import type { Application, NextFunction, Request, Response } from 'express'

interface ExpressRoute {
  methods: Record<string, boolean>
  _handles_method?: (method: string) => boolean
}

interface ExpressLayer {
  route?: ExpressRoute
  handle?: { stack?: ExpressLayer[] }
  match(path: string): boolean
  path?: string
}

function routeHandlesMethod(route: ExpressRoute, method: string): boolean {
  if (typeof route._handles_method === 'function') {
    return route._handles_method(method)
  }
  const name = method.toLowerCase()
  return Boolean(route.methods[name] || route.methods.get)
}

function stackHandles(stack: ExpressLayer[], path: string, method: string): boolean {
  for (const layer of stack) {
    if (layer.route) {
      if (layer.match(path) && routeHandlesMethod(layer.route, method)) {
        return true
      }
      continue
    }

    if (layer.handle?.stack && layer.match(path)) {
      const remaining = path.slice(layer.path?.length ?? 0) || '/'
      if (stackHandles(layer.handle.stack, remaining, method)) {
        return true
      }
    }
  }
  return false
}

/**
 * True if `app` has a real route registered that would handle `path`/`method`.
 * Walks Express's own router stack instead of a hand-maintained list, so it
 * can't drift out of sync with what's actually mounted.
 */
export function isRouteMounted(app: Application, path: string, method: string): boolean {
  const stack = (app as unknown as { _router?: { stack: ExpressLayer[] } })._router?.stack
  return Array.isArray(stack) ? stackHandles(stack, path, method) : false
}

export interface LegacyApiRedirectOptions {
  /** Skip redirecting entirely (used in test mode, where routes are also mounted at /api/*). */
  bypass: boolean
}

/**
 * Backward-compat redirect from /api/* to /api/v1/*.
 * Only redirects when the rewritten /api/v1 path is genuinely mounted;
 * anything else falls through to the normal 404 handler instead of bouncing
 * the client through a redirect that dead-ends (see issue #5).
 */
export function createLegacyApiRedirect(app: Application, options: LegacyApiRedirectOptions) {
  return (req: Request, res: Response, next: NextFunction) => {
    // Skip if already on /api/v1 path
    if (req.path.startsWith('/v1')) {
      return next()
    }

    if (options.bypass) {
      return next()
    }

    const newPath = `/api/v1${req.path}`

    if (!isRouteMounted(app, newPath, req.method)) {
      return next()
    }

    res.setHeader('Deprecation', 'true')
    const sunsetDate = new Date()
    sunsetDate.setMonth(sunsetDate.getMonth() + 6)
    res.setHeader('Sunset', sunsetDate.toISOString().split('T')[0])
    res.setHeader('Link', '</api/v1>; rel="successor-version"')
    res.redirect(307, newPath)
  }
}
