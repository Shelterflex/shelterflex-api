import { Router, type Request, type Response, type NextFunction } from 'express'
import { validate } from '../middleware/validate.js'
import { authenticateToken, type AuthenticatedRequest } from '../middleware/auth.js'
import { requireAdmin } from '../middleware/requireAdmin.js'
import { AppError } from '../errors/AppError.js'
import { ErrorCode } from '../errors/errorCodes.js'
import {
  createReportSchema,
  updateReportStatusSchema,
  listReportsQuerySchema,
} from '../schemas/whistleblowerReport.js'
import { whistleblowerReportService } from '../services/whistleblowerReportService.js'
import { whistleblowerRepository } from '../repositories/WhistleblowerRepository.js'

const RATE_LIMIT_MAX = 5
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000

interface RateLimitEntry {
  count: number
  resetAt: number
}

const ipRateLimit = new Map<string, RateLimitEntry>()

function checkIpRateLimit(ip: string): void {
  const now = Date.now()
  const entry = ipRateLimit.get(ip)

  if (!entry || now > entry.resetAt) {
    ipRateLimit.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS })
    return
  }

  if (entry.count >= RATE_LIMIT_MAX) {
    throw new AppError(
      ErrorCode.TOO_MANY_REQUESTS,
      429,
      'Too many reports submitted from this IP. Try again later.',
    )
  }

  entry.count++
}

export function createWhistleblowerReportsRouter(): Router {
  const router = Router()

  router.post(
    '/',
    validate(createReportSchema, 'body'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const ip = req.ip ?? 'unknown'
        checkIpRateLimit(ip)

        const { referenceCode } = await whistleblowerReportService.submitReport(
          req.body,
          ip,
        )

        res.status(201).json({
          success: true,
          referenceCode,
          message: 'Report submitted',
        })
      } catch (error) {
        next(error)
      }
    },
  )

  router.get(
    '/admin/reports',
    authenticateToken,
    requireAdmin({ mode: 'session' }),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {

        const parseResult = listReportsQuerySchema.safeParse(req.query)
        if (!parseResult.success) {
          throw new AppError(ErrorCode.VALIDATION_ERROR, 400, 'Invalid query parameters')
        }

        const { type, status, page, pageSize } = parseResult.data
        const result = await whistleblowerReportService.listReports({
          type,
          status,
          page,
          pageSize,
        })

        res.json({
          success: true,
          reports: result.reports.map((r) => ({
            id: r.id,
            referenceCode: r.referenceCode,
            reportType: r.reportType,
            description: r.description,
            evidenceUrl: r.evidenceUrl,
            status: r.status,
            adminNote: r.adminNote,
            createdAt: r.createdAt.toISOString(),
            updatedAt: r.updatedAt.toISOString(),
          })),
          pagination: {
            total: result.total,
            page,
            pageSize,
            totalPages: Math.ceil(result.total / pageSize),
          },
        })
      } catch (error) {
        next(error)
      }
    },
  )

  router.patch(
    '/admin/reports/:id/status',
    authenticateToken,
    validate(updateReportStatusSchema, 'body'),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        if (req.user?.role !== 'admin') {
          throw new AppError(ErrorCode.FORBIDDEN, 403, 'Admin access required')
        }

        const { id } = req.params
        const { status, note } = req.body as { status: string; note: string }
        const adminId = req.user.id

        const existing = await whistleblowerRepository.getReportById(id)
        if (!existing) {
          throw new AppError(ErrorCode.NOT_FOUND, 404, `Report with id '${id}' not found`)
        }

        const updated = await whistleblowerReportService.updateStatus(id, status, note, adminId)

        res.json({
          success: true,
          report: {
            id: updated.id,
            referenceCode: updated.referenceCode,
            reportType: updated.reportType,
            description: updated.description,
            evidenceUrl: updated.evidenceUrl,
            status: updated.status,
            adminNote: updated.adminNote,
            createdAt: updated.createdAt.toISOString(),
            updatedAt: updated.updatedAt.toISOString(),
          },
        })
      } catch (error) {
        next(error)
      }
    },
  )

  return router
}
