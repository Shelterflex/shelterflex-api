import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { newDb } from 'pg-mem'
import { setPool } from '../db.js'
import {
  whistleblowerTrustStore,
  SUSPENSION_THRESHOLD,
} from './whistleblowerTrustStore.js'
import { getRepaymentMandateStore } from './repaymentMandateStore.js'
import { viewingStore, viewingStatus } from './viewingStore.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const migrations = [
  '../../migrations/053_whistleblower_trust_and_repayment_mandates.sql',
  '../../migrations/054_viewings.sql',
].map((m) => path.resolve(__dirname, m))

describe('Postgres-backed whistleblower trust and repayment mandates', () => {
  beforeAll(() => {
    const db = newDb()
    for (const statement of migrations
      .map((m) => readFileSync(m, 'utf8'))
      .join('\n')
      .split(/;\s*\n/)
      .map((s) => s.trim())
      .filter(Boolean)) {
      db.public.none(statement)
    }
    const { Pool } = db.adapters.createPg()
    setPool(new Pool())
  })

  afterAll(() => setPool(null))

  beforeEach(async () => {
    await whistleblowerTrustStore.clear()
    await getRepaymentMandateStore().clear()
    await viewingStore.clear()
  })

  it('remembers who has verified their identity', async () => {
    expect(await whistleblowerTrustStore.isVerified('u1')).toBe(false)
    await whistleblowerTrustStore.markVerified('u1', 'prov-1')
    expect(await whistleblowerTrustStore.isVerified('u1')).toBe(true)
    expect((await whistleblowerTrustStore.getIdentity('u1')).reference).toBe('prov-1')
  })

  it('counts failed attempts', async () => {
    await whistleblowerTrustStore.recordFailedAttempt('u2')
    await whistleblowerTrustStore.recordFailedAttempt('u2')
    expect(await whistleblowerTrustStore.recentFailedAttempts('u2')).toBe(2)
    expect(await whistleblowerTrustStore.isVerified('u2')).toBe(false)
  })

  it('suspends after reports from different people, then reinstates', async () => {
    for (let i = 1; i <= SUSPENSION_THRESHOLD; i++) {
      const result = await whistleblowerTrustStore.addSafetyReport({
        whistleblowerId: 'risky',
        reporterId: `r${i}`,
        listingId: 'l1',
        details: 'Made me feel unsafe',
      })
      expect(result.newlySuspended).toBe(i === SUSPENSION_THRESHOLD)
    }
    expect(await whistleblowerTrustStore.isSuspended('risky')).toBe(true)
    expect(await whistleblowerTrustStore.listSuspensions()).toHaveLength(1)
    expect(await whistleblowerTrustStore.listReports('risky')).toHaveLength(SUSPENSION_THRESHOLD)

    expect(await whistleblowerTrustStore.reinstate('risky')).toBe(true)
    expect(await whistleblowerTrustStore.isSuspended('risky')).toBe(false)
    expect(await whistleblowerTrustStore.listReports('risky')).toHaveLength(0)
  })

  it('does not count one person reporting twice', async () => {
    for (let i = 0; i < 4; i++) {
      await whistleblowerTrustStore.addSafetyReport({
        whistleblowerId: 'w',
        reporterId: 'same',
        listingId: null,
        details: 'again',
      })
    }
    expect(await whistleblowerTrustStore.isSuspended('w')).toBe(false)
  })

  it('stores a mandate, updates it, and reads it back after the process "restarts"', async () => {
    const store = getRepaymentMandateStore()
    await store.upsert({
      dealId: 'deal-1',
      bankName: 'GTBank',
      accountName: 'NGOZI',
      accountLast4: '6789',
      deductionDay: 25,
      providerReference: null,
      status: 'pending',
    })
    const updated = await store.updateStatus('deal-1', 'active')
    expect(updated?.status).toBe('active')
    expect(await store.findByDealId('deal-1')).toMatchObject({
      accountLast4: '6789',
      deductionDay: 25,
      providerReference: null,
      status: 'active',
    })
    expect(await store.findByDealId('nope')).toBeNull()
  })

  it('stores viewings and walks them through acceptance and inspector assignment', async () => {
    const viewing = await viewingStore.create({
      listingId: 'L1',
      tenantId: 't1',
      whistleblowerId: 'w1',
      startsAt: '2030-01-03T10:00:00.000Z',
      requiresInspector: true,
    })
    expect(viewingStatus(viewing)).toBe('requested')

    const accepted = await viewingStore.update(viewing.viewingId, { whistleblowerAccepted: true })
    expect(viewingStatus(accepted!)).toBe('awaiting_inspector')
    expect((await viewingStore.listAwaitingInspector()).map((v) => v.viewingId)).toEqual([viewing.viewingId])

    const claimed = await viewingStore.update(viewing.viewingId, { inspectorId: 'i1' })
    expect(viewingStatus(claimed!)).toBe('confirmed')
    expect(await viewingStore.listAwaitingInspector()).toHaveLength(0)

    expect((await viewingStore.listForUser('t1')).map((v) => v.viewingId)).toEqual([viewing.viewingId])
    expect(await viewingStore.listForUser('i1')).toHaveLength(1)
    expect(await viewingStore.listActiveForListing('L1')).toHaveLength(1)

    await viewingStore.update(viewing.viewingId, { state: 'cancelled' })
    expect(await viewingStore.listActiveForListing('L1')).toHaveLength(0)
  })
})
