/**
 * Tests for chain reconciliation (I6 invariants).
 *
 * Tests cover:
 * - I6.1: Seeded drift detection (ledger says N, chain says N-x)
 * - I6.3: In-flight settlements not flagged as mismatch
 * - I6.2: RPC outage escalates as unknown, never auto-resolves to matched
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { reconcileChainPositions } from './chain-reconciliation.js'
import { resetDrift, configureDrift } from './drift.js'
import type { SorobanAdapter, MoneyContractType, OnChainPosition } from '../soroban/adapter.js'
import type { LedgerEvent, ToleranceRule } from './types.js'
import { CircuitBreakerOpenError } from '../soroban/circuit-breaker-errors.js'
import * as store from './store.js'

// Mock store functions at module scope
vi.mock('./store.js', () => ({
  persistMismatch: vi.fn().mockResolvedValue({}),
  markLedgerEventStatus: vi.fn().mockResolvedValue({ id: 'mock-id' }),
  listPendingLedgerEvents: vi.fn().mockResolvedValue([]),
}))

// ── Helpers ───────────────────────────────────────────────────────────────────

const CHAIN_RULE: ToleranceRule = {
  rail: 'chain',
  toleranceMinor: 0n,
  maxDelaySeconds: 30,
  maxResolutionAttempts: 0,
}

function makeLedgerEvent(overrides: Partial<LedgerEvent> = {}): LedgerEvent {
  const now = new Date()
  return {
    id: `ledger-${Date.now()}`,
    eventType: 'credit',
    amountMinor: 1_000_000n, // 1 USDC
    currency: 'USDC',
    internalRef: 'ref-001',
    rail: 'chain',
    userId: 'user-001',
    status: 'pending',
    occurredAt: now,
    createdAt: now,
    ...overrides,
  }
}

function makeOnChainPosition(overrides: Partial<OnChainPosition> = {}): OnChainPosition {
  return {
    contractType: 'staking_pool',
    contractId: 'contract-001',
    account: 'user-001',
    balanceMinor: 1_000_000n,
    currency: 'USDC',
    timestamp: BigInt(Math.floor(Date.now() / 1000)),
    ...overrides,
  }
}

class MockSorobanAdapter implements SorobanAdapter {
  async getBalance(_account: string): Promise<bigint> {
    return 0n
  }
  async credit(_account: string, _amount: bigint): Promise<void> {
    throw new Error('Not implemented')
  }
  async debit(_account: string, _amount: bigint): Promise<void> {
    throw new Error('Not implemented')
  }
  async getStakedBalance(_account: string): Promise<bigint> {
    return 0n
  }
  async getClaimableRewards(_account: string): Promise<bigint> {
    return 0n
  }
  async recordReceipt(_params: any): Promise<void> {
    throw new Error('Not implemented')
  }
  getConfig() {
    return {
      rpcUrl: 'https://testnet.stellar.org',
      networkPassphrase: 'Test SDF Network',
    }
  }
  async getReceiptEvents(_fromLedger: number | null) {
    return []
  }
  async getTimelockEvents(_fromLedger: number | null) {
    return []
  }
  async executeTimelock(_txHash: string, _target: string, _functionName: string, _args: any[], _eta: number) {
    return 'stub-tx-hash'
  }
  async cancelTimelock(_txHash: string) {
    return 'stub-tx-hash'
  }
  async stakeBond(_inspectorId: string, _amount: bigint): Promise<void> {
    throw new Error('Not implemented')
  }
  async unstakeBond(_inspectorId: string): Promise<void> {
    throw new Error('Not implemented')
  }
  async isBonded(_inspectorId: string): Promise<boolean> {
    return false
  }
  async getBond(_inspectorId: string): Promise<{ isBonded: boolean; amount: bigint }> {
    return { isBonded: false, amount: 0n }
  }

  // Mock implementation for chain reconciliation
  private onChainPositions: Map<string, OnChainPosition> = new Map()
  private shouldThrowCircuitBreakerError = false

  setOnChainPosition(key: string, position: OnChainPosition) {
    this.onChainPositions.set(key, position)
  }

  setCircuitBreakerError(shouldThrow: boolean) {
    this.shouldThrowCircuitBreakerError = shouldThrow
  }

  async getOnChainPosition(contractType: MoneyContractType, account?: string): Promise<OnChainPosition> {
    if (this.shouldThrowCircuitBreakerError) {
      throw new CircuitBreakerOpenError(
        { state: 'open', consecutiveFailures: 5, lastFailureTime: Date.now() },
        'getOnChainPosition',
        'Circuit breaker is OPEN',
      )
    }

    const key = `${contractType}:${account || 'aggregate'}`
    return this.onChainPositions.get(key) || makeOnChainPosition({ contractType, account })
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  resetDrift()
  configureDrift({ windowMs: 3_600_000, capMinor: 100_000n })
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ── I6.1: Seeded drift detection ─────────────────────────────────────────────

describe('I6.1 seeded drift detection', () => {
  it('detects ledger-vs-chain drift and escalates as amount_mismatch', async () => {
    const adapter = new MockSorobanAdapter()
    const ledgerEvent = makeLedgerEvent({ amountMinor: 1_000_000n }) // Ledger says 1 USDC
    const onChainPos = makeOnChainPosition({ balanceMinor: 900_000n }) // Chain says 0.9 USDC

    adapter.setOnChainPosition('staking_pool:user-001', onChainPos)

    const persistSpy = vi.spyOn(store, 'persistMismatch')

    const result = await reconcileChainPositions(
      adapter,
      {
        contractTypes: ['staking_pool'],
        accounts: ['user-001'],
        chainRule: CHAIN_RULE,
      },
      [ledgerEvent],
    )

    // Should detect mismatch (zero tolerance means any delta escalates)
    expect(result.mismatches).toBe(1)
    expect(result.matched).toBe(0)
    expect(persistSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        mismatchClass: 'amount_mismatch',
        expectedAmountMinor: 1_000_000n,
        actualAmountMinor: 900_000n,
        toleranceMinor: 0n,
      }),
    )
  })

  it('matches when ledger and chain positions are equal', async () => {
    const adapter = new MockSorobanAdapter()
    const ledgerEvent = makeLedgerEvent({ amountMinor: 1_000_000n })
    const onChainPos = makeOnChainPosition({ balanceMinor: 1_000_000n })

    adapter.setOnChainPosition('staking_pool:user-001', onChainPos)

    const markSpy = vi.spyOn(store, 'markLedgerEventStatus')

    const result = await reconcileChainPositions(
      adapter,
      {
        contractTypes: ['staking_pool'],
        accounts: ['user-001'],
        chainRule: CHAIN_RULE,
      },
      [ledgerEvent],
    )

    expect(result.matched).toBe(1)
    expect(result.mismatches).toBe(0)
    expect(markSpy).toHaveBeenCalledWith(ledgerEvent.id, 'matched')
  })
})

// ── I6.3: In-flight settlements (finality respect) ─────────────────────────

describe('I6.3 in-flight settlements', () => {
  it('matches reconciliation for events within the delay window when amounts are equal', async () => {
    const adapter = new MockSorobanAdapter()
    const ledgerEvent = makeLedgerEvent({
      amountMinor: 1_000_000n,
      occurredAt: new Date(Date.now() - 10_000), // 10 seconds ago (within 30s window)
    })
    const onChainPos = makeOnChainPosition({ balanceMinor: 1_000_000n }) // Matching amount

    adapter.setOnChainPosition('staking_pool:user-001', onChainPos)

    const persistSpy = vi.spyOn(store, 'persistMismatch')

    const result = await reconcileChainPositions(
      adapter,
      {
        contractTypes: ['staking_pool'],
        accounts: ['user-001'],
        chainRule: CHAIN_RULE,
      },
      [ledgerEvent],
    )

    // Should match (not flag as mismatch) because amounts are equal
    expect(result.matched).toBe(1)
    expect(result.mismatches).toBe(0)
    expect(persistSpy).not.toHaveBeenCalled()
  })

  it('flags mismatch for events past the delay window', async () => {
    const adapter = new MockSorobanAdapter()
    const ledgerEvent = makeLedgerEvent({
      amountMinor: 1_000_000n,
      occurredAt: new Date(Date.now() - 40_000), // 40 seconds ago (past 30s window)
    })
    const onChainPos = makeOnChainPosition({ balanceMinor: 900_000n })

    adapter.setOnChainPosition('staking_pool:user-001', onChainPos)

    const persistSpy = vi.spyOn(store, 'persistMismatch')

    const result = await reconcileChainPositions(
      adapter,
      {
        contractTypes: ['staking_pool'],
        accounts: ['user-001'],
        chainRule: CHAIN_RULE,
      },
      [ledgerEvent],
    )

    // Should flag as mismatch past delay window
    expect(result.mismatches).toBe(1)
    expect(persistSpy).toHaveBeenCalled()
  })
})

// ── I6.2: RPC unavailability (circuit breaker) ──────────────────────────────

describe('I6.2 RPC unavailability', () => {
  it('escalates as unknown when circuit breaker is open', async () => {
    const adapter = new MockSorobanAdapter()
    adapter.setCircuitBreakerError(true)

    const ledgerEvent = makeLedgerEvent()

    const persistSpy = vi.spyOn(store, 'persistMismatch')

    const result = await reconcileChainPositions(
      adapter,
      {
        contractTypes: ['staking_pool'],
        accounts: ['user-001'],
        chainRule: CHAIN_RULE,
      },
      [ledgerEvent],
    )

    // Should escalate as unknown, not auto-resolve to matched
    expect(result.unknown).toBe(1)
    expect(result.matched).toBe(0)
    expect(result.mismatches).toBe(0)
    expect(persistSpy).not.toHaveBeenCalled()
  })

  it('never auto-resolves to matched during RPC outage', async () => {
    const adapter = new MockSorobanAdapter()
    adapter.setCircuitBreakerError(true)

    const ledgerEvent = makeLedgerEvent({ amountMinor: 1_000_000n })

    const markSpy = vi.spyOn(store, 'markLedgerEventStatus')

    const result = await reconcileChainPositions(
      adapter,
      {
        contractTypes: ['staking_pool'],
        accounts: ['user-001'],
        chainRule: CHAIN_RULE,
      },
      [ledgerEvent],
    )

    // Should NOT mark as matched during outage
    expect(result.unknown).toBe(1)
    expect(markSpy).not.toHaveBeenCalledWith(ledgerEvent.id, 'matched')
  })
})

// ── Multiple contract types ─────────────────────────────────────────────────

describe('multiple contract types', () => {
  it('reconciles against multiple money contracts', async () => {
    const adapter = new MockSorobanAdapter()
    const ledgerEvent = makeLedgerEvent({ amountMinor: 1_000_000n })

    // Set matching positions for both contracts
    adapter.setOnChainPosition('staking_pool:user-001', makeOnChainPosition({ balanceMinor: 1_000_000n, contractType: 'staking_pool' }))
    adapter.setOnChainPosition('bond_collateral:user-001', makeOnChainPosition({ balanceMinor: 1_000_000n, contractType: 'bond_collateral' }))

    const result = await reconcileChainPositions(
      adapter,
      {
        contractTypes: ['staking_pool', 'bond_collateral'],
        accounts: ['user-001'],
        chainRule: CHAIN_RULE,
      },
      [ledgerEvent],
    )

    // Should check both contracts
    expect(result.matched).toBe(2)
    expect(result.mismatches).toBe(0)
  })
})
