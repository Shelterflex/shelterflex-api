/**
 * Tenant Document Vault — presigned upload/download URLs (issue #969)
 */

import express, { Router, type Request, type Response, type NextFunction } from 'express'
import { authenticateToken } from '../middleware/auth.js'
import { requireVaultUnlocked } from '../middleware/requireVaultUnlocked.js'
import { AppError } from '../errors/AppError.js'
import { ErrorCode } from '../errors/errorCodes.js'
import {
  uploadUrlRequestSchema,
  confirmUploadSchema,
  type DocumentDocType,
} from '../schemas/tenantDocumentPresign.js'
import { contentTypeToExtension } from '../services/storageService.js'
import {
  buildTenantDocumentObjectKey,
  downloadFile,
  uploadFile,
  STORAGE_TTL,
} from '../services/storageService.js'
import { encryptDocument, decryptDocument } from '../services/documentCrypto.js'
import { logger } from '../utils/logger.js'
import { getTenantDocumentVaultStore } from '../models/tenantDocumentVaultStore.js'
import { auditLog, extractAuditContext } from '../utils/auditLogger.js'

const router = Router()

function requireTenant(req: Request): string {
  const user = (req as Request & { user?: { id?: string } }).user
  if (!user?.id) {
    throw new AppError(ErrorCode.UNAUTHORIZED, 401, 'User not authenticated')
  }
  return user.id
}

const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024

/** API-relative path that uploads and serves a document's decrypted content. */
function contentPath(documentId: string): string {
  return `/documents/${documentId}/content`
}

/**
 * POST /api/documents/upload-url
 */
router.post(
  '/upload-url',
  authenticateToken,
  requireVaultUnlocked,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = requireTenant(req)
      const parsed = uploadUrlRequestSchema.safeParse(req.body)
      if (!parsed.success) {
        throw new AppError(
          ErrorCode.VALIDATION_ERROR,
          400,
          parsed.error.issues.map((i) => i.message).join(', ') || 'Invalid docType or contentType',
        )
      }

      const { docType, contentType } = parsed.data
      const objectKey = buildTenantDocumentObjectKey(userId, docType, contentType)
      const store = getTenantDocumentVaultStore()
      const doc = await store.createPendingUpload(userId, {
        docType,
        contentType,
        objectKey,
      })

      auditLog('DOCUMENT_UPLOAD_URL_ISSUED', extractAuditContext(req, 'user'), {
        documentId: doc.id,
        docType,
      })

      res.status(201).json({
        success: true,
        data: {
          documentId: doc.id,
          // Files are encrypted by the API, so they are sent to it, not to storage.
          uploadUrl: contentPath(doc.id),
          objectKey,
          expiresAt: new Date(Date.now() + STORAGE_TTL.UPLOAD_SECONDS * 1000).toISOString(),
          expiresInSeconds: STORAGE_TTL.UPLOAD_SECONDS,
        },
      })
    } catch (error) {
      next(error)
    }
  },
)

/**
 * GET /api/documents/:docId/download-url
 */
router.get(
  '/:docId/download-url',
  authenticateToken,
  requireVaultUnlocked,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = requireTenant(req)
      const { docId } = req.params
      if (!docId) {
        throw new AppError(ErrorCode.VALIDATION_ERROR, 400, 'Document ID is required')
      }

      const store = getTenantDocumentVaultStore()
      const doc = await store.findById(docId, userId)
      if (!doc) {
        throw new AppError(ErrorCode.NOT_FOUND, 404, 'Document not found')
      }
      if (doc.uploadStatus !== 'confirmed' || !doc.storageKey) {
        throw new AppError(ErrorCode.VALIDATION_ERROR, 400, 'Document upload not confirmed')
      }

      auditLog('DOCUMENT_DOWNLOAD_URL_ISSUED', extractAuditContext(req, 'user'), {
        documentId: doc.id,
        docType: doc.docType,
      })

      res.json({
        success: true,
        data: {
          documentId: doc.id,
          downloadUrl: contentPath(doc.id),
          expiresAt: new Date(Date.now() + STORAGE_TTL.DOWNLOAD_SECONDS * 1000).toISOString(),
          expiresInSeconds: STORAGE_TTL.DOWNLOAD_SECONDS,
        },
      })
    } catch (error) {
      next(error)
    }
  },
)

/**
 * PUT /api/documents/:docId/content
 * Receives the raw file, encrypts it, and stores only the encrypted blob.
 */
router.put(
  '/:docId/content',
  authenticateToken,
  requireVaultUnlocked,
  express.raw({ type: () => true, limit: MAX_DOCUMENT_BYTES }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = requireTenant(req)
      const { docId } = req.params
      if (!docId) {
        throw new AppError(ErrorCode.VALIDATION_ERROR, 400, 'Document ID is required')
      }

      const doc = await getTenantDocumentVaultStore().findById(docId, userId)
      if (!doc || !doc.storageKey) {
        throw new AppError(ErrorCode.NOT_FOUND, 404, 'Document not found')
      }
      if (doc.uploadStatus !== 'pending') {
        throw new AppError(ErrorCode.VALIDATION_ERROR, 400, 'Document already uploaded')
      }

      const body = req.body
      if (!Buffer.isBuffer(body) || body.length === 0) {
        throw new AppError(ErrorCode.VALIDATION_ERROR, 400, 'File content is required')
      }

      await uploadFile(doc.storageKey, encryptDocument(body, doc.storageKey), 'application/octet-stream')

      auditLog('DOCUMENT_CONTENT_STORED', extractAuditContext(req, 'user'), {
        documentId: doc.id,
        docType: doc.docType,
      })

      res.json({ success: true, data: { documentId: doc.id, fileSizeBytes: body.length } })
    } catch (error) {
      next(error)
    }
  },
)

/**
 * GET /api/documents/:docId/content
 * Decrypts and returns the file to its owner. Never cached.
 */
router.get(
  '/:docId/content',
  authenticateToken,
  requireVaultUnlocked,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = requireTenant(req)
      const { docId } = req.params
      if (!docId) {
        throw new AppError(ErrorCode.VALIDATION_ERROR, 400, 'Document ID is required')
      }

      const doc = await getTenantDocumentVaultStore().findById(docId, userId)
      if (!doc || !doc.storageKey) {
        throw new AppError(ErrorCode.NOT_FOUND, 404, 'Document not found')
      }
      if (doc.uploadStatus !== 'confirmed') {
        throw new AppError(ErrorCode.VALIDATION_ERROR, 400, 'Document upload not confirmed')
      }

      let plaintext: Buffer
      try {
        plaintext = decryptDocument(await downloadFile(doc.storageKey), doc.storageKey)
      } catch (error) {
        logger.error('Could not decrypt vault document', {
          documentId: doc.id,
          error: error instanceof Error ? error.message : String(error),
        })
        throw new AppError(ErrorCode.INTERNAL_ERROR, 500, 'Document could not be opened')
      }

      auditLog('DOCUMENT_CONTENT_SERVED', extractAuditContext(req, 'user'), {
        documentId: doc.id,
        docType: doc.docType,
      })

      res.set({
        'Content-Type': doc.contentType ?? 'application/octet-stream',
        'Content-Length': String(plaintext.length),
        'Content-Disposition': `inline; filename="${encodeURIComponent(doc.fileName || 'document')}"`,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        // Keeps a hostile SVG or HTML upload from running script in this origin.
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      })
      res.send(plaintext)
    } catch (error) {
      next(error)
    }
  },
)

/**
 * PATCH /api/documents/:docId/confirm
 */
router.patch(
  '/:docId/confirm',
  authenticateToken,
  requireVaultUnlocked,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = requireTenant(req)
      const { docId } = req.params
      if (!docId) {
        throw new AppError(ErrorCode.VALIDATION_ERROR, 400, 'Document ID is required')
      }

      const parsed = confirmUploadSchema.safeParse(req.body)
      if (!parsed.success) {
        throw new AppError(ErrorCode.VALIDATION_ERROR, 400, 'Invalid confirmation payload')
      }

      const store = getTenantDocumentVaultStore()
      const pending = await store.findById(docId, userId)
      if (!pending) {
        throw new AppError(ErrorCode.NOT_FOUND, 404, 'Document not found')
      }
      if (pending.uploadStatus === 'confirmed') {
        throw new AppError(ErrorCode.VALIDATION_ERROR, 400, 'Document already confirmed')
      }
      if (pending.storageKey !== parsed.data.objectKey) {
        throw new AppError(ErrorCode.VALIDATION_ERROR, 400, 'objectKey does not match pending upload')
      }

      const ext = contentTypeToExtension(pending.contentType ?? 'application/octet-stream')
      const fileName =
        parsed.data.fileName ??
        `${pending.docType ?? 'document'}.${ext}`

      const confirmed = await store.confirmUpload(docId, userId, {
        fileName,
        fileFormat: ext as import('../schemas/tenantDocumentVault.js').SupportedFileFormat,
        fileSizeBytes: parsed.data.fileSizeBytes ?? 1,
      })

      if (!confirmed) {
        throw new AppError(ErrorCode.NOT_FOUND, 404, 'Document not found')
      }

      auditLog('DOCUMENT_UPLOAD_CONFIRMED', extractAuditContext(req, 'user'), {
        documentId: docId,
        docType: confirmed.docType as DocumentDocType,
      })

      res.json({ success: true, data: confirmed })
    } catch (error) {
      next(error)
    }
  },
)

export function createTenantDocumentsPresignRouter(): Router {
  return router
}
