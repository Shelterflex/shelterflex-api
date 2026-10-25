import { describe, it, expect, beforeEach } from 'vitest'
import { dealStore } from '../models/dealStore.js'
import { DealStatus } from '../models/deal.js'
import { listingStore } from '../models/listingStore.js'
import { rewardStore } from '../models/rewardStore.js'
import { RewardStatus } from '../models/reward.js'
import { whistleblowerTrustStore } from '../models/whistleblowerTrustStore.js'
import { openRewardForDeal, releaseDueRewards, rewardHoldDays } from './whistleblowerRewardService.js'

const DAY = 24 * 60 * 60 * 1000

async function rentedDeal(whistleblowerId = 'wb-1') {
  const listing = await listingStore.create({
    whistleblowerId,
    address: '15 Admiralty Way, Lekki',
    bedrooms: 2,
    bathrooms: 2,
    annualRentNgn: 1_200_000,
    photos: ['https://x/1.jpg', 'https://x/2.jpg', 'https://x/3.jpg'],
  })
  const deal = await dealStore.create({
    tenantId: 'tenant-1',
    landlordId: 'landlord-1',
    listingId: listing.listingId,
    annualRentNgn: 1_200_000,
    depositNgn: 240_000,
    termMonths: 12,
  })
  return { listing, deal }
}

describe('whistleblower reward lifecycle', () => {
  beforeEach(async () => {
    await rewardStore.clear()
    await dealStore.clear()
    await listingStore.clear()
    await whistleblowerTrustStore.clear()
    await whistleblowerTrustStore.markVerified('wb-1', 'ref')
  })

  it('opens one pending reward for the reporter when the rental starts', async () => {
    const { deal } = await rentedDeal()
    expect(await openRewardForDeal(deal)).toBe(true)
    expect(await openRewardForDeal(deal)).toBe(false)

    const rewards = await rewardStore.listAll()
    expect(rewards).toHaveLength(1)
    expect(rewards[0]).toMatchObject({ whistleblowerId: 'wb-1', status: RewardStatus.PENDING })
  })

  it('holds the reward until the rental has held for the hold period', async () => {
    const { deal } = await rentedDeal()
    await openRewardForDeal(deal)

    const early = await releaseDueRewards(new Date(Date.now() + (rewardHoldDays() - 1) * DAY))
    expect(early).toMatchObject({ released: 0, stillWaiting: 1 })

    const later = await releaseDueRewards(new Date(Date.now() + (rewardHoldDays() + 1) * DAY))
    expect(later.released).toBe(1)
    expect((await rewardStore.listAll())[0]!.status).toBe(RewardStatus.PAYABLE)
  })

  it('keeps the reward back while the reporter is suspended, and releases it after reinstatement', async () => {
    const { deal } = await rentedDeal()
    await openRewardForDeal(deal)
    await whistleblowerTrustStore.suspend('wb-1', 'safety reports')

    const after = new Date(Date.now() + (rewardHoldDays() + 1) * DAY)
    expect(await releaseDueRewards(after)).toMatchObject({ released: 0, heldForSafety: 1 })

    await whistleblowerTrustStore.reinstate('wb-1')
    expect((await releaseDueRewards(after)).released).toBe(1)
  })

  it('does not release to someone who never verified their identity', async () => {
    await whistleblowerTrustStore.clear()
    const { deal } = await rentedDeal()
    await openRewardForDeal(deal)
    const after = new Date(Date.now() + (rewardHoldDays() + 1) * DAY)
    expect(await releaseDueRewards(after)).toMatchObject({ released: 0, heldForSafety: 1 })
  })

  it('cancels the reward when the tenant defaults', async () => {
    const { deal } = await rentedDeal()
    await openRewardForDeal(deal)
    await dealStore.updateStatus(deal.dealId, DealStatus.DEFAULTED)

    expect(await releaseDueRewards()).toMatchObject({ cancelled: 1, released: 0 })
    expect((await rewardStore.listAll())[0]!.status).toBe(RewardStatus.CANCELLED)
  })

  it('opens nothing for a deal that has no listing', async () => {
    expect(await openRewardForDeal({ dealId: 'd', listingId: undefined })).toBe(false)
  })
})
