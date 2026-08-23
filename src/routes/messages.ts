/**
 * Landlord↔tenant messaging routes.
 *
 * All endpoints require a valid Bearer session.  Authorization (participant
 * membership) is enforced by the store layer — an AccessDeniedError thrown
 * there is caught here and returned as 403.
 *
 * Delivery mechanism: cursor-based polling via the `since` / `before` query
 * parameters.  Real-time is available via the existing WebSocket notification
 * server (ws://host/ws/notifications?token=<token>) — after creating a
 * message the sender's conversation partners can be notified using
 * notificationWSS.sendToUser().  Full SSE/WebSocket fan-out is left as an
 * enhancement; polling with a cursor is clean, documented, and correct for v1.
 */

import { Router, type Response, type NextFunction } from 'express'
import { z } from 'zod'
import { authenticateToken, type AuthenticatedRequest } from '../middleware/auth.js'
import { validate } from '../middleware/validate.js'
import { messageStore, AccessDeniedError } from '../models/messageStore.js'
import { AppError } from '../errors/AppError.js'
import { ErrorCode } from '../errors/errorCodes.js'
import { logger } from '../utils/logger.js'

// ── Request schemas ───────────────────────────────────────────────────────────

const createConversationSchema = z.object({
  recipientId: z.string().min(1, 'recipientId is required'),
  listingId: z.string().uuid('listingId must be a valid UUID').optional(),
  dealId: z.string().uuid('dealId must be a valid UUID').optional(),
})

const createMessageSchema = z.object({
  body: z
    .string()
    .min(1, 'Message body cannot be empty')
    .max(4000, 'Message body cannot exceed 4000 characters'),
})

const listMessagesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
  before: z.string().uuid().optional(),
  since: z.string().uuid().optional(),
})

const listConversationsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().optional(),
})

// ── Router factory ────────────────────────────────────────────────────────────

export function createMessagesRouter(): Router {
  const router = Router()

  // Apply authentication to all routes in this router
  router.use(authenticateToken)

  // ── POST /messages/conversations
  //    Create or retrieve an existing conversation with a recipient.
  router.post(
    '/conversations',
    validate(createConversationSchema, 'body'),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const userId = req.user!.id
        const { recipientId, listingId, dealId } = req.body as z.infer<
          typeof createConversationSchema
        >

        if (recipientId === userId) {
          return next(
            new AppError(ErrorCode.VALIDATION_ERROR, 400, 'Cannot create a conversation with yourself'),
          )
        }

        const conversation = await messageStore.getOrCreateConversation({
          participantIds: [userId, recipientId],
          listingId,
          dealId,
        })

        logger.info('Conversation created or retrieved', {
          conversationId: conversation.conversationId,
          userId,
          requestId: req.requestId,
        })

        res.status(201).json({ success: true, data: conversation })
      } catch (err) {
        next(err)
      }
    },
  )

  // ── GET /messages/conversations
  //    List all conversations for the authenticated user.
  router.get(
    '/conversations',
    validate(listConversationsQuerySchema, 'query'),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const userId = req.user!.id
        const { limit, cursor } = req.query as unknown as z.infer<
          typeof listConversationsQuerySchema
        >

        const result = await messageStore.listConversations(userId, Number(limit), cursor)

        res.json({ success: true, data: result })
      } catch (err) {
        next(handleAccessDenied(err))
      }
    },
  )

  // ── GET /messages/conversations/:conversationId
  //    Fetch a single conversation (with metadata).
  router.get(
    '/conversations/:conversationId',
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const userId = req.user!.id
        const { conversationId } = req.params

        const conversation = await messageStore.getConversation(conversationId, userId)

        if (!conversation) {
          return next(
            new AppError(ErrorCode.NOT_FOUND, 404, `Conversation ${conversationId} not found`),
          )
        }

        res.json({ success: true, data: conversation })
      } catch (err) {
        next(handleAccessDenied(err))
      }
    },
  )

  // ── GET /messages/conversations/:conversationId/messages
  //    Paginated message history.  Pass `before=<messageId>` for older pages.
  //    Pass `since=<messageId>` to poll for new messages only (long-poll friendly).
  router.get(
    '/conversations/:conversationId/messages',
    validate(listMessagesQuerySchema, 'query'),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const userId = req.user!.id
        const { conversationId } = req.params
        const { limit, before, since } = req.query as unknown as z.infer<
          typeof listMessagesQuerySchema
        >

        const page = await messageStore.listMessages(
          conversationId,
          userId,
          Number(limit),
          before,
          since,
        )

        res.json({ success: true, data: page })
      } catch (err) {
        next(handleAccessDenied(err))
      }
    },
  )

  // ── POST /messages/conversations/:conversationId/messages
  //    Send a message.  Only participants may post.
  router.post(
    '/conversations/:conversationId/messages',
    validate(createMessageSchema, 'body'),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const userId = req.user!.id
        const { conversationId } = req.params
        const { body } = req.body as z.infer<typeof createMessageSchema>

        // Verify the conversation exists and the user is a participant
        const conversation = await messageStore.getConversation(conversationId, userId)
        if (!conversation) {
          return next(
            new AppError(ErrorCode.NOT_FOUND, 404, `Conversation ${conversationId} not found`),
          )
        }

        const message = await messageStore.createMessage({
          conversationId,
          senderId: userId,
          body,
        })

        logger.info('Message sent', {
          messageId: message.messageId,
          conversationId,
          userId,
          requestId: req.requestId,
        })

        res.status(201).json({ success: true, data: message })
      } catch (err) {
        next(handleAccessDenied(err))
      }
    },
  )

  // ── POST /messages/conversations/:conversationId/read
  //    Mark all messages in the conversation as read by the caller.
  router.post(
    '/conversations/:conversationId/read',
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const userId = req.user!.id
        const { conversationId } = req.params

        await messageStore.markMessagesRead(conversationId, userId)

        res.json({ success: true })
      } catch (err) {
        next(handleAccessDenied(err))
      }
    },
  )

  return router
}

// ── Helper: convert AccessDeniedError → AppError ──────────────────────────────

function handleAccessDenied(err: unknown): unknown {
  if (err instanceof AccessDeniedError) {
    return new AppError(ErrorCode.FORBIDDEN, 403, err.message)
  }
  return err
}
