import type { Request, Response, NextFunction } from 'express'
import { RateLimiterRedis, RateLimiterMemory, RateLimiterRes } from 'rate-limiter-flexible'
import { getRedisClient } from '../utils/redis.js'
import { logger, logThrottled } from '../utils/logger.js'
import type { RateLimiterOptions } from '../config/rateLimitConfig.js'

function buildKey(req: Request, keyBy: 'ip' | 'user'): string {
  if (keyBy === 'user') {
    const user = (req as any).user
    const sub = user?.sub ?? user?.id
    if (sub) return `user:${sub}`
  }
  return `ip:${req.ip ?? 'unknown'}`
}

/**
 * Factory that returns an Express middleware backed by RateLimiterRedis.
 * Fails open when Redis is unavailable and emits a warn-level log.
 * 429 responses follow the standard API error envelope:
 *   { success: false, error: { code, message, retryAfter } }
 * In test mode (NODE_ENV=test) the middleware is a no-op pass-through so
 * in-memory state cannot leak across tests sharing the same IP bucket.
 */
export function createRateLimiter(options: RateLimiterOptions) {
  if (process.env.NODE_ENV === 'test') {
    return (_req: Request, _res: Response, next: NextFunction) => next()
  }

  let limiter: RateLimiterRedis | RateLimiterMemory

  try {
    limiter = new RateLimiterRedis({
      storeClient: getRedisClient(),
      points: options.points,
      duration: options.duration,
      keyPrefix: options.keyPrefix,
      insuranceLimiter: new RateLimiterMemory({
        points: options.points,
        duration: options.duration,
        keyPrefix: `${options.keyPrefix}:mem`,
      }),
    })
  } catch {
    logger.warn('[rateLimiter] Redis unavailable during init — falling back to in-memory limiter')
    limiter = new RateLimiterMemory({
      points: options.points,
      duration: options.duration,
      keyPrefix: options.keyPrefix,
    })
  }

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const key = buildKey(req, options.keyBy)

    try {
      const result = await limiter.consume(key)
      res.setHeader('X-RateLimit-Limit', options.points)
      res.setHeader('X-RateLimit-Remaining', result.remainingPoints)
      res.setHeader('X-RateLimit-Reset', Math.ceil((Date.now() + result.msBeforeNext) / 1000))
      next()
    } catch (err) {
      if (err instanceof RateLimiterRes) {
        const retryAfter = Math.ceil(err.msBeforeNext / 1000)
        res.setHeader('Retry-After', retryAfter)
        res.setHeader('X-RateLimit-Limit', options.points)
        res.setHeader('X-RateLimit-Remaining', 0)
        res.setHeader('X-RateLimit-Reset', Math.ceil((Date.now() + err.msBeforeNext) / 1000))
        res.status(429).json({
          success: false,
          error: {
            code: 'RATE_LIMIT_EXCEEDED',
            message: 'Too many requests. Please slow down.',
            retryAfter,
          },
        })
        return
      }

      // Redis or unexpected error — fail open. This is deliberate: rate
      // limiting is not security-relevant (unlike e.g. nonce/replay checks),
      // so an unreachable Redis should degrade to "unlimited" rather than
      // block traffic. Logged at a bounded rate since this path can be hit
      // on every request during a sustained outage.
      logThrottled('warn', 'rate-limiter-redis-fail-open', 10_000, '[rateLimiter] Redis error, failing open', { error: String(err), key })
      next()
    }
  }
}
