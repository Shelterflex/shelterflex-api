import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import express, { type Express } from 'express'
import { errorHandler } from '../middleware/errorHandler.js'
import { AppError } from '../errors/AppError.js'
import { ErrorCode } from '../errors/errorCodes.js'
import { backgroundCheckService } from '../services/backgroundCheckService.js'

vi.mock('../services/backgroundCheckService.js', () => ({
  backgroundCheckService: {
    runFullCheck: vi.fn(),
    getLatestCheck: vi.fn(),
    getCheckById: vi.fn(),
    getChecksByApplicationId: vi.fn(),
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

import { backgroundCheckRouter } from './backgroundCheck.js'

describe('Background Check Routes', () => {
  let app: Express

  beforeEach(() => {
    vi.clearAllMocks()
    app = express()
    app.use(express.json())
    app.use('/api/admin', backgroundCheckRouter)
    app.use(errorHandler)
  })

  it('rejects unauthenticated requests', async () => {
    await request(app).get('/api/admin/tenants/tenant-1/background-check').expect(401)
  })

  it("does not let an ordinary tenant pull another tenant's background check", async () => {
    await request(app)
      .get('/api/admin/tenants/some-other-tenant/background-check')
      .set('x-test-role', 'tenant')
      .expect(403)
  })

  it('allows an admin to trigger a background check', async () => {
    vi.mocked(backgroundCheckService.runFullCheck).mockResolvedValue({
      id: 'check-1',
      tenantId: 'tenant-1',
      status: 'completed',
    } as any)

    const res = await request(app)
      .post('/api/admin/tenants/tenant-1/background-check')
      .set('x-test-role', 'admin')
      .send({ employerName: 'Acme Inc', skipIncome: true, skipBankStatement: true })
      .expect(201)

    expect(res.body.success).toBe(true)
    expect(res.body.data.id).toBe('check-1')
  })
})
