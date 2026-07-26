import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { createApp } from './app.js'

/**
 * Issue #4: the tenant payments and tenant credit-score routers (and, per
 * the app.ts sweep, several others) were only mounted at unversioned /api/*
 * paths. The frontend's fetch helper unconditionally prepends /api/v1, so
 * every one of these was unreachable from a real client. These tests assert
 * each affected router is reachable at its /api/v1/* path -- they fail with
 * a 404 if a versioned mount is ever dropped again.
 *
 * Note: NODE_ENV is forced to 'test' for this whole suite (vitest.config.ts),
 * which bypasses the /api -> /api/v1 legacy redirect entirely (see
 * src/middleware/legacyApiRedirect.ts) so both the legacy and versioned
 * mounts are reached directly here, not via a redirect hop.
 */

const app = createApp()

describe('tenant payments router — versioned mount (issue #4)', () => {
  it('GET /api/v1/tenant/payments/disputes requires auth (401), not 404', async () => {
    const res = await request(app).get('/api/v1/tenant/payments/disputes')
    expect(res.status).toBe(401)
  })

  it('legacy GET /api/tenant/payments/disputes still works and is marked deprecated', async () => {
    const res = await request(app).get('/api/tenant/payments/disputes')
    expect(res.status).toBe(401)
    expect(res.headers.deprecation).toBe('true')
    expect(res.headers.link).toBe('</api/v1>; rel="successor-version"')
  })

  it('the versioned mount does not carry a deprecation header', async () => {
    const res = await request(app).get('/api/v1/tenant/payments/disputes')
    expect(res.headers.deprecation).toBeUndefined()
  })
})

describe('tenant credit-score router — versioned mount (issue #4)', () => {
  it('GET /api/v1/tenant/credit-score/my requires auth (401), not 404', async () => {
    const res = await request(app).get('/api/v1/tenant/credit-score/my')
    expect(res.status).toBe(401)
  })

  it('legacy GET /api/tenant/credit-score/my still works and is marked deprecated', async () => {
    const res = await request(app).get('/api/tenant/credit-score/my')
    expect(res.status).toBe(401)
    expect(res.headers.deprecation).toBe('true')
  })
})

describe('app.ts sweep — other routers found mounted only at unversioned paths (issue #4)', () => {
  const cases: Array<{ name: string; method: 'get' | 'post'; path: string }> = [
    { name: 'notifications', method: 'get', path: '/notifications/unread-count' },
    { name: 'admin roles', method: 'get', path: '/admin/roles' },
    { name: 'apartment reviews', method: 'get', path: '/apartment-reviews' },
    { name: 'compliance reports', method: 'post', path: '/compliance/reports/generate' },
    { name: 'kyc submission', method: 'post', path: '/kyc' },
    { name: 'abuse events', method: 'get', path: '/admin/abuse/events' },
    { name: 'tenant credit scoring', method: 'post', path: '/tenant/credit-scoring/score' },
    { name: 'tenant onboarding', method: 'post', path: '/tenant/onboarding/submit' },
    { name: 'tenant document vault', method: 'get', path: '/tenant/vault' },
    { name: 'tenant documents presign', method: 'post', path: '/documents/upload-url' },
    { name: 'listings root', method: 'get', path: '/listings' },
    { name: 'listing applications (mine)', method: 'get', path: '/applications/my' },
    { name: 'landlord payout schedule', method: 'get', path: '/landlord/payout-schedule' },
    { name: 'onboarding draft', method: 'post', path: '/onboarding/draft' },
    { name: 'admin quota usage', method: 'get', path: '/admin/quota/usage/test-user' },
    { name: 'background check', method: 'post', path: '/admin/tenants/test-tenant/background-check' },
    { name: 'credit bureau pull', method: 'post', path: '/admin/tenants/test-tenant/pull-credit-report' },
    { name: 'contract events', method: 'get', path: '/admin/contract-events' },
  ]

  // Test-only: the pre-existing test-compat mount `/api/landlord` (inside
  // the NODE_ENV==='test' block, with authenticateToken applied at the
  // mount site) short-circuits via next(err) before the narrower
  // `/api/landlord/payout-schedule` mount below it is ever reached, so no
  // deprecation header is observable here. Nothing equivalent exists in
  // production (no bare, unversioned `/api/landlord` prefix mount there),
  // so the endpoint itself is unaffected -- only this test-mode assertion is.
  const noDeprecationHeaderInTestMode = new Set(['landlord payout schedule'])

  for (const { name, method, path } of cases) {
    it(`${name}: reachable at /api/v1${path} (not 404)`, async () => {
      const res = await request(app)[method](`/api/v1${path}`)
      expect(res.status).not.toBe(404)
    })

    it(`${name}: legacy /api${path} still reachable and marked deprecated`, async () => {
      const res = await request(app)[method](`/api${path}`)
      expect(res.status).not.toBe(404)
      if (!noDeprecationHeaderInTestMode.has(name)) {
        expect(res.headers.deprecation).toBe('true')
      }
    })
  }
})
