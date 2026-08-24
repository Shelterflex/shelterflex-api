import helmet from "helmet"
import type { RequestHandler } from "express"
import { env as defaultEnv, type Env } from "../schemas/env.js"

/**
 * HTTP security response headers (issue #34).
 *
 * The API previously sent none: no HSTS, no nosniff, no frame policy, and
 * `X-Powered-By: Express` advertising the stack. This module wraps helmet with
 * an API-shaped configuration and keeps the environment-dependent parts
 * (mainly HSTS) in the env schema so local HTTP development is unaffected.
 *
 * Two mounts are exported because this app serves both JSON and HTML:
 *   - `createSecurityHeaders()` — the blanket policy for every response. It
 *     deliberately leaves Content-Security-Policy off: a CSP is meaningless
 *     for JSON payloads and helmet's default policy breaks the Swagger UI.
 *   - `createDocsSecurityHeaders()` — the CSP for the HTML docs routes only.
 */

/** HSTS is only meaningful over TLS, so it defaults to production-only. */
export function isHstsEnabled(env: Pick<Env, "SECURITY_HSTS_ENABLED" | "NODE_ENV">): boolean {
  return env.SECURITY_HSTS_ENABLED ?? env.NODE_ENV === "production"
}

/**
 * Blanket security headers for every response the API sends.
 *
 * Mount this ahead of every router (including the admin routers that sit above
 * the CORS block in `app.ts`) so no route can be served without them.
 */
export function createSecurityHeaders(env: Env = defaultEnv): RequestHandler {
  return helmet({
    // Set per-route on the HTML docs instead — see createDocsSecurityHeaders().
    contentSecurityPolicy: false,
    // The API is consumed cross-origin by the web app (origins are already
    // pinned by the CORS block), so the same-origin default would be wrong.
    crossOriginResourcePolicy: { policy: "cross-origin" },
    crossOriginEmbedderPolicy: false,
    frameguard: {
      action: env.SECURITY_FRAME_OPTIONS === "SAMEORIGIN" ? "sameorigin" : "deny",
    },
    referrerPolicy: { policy: env.SECURITY_REFERRER_POLICY },
    hsts: isHstsEnabled(env)
      ? {
          maxAge: env.SECURITY_HSTS_MAX_AGE,
          includeSubDomains: env.SECURITY_HSTS_INCLUDE_SUBDOMAINS,
          preload: env.SECURITY_HSTS_PRELOAD,
        }
      : false,
  })
}

/**
 * Content-Security-Policy for the Swagger UI / OpenAPI docs routes.
 *
 * swagger-ui-express serves its bootstrap script and styles inline, so
 * `'unsafe-inline'` is required for the UI to render at all. `upgrade-insecure-requests`
 * is left out so the docs still load over plain HTTP in local development.
 */
export function createDocsSecurityHeaders(): RequestHandler {
  return helmet.contentSecurityPolicy({
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      baseUri: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:"],
      fontSrc: ["'self'", "data:"],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      formAction: ["'self'"],
    },
  })
}
