import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import express, { type Express } from 'express'
import { documentDocTypeSchema } from '../schemas/tenantDocumentPresign.js'
import { createTenantDocumentsPresignRouter } from './tenantDocumentsPresign.js'
import { errorHandler } from '../middleware/errorHandler.js'
import { sessionStore, userStore } from '../models/authStore.js'
import { vaultUnlockStore } from '../services/vaultUnlockStore.js'

const storedObjects = new Map<string, Buffer>()

vi.mock('../services/storageService.js', () => ({
  buildTenantDocumentObjectKey: vi.fn(() => 'tenant-documents/user-1/id_card/uuid.pdf'),
  uploadFile: vi.fn(async (key: string, buffer: Buffer) => {
    storedObjects.set(key, buffer)
    return { key, url: `mem://${key}` }
  }),
  downloadFile: vi.fn(async (key: string) => storedObjects.get(key)!),
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
    vaultUnlockStore.unlock(tenantToken)

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
    expect(res.body.data.uploadUrl).toBe('/documents/DOC-1/content')
    expect(res.body.data.documentId).toBe('DOC-1')
  })

  describe('encrypted content', () => {
    const key = 'tenant-documents/user-1/id_card/uuid.pdf'
    const plain = Buffer.from('%PDF-1.4 my passport scan')
    let userId: string

    beforeEach(async () => {
      storedObjects.clear()
      userId = (await userStore.getOrCreateByEmail('presign-tenant@test.com')).id
    })

    function pendingDoc() {
      return {
        id: 'DOC-1',
        userId,
        storageKey: key,
        uploadStatus: 'pending',
        docType: 'id_card',
        contentType: 'application/pdf',
        fileName: 'passport.pdf',
      }
    }

    it('stores only ciphertext and serves the original back to its owner', async () => {
      mockStore.findById.mockResolvedValue(pendingDoc())

      await request(app)
        .put('/api/documents/DOC-1/content')
        .set('Authorization', `Bearer ${tenantToken}`)
        .set('Content-Type', 'application/pdf')
        .send(plain)
        .expect(200)

      const stored = storedObjects.get(key)!
      expect(stored.includes(plain)).toBe(false)

      mockStore.findById.mockResolvedValue({ ...pendingDoc(), uploadStatus: 'confirmed' })
      const res = await request(app)
        .get('/api/documents/DOC-1/content')
        .set('Authorization', `Bearer ${tenantToken}`)
        .buffer(true)
        .parse((r, cb) => {
          const chunks: Buffer[] = []
          r.on('data', (c: Buffer) => chunks.push(c))
          r.on('end', () => cb(null, Buffer.concat(chunks)))
        })
        .expect(200)

      expect(res.body).toEqual(plain)
      expect(res.headers['cache-control']).toBe('no-store')
      expect(res.headers['x-content-type-options']).toBe('nosniff')
    })

    it("does not serve another tenant's document", async () => {
      mockStore.findById.mockResolvedValue(null)
      await request(app)
        .get('/api/documents/DOC-1/content')
        .set('Authorization', `Bearer ${tenantToken}`)
        .expect(404)
    })

    it('rejects an empty upload', async () => {
      mockStore.findById.mockResolvedValue(pendingDoc())
      await request(app)
        .put('/api/documents/DOC-1/content')
        .set('Authorization', `Bearer ${tenantToken}`)
        .set('Content-Type', 'application/pdf')
        .expect(400)
    })
  })
})
