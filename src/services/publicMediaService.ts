import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { env } from '../schemas/env.js'
import { AppError } from '../errors/AppError.js'
import { ErrorCode } from '../errors/errorCodes.js'
import { uploadFile } from './storageService.js'

/**
 * Stores images that anyone may view — listing photos, whistleblower report
 * photos, inspection photos — and returns a URL a browser can load.
 *
 * With PUBLIC_MEDIA_DIR and PUBLIC_MEDIA_BASE_URL set, files are written under
 * the directory served at /media. Otherwise they go to the configured storage
 * provider (S3 in production setups, a local path in development).
 */

const IMAGE_SIGNATURES: { type: string; ext: string; matches: (b: Buffer) => boolean }[] = [
  { type: 'image/jpeg', ext: 'jpg', matches: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  {
    type: 'image/png',
    ext: 'png',
    matches: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  },
  {
    type: 'image/webp',
    ext: 'webp',
    matches: (b) => b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP',
  },
]

/**
 * Identifies the image type from the file's bytes rather than the client's
 * claimed Content-Type, so a file can never be stored (and later served) as
 * anything other than an image.
 */
export function detectImageType(buffer: Buffer): { type: string; ext: string } | null {
  const match = IMAGE_SIGNATURES.find((sig) => buffer.length >= 12 && sig.matches(buffer))
  return match ? { type: match.type, ext: match.ext } : null
}

/** Stores one image under `folder` (e.g. "listings") and returns its public URL. */
export async function storePublicImage(buffer: Buffer, folder: string): Promise<string> {
  const image = detectImageType(buffer)
  if (!image) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, 400, 'Only JPEG, PNG or WebP images are allowed')
  }

  const relativePath = `uploads/${folder}/${randomUUID()}.${image.ext}`

  if (env.PUBLIC_MEDIA_DIR && env.PUBLIC_MEDIA_BASE_URL) {
    const filePath = join(env.PUBLIC_MEDIA_DIR, relativePath)
    await mkdir(join(filePath, '..'), { recursive: true })
    await writeFile(filePath, buffer)
    return `${env.PUBLIC_MEDIA_BASE_URL.replace(/\/$/, '')}/${relativePath}`
  }

  const { url } = await uploadFile(relativePath, buffer, image.type)
  return url
}
