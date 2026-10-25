/**
 * The whistleblower reward lifecycle.
 *
 * A reward is opened (pending) when the deal on a reported apartment goes
 * active, i.e. a tenant has actually rented it. It is only released (payable)
 * once the rental has held for a while, and never while the whistleblower is
 * suspended or unverified, or if the deal has failed:
 *
 *   deal active  ->  pending  --(hold period passes, reporter in good standing)-->  payable
 *                       \\--(deal defaulted)--> cancelled
 */

import { dealStore } from '../models/dealStore.js'
import { DealStatus } from '../models/deal.js'
import { listingStore } from '../models/listingStore.js'
import { rewardStore } from '../models/rewardStore.js'
import { RewardStatus } from '../models/reward.js'
import { whistleblowerTrustStore } from '../models/whistleblowerTrustStore.js'
import { logger } from '../utils/logger.js'

const DAY_MS = 24 * 60 * 60 * 1000

/** Reward per successful rental, in USDC. */
export function rewardAmountUsdc(): number {
  const value = Number(process.env.WHISTLEBLOWER_REWARD_USDC)
  return Number.isFinite(value) && value > 0 ? value : 10
}

/** How long a rental must hold before its reward is released. */
export function rewardHoldDays(): number {
  const value = Number(process.env.WHISTLEBLOWER_REWARD_HOLD_DAYS)
  return Number.isFinite(value) && value >= 0 ? value : 14
}

/** Opens a pending reward for the whistleblower behind the deal's listing, once. */
export async function openRewardForDeal(deal: {
  dealId: string
  listingId?: string
}): Promise<boolean> {
  if (!deal.listingId) return false
  const listing = await listingStore.getById(deal.listingId)
  if (!listing) return false

  const existing = (await rewardStore.listAll()).find((r) => r.dealId === deal.dealId)
  if (existing) return false

  await rewardStore.create({
    whistleblowerId: listing.whistleblowerId,
    dealId: deal.dealId,
    listingId: deal.listingId,
    amountUsdc: rewardAmountUsdc(),
  })
  logger.info('whistleblower.reward_opened', { dealId: deal.dealId, whistleblowerId: listing.whistleblowerId })
  return true
}

export interface ReleaseSummary {
  released: number
  heldForSafety: number
  stillWaiting: number
  cancelled: number
}

/** Moves rewards forward: releases the ones that have earned it, cancels the ones whose deal failed. */
export async function releaseDueRewards(now: Date = new Date()): Promise<ReleaseSummary> {
  const summary: ReleaseSummary = { released: 0, heldForSafety: 0, stillWaiting: 0, cancelled: 0 }
  const holdMs = rewardHoldDays() * DAY_MS

  for (const reward of await rewardStore.listAll()) {
    if (reward.status !== RewardStatus.PENDING) continue

    const deal = await dealStore.findById(reward.dealId)
    if (!deal || deal.status === DealStatus.DEFAULTED) {
      await rewardStore.updateStatus(reward.rewardId, RewardStatus.CANCELLED)
      summary.cancelled++
      continue
    }

    if (now.getTime() - reward.createdAt.getTime() < holdMs) {
      summary.stillWaiting++
      continue
    }

    if (
      (await whistleblowerTrustStore.isSuspended(reward.whistleblowerId)) ||
      !(await whistleblowerTrustStore.isVerified(reward.whistleblowerId))
    ) {
      summary.heldForSafety++
      continue
    }

    await rewardStore.updateStatus(reward.rewardId, RewardStatus.PAYABLE)
    summary.released++
  }

  return summary
}
