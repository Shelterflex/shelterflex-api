import { describe, it, expect, afterEach } from 'vitest'
import type { Redis } from 'ioredis'
import { createRedisConnection, getRedisStatus } from './redis.js'

describe('createRedisConnection', () => {
  let client: Redis | undefined

  afterEach(async () => {
    if (client) {
      client.disconnect()
      client = undefined
    }
  })

  it('rejects fast instead of hanging when Redis is unreachable', async () => {
    // Nothing listens on this port — simulates issue #1's "Redis unreachable" scenario.
    client = createRedisConnection('redis://127.0.0.1:19999')

    const start = Date.now()
    await expect(client.get('probe')).rejects.toThrow()
    const elapsed = Date.now() - start

    // Well under the 1s "added latency" target from the issue's acceptance criteria.
    expect(elapsed).toBeLessThan(1000)
  })

  it('does not queue commands indefinitely (enableOfflineQueue disabled)', async () => {
    client = createRedisConnection('redis://127.0.0.1:19999')

    // Fire several commands concurrently; none should hang waiting on a
    // reconnect that will never succeed.
    const results = await Promise.allSettled([
      client.get('a'),
      client.set('b', '1'),
      client.del('c'),
    ])

    expect(results.every(r => r.status === 'rejected')).toBe(true)
  })
})

describe('getRedisStatus', () => {
  it('never touches the network and returns a status synchronously', () => {
    // In the vitest environment NODE_ENV=test, so getRedisClient() would use
    // the in-memory mock — getRedisStatus() should reflect that without
    // requiring a real connection.
    expect(getRedisStatus()).toBe('disabled')
  })
})
