import { describe, it, expect } from "vitest"
import express from "express"
import request from "supertest"
import { createSecurityHeaders, createDocsSecurityHeaders, isHstsEnabled } from "./securityHeaders.js"
import { env } from "../schemas/env.js"
import type { Env } from "../schemas/env.js"
import { createTestAgent } from "../test-helpers.js"

function envWith(overrides: Partial<Env>): Env {
  return { ...env, ...overrides } as Env
}

function buildApp(overrides: Partial<Env> = {}) {
  const app = express()
  app.use(createSecurityHeaders(envWith(overrides)))
  app.get("/ping", (_req, res) => {
    res.status(200).json({ ok: true })
  })
  return app
}

describe("createSecurityHeaders", () => {
  it("sets nosniff, a frame policy and a referrer policy on API responses", async () => {
    const res = await request(buildApp()).get("/ping").expect(200)

    expect(res.headers["x-content-type-options"]).toBe("nosniff")
    expect(res.headers["x-frame-options"]).toBe("DENY")
    expect(res.headers["referrer-policy"]).toBe("no-referrer")
  })

  it("strips the X-Powered-By fingerprint", async () => {
    const res = await request(buildApp()).get("/ping").expect(200)

    expect(res.headers["x-powered-by"]).toBeUndefined()
  })

  it("leaves Content-Security-Policy off for JSON responses", async () => {
    const res = await request(buildApp()).get("/ping").expect(200)

    expect(res.headers["content-security-policy"]).toBeUndefined()
  })

  it("honours the configured frame and referrer policies", async () => {
    const res = await request(
      buildApp({ SECURITY_FRAME_OPTIONS: "SAMEORIGIN", SECURITY_REFERRER_POLICY: "strict-origin-when-cross-origin" }),
    )
      .get("/ping")
      .expect(200)

    expect(res.headers["x-frame-options"]).toBe("SAMEORIGIN")
    expect(res.headers["referrer-policy"]).toBe("strict-origin-when-cross-origin")
  })

  it("allows cross-origin consumption of API responses", async () => {
    const res = await request(buildApp()).get("/ping").expect(200)

    expect(res.headers["cross-origin-resource-policy"]).toBe("cross-origin")
  })

  describe("HSTS", () => {
    it("is off by default outside production, so local HTTP development is unaffected", async () => {
      const res = await request(buildApp({ NODE_ENV: "development", SECURITY_HSTS_ENABLED: undefined }))
        .get("/ping")
        .expect(200)

      expect(res.headers["strict-transport-security"]).toBeUndefined()
    })

    it("is sent in production with the configured max-age", async () => {
      const res = await request(
        buildApp({
          NODE_ENV: "production",
          SECURITY_HSTS_ENABLED: undefined,
          SECURITY_HSTS_MAX_AGE: 31_536_000,
          SECURITY_HSTS_INCLUDE_SUBDOMAINS: true,
          SECURITY_HSTS_PRELOAD: false,
        }),
      )
        .get("/ping")
        .expect(200)

      expect(res.headers["strict-transport-security"]).toBe("max-age=31536000; includeSubDomains")
    })

    it("can be forced on or off regardless of NODE_ENV", async () => {
      const forcedOn = await request(buildApp({ NODE_ENV: "development", SECURITY_HSTS_ENABLED: true }))
        .get("/ping")
        .expect(200)
      expect(forcedOn.headers["strict-transport-security"]).toContain("max-age=")

      const forcedOff = await request(buildApp({ NODE_ENV: "production", SECURITY_HSTS_ENABLED: false }))
        .get("/ping")
        .expect(200)
      expect(forcedOff.headers["strict-transport-security"]).toBeUndefined()

      expect(isHstsEnabled({ NODE_ENV: "development", SECURITY_HSTS_ENABLED: true })).toBe(true)
      expect(isHstsEnabled({ NODE_ENV: "production", SECURITY_HSTS_ENABLED: false })).toBe(false)
      expect(isHstsEnabled({ NODE_ENV: "production", SECURITY_HSTS_ENABLED: undefined })).toBe(true)
    })
  })
})

describe("createDocsSecurityHeaders", () => {
  it("scopes a Swagger-compatible CSP to the docs routes", async () => {
    const app = express()
    app.use("/docs", createDocsSecurityHeaders())
    app.get("/docs", (_req, res) => {
      res.status(200).send("<html></html>")
    })

    const res = await request(app).get("/docs").expect(200)
    const csp = res.headers["content-security-policy"]

    expect(csp).toContain("frame-ancestors 'none'")
    // swagger-ui-express serves its bootstrap inline; without this the UI is blank.
    expect(csp).toContain("script-src 'self' 'unsafe-inline'")
    // Would break the docs over plain HTTP in local development.
    expect(csp).not.toContain("upgrade-insecure-requests")
  })
})

describe("app security headers", () => {
  it("are present on a normal API response and X-Powered-By is gone", async () => {
    const res = await createTestAgent().get("/health")

    expect(res.headers["x-content-type-options"]).toBe("nosniff")
    expect(res.headers["x-frame-options"]).toBe("DENY")
    expect(res.headers["referrer-policy"]).toBe("no-referrer")
    expect(res.headers["x-powered-by"]).toBeUndefined()
  })

  it("still renders the OpenAPI docs, with the docs CSP applied", async () => {
    const res = await createTestAgent().get("/docs/").expect(200)

    expect(res.headers["content-security-policy"]).toContain("script-src 'self' 'unsafe-inline'")
    expect(res.text).toContain("swagger-ui")
  })
})
