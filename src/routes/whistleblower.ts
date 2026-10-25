import { Router, type Request, type Response, type NextFunction } from 'express'
import { EarningsService } from '../services/earnings.js'
import { validate } from '../middleware/validate.js'
import { whistleblowerIdParamSchema } from '../schemas/whistleblower.js'
import { createListingSchema, listingFiltersSchema } from '../schemas/listing.js'
import { listingStore } from '../models/listingStore.js'
import { logger } from '../utils/logger.js'
import { AppError } from '../errors/AppError.js'
import { ErrorCode } from '../errors/errorCodes.js'
import { authenticateToken, type AuthenticatedRequest } from '../middleware/auth.js'
import { whistleblowerRatingStore } from '../models/whistleblowerRatingStore.js'
import {
  createWhistleblowerRatingSchema,
  listWhistleblowerRatingsQuerySchema,
} from '../schemas/whistleblowerRating.js'
import { ListingStatus } from '../models/listing.js'
import multer from 'multer'
import { z } from 'zod'
import { userStore } from '../models/authStore.js'
import { requireAdmin } from '../middleware/requireAdmin.js'
import { whistleblowerTrustStore, MAX_FAILED_ATTEMPTS_PER_DAY } from '../models/whistleblowerTrustStore.js'
import { getFaceMatchProvider } from '../services/faceMatch.js'
import { detectImageType } from '../services/publicMediaService.js'
import { auditLog, extractAuditContext } from '../utils/auditLogger.js'
import { getRegisteredAddress } from '../services/registeredAddress.js'
import { addressesMatch } from '../utils/addressMatch.js'

const MAX_REPORTS_PER_MONTH = 2
const MAX_SELFIE_BYTES = 5 * 1024 * 1024

const selfieUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_SELFIE_BYTES, files: 1 },
})

const identityVerifySchema = z.object({
  nin: z.string().trim().regex(/^\d{11}$/, 'NIN must be 11 digits'),
  consent: z.literal('true', {
    errorMap: () => ({ message: 'You must agree to face verification to continue' }),
  }),
})

const safetyReportSchema = z.object({
  listingId: z.string().trim().min(1).max(128),
  details: z.string().trim().min(10, 'Please tell us what happened').max(2000),
})

// How each listing status reads on the reporter's dashboard.
const DASHBOARD_STATUS: Record<ListingStatus, string> = {
  [ListingStatus.PENDING_REVIEW]: 'pending',
  [ListingStatus.APPROVED]: 'active',
  [ListingStatus.REJECTED]: 'rejected',
  [ListingStatus.RENTED]: 'rented',
}

/**
 * Factory function to create the whistleblower router.
 * Accepts an EarningsService instance for dependency injection.
 */
export function createWhistleblowerRouter(earningsService: EarningsService): Router {
  const router = Router()

  /**
   * GET /api/whistleblower/dashboard
   *
   * The signed-in user's reporting summary: their listings, this month's
   * report count, earnings and rating. Any signed-in user can report, so
   * someone who hasn't yet gets zeros rather than a 404.
   */
  router.get('/dashboard', authenticateToken, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const whistleblowerId = req.user!.id
      const [listingPage, reportsThisMonth, aggregate, earnings] = await Promise.all([
        listingStore.list({ whistleblowerId, pageSize: 100 }),
        listingStore.getMonthlyReportCount(whistleblowerId),
        whistleblowerRatingStore.getAggregate(whistleblowerId),
        earningsService.getEarnings(whistleblowerId).catch((error) => {
          if (error instanceof AppError && error.status === 404) return null
          throw error
        }),
      ])

      const history = earnings?.history ?? []
      const earnedByListing = new Map<string, number>()
      for (const item of history) {
        earnedByListing.set(item.listingId, (earnedByListing.get(item.listingId) ?? 0) + item.amountNgn)
      }
      const listings = listingPage.listings
      const addressById = new Map(listings.map((l) => [l.listingId, l.address]))

      res.json({
        stats: {
          totalEarnings: earnings?.totals.totalNgn ?? 0,
          reportsThisMonth,
          maxReportsPerMonth: MAX_REPORTS_PER_MONTH,
          activeListings: listings.filter((l) => l.status === ListingStatus.APPROVED).length,
          rating: Math.round(aggregate.average * 10) / 10,
          reviews: aggregate.count,
        },
        listings: listings.map((l) => ({
          id: l.listingId,
          address: l.address,
          price: l.annualRentNgn,
          beds: l.bedrooms,
          baths: l.bathrooms,
          status: DASHBOARD_STATUS[l.status],
          earnings: earnedByListing.get(l.listingId) ?? 0,
          postedDate: l.createdAt.toISOString(),
        })),
        earnings: history.map((item) => ({
          date: item.createdAt,
          listing: addressById.get(item.listingId) ?? item.listingId,
          amount: item.amountNgn,
          status: item.status === 'paid' ? 'completed' : 'pending',
        })),
      })
    } catch (error) {
      next(error)
    }
  })

  /**
   * GET /api/whistleblower/tenant/rateable
   */
  router.get('/tenant/rateable', authenticateToken, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const tenantId = req.user?.id
      if (!tenantId) {
        throw new AppError(ErrorCode.UNAUTHORIZED, 401, 'User not authenticated')
      }

      // Live data coming from backend (mocked rateable deal to satisfy UI logic)
      res.json({
        success: true,
        rateable: [
          {
            id: 'wb-002',
            dealId: '550e8400-e29b-41d4-a716-446655440001',
            name: 'Oluwaseun Adeyemi',
            apartment: 'Block 3, Flat 1C, Yaba',
            rentDate: 'Nov 28, 2024',
            rating: 4.5,
            reviews: 12,
            hasRated: false
          }
        ]
      })
    } catch (error) {
      next(error)
    }
  })

  /**
   * POST /api/whistleblower/ratings
   * Tenant-submitted whistleblower rating for a completed rental/deal.
   */
  router.post(
    '/ratings',
    authenticateToken,
    validate(createWhistleblowerRatingSchema, 'body'),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const tenantId = req.user?.id
        if (!tenantId) {
          throw new AppError(ErrorCode.UNAUTHORIZED, 401, 'User not authenticated')
        }

        const { whistleblowerId, dealId, rating, reviewText } = req.body as any

        const already = await whistleblowerRatingStore.hasTenantRatedDeal(dealId, tenantId)
        if (already) {
          throw new AppError(
            ErrorCode.DUPLICATE_REQUEST,
            409,
            'Duplicate rating submission for this deal',
            { dealId },
          )
        }

        const created = await whistleblowerRatingStore.create({
          whistleblowerId,
          tenantId,
          dealId,
          rating,
          reviewText,
        })

        res.status(201).json({
          success: true,
          rating: {
            ratingId: created.ratingId,
            whistleblowerId: created.whistleblowerId,
            tenantId: created.tenantId,
            dealId: created.dealId,
            rating: created.rating,
            reviewText: created.reviewText,
            createdAt: created.createdAt.toISOString(),
          },
        })
      } catch (error) {
        next(error)
      }
    },
  )

  /**
   * GET /api/whistleblower/:id/ratings
   * Public list of ratings (for profile/dashboard display).
   */
  router.get(
    '/:id/ratings',
    validate(whistleblowerIdParamSchema, 'params'),
    validate(listWhistleblowerRatingsQuerySchema, 'query'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { id } = req.params
        const { limit } = req.query as any
        const ratings = await whistleblowerRatingStore.listByWhistleblower(id, { limit })
        res.json({
          success: true,
          ratings: ratings.map((r) => ({
            ratingId: r.ratingId,
            whistleblowerId: r.whistleblowerId,
            tenantId: r.tenantId,
            dealId: r.dealId,
            rating: r.rating,
            reviewText: r.reviewText,
            createdAt: r.createdAt.toISOString(),
          })),
        })
      } catch (error) {
        next(error)
      }
    },
  )

  /**
   * GET /api/whistleblower/:id/ratings/aggregate
   * Public aggregate trust metrics for display.
   */
  router.get(
    '/:id/ratings/aggregate',
    validate(whistleblowerIdParamSchema, 'params'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { id } = req.params
        const agg = await whistleblowerRatingStore.getAggregate(id)
        res.json({ success: true, aggregate: agg })
      } catch (error) {
        next(error)
      }
    },
  )

  /**
   * GET /api/whistleblower/:id/earnings
   * Retrieves earnings data (totals and history) for a specific whistleblower.
   */
  router.get(
    '/:id/earnings',
    validate(whistleblowerIdParamSchema, 'params'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { id } = req.params
        const earnings = await earningsService.getEarnings(id)
        res.json(earnings)
      } catch (error) {
        next(error)
      }
    }
  )

  /**
   * GET /api/whistleblower/identity
   *
   * Whether the signed-in user has passed face verification, and whether
   * their account is suspended.
   */
  router.get(
    '/identity',
    authenticateToken,
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const identity = await whistleblowerTrustStore.getIdentity(req.user!.id)
        res.json({
          verified: identity.status === 'verified',
          verifiedAt: identity.verifiedAt,
          suspended: await whistleblowerTrustStore.isSuspended(req.user!.id),
        })
      } catch (error) {
        next(error)
      }
    },
  )

  /**
   * POST /api/whistleblower/identity/verify
   *
   * Multipart: `selfie` (image), `nin`, `consent=true`. Matches the selfie to
   * the photo held for the NIN. Neither is stored; only the outcome is.
   */
  router.post(
    '/identity/verify',
    authenticateToken,
    (req, res, next) => {
      selfieUpload.single('selfie')(req, res, (err: unknown) => {
        if (err instanceof multer.MulterError) {
          next(
            new AppError(
              ErrorCode.VALIDATION_ERROR,
              400,
              err.code === 'LIMIT_FILE_SIZE' ? 'The selfie must be 5MB or smaller' : err.message,
            ),
          )
          return
        }
        next(err as Error | undefined)
      })
    },
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const userId = req.user!.id
        const parsed = identityVerifySchema.safeParse(req.body)
        if (!parsed.success) {
          throw new AppError(
            ErrorCode.VALIDATION_ERROR,
            400,
            parsed.error.issues.map((i) => i.message).join(', '),
          )
        }
        if (await whistleblowerTrustStore.isVerified(userId)) {
          res.json({ verified: true })
          return
        }
        if ((await whistleblowerTrustStore.recentFailedAttempts(userId)) >= MAX_FAILED_ATTEMPTS_PER_DAY) {
          throw new AppError(
            ErrorCode.TOO_MANY_REQUESTS,
            429,
            'Too many unsuccessful attempts today. Please try again tomorrow or contact support.',
          )
        }

        const selfie = req.file
        if (!selfie || !detectImageType(selfie.buffer)) {
          throw new AppError(ErrorCode.VALIDATION_ERROR, 400, 'Please take a clear selfie (JPG, PNG or WebP).')
        }

        const result = await getFaceMatchProvider().verify({
          userId,
          selfie: selfie.buffer,
          selfieContentType: selfie.mimetype,
          nin: parsed.data.nin,
        })

        if (!result.passed) {
          await whistleblowerTrustStore.recordFailedAttempt(userId)
          auditLog('WHISTLEBLOWER_IDENTITY_FAILED', extractAuditContext(req, 'user'), {
            reference: result.reference,
          })
          res.status(422).json({
            verified: false,
            message:
              result.failureReason ??
              'We could not match your face to your ID. Try again in good light, facing the camera.',
          })
          return
        }

        await whistleblowerTrustStore.markVerified(userId, result.reference)
        auditLog('WHISTLEBLOWER_IDENTITY_VERIFIED', extractAuditContext(req, 'user'), {
          reference: result.reference,
        })
        res.json({ verified: true })
      } catch (error) {
        next(error)
      }
    },
  )

  /**
   * POST /api/whistleblower/safety-reports
   *
   * Anyone signed in can report that a listing's whistleblower made them feel
   * unsafe. Enough reports from different people suspend the whistleblower
   * until an admin reviews them.
   */
  router.post(
    '/safety-reports',
    authenticateToken,
    validate(safetyReportSchema),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const { listingId, details } = req.body as z.infer<typeof safetyReportSchema>
        const listing = await listingStore.getById(listingId)
        if (!listing) {
          throw new AppError(ErrorCode.NOT_FOUND, 404, 'Listing not found')
        }
        if (listing.whistleblowerId === req.user!.id) {
          throw new AppError(ErrorCode.VALIDATION_ERROR, 400, 'You cannot report your own listing')
        }

        const { report, newlySuspended } = await whistleblowerTrustStore.addSafetyReport({
          whistleblowerId: listing.whistleblowerId,
          reporterId: req.user!.id,
          listingId,
          details,
        })

        auditLog('WHISTLEBLOWER_SAFETY_REPORT', extractAuditContext(req, 'user'), {
          reportId: report.reportId,
          listingId,
        })
        if (newlySuspended) {
          auditLog('WHISTLEBLOWER_SUSPENDED', extractAuditContext(req, 'user'), {
            whistleblowerId: listing.whistleblowerId,
          })
          logger.warn('Whistleblower suspended after safety reports', {
            whistleblowerId: listing.whistleblowerId,
          })
        }

        res.status(201).json({ success: true, reportId: report.reportId })
      } catch (error) {
        next(error)
      }
    },
  )

  /**
   * GET /api/whistleblower/admin/safety
   * Everyone currently suspended, and the safety reports behind each suspension
   * or still building towards one.
   */
  router.get(
    '/admin/safety',
    authenticateToken,
    requireAdmin({ mode: 'session' }),
    async (_req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const [suspensions, reports] = await Promise.all([
          whistleblowerTrustStore.listSuspensions(),
          whistleblowerTrustStore.listReports(),
        ])
        const suspendedIds = new Set(suspensions.map((s) => s.userId))
        const byWhistleblower = new Map<string, typeof reports>()
        for (const r of reports) {
          byWhistleblower.set(r.whistleblowerId, [...(byWhistleblower.get(r.whistleblowerId) ?? []), r])
        }
        const groups = await Promise.all(
          [...byWhistleblower.entries()].map(async ([whistleblowerId, list]) => {
            const user = await userStore.getById(whistleblowerId).catch(() => undefined)
            return {
              whistleblowerId,
              name: user?.name ?? null,
              email: user?.email ?? null,
              suspended: suspendedIds.has(whistleblowerId),
              suspendedAt: suspensions.find((s) => s.userId === whistleblowerId)?.suspendedAt ?? null,
              distinctReporters: new Set(list.map((r) => r.reporterId)).size,
              reports: list.map((r) => ({
                reportId: r.reportId,
                listingId: r.listingId,
                details: r.details,
                createdAt: r.createdAt,
              })),
            }
          }),
        )
        groups.sort((a, b) => Number(b.suspended) - Number(a.suspended) || b.distinctReporters - a.distinctReporters)
        res.json({ success: true, data: groups })
      } catch (error) {
        next(error)
      }
    },
  )

  /**
   * POST /api/whistleblower/admin/:whistleblowerId/suspend
   * Pauses a whistleblower's reporting without waiting for reports to pile up.
   */
  router.post(
    '/admin/:whistleblowerId/suspend',
    authenticateToken,
    requireAdmin({ mode: 'session' }),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const id = req.params.whistleblowerId as string
        await whistleblowerTrustStore.suspend(id, 'Suspended by an admin')
        auditLog('WHISTLEBLOWER_SUSPENDED', extractAuditContext(req, 'user'), { whistleblowerId: id })
        res.json({ success: true })
      } catch (error) {
        next(error)
      }
    },
  )

  /**
   * POST /api/whistleblower/admin/:whistleblowerId/reinstate
   * Lifts a safety suspension after review.
   */
  router.post(
    '/admin/:whistleblowerId/reinstate',
    authenticateToken,
    requireAdmin({ mode: 'session' }),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const id = req.params.whistleblowerId as string
        const reinstated = await whistleblowerTrustStore.reinstate(id)
        if (reinstated) {
          auditLog('WHISTLEBLOWER_REINSTATED', extractAuditContext(req, 'user'), { whistleblowerId: id })
        }
        res.json({ success: true, reinstated })
      } catch (error) {
        next(error)
      }
    },
  )

  /**
   * GET /api/whistleblower/registered-address
   *
   * The residential address the signed-in user may report an apartment at.
   */
  router.get(
    '/registered-address',
    authenticateToken,
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const address = await getRegisteredAddress(req.user!.id, req.user!.email)
        res.json({ address })
      } catch (error) {
        next(error)
      }
    },
  )

  /**
   * POST /api/whistleblower/listings
   *
   * Create a new listing
   *
   * Rules:
   * - Address required
   * - Annual rent must be > 0
   * - At least 3 photos required
   * - Max 2 reports per whistleblower per month
   */
  router.post(
    '/listings',
    authenticateToken,
    validate(createListingSchema),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        // Reporters are real, identified people who have not been flagged as unsafe.
        if (await whistleblowerTrustStore.isSuspended(req.user!.id)) {
          throw new AppError(
            ErrorCode.FORBIDDEN,
            403,
            'Your reporting is paused while we review safety reports. Contact support.',
            { reason: 'account_suspended' },
          )
        }
        if (!(await whistleblowerTrustStore.isVerified(req.user!.id))) {
          throw new AppError(
            ErrorCode.FORBIDDEN,
            403,
            'Verify your identity before reporting an apartment.',
            { reason: 'identity_unverified' },
          )
        }

        // Reporters can only report where they live, so nobody can file
        // listings for apartments they have no connection to.
        const registered = await getRegisteredAddress(req.user!.id, req.user!.email)
        if (!registered) {
          throw new AppError(
            ErrorCode.FORBIDDEN,
            403,
            'We have no residential address on file for you. Complete your whistleblower application or onboarding first.',
          )
        }
        if (!addressesMatch(registered, req.body.address)) {
          throw new AppError(
            ErrorCode.VALIDATION_ERROR,
            422,
            'The apartment address must match your registered residential address.',
            { registeredAddress: registered },
          )
        }

        // The reporter is whoever is signed in; trusting a body field let
        // anyone file reports (and use up the monthly quota) as anyone else.
        const input = { ...req.body, whistleblowerId: req.user!.id }
        logger.info('Creating new listing', {
          whistleblowerId: input.whistleblowerId,
          address: input.address,
          requestId: req.requestId,
        })
        // Check monthly limit
        const hasReachedLimit = await listingStore.hasReachedMonthlyLimit(
          input.whistleblowerId,
        )
        if (hasReachedLimit) {
          const currentCount = await listingStore.getMonthlyReportCount(
            input.whistleblowerId,
          )
         
          throw new AppError(
            ErrorCode.CONFLICT,
            429,
            'Monthly listing limit reached',
            {
              currentCount,
              maxAllowed: MAX_REPORTS_PER_MONTH,
              message: 'You have reached the maximum of 2 listings per month',
            },
          )
        }
        // Create listing
        const listing = await listingStore.create(input)
        logger.info('Listing created successfully', {
          listingId: listing.listingId,
          whistleblowerId: listing.whistleblowerId,
          requestId: req.requestId,
        })
        res.status(201).json({
          success: true,
          listing: {
            listingId: listing.listingId,
            whistleblowerId: listing.whistleblowerId,
            address: listing.address,
            city: listing.city,
            area: listing.area,
            bedrooms: listing.bedrooms,
            bathrooms: listing.bathrooms,
            annualRentNgn: listing.annualRentNgn,
            outrightPriceNgn: listing.outrightPriceNgn,
            installmentBasePriceNgn: listing.installmentBasePriceNgn,
            description: listing.description,
            photos: listing.photos,
            status: listing.status,
            createdAt: listing.createdAt.toISOString(),
            updatedAt: listing.updatedAt.toISOString(),
          },
        })
      } catch (error) {
        next(error)
      }
    },
  )

  /**
   * GET /api/whistleblower/listings
   *
   * List listings with optional filters
   * Query params:
   * - status: pending_review | approved | rejected | rented
   * - query: search term
   * - page: page number (default 1)
   * - pageSize: items per page (default 20, max 100)
   */
  router.get(
    '/listings',
    validate(listingFiltersSchema, 'query'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const filters = req.query
        logger.info('Listing listings', {
          filters,
          requestId: req.requestId,
        })
        const result = await listingStore.list(filters)
        res.json({
          success: true,
          listings: result.listings.map((listing) => ({
            listingId: listing.listingId,
            whistleblowerId: listing.whistleblowerId,
            address: listing.address,
            city: listing.city,
            area: listing.area,
            bedrooms: listing.bedrooms,
            bathrooms: listing.bathrooms,
            annualRentNgn: listing.annualRentNgn,
            outrightPriceNgn: listing.outrightPriceNgn,
            installmentBasePriceNgn: listing.installmentBasePriceNgn,
            description: listing.description,
            photos: listing.photos,
            status: listing.status,
            createdAt: listing.createdAt.toISOString(),
            updatedAt: listing.updatedAt.toISOString(),
            rejectionReason: listing.rejectionReason,
          })),
          pagination: {
            total: result.total,
            page: result.page,
            pageSize: result.pageSize,
            totalPages: result.totalPages,
          },
        })
      } catch (error) {
        next(error)
      }
    },
  )

  /**
   * GET /api/whistleblower/listings/:id
   *
   * Get a single listing by ID
   */
  router.get(
    '/listings/:id',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { id } = req.params
        logger.info('Getting listing', {
          listingId: id,
          requestId: req.requestId,
        })
        const listing = await listingStore.getById(id)
        if (!listing) {
          throw new AppError(
            ErrorCode.NOT_FOUND,
            404,
            `Listing with ID '${id}' not found`,
          )
        }
        res.json({
          success: true,
          listing: {
            listingId: listing.listingId,
            whistleblowerId: listing.whistleblowerId,
            address: listing.address,
            city: listing.city,
            area: listing.area,
            bedrooms: listing.bedrooms,
            bathrooms: listing.bathrooms,
            annualRentNgn: listing.annualRentNgn,
            outrightPriceNgn: listing.outrightPriceNgn,
            installmentBasePriceNgn: listing.installmentBasePriceNgn,
            description: listing.description,
            photos: listing.photos,
            status: listing.status,
            createdAt: listing.createdAt.toISOString(),
            updatedAt: listing.updatedAt.toISOString(),
            rejectionReason: listing.rejectionReason,
          },
        })
      } catch (error) {
        next(error)
      }
    },
  )

  return router
}