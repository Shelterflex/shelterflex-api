import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createTestAgent, expectErrorShape } from '../test-helpers.js'
import { SESSION_TTL_MS, sessionStore, userStore, otpChallengeStore } from '../models/authStore.js'
import { _testOnly_clearAuthRateLimits } from '../middleware/authRateLimit.js'
import type supertest from 'supertest'

vi.mock('../utils/tokens.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../utils/tokens.js')>()
  return {
    ...mod,
    generateOtp: () => '123456',
    generateToken: () => `tok-${Math.random().toString(36).slice(2)}`,
  }
})

describe('Session Hardening', () => {
  const email = 'sessiontest@example.com'

  function freshState() {
    sessionStore.clear()
    userStore.clear()
    otpChallengeStore.clear()
    _testOnly_clearAuthRateLimits()
    vi.useRealTimers()
  }

  beforeEach(freshState)

  async function loginAndGetToken(agent: ReturnType<typeof createTestAgent>): Promise<string> {
    // Reset rate limits before each login so repeated logins within one test don't hit OTP limits
    _testOnly_clearAuthRateLimits()
    await agent.post('/api/auth/request-otp').send({ email }).expect(200)
    const res = await agent.post('/api/auth/verify-otp').send({ email, otp: '123456' }).expect(200)
    return res.body.token as string
  }

  it('expired token should be rejected with 401', async () => {
    vi.useFakeTimers()
    const agent = createTestAgent()

    const token = await loginAndGetToken(agent)

    vi.advanceTimersByTime(SESSION_TTL_MS + 1000)

    const res = await agent.get('/api/auth/me').set('Authorization', `Bearer ${token}`)
    expectErrorShape(res, 'TOKEN_EXPIRED', 401)
  })

  it('logout: token is immediately invalidated', async () => {
    const agent = createTestAgent()
    const token = await loginAndGetToken(agent)

    // Confirm it works before logout
    await agent.get('/api/auth/me').set('Authorization', `Bearer ${token}`).expect(200)

    // Logout
    await agent.post('/api/auth/logout').set('Authorization', `Bearer ${token}`).expect(200)

    // Now it must fail
    const res = await agent.get('/api/auth/me').set('Authorization', `Bearer ${token}`)
    expectErrorShape(res, 'INVALID_TOKEN', 401)
  })

  it('logout-all: all sessions for the user are invalidated', async () => {
    const agent = createTestAgent()

    const token1 = await loginAndGetToken(agent)
    const token2 = await loginAndGetToken(agent)

    // Both work
    await agent.get('/api/auth/me').set('Authorization', `Bearer ${token1}`).expect(200)
    await agent.get('/api/auth/me').set('Authorization', `Bearer ${token2}`).expect(200)

    // Logout-all using token1
    const logoutRes = await agent
      .post('/api/auth/logout-all')
      .set('Authorization', `Bearer ${token1}`)
      .expect(200)
    expect(logoutRes.body.message).toMatch(/2 session/)

    // Both tokens must now be invalid
    expectErrorShape(
      await agent.get('/api/auth/me').set('Authorization', `Bearer ${token1}`),
      'INVALID_TOKEN',
      401,
    )
    expectErrorShape(
      await agent.get('/api/auth/me').set('Authorization', `Bearer ${token2}`),
      'INVALID_TOKEN',
      401,
    )
  })

  it('revoked token is rejected even if not yet expired', async () => {
    const agent = createTestAgent()
    const token = await loginAndGetToken(agent)

    sessionStore.revokeByToken(token)

    const res = await agent.get('/api/auth/me').set('Authorization', `Bearer ${token}`)
    expectErrorShape(res, 'INVALID_TOKEN', 401)
  })

  it('missing token returns 401', async () => {
    const agent = createTestAgent()
    const res = await agent.get('/api/auth/me')
    expectErrorShape(res, 'UNAUTHORIZED', 401)
  })

  it('session stores userAgent when provided', async () => {
    const agent = createTestAgent()
    _testOnly_clearAuthRateLimits()

    await agent.post('/api/auth/request-otp').send({ email }).expect(200)
    await agent
      .post('/api/auth/verify-otp')
      .set('User-Agent', 'TestBrowser/1.0')
      .send({ email, otp: '123456' })
      .expect(200)

    const sessions = sessionStore.getActiveSessionsByEmail(email)
    expect(sessions.length).toBe(1)
    expect(sessions[0].userAgent).toBe('TestBrowser/1.0')
  })

  it('session expires after SESSION_TTL_MS', async () => {
    const agent = createTestAgent()
    await loginAndGetToken(agent)

    const sessions = sessionStore.getActiveSessionsByEmail(email)
    expect(sessions.length).toBeGreaterThan(0)

    const ttlMs = sessions[0].expiresAt.getTime() - sessions[0].createdAt.getTime()
    expect(ttlMs).toBeGreaterThanOrEqual(SESSION_TTL_MS - 1000)
    expect(ttlMs).toBeLessThanOrEqual(SESSION_TTL_MS + 1000)
  })
})
