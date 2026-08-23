/**
 * Message store — InMemory / Postgres / Hybrid implementations.
 *
 * Follows the same three-class pattern used throughout this codebase
 * (walletStore, dealStore, supportMessageStore, etc.).
 *
 * Authorization enforcement:
 *   getConversation / listMessages / createMessage all throw if the
 *   requesting userId is not a participant.  This is deliberate — the
 *   service, not just the route, guards cross-tenant access.
 */

import { randomUUID } from 'node:crypto'
import { getPool, type PgPoolLike } from '../db.js'
import { userStore } from './authStore.js'
import type {
  Conversation,
  CreateConversationInput,
  Message,
  CreateMessageInput,
  MessagePage,
} from './message.js'

// ── Participant/sender display-name enrichment ────────────────────────────────
//
// Conversation.participantIds / Message.senderId are raw user-ids; both
// in-memory and Postgres stores resolve display names the same way, via
// userStore.getById (which itself falls back to an in-memory cache when
// Postgres is unavailable), so the enrichment lives here once rather than
// being duplicated per store implementation.

async function resolveParticipants(
  userIds: string[],
): Promise<{ userId: string; name: string }[]> {
  const resolved = await Promise.all(
    userIds.map(async (userId) => {
      const user = await userStore.getById(userId)
      return user ? { userId, name: user.name } : null
    }),
  )
  return resolved.filter((p): p is { userId: string; name: string } => p !== null)
}

async function attachSenderNames(messages: Message[]): Promise<Message[]> {
  const uniqueSenderIds = Array.from(new Set(messages.map((m) => m.senderId)))
  const participants = await resolveParticipants(uniqueSenderIds)
  const nameByUserId = new Map(participants.map((p) => [p.userId, p.name]))
  return messages.map((m) => ({ ...m, senderName: nameByUserId.get(m.senderId) }))
}

// ── Store interface ───────────────────────────────────────────────────────────

export interface MessageStorePort {
  /**
   * Find an existing conversation between exactly these two participants
   * (scoped to listing/deal when provided), or create a new one.
   */
  getOrCreateConversation(input: CreateConversationInput): Promise<Conversation>

  /**
   * Return a conversation by id.
   * Throws FORBIDDEN (403-level error) if requestingUserId is not a participant.
   */
  getConversation(
    conversationId: string,
    requestingUserId: string,
  ): Promise<Conversation | null>

  /**
   * List all conversations the user participates in, most-recently-updated first.
   * Includes unreadCount and lastMessage per conversation.
   */
  listConversations(
    userId: string,
    limit?: number,
    cursor?: string,
  ): Promise<{ conversations: Conversation[]; nextCursor: string | null }>

  /**
   * Fetch messages in a conversation, newest-first (cursor-based pagination).
   * `before` pages backward to older messages; `since` restricts the result
   * to messages newer than the given message id (for polling).
   * Throws FORBIDDEN if requestingUserId is not a participant.
   */
  listMessages(
    conversationId: string,
    requestingUserId: string,
    limit?: number,
    before?: string,
    since?: string,
  ): Promise<MessagePage>

  /**
   * Post a message to a conversation.
   * Throws FORBIDDEN if senderId is not a participant.
   */
  createMessage(input: CreateMessageInput): Promise<Message>

  /**
   * Mark all messages in the conversation sent by others as read by userId.
   * Throws FORBIDDEN if userId is not a participant.
   */
  markMessagesRead(conversationId: string, userId: string): Promise<void>

  /** Test helper only. */
  clear(): Promise<void>
}

// ── Error helper ──────────────────────────────────────────────────────────────

class AccessDeniedError extends Error {
  readonly statusCode = 403
  constructor(conversationId: string) {
    super(`Access denied to conversation ${conversationId}`)
    this.name = 'AccessDeniedError'
  }
}

export { AccessDeniedError }

// ── In-memory implementation ──────────────────────────────────────────────────

interface StoredConversation {
  conversationId: string
  participantIds: string[]
  listingId?: string
  dealId?: string
  createdAt: Date
  updatedAt: Date
}

class InMemoryMessageStore implements MessageStorePort {
  private conversations = new Map<string, StoredConversation>()
  private messages = new Map<string, Message>()

  async getOrCreateConversation(input: CreateConversationInput): Promise<Conversation> {
    const [a, b] = input.participantIds
    // Find existing conversation with the same participant pair and same context
    for (const conv of this.conversations.values()) {
      if (
        conv.participantIds.includes(a) &&
        conv.participantIds.includes(b) &&
        conv.participantIds.length === 2 &&
        (conv.listingId ?? null) === (input.listingId ?? null) &&
        (conv.dealId ?? null) === (input.dealId ?? null)
      ) {
        return this.enrichConversation(conv, a)
      }
    }

    const conv: StoredConversation = {
      conversationId: randomUUID(),
      participantIds: [a, b],
      listingId: input.listingId,
      dealId: input.dealId,
      createdAt: new Date(),
      updatedAt: new Date(),
    }
    this.conversations.set(conv.conversationId, conv)
    return this.enrichConversation(conv, a)
  }

  async getConversation(
    conversationId: string,
    requestingUserId: string,
  ): Promise<Conversation | null> {
    const conv = this.conversations.get(conversationId)
    if (!conv) return null
    if (!conv.participantIds.includes(requestingUserId)) {
      throw new AccessDeniedError(conversationId)
    }
    return this.enrichConversation(conv, requestingUserId)
  }

  async listConversations(
    userId: string,
    limit = 20,
    cursor?: string,
  ): Promise<{ conversations: Conversation[]; nextCursor: string | null }> {
    let all = Array.from(this.conversations.values())
      .filter((c) => c.participantIds.includes(userId))
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())

    if (cursor) {
      const idx = all.findIndex((c) => c.conversationId === cursor)
      if (idx !== -1) all = all.slice(idx + 1)
    }

    const page = all.slice(0, limit)
    const nextCursor = page.length === limit && all.length > limit ? page[page.length - 1].conversationId : null
    const conversations = await Promise.all(page.map((c) => this.enrichConversation(c, userId)))
    return { conversations, nextCursor }
  }

  async listMessages(
    conversationId: string,
    requestingUserId: string,
    limit = 30,
    before?: string,
    since?: string,
  ): Promise<MessagePage> {
    const conv = this.conversations.get(conversationId)
    if (!conv) return { messages: [], nextCursor: null, total: 0 }
    if (!conv.participantIds.includes(requestingUserId)) {
      throw new AccessDeniedError(conversationId)
    }

    let msgs = Array.from(this.messages.values())
      .filter((m) => m.conversationId === conversationId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())

    const total = msgs.length

    if (since) {
      // msgs is newest-first, so everything before the cursor's index is newer than it
      const idx = msgs.findIndex((m) => m.messageId === since)
      if (idx !== -1) msgs = msgs.slice(0, idx)
    }

    if (before) {
      const idx = msgs.findIndex((m) => m.messageId === before)
      if (idx !== -1) msgs = msgs.slice(idx + 1)
    }

    const page = msgs.slice(0, limit)
    const nextCursor =
      page.length === limit && msgs.length > limit ? page[page.length - 1].messageId : null

    const messages = await attachSenderNames(page)
    return { messages, nextCursor, total }
  }

  async createMessage(input: CreateMessageInput): Promise<Message> {
    const conv = this.conversations.get(input.conversationId)
    if (!conv) {
      throw new Error(`Conversation ${input.conversationId} not found`)
    }
    if (!conv.participantIds.includes(input.senderId)) {
      throw new AccessDeniedError(input.conversationId)
    }

    const message: Message = {
      messageId: randomUUID(),
      conversationId: input.conversationId,
      senderId: input.senderId,
      body: input.body,
      readBy: [input.senderId],
      createdAt: new Date(),
      updatedAt: new Date(),
    }
    this.messages.set(message.messageId, message)

    // Update conversation.updatedAt
    conv.updatedAt = message.createdAt

    const [withSenderName] = await attachSenderNames([message])
    return withSenderName
  }

  async markMessagesRead(conversationId: string, userId: string): Promise<void> {
    const conv = this.conversations.get(conversationId)
    if (!conv) return
    if (!conv.participantIds.includes(userId)) {
      throw new AccessDeniedError(conversationId)
    }
    for (const msg of this.messages.values()) {
      if (msg.conversationId === conversationId && !msg.readBy.includes(userId)) {
        msg.readBy = [...msg.readBy, userId]
        msg.updatedAt = new Date()
      }
    }
  }

  async clear(): Promise<void> {
    this.conversations.clear()
    this.messages.clear()
  }

  private async enrichConversation(conv: StoredConversation, forUserId: string): Promise<Conversation> {
    const convMessages = Array.from(this.messages.values())
      .filter((m) => m.conversationId === conv.conversationId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())

    const lastMessageRaw = convMessages[0]
    const unreadCount = convMessages.filter(
      (m) => m.senderId !== forUserId && !m.readBy.includes(forUserId),
    ).length

    const participants = await resolveParticipants(conv.participantIds)
    const nameByUserId = new Map(participants.map((p) => [p.userId, p.name]))
    const lastMessage = lastMessageRaw
      ? { ...lastMessageRaw, senderName: nameByUserId.get(lastMessageRaw.senderId) }
      : undefined

    return {
      conversationId: conv.conversationId,
      participantIds: conv.participantIds,
      participants,
      listingId: conv.listingId,
      dealId: conv.dealId,
      createdAt: conv.createdAt,
      updatedAt: conv.updatedAt,
      lastMessage,
      unreadCount,
    }
  }
}

// ── Postgres implementation ───────────────────────────────────────────────────

type ConvRow = {
  conversation_id: string
  listing_id: string | null
  deal_id: string | null
  created_at: Date
  updated_at: Date
  participant_ids: string[]
}

type MsgRow = {
  message_id: string
  conversation_id: string
  sender_id: string
  body: string
  read_by: string[]
  created_at: Date
  updated_at: Date
}

class PostgresMessageStore implements MessageStorePort {
  private async pool(): Promise<PgPoolLike> {
    const p = await getPool()
    if (!p) throw new Error('Database pool is not available (DATABASE_URL/pg not configured)')
    return p
  }

  async isAvailable(): Promise<boolean> {
    return (await getPool()) !== null
  }

  async getOrCreateConversation(input: CreateConversationInput): Promise<Conversation> {
    const pool = await this.pool()
    const [a, b] = input.participantIds

    // Try to find an existing conversation with identical participants and context
    const findResult = await pool.query(
      `SELECT c.conversation_id, c.listing_id, c.deal_id, c.created_at, c.updated_at,
              ARRAY_AGG(cp.user_id ORDER BY cp.joined_at) AS participant_ids
         FROM conversations c
         JOIN conversation_participants cp ON cp.conversation_id = c.conversation_id
        WHERE c.conversation_id IN (
                SELECT conversation_id FROM conversation_participants WHERE user_id = $1
                INTERSECT
                SELECT conversation_id FROM conversation_participants WHERE user_id = $2
              )
          AND (c.listing_id IS NOT DISTINCT FROM $3)
          AND (c.deal_id IS NOT DISTINCT FROM $4)
        GROUP BY c.conversation_id, c.listing_id, c.deal_id, c.created_at, c.updated_at
       HAVING COUNT(DISTINCT cp.user_id) = 2
        LIMIT 1`,
      [a, b, input.listingId ?? null, input.dealId ?? null],
    )

    if (findResult.rows.length > 0) {
      return this.enrichRow(pool, findResult.rows[0] as ConvRow, a)
    }

    // Create a new conversation in a transaction
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const insertConv = await client.query(
        `INSERT INTO conversations (listing_id, deal_id)
         VALUES ($1, $2)
         RETURNING conversation_id, listing_id, deal_id, created_at, updated_at`,
        [input.listingId ?? null, input.dealId ?? null],
      )
      const convRow = insertConv.rows[0] as {
        conversation_id: string
        listing_id: string | null
        deal_id: string | null
        created_at: Date
        updated_at: Date
      }

      await client.query(
        `INSERT INTO conversation_participants (conversation_id, user_id)
         VALUES ($1, $2), ($1, $3)`,
        [convRow.conversation_id, a, b],
      )

      await client.query('COMMIT')

      return {
        conversationId: convRow.conversation_id,
        participantIds: [a, b],
        participants: await resolveParticipants([a, b]),
        listingId: convRow.listing_id ?? undefined,
        dealId: convRow.deal_id ?? undefined,
        createdAt: new Date(convRow.created_at),
        updatedAt: new Date(convRow.updated_at),
        unreadCount: 0,
      }
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  async getConversation(
    conversationId: string,
    requestingUserId: string,
  ): Promise<Conversation | null> {
    const pool = await this.pool()
    const result = await pool.query(
      `SELECT c.conversation_id, c.listing_id, c.deal_id, c.created_at, c.updated_at,
              ARRAY_AGG(cp.user_id ORDER BY cp.joined_at) AS participant_ids
         FROM conversations c
         JOIN conversation_participants cp ON cp.conversation_id = c.conversation_id
        WHERE c.conversation_id = $1
        GROUP BY c.conversation_id, c.listing_id, c.deal_id, c.created_at, c.updated_at`,
      [conversationId],
    )

    if (result.rows.length === 0) return null

    const row = result.rows[0] as ConvRow
    if (!row.participant_ids.includes(requestingUserId)) {
      throw new AccessDeniedError(conversationId)
    }
    return this.enrichRow(pool, row, requestingUserId)
  }

  async listConversations(
    userId: string,
    limit = 20,
    cursor?: string,
  ): Promise<{ conversations: Conversation[]; nextCursor: string | null }> {
    const pool = await this.pool()
    const values: unknown[] = [userId, limit + 1]
    let cursorSql = ''
    if (cursor) {
      const cursorResult = await pool.query(
        `SELECT updated_at FROM conversations WHERE conversation_id = $1`,
        [cursor],
      )
      if (cursorResult.rows.length > 0) {
        values.push((cursorResult.rows[0] as { updated_at: Date }).updated_at)
        cursorSql = ` AND c.updated_at < $${values.length}`
      }
    }

    const result = await pool.query(
      `SELECT c.conversation_id, c.listing_id, c.deal_id, c.created_at, c.updated_at,
              ARRAY_AGG(cp.user_id ORDER BY cp.joined_at) AS participant_ids
         FROM conversations c
         JOIN conversation_participants cp ON cp.conversation_id = c.conversation_id
        WHERE c.conversation_id IN (
                SELECT conversation_id FROM conversation_participants WHERE user_id = $1
              )${cursorSql}
        GROUP BY c.conversation_id, c.listing_id, c.deal_id, c.created_at, c.updated_at
        ORDER BY c.updated_at DESC
        LIMIT $2`,
      values,
    )

    const rows = result.rows as ConvRow[]
    const hasMore = rows.length > limit
    const page = hasMore ? rows.slice(0, limit) : rows
    const conversations = await Promise.all(page.map((r) => this.enrichRow(pool, r, userId)))
    const nextCursor = hasMore ? page[page.length - 1].conversation_id : null
    return { conversations, nextCursor }
  }

  async listMessages(
    conversationId: string,
    requestingUserId: string,
    limit = 30,
    before?: string,
    since?: string,
  ): Promise<MessagePage> {
    const pool = await this.pool()

    // Check participant access
    const partCheck = await pool.query(
      `SELECT 1 FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2`,
      [conversationId, requestingUserId],
    )
    if (partCheck.rows.length === 0) {
      // Check if conversation exists at all
      const convCheck = await pool.query(
        `SELECT 1 FROM conversations WHERE conversation_id = $1`,
        [conversationId],
      )
      if (convCheck.rows.length > 0) {
        throw new AccessDeniedError(conversationId)
      }
      return { messages: [], nextCursor: null, total: 0 }
    }

    const countResult = await pool.query(
      `SELECT COUNT(*) AS total FROM messages WHERE conversation_id = $1`,
      [conversationId],
    )
    const total = Number((countResult.rows[0] as { total: string }).total)

    const values: unknown[] = [conversationId, limit + 1]
    let filterSql = ''
    if (since) {
      const sinceResult = await pool.query(
        `SELECT created_at FROM messages WHERE message_id = $1`,
        [since],
      )
      if (sinceResult.rows.length > 0) {
        values.push((sinceResult.rows[0] as { created_at: Date }).created_at)
        filterSql += ` AND created_at > $${values.length}`
      }
    }
    if (before) {
      const beforeResult = await pool.query(
        `SELECT created_at FROM messages WHERE message_id = $1`,
        [before],
      )
      if (beforeResult.rows.length > 0) {
        values.push((beforeResult.rows[0] as { created_at: Date }).created_at)
        filterSql += ` AND created_at < $${values.length}`
      }
    }

    const result = await pool.query(
      `SELECT message_id, conversation_id, sender_id, body, read_by, created_at, updated_at
         FROM messages
        WHERE conversation_id = $1${filterSql}
        ORDER BY created_at DESC
        LIMIT $2`,
      values,
    )

    const rows = result.rows as MsgRow[]
    const hasMore = rows.length > limit
    const page = hasMore ? rows.slice(0, limit) : rows
    const messages = await attachSenderNames(page.map((r) => this.mapMessage(r)))
    const nextCursor = hasMore ? page[page.length - 1].message_id : null
    return { messages, nextCursor, total }
  }

  async createMessage(input: CreateMessageInput): Promise<Message> {
    const pool = await this.pool()

    // Enforce participant membership at service layer
    const partCheck = await pool.query(
      `SELECT 1 FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2`,
      [input.conversationId, input.senderId],
    )
    if (partCheck.rows.length === 0) {
      throw new AccessDeniedError(input.conversationId)
    }

    const result = await pool.query(
      `INSERT INTO messages (conversation_id, sender_id, body, read_by)
       VALUES ($1, $2, $3, ARRAY[$2])
       RETURNING message_id, conversation_id, sender_id, body, read_by, created_at, updated_at`,
      [input.conversationId, input.senderId, input.body],
    )

    const [message] = await attachSenderNames([this.mapMessage(result.rows[0] as MsgRow)])
    return message
  }

  async markMessagesRead(conversationId: string, userId: string): Promise<void> {
    const pool = await this.pool()

    const partCheck = await pool.query(
      `SELECT 1 FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2`,
      [conversationId, userId],
    )
    if (partCheck.rows.length === 0) {
      throw new AccessDeniedError(conversationId)
    }

    await pool.query(
      `UPDATE messages
          SET read_by = array_append(read_by, $2),
              updated_at = NOW()
        WHERE conversation_id = $1
          AND NOT ($2 = ANY(read_by))`,
      [conversationId, userId],
    )
  }

  async clear(): Promise<void> {
    const pool = await this.pool()
    if (process.env.NODE_ENV !== 'test') {
      throw new Error('messageStore.clear() is only supported in test env')
    }
    await pool.query('TRUNCATE messages, conversation_participants, conversations RESTART IDENTITY CASCADE')
  }

  private mapMessage(row: MsgRow): Message {
    return {
      messageId: row.message_id,
      conversationId: row.conversation_id,
      senderId: row.sender_id,
      body: row.body,
      readBy: Array.isArray(row.read_by) ? row.read_by : [],
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    }
  }

  private async enrichRow(
    pool: PgPoolLike,
    row: ConvRow,
    forUserId: string,
  ): Promise<Conversation> {
    // Fetch last message
    const lastMsgResult = await pool.query(
      `SELECT message_id, conversation_id, sender_id, body, read_by, created_at, updated_at
         FROM messages
        WHERE conversation_id = $1
        ORDER BY created_at DESC
        LIMIT 1`,
      [row.conversation_id],
    )

    const lastMessageRaw =
      lastMsgResult.rows.length > 0
        ? this.mapMessage(lastMsgResult.rows[0] as MsgRow)
        : undefined

    // Count unread messages for this user
    const unreadResult = await pool.query(
      `SELECT COUNT(*) AS cnt
         FROM messages
        WHERE conversation_id = $1
          AND sender_id != $2
          AND NOT ($2 = ANY(read_by))`,
      [row.conversation_id, forUserId],
    )
    const unreadCount = Number((unreadResult.rows[0] as { cnt: string }).cnt)

    const participants = await resolveParticipants(row.participant_ids)
    const nameByUserId = new Map(participants.map((p) => [p.userId, p.name]))
    const lastMessage = lastMessageRaw
      ? { ...lastMessageRaw, senderName: nameByUserId.get(lastMessageRaw.senderId) }
      : undefined

    return {
      conversationId: row.conversation_id,
      participantIds: row.participant_ids,
      participants,
      listingId: row.listing_id ?? undefined,
      dealId: row.deal_id ?? undefined,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
      lastMessage,
      unreadCount,
    }
  }
}

// ── Hybrid store ──────────────────────────────────────────────────────────────

class HybridMessageStore implements MessageStorePort {
  private memory = new InMemoryMessageStore()
  private postgres = new PostgresMessageStore()

  private async adapter(): Promise<MessageStorePort> {
    if (await this.postgres.isAvailable()) return this.postgres
    return this.memory
  }

  async getOrCreateConversation(input: CreateConversationInput): Promise<Conversation> {
    return (await this.adapter()).getOrCreateConversation(input)
  }

  async getConversation(id: string, userId: string): Promise<Conversation | null> {
    return (await this.adapter()).getConversation(id, userId)
  }

  async listConversations(
    userId: string,
    limit?: number,
    cursor?: string,
  ): Promise<{ conversations: Conversation[]; nextCursor: string | null }> {
    return (await this.adapter()).listConversations(userId, limit, cursor)
  }

  async listMessages(
    conversationId: string,
    requestingUserId: string,
    limit?: number,
    before?: string,
    since?: string,
  ): Promise<MessagePage> {
    return (await this.adapter()).listMessages(conversationId, requestingUserId, limit, before, since)
  }

  async createMessage(input: CreateMessageInput): Promise<Message> {
    return (await this.adapter()).createMessage(input)
  }

  async markMessagesRead(conversationId: string, userId: string): Promise<void> {
    return (await this.adapter()).markMessagesRead(conversationId, userId)
  }

  async clear(): Promise<void> {
    return (await this.adapter()).clear()
  }
}

export const messageStore = new HybridMessageStore()
