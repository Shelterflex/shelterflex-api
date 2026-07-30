import { SorobanAdapter } from '../soroban/adapter.js'
import { logger } from '../utils/logger.js'
import { outboxStore } from '../outbox/store.js'
import { OutboxStatus, TxType, type OutboxItem } from '../outbox/types.js'
import { isDealSyncEnabled } from '../services/deals/dealSyncConfig.js'

const MAX_DEAL_SYNC_RETRIES = 5
const BASE_BACKOFF_MS = 1000

function getBackoffMs(retryCount: number): number {
  return Math.min(Math.pow(2, retryCount) * BASE_BACKOFF_MS, 60 * 60 * 1000)
}

function shouldRetry(item: OutboxItem): boolean {
  if (item.retryCount >= MAX_DEAL_SYNC_RETRIES) return false
  if (!item.nextRetryAt) return true
  return Date.now() >= new Date(item.nextRetryAt).getTime()
}

/**
 * Polls outbox records for deal status sync and invokes deal_escrow on Soroban.
 */
export class DealStatusSyncWorker {
  private intervalId: NodeJS.Timeout | null = null
  private running = false
  private processingPromise: Promise<void> | null = null

  constructor(private adapter: SorobanAdapter) {}

  start(intervalMs = 30000) {
    if (this.running) return
    this.running = true
    this.intervalId = setInterval(() => {
      this.processingPromise = this.process().finally(() => {
        this.processingPromise = null
      })
    }, intervalMs)
    logger.info('DealStatusSyncWorker started', { intervalMs, enabled: isDealSyncEnabled() })
  }

  async stop() {
    this.running = false
    if (this.intervalId) {
      clearInterval(this.intervalId)
      this.intervalId = null
    }
    if (this.processingPromise) {
      await this.processingPromise
    }
    logger.info('DealStatusSyncWorker stopped')
  }

  async process() {
    if (!isDealSyncEnabled()) {
      return
    }
    if (!this.adapter.syncDealStatus) {
      return
    }

    const pending = await outboxStore.listByStatus(OutboxStatus.PENDING)
    const failed = await outboxStore.listByStatus(OutboxStatus.FAILED)
    const items = [...pending, ...failed].filter((item) => item.txType === TxType.DEAL_STATUS_CHANGED)

    for (const item of items) {
      if (item.status === OutboxStatus.FAILED && !shouldRetry(item)) {
        if (item.retryCount >= MAX_DEAL_SYNC_RETRIES) {
          await outboxStore.markDead(item.id, 'Max deal sync retry count reached')
          logger.error('Deal status sync dead-lettered', {
            outboxId: item.id,
            dealId: item.payload.dealId,
            retryCount: item.retryCount,
            lastError: item.lastError,
          })
        }
        continue
      }

      await this.sendDealStatus(item)
    }
  }

  private async sendDealStatus(item: OutboxItem): Promise<void> {
    try {
      const payload = item.payload
      const dealId = String(payload.dealId ?? '')
      const contractDealId = String(payload.contractDealId ?? dealId)
      const newStatus = payload.newStatus as 'active' | 'completed' | 'defaulted'
      const actor = String(payload.actor ?? 'system')

      if (!dealId || !newStatus) {
        throw new Error('Invalid DEAL_STATUS_CHANGED payload')
      }

      await this.adapter.syncDealStatus!({
        dealId,
        contractDealId,
        newStatus,
        actor,
      })

      await outboxStore.updateStatus(item.id, OutboxStatus.SENT)
      logger.info('Deal status sync succeeded', { outboxId: item.id, dealId, newStatus })
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      const currentRetryCount = item.retryCount || 0
      const nextRetryAt = new Date(Date.now() + getBackoffMs(currentRetryCount))

      if (currentRetryCount + 1 >= MAX_DEAL_SYNC_RETRIES) {
        await outboxStore.markDead(item.id, errorMessage)
        logger.error('Deal status sync failed — dead-lettered', {
          outboxId: item.id,
          dealId: item.payload.dealId,
          retryCount: currentRetryCount + 1,
          lastError: errorMessage,
        })
        return
      }

      await outboxStore.updateStatus(item.id, OutboxStatus.FAILED, {
        error: errorMessage,
        nextRetryAt,
      })
      logger.warn('Deal status sync failed — will retry', {
        outboxId: item.id,
        dealId: item.payload.dealId,
        retryCount: currentRetryCount + 1,
        lastError: errorMessage,
      })
    }
  }
}
