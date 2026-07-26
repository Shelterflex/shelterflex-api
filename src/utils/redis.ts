import { Redis } from 'ioredis'
import { EventEmitter } from 'node:events'
import { env } from '../schemas/env.js'
import { logger, logThrottled } from './logger.js'

let redis: Redis | null = null

// Simple mock for environments without Redis (e.g. CI/Tests)
class MockRedis extends EventEmitter {
    private readonly storage = new Map<string, string>()
    constructor() {
        super()
    }
    async get(key: string) { return this.storage.get(key) || null }
    async set(key: string, value: string, mode?: string, duration?: number) {
        this.storage.set(key, value)
        return 'OK'
    }
    async del(key: string) { return this.storage.delete(key) ? 1 : 0 }
    async quit() { return 'OK' }
    async keys(pattern: string) {
        const regex = new RegExp('^' + pattern.replaceAll('*', '.*') + '$')
        return Array.from(this.storage.keys()).filter(k => regex.test(k))
    }
}

/**
 * Builds a real ioredis connection with bounded failure behavior.
 *
 * maxRetriesPerRequest/enableOfflineQueue previously defaulted to "queue
 * commands forever while disconnected" (see issue #1) — every command issued
 * during an outage hung instead of rejecting, which defeats the fail-open
 * handling in every caller. enableOfflineQueue: false makes ioredis reject a
 * command immediately if the connection isn't ready, and connectTimeout /
 * commandTimeout bound the two remaining ways a call could stall (a slow
 * initial connect, and a connected-but-unresponsive server). Reconnection
 * itself is handled by ioredis's own retryStrategy timer below, which runs
 * independently of request volume — a sustained outage does not add extra
 * reconnect attempts per incoming request.
 */
export function createRedisConnection(url: string): Redis {
    const client = new Redis(url, {
        connectTimeout: 2000,
        commandTimeout: 1500,
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
        enableReadyCheck: true,
        retryStrategy(times) {
            const delay = Math.min(times * 50, 2000)
            return delay
        },
    })

    client.on('error', (err) => {
        logThrottled('error', 'redis-client-error', 10_000, '[redis] unexpected error', {
            error: err instanceof Error ? err.message : String(err),
        })
    })

    client.on('connect', () => {
        logger.info('[redis] connected', { url })
    })

    return client
}

export function getRedisClient(): Redis {
    if (redis) return redis

    // In test environment or if REDIS_DISABLED is set, use mock
    if (process.env.NODE_ENV === 'test' || process.env.REDIS_DISABLED === 'true') {
        console.log('[redis] using mock client (test/disabled mode)')
        redis = new MockRedis() as any
        return redis!
    }

    redis = createRedisConnection(env.REDIS_URL)
    return redis
}

/**
 * Synchronous, non-blocking Redis status for health checks.
 * Never touches the network, so it cannot hang the /health route.
 */
export function getRedisStatus(): 'ready' | 'connecting' | 'unavailable' | 'disabled' {
    if (process.env.NODE_ENV === 'test' || process.env.REDIS_DISABLED === 'true') {
        return 'disabled'
    }
    if (!redis) return 'unavailable'
    const status = (redis as Redis).status
    if (status === 'ready') return 'ready'
    if (status === 'connecting' || status === 'connect' || status === 'reconnecting') return 'connecting'
    return 'unavailable'
}

export async function closeRedis() {
    if (redis) {
        await redis.quit()
        redis = null
    }
}
