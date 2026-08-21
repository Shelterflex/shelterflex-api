/**
 * Global test setup run before every test file.
 *
 * Mocks @sentry/profiling-node so tests work on Node 21 where
 * the native cpu-profiler binary for Node 22 is absent.
 * This is a no-op on Node 22+ (CI) since the binary exists there.
 */
import { vi } from 'vitest'

vi.mock('@sentry/profiling-node', () => ({
  nodeProfilingIntegration: () => ({}),
}))
