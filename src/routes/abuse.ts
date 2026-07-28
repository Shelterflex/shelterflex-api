import { Router, type Request, type Response, type NextFunction } from 'express'
import { authenticateToken, type AuthenticatedRequest } from '../middleware/auth.js'
import { requireAdmin } from '../middleware/requireAdmin.js'
import { AppError } from '../errors/AppError.js'
import { ErrorCode } from '../errors/errorCodes.js'
import { abuseEventStore } from '../services/abuseDetectionService.js'

export function createAbuseRouter(): Router {
  const router = Router()


  /**
   * GET /api/admin/abuse/events
   * Paginated list of abuse events
   */
  router.get(
    '/events',
    authenticateToken,
    requireAdmin({ mode: 'session' }),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        
        const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10) || 1)
        const pageSize = Math.min(100, Math.max(1, parseInt(String(req.query.pageSize ?? '20'), 10) || 20))

        const { data, total } = abuseEventStore.getPaginated(page, pageSize)

        res.status(200).json({
          success: true,
          events: data.map((e) => ({
            id: e.id,
            target: e.target,
            type: e.type,
            timestamp: e.timestamp.toISOString(),
            expiresAt: e.expiresAt.toISOString(),
          })),
          pagination: {
            total,
            page,
            pageSize,
            totalPages: Math.ceil(total / pageSize),
          },
        })
      } catch (error) {
        next(error)
      }
    }
  )

  return router
}
