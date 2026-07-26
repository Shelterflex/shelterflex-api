import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import express, { type Express } from 'express'
import { errorHandler } from '../middleware/errorHandler.js'
import { AppError } from '../errors/AppError.js'
import { ErrorCode } from '../errors/errorCodes.js'
import { getPool } from '../db.js'

vi.mock('../db.js', () => ({
  getPool: vi.fn(),
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

import { createContractEventsRouter } from './contractEvents.js'

describe('Contract Events Routes', () => {
  let app: Express

  beforeEach(() => {
    vi.clearAllMocks()
    app = express()
    app.use(express.json())
    app.use('/api', createContractEventsRouter())
    app.use(errorHandler)
  })

  it('rejects unauthenticated requests', async () => {
    await request(app).get('/api/admin/contract-events').expect(401)
  })

  it('rejects a non-admin caller', async () => {
    await request(app)
      .get('/api/admin/contract-events')
      .set('x-test-role', 'tenant')
      .expect(403)
  })

  it('returns paginated events for an admin', async () => {
    vi.mocked(getPool).mockResolvedValue({
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [{ count: '1' }] })
        .mockResolvedValueOnce({
          rows: [
            {
              id: 'evt-1',
              contract_id: 'C123',
              ledger_sequence: '100',
              transaction_hash: 'tx-1',
              event_type: 'deal_created',
              topic_1: 'deal-1',
              topic_2: null,
              data_json: {},
              indexed_at: new Date().toISOString(),
              created_at: new Date().toISOString(),
            },
          ],
        }),
    } as any)

    const res = await request(app)
      .get('/api/admin/contract-events')
      .set('x-test-role', 'admin')
      .expect(200)

    expect(res.body.success).toBe(true)
    expect(res.body.data.events).toHaveLength(1)
    expect(res.body.data.pagination.total).toBe(1)
  })
})
