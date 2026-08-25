import request from 'supertest'
import type { NextFunction, Request, Response } from 'express'
import { describe, expect, it, vi } from 'vitest'

/**
 * Issue #35: the admin timelock router used to be mounted ahead of the CORS
 * block and the Redis-backed rate limiters, leaving the most privileged
 * surface in the API as the only one with no throttle and no origin policy.
 * It now sits below both. These tests fail if it is ever hoisted back above
 * them.
 *
 * createRateLimiter is a deliberate no-op under NODE_ENV=test (so in-memory
 * buckets can't leak across suites sharing an IP), so a burst here would never
 * 429. Instead the factory is mocked with a pass-through that stamps the
 * profile it was built from onto the response — that proves the limiter is in
 * the timelock chain, and which profile it is, without depending on Redis.
 */

const limiters = vi.hoisted(() => ({ profiles: [] as string[] }))

vi.mock('./middleware/rateLimiter.js', () => ({
  createRateLimiter: (options: { points: number; keyPrefix: string }) => {
    limiters.profiles.push(options.keyPrefix)
    return (_req: Request, res: Response, next: NextFunction) => {
      res.setHeader('X-Test-RateLimit-Profile', options.keyPrefix)
      res.setHeader('X-Test-RateLimit-Limit', String(options.points))
      next()
    }
  },
}))

const { createApp } = await import('./app.js')
const { rateLimitProfiles } = await import('./config/rateLimitConfig.js')

const app = createApp()
const ALLOWED_ORIGIN = 'http://localhost:3000'
const TIMELOCK_PATH = '/api/admin/timelock/transactions'

describe('admin timelock router — rate limiting (issue #35)', () => {
  it('builds an admin-scoped limiter at app startup', () => {
    expect(limiters.profiles).toContain(rateLimitProfiles.adminBulk.keyPrefix)
  })

  it('runs the admin limiter before the timelock router', async () => {
    const res = await request(app).get(TIMELOCK_PATH)

    expect(res.status).toBe(200)
    expect(res.headers['x-test-ratelimit-profile']).toBe(rateLimitProfiles.adminBulk.keyPrefix)
    expect(res.headers['x-test-ratelimit-limit']).toBe(String(rateLimitProfiles.adminBulk.points))
  })

  it('rate-limits the mutating timelock endpoints too, not just the read', async () => {
    const res = await request(app).post('/api/admin/timelock/execute').send({})

    expect(res.status).toBe(400)
    expect(res.headers['x-test-ratelimit-profile']).toBe(rateLimitProfiles.adminBulk.keyPrefix)
  })
})

describe('admin timelock router — CORS policy (issue #35)', () => {
  it('returns the allow-origin header for an allowed origin', async () => {
    const res = await request(app).get(TIMELOCK_PATH).set('Origin', ALLOWED_ORIGIN)

    expect(res.status).toBe(200)
    expect(res.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN)
  })

  it('withholds the allow-origin header for an origin outside the policy', async () => {
    const res = await request(app).get(TIMELOCK_PATH).set('Origin', 'https://evil.example.com')

    expect(res.headers['access-control-allow-origin']).toBeUndefined()
  })

  it('answers the CORS preflight for a timelock mutation', async () => {
    const res = await request(app)
      .options('/api/admin/timelock/execute')
      .set('Origin', ALLOWED_ORIGIN)
      .set('Access-Control-Request-Method', 'POST')

    expect(res.status).toBe(204)
    expect(res.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN)
  })
})

describe('admin timelock router — behaviour unchanged by the move (issue #35)', () => {
  it('still serves the transactions listing at the unversioned path', async () => {
    const res = await request(app).get(TIMELOCK_PATH)

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ transactions: [] })
  })

  it('still rejects an execute with no txHash', async () => {
    const res = await request(app).post('/api/admin/timelock/execute').send({})

    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'Missing txHash' })
  })

  it('still rejects a cancel with no txHash', async () => {
    const res = await request(app).post('/api/admin/timelock/cancel').send({})

    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'Missing txHash' })
  })

  it('is still unversioned-only — no timelock listing under /api/v1 (issue #4 scope)', async () => {
    const res = await request(app).get('/api/v1/admin/timelock/transactions')

    // Whatever the generic /api/v1/admin chain answers with, it is not the
    // timelock router: adding a versioned mount is issue #4's job, not this one.
    expect(res.status).not.toBe(200)
    expect(res.body).not.toHaveProperty('transactions')
  })
})
