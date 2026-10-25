/**
 * Envelope encryption for tenant vault documents.
 *
 * Each file is encrypted with its own random AES-256-GCM key (the DEK). The DEK
 * is itself encrypted ("wrapped") with the master key, so a copy of the bucket
 * is unreadable without the master key, which never lives in storage.
 *
 * Stored blob layout (all binary):
 *   "SFD1" | keyIdLen(1) | keyId | wrapIv(12) | wrapTag(16) | wrappedDek(32)
 *          | iv(12) | tag(16) | ciphertext
 *
 * The object key is bound in as additional authenticated data, so a blob copied
 * under another document's key fails to decrypt.
 *
 * Keys: DOCUMENT_ENCRYPTION_KEY is the current master key (base64, 32 bytes) and
 * DOCUMENT_ENCRYPTION_KEY_ID names it (default "k1"). To rotate, set a new key
 * and id, and list the old ones in DOCUMENT_ENCRYPTION_PREVIOUS_KEYS as
 * "id:base64,id:base64" so existing documents still open.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { logger } from '../utils/logger.js'

const MAGIC = Buffer.from('SFD1')
const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 12
const TAG_LENGTH = 16
const KEY_LENGTH = 32

interface KeyRing {
  currentId: string
  keys: Map<string, Buffer>
}

let cachedRing: KeyRing | null = null

function parseKey(id: string, base64: string): Buffer {
  const key = Buffer.from(base64, 'base64')
  if (key.length !== KEY_LENGTH) {
    throw new Error(`Document encryption key "${id}" must be ${KEY_LENGTH} bytes (base64)`)
  }
  return key
}

function loadKeyRing(): KeyRing {
  if (cachedRing) return cachedRing

  const currentId = process.env.DOCUMENT_ENCRYPTION_KEY_ID ?? 'k1'
  const keys = new Map<string, Buffer>()
  const current = process.env.DOCUMENT_ENCRYPTION_KEY

  if (current) {
    keys.set(currentId, parseKey(currentId, current))
  } else if (process.env.NODE_ENV === 'production') {
    throw new Error('DOCUMENT_ENCRYPTION_KEY is required in production')
  } else {
    logger.warn('DOCUMENT_ENCRYPTION_KEY is not set; using an insecure development key')
    keys.set(currentId, createHash('sha256').update('shelterflex-dev-document-key').digest())
  }

  for (const entry of (process.env.DOCUMENT_ENCRYPTION_PREVIOUS_KEYS ?? '').split(',')) {
    const [id, value] = entry.trim().split(':')
    if (id && value) keys.set(id, parseKey(id, value))
  }

  cachedRing = { currentId, keys }
  return cachedRing
}

/** Clears the cached keys; tests use it after changing the environment. */
export function resetDocumentKeyRing(): void {
  cachedRing = null
}

/** Encrypts a file; `aad` should be the object key the blob will be stored under. */
export function encryptDocument(plaintext: Buffer, aad: string): Buffer {
  const { currentId, keys } = loadKeyRing()
  const master = keys.get(currentId)!
  const aadBuffer = Buffer.from(aad)

  const dek = randomBytes(KEY_LENGTH)
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv(ALGORITHM, dek, iv)
  cipher.setAAD(aadBuffer)
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag()

  const wrapIv = randomBytes(IV_LENGTH)
  const wrapper = createCipheriv(ALGORITHM, master, wrapIv)
  wrapper.setAAD(aadBuffer)
  const wrappedDek = Buffer.concat([wrapper.update(dek), wrapper.final()])
  const wrapTag = wrapper.getAuthTag()

  const keyId = Buffer.from(currentId)
  return Buffer.concat([
    MAGIC,
    Buffer.from([keyId.length]),
    keyId,
    wrapIv,
    wrapTag,
    wrappedDek,
    iv,
    tag,
    ciphertext,
  ])
}

/** Decrypts a blob made by `encryptDocument`. Throws if it was altered or moved. */
export function decryptDocument(blob: Buffer, aad: string): Buffer {
  if (blob.length < MAGIC.length + 1 || !blob.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('Not an encrypted document')
  }

  let offset = MAGIC.length
  const keyIdLength = blob[offset]!
  offset += 1
  const keyId = blob.subarray(offset, offset + keyIdLength).toString()
  offset += keyIdLength
  const wrapIv = blob.subarray(offset, (offset += IV_LENGTH))
  const wrapTag = blob.subarray(offset, (offset += TAG_LENGTH))
  const wrappedDek = blob.subarray(offset, (offset += KEY_LENGTH))
  const iv = blob.subarray(offset, (offset += IV_LENGTH))
  const tag = blob.subarray(offset, (offset += TAG_LENGTH))
  const ciphertext = blob.subarray(offset)

  const master = loadKeyRing().keys.get(keyId)
  if (!master) throw new Error(`Unknown document encryption key "${keyId}"`)
  const aadBuffer = Buffer.from(aad)

  const unwrapper = createDecipheriv(ALGORITHM, master, wrapIv)
  unwrapper.setAAD(aadBuffer)
  unwrapper.setAuthTag(wrapTag)
  const dek = Buffer.concat([unwrapper.update(wrappedDek), unwrapper.final()])

  const decipher = createDecipheriv(ALGORITHM, dek, iv)
  decipher.setAAD(aadBuffer)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()])
}
