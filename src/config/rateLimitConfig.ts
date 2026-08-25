export interface RateLimiterOptions {
  /** Max requests allowed within the window */
  points: number
  /** Window duration in seconds */
  duration: number
  /** Redis key prefix to namespace this limiter */
  keyPrefix: string
  /** Key to use for identification: 'ip' uses req.ip, 'user' uses JWT sub claim (falls back to ip) */
  keyBy: 'ip' | 'user'
}

export const rateLimitProfiles = {
  auth: {
    points: 10,
    duration: 15 * 60, // 15 minutes
    keyPrefix: 'rl:auth',
    keyBy: 'ip',
  },
  otp: {
    points: 5,
    duration: 10 * 60, // 10 minutes
    keyPrefix: 'rl:otp',
    keyBy: 'ip',
  },
  publicSearch: {
    points: 60,
    duration: 60, // 1 minute
    keyPrefix: 'rl:public_search',
    keyBy: 'ip',
  },
  authenticated: {
    points: 300,
    duration: 60, // 1 minute
    keyPrefix: 'rl:authed',
    keyBy: 'user',
  },
  // Privileged admin surfaces — bulk operations and the timelock governance
  // router (issue #35). Keyed by user where a JWT is present, IP otherwise.
  adminBulk: {
    points: 20,
    duration: 60, // 1 minute
    keyPrefix: 'rl:admin_bulk',
    keyBy: 'user',
  },
} as const satisfies Record<string, RateLimiterOptions>

export type RateLimitProfileName = keyof typeof rateLimitProfiles
