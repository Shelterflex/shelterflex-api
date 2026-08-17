import { describe, it, expect, beforeEach } from 'vitest'
import { createTestAgent } from '../test-helpers.js'
import { listingStore } from '../models/listingStore.js'
import { dealStore } from '../models/dealStore.js'
import { landlordPropertyStore } from '../models/landlordPropertyStore.js'
import { ListingStatus } from '../models/listing.js'
import { DealStatus } from '../models/deal.js'
import { clearStatsCache } from '../services/platformStatsService.js'

describe('Platform Stats API', () => {
  const request = createTestAgent()

  beforeEach(async () => {
    await listingStore.clear()
    await dealStore.clear()
    await landlordPropertyStore.clear()
    clearStatsCache()
  })

  describe('GET /api/v1/platform-stats', () => {
    it('should return 200 with zeroed stats when no data exists', async () => {
      const response = await request.get('/api/v1/platform-stats')

      expect(response.status).toBe(200)
      expect(response.body).toMatchObject({
        listings: { total: 0, active: 0 },
        deals: { total: 0, active: 0, completed: 0 },
        totalFinancedNgn: 0,
        properties: { total: 0 },
      })
      expect(response.body.generatedAt).toBeDefined()
    })

    it('should be reachable without authentication', async () => {
      const response = await request.get('/api/v1/platform-stats')

      expect(response.status).toBe(200)
    })

    it('should compute correct listing counts', async () => {
      const listing1 = await listingStore.create({
        whistleblowerId: 'wb-1',
        address: '10 Ikeja',
        bedrooms: 2,
        bathrooms: 1,
        annualRentNgn: 1_000_000,
        photos: [],
      })
      await listingStore.create({
        whistleblowerId: 'wb-2',
        address: '20 Lekki',
        bedrooms: 3,
        bathrooms: 2,
        annualRentNgn: 2_000_000,
        photos: [],
      })

      await listingStore.updateStatus(listing1.listingId, ListingStatus.APPROVED)

      const response = await request.get('/api/v1/platform-stats')

      expect(response.status).toBe(200)
      expect(response.body.listings.total).toBe(2)
      expect(response.body.listings.active).toBe(1)
    })

    it('should compute correct deal counts and financed amount', async () => {
      const deal1 = await dealStore.create({
        tenantId: 't-1',
        landlordId: 'l-1',
        annualRentNgn: 1_200_000,
        depositNgn: 240_000,
        termMonths: 12,
      })
      const deal2 = await dealStore.create({
        tenantId: 't-2',
        landlordId: 'l-2',
        annualRentNgn: 2_400_000,
        depositNgn: 480_000,
        termMonths: 6,
      })

      await dealStore.updateStatus(deal1.dealId, DealStatus.ACTIVE)
      await dealStore.updateStatus(deal2.dealId, DealStatus.COMPLETED)

      const response = await request.get('/api/v1/platform-stats')

      expect(response.status).toBe(200)
      expect(response.body.deals.total).toBe(2)
      expect(response.body.deals.active).toBe(1)
      expect(response.body.deals.completed).toBe(1)
      expect(response.body.totalFinancedNgn).toBe(
        (1_200_000 - 240_000) + (2_400_000 - 480_000),
      )
    })

    it('should count at_risk deals as active', async () => {
      const deal = await dealStore.create({
        tenantId: 't-1',
        landlordId: 'l-1',
        annualRentNgn: 1_200_000,
        depositNgn: 240_000,
        termMonths: 12,
      })
      await dealStore.updateStatus(deal.dealId, DealStatus.AT_RISK)

      const response = await request.get('/api/v1/platform-stats')

      expect(response.body.deals.active).toBe(1)
    })

    it('should compute correct property count', async () => {
      await landlordPropertyStore.create({
        landlordId: 'l-1',
        title: 'Apartment A',
        address: '10 Main St',
        bedrooms: 2,
        bathrooms: 1,
        annualRentNgn: 500_000,
        photos: [],
      })
      await landlordPropertyStore.create({
        landlordId: 'l-2',
        title: 'Apartment B',
        address: '20 Main St',
        bedrooms: 3,
        bathrooms: 2,
        annualRentNgn: 800_000,
        photos: [],
      })

      const response = await request.get('/api/v1/platform-stats')

      expect(response.body.properties.total).toBe(2)
    })

    it('should cache repeated requests', async () => {
      await listingStore.create({
        whistleblowerId: 'wb-1',
        address: '10 Ikeja',
        bedrooms: 2,
        bathrooms: 1,
        annualRentNgn: 1_000_000,
        photos: [],
      })

      const first = await request.get('/api/v1/platform-stats')
      const second = await request.get('/api/v1/platform-stats')

      expect(first.body.listings.total).toBe(1)
      expect(second.body.listings.total).toBe(1)

      expect(first.body.generatedAt).toBe(second.body.generatedAt)
    })

    it('should return cache-control headers', async () => {
      const response = await request.get('/api/v1/platform-stats')

      expect(response.headers['cache-control']).toBeDefined()
    })
  })
})
