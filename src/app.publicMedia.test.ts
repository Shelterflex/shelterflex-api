import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import request from 'supertest'
import { describe, expect, it, vi } from 'vitest'

// env is parsed when ./schemas/env.js is first imported, so the media
// directory must exist and be set before the app module loads.
const mediaDir = vi.hoisted(() => {
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs')
  const { tmpdir } = require('node:os') as typeof import('node:os')
  const { join } = require('node:path') as typeof import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'public-media-'))
  process.env.PUBLIC_MEDIA_DIR = dir
  return dir
})

const { createApp } = await import('./app.js')

mkdirSync(join(mediaDir, 'properties', '1'), { recursive: true })
writeFileSync(join(mediaDir, 'properties', '1', 'kitchen.jpg'), 'jpeg-bytes')
writeFileSync(join(mediaDir, '.secret'), 'nope')

// A sibling directory standing in for LOCAL_STORAGE_DIR's private documents.
const privateDir = mkdtempSync(join(tmpdir(), 'private-docs-'))
writeFileSync(join(privateDir, 'lease.pdf'), 'private')

const app = createApp()

describe('GET /media (public listing photos)', () => {
  it('serves a photo with long-lived caching', async () => {
    const res = await request(app).get('/media/properties/1/kitchen.jpg')
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toBe('image/jpeg')
    expect(res.headers['cache-control']).toBe('public, max-age=2592000')
  })

  it('returns 404, not 500, for a missing file', async () => {
    const res = await request(app).get('/media/properties/1/missing.jpg')
    expect(res.status).toBe(404)
  })

  it('does not serve dotfiles', async () => {
    const res = await request(app).get('/media/.secret')
    expect(res.status).toBe(404)
  })

  it('does not serve files outside the media directory', async () => {
    const escape = `/media/..%2F${privateDir.split('/').pop()}%2Flease.pdf`
    const res = await request(app).get(escape)
    expect(res.status).not.toBe(200)
    expect(res.text).not.toContain('private')
  })
})
