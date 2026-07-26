import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Request, Response, NextFunction } from 'express'

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('rate-limiter-flexible', () => {
  const consumeMock = vi.fn()

  class RateLimiterRedisMock {
    constructor(_opts: unknown) {}
    consume = consumeMock
  }

  class RateLimiterMemoryMock {
    constructor(_opts: unknown) {}
    consume = consumeMock
  }

  class RateLimiterResMock {
    remainingPoints: number
    msBeforeNext: number
    consumedPoints: number
    isFirstInDuration: boolean
    constructor(remaining = 0, msBeforeNext = 60000) {
      this.remainingPoints = remaining
      this.msBeforeNext = msBeforeNext
      this.consumedPoints = 1
      this.isFirstInDuration = false
    }
  }

  return {
    RateLimiterRedis: RateLimiterRedisMock,
    RateLimiterMemory: RateLimiterMemoryMock,
    RateLimiterRes: RateLimiterResMock,
    consumeMock,
  }
})

vi.mock('../utils/redis.js', () => ({
  getRedisClient: vi.fn(() => ({})),
}))

vi.mock('../utils/logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
  logThrottled: vi.fn(),
}))

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeReq(overrides: Partial<Request> = {}): Request {
  return { ip: '127.0.0.1', ...overrides } as unknown as Request
}

function makeRes() {
  const headers: Record<string, unknown> = {}
  return {
    setHeader: vi.fn((k: string, v: unknown) => { headers[k] = v }),
    status: vi.fn().mockReturnThis(),
    json: vi.fn(),
    _headers: headers,
  } as unknown as Response & { _headers: Record<string, unknown> }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('createRateLimiter', () => {
  let consumeMock: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    vi.clearAllMocks()
    // Run limiter logic even in the test environment
    vi.stubEnv('NODE_ENV', 'production')
    const mod = await import('rate-limiter-flexible')
    consumeMock = (mod as any).consumeMock
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  const baseOptions = {
    points: 5,
    duration: 60,
    keyPrefix: 'rl:test',
    keyBy: 'ip' as const,
  }

  it('passes request through when below limit', async () => {
    consumeMock.mockResolvedValueOnce({ remainingPoints: 4, msBeforeNext: 55000 })

    const { createRateLimiter } = await import('./rateLimiter.js')
    const mw = createRateLimiter(baseOptions)
    const req = makeReq()
    const res = makeRes()
    const next = vi.fn() as NextFunction

    await mw(req, res, next)

    expect(next).toHaveBeenCalledOnce()
    expect(res.status).not.toHaveBeenCalled()
  })

  it('passes request when exactly at limit (consume still resolves)', async () => {
    consumeMock.mockResolvedValueOnce({ remainingPoints: 0, msBeforeNext: 0 })

    const { createRateLimiter } = await import('./rateLimiter.js')
    const mw = createRateLimiter(baseOptions)
    const req = makeReq()
    const res = makeRes()
    const next = vi.fn() as NextFunction

    await mw(req, res, next)

    expect(next).toHaveBeenCalledOnce()
  })

  it('returns 429 with Retry-After header when above limit', async () => {
    const { RateLimiterRes: RLRes } = await import('rate-limiter-flexible')
    consumeMock.mockRejectedValueOnce(new RLRes(0, 30000))

    const { createRateLimiter } = await import('./rateLimiter.js')
    const mw = createRateLimiter(baseOptions)
    const req = makeReq()
    const res = makeRes()
    const next = vi.fn() as NextFunction

    await mw(req, res, next)

    expect(next).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(429)
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: expect.objectContaining({
          code: 'RATE_LIMIT_EXCEEDED',
          retryAfter: 30,
        }),
      }),
    )
    expect(res.setHeader).toHaveBeenCalledWith('Retry-After', 30)
  })

  it('fails open and calls next when Redis throws an unexpected error', async () => {
    consumeMock.mockRejectedValueOnce(new Error('Redis connection lost'))

    const { createRateLimiter } = await import('./rateLimiter.js')
    const mw = createRateLimiter(baseOptions)
    const req = makeReq()
    const res = makeRes()
    const next = vi.fn() as NextFunction

    await mw(req, res, next)

    expect(next).toHaveBeenCalledOnce()
    expect(res.status).not.toHaveBeenCalled()
  })

  it('uses JWT sub as key when keyBy is user and token is present', async () => {
    consumeMock.mockResolvedValueOnce({ remainingPoints: 299, msBeforeNext: 55000 })

    const { createRateLimiter } = await import('./rateLimiter.js')
    const mw = createRateLimiter({ ...baseOptions, keyBy: 'user' })
    const req = makeReq({ user: { sub: 'user-abc-123' } } as any)
    const res = makeRes()
    const next = vi.fn() as NextFunction

    await mw(req, res, next)

    expect(next).toHaveBeenCalledOnce()
    expect(consumeMock).toHaveBeenCalledWith('user:user-abc-123')
  })

  it('falls back to IP key when keyBy is user but token is absent', async () => {
    consumeMock.mockResolvedValueOnce({ remainingPoints: 59, msBeforeNext: 55000 })

    const { createRateLimiter } = await import('./rateLimiter.js')
    const mw = createRateLimiter({ ...baseOptions, keyBy: 'user' })
    const req = makeReq({ ip: '10.0.0.1' })
    const res = makeRes()
    const next = vi.fn() as NextFunction

    await mw(req, res, next)

    expect(consumeMock).toHaveBeenCalledWith('ip:10.0.0.1')
  })
})
