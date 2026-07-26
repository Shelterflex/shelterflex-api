import express from 'express'
import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { deprecatedMount } from './deprecatedMount.js'

describe('deprecatedMount', () => {
  it('sets Deprecation, Sunset, and Link headers and still serves the request', async () => {
    const app = express()
    app.use('/api/legacy', deprecatedMount(), (_req, res) => res.json({ ok: true }))

    const res = await request(app).get('/api/legacy').expect(200)

    expect(res.body).toEqual({ ok: true })
    expect(res.headers.deprecation).toBe('true')
    expect(res.headers.link).toBe('</api/v1>; rel="successor-version"')
    expect(res.headers.sunset).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})
