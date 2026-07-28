import { type Response, type NextFunction } from 'express'
import { AppError } from '../errors/AppError.js'
import { ErrorCode } from '../errors/errorCodes.js'
import { env } from '../schemas/env.js'
import type { AuthenticatedRequest } from './auth.js'

/**
 * Fail-closed admin authorization middleware.
 *
 * Supports two authorization modes:
 * 1. Secret-header auth (for machine-to-machine calls): Requires x-admin-secret header
 * 2. Session-based auth (for human admins): Requires authenticated user with admin role
 *
 * This middleware ALWAYS rejects if:
 * - No credentials are provided
 * - Wrong credentials are provided
 * - The required configuration (MANUAL_ADMIN_SECRET) is unset (for secret-header mode)
 *
 * This is a fail-closed design: missing configuration is treated as a server misconfiguration,
 * not an authorization bypass.
 */

export type AdminAuthMode = 'secret' | 'session' | 'either'

interface RequireAdminOptions {
  /**
   * Authorization mode:
   * - 'secret': Only accept x-admin-secret header (for machine-to-machine)
   * - 'session': Only accept authenticated session with admin role (for human admins)
   * - 'either': Accept either secret header OR session auth (default)
   */
  mode?: AdminAuthMode
}

/**
 * Middleware that requires admin authorization.
 *
 * Usage:
 *   router.get('/admin/endpoint', requireAdmin(), handler)           // accepts either mode
 *   router.get('/admin/endpoint', requireAdmin({ mode: 'secret' }), handler)  // secret only
 *   router.get('/admin/endpoint', requireAdmin({ mode: 'session' }), handler)  // session only
 */
export function requireAdmin(options: RequireAdminOptions = {}) {
  const { mode = 'either' } = options

  return async (
    req: AuthenticatedRequest,
    _res: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      const headerSecret = req.headers['x-admin-secret']
      const hasSecret = typeof headerSecret === 'string' && headerSecret.length > 0
      const hasSession = !!req.user

      // Check secret-header auth
      if (mode === 'secret' || mode === 'either') {
        if (hasSecret) {
          // Fail-closed: MANUAL_ADMIN_SECRET must be set and must match
          if (!env.MANUAL_ADMIN_SECRET) {
            throw new AppError(
              ErrorCode.INTERNAL_ERROR,
              500,
              'Server misconfiguration: MANUAL_ADMIN_SECRET is not set. Secret-based admin auth is not available.',
            )
          }
          if (headerSecret !== env.MANUAL_ADMIN_SECRET) {
            throw new AppError(ErrorCode.FORBIDDEN, 403, 'Invalid admin secret')
          }
          // Secret auth successful
          return next()
        }
      }

      // Check session-based auth
      if (mode === 'session' || mode === 'either') {
        if (hasSession) {
          // Check if user has admin role
          const isAdminRole =
            req.user.role === 'admin' ||
            req.user.role === 'super_admin' ||
            (req.user as any).isAdmin === true

          if (!isAdminRole) {
            throw new AppError(ErrorCode.FORBIDDEN, 403, 'Admin role required')
          }
          // Session auth successful
          return next()
        }
      }

      // No valid auth provided
      if (mode === 'secret') {
        throw new AppError(ErrorCode.UNAUTHORIZED, 401, 'Admin secret header required')
      }
      if (mode === 'session') {
        throw new AppError(ErrorCode.UNAUTHORIZED, 401, 'Authentication required')
      }
      // mode === 'either'
      throw new AppError(
        ErrorCode.UNAUTHORIZED,
        401,
        'Authentication required: provide either a valid session or admin secret header',
      )
    } catch (error) {
      next(error)
    }
  }
}

/**
 * Convenience function for inline authorization checks (non-middleware usage).
 * Throws AppError if authorization fails.
 *
 * Usage in route handlers:
 *   async (req, res, next) => {
 *     assertAdminAuth(req)
 *     // ... handler logic
 *   }
 */
export function assertAdminAuth(
  req: AuthenticatedRequest,
  options: RequireAdminOptions = {},
): void {
  const middleware = requireAdmin(options)
  // Create a mock next function that throws on error
  const mockNext = (error: unknown) => {
    if (error instanceof Error) {
      throw error
    }
    throw new AppError(ErrorCode.INTERNAL_ERROR, 500, 'Authorization check failed')
  }
  void middleware(req, {} as Response, mockNext)
}
