import { type Response, type NextFunction } from 'express'
import { getPool } from '../db.js'
import { AppError } from '../errors/AppError.js'
import { ErrorCode } from '../errors/errorCodes.js'
import type { AuthenticatedRequest } from './auth.js'

export function requirePermission(resource: string, action: string) {
  return async (req: AuthenticatedRequest, _res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!req.user) {
        throw new AppError(ErrorCode.UNAUTHORIZED, 401, 'Authentication required')
      }

      // Check cache in request context first to avoid per-check queries
      if ((req as any).isSuperAdmin !== undefined) {
        if ((req as any).isSuperAdmin) {
          return next()
        }
        const requiredPermission = `${resource}:${action}`
        if ((req as any).permissions?.includes(requiredPermission)) {
          return next()
        }
        throw new AppError(ErrorCode.FORBIDDEN, 403, 'Forbidden')
      }

      const pool = await getPool()
      if (!pool) {
        // For tests without DB, check user.role from userStore
        if ((req.user as any).role === 'super_admin') {
          return next()
        }
        throw new AppError(ErrorCode.FORBIDDEN, 403, 'Forbidden')
      }

      const { rows } = await pool.query(
        `SELECT r.name AS role_name, p.resource, p.action
         FROM user_roles ur
         JOIN roles r ON ur.role_id = r.id
         LEFT JOIN role_permissions rp ON r.id = rp.role_id
         LEFT JOIN permissions p ON rp.permission_id = p.id
         WHERE ur.user_id = $1`,
        [req.user.id],
      )

      const isSuperAdmin = rows.some((row) => row.role_name === 'super_admin')
      const permissions = rows
        .filter((row) => row.resource && row.action)
        .map((row) => `${row.resource}:${row.action}`)

      // Cache effective permissions and super_admin status in request context
      ;(req as any).isSuperAdmin = isSuperAdmin
      ;(req as any).permissions = permissions

      // super_admin implicitly has all permissions
      if (isSuperAdmin) {
        return next()
      }

      // Fallback: If DB contains no RBAC roles for this user, check their legacy user.role
      if (rows.length === 0) {
        // No fallback - user must have explicit RBAC permissions
      }

      throw new AppError(ErrorCode.FORBIDDEN, 403, 'Forbidden')
    } catch (error) {
      next(error)
    }
  }
}
