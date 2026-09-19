/**
 * Tests for ReconciliationWorker concurrency safety.
 * 
 * Tests cover:
 * - Intra-process overlap guard (slow pass skips next tick)
 * - Advisory lock (other instances no-op when lock held)
 * - Leader takeover after holder stops
 * - Concurrent passes not double-absorbing drift past cap
 * - Concurrent passes not double-escalating mismatch
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { ReconciliationWorker } from './worker.js'
import { tryAcquireLeaderLock, releaseLeaderLock } from './store.js'
import { resetDrift, configureDrift, tryAbsorbDrift } from './drift.js'
import { persistMismatch } from './store.js'
import type { ToleranceRule } from './types.js'

// Mock store functions
vi.mock('./store.js', () => ({
  tryAcquireLeaderLock: vi.fn().mockResolvedValue(true),
  releaseLeaderLock: vi.fn().mockResolvedValue(true),
  listPendingLedgerEvents: vi.fn().mockResolvedValue([]),
  persistMismatch: vi.fn().mockResolvedValue({}),
  markLedgerEventStatus: vi.fn().mockResolvedValue(),
}))

// Mock engine functions
vi.mock('./engine.js', () => ({
  runReconciliationPass: vi.fn().mockResolvedValue({ matched: 0, mismatches: 0, skipped: 0 }),
}))

// Mock resolver functions
vi.mock('./resolver.js', () => ({
  runResolutionPass: vi.fn().mockResolvedValue({ resolved: 0, escalated: 0 }),
}))

// Mock chain reconciliation
vi.mock('./chain-reconciliation.js', () => ({
  reconcileChainPositions: vi.fn().mockResolvedValue({ matched: 0, mismatches: 0, skipped: 0, unknown: 0 }),
}))

// Mock metrics
vi.mock('../metrics.js', () => ({
  recordReconciliationPending: vi.fn(),
  recordReconciliationProcessed: vi.fn(),
  recordReconciliationProcessingDuration: vi.fn(),
  recordToleranceAbsorbed: vi.fn(),
  recordDriftCapBreach: vi.fn(),
}))

// Mock Soroban adapter
vi.mock('../soroban/index.js', () => ({
  createSorobanAdapter: vi.fn().mockReturnValue({
    getOnChainPosition: vi.fn().mockResolvedValue({ balanceMinor: 0n, contractType: 'staking_pool', contractId: 'test', account: 'test' }),
  }),
}))

vi.mock('../soroban/client.js', () => ({
  getSorobanConfigFromEnv: vi.fn().mockReturnValue({}),
}))

import * as store from './store.js'
import * as engine from './engine.js'
import * as resolver from './resolver.js'

// Disable chain reconciliation for tests
const originalEnv = process.env.RECON_CHAIN_ENABLED

beforeEach(() => {
  process.env.RECON_CHAIN_ENABLED = 'false'
  vi.clearAllMocks()
  resetDrift()
  configureDrift({ windowMs: 3_600_000, capMinor: 100_000n })
  // Reset mocks to default state
  vi.mocked(store.tryAcquireLeaderLock).mockResolvedValue(true)
  vi.mocked(store.releaseLeaderLock).mockResolvedValue(true)
  vi.mocked(engine.runReconciliationPass).mockResolvedValue({ matched: 0, mismatches: 0, skipped: 0 })
  vi.mocked(resolver.runResolutionPass).mockResolvedValue({ resolved: 0, escalated: 0 })
})

afterEach(() => {
  process.env.RECON_CHAIN_ENABLED = originalEnv
  vi.restoreAllMocks()
})

// ── Intra-process overlap guard ─────────────────────────────────────────────

describe('intra-process overlap guard', () => {
  it('skips tick if previous pass is still running', async () => {
    const worker = new ReconciliationWorker()
    
    // Mock a slow pass that takes longer than interval
    let resolvePass: () => void
    const slowPass = new Promise<void>(resolve => {
      resolvePass = resolve
    })
    vi.mocked(engine.runReconciliationPass).mockReturnValue(slowPass as any)
    vi.mocked(resolver.runResolutionPass).mockReturnValue(Promise.resolve({ resolved: 0, escalated: 0 }))
    
    // Start worker with short interval
    worker.start(50)
    
    // Wait for first tick to start
    await new Promise(resolve => setTimeout(resolve, 60))
    
    // First tick should have started
    expect(engine.runReconciliationPass).toHaveBeenCalledTimes(1)
    
    // Wait for second tick (should be skipped due to guard)
    await new Promise(resolve => setTimeout(resolve, 60))
    
    // Should still be 1 (second tick was skipped)
    expect(engine.runReconciliationPass).toHaveBeenCalledTimes(1)
    
    // Complete the slow pass
    resolvePass!()
    await slowPass
    
    await worker.stop()
  })
})

// ── Advisory lock (cluster-wide leader election) ───────────────────────────

describe('advisory lock', () => {
  it('skips pass when lock is held by another instance', async () => {
    // Mock lock acquisition failure (another instance holds lock)
    vi.mocked(store.tryAcquireLeaderLock).mockResolvedValue(false)
    
    const worker = new ReconciliationWorker()
    await worker.poll()
    
    // Should not run reconciliation pass
    expect(engine.runReconciliationPass).not.toHaveBeenCalled()
    expect(resolver.runResolutionPass).not.toHaveBeenCalled()
  })

  it('runs pass when lock is acquired', async () => {
    // Mock lock acquisition success
    vi.mocked(store.tryAcquireLeaderLock).mockResolvedValue(true)
    
    const worker = new ReconciliationWorker()
    await worker.poll()
    
    // Should run reconciliation pass
    expect(engine.runReconciliationPass).toHaveBeenCalledTimes(1)
    expect(resolver.runResolutionPass).toHaveBeenCalledTimes(1)
    expect(store.releaseLeaderLock).toHaveBeenCalledTimes(1)
  })

  it('releases lock even if pass fails', async () => {
    vi.mocked(store.tryAcquireLeaderLock).mockResolvedValue(true)
    vi.mocked(engine.runReconciliationPass).mockRejectedValue(new Error('DB error'))
    
    const worker = new ReconciliationWorker()
    await worker.poll()
    
    // Should still release lock despite error
    expect(store.releaseLeaderLock).toHaveBeenCalledTimes(1)
  })
})

// ── Leader takeover ─────────────────────────────────────────────────────────

describe('leader takeover', () => {
  it('another instance can acquire lock after holder releases', async () => {
    // First instance acquires lock
    vi.mocked(store.tryAcquireLeaderLock).mockResolvedValueOnce(true)
    
    const worker1 = new ReconciliationWorker()
    await worker1.poll()
    
    expect(store.releaseLeaderLock).toHaveBeenCalledTimes(1)
    
    // Second instance can now acquire lock
    vi.mocked(store.tryAcquireLeaderLock).mockResolvedValueOnce(true)
    
    const worker2 = new ReconciliationWorker()
    await worker2.poll()
    
    expect(engine.runReconciliationPass).toHaveBeenCalledTimes(2) // Both instances ran
  })
})

// ── Drift cap under concurrency ───────────────────────────────────────────────

describe('drift cap under concurrency', () => {
  it('concurrent passes cannot absorb drift past cap', async () => {
    const rule: ToleranceRule = { rail: 'paystack', toleranceMinor: 100n, maxDelaySeconds: 3600, maxResolutionAttempts: 3 }
    
    // Configure drift with small cap
    configureDrift({ windowMs: 60_000, capMinor: 200n })
    
    // Simulate two concurrent passes trying to absorb drift
    const pass1 = tryAbsorbDrift('paystack', 'NGN', 150n, rule)
    const pass2 = tryAbsorbDrift('paystack', 'NGN', 150n, rule)
    
    const [result1, result2] = await Promise.all([pass1, pass2])
    
    // At most one should succeed (total absorbed <= 200n cap)
    const totalAbsorbed = (result1 ? 150n : 0n) + (result2 ? 150n : 0n)
    expect(totalAbsorbed).toBeLessThanOrEqual(200n)
  })
})

// ── Mismatch escalation under concurrency ───────────────────────────────────

describe('mismatch escalation under concurrency', () => {
  it('concurrent passes do not double-escalate a single mismatch', async () => {
    // The advisory lock ensures only one instance runs at a time
    // So concurrent passes cannot both escalate the same mismatch
    vi.mocked(store.tryAcquireLeaderLock).mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    
    const worker1 = new ReconciliationWorker()
    const worker2 = new ReconciliationWorker()
    
    // Both try to run passes
    const pass1 = worker1.poll()
    const pass2 = worker2.poll()
    
    await Promise.all([pass1, pass2])
    
    // Only one pass should have run (the one that acquired the lock)
    expect(engine.runReconciliationPass).toHaveBeenCalledTimes(1)
  })
})
