import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import { describe, expect, it } from 'vitest'
import { envSchema } from './env.js'

/**
 * Guards against .env.example drifting out of sync with envSchema (issue #7):
 * a new required variable, or a placeholder that no longer satisfies its
 * schema constraint, should fail this test rather than surface only when a
 * new contributor tries to boot the API.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ENV_EXAMPLE_PATH = path.join(__dirname, '../../.env.example')

function loadEnvExample(): Record<string, string> {
  const raw = readFileSync(ENV_EXAMPLE_PATH, 'utf-8')
  return dotenv.parse(raw)
}

describe('.env.example', () => {
  it('satisfies the same envSchema used to validate startup configuration', () => {
    const parsed = loadEnvExample()

    // Validated in isolation (not merged with the test runner's process.env)
    // so this fails exactly when .env.example itself is insufficient to boot.
    const result = envSchema.safeParse(parsed)

    if (!result.success) {
      const details = result.error.issues
        .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
        .join('\n')
      throw new Error(`.env.example fails startup validation:\n${details}`)
    }

    expect(result.success).toBe(true)
  })

  it('ships obviously-fake placeholders for required secrets, not plausible real values', () => {
    const parsed = loadEnvExample()

    expect(parsed.ENCRYPTION_KEY).toBeTruthy()
    expect(parsed.ENCRYPTION_KEY.length).toBeGreaterThanOrEqual(32)
    expect(parsed.ENCRYPTION_KEY.toLowerCase()).toContain('replace')

    expect(parsed.WEBHOOK_KEY).toBeTruthy()
    expect(parsed.WEBHOOK_KEY.toLowerCase()).toContain('replace')
  })

  it('defaults to the local storage provider, which needs no external credentials', () => {
    const parsed = loadEnvExample()

    expect(parsed.STORAGE_PROVIDER).toBe('local')
  })
})
