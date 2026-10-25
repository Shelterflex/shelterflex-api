import { describe, it, expect, afterEach } from 'vitest'
import { randomBytes } from 'node:crypto'
import { encryptDocument, decryptDocument, resetDocumentKeyRing } from './documentCrypto.js'

const KEY_A = randomBytes(32).toString('base64')
const KEY_B = randomBytes(32).toString('base64')

afterEach(() => {
  delete process.env.DOCUMENT_ENCRYPTION_KEY
  delete process.env.DOCUMENT_ENCRYPTION_KEY_ID
  delete process.env.DOCUMENT_ENCRYPTION_PREVIOUS_KEYS
  resetDocumentKeyRing()
})

describe('documentCrypto', () => {
  it('round-trips a document', () => {
    process.env.DOCUMENT_ENCRYPTION_KEY = KEY_A
    const plain = Buffer.from('passport scan bytes')
    const blob = encryptDocument(plain, 'tenant-documents/u1/id_card/a.pdf')
    expect(blob.includes(plain)).toBe(false)
    expect(decryptDocument(blob, 'tenant-documents/u1/id_card/a.pdf')).toEqual(plain)
  })

  it('refuses a blob moved to another object key', () => {
    process.env.DOCUMENT_ENCRYPTION_KEY = KEY_A
    const blob = encryptDocument(Buffer.from('x'), 'key-1')
    expect(() => decryptDocument(blob, 'key-2')).toThrow()
  })

  it('detects tampering', () => {
    process.env.DOCUMENT_ENCRYPTION_KEY = KEY_A
    const blob = encryptDocument(Buffer.from('hello world'), 'k')
    blob[blob.length - 1] ^= 0xff
    expect(() => decryptDocument(blob, 'k')).toThrow()
  })

  it('cannot be read with a different master key', () => {
    process.env.DOCUMENT_ENCRYPTION_KEY = KEY_A
    const blob = encryptDocument(Buffer.from('secret'), 'k')
    process.env.DOCUMENT_ENCRYPTION_KEY = KEY_B
    resetDocumentKeyRing()
    expect(() => decryptDocument(blob, 'k')).toThrow()
  })

  it('still opens old documents after the master key is rotated', () => {
    process.env.DOCUMENT_ENCRYPTION_KEY = KEY_A
    process.env.DOCUMENT_ENCRYPTION_KEY_ID = 'k1'
    const blob = encryptDocument(Buffer.from('old doc'), 'k')

    process.env.DOCUMENT_ENCRYPTION_KEY = KEY_B
    process.env.DOCUMENT_ENCRYPTION_KEY_ID = 'k2'
    process.env.DOCUMENT_ENCRYPTION_PREVIOUS_KEYS = `k1:${KEY_A}`
    resetDocumentKeyRing()
    expect(decryptDocument(blob, 'k').toString()).toBe('old doc')
  })

  it('requires a key in production', () => {
    const env = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    resetDocumentKeyRing()
    expect(() => encryptDocument(Buffer.from('x'), 'k')).toThrow(/DOCUMENT_ENCRYPTION_KEY/)
    process.env.NODE_ENV = env
  })
})
