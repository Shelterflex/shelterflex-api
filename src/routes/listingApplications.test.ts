import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import express from 'express'
import listingApplicationsRouter from './listingApplications.js'
import { listingStore } from '../models/listingStore.js'
import { applicationService } from '../services/applicationService.js'
import { AppError } from '../errors/AppError.js'
import { ErrorCode } from '../errors/errorCodes.js'

// Mock dependencies
vi.mock('../models/listingStore.js')
vi.mock('../services/applicationService.js')

describe('listingApplications routes (issue #19)', () => {
  let app: express.Application

  beforeEach(() => {
    app = express()
    app.use(express.json())
    app.use('/api', listingApplicationsRouter)
    vi.clearAllMocks()
  })

  describe('POST /api/listings/:listingId/apply', () => {
    it('resolves landlord from listing and creates application', async () => {
      const listingId = 'listing-123'
      const landlordId = 'landlord-456'
      const tenantId = 'tenant-789'

      vi.mocked(listingStore.getById).mockResolvedValue({
        listingId,
        whistleblowerId: 'wb-1',
        landlordId,
        address: '123 Main St',
        bedrooms: 2,
        bathrooms: 1,
        annualRentNgn: 500000,
        photos: [],
        status: 'approved' as any,
        createdAt: new Date(),
        updatedAt: new Date(),
      })

      vi.mocked(applicationService.apply).mockResolvedValue({
        id: 'app-1',
        tenantId,
        listingId,
        landlordId,
        status: 'pending' as any,
        preferredStartDate: new Date(),
        paymentPlan: 'six_months' as any,
        appliedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      })

      const response = await request(app)
        .post(`/api/listings/${listingId}/apply`)
        .set('Authorization', `Bearer ${tenantId}`)
        .send({
          preferredStartDate: new Date(Date.now() + 8 * 24 * 60 * 60 * 1000).toISOString(),
          paymentPlan: 'six_months',
        })

      expect(response.status).toBe(201)
      expect(listingStore.getById).toHaveBeenCalledWith(listingId)
      expect(applicationService.apply).toHaveBeenCalledWith(
        expect.objectContaining({
          listingId,
          tenantId,
          landlordId,
        })
      )
    })

    it('returns 404 when listing does not exist', async () => {
      const listingId = 'nonexistent-listing'
      const tenantId = 'tenant-789'

      vi.mocked(listingStore.getById).mockResolvedValue(null)

      const response = await request(app)
        .post(`/api/listings/${listingId}/apply`)
        .set('Authorization', `Bearer ${tenantId}`)
        .send({
          preferredStartDate: new Date(Date.now() + 8 * 24 * 60 * 60 * 1000).toISOString(),
          paymentPlan: 'six_months',
        })

      expect(response.status).toBe(404)
      expect(applicationService.apply).not.toHaveBeenCalled()
    })

    it('returns 400 when listing has no associated landlord', async () => {
      const listingId = 'listing-123'
      const tenantId = 'tenant-789'

      vi.mocked(listingStore.getById).mockResolvedValue({
        listingId,
        whistleblowerId: 'wb-1',
        landlordId: undefined, // No landlord
        address: '123 Main St',
        bedrooms: 2,
        bathrooms: 1,
        annualRentNgn: 500000,
        photos: [],
        status: 'approved' as any,
        createdAt: new Date(),
        updatedAt: new Date(),
      })

      const response = await request(app)
        .post(`/api/listings/${listingId}/apply`)
        .set('Authorization', `Bearer ${tenantId}`)
        .send({
          preferredStartDate: new Date(Date.now() + 8 * 24 * 60 * 60 * 1000).toISOString(),
          paymentPlan: 'six_months',
        })

      expect(response.status).toBe(400)
      expect(response.body).toMatchObject({
        success: false,
        error: expect.objectContaining({
          message: expect.stringContaining('does not have an associated landlord'),
        }),
      })
      expect(applicationService.apply).not.toHaveBeenCalled()
    })

    it('returns 401 when user is not authenticated', async () => {
      const listingId = 'listing-123'

      const response = await request(app)
        .post(`/api/listings/${listingId}/apply`)
        .send({
          preferredStartDate: new Date(Date.now() + 8 * 24 * 60 * 60 * 1000).toISOString(),
          paymentPlan: 'six_months',
        })

      expect(response.status).toBe(401)
    })
  })
})
