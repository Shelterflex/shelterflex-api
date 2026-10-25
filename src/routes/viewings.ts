/**
 * Apartment viewings, arranged in-app so nobody has to hand a stranger their
 * phone number, and kept to daytime. A viewing of a first-time reporter's
 * apartment is only confirmed once a Shelterflex inspector has agreed to attend.
 */

import { Router, type Response, type NextFunction } from 'express'
import { z } from 'zod'
import { authenticateToken, type AuthenticatedRequest } from '../middleware/auth.js'
import { validate } from '../middleware/validate.js'
import { AppError } from '../errors/AppError.js'
import { ErrorCode } from '../errors/errorCodes.js'
import { listingStore } from '../models/listingStore.js'
import { ListingStatus } from '../models/listing.js'
import { userStore } from '../models/authStore.js'
import { viewingStore, viewingStatus, type Viewing } from '../models/viewingStore.js'
import { whistleblowerTrustStore } from '../models/whistleblowerTrustStore.js'
import { checkViewingSlot } from '../utils/viewingSlots.js'
import { auditLog, extractAuditContext } from '../utils/auditLogger.js'

/** A tenant can hold at most this many upcoming viewings at once. */
export const MAX_ACTIVE_VIEWINGS_PER_TENANT = 3

const createSchema = z.object({
  listingId: z.string().trim().min(1).max(128),
  startsAt: z.string().datetime(),
})
const respondSchema = z.object({ action: z.enum(['accept', 'decline']) })

const firstName = (name: string | undefined | null) => (name ?? '').trim().split(/\s+/)[0] || 'Someone'

/**
 * How a viewing is shown to someone in it. Only first names are given, never
 * contact details, and the exact address is held back until it is confirmed.
 */
async function present(viewing: Viewing, userId: string) {
  const status = viewingStatus(viewing)
  const [listing, tenant, reporter] = await Promise.all([
    listingStore.getById(viewing.listingId),
    userStore.getById(viewing.tenantId).catch(() => undefined),
    userStore.getById(viewing.whistleblowerId).catch(() => undefined),
  ])
  const place = [listing?.area, listing?.city].filter(Boolean).join(', ')
  const role =
    viewing.tenantId === userId ? 'tenant' : viewing.whistleblowerId === userId ? 'reporter' : 'inspector'
  // The meeting place is revealed to the people attending once it is confirmed.
  const showAddress = status === 'confirmed' && listing
  return {
    viewingId: viewing.viewingId,
    listingId: viewing.listingId,
    startsAt: viewing.startsAt,
    status,
    role,
    requiresInspector: viewing.requiresInspector,
    inspectorAssigned: viewing.inspectorId !== null,
    place: place || null,
    address: showAddress ? listing.address : null,
    tenantFirstName: firstName(tenant?.name),
    reporterFirstName: firstName(reporter?.name),
  }
}

export function createViewingsRouter(): Router {
  const router = Router()

  /** POST /viewings: a tenant asks to see a listing. */
  router.post(
    '/',
    authenticateToken,
    validate(createSchema),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const userId = req.user!.id
        const { listingId, startsAt } = req.body as z.infer<typeof createSchema>

        const slotProblem = checkViewingSlot(new Date(startsAt))
        if (slotProblem) throw new AppError(ErrorCode.VALIDATION_ERROR, 422, slotProblem)

        const listing = await listingStore.getById(listingId)
        if (!listing || listing.status !== ListingStatus.APPROVED) {
          throw new AppError(ErrorCode.NOT_FOUND, 404, 'This apartment is not open for viewings.')
        }
        if (listing.whistleblowerId === userId) {
          throw new AppError(ErrorCode.VALIDATION_ERROR, 400, 'You cannot book a viewing of your own listing.')
        }
        if (await whistleblowerTrustStore.isSuspended(listing.whistleblowerId)) {
          throw new AppError(ErrorCode.CONFLICT, 409, 'Viewings of this apartment are paused right now.')
        }

        const active = (await viewingStore.listForUser(userId)).filter(
          (v) => v.tenantId === userId && v.state === 'open' && Date.parse(v.startsAt) > Date.now(),
        )
        if (active.length >= MAX_ACTIVE_VIEWINGS_PER_TENANT) {
          throw new AppError(
            ErrorCode.CONFLICT,
            409,
            `You can have ${MAX_ACTIVE_VIEWINGS_PER_TENANT} upcoming viewings at a time. Cancel one to book another.`,
          )
        }
        const slotTaken = (await viewingStore.listActiveForListing(listingId)).some(
          (v) => Date.parse(v.startsAt) === Date.parse(startsAt),
        )
        if (slotTaken) {
          throw new AppError(ErrorCode.CONFLICT, 409, 'That time is already taken. Pick another.')
        }

        // A reporter who has not yet had a successful rental is new to us, so
        // an inspector comes along.
        const rented = await listingStore.list({
          whistleblowerId: listing.whistleblowerId,
          status: ListingStatus.RENTED,
          pageSize: 1,
        })

        const viewing = await viewingStore.create({
          listingId,
          tenantId: userId,
          whistleblowerId: listing.whistleblowerId,
          startsAt: new Date(startsAt).toISOString(),
          requiresInspector: rented.total === 0,
        })
        auditLog('VIEWING_REQUESTED', extractAuditContext(req, 'user'), { viewingId: viewing.viewingId, listingId })
        res.status(201).json({ success: true, data: await present(viewing, userId) })
      } catch (error) {
        next(error)
      }
    },
  )

  /** GET /viewings: the signed-in user's viewings, whichever side they are on. */
  router.get('/', authenticateToken, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.id
      const viewings = await viewingStore.listForUser(userId)
      res.json({ success: true, data: await Promise.all(viewings.map((v) => present(v, userId))) })
    } catch (error) {
      next(error)
    }
  })

  /** GET /viewings/open-for-inspectors: accepted viewings still needing an inspector. */
  router.get(
    '/open-for-inspectors',
    authenticateToken,
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        if (req.user!.role !== 'inspector') {
          throw new AppError(ErrorCode.FORBIDDEN, 403, 'Only inspectors can see these.')
        }
        const viewings = await viewingStore.listAwaitingInspector()
        // Inspectors need the address to attend, so it is included for them.
        const data = await Promise.all(
          viewings.map(async (v) => {
            const listing = await listingStore.getById(v.listingId)
            return { ...(await present(v, req.user!.id)), address: listing?.address ?? null }
          }),
        )
        res.json({ success: true, data })
      } catch (error) {
        next(error)
      }
    },
  )

  /** POST /viewings/:id/respond: the reporter accepts or declines. */
  router.post(
    '/:id/respond',
    authenticateToken,
    validate(respondSchema),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const viewing = await viewingStore.getById(req.params.id as string)
        if (!viewing || viewing.whistleblowerId !== req.user!.id) {
          throw new AppError(ErrorCode.NOT_FOUND, 404, 'Viewing not found')
        }
        if (viewing.state !== 'open') {
          throw new AppError(ErrorCode.CONFLICT, 409, 'This viewing has already ended.')
        }
        const { action } = req.body as z.infer<typeof respondSchema>
        const updated = await viewingStore.update(
          viewing.viewingId,
          action === 'accept' ? { whistleblowerAccepted: true } : { state: 'declined' },
        )
        auditLog('VIEWING_RESPONDED', extractAuditContext(req, 'user'), { viewingId: viewing.viewingId, action })
        res.json({ success: true, data: await present(updated!, req.user!.id) })
      } catch (error) {
        next(error)
      }
    },
  )

  /** POST /viewings/:id/claim: an inspector agrees to attend. */
  router.post('/:id/claim', authenticateToken, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      if (req.user!.role !== 'inspector') {
        throw new AppError(ErrorCode.FORBIDDEN, 403, 'Only inspectors can attend viewings.')
      }
      const viewing = await viewingStore.getById(req.params.id as string)
      if (!viewing || !viewing.requiresInspector) {
        throw new AppError(ErrorCode.NOT_FOUND, 404, 'Viewing not found')
      }
      if (viewing.state !== 'open') {
        throw new AppError(ErrorCode.CONFLICT, 409, 'This viewing has already ended.')
      }
      if (viewing.inspectorId) {
        throw new AppError(ErrorCode.CONFLICT, 409, 'Another inspector has already taken this viewing.')
      }
      const updated = await viewingStore.update(viewing.viewingId, { inspectorId: req.user!.id })
      auditLog('VIEWING_INSPECTOR_CLAIMED', extractAuditContext(req, 'user'), { viewingId: viewing.viewingId })
      res.json({ success: true, data: await present(updated!, req.user!.id) })
    } catch (error) {
      next(error)
    }
  })

  /** POST /viewings/:id/cancel: either side can cancel an open viewing. */
  router.post('/:id/cancel', authenticateToken, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.id
      const viewing = await viewingStore.getById(req.params.id as string)
      if (!viewing || (viewing.tenantId !== userId && viewing.whistleblowerId !== userId)) {
        throw new AppError(ErrorCode.NOT_FOUND, 404, 'Viewing not found')
      }
      if (viewing.state !== 'open') {
        throw new AppError(ErrorCode.CONFLICT, 409, 'This viewing has already ended.')
      }
      const updated = await viewingStore.update(viewing.viewingId, { state: 'cancelled' })
      auditLog('VIEWING_CANCELLED', extractAuditContext(req, 'user'), { viewingId: viewing.viewingId })
      res.json({ success: true, data: await present(updated!, userId) })
    } catch (error) {
      next(error)
    }
  })

  return router
}
