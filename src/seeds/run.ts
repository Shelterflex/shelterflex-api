/**
 * Entry point for `npm run db:seed`.
 *
 * Loads the development dataset into the database named by DATABASE_URL inside
 * a single transaction, after checking that the target is safe to write to.
 *
 * Usage:
 *   npm run db:seed
 *   npm run db:seed -- --allow-remote          # confirm a non-local target
 *   npm run db:seed -- --simulate-failure      # prove the rollback works
 */
import 'dotenv/config'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Pool } from 'pg'
import { assertSafeSeedTarget, hasAllowRemoteFlag, SeedGuardError } from './guard.js'
import {
  SEED_STAGES,
  seedDevData,
  type SeedStage,
  type SeedSummary,
} from './devSeed.js'
import { SEED_USERS } from './devData.js'

function parseSimulateFailure(argv: string[]): SeedStage | undefined {
  const arg = argv.find((value) => value.startsWith('--simulate-failure'))
  if (!arg) return undefined

  const [, value] = arg.split('=')
  if (!value) return 'listings'

  if (!(SEED_STAGES as readonly string[]).includes(value)) {
    throw new SeedGuardError(
      `Unknown --simulate-failure stage "${value}". Valid stages: ${SEED_STAGES.join(', ')}.`,
    )
  }
  return value as SeedStage
}

function printSummary(summary: SeedSummary): void {
  const total = Object.values(summary).reduce((sum, count) => sum + count, 0)
  console.log(`\n[db:seed] ${total} rows written across ${Object.keys(summary).length} tables:`)
  for (const [table, count] of Object.entries(summary)) {
    console.log(`  ${table.padEnd(24)} ${count}`)
  }

  console.log('\n[db:seed] Seeded accounts (sign in with the email, the OTP is printed by the server):')
  for (const user of SEED_USERS) {
    console.log(`  ${user.role.padEnd(10)} ${user.email.padEnd(24)} ${user.name}`)
  }
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const simulateFailureAfter = parseSimulateFailure(argv)
  const target = assertSafeSeedTarget({
    allowRemote: hasAllowRemoteFlag(argv),
    scriptName: 'db:seed',
  })

  console.log(`[db:seed] Target: ${target.describe}`)
  if (!target.isLocal) {
    console.log('[db:seed] Non-local target confirmed with --allow-remote.')
  }
  if (simulateFailureAfter) {
    console.log(
      `[db:seed] --simulate-failure: will abort after the "${simulateFailureAfter}" stage.`,
    )
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  const client = await pool.connect()

  try {
    await client.query('BEGIN')
    const summary = await seedDevData(client, {
      simulateFailureAfter,
      log: (message) => console.log(message),
    })
    await client.query('COMMIT')
    printSummary(summary)
    console.log('\n[db:seed] Done.')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    if ((error as { code?: string }).code === '42P01') {
      throw new Error(
        'A table the seed needs does not exist. Run `npm run db:migrate` (or start the ' +
          `server once) before seeding. Underlying error: ${(error as Error).message}`,
      )
    }
    throw error
  } finally {
    client.release()
    await pool.end()
  }
}

const entryPoint = process.argv[1] ? realpathSync(process.argv[1]) : undefined

if (entryPoint === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    if (error instanceof SeedGuardError) {
      console.error(`\n[db:seed] ${error.message}\n`)
    } else {
      console.error('\n[db:seed] Failed — the transaction was rolled back.')
      console.error(error)
    }
    process.exit(1)
  })
}
