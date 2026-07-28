import { Router } from 'express'
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth.js'
import { requireAdmin } from '../middleware/requireAdmin.js'
import { inspectorService } from '../services/inspectorService.js'
import { SorobanAdapter } from '../soroban/adapter.js'
import { InspectorBondService } from '../services/inspectorBondService.js'
import { AppError } from '../errors/AppError.js'
import { ErrorCode } from '../errors/errorCodes.js'
import { auditLog, extractAuditContext } from '../utils/auditLogger.js'
import { logger } from '../utils/logger.js'

function assertInspector(req: AuthenticatedRequest) {
  if (req.user?.role !== 'inspector' && req.user?.role !== 'admin') {
    throw new AppError(ErrorCode.FORBIDDEN, 403, 'Only inspectors can access this resource')
  }
}


// Inspector-facing router — mounted at /api/inspector
export function createInspectorJobsRouter(adapter: SorobanAdapter): Router {
  const router = Router()
  const bondService = new InspectorBondService(adapter)

  // Bond management routes
  router.post('/bond/stake', authenticateToken, async (req: AuthenticatedRequest, res, next) => {
    try {
      assertInspector(req)
      const { amount } = req.body
      if (!amount) {
        throw new AppError(ErrorCode.VALIDATION_ERROR, 400, 'amount is required')
      }
      const inspectorId = req.user!.id
      await bondService.stake(inspectorId, BigInt(amount))
      logger.info('Inspector bond staked', { inspectorId, amount })
      res.json({ success: true, message: 'Bond staked successfully' })
    } catch (error) {
      next(error)
    }
  })

  router.delete('/bond/unstake', authenticateToken, async (req: AuthenticatedRequest, res, next) => {
    try {
      assertInspector(req)
      const inspectorId = req.user!.id
      await bondService.unstake(inspectorId)
      logger.info('Inspector bond unstaked', { inspectorId })
      res.json({ success: true, message: 'Bond unstaked successfully' })
    } catch (error) {
      next(error)
    }
  })

  router.get('/bond/status', authenticateToken, async (req: AuthenticatedRequest, res, next) => {
    try {
      assertInspector(req)
      const status = await bondService.getStatus(req.user!.id)
      res.json({ success: true, ...status })
    } catch (error) {
      next(error)
    }
  })

  // Job routes
  router.get('/jobs', authenticateToken, async (req: AuthenticatedRequest, res, next) => {
    try {
      assertInspector(req)
      const jobs = await inspectorService.listAvailableJobs()
      res.json({ success: true, data: jobs })
    } catch (error) {
      next(error)
    }
  })

  router.post('/jobs/:id/claim', authenticateToken, async (req: AuthenticatedRequest, res, next) => {
    try {
      assertInspector(req)
      const inspectorId = req.user!.id
      await bondService.assertBonded(inspectorId)
      const job = await inspectorService.claimJob(req.params.id, inspectorId)
      auditLog('INSPECTOR_JOB_CLAIMED' as any, extractAuditContext(req, 'user'), {
        jobId: job.id,
        listingId: job.listingId,
      })
      res.json({ success: true, data: job })
    } catch (error) {
      next(error)
    }
  })

  router.post('/jobs/:id/report', authenticateToken, async (req: AuthenticatedRequest, res, next) => {
    try {
      assertInspector(req)
      const { job, report } = await inspectorService.submitReport(
        req.params.id,
        req.user!.id,
        req.body,
      )
      auditLog('INSPECTOR_REPORT_SUBMITTED' as any, extractAuditContext(req, 'user'), {
        jobId: job.id,
        reportId: report.id,
        grade: report.overallGrade,
      })
      res.status(201).json({ success: true, data: { job, report } })
    } catch (error) {
      next(error)
    }
  })

  return router
}

// Admin-facing router — mounted at /api/admin/inspector
export function createAdminInspectorJobsRouter(): Router {
  const router = Router()

  router.get('/jobs', authenticateToken, requireAdmin({ mode: 'session' }), async (req: AuthenticatedRequest, res, next) => {
    try {
      const jobs = await inspectorService.listAllJobs()
      res.json({ success: true, data: jobs })
    } catch (error) {
      next(error)
    }
  })

  router.post('/jobs', authenticateToken, requireAdmin({ mode: 'session' }), async (req: AuthenticatedRequest, res, next) => {
    try {
      const { listingId, offeredFeeNgn } = req.body
      if (!listingId || !offeredFeeNgn) {
        throw new AppError(ErrorCode.VALIDATION_ERROR, 400, 'listingId and offeredFeeNgn are required')
      }
      const job = await inspectorService.createJob(listingId, offeredFeeNgn)
      auditLog('INSPECTOR_JOB_CREATED' as any, extractAuditContext(req, 'admin'), {
        jobId: job.id,
        listingId,
        offeredFeeNgn,
      })
      res.status(201).json({ success: true, data: job })
    } catch (error) {
      next(error)
    }
  })

  router.post('/jobs/:id/approve', authenticateToken, requireAdmin({ mode: 'session' }), async (req: AuthenticatedRequest, res, next) => {
    try {
      const job = await inspectorService.approveReport(req.params.id)
      auditLog('INSPECTOR_REPORT_APPROVED' as any, extractAuditContext(req, 'admin'), {
        jobId: job.id,
        listingId: job.listingId,
        inspectorId: job.inspectorId,
      })
      res.json({ success: true, data: job })
    } catch (error) {
      next(error)
    }
  })

  router.post('/jobs/:id/reject', authenticateToken, requireAdmin({ mode: 'session' }), async (req: AuthenticatedRequest, res, next) => {
    try {
      const { reason } = req.body
      if (!reason || typeof reason !== 'string' || reason.trim().length === 0) {
        throw new AppError(ErrorCode.VALIDATION_ERROR, 400, 'Rejection reason is required')
      }
      const job = await inspectorService.rejectReport(req.params.id, reason)
      auditLog('INSPECTOR_REPORT_REJECTED' as any, extractAuditContext(req, 'admin'), {
        jobId: job.id,
        reason,
      })
      res.json({ success: true, data: job })
    } catch (error) {
      next(error)
    }
  })

  return router
}
