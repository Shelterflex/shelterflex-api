import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import express, { type Express } from 'express'
import { errorHandler } from '../middleware/errorHandler.js'
import { AppError } from '../errors/AppError.js'
import { ErrorCode } from '../errors/errorCodes.js'
import { creditBureauService } from '../services/creditBureauService.js'

vi.mock('../services/creditBureauService.js', () => ({
  creditBureauService: {
    pullReport: vi.fn(),
    getCachedReport: vi.fn(),
  },
}))

vi.mock('../middleware/auth.js', () => ({
  authenticateToken: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    const role = req.headers['x-test-role']
    if (!role) {
      next(new AppError(ErrorCode.UNAUTHORIZED, 401, 'Authentication token required'))
      return
    }
    ;(req as any).user = { id: 'admin-1', role }
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

import creditBureauRouter from './creditBureau.js'

describe('Credit Bureau Routes', () => {
  let app: Express

  beforeEach(() => {
    vi.clearAllMocks()
    app = express()
    app.use(express.json())
    app.use('/api', creditBureauRouter)
    app.use(errorHandler)
  })

  it('rejects unauthenticated requests (BVN/NIN pulls must never be public)', async () => {
    await request(app)
      .post('/api/admin/tenants/tenant-1/pull-credit-report')
      .send({ bvn: '12345678901', nin: '12345678901' })
      .expect(401)
  })

  it('rejects a non-admin caller', async () => {
    await request(app)
      .post('/api/admin/tenants/tenant-1/pull-credit-report')
      .set('x-test-role', 'tenant')
      .send({ bvn: '12345678901', nin: '12345678901' })
      .expect(403)
  })

  it('allows an admin to pull a credit report with valid BVN/NIN', async () => {
    vi.mocked(creditBureauService.pullReport).mockResolvedValue({ score: 720 } as any)

    const res = await request(app)
      .post('/api/admin/tenants/tenant-1/pull-credit-report')
      .set('x-test-role', 'admin')
      .send({ bvn: '12345678901', nin: '12345678901' })
      .expect(200)

    expect(res.body.success).toBe(true)
    expect(res.body.report.score).toBe(720)
  })

  it('rejects a malformed BVN even for an admin', async () => {
    await request(app)
      .post('/api/admin/tenants/tenant-1/pull-credit-report')
      .set('x-test-role', 'admin')
      .send({ bvn: 'not-a-bvn', nin: '12345678901' })
      .expect(400)
  })
})
