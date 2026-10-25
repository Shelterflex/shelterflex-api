import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import express, { type Express } from 'express'
import { errorHandler } from '../middleware/errorHandler.js'
import { sessionStore, userStore } from '../models/authStore.js'
import { vaultUnlockStore } from '../services/vaultUnlockStore.js'
import { requireVaultUnlocked } from '../middleware/requireVaultUnlocked.js'

const sent = vi.hoisted(() => ({ otp: '' }))
vi.mock('../services/otpDeliveryFactory.js', () => ({
  createOtpDeliveryProvider: () => ({
    sendOtp: async (_email: string, otp: string) => {
      sent.otp = otp
    },
  }),
}))
vi.mock('../middleware/rateLimiter.js', () => ({
  createRateLimiter: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}))
vi.mock('../utils/auditLogger.js', () => ({
  auditLog: vi.fn(),
  extractAuditContext: vi.fn(() => ({})),
}))

import { createTenantDocumentVaultRouter } from './tenantDocumentVault.js'
import { createVaultUnlockRouter } from './vaultUnlock.js'

describe('document vault step-up verification', () => {
  let app: Express
  let token: string

  beforeEach(async () => {
    vaultUnlockStore.clear()
    userStore.clear()
    sessionStore.clear()
    await userStore.getOrCreateByEmail('vault-user@test.com')
    token = (await sessionStore.create('vault-user@test.com', `vault-${Date.now()}`)).token

    app = express()
    app.use(express.json())
    app.use('/api/tenant/vault/unlock', createVaultUnlockRouter())
    app.use('/api/tenant/vault', createTenantDocumentVaultRouter())
    app.use(errorHandler)
  })

  const auth = () => ({ Authorization: `Bearer ${token}` })

  it('keeps the vault locked until the user re-verifies', async () => {
    await request(app).get('/api/tenant/vault').set(auth()).expect(403)

    // The error says why, so the web app knows to ask for the code.
    const next = vi.fn()
    requireVaultUnlocked({ headers: { authorization: `Bearer ${token}` } } as never, {} as never, next)
    expect(next.mock.calls[0]![0]).toMatchObject({ status: 403, details: { reason: 'vault_locked' } })
  })

  it('unlocks with the emailed code, then lets documents through', async () => {
    await request(app).post('/api/tenant/vault/unlock/request').set(auth()).expect(200)
    expect(sent.otp).toMatch(/^\d{6}$/)

    const unlocked = await request(app)
      .post('/api/tenant/vault/unlock')
      .set(auth())
      .send({ otp: sent.otp })
      .expect(200)
    expect(unlocked.body.data.unlocked).toBe(true)

    await request(app).get('/api/tenant/vault').set(auth()).expect(200)
    const status = await request(app).get('/api/tenant/vault/unlock').set(auth()).expect(200)
    expect(status.body.data.unlocked).toBe(true)
  })

  it('rejects a wrong code and stays locked', async () => {
    await request(app).post('/api/tenant/vault/unlock/request').set(auth()).expect(200)
    const wrong = sent.otp === '000000' ? '111111' : '000000'
    await request(app).post('/api/tenant/vault/unlock').set(auth()).send({ otp: wrong }).expect(401)
    await request(app).get('/api/tenant/vault').set(auth()).expect(403)
  })

  it('burns the code after too many wrong attempts', async () => {
    await request(app).post('/api/tenant/vault/unlock/request').set(auth()).expect(200)
    const good = sent.otp
    const wrong = good === '000000' ? '111111' : '000000'
    for (let i = 0; i < 5; i++) {
      await request(app).post('/api/tenant/vault/unlock').set(auth()).send({ otp: wrong }).expect(401)
    }
    await request(app).post('/api/tenant/vault/unlock').set(auth()).send({ otp: good }).expect(401)
    await request(app).get('/api/tenant/vault').set(auth()).expect(403)
  })

  it('does not let a login code unlock the vault', async () => {
    await request(app).post('/api/tenant/vault/unlock').set(auth()).send({ otp: '123456' }).expect(401)
  })

  it('locks again on request and when the window ends', async () => {
    vaultUnlockStore.unlock(token)
    await request(app).get('/api/tenant/vault').set(auth()).expect(200)

    await request(app).delete('/api/tenant/vault/unlock').set(auth()).expect(200)
    await request(app).get('/api/tenant/vault').set(auth()).expect(403)

    vi.useFakeTimers()
    vaultUnlockStore.unlock(token)
    vi.advanceTimersByTime(11 * 60 * 1000)
    expect(vaultUnlockStore.isUnlocked(token)).toBe(false)
    vi.useRealTimers()
  })

  it('requires a signed-in user', async () => {
    await request(app).post('/api/tenant/vault/unlock/request').expect(401)
  })
})
