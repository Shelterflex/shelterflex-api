/**
 * scripts/verify-migrations.ts
 *
 * Creates a throwaway Postgres database, runs every migration in migrations/
 * from a completely empty state, reports the first failure with the offending
 * filename, then drops the database whether the run succeeded or failed.
 *
 * Usage:
 *   npm run db:verify
 *
 * Environment (all optional – defaults match a typical local dev setup):
 *   PGHOST      Postgres host           (default: localhost)
 *   PGPORT      Postgres port           (default: 5432)
 *   PGUSER      Postgres superuser      (default: current OS user)
 *   PGPASSWORD  Password for that user
 *   PGDATABASE  Admin database to connect to initially (default: postgres)
 *
 * The script never touches any existing database.  The throwaway database is
 * named  shelterflex_migration_verify_<timestamp>  and is always dropped at
 * the end, even when a migration fails.
 *
 * Exit codes:
 *   0   All migrations applied successfully
 *   1   One or more migrations failed (offending file printed to stderr)
 */

import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from 'pg'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MIGRATIONS_DIR = path.resolve(__dirname, '..', 'migrations')

const PGHOST     = process.env.PGHOST     ?? 'localhost'
const PGPORT     = parseInt(process.env.PGPORT ?? '5432', 10)
const PGUSER     = process.env.PGUSER     ?? process.env.USER ?? 'postgres'
const PGPASSWORD = process.env.PGPASSWORD ?? ''
const PGDATABASE = process.env.PGDATABASE ?? 'postgres'

const DB_NAME = `shelterflex_migration_verify_${Date.now()}`

function adminClient(): Client {
  return new Client({
    host: PGHOST,
    port: PGPORT,
    user: PGUSER,
    password: PGPASSWORD,
    database: PGDATABASE,
  })
}

function verifyClient(): Client {
  return new Client({
    host: PGHOST,
    port: PGPORT,
    user: PGUSER,
    password: PGPASSWORD,
    database: DB_NAME,
  })
}

// Same SQL splitter used by runMigrations.ts — keeps dollar-quoted bodies,
// quoted strings, and line comments intact so semicolons inside them are not
// treated as statement boundaries.
function splitSqlStatements(sql: string): string[] {
  const statements: string[] = []
  let current = ''
  let i = 0
  let dollarTag: string | null = null

  while (i < sql.length) {
    const rest = sql.slice(i)

    if (dollarTag) {
      const closeIdx = rest.indexOf(dollarTag)
      if (closeIdx === -1) {
        current += rest
        i = sql.length
      } else {
        current += rest.slice(0, closeIdx + dollarTag.length)
        i += closeIdx + dollarTag.length
        dollarTag = null
      }
      continue
    }

    const dollarMatch = /^\$[A-Za-z_]*\$/.exec(rest)
    if (dollarMatch) {
      dollarTag = dollarMatch[0]
      current += dollarTag
      i += dollarTag.length
      continue
    }

    const ch = sql[i]

    if (ch === '-' && sql[i + 1] === '-') {
      const nlIdx = sql.indexOf('\n', i)
      const end = nlIdx === -1 ? sql.length : nlIdx + 1
      current += sql.slice(i, end)
      i = end
      continue
    }

    if (ch === "'" || ch === '"') {
      const quote = ch
      let j = i + 1
      while (j < sql.length) {
        if (sql[j] === quote) {
          if (sql[j + 1] === quote) { j += 2; continue }
          j += 1
          break
        }
        j += 1
      }
      current += sql.slice(i, j)
      i = j
      continue
    }

    if (ch === ';') {
      current += ch
      const trimmed = current.trim()
      if (trimmed) statements.push(trimmed)
      current = ''
      i += 1
      continue
    }

    current += ch
    i += 1
  }

  const trimmed = current.trim()
  if (trimmed) statements.push(trimmed)

  return statements
}

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

async function createDatabase(): Promise<void> {
  const client = adminClient()
  await client.connect()
  try {
    // Must be outside a transaction block
    await client.query(`CREATE DATABASE "${DB_NAME}"`)
    console.log(`[verify] Created throwaway database: ${DB_NAME}`)
  } finally {
    await client.end()
  }
}

async function dropDatabase(): Promise<void> {
  const client = adminClient()
  await client.connect()
  try {
    // Terminate any lingering connections first so DROP DATABASE doesn't block
    await client.query(`
      SELECT pg_terminate_backend(pid)
      FROM   pg_stat_activity
      WHERE  datname = $1 AND pid <> pg_backend_pid()
    `, [DB_NAME])
    await client.query(`DROP DATABASE IF EXISTS "${DB_NAME}"`)
    console.log(`[verify] Dropped throwaway database: ${DB_NAME}`)
  } finally {
    await client.end()
  }
}

async function runAllMigrations(): Promise<void> {
  const files = (await readdir(MIGRATIONS_DIR))
    .filter(f => f.endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b))

  console.log(`[verify] Found ${files.length} migration file(s) to apply.`)

  const client = verifyClient()
  await client.connect()

  try {
    for (const file of files) {
      const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8')
      const isConcurrent = /CONCURRENTLY/i.test(sql)

      try {
        if (isConcurrent) {
          // CONCURRENTLY cannot run inside a transaction block
          for (const statement of splitSqlStatements(sql)) {
            await client.query(statement)
          }
        } else {
          await client.query('BEGIN')
          await client.query(sql)
          await client.query('COMMIT')
        }
        console.log(`[verify]   ✓ ${file}`)
      } catch (err) {
        if (!isConcurrent) {
          // Best-effort rollback – ignore secondary errors
          await client.query('ROLLBACK').catch(() => {})
        }
        const message = err instanceof Error ? err.message : String(err)
        console.error(`\n[verify] ✗ FAILED: ${file}`)
        console.error(`[verify]   ${message}\n`)
        throw Object.assign(new Error(`Migration failed: ${file}\n${message}`), { file })
      }
    }
  } finally {
    await client.end()
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  let success = false

  try {
    await createDatabase()
    await runAllMigrations()
    success = true
    console.log('\n[verify] ✅  All migrations applied successfully on a clean database.\n')
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`\n[verify] ❌  Migration verification failed.\n[verify]    ${message}\n`)
  } finally {
    await dropDatabase()
  }

  process.exit(success ? 0 : 1)
}

main()
