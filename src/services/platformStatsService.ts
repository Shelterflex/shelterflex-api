import { LRUCache } from 'lru-cache'
import { listingStore } from '../models/listingStore.js'
import { dealStore } from '../models/dealStore.js'
import { landlordPropertyStore } from '../models/landlordPropertyStore.js'
import { ListingStatus } from '../models/listing.js'
import { DealStatus } from '../models/deal.js'

export interface PlatformStats {
  listings: {
    total: number
    active: number
  }
  deals: {
    total: number
    active: number
    completed: number
  }
  totalFinancedNgn: number
  properties: {
    total: number
  }
  generatedAt: string
}

const CACHE_TTL_MS = 5 * 60 * 1000

const statsCache = new LRUCache<string, PlatformStats>({
  max: 1,
  ttl: CACHE_TTL_MS,
})

export async function getPlatformStats(): Promise<PlatformStats> {
  const cached = statsCache.get('stats')
  if (cached) return cached

  const [listingsPage, dealsPage, propertiesPage] = await Promise.all([
    listingStore.list({ pageSize: 50_000 }),
    dealStore.findMany({ pageSize: 50_000 }),
    landlordPropertyStore.list({ pageSize: 50_000 }),
  ])

  const activeListings = listingsPage.listings.filter(
    (l) => l.status === ListingStatus.APPROVED,
  ).length

  let activeDeals = 0
  let completedDeals = 0
  let totalFinancedNgn = 0
  for (const deal of dealsPage.deals) {
    if (deal.status === DealStatus.ACTIVE || deal.status === DealStatus.AT_RISK) activeDeals++
    if (deal.status === DealStatus.COMPLETED) completedDeals++
    totalFinancedNgn += deal.financedAmountNgn
  }

  const stats: PlatformStats = {
    listings: {
      total: listingsPage.total,
      active: activeListings,
    },
    deals: {
      total: dealsPage.total,
      active: activeDeals,
      completed: completedDeals,
    },
    totalFinancedNgn,
    properties: {
      total: propertiesPage.total,
    },
    generatedAt: new Date().toISOString(),
  }

  statsCache.set('stats', stats)
  return stats
}

export function clearStatsCache(): void {
  statsCache.clear()
}
