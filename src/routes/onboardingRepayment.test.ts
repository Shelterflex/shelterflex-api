import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import express, { type Express } from 'express'
import { errorHandler } from '../middleware/errorHandler.js'

const query = vi.fn()
vi.mock('../db.js', () => ({ getPool: async () => ({ query }) }))

vi.mock('../middleware/auth.js', () => ({
  authenticateToken: (req: any, _res: unknown, next: () => void) => {
    req.user = { id: 'user-1', role: 'tenant' }
    next()
  },
}))

const resolve = vi.fn()
vi.mock('../services/BankAccountResolverService.js', () => ({
  bankAccountResolverService: { resolve: (...a: unknown[]) => resolve(...a) },
}))

import { createOnboardingRouter } from './onboarding.js'
import { openMandateFromOnboarding } from '../services/onboardingMandate.js'
import {
  getRepaymentMandateStore,
  initRepaymentMandateStore,
  InMemoryRepaymentMandateStore,
} from '../models/repaymentMandateStore.js'
import { decryptPii } from '../utils/piiEncryption.js'

const body = {
  bankCode: '058',
  bankName: 'GTBank',
  accountNumber: '0123456789',
  deductionDay: 25,
  consentAccepted: true,
}

describe('onboarding repayment account', () => {
  let app: Express

  beforeEach(() => {
    vi.clearAllMocks()
    process.env.ENCRYPTION_KEY = 'a'.repeat(64)
    resolve.mockResolvedValue({ accountName: 'NGOZI ADEKUNLE' })
    query.mockResolvedValue({ rows: [] })

    app = express()
    app.use(express.json())
    app.use('/api/onboarding', createOnboardingRouter())
    app.use(errorHandler)
  })

  it('takes the account name from the bank and stores the number encrypted', async () => {
    const res = await request(app)
      .post('/api/onboarding/repayment-account')
        .send({ ...body, accountName: 'Someone Else' })
      .expect(200)

    expect(res.body.data.accountName).toBe('NGOZI ADEKUNLE')
    expect(res.body.data.accountLast4).toBe('6789')
    expect(JSON.stringify(res.body)).not.toContain('0123456789')

    const insert = query.mock.calls.find((c) => String(c[0]).includes('INSERT INTO onboarding_drafts'))!
    const stored = JSON.parse(insert[1][1])
    expect(stored.accountNumberEncrypted).not.toContain('0123456789')
    expect(decryptPii(stored.accountNumberEncrypted)).toBe('0123456789')
    expect(insert[1][2]).toContain('repayment')
  })

  it('requires the tenant to authorise the deduction', async () => {
    await request(app)
      .post('/api/onboarding/repayment-account')
        .send({ ...body, consentAccepted: false })
      .expect(400)
    expect(resolve).not.toHaveBeenCalled()
  })

  it('rejects a malformed account number before calling the bank', async () => {
    await request(app)
      .post('/api/onboarding/repayment-account')
        .send({ ...body, accountNumber: '12' })
      .expect(400)
    expect(resolve).not.toHaveBeenCalled()
  })

  it('blocks final submission until an account is authorised', async () => {
    query.mockResolvedValueOnce({
      rows: [{
        id: 'x', user_id: 'u', personal_info: { fullName: 'A' }, employment_info: { employmentStatus: 'employed' },
        completed_steps: [], current_step: 'repayment', submitted: false,
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      }],
    })
    await request(app)
      .post('/api/onboarding/submit')
        .send({})
      .expect(400)
    // Nothing was marked submitted.
    expect(query).toHaveBeenCalledTimes(1)
  })
})

describe('openMandateFromOnboarding', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    // The db pool is mocked here, so keep mandates in memory.
    initRepaymentMandateStore(new InMemoryRepaymentMandateStore())
    await getRepaymentMandateStore().clear()
  })

  it('opens a pending mandate from the onboarding account', async () => {
    query.mockResolvedValue({
      rows: [{
        repayment_info: {
          bankName: 'GTBank', accountName: 'NGOZI ADEKUNLE', accountLast4: '6789', deductionDay: 25,
        },
      }],
    })
    const mandate = await openMandateFromOnboarding('deal-1', 'tenant-1')
    expect(mandate).toMatchObject({ status: 'pending', accountLast4: '6789', providerReference: null })
  })

  it('does nothing when the tenant has no account on file', async () => {
    query.mockResolvedValue({ rows: [{ repayment_info: null }] })
    expect(await openMandateFromOnboarding('deal-1', 'tenant-1')).toBeNull()
  })
})
