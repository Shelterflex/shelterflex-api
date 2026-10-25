import { releaseDueRewards } from '../services/whistleblowerRewardService.js'
import { logger } from '../utils/logger.js'

/** Daily: releases whistleblower rewards whose hold period has passed. */
export class RewardReleaseJob {
  private interval: NodeJS.Timeout | null = null
  private processingPromise: Promise<void> | null = null

  constructor(private pollIntervalMs: number = 24 * 60 * 60 * 1000) {}

  start(): void {
    if (this.interval) return
    logger.info('Starting RewardReleaseJob', { pollIntervalMs: this.pollIntervalMs })
    void this.poll()
    this.interval = setInterval(() => {
      this.processingPromise = this.poll().finally(() => {
        this.processingPromise = null
      })
    }, this.pollIntervalMs)
    if (this.interval.unref) this.interval.unref()
  }

  async stop(): Promise<void> {
    if (this.interval) {
      clearInterval(this.interval)
      this.interval = null
    }
    if (this.processingPromise) await this.processingPromise
    logger.info('Stopped RewardReleaseJob')
  }

  async poll(now?: Date): Promise<void> {
    try {
      logger.info('RewardReleaseJob completed', { ...(await releaseDueRewards(now)) })
    } catch (error) {
      logger.error('RewardReleaseJob failed', { error })
    }
  }
}
