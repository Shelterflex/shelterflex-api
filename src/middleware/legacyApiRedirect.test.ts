import express from 'express'
import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { createLegacyApiRedirect } from './legacyApiRedirect.js'

function buildApp(bypass: boolean) {
  const app = express()

  // A directly-mounted v1 route.
  app.get('/api/v1/known', (_req, res) => res.json({ ok: true }))

  // A v1 route reached through a bare sub-router mount, mirroring how most
  // routers in app.ts are mounted (e.g. app.use('/api/v1', someRouter)).
  const subRouter = express.Router()
  subRouter.get('/nested/thing', (_req, res) => res.json({ nested: true }))
  app.use('/api/v1', subRouter)

  app.use('/api', createLegacyApiRedirect(app, { bypass }))

  app.use((_req, res) => {
    res.status(404).json({ error: 'not found' })
  })

  return app
}

describe('createLegacyApiRedirect', () => {
  it('redirects a legacy path that is genuinely mounted under /api/v1', async () => {
    const app = buildApp(false)

    const res = await request(app).get('/api/known').redirects(0)

    expect(res.status).toBe(307)
    expect(res.headers.location).toBe('/api/v1/known')
    expect(res.headers.deprecation).toBe('true')
  })

  it('redirects a legacy path mounted via a bare sub-router', async () => {
    const app = buildApp(false)

    const res = await request(app).get('/api/nested/thing').redirects(0)

    expect(res.status).toBe(307)
    expect(res.headers.location).toBe('/api/v1/nested/thing')
  })

  it('returns a direct 404 for a legacy path with no /api/v1 counterpart, without redirecting', async () => {
    const app = buildApp(false)

    const res = await request(app).get('/api/nonsense').redirects(0)

    expect(res.status).toBe(404)
    expect(res.headers.location).toBeUndefined()
  })

  it('leaves /api/v1/* requests untouched', async () => {
    const app = buildApp(false)

    const res = await request(app).get('/api/v1/known').expect(200)

    expect(res.body).toEqual({ ok: true })
  })

  it('bypasses redirecting entirely when bypass is true', async () => {
    const app = buildApp(true)

    const res = await request(app).get('/api/known').redirects(0)

    expect(res.status).toBe(404)
    expect(res.headers.location).toBeUndefined()
  })
})
