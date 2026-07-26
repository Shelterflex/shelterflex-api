import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import request from 'supertest'
import express, { type Express } from 'express'
import { createLeaseAgreementsRouter } from './leaseAgreements.js'
import { requireFlag } from '../middleware/requireFlag.js'
import { errorHandler } from '../middleware/errorHandler.js'
import { sessionStore, userStore } from '../models/authStore.js'
import { dealStore } from '../models/dealStore.js'
import { leaseAgreementStore } from '../models/leaseAgreementStore.js'

vi.mock('../models/dealStore.js', () => ({
  dealStore: { findById: vi.fn() },
}))

vi.mock('../models/leaseAgreementStore.js', () => ({
  leaseAgreementStore: {
    getByDealId: vi.fn(),
    create: vi.fn(),
    updateStatus: vi.fn(),
    void: vi.fn(),
  },
}))

function buildApp(): Express {
  const app = express()
  app.use(express.json())
  app.use('/api/v1', requireFlag('LEASE_AGREEMENTS_ENABLED'), createLeaseAgreementsRouter())
  app.use(errorHandler)
  return app
}

describe('Lease Agreement Routes (feature-flagged)', () => {
  let landlordToken: string

  beforeEach(async () => {
    vi.clearAllMocks()
    userStore.clear()
    sessionStore.clear()

    const landlord = await userStore.getOrCreateByEmail('lease-landlord@test.com')
    landlord.role = 'landlord'
    const session = await sessionStore.create('lease-landlord@test.com', `landlord-token-${Date.now()}`)
    landlordToken = session.token
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('is off by default: 403 even for an authenticated landlord', async () => {
    const app = buildApp()

    await request(app)
      .post('/api/v1/deals/deal-1/lease/generate')
      .set('Authorization', `Bearer ${landlordToken}`)
      .expect(403)
  })

  it('generates a lease draft once the flag is enabled', async () => {
    vi.stubEnv('FEATURE_FLAG_LEASE_AGREEMENTS_ENABLED', 'true')
    const app = buildApp()

    vi.mocked(dealStore.findById).mockResolvedValue({
      dealId: 'deal-1',
      tenantId: 'tenant-1',
      landlordId: 'landlord-1',
      annualRentNgn: 1_200_000,
      depositNgn: 240_000,
      termMonths: 12,
      paymentType: 'installment',
      listingId: 'Property 1',
    } as any)
    vi.mocked(leaseAgreementStore.getByDealId).mockResolvedValue(null)
    vi.mocked(leaseAgreementStore.create).mockResolvedValue({
      leaseId: 'lease-1',
      documentKey: 'lease/deal-1/uuid.pdf',
    } as any)

    const res = await request(app)
      .post('/api/v1/deals/deal-1/lease/generate')
      .set('Authorization', `Bearer ${landlordToken}`)
      .expect(201)

    expect(res.body.success).toBe(true)
    expect(res.body.data.status).toBe('draft')
  })
})
