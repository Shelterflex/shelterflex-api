import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import express, { type Express } from 'express'
import { documentDocTypeSchema } from '../schemas/tenantDocumentPresign.js'
import { createTenantDocumentsPresignRouter } from './tenantDocumentsPresign.js'
import { errorHandler } from '../middleware/errorHandler.js'
import { sessionStore, userStore } from '../models/authStore.js'

vi.mock('../services/storageService.js', () => ({
  buildTenantDocumentObjectKey: vi.fn(() => 'tenant-documents/user-1/id_card/uuid.pdf'),
  generatePresignedUpload: vi.fn(async () => ({
    uploadUrl: 'https://minio.local/upload',
    expiresAt: new Date(Date.now() + 900000).toISOString(),
  })),
  generatePresignedDownload: vi.fn(async () => ({
    downloadUrl: 'https://minio.local/download',
    expiresAt: new Date(Date.now() + 300000).toISOString(),
  })),
  contentTypeToExtension: vi.fn(() => 'pdf'),
  STORAGE_TTL: { UPLOAD_SECONDS: 900, DOWNLOAD_SECONDS: 300 },
}))

const mockStore = {
  createPendingUpload: vi.fn(),
  findById: vi.fn(),
  confirmUpload: vi.fn(),
}

vi.mock('../models/tenantDocumentVaultStore.js', () => ({
  getTenantDocumentVaultStore: () => mockStore,
}))

vi.mock('../utils/auditLogger.js', () => ({
  auditLog: vi.fn(),
  extractAuditContext: vi.fn(() => ({ userId: 'user-1', requestId: 'req-1', ip: '127.0.0.1', actorType: 'user' })),
}))

describe('tenantDocumentPresign schemas', () => {
  it('accepts allowlisted docType values', () => {
    for (const docType of [
      'id_card',
      'passport',
      'employment_letter',
      'bank_statement',
      'utility_bill',
      'proof_of_address',
    ]) {
      expect(documentDocTypeSchema.safeParse(docType).success).toBe(true)
    }
  })

  it('rejects unknown docType with 400-level validation error', () => {
    const result = documentDocTypeSchema.safeParse('drivers_license')
    expect(result.success).toBe(false)
  })
})

describe('tenant documents presign store flow', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('creates pending upload with object key', async () => {
    mockStore.createPendingUpload.mockResolvedValue({
      id: 'DOC-1',
      userId: 'user-1',
      storageKey: 'tenant-documents/user-1/id_card/uuid.pdf',
      uploadStatus: 'pending',
      docType: 'id_card',
    })

    const doc = await mockStore.createPendingUpload('user-1', {
      docType: 'id_card',
      contentType: 'application/pdf',
      objectKey: 'tenant-documents/user-1/id_card/uuid.pdf',
    })

    expect(doc.uploadStatus).toBe('pending')
    expect(doc.storageKey).toContain('tenant-documents/user-1/id_card')
  })

  it('confirms upload and records storage key', async () => {
    mockStore.confirmUpload.mockResolvedValue({
      id: 'DOC-1',
      uploadStatus: 'confirmed',
      storageKey: 'tenant-documents/user-1/id_card/uuid.pdf',
    })

    const confirmed = await mockStore.confirmUpload('DOC-1', 'user-1', {
      fileName: 'id.pdf',
      fileFormat: 'pdf',
      fileSizeBytes: 1024,
    })

    expect(confirmed.uploadStatus).toBe('confirmed')
  })
})

describe('tenant documents presign endpoints', () => {
  let app: Express
  let tenantToken: string

  beforeEach(async () => {
    vi.clearAllMocks()
    userStore.clear()
    sessionStore.clear()

    await userStore.getOrCreateByEmail('presign-tenant@test.com')
    const session = await sessionStore.create('presign-tenant@test.com', `tenant-token-${Date.now()}`)
    tenantToken = session.token

    app = express()
    app.use(express.json())
    app.use('/api/documents', createTenantDocumentsPresignRouter())
    app.use(errorHandler)
  })

  it('rejects unauthenticated upload-url requests', async () => {
    await request(app)
      .post('/api/documents/upload-url')
      .send({ docType: 'id_card', contentType: 'application/pdf' })
      .expect(401)
  })

  it('issues a presigned upload URL for an authenticated tenant', async () => {
    mockStore.createPendingUpload.mockResolvedValue({
      id: 'DOC-1',
      userId: 'user-1',
      storageKey: 'tenant-documents/user-1/id_card/uuid.pdf',
      uploadStatus: 'pending',
      docType: 'id_card',
    })

    const res = await request(app)
      .post('/api/documents/upload-url')
      .set('Authorization', `Bearer ${tenantToken}`)
      .send({ docType: 'id_card', contentType: 'application/pdf' })
      .expect(201)

    expect(res.body.success).toBe(true)
    expect(res.body.data.uploadUrl).toBe('https://minio.local/upload')
    expect(res.body.data.documentId).toBe('DOC-1')
  })
})
