import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import express, { type Express } from 'express'
import { errorHandler } from '../middleware/errorHandler.js'
import { AppError } from '../errors/AppError.js'
import { ErrorCode } from '../errors/errorCodes.js'
import { paymentDisputeRepository } from '../repositories/PaymentDisputeRepository.js'

vi.mock('../repositories/PaymentDisputeRepository.js', () => ({
  paymentDisputeRepository: {
    create: vi.fn(),
    findByPaymentId: vi.fn(),
    findByUserId: vi.fn(),
    findById: vi.fn(),
    list: vi.fn(),
    updateStatus: vi.fn(),
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

vi.mock('../middleware/rbac.js', () => ({
  requirePermission: (_resource: string, _action: string) => (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    const user = (req as any).user
    if (user?.role === 'admin' || user?.role === 'super_admin') {
      next()
      return
    }
    next(new AppError(ErrorCode.FORBIDDEN, 403, 'Forbidden'))
  },
}))

import { createPaymentDisputeRouter } from './paymentDispute.js'

describe('Payment Dispute Routes', () => {
  let app: Express

  beforeEach(() => {
    vi.clearAllMocks()
    app = express()
    app.use(express.json())
    app.use('/api/v1/disputes', createPaymentDisputeRouter())
    app.use(errorHandler)
  })

  it('rejects unauthenticated requests', async () => {
    await request(app).get('/api/v1/disputes/my').expect(401)
  })

  it('creates a dispute for the authenticated user', async () => {
    vi.mocked(paymentDisputeRepository.findByPaymentId).mockResolvedValue([])
    vi.mocked(paymentDisputeRepository.create).mockResolvedValue({
      id: 'dispute-1',
      userId: 'user-1',
      paymentId: '11111111-1111-1111-1111-111111111111',
      reason: 'duplicate_charge',
      description: 'Charged twice for the same rent payment',
      evidenceKeys: [],
      status: 'pending',
      resolution: null,
      resolvedBy: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any)

    const res = await request(app)
      .post('/api/v1/disputes')
      .set('x-test-role', 'tenant')
      .send({
        paymentId: '11111111-1111-1111-1111-111111111111',
        reason: 'duplicate_charge',
        description: 'Charged twice for the same rent payment',
      })
      .expect(201)

    expect(res.body.success).toBe(true)
    expect(res.body.disputeId).toBe('dispute-1')
  })

  it('rejects a non-admin from listing all disputes', async () => {
    await request(app)
      .get('/api/v1/disputes/admin')
      .set('x-test-role', 'tenant')
      .expect(403)
  })

  it('allows an admin to list disputes', async () => {
    vi.mocked(paymentDisputeRepository.list).mockResolvedValue({
      disputes: [],
      total: 0,
      page: 1,
      pageSize: 50,
    } as any)

    const res = await request(app)
      .get('/api/v1/disputes/admin')
      .set('x-test-role', 'admin')
      .expect(200)

    expect(res.body.total).toBe(0)
  })
})
