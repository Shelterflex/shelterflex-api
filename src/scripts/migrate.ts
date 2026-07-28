/**
 * Entry point for `npm run db:migrate`.
 *
 * Applies any migrations in migrations/ that have not been recorded in
 * schema_migrations. This is the same runner the server executes on startup,
 * exposed as a standalone command so a database can be prepared without booting
 * the app (and so `npm run db:reset` has something to call).
 */
import 'dotenv/config'
import { runMigrationsIfNeeded } from '../migrations/runMigrations.js'

if (!process.env.DATABASE_URL) {
  console.error(
    '[db:migrate] DATABASE_URL is not set. Copy .env.example to .env and point ' +
      'DATABASE_URL at your local Postgres instance.',
  )
  process.exit(1)
}

runMigrationsIfNeeded()
  .then(() => {
    console.log('[db:migrate] Migrations up to date.')
  })
  .catch((error: unknown) => {
    console.error('[db:migrate] Failed:', error)
    process.exit(1)
  })
