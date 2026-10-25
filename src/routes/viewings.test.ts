import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import express, { type Express } from 'express'
import { errorHandler } from '../middleware/errorHandler.js'
import { listingStore } from '../models/listingStore.js'
import { ListingStatus } from '../models/listing.js'
import { viewingStore } from '../models/viewingStore.js'
import { whistleblowerTrustStore } from '../models/whistleblowerTrustStore.js'

vi.mock('../middleware/auth.js', () => ({
  authenticateToken: (req: any, _res: unknown, next: () => void) => {
    req.user = { id: req.header('x-user') ?? 'tenant-1', email: 'u@test.com', role: req.header('x-role') ?? 'tenant' }
    next()
  },
}))
vi.mock('../utils/auditLogger.js', () => ({ auditLog: vi.fn(), extractAuditContext: vi.fn(() => ({})) }))

import { createViewingsRouter, MAX_ACTIVE_VIEWINGS_PER_TENANT } from './viewings.js'

const DAY = 24 * 60 * 60 * 1000

/** A valid slot: a few days out, at 11am Lagos time (10:00 UTC). */
function slot(daysAhead = 3, hourUtc = 10): string {
  const d = new Date(Date.now() + daysAhead * DAY)
  d.setUTCHours(hourUtc, 0, 0, 0)
  return d.toISOString()
}

const as = (user: string, role = 'tenant') => ({ 'x-user': user, 'x-role': role })

describe('viewings', () => {
  let app: Express
  let listingId: string

  async function newListing(whistleblowerId: string, status = ListingStatus.APPROVED) {
    const listing = await listingStore.create({
      whistleblowerId,
      address: '15 Admiralty Way, Lekki Phase 1',
      city: 'Lagos',
      area: 'Lekki',
      bedrooms: 2,
      bathrooms: 2,
      annualRentNgn: 1_500_000,
      photos: ['https://x/1.jpg', 'https://x/2.jpg', 'https://x/3.jpg'],
    })
    if (status !== ListingStatus.PENDING_REVIEW) await listingStore.updateStatus(listing.listingId, status)
    return listing.listingId
  }

  beforeEach(async () => {
    await viewingStore.clear()
    await listingStore.clear()
    await whistleblowerTrustStore.clear()
    listingId = await newListing('reporter-1')
    app = express()
    app.use(express.json())
    app.use('/api/viewings', createViewingsRouter())
    app.use(errorHandler)
  })

  const book = (user = 'tenant-1', body: Record<string, unknown> = {}) =>
    request(app)
      .post('/api/viewings')
      .set(as(user))
      .send({ listingId, startsAt: slot(), ...body })

  it('books a daytime viewing and hides the exact address and contact details for now', async () => {
    const res = await book().expect(201)
    expect(res.body.data).toMatchObject({
      status: 'requested',
      role: 'tenant',
      requiresInspector: true,
      place: 'Lekki, Lagos',
      address: null,
    })
    expect(JSON.stringify(res.body)).not.toMatch(/@|phone/i)
  })

  it('refuses night-time slots, short notice and off-the-hour times', async () => {
    await book('tenant-1', { startsAt: slot(3, 20) }).expect(422)
    await book('tenant-1', { startsAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString() }).expect(422)
    await book('tenant-1', { startsAt: slot(3).replace(':00:00', ':30:00') }).expect(422)
  })

  it('only allows viewings of approved listings, and never of your own', async () => {
    const pending = await newListing('reporter-1', ListingStatus.PENDING_REVIEW)
    await book('tenant-1', { listingId: pending }).expect(404)
    await request(app).post('/api/viewings').set(as('reporter-1')).send({ listingId, startsAt: slot() }).expect(400)
  })

  it('does not double-book a slot, and caps upcoming viewings per tenant', async () => {
    const when = slot(3)
    await book('tenant-1', { startsAt: when }).expect(201)
    await book('tenant-2', { startsAt: when }).expect(409)

    for (let i = 1; i < MAX_ACTIVE_VIEWINGS_PER_TENANT; i++) {
      await book('tenant-1', { startsAt: slot(3 + i) }).expect(201)
    }
    await book('tenant-1', { startsAt: slot(10) }).expect(409)
  })

  it('pauses viewings of a suspended whistleblower', async () => {
    await whistleblowerTrustStore.suspend('reporter-1', 'safety reports')
    await book().expect(409)
  })

  it('needs an inspector for a first-time reporter before it is confirmed', async () => {
    const created = await book().expect(201)
    const id = created.body.data.viewingId

    const accepted = await request(app).post(`/api/viewings/${id}/respond`).set(as('reporter-1')).send({ action: 'accept' }).expect(200)
    expect(accepted.body.data.status).toBe('awaiting_inspector')
    expect(accepted.body.data.address).toBeNull()

    // Only inspectors see and take open viewings.
    await request(app).get('/api/viewings/open-for-inspectors').set(as('tenant-1')).expect(403)
    const open = await request(app).get('/api/viewings/open-for-inspectors').set(as('inspector-1', 'inspector')).expect(200)
    expect(open.body.data).toHaveLength(1)
    expect(open.body.data[0].address).toBe('15 Admiralty Way, Lekki Phase 1')

    await request(app).post(`/api/viewings/${id}/claim`).set(as('tenant-1')).expect(403)
    const claimed = await request(app).post(`/api/viewings/${id}/claim`).set(as('inspector-1', 'inspector')).expect(200)
    expect(claimed.body.data.status).toBe('confirmed')
    await request(app).post(`/api/viewings/${id}/claim`).set(as('inspector-2', 'inspector')).expect(409)

    // Now it is confirmed, the tenant is told where to go.
    const mine = await request(app).get('/api/viewings').set(as('tenant-1')).expect(200)
    expect(mine.body.data[0]).toMatchObject({ status: 'confirmed', address: '15 Admiralty Way, Lekki Phase 1' })
  })

  it('confirms straight away when the reporter already has a successful rental', async () => {
    const seasoned = await newListing('reporter-2')
    await newListing('reporter-2', ListingStatus.RENTED)
    const created = await book('tenant-1', { listingId: seasoned }).expect(201)
    expect(created.body.data.requiresInspector).toBe(false)

    const accepted = await request(app)
      .post(`/api/viewings/${created.body.data.viewingId}/respond`)
      .set(as('reporter-2'))
      .send({ action: 'accept' })
      .expect(200)
    expect(accepted.body.data.status).toBe('confirmed')
  })

  it('lets only the reporter respond, and declines end the viewing', async () => {
    const id = (await book().expect(201)).body.data.viewingId
    await request(app).post(`/api/viewings/${id}/respond`).set(as('tenant-1')).send({ action: 'accept' }).expect(404)
    const declined = await request(app).post(`/api/viewings/${id}/respond`).set(as('reporter-1')).send({ action: 'decline' }).expect(200)
    expect(declined.body.data.status).toBe('declined')
    await request(app).post(`/api/viewings/${id}/respond`).set(as('reporter-1')).send({ action: 'accept' }).expect(409)
  })

  it('lets either side cancel, but nobody else', async () => {
    const id = (await book().expect(201)).body.data.viewingId
    await request(app).post(`/api/viewings/${id}/cancel`).set(as('stranger')).expect(404)
    const cancelled = await request(app).post(`/api/viewings/${id}/cancel`).set(as('tenant-1')).expect(200)
    expect(cancelled.body.data.status).toBe('cancelled')
    // The slot is free again.
    await book('tenant-2').expect(201)
  })
})
