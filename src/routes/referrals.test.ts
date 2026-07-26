import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import express, { type Express } from 'express'
import { errorHandler } from '../middleware/errorHandler.js'
import { AppError } from '../errors/AppError.js'
import { ErrorCode } from '../errors/errorCodes.js'
import { referralService } from '../services/referralService.js'
import { referralRepository } from '../repositories/ReferralRepository.js'

vi.mock('../services/referralService.js', () => ({
  referralService: {
    getReferralStats: vi.fn(),
    applyReferralCode: vi.fn(),
  },
}))

vi.mock('../repositories/ReferralRepository.js', () => ({
  referralRepository: {
    getAllConversions: vi.fn(),
  },
}))

vi.mock('../middleware/auth.js', () => ({
  authenticateToken: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    const role = req.headers['x-test-role']
    if (!role) {
      next(new AppError(ErrorCode.UNAUTHORIZED, 401, 'Authentication token required'))
      return
    }
    ;(req as any).user = { id: 'user-1', role }
    next()
  },
}))

import { createReferralsRouter } from './referrals.js'

describe('Referral Routes', () => {
  let app: Express

  beforeEach(() => {
    vi.clearAllMocks()
    app = express()
    app.use(express.json())
    app.use('/api/v1', createReferralsRouter())
    app.use(errorHandler)
  })

  it('rejects unauthenticated requests to view referral stats', async () => {
    await request(app).get('/api/v1/tenant/referral').expect(401)
  })

  it('lets a tenant view their own referral code and stats', async () => {
    vi.mocked(referralService.getReferralStats).mockResolvedValue({
      code: 'ABC12345',
      referralLink: 'https://shelterflex.app/register?ref=ABC12345',
      totalReferred: 2,
      pendingRewards: 1,
      appliedRewards: 1,
      totalRewardAmountNgn: 10000,
    })

    const res = await request(app)
      .get('/api/v1/tenant/referral')
      .set('x-test-role', 'tenant')
      .expect(200)

    expect(res.body.data.code).toBe('ABC12345')
  })

  it('does not let a landlord view tenant referral stats', async () => {
    await request(app)
      .get('/api/v1/tenant/referral')
      .set('x-test-role', 'landlord')
      .expect(403)
  })

  it('applies a referral code without requiring auth (registration flow)', async () => {
    vi.mocked(referralService.applyReferralCode).mockResolvedValue({
      id: 'conversion-1',
    } as any)

    const res = await request(app)
      .post('/api/v1/referrals/apply')
      .send({ referralCode: 'ABC12345', referredTenantId: 'new-tenant-1' })
      .expect(201)

    expect(res.body.data.conversionId).toBe('conversion-1')
  })

  it('rejects a non-admin from viewing all referral conversions', async () => {
    await request(app)
      .get('/api/v1/admin/referrals')
      .set('x-test-role', 'tenant')
      .expect(403)
  })
})
