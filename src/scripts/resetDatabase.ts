/**
 * Entry point for `npm run db:reset`.
 *
 * Drops the public schema, re-applies every migration, then seeds the
 * development dataset — the "give me a clean, populated database" command.
 *
 * This is destructive, so it goes through the same guard as the seed: it never
 * runs with NODE_ENV=production, and any non-local host needs --allow-remote.
 *
 * Usage:
 *   npm run db:reset
 *   npm run db:reset -- --allow-remote
 */
import 'dotenv/config'
import { Pool } from 'pg'
import { assertSafeSeedTarget, hasAllowRemoteFlag, SeedGuardError } from '../seeds/guard.js'
import { runMigrationsIfNeeded } from '../migrations/runMigrations.js'
import { seedDevData } from '../seeds/devSeed.js'
import { SEED_USERS } from '../seeds/devData.js'

async function dropSchema(): Promise<void> {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  try {
    await pool.query('DROP SCHEMA IF EXISTS public CASCADE')
    await pool.query('CREATE SCHEMA public')
  } finally {
    await pool.end()
  }
}

async function seed(): Promise<void> {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await seedDevData(client, { log: (message) => console.log(message) })
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
    await pool.end()
  }
}

async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const target = assertSafeSeedTarget({
    allowRemote: hasAllowRemoteFlag(argv),
    scriptName: 'db:reset',
  })

  console.log(`[db:reset] Dropping and rebuilding ${target.describe}`)

  await dropSchema()
  console.log('[db:reset] Schema dropped.')

  await runMigrationsIfNeeded()
  console.log('[db:reset] Migrations applied.')

  await seed()
  console.log('[db:reset] Seed complete.')
  console.log('[db:reset] Sign in with any of:')
  for (const user of SEED_USERS) {
    console.log(`  ${user.role.padEnd(10)} ${user.email}`)
  }
}

main().catch((error: unknown) => {
  if (error instanceof SeedGuardError) {
    console.error(`\n[db:reset] ${error.message}\n`)
  } else {
    console.error('\n[db:reset] Failed:', error)
  }
  process.exit(1)
})
