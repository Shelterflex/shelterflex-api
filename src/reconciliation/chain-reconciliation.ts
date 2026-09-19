/**
 * On-chain reconciliation module.
 * 
 * Extends the reconciliation engine to cover on-chain state by reading positions
 * from money contracts (deal_escrow, staking_pool, rent_wallet, bond_collateral) via
 * the SorobanAdapter and classifying drift against the off-chain ledger.
 * 
 * This module reuses the existing classification machinery (classifyLedgerEvent)
 * and drift accounting (tryAbsorbDrift) to maintain I1-I3 invariants for the chain rail.
 */

import { logger } from '../utils/logger.js'
import type { SorobanAdapter, MoneyContractType, OnChainPosition } from '../soroban/adapter.js'
import type { LedgerEvent, ToleranceRule } from './types.js'
import { classifyLedgerEvent } from './engine.js'
import { tryAbsorbDrift } from './drift.js'
import { persistMismatch, markLedgerEventStatus } from './store.js'
import { recordReconciliationMismatch } from '../metrics.js'
import { CircuitBreakerOpenError } from '../soroban/circuit-breaker-errors.js'

/**
 * Result of a single on-chain reconciliation check.
 */
export interface ChainReconciliationResult {
  matched: number
  mismatches: number
  skipped: number
  unknown: number  // RPC unavailable / circuit breaker open
}

/**
 * Configuration for on-chain reconciliation.
 */
export interface ChainReconciliationConfig {
  /** Money contracts to reconcile */
  contractTypes: MoneyContractType[]
  /** Accounts to check per contract (if empty, checks aggregate when available) */
  accounts: string[]
  /** Tolerance rule for the chain rail */
  chainRule: ToleranceRule
}

/**
 * Reconcile on-chain positions against the off-chain ledger.
 * 
 * This function:
 * 1. Reads on-chain positions from money contracts via SorobanAdapter
 * 2. For each position, finds the corresponding ledger event
 * 3. Classifies drift using the existing pure classifier
 * 4. Handles in-flight settlements (non-terminal skip)
 * 5. Escalates RPC unavailability as unknown (never auto-resolves to matched)
 * 
 * @param adapter - SorobanAdapter for reading on-chain positions
 * @param config - Configuration for which contracts/accounts to check
 * @param ledgerEvents - Ledger events to reconcile against
 * @returns Reconciliation result with counts
 */
export async function reconcileChainPositions(
  adapter: SorobanAdapter,
  config: ChainReconciliationConfig,
  ledgerEvents: LedgerEvent[],
): Promise<ChainReconciliationResult> {
  const result: ChainReconciliationResult = { matched: 0, mismatches: 0, skipped: 0, unknown: 0 }
  const now = Date.now()

  logger.info('[chain-reconciliation] Starting on-chain reconciliation pass', {
    contractTypes: config.contractTypes,
    accountsCount: config.accounts.length,
    ledgerEventsCount: ledgerEvents.length,
  })

  // Build a map of ledger events by internal ref for efficient lookup
  const ledgerByRef = new Map<string, LedgerEvent>()
  for (const event of ledgerEvents) {
    ledgerByRef.set(event.internalRef, event)
  }

  // For each contract type and account, read on-chain position and reconcile
  for (const contractType of config.contractTypes) {
    for (const account of config.accounts) {
      try {
        // Read on-chain position (protected by circuit breaker)
        const onChainPos = await adapter.getOnChainPosition?.(contractType, account)

        if (!onChainPos) {
          logger.warn('[chain-reconciliation] getOnChainPosition not implemented by adapter', {
            contractType,
            account,
          })
          result.unknown++
          continue
        }

        // Find corresponding ledger event for this account/contract
        // For now, we use a simple heuristic: look for ledger events with this account
        // In production, this would be more sophisticated (e.g., tagging ledger events with contract type)
        const ledgerEvent = ledgerEvents.find(e => 
          e.userId === account || 
          e.internalRef === account ||
          e.internalRef.includes(account)
        )

        if (!ledgerEvent) {
          logger.debug('[chain-reconciliation] No ledger event found for account', {
            contractType,
            account,
          })
          result.skipped++
          continue
        }

        // Create a synthetic provider event representing the on-chain position
        // This allows us to reuse the existing classification logic
        const syntheticProviderEvent = {
          id: `chain-${contractType}-${account}`,
          provider: 'chain',
          providerEventId: `${contractType}-${account}-${onChainPos.timestamp}`,
          eventType: ledgerEvent.eventType,
          amountMinor: onChainPos.balanceMinor,
          currency: onChainPos.currency,
          internalRef: ledgerEvent.internalRef,
          rawStatus: 'success',
          occurredAt: new Date(Number(onChainPos.timestamp) * 1000),
          createdAt: new Date(),
        }

        // Classify using the existing pure classifier
        const decision = classifyLedgerEvent(
          ledgerEvent,
          [syntheticProviderEvent],
          config.chainRule,
          now,
        )

        switch (decision.kind) {
          case 'skip':
            result.skipped++
            logger.debug('[chain-reconciliation] Skipped (in-flight or within delay window)', {
              contractType,
              account,
              internalRef: ledgerEvent.internalRef,
            })
            break

          case 'match': {
            // Handle drift absorption
            if (decision.absorbedMinor > 0n) {
              const absorbed = tryAbsorbDrift(
                'chain',
                onChainPos.currency,
                decision.absorbedMinor,
                now,
              )
              if (!absorbed) {
                await persistMismatch({
                  mismatchClass: 'amount_mismatch',
                  ledgerEventId: ledgerEvent.id,
                  providerEventId: decision.settlement.id,
                  toleranceMinor: config.chainRule.toleranceMinor,
                  expectedAmountMinor: ledgerEvent.amountMinor,
                  actualAmountMinor: decision.settlement.amountMinor,
                  traceContext: {
                    rail: 'chain',
                    contractType,
                    account,
                    driftCapBreached: true,
                    absorbedMinor: decision.absorbedMinor.toString(),
                  },
                })
                await markLedgerEventStatus(ledgerEvent.id, 'unmatched')
                logger.warn('[chain-reconciliation] Tolerance drift cap breached — escalating', {
                  contractType,
                  account,
                })
                result.mismatches++
                break
              }
            }
            await markLedgerEventStatus(ledgerEvent.id, 'matched')
            logger.info('[chain-reconciliation] Matched', {
              contractType,
              account,
              internalRef: ledgerEvent.internalRef,
            })
            result.matched++
            break
          }

          case 'mismatch': {
            await persistMismatch({
              mismatchClass: decision.mismatchClass,
              ledgerEventId: ledgerEvent.id,
              providerEventId: decision.settlement?.id,
              toleranceMinor: config.chainRule.toleranceMinor,
              expectedAmountMinor: ledgerEvent.amountMinor,
              actualAmountMinor: decision.settlement?.amountMinor,
              traceContext: {
                rail: 'chain',
                contractType,
                account,
                ledgerAmount: ledgerEvent.amountMinor.toString(),
                chainAmount: onChainPos.balanceMinor.toString(),
              },
            })
            await markLedgerEventStatus(ledgerEvent.id, 'unmatched')
            recordReconciliationMismatch(decision.mismatchClass)
            logger.warn('[chain-reconciliation] Mismatch detected', {
              contractType,
              account,
              mismatchClass: decision.mismatchClass,
              ledgerAmount: ledgerEvent.amountMinor.toString(),
              chainAmount: onChainPos.balanceMinor.toString(),
            })
            result.mismatches++
            break
          }
        }
      } catch (err) {
        // Handle circuit breaker open / RPC unavailability
        if (err instanceof CircuitBreakerOpenError) {
          logger.error('[chain-reconciliation] Circuit breaker open — escalating as unknown', {
            contractType,
            account,
            error: err.message,
          })
          result.unknown++
          continue
        }

        // Handle other errors (e.g., contract not configured)
        logger.error('[chain-reconciliation] Error reconciling chain position', {
          contractType,
          account,
          error: err instanceof Error ? err.message : String(err),
        })
        result.unknown++
      }
    }
  }

  logger.info('[chain-reconciliation] Pass complete', { ...result })
  return result
}
