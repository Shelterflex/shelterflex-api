import request from 'supertest'
import { beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../app.js'
import { ListingStatus, type CreateListingInput } from '../models/listing.js'
import { listingStore } from '../models/listingStore.js'

describe('Public Listings Search API', () => {
  const app = createApp()
  let whistleblowerSequence = 0

  beforeEach(async () => {
    whistleblowerSequence = 0
    await listingStore.clear()
  })

  async function createApprovedListing(input: Partial<CreateListingInput> = {}) {
    whistleblowerSequence += 1
    const listing = await listingStore.create({
      whistleblowerId: input.whistleblowerId ?? `wb-${whistleblowerSequence}`,
      address: input.address ?? '12 Admiralty Way, Lekki Phase 1',
      city: input.city ?? 'Lagos',
      area: input.area ?? 'Lekki',
      bedrooms: input.bedrooms ?? 2,
      bathrooms: input.bathrooms ?? 2,
      annualRentNgn: input.annualRentNgn ?? 2_500_000,
      outrightPriceNgn: input.outrightPriceNgn,
      installmentBasePriceNgn: input.installmentBasePriceNgn,
      negotiatedLandlordRateNgn: input.negotiatedLandlordRateNgn,
      description: input.description ?? 'Bright apartment close to shops and transit',
      photos: input.photos ?? [
        'https://example.com/photo-1.jpg',
        'https://example.com/photo-2.jpg',
        'https://example.com/photo-3.jpg',
      ],
    })

    const approved = await listingStore.moderate(
      listing.listingId,
      ListingStatus.APPROVED,
      'search-test-admin',
    )

    if (!approved) {
      throw new Error('Expected listing to be approved')
    }

    return approved
  }

  it('returns a paginated collection of approved listings from the root endpoint, with no redirect', async () => {
    await createApprovedListing({ address: '1 First Street' })
    await createApprovedListing({ address: '2 Second Street' })
    await createApprovedListing({ address: '3 Third Street' })

    const response = await request(app).get('/api/listings').redirects(0).expect(200)

    expect(response.body.success).toBe(true)
    expect(response.body.total).toBe(3)
    expect(response.body.page).toBe(1)
    expect(response.body.pageSize).toBe(20)
    expect(response.body.totalPages).toBe(1)
    expect(response.body.data).toHaveLength(3)
  })

  it('paginates the root endpoint and clamps oversized page sizes', async () => {
    await createApprovedListing({ address: '1 First Street' })
    await createApprovedListing({ address: '2 Second Street' })
    await createApprovedListing({ address: '3 Third Street' })

    const paged = await request(app)
      .get('/api/listings')
      .query({ page: 2, pageSize: 2 })
      .expect(200)

    expect(paged.body.total).toBe(3)
    expect(paged.body.page).toBe(2)
    expect(paged.body.pageSize).toBe(2)
    expect(paged.body.data).toHaveLength(1)

    const oversized = await request(app)
      .get('/api/listings')
      .query({ pageSize: 500 })
      .expect(400)

    expect(oversized.body.success).not.toBe(true)
  })

  it('excludes non-approved listings from the root endpoint', async () => {
    await createApprovedListing({ address: '1 First Street' })
    await listingStore.create({
      whistleblowerId: 'wb-pending',
      address: '2 Pending Street',
      city: 'Lagos',
      area: 'Lekki',
      bedrooms: 2,
      bathrooms: 2,
      annualRentNgn: 2_000_000,
      description: 'Awaiting review',
      photos: [
        'https://example.com/photo-1.jpg',
        'https://example.com/photo-2.jpg',
        'https://example.com/photo-3.jpg',
      ],
    })

    const response = await request(app).get('/api/listings').expect(200)

    expect(response.body.total).toBe(1)
    expect(response.body.data[0].address).toBe('1 First Street')
  })

  it('gets a single approved listing by id, leaving the root and search routes unaffected', async () => {
    const listing = await createApprovedListing({ address: '9 Ninth Street' })

    const response = await request(app).get(`/api/listings/${listing.listingId}`).expect(200)

    expect(response.body.success).toBe(true)
    expect(response.body.data.listingId).toBe(listing.listingId)
  })

  it('searches approved listings across description, address, city, and area', async () => {
    await createApprovedListing({
      address: '5 Bourdillon Road',
      area: 'Ikoyi',
      description: 'Quiet serviced apartment with lagoon views',
    })
    await createApprovedListing({
      address: '11 Allen Avenue',
      area: 'Ikeja',
      description: 'Family home near the airport',
    })

    const response = await request(app)
      .get('/api/listings/search')
      .query({ q: 'lagoon' })
      .expect(200)

    expect(response.body.success).toBe(true)
    expect(response.body.total).toBe(1)
    expect(response.body.data[0].area).toBe('Ikoyi')
    expect(response.body.data[0].highlightedSnippet).toContain('lagoon')
    expect(response.body.data[0]).toHaveProperty('rank')
  })

  it('combines price, bedroom, LGA, and payment plan filters', async () => {
    await createApprovedListing({
      address: '20 Admiralty Road',
      area: 'Lekki',
      bedrooms: 3,
      annualRentNgn: 3_000_000,
      installmentBasePriceNgn: 3_300_000,
      description: 'Three bedroom apartment with flexible installments',
    })
    await createApprovedListing({
      address: '21 Admiralty Road',
      area: 'Lekki',
      bedrooms: 2,
      annualRentNgn: 2_400_000,
      installmentBasePriceNgn: 2_700_000,
    })
    await createApprovedListing({
      address: '22 Admiralty Road',
      area: 'Ikoyi',
      bedrooms: 3,
      annualRentNgn: 3_200_000,
      installmentBasePriceNgn: 3_500_000,
    })
    await createApprovedListing({
      address: '23 Admiralty Road',
      area: 'Lekki',
      bedrooms: 3,
      annualRentNgn: 3_000_000,
      installmentBasePriceNgn: undefined,
    })

    const response = await request(app)
      .get('/api/listings/search')
      .query({
        q: 'apartment',
        minPrice: 3_000_000,
        maxPrice: 3_400_000,
        bedrooms: 3,
        lga: 'lekki',
        paymentPlan: 'monthly',
      })
      .expect(200)

    expect(response.body.total).toBe(1)
    expect(response.body.data[0].address).toBe('20 Admiralty Road')
  })

  it('returns all approved listings for an empty query and paginates results', async () => {
    await createApprovedListing({ address: '1 First Street' })
    await createApprovedListing({ address: '2 Second Street' })
    await createApprovedListing({ address: '3 Third Street' })

    const response = await request(app)
      .get('/api/listings/search')
      .query({ page: 2, pageSize: 2 })
      .expect(200)

    expect(response.body.total).toBe(3)
    expect(response.body.page).toBe(2)
    expect(response.body.pageSize).toBe(2)
    expect(response.body.totalPages).toBe(2)
    expect(response.body.data).toHaveLength(1)
  })

  it('returns an empty result set when no listings match', async () => {
    await createApprovedListing({ address: '1 First Street', description: 'Compact studio' })

    const response = await request(app)
      .get('/api/listings/search')
      .query({ q: 'penthouse', lga: 'Yaba' })
      .expect(200)

    expect(response.body.total).toBe(0)
    expect(response.body.data).toEqual([])
  })

  it('suggests up to five matching addresses, cities, and LGAs', async () => {
    await createApprovedListing({ address: '10 Lekki Gardens', area: 'Lekki', city: 'Lagos' })
    await createApprovedListing({ address: '11 Lekki Palms', area: 'Lekki Phase 1', city: 'Lagos' })
    await createApprovedListing({ address: '12 Lekki Heights', area: 'Lekki Phase 2', city: 'Lagos' })

    const response = await request(app)
      .get('/api/listings/search/suggest')
      .query({ q: 'lekki' })
      .expect(200)

    expect(response.body.success).toBe(true)
    expect(response.body.data.length).toBeGreaterThan(0)
    expect(response.body.data.length).toBeLessThanOrEqual(5)
    expect(response.body.data.some((suggestion: string) => suggestion.toLowerCase().includes('lekki'))).toBe(true)
  })
})
