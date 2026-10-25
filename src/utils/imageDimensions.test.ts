import { describe, it, expect } from 'vitest'
import { getImageSize } from './imageDimensions.js'

function png(width: number, height: number): Buffer {
  const b = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b)
  b.writeUInt32BE(13, 8)
  b.write('IHDR', 12, 'ascii')
  b.writeUInt32BE(width, 16)
  b.writeUInt32BE(height, 20)
  return b
}

function jpeg(width: number, height: number): Buffer {
  // SOI, an APP0 segment to skip, then SOF0 carrying the size.
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, ...Array(14).fill(0)])
  const sof = Buffer.alloc(19)
  sof[0] = 0xff
  sof[1] = 0xc0
  sof.writeUInt16BE(17, 2)
  sof[4] = 8
  sof.writeUInt16BE(height, 5)
  sof.writeUInt16BE(width, 7)
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof])
}

function webpLossy(width: number, height: number): Buffer {
  const b = Buffer.alloc(32)
  b.write('RIFF', 0, 'ascii')
  b.write('WEBP', 8, 'ascii')
  b.write('VP8 ', 12, 'ascii')
  b.writeUInt16LE(width, 26)
  b.writeUInt16LE(height, 28)
  return b
}

describe('getImageSize', () => {
  it('reads PNG, JPEG and WebP sizes', () => {
    expect(getImageSize(png(1920, 1080))).toEqual({ width: 1920, height: 1080 })
    expect(getImageSize(jpeg(4032, 3024))).toEqual({ width: 4032, height: 3024 })
    expect(getImageSize(webpLossy(1600, 1200))).toEqual({ width: 1600, height: 1200 })
  })

  it('returns null for anything else or a truncated file', () => {
    expect(getImageSize(Buffer.from('not an image at all, just text'))).toBeNull()
    expect(getImageSize(Buffer.from([0xff, 0xd8, 0xff]))).toBeNull()
  })
})
