import { describe, it, expect } from 'vitest'
import {
  assertSafeSeedTarget,
  hasAllowRemoteFlag,
  parseTarget,
  SeedGuardError,
} from './guard.js'

describe('parseTarget', () => {
  it('extracts host and database without credentials', () => {
    const target = parseTarget('postgres://app:secret@localhost:5432/app')
    expect(target.host).toBe('localhost')
    expect(target.database).toBe('app')
    expect(target.isLocal).toBe(true)
    expect(target.describe).toBe('localhost:5432/app')
    expect(target.describe).not.toContain('secret')
  })

  it('treats loopback addresses and docker host as local', () => {
    expect(parseTarget('postgres://u@127.0.0.1:5432/app').isLocal).toBe(true)
    expect(parseTarget('postgres://u@127.5.5.5:5432/app').isLocal).toBe(true)
    expect(parseTarget('postgres://u@[::1]:5432/app').isLocal).toBe(true)
    expect(parseTarget('postgres://u@host.docker.internal:5432/app').isLocal).toBe(true)
  })

  it('treats a unix socket connection as local', () => {
    const target = parseTarget('postgres://u@/app?host=/var/run/postgresql')
    expect(target.isLocal).toBe(true)
    expect(target.database).toBe('app')
  })

  it('treats anything else as non-local', () => {
    expect(parseTarget('postgres://u:p@db.example.com:5432/app').isLocal).toBe(false)
    expect(parseTarget('postgres://u:p@10.2.3.4:5432/app').isLocal).toBe(false)
  })

  it('rejects a malformed connection string', () => {
    expect(() => parseTarget('not-a-url')).toThrow(SeedGuardError)
  })
})

describe('assertSafeSeedTarget', () => {
  const localUrl = 'postgres://app:app@localhost:5432/app'
  const remoteUrl = 'postgres://app:app@db.example.com:5432/app'

  it('allows a local target in development', () => {
    const target = assertSafeSeedTarget({ databaseUrl: localUrl, nodeEnv: 'development' })
    expect(target.database).toBe('app')
  })

  it('refuses to run when NODE_ENV=production', () => {
    expect(() =>
      assertSafeSeedTarget({ databaseUrl: localUrl, nodeEnv: 'production' }),
    ).toThrow(/NODE_ENV=production/)
  })

  it('refuses production even with the confirmation flag', () => {
    expect(() =>
      assertSafeSeedTarget({
        databaseUrl: localUrl,
        nodeEnv: 'production',
        allowRemote: true,
      }),
    ).toThrow(/NODE_ENV=production/)
  })

  it('refuses a non-local host without confirmation', () => {
    expect(() =>
      assertSafeSeedTarget({ databaseUrl: remoteUrl, nodeEnv: 'development' }),
    ).toThrow(/non-local host "db.example.com"/)
  })

  it('allows a non-local host once confirmed', () => {
    const target = assertSafeSeedTarget({
      databaseUrl: remoteUrl,
      nodeEnv: 'development',
      allowRemote: true,
    })
    expect(target.isLocal).toBe(false)
  })

  it('fails loudly when DATABASE_URL is missing', () => {
    expect(() =>
      assertSafeSeedTarget({ databaseUrl: undefined, nodeEnv: 'development' }),
    ).toThrow(/DATABASE_URL is not set/)
  })

  it('fails when DATABASE_URL names no database', () => {
    expect(() =>
      assertSafeSeedTarget({
        databaseUrl: 'postgres://app:app@localhost:5432',
        nodeEnv: 'development',
      }),
    ).toThrow(/does not name a database/)
  })
})

describe('hasAllowRemoteFlag', () => {
  it('reads the flag from argv', () => {
    expect(hasAllowRemoteFlag(['--allow-remote'], {})).toBe(true)
    expect(hasAllowRemoteFlag([], {})).toBe(false)
  })

  it('reads the flag from the environment', () => {
    expect(hasAllowRemoteFlag([], { SEED_ALLOW_REMOTE: 'true' })).toBe(true)
    expect(hasAllowRemoteFlag([], { SEED_ALLOW_REMOTE: 'false' })).toBe(false)
  })
})
