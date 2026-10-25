import { existsSync } from 'node:fs'
import { join } from 'node:path'
import request from 'supertest'
import { describe, expect, it, vi } from 'vitest'

// env is parsed on first import, so configure the public media store first.
const mediaDir = vi.hoisted(() => {
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs')
  const { tmpdir } = require('node:os') as typeof import('node:os')
  const { join } = require('node:path') as typeof import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'media-upload-'))
  process.env.PUBLIC_MEDIA_DIR = dir
  process.env.PUBLIC_MEDIA_BASE_URL = 'https://api.example.com/media'
  return dir
})

const { createApp } = await import('../app.js')
const { sessionStore, userStore } = await import('../models/authStore.js')

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16)])
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)])

async function signIn(email: string) {
  const user = await userStore.getOrCreateByEmail(email)
  const token = `token-${email.replace(/[^a-z0-9]/gi, '-')}`
  await sessionStore.create(email, token)
  return { userId: user.id, token }
}

function pngOfSize(width: number, height: number): Buffer {
  const b = Buffer.alloc(33)
  PNG.subarray(0, 8).copy(b)
  b.writeUInt32BE(13, 8)
  b.write('IHDR', 12, 'ascii')
  b.writeUInt32BE(width, 16)
  b.writeUInt32BE(height, 20)
  return b
}

const app = createApp()

describe('POST /api/v1/media/photos with purpose=listing', () => {
  it('rejects photos below the minimum resolution', async () => {
    const { token } = await signIn('lowres@example.com')
    const res = await request(app)
      .post('/api/v1/media/photos')
      .set('Authorization', `Bearer ${token}`)
      .field('purpose', 'listing')
      .attach('photos', pngOfSize(640, 480), { filename: 'blurry.png', contentType: 'image/png' })
      .expect(422)
    expect(JSON.stringify(res.body)).toContain('blurry.png')
    expect(JSON.stringify(res.body)).toContain('640×480')
  })

  it('accepts sharp photos, in either orientation', async () => {
    const { token } = await signIn('hires@example.com')
    await request(app)
      .post('/api/v1/media/photos')
      .set('Authorization', `Bearer ${token}`)
      .field('purpose', 'listing')
      .attach('photos', pngOfSize(4032, 3024), { filename: 'a.png', contentType: 'image/png' })
      .attach('photos', pngOfSize(3024, 4032), { filename: 'b.png', contentType: 'image/png' })
      .expect(201)
  })
})

describe('POST /api/v1/media/photos', () => {
  it('stores images under the uploader and returns their public URLs', async () => {
    const { userId, token } = await signIn('uploader@example.com')

    const res = await request(app)
      .post('/api/v1/media/photos')
      .set('Authorization', `Bearer ${token}`)
      .attach('photos', JPEG, { filename: 'a.jpg', contentType: 'image/jpeg' })
      .attach('photos', PNG, { filename: 'b.png', contentType: 'image/png' })
      .expect(201)

    expect(res.body.urls).toHaveLength(2)
    const prefix = `https://api.example.com/media/uploads/photos/${userId}/`
    expect(res.body.urls[0]).toMatch(new RegExp(`^${prefix}[0-9a-f-]+\\.jpg$`))
    expect(res.body.urls[1]).toMatch(/\.png$/)

    const relative = res.body.urls[0].replace('https://api.example.com/media/', '')
    expect(existsSync(join(mediaDir, relative))).toBe(true)
  })

  it('requires a signed-in user', async () => {
    await request(app)
      .post('/api/v1/media/photos')
      .attach('photos', JPEG, { filename: 'a.jpg', contentType: 'image/jpeg' })
      .expect(401)
  })

  it('rejects files that are not images, whatever they claim to be', async () => {
    const { token } = await signIn('sneaky@example.com')

    const res = await request(app)
      .post('/api/v1/media/photos')
      .set('Authorization', `Bearer ${token}`)
      .attach('photos', Buffer.from('<html><script>alert(1)</script></html>'), {
        filename: 'evil.jpg',
        contentType: 'image/jpeg',
      })
      .expect(400)

    expect(res.body.error.code).toBe('VALIDATION_ERROR')
  })

  it('rejects a request with no photos', async () => {
    const { token } = await signIn('empty@example.com')
    await request(app).post('/api/v1/media/photos').set('Authorization', `Bearer ${token}`).expect(400)
  })
})
