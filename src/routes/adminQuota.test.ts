import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import express, { type Express } from 'express'
import { errorHandler } from '../middleware/errorHandler.js'
import { AppError } from '../errors/AppError.js'
import { ErrorCode } from '../errors/errorCodes.js'
import { quotaManager } from '../services/QuotaManager.js'

vi.mock('../services/QuotaManager.js', () => ({
  quotaManager: {
    getQuotaUsage: vi.fn(),
    getUserOverrides: vi.fn(),
    setOverride: vi.fn(),
    removeOverride: vi.fn(),
    getQuotaStats: vi.fn(),
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

import { createAdminQuotaRouter } from './adminQuota.js'

describe('Admin Quota Routes', () => {
  let app: Express

  beforeEach(() => {
    vi.clearAllMocks()
    app = express()
    app.use(express.json())
    app.use('/api/admin/quota', createAdminQuotaRouter())
    app.use(errorHandler)
  })

  it('rejects unauthenticated requests', async () => {
    await request(app).get('/api/admin/quota/stats').expect(401)
  })

  it('rejects a non-admin user with 403', async () => {
    await request(app)
      .get('/api/admin/quota/stats')
      .set('x-test-role', 'tenant')
      .expect(403)
  })

  it('allows an admin to view quota stats', async () => {
    vi.mocked(quotaManager.getQuotaStats).mockResolvedValue({
      totalOverrides: 2,
      activeOverrides: 1,
      nearLimitUsers: 0,
    })

    const res = await request(app)
      .get('/api/admin/quota/stats')
      .set('x-test-role', 'admin')
      .expect(200)

    expect(res.body.totalOverrides).toBe(2)
  })

  it('allows an admin to create a quota override', async () => {
    vi.mocked(quotaManager.setOverride).mockResolvedValue({
      userId: 'user-1',
      elevatedLimit: 500,
      reason: 'VIP tenant',
      createdBy: 'admin-1',
      createdAt: Date.now(),
    } as any)

    const res = await request(app)
      .post('/api/admin/quota/override')
      .set('x-test-role', 'admin')
      .send({ userId: 'user-1', elevatedLimit: 500, reason: 'VIP tenant' })
      .expect(201)

    expect(res.body.success).toBe(true)
  })
})
