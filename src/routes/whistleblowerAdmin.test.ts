import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import express, { type Express } from 'express'
import { errorHandler } from '../middleware/errorHandler.js'
import { whistleblowerTrustStore } from '../models/whistleblowerTrustStore.js'

vi.mock('../middleware/auth.js', () => ({
  authenticateToken: (req: any, _res: unknown, next: () => void) => {
    req.user = { id: req.header('x-user') ?? 'user-1', email: 'u@test.com', role: req.header('x-role') ?? 'tenant' }
    next()
  },
}))
vi.mock('../utils/auditLogger.js', () => ({
  auditLog: vi.fn(),
  extractAuditContext: vi.fn(() => ({})),
}))

import { createWhistleblowerRouter } from './whistleblower.js'

describe('whistleblower safety admin endpoints', () => {
  let app: Express
  const admin = { 'x-role': 'admin', 'x-user': 'admin-1' }

  beforeEach(async () => {
    await whistleblowerTrustStore.clear()
    app = express()
    app.use(express.json())
    app.use('/api/whistleblower', createWhistleblowerRouter({ getEarnings: vi.fn() } as never))
    app.use(errorHandler)

    for (const reporter of ['a', 'b', 'c']) {
      await whistleblowerTrustStore.addSafetyReport({
        whistleblowerId: 'risky',
        reporterId: reporter,
        listingId: 'L1',
        details: `report from ${reporter}`,
      })
    }
    await whistleblowerTrustStore.addSafetyReport({
      whistleblowerId: 'watched',
      reporterId: 'a',
      listingId: null,
      details: 'one report',
    })
  })

  it('is closed to everyone who is not an admin', async () => {
    await request(app).get('/api/whistleblower/admin/safety').set('x-role', 'tenant').expect(403)
    await request(app).post('/api/whistleblower/admin/risky/reinstate').set('x-role', 'tenant').expect(403)
    await request(app).post('/api/whistleblower/admin/watched/suspend').set('x-role', 'landlord').expect(403)
    expect(await whistleblowerTrustStore.isSuspended('risky')).toBe(true)
  })

  it('lists suspended whistleblowers first, with their reports', async () => {
    const res = await request(app).get('/api/whistleblower/admin/safety').set(admin).expect(200)
    const [first, second] = res.body.data
    expect(first).toMatchObject({ whistleblowerId: 'risky', suspended: true, distinctReporters: 3 })
    expect(first.reports).toHaveLength(3)
    expect(second).toMatchObject({ whistleblowerId: 'watched', suspended: false, distinctReporters: 1 })
  })

  it('suspends early and reinstates', async () => {
    await request(app).post('/api/whistleblower/admin/watched/suspend').set(admin).expect(200)
    expect(await whistleblowerTrustStore.isSuspended('watched')).toBe(true)

    const res = await request(app).post('/api/whistleblower/admin/risky/reinstate').set(admin).expect(200)
    expect(res.body.reinstated).toBe(true)
    expect(await whistleblowerTrustStore.isSuspended('risky')).toBe(false)
    expect(await whistleblowerTrustStore.listReports('risky')).toHaveLength(0)
  })
})
