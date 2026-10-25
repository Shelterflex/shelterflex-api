/**
 * Reads an image's pixel size from its header, without decoding it.
 * Supports the formats listing photos may be stored as: JPEG, PNG and WebP.
 */

export interface ImageSize {
  width: number
  height: number
}

function jpegSize(b: Buffer): ImageSize | null {
  let offset = 2
  while (offset + 9 < b.length) {
    if (b[offset] !== 0xff) {
      offset += 1
      continue
    }
    const marker = b[offset + 1]!
    // Start-of-frame markers carry the size (all except DHT, JPG and DAC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: b.readUInt16BE(offset + 5), width: b.readUInt16BE(offset + 7) }
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2
      continue
    }
    offset += 2 + b.readUInt16BE(offset + 2)
  }
  return null
}

function pngSize(b: Buffer): ImageSize | null {
  if (b.length < 24) return null
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) }
}

function webpSize(b: Buffer): ImageSize | null {
  if (b.length < 30) return null
  const format = b.subarray(12, 16).toString('ascii')
  if (format === 'VP8 ') {
    return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff }
  }
  if (format === 'VP8L') {
    const bits = b.readUInt32LE(21)
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
  }
  if (format === 'VP8X') {
    return { width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1 }
  }
  return null
}

export function getImageSize(buffer: Buffer): ImageSize | null {
  try {
    if (buffer[0] === 0xff && buffer[1] === 0xd8) return jpegSize(buffer)
    if (buffer.subarray(1, 4).toString('ascii') === 'PNG') return pngSize(buffer)
    if (buffer.subarray(0, 4).toString('ascii') === 'RIFF') return webpSize(buffer)
  } catch {
    // A truncated or malformed header is treated as unreadable.
  }
  return null
}
