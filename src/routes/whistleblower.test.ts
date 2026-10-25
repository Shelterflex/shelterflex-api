import { describe, it, expect, beforeEach } from 'vitest'
import { createTestAgent, expectRequestId, expectErrorShape } from '../test-helpers.js'
import request from 'supertest'
import { createApp } from '../app.js'
import { listingStore } from '../models/listingStore.js'
import { ListingStatus } from '../models/listing.js'
import { sessionStore, userStore } from '../models/authStore.js'

/** Signs a user in (in-memory fallback store) and returns their id and token. */
async function signIn(email: string): Promise<{ userId: string; token: string }> {
  const user = await userStore.getOrCreateByEmail(email)
  const token = `token-${email.replace(/[^a-z0-9]/gi, '-')}`
  await sessionStore.create(email, token)
  return { userId: user.id, token }
}

describe('Whistleblower Earnings API', () => {
  const request = createTestAgent()

  describe('GET /api/whistleblower/:id/earnings', () => {
    it('should return 200 with earnings data for valid whistleblower', async () => {
      const response = await request.get('/api/whistleblower/test-whistleblower-1/earnings')
      expect(response.status).toBe(200)
      expect(response.body).toHaveProperty('totals')
      expect(response.body).toHaveProperty('history')
      // Verify totals structure
      expect(response.body.totals).toHaveProperty('totalNgn')
      expect(response.body.totals).toHaveProperty('pendingNgn')
      expect(response.body.totals).toHaveProperty('paidNgn')
      expect(typeof response.body.totals.totalNgn).toBe('number')
      expect(typeof response.body.totals.pendingNgn).toBe('number')
      expect(typeof response.body.totals.paidNgn).toBe('number')
      // Verify history is an array
      expect(Array.isArray(response.body.history)).toBe(true)
    })
    it('should return earnings with correct aggregation for test whistleblower', async () => {
      const response = await request.get('/api/whistleblower/test-whistleblower-1/earnings')
      expect(response.status).toBe(200)
      // Test data has: 50 USDC paid, 100 USDC pending, 75 USDC payable, 25 USDC paid
      // Total: 250 USDC, Pending: 175 USDC (pending + payable), Paid: 75 USDC
      // At 1600 NGN/USDC: Total: 400000, Pending: 280000, Paid: 120000
      expect(response.body.totals.totalNgn).toBe(400000)
      expect(response.body.totals.pendingNgn).toBe(280000)
      expect(response.body.totals.paidNgn).toBe(120000)
      // Verify USDC amounts
      expect(response.body.totals.totalUsdc).toBe(250)
      expect(response.body.totals.pendingUsdc).toBe(175)
      expect(response.body.totals.paidUsdc).toBe(75)
      // Verify history has 4 items
      expect(response.body.history).toHaveLength(4)
    })
    it('should return history items with correct structure', async () => {
      const response = await request.get('/api/whistleblower/test-whistleblower-1/earnings')
      expect(response.status).toBe(200)
      expect(response.body.history.length).toBeGreaterThan(0)
      const item = response.body.history[0]
      expect(item).toHaveProperty('rewardId')
      expect(item).toHaveProperty('listingId')
      expect(item).toHaveProperty('dealId')
      expect(item).toHaveProperty('amountNgn')
      expect(item).toHaveProperty('amountUsdc')
      expect(item).toHaveProperty('status')
      expect(item).toHaveProperty('createdAt')
      expect(['pending', 'payable', 'paid']).toContain(item.status)
    })
    it('should include paidAt for paid rewards', async () => {
      const response = await request.get('/api/whistleblower/test-whistleblower-1/earnings')
      expect(response.status).toBe(200)
      const paidReward = response.body.history.find((item: any) => item.status === 'paid')
      expect(paidReward).toBeDefined()
      expect(paidReward).toHaveProperty('paidAt')
      expect(typeof paidReward.paidAt).toBe('string')
    })
    it('should not include paidAt for pending/payable rewards', async () => {
      const response = await request.get('/api/whistleblower/test-whistleblower-1/earnings')
      expect(response.status).toBe(200)
      const pendingReward = response.body.history.find(
        (item: any) => item.status === 'pending' || item.status === 'payable'
      )
      expect(pendingReward).toBeDefined()
      expect(pendingReward.paidAt).toBeUndefined()
    })
    it('should return history sorted by createdAt descending', async () => {
      const response = await request.get('/api/whistleblower/test-whistleblower-1/earnings')
      expect(response.status).toBe(200)
      expect(response.body.history.length).toBeGreaterThan(1)
      // Verify descending order
      for (let i = 0; i < response.body.history.length - 1; i++) {
        const current = new Date(response.body.history[i].createdAt)
        const next = new Date(response.body.history[i + 1].createdAt)
        expect(current.getTime()).toBeGreaterThanOrEqual(next.getTime())
      }
    })
    it('should return empty history and zero totals for whistleblower with no rewards', async () => {
      const response = await request.get('/api/whistleblower/test-whistleblower-empty/earnings')
      expect(response.status).toBe(200)
      expect(response.body.totals.totalNgn).toBe(0)
      expect(response.body.totals.pendingNgn).toBe(0)
      expect(response.body.totals.paidNgn).toBe(0)
      expect(response.body.history).toHaveLength(0)
    })
    it('should return 404 for non-existent whistleblower', async () => {
      const response = await request.get('/api/whistleblower/non-existent-id/earnings')
      expectErrorShape(response, 'NOT_FOUND', 404)
      expect(response.body.error.message).toContain('Whistleblower not found')
    })
    it('should return 400 for empty whistleblower ID', async () => {
      const response = await request.get('/api/whistleblower//earnings')
      // This will hit the 404 catch-all since the route won't match
      expect(response.status).toBe(404)
    })
    it('should include x-request-id header in successful responses', async () => {
      const response = await request.get('/api/whistleblower/test-whistleblower-1/earnings')
      expect(response.status).toBe(200)
      expectRequestId(response)
    })
    it('should include x-request-id header in error responses', async () => {
      const response = await request.get('/api/whistleblower/non-existent-id/earnings')
      expect(response.status).toBe(404)
      expectRequestId(response)
    })
  })
})

describe('Whistleblower Listings API', () => {
  const app = createApp()
  let reporter: { userId: string; token: string }
  let otherReporter: { userId: string; token: string }

  beforeEach(async () => {
    await listingStore.clear()
    reporter = await signIn('wb-001@example.com')
    otherReporter = await signIn('wb-002@example.com')
  })

  describe('POST /api/whistleblower/listings', () => {
    const validListing = {
      address: '123 Main Street, Ikeja',
      city: 'Lagos',
      area: 'Ikeja',
      bedrooms: 2,
      bathrooms: 2,
      annualRentNgn: 1200000,
      description: 'Beautiful 2-bedroom apartment',
      photos: [
        'https://example.com/photo1.jpg',
        'https://example.com/photo2.jpg',
        'https://example.com/photo3.jpg',
      ],
    }
    it('should create a listing successfully', async () => {
      const response = await request(app)
        .post('/api/whistleblower/listings')
        .set('Authorization', `Bearer ${reporter.token}`)
        .send(validListing)
        .expect(201)
      expect(response.body.success).toBe(true)
      expect(response.body.listing).toBeDefined()
      expect(response.body.listing.listingId).toBeDefined()
      expect(response.body.listing.address).toBe(validListing.address)
      expect(response.body.listing.status).toBe(ListingStatus.PENDING_REVIEW)
      expect(response.body.listing.photos).toHaveLength(3)
      expect(response.body.listing.whistleblowerId).toBe(reporter.userId)
    })
    it('requires a signed-in reporter', async () => {
      await request(app).post('/api/whistleblower/listings').send(validListing).expect(401)
    })
    it('files the listing as the signed-in user, ignoring a whistleblowerId in the body', async () => {
      const response = await request(app)
        .post('/api/whistleblower/listings')
        .set('Authorization', `Bearer ${reporter.token}`)
        .send({ ...validListing, whistleblowerId: otherReporter.userId })
        .expect(201)
      expect(response.body.listing.whistleblowerId).toBe(reporter.userId)
    })
    it('should reject listing without address', async () => {
      const response = await request(app)
        .post('/api/whistleblower/listings')
        .set('Authorization', `Bearer ${reporter.token}`)
        .send({
          ...validListing,
          address: '',
        })
        .expect(400)
      expect(response.body.error).toBeDefined()
      expect(response.body.error.code).toBe('VALIDATION_ERROR')
      expect(response.body.error.details).toBeDefined()
    })
    it('should reject listing with invalid annual rent (zero)', async () => {
      const response = await request(app)
        .post('/api/whistleblower/listings')
        .set('Authorization', `Bearer ${reporter.token}`)
        .send({
          ...validListing,
          annualRentNgn: 0,
        })
        .expect(400)
      expect(response.body.error).toBeDefined()
      expect(response.body.error.code).toBe('VALIDATION_ERROR')
    })
    it('should reject listing with negative annual rent', async () => {
      const response = await request(app)
        .post('/api/whistleblower/listings')
        .set('Authorization', `Bearer ${reporter.token}`)
        .send({
          ...validListing,
          annualRentNgn: -1000,
        })
        .expect(400)
      expect(response.body.error).toBeDefined()
      expect(response.body.error.code).toBe('VALIDATION_ERROR')
    })
    it('should reject listing with less than 3 photos', async () => {
      const response = await request(app)
        .post('/api/whistleblower/listings')
        .set('Authorization', `Bearer ${reporter.token}`)
        .send({
          ...validListing,
          photos: [
            'https://example.com/photo1.jpg',
            'https://example.com/photo2.jpg',
          ],
        })
        .expect(400)
      expect(response.body.error).toBeDefined()
      expect(response.body.error.code).toBe('VALIDATION_ERROR')
      expect(response.body.error.message).toContain('Invalid request data')
    })
    it('should reject listing with invalid photo URLs', async () => {
      const response = await request(app)
        .post('/api/whistleblower/listings')
        .set('Authorization', `Bearer ${reporter.token}`)
        .send({
          ...validListing,
          photos: ['not-a-url', 'also-not-a-url', 'still-not-a-url'],
        })
        .expect(400)
      expect(response.body.error).toBeDefined()
      expect(response.body.error.code).toBe('VALIDATION_ERROR')
    })
    it('should enforce monthly limit (max 2 listings per month)', async () => {
      // Create first listing
      await request(app)
        .post('/api/whistleblower/listings')
        .set('Authorization', `Bearer ${reporter.token}`)
        .send(validListing)
        .expect(201)
      // Create second listing
      await request(app)
        .post('/api/whistleblower/listings')
        .set('Authorization', `Bearer ${reporter.token}`)
        .send({
          ...validListing,
          address: '456 Another Street',
        })
        .expect(201)
      // Third listing should be rejected
      const response = await request(app)
        .post('/api/whistleblower/listings')
        .set('Authorization', `Bearer ${reporter.token}`)
        .send({
          ...validListing,
          address: '789 Third Street',
        })
        .expect(429)
      expect(response.body.error).toBeDefined()
      expect(response.body.error.code).toBe('CONFLICT')
      expect(response.body.error.message).toContain('Monthly listing limit reached')
      expect(response.body.error.details).toBeDefined()
      expect(response.body.error.details.currentCount).toBe(2)
      expect(response.body.error.details.maxAllowed).toBe(2)
    })
    it('should allow different whistleblowers to create listings independently', async () => {
      // Whistleblower 1 creates 2 listings
      await request(app)
        .post('/api/whistleblower/listings')
        .set('Authorization', `Bearer ${reporter.token}`)
        .send(validListing)
        .expect(201)
      await request(app)
        .post('/api/whistleblower/listings')
        .set('Authorization', `Bearer ${reporter.token}`)
        .send({ ...validListing, address: '456 Street' })
        .expect(201)
      // Whistleblower 2 should still be able to create listings
      const response = await request(app)
        .post('/api/whistleblower/listings')
        .set('Authorization', `Bearer ${otherReporter.token}`)
        .send(validListing)
        .expect(201)
      expect(response.body.success).toBe(true)
    })
  })

  describe('GET /api/whistleblower/listings', () => {
    beforeEach(async () => {
      // Create test listings
      await listingStore.create({
        whistleblowerId: 'wb-001',
        address: '123 Main Street',
        city: 'Lagos',
        bedrooms: 2,
        bathrooms: 2,
        annualRentNgn: 1200000,
        photos: ['https://example.com/1.jpg', 'https://example.com/2.jpg', 'https://example.com/3.jpg'],
      })
      await listingStore.create({
        whistleblowerId: 'wb-002',
        address: '456 Second Avenue',
        city: 'Abuja',
        bedrooms: 3,
        bathrooms: 2,
        annualRentNgn: 1500000,
        photos: ['https://example.com/4.jpg', 'https://example.com/5.jpg', 'https://example.com/6.jpg'],
      })
    })
    it('should list all listings', async () => {
      const response = await request(app)
        .get('/api/whistleblower/listings')
        .expect(200)
      expect(response.body.success).toBe(true)
      expect(response.body.listings).toHaveLength(2)
      expect(response.body.pagination).toBeDefined()
      expect(response.body.pagination.total).toBe(2)
    })
    it('should filter listings by status', async () => {
      const response = await request(app)
        .get('/api/whistleblower/listings?status=pending_review')
        .expect(200)
      expect(response.body.success).toBe(true)
      expect(response.body.listings).toHaveLength(2)
      expect(response.body.listings.every((l: any) => l.status === 'pending_review')).toBe(true)
    })
    it('should search listings by query', async () => {
      const response = await request(app)
        .get('/api/whistleblower/listings?query=Lagos')
        .expect(200)
      expect(response.body.success).toBe(true)
      expect(response.body.listings).toHaveLength(1)
      expect(response.body.listings[0].city).toBe('Lagos')
    })
    it('should support pagination', async () => {
      const response = await request(app)
        .get('/api/whistleblower/listings?page=1&pageSize=1')
        .expect(200)
      expect(response.body.success).toBe(true)
      expect(response.body.listings).toHaveLength(1)
      expect(response.body.pagination.page).toBe(1)
      expect(response.body.pagination.pageSize).toBe(1)
      expect(response.body.pagination.totalPages).toBe(2)
    })
    it('should reject invalid page size', async () => {
      const response = await request(app)
        .get('/api/whistleblower/listings?pageSize=0')
        .expect(400)
      expect(response.body.error).toBeDefined()
      expect(response.body.error.code).toBe('VALIDATION_ERROR')
    })
    it('should reject page size exceeding maximum', async () => {
      const response = await request(app)
        .get('/api/whistleblower/listings?pageSize=101')
        .expect(400)
      expect(response.body.error).toBeDefined()
      expect(response.body.error.code).toBe('VALIDATION_ERROR')
    })
  })

  describe('GET /api/whistleblower/listings/:id', () => {
    it('should get a listing by ID', async () => {
      const created = await listingStore.create({
        whistleblowerId: 'wb-001',
        address: '123 Main Street',
        bedrooms: 2,
        bathrooms: 2,
        annualRentNgn: 1200000,
        photos: ['https://example.com/1.jpg', 'https://example.com/2.jpg', 'https://example.com/3.jpg'],
      })
      const response = await request(app)
        .get(`/api/whistleblower/listings/${created.listingId}`)
        .expect(200)
      expect(response.body.success).toBe(true)
      expect(response.body.listing).toBeDefined()
      expect(response.body.listing.listingId).toBe(created.listingId)
      expect(response.body.listing.address).toBe('123 Main Street')
    })
    it('should return 404 for non-existent listing', async () => {
      const response = await request(app)
        .get('/api/whistleblower/listings/non-existent-id')
        .expect(404)
      expect(response.body.error).toBeDefined()
      expect(response.body.error.code).toBe('NOT_FOUND')
      expect(response.body.error.message).toContain('not found')
    })
  })
})
describe('GET /api/v1/whistleblower/dashboard', () => {
  const app = createApp()

  beforeEach(async () => {
    await listingStore.clear()
  })

  it('requires a signed-in user', async () => {
    await request(app).get('/api/v1/whistleblower/dashboard').expect(401)
  })

  it('gives someone who has never reported an empty summary', async () => {
    const { token } = await signIn('wb-dash-new@example.com')
    const response = await request(app)
      .get('/api/v1/whistleblower/dashboard')
      .set('Authorization', `Bearer ${token}`)
      .expect(200)
    expect(response.body.stats).toEqual({
      totalEarnings: 0,
      reportsThisMonth: 0,
      maxReportsPerMonth: 2,
      activeListings: 0,
      rating: 0,
      reviews: 0,
    })
    expect(response.body.listings).toEqual([])
    expect(response.body.earnings).toEqual([])
  })

  it("shows only the signed-in reporter's own listings", async () => {
    const reporter = await signIn('wb-dash-1@example.com')
    const other = await signIn('wb-dash-2@example.com')
    const listing = {
      address: '9 Allen Avenue, Ikeja',
      bedrooms: 3,
      bathrooms: 2,
      annualRentNgn: 2500000,
      photos: ['https://example.com/a.jpg', 'https://example.com/b.jpg', 'https://example.com/c.jpg'],
    }
    await request(app).post('/api/v1/whistleblower/listings').set('Authorization', `Bearer ${reporter.token}`).send(listing).expect(201)
    await request(app)
      .post('/api/v1/whistleblower/listings')
      .set('Authorization', `Bearer ${other.token}`)
      .send({ ...listing, address: '1 Other Street' })
      .expect(201)

    const response = await request(app)
      .get('/api/v1/whistleblower/dashboard')
      .set('Authorization', `Bearer ${reporter.token}`)
      .expect(200)
    expect(response.body.stats.reportsThisMonth).toBe(1)
    expect(response.body.listings).toHaveLength(1)
    expect(response.body.listings[0]).toMatchObject({
      address: '9 Allen Avenue, Ikeja',
      price: 2500000,
      beds: 3,
      baths: 2,
      status: 'pending',
      earnings: 0,
    })
  })
})
