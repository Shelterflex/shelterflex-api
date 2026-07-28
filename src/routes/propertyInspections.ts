import { Router } from 'express'
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth.js'
import { requireAdmin } from '../middleware/requireAdmin.js'
import { validate } from '../middleware/validate.js'
import {
  createInspectorProfileSchema,
  updateInspectorProfileSchema,
  createPropertyInspectionSchema,
  updatePropertyInspectionSchema,
  submitReportSchema,
  reviewInspectionSchema,
  inspectionSummarySchema,
} from '../schemas/propertyInspection.js'
import { AppError } from '../errors/AppError.js'
import { ErrorCode } from '../errors/errorCodes.js'
import { inspectorProfileStore } from '../models/inspectorProfileStore.js'
import { propertyInspectionStore } from '../models/propertyInspectionStore.js'
import { inspectionChecklistItemStore } from '../models/inspectionChecklistItemStore.js'
import { inspectionPhotoStore } from '../models/inspectionPhotoStore.js'
import { listingStore } from '../models/listingStore.js'
import { InspectorVerificationStatus } from '../models/inspectorProfile.js'
import { InspectionStatus } from '../models/propertyInspection.js'
import { propertyInspectionService } from '../services/propertyInspectionService.js'

function assertInspector(req: AuthenticatedRequest) {
  if (req.user?.role !== 'inspector' && req.user?.role !== 'admin') {
    throw new AppError(ErrorCode.FORBIDDEN, 403, 'Only inspectors can access this resource')
  }
}


const router = Router()

/**
 * POST /inspector/apply
 * Inspector submits an application to join the network
 */
router.post(
  '/inspector/apply',
  authenticateToken,
  validate(createInspectorProfileSchema, 'body'),
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const existing = await inspectorProfileStore.getByUserId(req.user!.id)
      if (existing) {
        throw new AppError(ErrorCode.CONFLICT, 409, 'Inspector profile already exists')
      }

      const profile = await inspectorProfileStore.create({
        userId: req.user!.id,
        bio: req.body.bio,
        serviceAreas: req.body.serviceAreas,
      })

      res.status(201).json({ success: true, data: profile })
    } catch (error) {
      next(error)
    }
  }
)

/**
 * GET /inspector/jobs
 * Authenticated inspector views available inspection jobs for their service areas
 */
router.get('/inspector/jobs', authenticateToken, async (req: AuthenticatedRequest, res, next) => {
  try {
    assertInspector(req)

    const profile = await inspectorProfileStore.getByUserId(req.user!.id)
    if (!profile) {
      throw new AppError(ErrorCode.NOT_FOUND, 404, 'Inspector profile not found')
    }

    if (profile.verificationStatus !== InspectorVerificationStatus.VERIFIED) {
      throw new AppError(ErrorCode.FORBIDDEN, 403, 'Inspector must be verified to view jobs')
    }

    const jobs = await propertyInspectionService.getAvailableJobs(profile.serviceAreas)
    res.json({ success: true, data: jobs })
  } catch (error) {
    next(error)
  }
})

/**
 * POST /inspector/jobs/:inspectionId/accept
 * Inspector accepts a job (moves status to in_progress)
 */
router.post(
  '/inspector/jobs/:inspectionId/accept',
  authenticateToken,
  async (req: AuthenticatedRequest, res, next) => {
    try {
      assertInspector(req)

      const profile = await inspectorProfileStore.getByUserId(req.user!.id)
      if (!profile) {
        throw new AppError(ErrorCode.NOT_FOUND, 404, 'Inspector profile not found')
      }

      if (profile.verificationStatus !== InspectorVerificationStatus.VERIFIED) {
        throw new AppError(ErrorCode.FORBIDDEN, 403, 'Inspector must be verified to accept jobs')
      }

      const inspection = await propertyInspectionService.acceptJob(
        req.params.inspectionId,
        req.user!.id,
        profile.serviceAreas,
      )

      res.json({ success: true, data: inspection })
    } catch (error) {
      next(error)
    }
  }
)

/**
 * POST /inspector/jobs/:inspectionId/report
 * Inspector submits a structured report
 */
router.post(
  '/inspector/jobs/:inspectionId/report',
  authenticateToken,
  validate(submitReportSchema, 'body'),
  async (req: AuthenticatedRequest, res, next) => {
    try {
      assertInspector(req)

      const inspection = await propertyInspectionService.submitReport(
        req.params.inspectionId,
        req.user!.id,
        req.body,
      )

      res.status(201).json({ success: true, data: inspection })
    } catch (error) {
      next(error)
    }
  }
)

/**
 * GET /inspector/earnings
 * Inspector views their completed inspections and earnings
 */
router.get('/inspector/earnings', authenticateToken, async (req: AuthenticatedRequest, res, next) => {
  try {
    assertInspector(req)

    const earnings = await propertyInspectionService.getInspectorEarnings(req.user!.id)
    res.json({ success: true, data: earnings })
  } catch (error) {
    next(error)
  }
})

/**
 * PATCH /admin/inspections/:inspectionId/review
 * Admin approves or rejects a submitted report
 */
router.patch(
  '/admin/inspections/:inspectionId/review',
  authenticateToken,
  requireAdmin({ mode: 'session' }),
  validate(reviewInspectionSchema, 'body'),
  async (req: AuthenticatedRequest, res, next) => {
    try {

      const result = await propertyInspectionService.reviewInspection(
        req.params.inspectionId,
        req.body.status,
        req.body.rejectionReason,
      )

      res.json({ success: true, data: result })
    } catch (error) {
      next(error)
    }
  }
)

/**
 * GET /properties/:propertyId/inspection-summary
 * Public endpoint returning the latest approved inspection summary for a listing
 */
router.get(
  '/properties/:propertyId/inspection-summary',
  async (req, res, next) => {
    try {
      const summary = await propertyInspectionService.getInspectionSummary(req.params.propertyId)
      if (!summary) {
        throw new AppError(ErrorCode.NOT_FOUND, 404, 'No approved inspection found for this property')
      }

      res.json({ success: true, data: summary })
    } catch (error) {
      next(error)
    }
  }
)

export function createPropertyInspectionsRouter(): Router {
  return router
}
