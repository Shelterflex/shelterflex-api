/**
 * Safety guard for destructive database scripts (db:seed, db:reset).
 *
 * The seed is run by contributors who are unfamiliar with the codebase, so the
 * rules are deliberately blunt:
 *
 *   1. NODE_ENV=production is refused outright — no flag overrides it.
 *   2. Any host that is not obviously local requires an explicit confirmation
 *      flag (`--allow-remote` / SEED_ALLOW_REMOTE=true).
 *   3. A missing DATABASE_URL is an error, never a silent no-op.
 */

/** Hostnames that are treated as a developer's own machine. */
const LOCAL_HOSTNAMES = new Set([
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '::1',
  'host.docker.internal',
])

export class SeedGuardError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SeedGuardError'
  }
}

export interface SeedTarget {
  /** Hostname from DATABASE_URL ('' for a unix-socket connection). */
  host: string
  /** Database name from DATABASE_URL. */
  database: string
  /** Whether the host is a local (developer machine) target. */
  isLocal: boolean
  /** Host:port/database, safe to print — never contains credentials. */
  describe: string
}

export interface GuardOptions {
  databaseUrl?: string
  nodeEnv?: string
  /** Set by `--allow-remote` or SEED_ALLOW_REMOTE=true. */
  allowRemote?: boolean
  /** Name of the calling script, used in error messages. */
  scriptName?: string
}

function toUrl(databaseUrl: string): URL {
  try {
    return new URL(databaseUrl)
  } catch {
    // A unix-socket connection string keeps its credentials but has no host —
    // `postgres://user:pass@/db?host=/var/run/postgresql` — which the WHATWG
    // parser rejects. Drop the userinfo (which the guard ignores anyway) and
    // try again.
    try {
      return new URL(databaseUrl.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, '$1'))
    } catch {
      throw new SeedGuardError('DATABASE_URL is not a valid connection string.')
    }
  }
}

/**
 * Parses a Postgres connection string into the parts the guard cares about.
 * Never returns credentials.
 */
export function parseTarget(databaseUrl: string): SeedTarget {
  const url = toUrl(databaseUrl)

  // `postgres://user:pass@/db?host=/var/run/postgresql` — a unix socket, which
  // can only ever be the local machine.
  const socketHost = url.searchParams.get('host')
  const rawHost = url.hostname || (socketHost ?? '')
  const host = rawHost.replace(/^\[|\]$/g, '')

  const database = decodeURIComponent(url.pathname.replace(/^\//, ''))
  const isLocal =
    host === '' ||
    host.startsWith('/') ||
    LOCAL_HOSTNAMES.has(host.toLowerCase()) ||
    /^127\.\d+\.\d+\.\d+$/.test(host)

  const port = url.port ? `:${url.port}` : ''
  const describe = `${host || '(unix socket)'}${port}/${database || '(no database)'}`

  return { host, database, isLocal, describe }
}

/**
 * Throws unless it is safe to write seed data to the configured database.
 * Returns a credential-free description of the target on success.
 */
export function assertSafeSeedTarget(options: GuardOptions = {}): SeedTarget {
  const {
    databaseUrl = process.env.DATABASE_URL,
    nodeEnv = process.env.NODE_ENV,
    allowRemote = false,
    scriptName = 'db:seed',
  } = options

  if (nodeEnv === 'production') {
    throw new SeedGuardError(
      `Refusing to run ${scriptName} with NODE_ENV=production. ` +
        'This script is for development databases only and has no override for production.',
    )
  }

  if (!databaseUrl) {
    throw new SeedGuardError(
      'DATABASE_URL is not set. Copy .env.example to .env and point DATABASE_URL ' +
        'at your local Postgres instance before running ' +
        `${scriptName}.`,
    )
  }

  const target = parseTarget(databaseUrl)

  if (!target.database) {
    throw new SeedGuardError('DATABASE_URL does not name a database.')
  }

  if (!target.isLocal && !allowRemote) {
    throw new SeedGuardError(
      `Refusing to run ${scriptName} against the non-local host "${target.host}". ` +
        'If you are certain this is a throwaway database, re-run with ' +
        `\`npm run ${scriptName} -- --allow-remote\` (or SEED_ALLOW_REMOTE=true).`,
    )
  }

  return target
}

/** True when the confirmation flag was passed on argv or via the environment. */
export function hasAllowRemoteFlag(
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return argv.includes('--allow-remote') || env.SEED_ALLOW_REMOTE === 'true'
}
