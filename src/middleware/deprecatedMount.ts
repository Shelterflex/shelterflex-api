import type { NextFunction, Request, Response } from 'express'

/**
 * Marks a route that is still served at an unversioned /api/* path (kept
 * temporarily for backward compatibility alongside its /api/v1/* mount) as
 * deprecated, using the same headers as the /api -> /api/v1 redirect --
 * without redirecting, since the router at this path still serves the
 * request directly.
 */
export function deprecatedMount() {
  return (_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Deprecation', 'true')
    const sunsetDate = new Date()
    sunsetDate.setMonth(sunsetDate.getMonth() + 6)
    res.setHeader('Sunset', sunsetDate.toISOString().split('T')[0])
    res.setHeader('Link', '</api/v1>; rel="successor-version"')
    next()
  }
}
