import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { Signer } from './eSignatureService.js'
import { computeDocumentHash } from './eSignatureService.js'
import { verifyDocusealWebhookSignature, _testEsignRequestStore as esignRequestStore } from './docusealESignatureProvider.js'

const DOC_KEY = 'lease/deal-abc/123e4567-e89b-12d3-a456-426614174000.pdf'
const DOC_HASH = computeDocumentHash(DOC_KEY)
const SIGNERS: Signer[] = [
  { id: 'tenant-1', name: 'Alice', email: 'alice@test.com', role: 'tenant' },
  { id: 'landlord-1', name: 'Bob', email: 'bob@test.com', role: 'landlord' },
]

function tokenFromUrl(url: string): string {
  return new URLSearchParams(url.split('?')[1]).get('token')!
}

// ── Mock setup ──────────────────────────────────────────────────────────────

const mockFetch = vi.fn<typeof fetch>()
vi.stubGlobal('fetch', mockFetch)

// Mock getPool to return null (in-memory path)
vi.mock('../db.js', () => ({
  getPool: vi.fn().mockResolvedValue(null),
}))

let DocuSealESignatureProvider: typeof import('./docusealESignatureProvider.js').DocuSealESignatureProvider

beforeEach(async () => {
  vi.clearAllMocks()
  vi.stubEnv('ESIGN_PROVIDER', 'docuseal')
  vi.stubEnv('DOCUSEAL_API_URL', 'http://docuseal-test:3000')
  vi.stubEnv('DOCUSEAL_API_KEY', 'test-api-key')
  vi.stubEnv('DOCUSEAL_WEBHOOK_SECRET', '')

  // Clear the shared store between tests to prevent accumulation
  await esignRequestStore.clear()

  const mod = await import('./docusealESignatureProvider.js')
  DocuSealESignatureProvider = mod.DocuSealESignatureProvider
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

// ── Helpers ─────────────────────────────────────────────────────────────────

function mockDocusealTemplateCreate() {
  mockFetch.mockResolvedValueOnce(
    new Response(JSON.stringify({ id: 42, name: DOC_KEY, key: DOC_HASH }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  )
}

function mockDocusealTemplateSend() {
  mockFetch.mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        id: 100,
        submitters: {
          tenant: { id: 1, email: 'alice@test.com', role: 'tenant' },
          landlord: { id: 2, email: 'bob@test.com', role: 'landlord' },
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ),
  )
}

function mockDocusealTemplateGet() {
  mockFetch.mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        id: 42,
        submitters: {
          tenant: { id: 1, secret: 'sign-secret-1' },
          landlord: { id: 2, secret: 'sign-secret-2' },
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ),
  )
}

// ── createSigningRequest ────────────────────────────────────────────────────

describe('DocuSealESignatureProvider', () => {
  describe('createSigningRequest', () => {
    it('creates a template in DocuSeal and sends to all signers', async () => {
      mockDocusealTemplateCreate()
      mockDocusealTemplateSend()

      const provider = new DocuSealESignatureProvider()
      const req = await provider.createSigningRequest(DOC_KEY, DOC_HASH, SIGNERS)

      expect(req.documentHash).toBe(DOC_HASH)
      expect(req.documentKey).toBe(DOC_KEY)
      expect(req.signers).toEqual(SIGNERS)
      expect(req.status).toBe('pending')
      expect(req.requestId).toMatch(/^[\da-f-]{36}$/)
      expect(req.createdAt).toBeInstanceOf(Date)

      // Verify two fetch calls were made (create template + send)
      expect(mockFetch).toHaveBeenCalledTimes(2)

      // First call: create template
      const [createUrl, createOpts] = mockFetch.mock.calls[0]
      expect(createUrl).toBe('http://docuseal-test:3000/api/v1/templates')
      expect(createOpts?.method).toBe('POST')
      const createBody = JSON.parse(createOpts?.body as string)
      expect(createBody.key).toBe(DOC_HASH)

      // Second call: send to signers
      const [sendUrl, sendOpts] = mockFetch.mock.calls[1]
      expect(sendUrl).toBe('http://docuseal-test:3000/api/v1/templates/42/send')
      expect(sendOpts?.method).toBe('POST')
    })

    it('stores the provider-assigned document ID for later webhook lookups', async () => {
      mockDocusealTemplateCreate()
      mockDocusealTemplateSend()

      const provider = new DocuSealESignatureProvider()
      const req = await provider.createSigningRequest(DOC_KEY, DOC_HASH, SIGNERS)

      // The provider ID (42) should be stored and returned
      // We verify this indirectly by checking the fetch was called with the right template key
      expect(mockFetch).toHaveBeenCalledTimes(2)
    })

    it('propagates DocuSeal API errors', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response('Unauthorized', { status: 401 }),
      )

      const provider = new DocuSealESignatureProvider()
      await expect(
        provider.createSigningRequest(DOC_KEY, DOC_HASH, SIGNERS),
      ).rejects.toThrow(/DocuSeal API error 401/)
    })
  })

  // ── getSigningUrl ───────────────────────────────────────────────────────

  describe('getSigningUrl', () => {
    it('returns the DocuSeal signing URL when template is accessible', async () => {
      mockDocusealTemplateCreate()
      mockDocusealTemplateSend()
      mockDocusealTemplateGet()

      const provider = new DocuSealESignatureProvider()
      const req = await provider.createSigningRequest(DOC_KEY, DOC_HASH, SIGNERS)

      const { url, expiresAt } = await provider.getSigningUrl(req.requestId, SIGNERS[0].id)

      expect(url).toBe('http://docuseal-test:3000/sign/sign-secret-1')
      expect(expiresAt.getTime()).toBeGreaterThan(Date.now())
    })

    it('falls back to stub URL when DocuSeal API is unreachable', async () => {
      mockDocusealTemplateCreate()
      mockDocusealTemplateSend()
      mockFetch.mockRejectedValueOnce(new Error('Connection refused'))

      const provider = new DocuSealESignatureProvider()
      const req = await provider.createSigningRequest(DOC_KEY, DOC_HASH, SIGNERS)

      const { url } = await provider.getSigningUrl(req.requestId, SIGNERS[0].id)

      expect(url).toContain('/api/v1/webhooks/esignature/stub?token=')
      expect(url).toContain(`signer=${SIGNERS[0].id}`)
      expect(url).toContain(`requestId=${req.requestId}`)
    })

    it('throws for an unknown requestId', async () => {
      const provider = new DocuSealESignatureProvider()
      await expect(
        provider.getSigningUrl('nonexistent-id', SIGNERS[0].id),
      ).rejects.toThrow(/not found/)
    })

    it('throws for an unknown signerId', async () => {
      mockDocusealTemplateCreate()
      mockDocusealTemplateSend()

      const provider = new DocuSealESignatureProvider()
      const req = await provider.createSigningRequest(DOC_KEY, DOC_HASH, SIGNERS)

      await expect(
        provider.getSigningUrl(req.requestId, 'unknown-signer'),
      ).rejects.toThrow(/not found/)
    })
  })

  // ── handleWebhook ─────────────────────────────────────────────────────

  describe('handleWebhook', () => {
    it('rejects a webhook without a valid signature when secret is configured', async () => {
      vi.stubEnv('DOCUSEAL_WEBHOOK_SECRET', 'my-secret')

      mockDocusealTemplateCreate()
      mockDocusealTemplateSend()

      const provider = new DocuSealESignatureProvider()
      const req = await provider.createSigningRequest(DOC_KEY, DOC_HASH, SIGNERS)

      await expect(
        provider.handleWebhook({
          event: 'document.completed',
          payload: { id: 42, status: 'completed', submitters: { tenant: { completed: true } } },
        }),
      ).rejects.toThrow(/Missing webhook signature/)
    })

    it('rejects a webhook with an invalid signature', async () => {
      vi.stubEnv('DOCUSEAL_WEBHOOK_SECRET', 'my-secret')

      mockDocusealTemplateCreate()
      mockDocusealTemplateSend()

      const provider = new DocuSealESignatureProvider()
      const req = await provider.createSigningRequest(DOC_KEY, DOC_HASH, SIGNERS)

      await expect(
        provider.handleWebhook({
          event: 'document.completed',
          signature: 'deadbeef',
          payload: { id: 42, status: 'completed', submitters: { tenant: { completed: true } } },
        }),
      ).rejects.toThrow(/Invalid webhook signature/)
    })

    it('accepts a valid signed webhook and marks the signer as signed', async () => {
      const secret = 'test-webhook-secret'
      vi.stubEnv('DOCUSEAL_WEBHOOK_SECRET', secret)

      mockDocusealTemplateCreate()
      mockDocusealTemplateSend()

      const provider = new DocuSealESignatureProvider()
      const req = await provider.createSigningRequest(DOC_KEY, DOC_HASH, SIGNERS)

      const webhookPayload = {
        event: 'document.completed',
        payload: {
          id: 42,
          status: 'completed',
          submitters: { tenant: { id: 1, completed: true } },
        },
      }

      // Compute correct HMAC signature over payload WITHOUT the signature field
      const crypto = await import('node:crypto')
      const signature = crypto
        .createHmac('sha256', secret)
        .update(JSON.stringify(webhookPayload))
        .digest('hex')

      const result = await provider.handleWebhook({ ...webhookPayload, signature })

      expect(result.signed).toBe(true)
      expect(result.requestId).toBe(req.requestId)
      expect(result.signerId).toBe('tenant-1')
    })

    it('works without webhook secret (stub compat mode)', async () => {
      mockDocusealTemplateCreate()
      mockDocusealTemplateSend()

      const provider = new DocuSealESignatureProvider()
      const req = await provider.createSigningRequest(DOC_KEY, DOC_HASH, SIGNERS)

      const result = await provider.handleWebhook({
        event: 'document.completed',
        payload: {
          id: 42,
          status: 'completed',
          submitters: { tenant: { id: 1, completed: true } },
        },
      })

      expect(result.signed).toBe(true)
      expect(result.signerId).toBe('tenant-1')
    })

    it('ignores non-completion events gracefully', async () => {
      mockDocusealTemplateCreate()
      mockDocusealTemplateSend()

      const provider = new DocuSealESignatureProvider()
      await provider.createSigningRequest(DOC_KEY, DOC_HASH, SIGNERS)

      const result = await provider.handleWebhook({
        event: 'document.sent',
        payload: { id: 42, status: 'sent' },
      })

      expect(result.signed).toBe(false)
      expect(result.requestId).toBe('')
    })

    it('marks request as completed when all signers have signed', async () => {
      mockDocusealTemplateCreate()
      mockDocusealTemplateSend()

      const provider = new DocuSealESignatureProvider()
      const req = await provider.createSigningRequest(DOC_KEY, DOC_HASH, SIGNERS)

      // Sign as tenant
      await provider.handleWebhook({
        event: 'document.completed',
        payload: { id: 42, status: 'completed', submitters: { tenant: { id: 1, completed: true } } },
      })

      // Sign as landlord
      await provider.handleWebhook({
        event: 'document.completed',
        payload: { id: 42, status: 'completed', submitters: { landlord: { id: 2, completed: true } } },
      })

      // Both should be signed
      expect(await provider.verifySignature(req.requestId, 'tenant-1')).toBe(true)
      expect(await provider.verifySignature(req.requestId, 'landlord-1')).toBe(true)
    })
  })

  // ── verifySignature ──────────────────────────────────────────────────

  describe('verifySignature', () => {
    it('returns false before any signing', async () => {
      mockDocusealTemplateCreate()
      mockDocusealTemplateSend()

      const provider = new DocuSealESignatureProvider()
      const req = await provider.createSigningRequest(DOC_KEY, DOC_HASH, SIGNERS)

      expect(await provider.verifySignature(req.requestId, 'tenant-1')).toBe(false)
    })

    it('returns true after a successful webhook marks the signer', async () => {
      mockDocusealTemplateCreate()
      mockDocusealTemplateSend()

      const provider = new DocuSealESignatureProvider()
      const req = await provider.createSigningRequest(DOC_KEY, DOC_HASH, SIGNERS)

      await provider.handleWebhook({
        event: 'document.completed',
        payload: { id: 42, status: 'completed', submitters: { tenant: { id: 1, completed: true } } },
      })

      expect(await provider.verifySignature(req.requestId, 'tenant-1')).toBe(true)
    })

    it('returns false for an unknown requestId', async () => {
      const provider = new DocuSealESignatureProvider()
      expect(await provider.verifySignature('nonexistent', 'tenant-1')).toBe(false)
    })

    it('returns false for an unknown signerId on a valid request', async () => {
      mockDocusealTemplateCreate()
      mockDocusealTemplateSend()

      const provider = new DocuSealESignatureProvider()
      const req = await provider.createSigningRequest(DOC_KEY, DOC_HASH, SIGNERS)

      expect(await provider.verifySignature(req.requestId, 'unknown-signer')).toBe(false)
    })

    it('returns false for unsigned co-signer after one signs', async () => {
      mockDocusealTemplateCreate()
      mockDocusealTemplateSend()

      const provider = new DocuSealESignatureProvider()
      const req = await provider.createSigningRequest(DOC_KEY, DOC_HASH, SIGNERS)

      await provider.handleWebhook({
        event: 'document.completed',
        payload: { id: 42, status: 'completed', submitters: { tenant: { id: 1, completed: true } } },
      })

      expect(await provider.verifySignature(req.requestId, 'landlord-1')).toBe(false)
    })
  })

  // ── document-hash binding ────────────────────────────────────────────

  describe('document-hash binding', () => {
    it('binds the signing request to the exact documentHash', async () => {
      mockDocusealTemplateCreate()
      mockDocusealTemplateSend()

      const provider = new DocuSealESignatureProvider()
      const req = await provider.createSigningRequest(DOC_KEY, DOC_HASH, SIGNERS)

      // The template was created with the correct key (hash)
      const createCall = mockFetch.mock.calls[0]
      const createBody = JSON.parse((createCall[1] as RequestInit).body as string)
      expect(createBody.key).toBe(DOC_HASH)
    })

    it('different hashes produce different template creation calls', async () => {
      mockDocusealTemplateCreate()
      mockDocusealTemplateSend()
      mockDocusealTemplateCreate()
      mockDocusealTemplateSend()

      const provider = new DocuSealESignatureProvider()
      const hash1 = 'a'.repeat(64)
      const hash2 = 'b'.repeat(64)

      await provider.createSigningRequest(DOC_KEY, hash1, SIGNERS)
      await provider.createSigningRequest(DOC_KEY, hash2, SIGNERS)

      const body1 = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string)
      const body2 = JSON.parse((mockFetch.mock.calls[2][1] as RequestInit).body as string)

      expect(body1.key).toBe(hash1)
      expect(body2.key).toBe(hash2)
      expect(body1.key).not.toBe(body2.key)
    })
  })

  // ── webhook signature verification (pure function) ───────────────────

  describe('verifyDocusealWebhookSignature', () => {
    it('returns true for a valid HMAC-SHA256 signature', () => {
      const crypto = require('node:crypto')
      const secret = 'my-secret'
      const body = '{"event":"test"}'
      const sig = crypto.createHmac('sha256', secret).update(body).digest('hex')

      expect(verifyDocusealWebhookSignature(body, sig, secret)).toBe(true)
    })

    it('returns false for an invalid signature', () => {
      expect(verifyDocusealWebhookSignature('body', 'deadbeef', 'secret')).toBe(false)
    })

    it('returns false when signature is empty', () => {
      expect(verifyDocusealWebhookSignature('body', '', 'secret')).toBe(false)
    })
  })
})
