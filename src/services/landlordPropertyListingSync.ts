/**
 * Keeps whistleblower listings in sync with landlord inventory for tenant search.
 */

import { listingStore } from '../models/listingStore.js'
import { ListingStatus } from '../models/listing.js'
import { LandlordProperty, PropertyStatus } from '../models/landlordProperty.js'
import { landlordPropertyStore } from '../models/landlordPropertyStore.js'

const SYSTEM_WHISTLEBLOWER_ID = 'landlord-inventory-sync'

function listingStatusForProperty(status: PropertyStatus): ListingStatus | null {
  switch (status) {
    case PropertyStatus.APPROVED:
      return ListingStatus.APPROVED
    case PropertyStatus.PENDING_REVIEW:
      return ListingStatus.PENDING_REVIEW
    case PropertyStatus.RENTED:
      return ListingStatus.RENTED
    case PropertyStatus.DEACTIVATED:
      return ListingStatus.REJECTED
    default:
      return null
  }
}

export async function syncLandlordPropertyListing(
  property: LandlordProperty,
): Promise<LandlordProperty> {
  const targetListingStatus = listingStatusForProperty(property.status)

  if (!targetListingStatus) {
    return property
  }

  if (property.status === PropertyStatus.DEACTIVATED && property.listingId) {
    await listingStore.updateStatus(
      property.listingId,
      ListingStatus.REJECTED,
      'Deactivated by landlord',
    )
    return property
  }

  const photos = property.photos ?? []
  const primaryIndex = Math.min(
    property.primaryPhotoIndex ?? 0,
    Math.max(photos.length - 1, 0),
  )
  const orderedPhotos =
    photos.length > 0
      ? [photos[primaryIndex], ...photos.filter((_, i) => i !== primaryIndex)]
      : photos

  if (property.listingId) {
    await listingStore.updateStatus(property.listingId, targetListingStatus)
    return property
  }

  if (
    property.status !== PropertyStatus.PENDING_REVIEW &&
    property.status !== PropertyStatus.APPROVED
  ) {
    return property
  }

  const listing = await listingStore.create({
    whistleblowerId: SYSTEM_WHISTLEBLOWER_ID,
    landlordId: property.landlordId,
    address: property.address,
    city: property.city,
    area: property.area,
    bedrooms: property.bedrooms,
    bathrooms: property.bathrooms,
    annualRentNgn: property.installmentBasePriceNgn ?? property.annualRentNgn,
    negotiatedLandlordRateNgn: property.negotiatedLandlordRateNgn,
    outrightPriceNgn: property.outrightPriceNgn,
    installmentBasePriceNgn: property.installmentBasePriceNgn,
    description: property.description,
    photos: orderedPhotos,
  })

  if (targetListingStatus !== ListingStatus.PENDING_REVIEW) {
    await listingStore.updateStatus(listing.listingId, targetListingStatus)
  }

  const updated = await landlordPropertyStore.update(property.id, {
    listingId: listing.listingId,
  })

  return updated ?? { ...property, listingId: listing.listingId }
}
