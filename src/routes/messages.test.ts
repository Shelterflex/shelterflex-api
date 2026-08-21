/**
 * Integration tests for the landlord↔tenant messaging service.
 *
 * Authorization is the primary risk: a non-participant must never be able to
 * read or post to a conversation they don't belong to.
 *
 * The test suite covers:
 * - Creating / get-or-creating conversations
 * - Posting and reading messages as a participant
 * - Non-participant receives 403 on read and post
 * - Pagination (limit / before cursor)
 * - Read-state (markMessagesRead / unreadCount)
 * - Self-conversation rejection
 * - 401 for unauthenticated requests
 * - Message persistence (state survives multiple requests)
 */

import { describe, it, expect, beforeEach } from 'vitest'
import request from 'supertest'
import { createApp } from '../app.js'
import { messageStore } from '../models/messageStore.js'
import { sessionStore, userStore } from '../models/authStore.js'
import { resetRateLimitStore } from '../middleware/comprehensiveRateLimit.js'

// ── Test helpers ──────────────────────────────────────────────────────────────

/**
 * Creates a user in the fallback in-memory cache and issues a session token.
 * In test mode the user store tries the Postgres repo (which fails since
 * DATABASE_URL is absent) and falls back to the in-memory cache, so
 * getOrCreateByEmail is the right entry point.
 *
 * Returns { token, userId } — userId is resolved after creation.
 */
async function createTestUser(email: string): Promise<{ token: string; userId: string }> {
  const user = await userStore.getOrCreateByEmail(email)
  const token = `token-${email.replace(/[^a-z0-9]/gi, '-')}`
  await sessionStore.create(email, token)
  return { token, userId: user.id }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Messages API', () => {
  let app: ReturnType<typeof createApp>
  let landlordToken: string
  let landlordId: string
  let tenantToken: string
  let tenantId: string
  let outsiderToken: string

  beforeEach(async () => {
    resetRateLimitStore()
    await messageStore.clear()
    userStore.clear()
    sessionStore.clear()
    app = createApp()

    const landlord = await createTestUser('landlord@test.com')
    landlordToken = landlord.token
    landlordId = landlord.userId

    const tenant = await createTestUser('tenant@test.com')
    tenantToken = tenant.token
    tenantId = tenant.userId

    const outsider = await createTestUser('outsider@test.com')
    outsiderToken = outsider.token
    void outsider.userId // outsiderId is intentionally unused — we test via token
  })

  // ── Unauthenticated ───────────────────────────────────────────────────────

  describe('Unauthenticated access', () => {
    it('GET /conversations returns 401 without token', async () => {
      const res = await request(app).get('/api/messages/conversations').expect(401)
      expect(res.body.error?.code).toBe('UNAUTHORIZED')
    })

    it('POST /conversations returns 401 without token', async () => {
      const res = await request(app)
        .post('/api/messages/conversations')
        .send({ recipientId: tenantId })
        .expect(401)
      expect(res.body.error?.code).toBe('UNAUTHORIZED')
    })

    it('GET messages returns 401 without token', async () => {
      const fakeId = '550e8400-e29b-41d4-a716-446655440001'
      const res = await request(app)
        .get(`/api/messages/conversations/${fakeId}/messages`)
        .expect(401)
      expect(res.body.error?.code).toBe('UNAUTHORIZED')
    })
  })

  // ── Create / get-or-create conversation ───────────────────────────────────

  describe('POST /messages/conversations', () => {
    it('creates a new conversation between landlord and tenant', async () => {
      const res = await request(app)
        .post('/api/messages/conversations')
        .set('Authorization', `Bearer ${landlordToken}`)
        .send({ recipientId: tenantId })
        .expect(201)

      expect(res.body.success).toBe(true)
      const conv = res.body.data
      expect(conv.conversationId).toBeDefined()
      expect(conv.participantIds).toHaveLength(2)
      expect(conv.participantIds).toContain(landlordId)
      expect(conv.participantIds).toContain(tenantId)
      expect(conv.listingId).toBeUndefined()
      expect(conv.dealId).toBeUndefined()
    })

    it('returns the same conversation on a second identical call (idempotent)', async () => {
      const res1 = await request(app)
        .post('/api/messages/conversations')
        .set('Authorization', `Bearer ${landlordToken}`)
        .send({ recipientId: tenantId })
        .expect(201)

      const res2 = await request(app)
        .post('/api/messages/conversations')
        .set('Authorization', `Bearer ${landlordToken}`)
        .send({ recipientId: tenantId })
        .expect(201)

      expect(res1.body.data.conversationId).toBe(res2.body.data.conversationId)
    })

    it('is symmetric — same conversation when tenant initiates', async () => {
      const res1 = await request(app)
        .post('/api/messages/conversations')
        .set('Authorization', `Bearer ${landlordToken}`)
        .send({ recipientId: tenantId })
        .expect(201)

      const res2 = await request(app)
        .post('/api/messages/conversations')
        .set('Authorization', `Bearer ${tenantToken}`)
        .send({ recipientId: landlordId })
        .expect(201)

      expect(res1.body.data.conversationId).toBe(res2.body.data.conversationId)
    })

    it('scopes conversations by listingId — two different listings = two conversations', async () => {
      const listingId1 = '550e8400-e29b-41d4-a716-446655440001'
      const listingId2 = '550e8400-e29b-41d4-a716-446655440002'

      const res1 = await request(app)
        .post('/api/messages/conversations')
        .set('Authorization', `Bearer ${landlordToken}`)
        .send({ recipientId: tenantId, listingId: listingId1 })
        .expect(201)

      const res2 = await request(app)
        .post('/api/messages/conversations')
        .set('Authorization', `Bearer ${landlordToken}`)
        .send({ recipientId: tenantId, listingId: listingId2 })
        .expect(201)

      expect(res1.body.data.conversationId).not.toBe(res2.body.data.conversationId)
      expect(res1.body.data.listingId).toBe(listingId1)
      expect(res2.body.data.listingId).toBe(listingId2)
    })

    it('rejects self-conversation with 400', async () => {
      const res = await request(app)
        .post('/api/messages/conversations')
        .set('Authorization', `Bearer ${landlordToken}`)
        .send({ recipientId: landlordId })
        .expect(400)
      expect(res.body.error.code).toBe('VALIDATION_ERROR')
    })

    it('rejects missing recipientId', async () => {
      const res = await request(app)
        .post('/api/messages/conversations')
        .set('Authorization', `Bearer ${landlordToken}`)
        .send({})
        .expect(400)
      expect(res.body.error.code).toBe('VALIDATION_ERROR')
    })

    it('rejects invalid listingId (not a UUID)', async () => {
      const res = await request(app)
        .post('/api/messages/conversations')
        .set('Authorization', `Bearer ${landlordToken}`)
        .send({ recipientId: tenantId, listingId: 'not-a-uuid' })
        .expect(400)
      expect(res.body.error.code).toBe('VALIDATION_ERROR')
    })
  })

  // ── List conversations ─────────────────────────────────────────────────────

  describe('GET /messages/conversations', () => {
    it('returns conversations the user participates in', async () => {
      await request(app)
        .post('/api/messages/conversations')
        .set('Authorization', `Bearer ${landlordToken}`)
        .send({ recipientId: tenantId })
        .expect(201)

      const res = await request(app)
        .get('/api/messages/conversations')
        .set('Authorization', `Bearer ${landlordToken}`)
        .expect(200)

      expect(res.body.success).toBe(true)
      expect(res.body.data.conversations).toHaveLength(1)
      expect(res.body.data.nextCursor).toBeNull()
    })

    it('does not return conversations the user is not part of', async () => {
      await request(app)
        .post('/api/messages/conversations')
        .set('Authorization', `Bearer ${landlordToken}`)
        .send({ recipientId: tenantId })
        .expect(201)

      const res = await request(app)
        .get('/api/messages/conversations')
        .set('Authorization', `Bearer ${outsiderToken}`)
        .expect(200)

      expect(res.body.data.conversations).toHaveLength(0)
    })

    it('respects limit parameter and returns a nextCursor when more exist', async () => {
      // Create two distinct conversations for the landlord
      const extraUser = await createTestUser('extra@test.com')
      await request(app)
        .post('/api/messages/conversations')
        .set('Authorization', `Bearer ${landlordToken}`)
        .send({ recipientId: tenantId })
        .expect(201)
      await request(app)
        .post('/api/messages/conversations')
        .set('Authorization', `Bearer ${landlordToken}`)
        .send({ recipientId: extraUser.userId })
        .expect(201)

      const res = await request(app)
        .get('/api/messages/conversations?limit=1')
        .set('Authorization', `Bearer ${landlordToken}`)
        .expect(200)

      expect(res.body.data.conversations).toHaveLength(1)
      expect(res.body.data.nextCursor).toBeTruthy()
    })
  })

  // ── Get single conversation ────────────────────────────────────────────────

  describe('GET /messages/conversations/:conversationId', () => {
    it('returns conversation data to any participant', async () => {
      const createRes = await request(app)
        .post('/api/messages/conversations')
        .set('Authorization', `Bearer ${landlordToken}`)
        .send({ recipientId: tenantId })
        .expect(201)
      const conversationId = createRes.body.data.conversationId

      const res = await request(app)
        .get(`/api/messages/conversations/${conversationId}`)
        .set('Authorization', `Bearer ${tenantToken}`)
        .expect(200)

      expect(res.body.data.conversationId).toBe(conversationId)
    })

    it('returns 403 to a non-participant', async () => {
      const createRes = await request(app)
        .post('/api/messages/conversations')
        .set('Authorization', `Bearer ${landlordToken}`)
        .send({ recipientId: tenantId })
        .expect(201)
      const conversationId = createRes.body.data.conversationId

      const res = await request(app)
        .get(`/api/messages/conversations/${conversationId}`)
        .set('Authorization', `Bearer ${outsiderToken}`)
        .expect(403)

      expect(res.body.error.code).toBe('FORBIDDEN')
    })

    it('returns 404 for a non-existent conversation', async () => {
      const fakeId = '550e8400-e29b-41d4-a716-446655440999'
      const res = await request(app)
        .get(`/api/messages/conversations/${fakeId}`)
        .set('Authorization', `Bearer ${landlordToken}`)
        .expect(404)

      expect(res.body.error.code).toBe('NOT_FOUND')
    })
  })

  // ── Post message ──────────────────────────────────────────────────────────

  describe('POST /messages/conversations/:conversationId/messages', () => {
    let conversationId: string

    beforeEach(async () => {
      const res = await request(app)
        .post('/api/messages/conversations')
        .set('Authorization', `Bearer ${landlordToken}`)
        .send({ recipientId: tenantId })
        .expect(201)
      conversationId = res.body.data.conversationId
    })

    it('allows the initiating participant to post', async () => {
      const res = await request(app)
        .post(`/api/messages/conversations/${conversationId}/messages`)
        .set('Authorization', `Bearer ${landlordToken}`)
        .send({ body: 'When can you move in?' })
        .expect(201)

      expect(res.body.success).toBe(true)
      const msg = res.body.data
      expect(msg.messageId).toBeDefined()
      expect(msg.conversationId).toBe(conversationId)
      expect(msg.senderId).toBe(landlordId)
      expect(msg.body).toBe('When can you move in?')
      expect(msg.readBy).toContain(landlordId)
      expect(msg.createdAt).toBeDefined()
    })

    it('allows the other participant to reply', async () => {
      await request(app)
        .post(`/api/messages/conversations/${conversationId}/messages`)
        .set('Authorization', `Bearer ${landlordToken}`)
        .send({ body: 'Hello there' })
        .expect(201)

      const res = await request(app)
        .post(`/api/messages/conversations/${conversationId}/messages`)
        .set('Authorization', `Bearer ${tenantToken}`)
        .send({ body: 'I can move in on the 1st' })
        .expect(201)

      expect(res.body.data.senderId).toBe(tenantId)
    })

    it('returns 403 for a non-participant — cross-tenant access rejected', async () => {
      const res = await request(app)
        .post(`/api/messages/conversations/${conversationId}/messages`)
        .set('Authorization', `Bearer ${outsiderToken}`)
        .send({ body: 'Sneaky intruder message' })
        .expect(403)

      expect(res.body.error.code).toBe('FORBIDDEN')
    })

    it('rejects empty body with 400', async () => {
      const res = await request(app)
        .post(`/api/messages/conversations/${conversationId}/messages`)
        .set('Authorization', `Bearer ${landlordToken}`)
        .send({ body: '' })
        .expect(400)
      expect(res.body.error.code).toBe('VALIDATION_ERROR')
    })

    it('rejects body exceeding 4000 characters with 400', async () => {
      const res = await request(app)
        .post(`/api/messages/conversations/${conversationId}/messages`)
        .set('Authorization', `Bearer ${landlordToken}`)
        .send({ body: 'x'.repeat(4001) })
        .expect(400)
      expect(res.body.error.code).toBe('VALIDATION_ERROR')
    })

    it('accepts a body of exactly 4000 characters', async () => {
      const res = await request(app)
        .post(`/api/messages/conversations/${conversationId}/messages`)
        .set('Authorization', `Bearer ${landlordToken}`)
        .send({ body: 'x'.repeat(4000) })
        .expect(201)
      expect(res.body.success).toBe(true)
    })

    it('returns 404 when the conversation does not exist', async () => {
      const fakeId = '550e8400-e29b-41d4-a716-446655440999'
      const res = await request(app)
        .post(`/api/messages/conversations/${fakeId}/messages`)
        .set('Authorization', `Bearer ${landlordToken}`)
        .send({ body: 'Hello?' })
        .expect(404)
      expect(res.body.error.code).toBe('NOT_FOUND')
    })
  })

  // ── List messages (pagination) ────────────────────────────────────────────

  describe('GET /messages/conversations/:conversationId/messages', () => {
    let conversationId: string

    beforeEach(async () => {
      const createRes = await request(app)
        .post('/api/messages/conversations')
        .set('Authorization', `Bearer ${landlordToken}`)
        .send({ recipientId: tenantId })
        .expect(201)
      conversationId = createRes.body.data.conversationId

      // Post 5 messages alternating senders
      for (let i = 1; i <= 5; i++) {
        const token = i % 2 === 0 ? tenantToken : landlordToken
        await request(app)
          .post(`/api/messages/conversations/${conversationId}/messages`)
          .set('Authorization', `Bearer ${token}`)
          .send({ body: `Message number ${i}` })
          .expect(201)
      }
    })

    it('returns messages to a participant (newest first)', async () => {
      const res = await request(app)
        .get(`/api/messages/conversations/${conversationId}/messages`)
        .set('Authorization', `Bearer ${landlordToken}`)
        .expect(200)

      expect(res.body.success).toBe(true)
      expect(res.body.data.messages).toHaveLength(5)
      expect(res.body.data.total).toBe(5)
      // Newest first
      const bodies = res.body.data.messages.map((m: { body: string }) => m.body)
      expect(bodies[0]).toBe('Message number 5')
      expect(bodies[4]).toBe('Message number 1')
    })

    it('respects the limit parameter', async () => {
      const res = await request(app)
        .get(`/api/messages/conversations/${conversationId}/messages?limit=2`)
        .set('Authorization', `Bearer ${landlordToken}`)
        .expect(200)

      expect(res.body.data.messages).toHaveLength(2)
      expect(res.body.data.nextCursor).toBeTruthy()
    })

    it('paginates correctly with the before cursor', async () => {
      // First page
      const page1 = await request(app)
        .get(`/api/messages/conversations/${conversationId}/messages?limit=2`)
        .set('Authorization', `Bearer ${landlordToken}`)
        .expect(200)

      expect(page1.body.data.nextCursor).toBeTruthy()
      const cursor = page1.body.data.nextCursor

      // Second page
      const page2 = await request(app)
        .get(
          `/api/messages/conversations/${conversationId}/messages?limit=2&before=${cursor}`,
        )
        .set('Authorization', `Bearer ${landlordToken}`)
        .expect(200)

      // Pages must not overlap
      const ids1 = new Set(page1.body.data.messages.map((m: { messageId: string }) => m.messageId))
      const ids2 = page2.body.data.messages.map((m: { messageId: string }) => m.messageId)
      for (const id of ids2) {
        expect(ids1.has(id)).toBe(false)
      }
    })

    it('returns 403 when a non-participant tries to read messages', async () => {
      const res = await request(app)
        .get(`/api/messages/conversations/${conversationId}/messages`)
        .set('Authorization', `Bearer ${outsiderToken}`)
        .expect(403)

      expect(res.body.error.code).toBe('FORBIDDEN')
    })
  })

  // ── Read state ────────────────────────────────────────────────────────────

  describe('POST /messages/conversations/:conversationId/read', () => {
    let conversationId: string
    let messageId: string

    beforeEach(async () => {
      // Landlord creates conversation and sends a message
      const createRes = await request(app)
        .post('/api/messages/conversations')
        .set('Authorization', `Bearer ${landlordToken}`)
        .send({ recipientId: tenantId })
        .expect(201)
      conversationId = createRes.body.data.conversationId

      const msgRes = await request(app)
        .post(`/api/messages/conversations/${conversationId}/messages`)
        .set('Authorization', `Bearer ${landlordToken}`)
        .send({ body: 'Are you interested in viewing the property?' })
        .expect(201)
      messageId = msgRes.body.data.messageId
    })

    it("tenant's unreadCount is 1 before marking read", async () => {
      const res = await request(app)
        .get(`/api/messages/conversations/${conversationId}`)
        .set('Authorization', `Bearer ${tenantToken}`)
        .expect(200)
      expect(res.body.data.unreadCount).toBe(1)
    })

    it('marks messages as read and adds userId to readBy', async () => {
      // Mark read
      await request(app)
        .post(`/api/messages/conversations/${conversationId}/read`)
        .set('Authorization', `Bearer ${tenantToken}`)
        .expect(200)

      // Message should now include tenantId in readBy
      const msgsRes = await request(app)
        .get(`/api/messages/conversations/${conversationId}/messages`)
        .set('Authorization', `Bearer ${tenantToken}`)
        .expect(200)

      const msg = msgsRes.body.data.messages.find(
        (m: { messageId: string }) => m.messageId === messageId,
      )
      expect(msg?.readBy).toContain(tenantId)
    })

    it('unreadCount drops to 0 after marking read', async () => {
      await request(app)
        .post(`/api/messages/conversations/${conversationId}/read`)
        .set('Authorization', `Bearer ${tenantToken}`)
        .expect(200)

      const res = await request(app)
        .get(`/api/messages/conversations/${conversationId}`)
        .set('Authorization', `Bearer ${tenantToken}`)
        .expect(200)
      expect(res.body.data.unreadCount).toBe(0)
    })

    it('is idempotent — marking read twice does not error', async () => {
      await request(app)
        .post(`/api/messages/conversations/${conversationId}/read`)
        .set('Authorization', `Bearer ${tenantToken}`)
        .expect(200)

      await request(app)
        .post(`/api/messages/conversations/${conversationId}/read`)
        .set('Authorization', `Bearer ${tenantToken}`)
        .expect(200)
    })

    it('returns 403 when a non-participant calls mark-read', async () => {
      const res = await request(app)
        .post(`/api/messages/conversations/${conversationId}/read`)
        .set('Authorization', `Bearer ${outsiderToken}`)
        .expect(403)

      expect(res.body.error.code).toBe('FORBIDDEN')
    })
  })

  // ── Persistence (state survives across requests) ───────────────────────────

  describe('Message persistence', () => {
    it('messages posted by one participant are immediately visible to the other', async () => {
      const createRes = await request(app)
        .post('/api/messages/conversations')
        .set('Authorization', `Bearer ${landlordToken}`)
        .send({ recipientId: tenantId })
        .expect(201)
      const conversationId = createRes.body.data.conversationId

      await request(app)
        .post(`/api/messages/conversations/${conversationId}/messages`)
        .set('Authorization', `Bearer ${landlordToken}`)
        .send({ body: 'When can you move in?' })
        .expect(201)

      const res = await request(app)
        .get(`/api/messages/conversations/${conversationId}/messages`)
        .set('Authorization', `Bearer ${tenantToken}`)
        .expect(200)

      expect(res.body.data.messages).toHaveLength(1)
      expect(res.body.data.messages[0].body).toBe('When can you move in?')
    })

    it('lastMessage is populated on conversation list after first message', async () => {
      const createRes = await request(app)
        .post('/api/messages/conversations')
        .set('Authorization', `Bearer ${landlordToken}`)
        .send({ recipientId: tenantId })
        .expect(201)
      const conversationId = createRes.body.data.conversationId

      await request(app)
        .post(`/api/messages/conversations/${conversationId}/messages`)
        .set('Authorization', `Bearer ${landlordToken}`)
        .send({ body: 'The viewing is scheduled for Saturday.' })
        .expect(201)

      const listRes = await request(app)
        .get('/api/messages/conversations')
        .set('Authorization', `Bearer ${landlordToken}`)
        .expect(200)

      const conv = listRes.body.data.conversations[0]
      expect(conv.lastMessage).toBeDefined()
      expect(conv.lastMessage.body).toBe('The viewing is scheduled for Saturday.')
    })
  })
})
