/**
 * Listing model and types
 */

export enum ListingStatus {
  PENDING_REVIEW = 'pending_review',
  APPROVED = 'approved',
  REJECTED = 'rejected',
  RENTED = 'rented',
}

export interface Listing {
  listingId: string
  whistleblowerId: string
  landlordId?: string
  address: string
  city?: string
  area?: string
  bedrooms: number
  bathrooms: number
  annualRentNgn: number
  outrightPriceNgn?: number
  installmentBasePriceNgn?: number
  negotiatedLandlordRateNgn?: number
  description?: string
  photos: string[]
  status: ListingStatus
  reviewedBy?: string
  reviewedAt?: Date
  rejectionReason?: string
  dealId?: string
  trustScore?: number
  hasVerifiedInspection?: boolean
  createdAt: Date
  updatedAt: Date
}

export interface ListingSearchResult extends Listing {
  highlightedSnippet: string
  rank: number
}

export interface CreateListingInput {
  whistleblowerId: string
  landlordId?: string
  address: string
  city?: string
  area?: string
  bedrooms: number
  bathrooms: number
  annualRentNgn: number
  outrightPriceNgn?: number
  installmentBasePriceNgn?: number
  negotiatedLandlordRateNgn?: number
  description?: string
  photos: string[]
}

export interface ListingFilters {
  status?: ListingStatus
  query?: string
  q?: string
  minPrice?: number
  maxPrice?: number
  bedrooms?: number
  lga?: string
  paymentPlan?: string
  page?: number
  pageSize?: number
}

export interface PaginatedListings {
  listings: Listing[] | ListingSearchResult[]
  total: number
  page: number
  pageSize: number
  totalPages: number
}
