import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Regression guard for issue #2: route modules that exist under src/routes/
 * but are never wired into the running app (either never imported into
 * app.ts, or imported and then left dangling with no app.use(...) call).
 *
 * Every module here must be either:
 *   - mounted in app.ts (including behind requireFlag(...)), or
 *   - listed in UNMOUNTED_ALLOWLIST below with a one-line reason.
 *
 * Keep the allowlist empty if at all possible — an entry here is a decision
 * that a maintainer should be able to see and challenge without re-reading
 * the route file itself.
 */
const UNMOUNTED_ALLOWLIST: Record<string, string> = {}

const routesDir = dirname(fileURLToPath(import.meta.url))
const appTsPath = join(routesDir, '..', 'app.ts')

function getRouteModuleNames(): string[] {
  return readdirSync(routesDir)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => f.replace(/\.ts$/, ''))
    .sort()
}

/**
 * A module counts as "referenced" only if app.ts both imports it AND uses
 * at least one of the imported identifiers somewhere outside the import
 * line itself (i.e. actually passed to app.use, not just imported and
 * forgotten — the exact bug class this guard exists to catch).
 */
export function isRouteModuleReferenced(appTsSource: string, moduleName: string): boolean {
  const lines = appTsSource.split('\n')
  const specifierPattern = new RegExp(`from\\s+["']\\./routes/${moduleName}\\.js["']`)
  const importLine = lines.find((line) => specifierPattern.test(line))
  if (!importLine) return false

  const identifiers: string[] = []
  const namedMatch = importLine.match(/import\s+\{([^}]+)\}/)
  if (namedMatch) {
    identifiers.push(
      ...namedMatch[1]
        .split(',')
        .map((s) => s.trim().split(/\s+as\s+/).pop()!.trim())
        .filter(Boolean),
    )
  }
  const defaultMatch = importLine.match(/import\s+(\w+)\s*,?/)
  if (defaultMatch && !namedMatch) {
    identifiers.push(defaultMatch[1])
  }

  if (identifiers.length === 0) return false

  const sourceWithoutImportLine = appTsSource.replace(importLine, '')
  return identifiers.some((id) => new RegExp(`\\b${id}\\b`).test(sourceWithoutImportLine))
}

describe('route module mounting (regression guard for issue #2)', () => {
  it('every route module is mounted in app.ts or on the documented allowlist', () => {
    const appTsSource = readFileSync(appTsPath, 'utf-8')

    const unaccounted = getRouteModuleNames().filter((name) => {
      if (name in UNMOUNTED_ALLOWLIST) return false
      return !isRouteModuleReferenced(appTsSource, name)
    })

    expect(
      unaccounted,
      `Found route module(s) with no app.use(...) wiring and no allowlist entry: ${unaccounted.join(', ')}. ` +
        `Either mount them in app.ts (optionally behind requireFlag), delete the file if abandoned, ` +
        `or add a reasoned entry to UNMOUNTED_ALLOWLIST in this test.`,
    ).toEqual([])
  })

  it('flags a route module that is never imported (proves the guard actually catches the bug)', () => {
    const appTsSource = readFileSync(appTsPath, 'utf-8')

    // 'quote' is mounted by this PR — a positive control proving the checker
    // recognizes a real, wired-up module rather than always failing closed.
    expect(isRouteModuleReferenced(appTsSource, 'quote')).toBe(true)

    // A module that doesn't exist in app.ts at all — simulates exactly the
    // defect class from issue #2: a new route file dropped into src/routes/
    // with no corresponding app.use(...) call.
    expect(isRouteModuleReferenced(appTsSource, 'totallyNewUnmountedRoute')).toBe(false)
  })

  it('flags a route module that is imported but never used (the other half of issue #2)', () => {
    const fixture = `
import { createFooRouter } from "./routes/foo.js";
import { createBarRouter } from "./routes/bar.js";

export function createApp() {
  app.use('/api/v1/bar', createBarRouter())
}
`
    // foo is imported but its factory is never invoked/mounted — unreachable.
    expect(isRouteModuleReferenced(fixture, 'foo')).toBe(false)
    // bar is imported and mounted — reachable.
    expect(isRouteModuleReferenced(fixture, 'bar')).toBe(true)
  })
})
