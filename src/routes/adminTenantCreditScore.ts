/**
 * GET /api/admin/tenants/:tenantId/credit-score — latest pipeline score breakdown (admin-only).
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import { authenticateToken, type AuthenticatedRequest } from '../middleware/auth.js'
import { requireAdmin } from '../middleware/requireAdmin.js'
import { tenantCreditScoringService } from '../services/tenantCreditScoringService.js'
import { AppError } from '../errors/AppError.js'
import { ErrorCode } from '../errors/errorCodes.js'


export function createAdminTenantCreditScoreRouter(): Router {
  const router = Router()

  router.get(
    '/tenants/:tenantId/credit-score',
    authenticateToken,
    requireAdmin({ mode: 'session' }),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { tenantId } = req.params
        if (!tenantId) {
          throw new AppError(ErrorCode.VALIDATION_ERROR, 400, 'tenantId is required')
        }

        const record = tenantCreditScoringService.getPipelineScore(tenantId)
        if (!record) {
          throw new AppError(ErrorCode.NOT_FOUND, 404, 'Credit score not found for tenant')
        }

        res.json({
          tenantId: record.tenantId,
          score: record.score,
          band: record.band,
          incomeScore: record.incomeScore,
          employmentScore: record.employmentScore,
          bankStatementScore: record.bankStatementScore,
          alternativeDataScore: record.alternativeDataScore,
          computedAt: record.computedAt.toISOString(),
          version: record.version,
          dataVersion: record.dataVersion,
        })
      } catch (error) {
        next(error)
      }
    },
  )

  return router
}
