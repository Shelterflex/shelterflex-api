import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { newDb, DataType } from 'pg-mem'
import { setPool } from '../db.js'
import { dealStore } from './dealStore.js'
import { listingStore } from './listingStore.js'
import { rewardStore } from './rewardStore.js'
import { ListingStatus } from './listing.js'
import { DealStatus, ScheduleItemStatus } from './deal.js'
import { RewardStatus } from './reward.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const migrationPaths = [
  path.resolve(__dirname, '../../migrations/006_deal_listing_reward_store.sql'),
  path.resolve(__dirname, '../../migrations/014_settlement_outbox.sql'),
  path.resolve(__dirname, '../../migrations/016_support_messages.sql'),
  path.resolve(__dirname, '../../migrations/017_whistleblower_ratings.sql'),
  path.resolve(__dirname, '../../migrations/018_property_issue_reports.sql'),
  path.resolve(__dirname, '../../migrations/030_two_tier_pricing.sql'),
  path.resolve(__dirname, '../../migrations/046_add_landlord_id_to_whistleblower_listings.sql'),
]

function loadMigrations(sql: string) {
  const db = newDb({ autoCreateForeignKeyIndices: true })

  db.public.registerFunction({
    name: 'gen_random_uuid',
    returns: DataType.uuid,
    implementation: () => randomUUID(),
  })

  db.public.registerFunction({
    name: 'jsonb_array_length',
    args: [DataType.jsonb],
    returns: DataType.int4,
    implementation: (value: unknown) => {
      const parsed = typeof value === 'string' ? JSON.parse(value) : value
      return Array.isArray(parsed) ? parsed.length : 0
    },
  })

  db.public.registerFunction({
    name: 'jsonb_typeof',
    args: [DataType.jsonb],
    returns: DataType.text,
    implementation: (value: unknown) => {
      const parsed = typeof value === 'string' ? JSON.parse(value) : value
      if (Array.isArray(parsed)) return 'array'
      if (parsed === null) return 'null'
      const type = typeof parsed
      if (type === 'object') return 'object'
      if (type === 'number') return 'number'
      if (type === 'boolean') return 'boolean'
      return 'string'
    },
  })

  db.public.registerFunction({
    name: 'date_trunc',
    args: [DataType.text, DataType.timestamptz],
    returns: DataType.timestamptz,
    implementation: (precision: string, value: unknown) => {
      if (precision !== 'month') {
        throw new Error(`Unsupported precision ${precision} in pg-mem test helper`)
      }
      const date = value instanceof Date ? value : new Date(value as string)
      return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1))
    },
  })

  const statements = sql
    .split(/;\s*\n/)
    .map((stmt) => stmt.trim())
    .filter(Boolean)

  for (const statement of statements) {
    try {
      db.public.none(statement)
    } catch (error) {
      if (statement.includes('USING GIN')) {
        continue
      }
      throw error
    }
  }

  return db
}

describe('Postgres-backed stores', () => {
  let pool: any

  beforeAll(() => {
    process.env.NODE_ENV = 'test'
    process.env.DATABASE_URL = 'pg-mem://test'

    const sql = migrationPaths.map((p) => readFileSync(p, 'utf8')).join('\n')
    const db = loadMigrations(sql)
    const { Pool } = db.adapters.createPg()
    pool = new Pool()
    setPool(pool)
  })

  afterAll(async () => {
    if (pool?.end) {
      await pool.end()
    }
    setPool(null)
    delete process.env.DATABASE_URL
  })

  beforeEach(async () => {
    await rewardStore.clear()
    await dealStore.clear()
    await listingStore.clear()
  })

  async function seedListing(overrides: Partial<{ whistleblowerId: string; address: string }> = {}) {
    const listing = await listingStore.create({
      whistleblowerId: overrides.whistleblowerId ?? 'wb-001',
      address: overrides.address ?? '15 Adeola Hopewell, Lagos',
      city: 'Lagos',
      area: 'Victoria Island',
      bedrooms: 2,
      bathrooms: 2,
      annualRentNgn: 1200000,
      description: 'Test unit',
      photos: ['url-1', 'url-2', 'url-3'],
    })
    return listing
  }

  it('persists deals and schedules and supports filtering', async () => {
    const listing = await seedListing()
    await listingStore.updateStatus(listing.listingId, ListingStatus.APPROVED)

    const deal = await dealStore.create({
      tenantId: 'tenant-123',
      landlordId: 'landlord-456',
      listingId: listing.listingId,
      annualRentNgn: listing.annualRentNgn,
      depositNgn: listing.annualRentNgn * 0.3,
      termMonths: 6,
    })

    expect(deal.dealId).toBeTruthy()
    expect(deal.schedule).toHaveLength(6)

    await dealStore.updateStatus(deal.dealId, DealStatus.ACTIVE)
    await dealStore.updateScheduleItemStatus(deal.dealId, 1, ScheduleItemStatus.PAID)

    const refreshed = await dealStore.findById(deal.dealId)
    expect(refreshed?.status).toBe(DealStatus.ACTIVE)
    expect(refreshed?.schedule.find((item) => item.period === 1)?.status).toBe(
      ScheduleItemStatus.PAID,
    )

    const paged = await dealStore.findMany({ tenantId: 'tenant-123', page: 1, pageSize: 5 })
    expect(paged.total).toBe(1)
    expect(paged.deals[0].listingId).toBe(listing.listingId)
  })

  it('enforces monthly listing limits and search filters', async () => {
    const first = await seedListing({ address: '10 Marina Road, Lagos' })
    await seedListing({ address: '20 Broad Street, Lagos' })

    const count = await listingStore.getMonthlyReportCount(first.whistleblowerId)
    expect(count).toBe(2)
    expect(await listingStore.hasReachedMonthlyLimit(first.whistleblowerId)).toBe(true)

    const results = await listingStore.list({ lga: 'Victoria Island', page: 1, pageSize: 1 })
    expect(results.total).toBe(2)
    expect(results.listings[0].address).toContain('Lagos')

    const moderated = await listingStore.moderate(
      first.listingId,
      ListingStatus.APPROVED,
      'admin-user',
    )
    expect(moderated?.status).toBe(ListingStatus.APPROVED)
    expect(moderated?.reviewedBy).toBe('admin-user')
  })

  it('persists rewards lifecycle in Postgres implementation', async () => {
    const listing = await seedListing()
    await listingStore.updateStatus(listing.listingId, ListingStatus.APPROVED)

    const deal = await dealStore.create({
      tenantId: 'tenant-rw',
      landlordId: 'landlord-rw',
      listingId: listing.listingId,
      annualRentNgn: listing.annualRentNgn,
      depositNgn: listing.annualRentNgn * 0.25,
      termMonths: 3,
    })

    const reward = await rewardStore.create({
      whistleblowerId: listing.whistleblowerId,
      dealId: deal.dealId,
      listingId: listing.listingId,
      amountUsdc: 150,
    })

    await rewardStore.updateStatus(reward.rewardId, RewardStatus.PAYABLE)
    const paid = await rewardStore.markAsPaid(reward.rewardId, 'tx-abc', 'stripe', 'pi_123', {
      amountNgn: 200000,
      fxRateNgnPerUsdc: 1333.33,
      fxProvider: 'demofx',
    })

    expect(paid?.status).toBe(RewardStatus.PAID)
    expect(paid?.metadata?.amountNgn).toBe(200000)
    expect(paid?.paymentTxId).toBe('tx-abc')

    const rewards = await rewardStore.listAll()
    expect(rewards).toHaveLength(1)
    expect(rewards[0].rewardId).toBe(reward.rewardId)
  })
})
