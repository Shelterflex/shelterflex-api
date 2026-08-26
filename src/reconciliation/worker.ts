import { logger } from '../utils/logger.js'
import { runReconciliationPass } from './engine.js'
import { runResolutionPass } from './resolver.js'
import { reconcileChainPositions } from './chain-reconciliation.js'
import { listPendingLedgerEvents } from './store.js'
import type { ToleranceRule } from './types.js'
import { DEFAULT_TOLERANCE_RULES } from './types.js'
import {
  recordReconciliationPending,
  recordReconciliationProcessed,
  recordReconciliationProcessingDuration,
} from '../metrics.js'
import { createSorobanAdapter } from '../soroban/index.js'
import type { MoneyContractType } from '../soroban/adapter.js'
import { getSorobanConfigFromEnv } from '../soroban/client.js'

const RECON_INTERVAL_MS = parseInt(process.env.RECONCILIATION_INTERVAL_MS ?? '60000', 10)
const RECON_BATCH_SIZE  = parseInt(process.env.RECONCILIATION_BATCH_SIZE  ?? '200',   10)

export class ReconciliationWorker {
  private interval: NodeJS.Timeout | null = null
  private processingPromise: Promise<void> | null = null

  constructor(private readonly toleranceRules?: ToleranceRule[]) {}

  start(intervalMs = RECON_INTERVAL_MS) {
    if (this.interval) return
    logger.info('[ReconciliationWorker] Starting', { intervalMs, batchSize: RECON_BATCH_SIZE })
    this.interval = setInterval(() => {
      this.processingPromise = this.poll().finally(() => {
        this.processingPromise = null
      })
    }, intervalMs)
  }

  async stop() {
    if (this.interval) {
      clearInterval(this.interval)
      this.interval = null
    }
    if (this.processingPromise) {
      logger.info('[ReconciliationWorker] Waiting for in-progress pass to complete...')
      await this.processingPromise
    }
    logger.info('[ReconciliationWorker] Stopped')
  }

  async poll() {
    const startTime = Date.now()
    try {
      const reconResult = await runReconciliationPass(this.toleranceRules, RECON_BATCH_SIZE)
      logger.info('[ReconciliationWorker] Reconciliation pass done', reconResult)

      // Record pending count (matched + mismatches + skipped = total processed)
      recordReconciliationPending(reconResult.matched + reconResult.mismatches + reconResult.skipped)

      // Record processed counts by status
      recordReconciliationProcessed('matched')
      for (let i = 1; i < reconResult.matched; i++) {
        recordReconciliationProcessed('matched')
      }
      for (let i = 0; i < reconResult.mismatches; i++) {
        recordReconciliationProcessed('mismatch')
      }
      for (let i = 0; i < reconResult.skipped; i++) {
        recordReconciliationProcessed('skipped')
      }

      // Chain reconciliation pass (if enabled)
      const chainEnabled = process.env.RECON_CHAIN_ENABLED === 'true'
      if (chainEnabled) {
        try {
          const sorobanConfig = getSorobanConfigFromEnv(process.env)
          const adapter = createSorobanAdapter(sorobanConfig)
          const chainRule = DEFAULT_TOLERANCE_RULES.find(r => r.rail === 'chain')
          if (!chainRule) {
            logger.warn('[ReconciliationWorker] Chain rail not found in tolerance rules')
          } else {
            // Configure which contracts to check from environment
            const contractTypesEnv = process.env.RECON_CHAIN_CONTRACT_TYPES || 'staking_pool,bond_collateral'
            const contractTypes = contractTypesEnv.split(',') as MoneyContractType[]
            
            // Get pending ledger events to reconcile against
            const ledgerEvents = await listPendingLedgerEvents(RECON_BATCH_SIZE)
            
            // Extract unique accounts from ledger events (filter undefined first)
            const accounts = [...new Set(ledgerEvents.map(e => e.userId).filter((id): id is string => id !== undefined))]
            
            const chainResult = await reconcileChainPositions(
              adapter,
              {
                contractTypes,
                accounts,
                chainRule,
              },
              ledgerEvents,
            )
            logger.info('[ReconciliationWorker] Chain reconciliation pass done', { ...chainResult })
            
            // Record chain reconciliation metrics
            recordReconciliationPending(chainResult.matched + chainResult.mismatches + chainResult.skipped + chainResult.unknown)
            for (let i = 0; i < chainResult.matched; i++) {
              recordReconciliationProcessed('matched')
            }
            for (let i = 0; i < chainResult.mismatches; i++) {
              recordReconciliationProcessed('mismatch')
            }
            for (let i = 0; i < chainResult.skipped; i++) {
              recordReconciliationProcessed('skipped')
            }
            for (let i = 0; i < chainResult.unknown; i++) {
              recordReconciliationProcessed('skipped') // unknown counts as skipped for metrics
            }
          }
        } catch (chainErr) {
          logger.error('[ReconciliationWorker] Chain reconciliation pass failed', {
            error: chainErr instanceof Error ? chainErr.message : String(chainErr),
          })
        }
      }

      const resolveResult = await runResolutionPass()
      logger.info('[ReconciliationWorker] Resolution pass done', resolveResult)

      const duration = Date.now() - startTime
      recordReconciliationProcessingDuration(duration)
    } catch (err) {
      logger.error('[ReconciliationWorker] Poll failed', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
}
