import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import express, { type Express } from 'express'
import { createDealsRouter } from './deals.js'
import { errorHandler } from '../middleware/errorHandler.js'
import { sessionStore, userStore } from '../models/authStore.js'
import { dealStore } from '../models/dealStore.js'
import { getRepaymentMandateStore } from '../models/repaymentMandateStore.js'

vi.mock('../utils/auditLogger.js', () => ({
  auditLog: vi.fn(),
  extractAuditContext: vi.fn(() => ({})),
}))

const body = {
  bankName: 'GTBank',
  accountName: 'Ngozi Adekunle',
  accountNumber: '0123456789',
  deductionDay: 25,
  providerReference: 'MND_123',
}

describe('deal repayment mandate', () => {
  let app: Express
  let tenantToken: string
  let otherToken: string
  let tenantId: string

  beforeEach(async () => {
    userStore.clear()
    sessionStore.clear()
    await getRepaymentMandateStore().clear()

    const tenant = await userStore.getOrCreateByEmail('mandate-tenant@test.com')
    tenantId = tenant.id
    tenantToken = (await sessionStore.create('mandate-tenant@test.com', `t-${Date.now()}`)).token
    await userStore.getOrCreateByEmail('mandate-other@test.com')
    otherToken = (await sessionStore.create('mandate-other@test.com', `o-${Date.now()}`)).token

    vi.spyOn(dealStore, 'findById').mockResolvedValue({
      dealId: 'deal-1',
      tenantId,
      landlordId: 'landlord-1',
    } as never)

    app = express()
    app.use(express.json())
    app.use('/api/deals', createDealsRouter())
    app.use(errorHandler)
  })

  it('is not found until the deduction is set up', async () => {
    await request(app)
      .get('/api/deals/deal-1/mandate')
      .set('Authorization', `Bearer ${tenantToken}`)
      .expect(404)
  })

  it('records the mandate and keeps only the last four digits', async () => {
    const put = await request(app)
      .put('/api/deals/deal-1/mandate')
      .set('Authorization', `Bearer ${tenantToken}`)
      .send(body)
      .expect(200)

    expect(put.body.data.accountLast4).toBe('6789')
    expect(put.body.data.status).toBe('active')
    expect(JSON.stringify(put.body)).not.toContain('0123456789')

    const get = await request(app)
      .get('/api/deals/deal-1/mandate')
      .set('Authorization', `Bearer ${tenantToken}`)
      .expect(200)
    expect(get.body.data.deductionDay).toBe(25)
  })

  it('rejects a badly formed account number', async () => {
    await request(app)
      .put('/api/deals/deal-1/mandate')
      .set('Authorization', `Bearer ${tenantToken}`)
      .send({ ...body, accountNumber: '123' })
      .expect(400)
  })

  it("does not let another user touch the tenant's mandate", async () => {
    await request(app)
      .put('/api/deals/deal-1/mandate')
      .set('Authorization', `Bearer ${otherToken}`)
      .send(body)
      .expect(403)
    await request(app).get('/api/deals/deal-1/mandate').expect(401)
  })
})
