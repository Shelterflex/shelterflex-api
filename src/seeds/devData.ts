/**
 * Deterministic development fixtures.
 *
 * Every row has a hard-coded primary key so a seeded record keeps the same id
 * across runs and can be referenced from tests. Seeded UUIDs all start with
 * `5eed` (leetspeak for "seed"), which makes them obvious in a query result and
 * easy to select with `id::text LIKE '5eed%'`.
 *
 * All data is fictional: street names, companies, phone numbers and bank
 * details are invented, and every email address uses the RFC 2606 reserved
 * `example.com` domain, which can never receive mail.
 */

/** Builds a stable seed UUID from a group number and a row index. */
function seedId(group: number, index: number): string {
  const g = group.toString(16).padStart(4, '0')
  const i = index.toString(16).padStart(12, '0')
  return `5eed${g}-0000-4000-8000-${i}`
}

const GROUP = {
  user: 1,
  landlordProperty: 2,
  propertyPhoto: 3,
  listing: 4,
  deal: 5,
  inspectionJob: 6,
  repayment: 7,
} as const

export type SeedRole = 'tenant' | 'landlord' | 'agent' | 'admin' | 'inspector'

export interface SeedUser {
  id: string
  email: string
  name: string
  role: SeedRole
  /** Admin RBAC role granted through user_roles, if any. */
  adminRole?: string
}

export const SEED_USERS: SeedUser[] = [
  { id: seedId(GROUP.user, 1), email: 'tenant@example.com', name: 'Tola Tenant', role: 'tenant' },
  { id: seedId(GROUP.user, 2), email: 'tenant2@example.com', name: 'Temi Tenant', role: 'tenant' },
  { id: seedId(GROUP.user, 3), email: 'landlord@example.com', name: 'Lola Landlord', role: 'landlord' },
  { id: seedId(GROUP.user, 4), email: 'landlord2@example.com', name: 'Lanre Landlord', role: 'landlord' },
  {
    id: seedId(GROUP.user, 5),
    email: 'admin@example.com',
    name: 'Ada Admin',
    role: 'admin',
    adminRole: 'super_admin',
  },
  { id: seedId(GROUP.user, 6), email: 'inspector@example.com', name: 'Ike Inspector', role: 'inspector' },
  { id: seedId(GROUP.user, 7), email: 'agent@example.com', name: 'Ayo Agent', role: 'agent' },
]

export const USER_IDS = {
  tenant1: SEED_USERS[0].id,
  tenant2: SEED_USERS[1].id,
  landlord1: SEED_USERS[2].id,
  landlord2: SEED_USERS[3].id,
  admin: SEED_USERS[4].id,
  inspector: SEED_USERS[5].id,
  agent: SEED_USERS[6].id,
} as const

export interface SeedLandlordProfile {
  userId: string
  phone: string
  address: string
  companyName: string
  bankName: string
  accountNumber: string
  accountName: string
  verificationLevel: string
}

export const SEED_LANDLORD_PROFILES: SeedLandlordProfile[] = [
  {
    userId: USER_IDS.landlord1,
    phone: '+2348000000003',
    address: '1 Example Court, Lekki Phase 1, Lagos',
    companyName: 'Example Estates Ltd',
    bankName: 'Sample Bank',
    accountNumber: '0000000003',
    accountName: 'Example Estates Ltd',
    verificationLevel: 'id_and_property_verified',
  },
  {
    userId: USER_IDS.landlord2,
    phone: '+2348000000004',
    address: '2 Example Court, Wuse 2, Abuja',
    companyName: 'Placeholder Properties Ltd',
    bankName: 'Sample Bank',
    accountNumber: '0000000004',
    accountName: 'Placeholder Properties Ltd',
    verificationLevel: 'id_verified',
  },
]

export interface SeedPhoto {
  id: string
  url: string
  isFeatured: boolean
  orderIndex: number
  fileName: string
}

export interface SeedLandlordProperty {
  id: string
  landlordId: string
  title: string
  address: string
  city: string
  area: string
  bedrooms: number
  bathrooms: number
  sqm: number
  annualRentNgn: number
  outrightPriceNgn: number
  installmentBasePriceNgn: number
  propertyType: string
  amenities: string[]
  description: string
  status: 'approved' | 'pending_review' | 'rented' | 'deactivated'
  views: number
  inquiries: number
  photos: SeedPhoto[]
}

/**
 * Photo paths follow the `/properties/<n>/<name>.jpg` convention used by the
 * sample images bundled in shelterflex-web, so seeded listings render with real
 * pictures rather than broken image icons.
 */
function photoSet(propertyIndex: number, names: string[]): SeedPhoto[] {
  return names.map((name, i) => ({
    id: seedId(GROUP.propertyPhoto, propertyIndex * 100 + i),
    url: `/properties/${propertyIndex}/${name}.jpg`,
    isFeatured: i === 0,
    orderIndex: i,
    fileName: `${name}.jpg`,
  }))
}

const STANDARD_PHOTOS = ['exterior', 'living-room', 'master-bedroom', 'kitchen', 'bathroom']

export const SEED_LANDLORD_PROPERTIES: SeedLandlordProperty[] = [
  {
    id: seedId(GROUP.landlordProperty, 1),
    landlordId: USER_IDS.landlord1,
    title: '3 Bedroom Serviced Apartment',
    address: '4 Marigold Close, Lekki Phase 1, Lagos',
    city: 'Lagos',
    area: 'Lekki Phase 1',
    bedrooms: 3,
    bathrooms: 3,
    sqm: 145,
    annualRentNgn: 3_500_000,
    outrightPriceNgn: 3_500_000,
    installmentBasePriceNgn: 3_850_000,
    propertyType: 'apartment',
    amenities: ['24/7 power', 'Borehole water', 'Gated estate', 'Parking'],
    description:
      'A fictional three bedroom serviced apartment used for local development. Fully fitted kitchen, en-suite bedrooms and a shared residents gym.',
    status: 'approved',
    views: 142,
    inquiries: 9,
    photos: photoSet(1, STANDARD_PHOTOS),
  },
  {
    id: seedId(GROUP.landlordProperty, 2),
    landlordId: USER_IDS.landlord1,
    title: '2 Bedroom Flat',
    address: '11 Sandpiper Crescent, Wuse 2, Abuja',
    city: 'Abuja',
    area: 'Wuse 2',
    bedrooms: 2,
    bathrooms: 2,
    sqm: 98,
    annualRentNgn: 2_800_000,
    outrightPriceNgn: 2_800_000,
    installmentBasePriceNgn: 3_080_000,
    propertyType: 'apartment',
    amenities: ['Gated estate', 'Parking', 'Prepaid meter'],
    description:
      'A fictional two bedroom flat used for local development. Open plan living area and a small balcony overlooking the estate courtyard.',
    status: 'approved',
    views: 87,
    inquiries: 4,
    photos: photoSet(2, STANDARD_PHOTOS),
  },
  {
    id: seedId(GROUP.landlordProperty, 3),
    landlordId: USER_IDS.landlord1,
    title: '4 Bedroom Duplex',
    address: '6 Kingfisher Lane, Ikoyi, Lagos',
    city: 'Lagos',
    area: 'Ikoyi',
    bedrooms: 4,
    bathrooms: 4,
    sqm: 260,
    annualRentNgn: 8_500_000,
    outrightPriceNgn: 8_500_000,
    installmentBasePriceNgn: 9_350_000,
    propertyType: 'duplex',
    amenities: ['Swimming pool', 'Boys quarters', 'Solar backup', 'Gated estate'],
    description:
      'A fictional four bedroom duplex used for local development. Private garden, family lounge and a detached boys quarters.',
    status: 'rented',
    views: 310,
    inquiries: 21,
    photos: photoSet(3, [...STANDARD_PHOTOS, 'pool']),
  },
  {
    id: seedId(GROUP.landlordProperty, 4),
    landlordId: USER_IDS.landlord2,
    title: 'Studio Apartment',
    address: '19 Ironwood Street, Yaba, Lagos',
    city: 'Lagos',
    area: 'Yaba',
    bedrooms: 1,
    bathrooms: 1,
    sqm: 42,
    annualRentNgn: 1_200_000,
    outrightPriceNgn: 1_200_000,
    installmentBasePriceNgn: 1_320_000,
    propertyType: 'studio',
    amenities: ['Prepaid meter', 'Fibre internet ready'],
    description:
      'A fictional studio apartment used for local development. Compact layout aimed at a single occupant, walking distance to the imaginary tech park.',
    status: 'approved',
    views: 56,
    inquiries: 3,
    photos: photoSet(4, ['exterior', 'studio', 'bedroom', 'kitchen', 'bathroom']),
  },
  {
    id: seedId(GROUP.landlordProperty, 5),
    landlordId: USER_IDS.landlord2,
    title: '3 Bedroom Executive Apartment',
    address: '30 Cobalt Avenue, Victoria Island, Lagos',
    city: 'Lagos',
    area: 'Victoria Island',
    bedrooms: 3,
    bathrooms: 3,
    sqm: 160,
    annualRentNgn: 5_500_000,
    outrightPriceNgn: 5_500_000,
    installmentBasePriceNgn: 6_050_000,
    propertyType: 'apartment',
    amenities: ['24/7 power', 'Concierge', 'Gym', 'Parking'],
    description:
      'A fictional three bedroom executive apartment used for local development. Serviced building with a shared roof terrace.',
    status: 'approved',
    views: 198,
    inquiries: 12,
    photos: photoSet(5, STANDARD_PHOTOS),
  },
  {
    id: seedId(GROUP.landlordProperty, 6),
    landlordId: USER_IDS.landlord2,
    title: '4 Bedroom Family Bungalow',
    address: '8 Tamarind Way, Gwarimpa, Abuja',
    city: 'Abuja',
    area: 'Gwarimpa',
    bedrooms: 4,
    bathrooms: 3,
    sqm: 210,
    annualRentNgn: 4_200_000,
    outrightPriceNgn: 4_200_000,
    installmentBasePriceNgn: 4_620_000,
    propertyType: 'bungalow',
    amenities: ['Boys quarters', 'Large compound', 'Borehole water'],
    description:
      'A fictional four bedroom bungalow used for local development. Awaiting review so the landlord dashboard has a pending item to show.',
    status: 'pending_review',
    views: 12,
    inquiries: 0,
    photos: photoSet(6, STANDARD_PHOTOS),
  },
]

export interface SeedListing {
  id: string
  whistleblowerId: string
  address: string
  city: string
  area: string
  bedrooms: number
  bathrooms: number
  annualRentNgn: number
  outrightPriceNgn: number
  installmentBasePriceNgn: number
  description: string
  photos: string[]
  status: 'approved' | 'pending_review' | 'rented'
  trustScore: number
  hasVerifiedInspection: boolean
}

function listingPhotos(imageSet: number, names: string[] = STANDARD_PHOTOS): string[] {
  return names.map((name) => `/properties/${imageSet}/${name}.jpg`)
}

/**
 * Public search results. These are the rows the /properties page reads, so the
 * set deliberately spans price bands, cities and bedroom counts to make filters
 * and sorting exercisable.
 */
export const SEED_LISTINGS: SeedListing[] = [
  {
    id: seedId(GROUP.listing, 1),
    whistleblowerId: USER_IDS.tenant2,
    address: '4 Marigold Close, Lekki Phase 1, Lagos',
    city: 'Lagos',
    area: 'Lekki Phase 1',
    bedrooms: 3,
    bathrooms: 3,
    annualRentNgn: 3_500_000,
    outrightPriceNgn: 3_500_000,
    installmentBasePriceNgn: 3_850_000,
    description:
      'A fictional three bedroom serviced apartment used for local development. Fully fitted kitchen, en-suite bedrooms and a shared residents gym.',
    photos: listingPhotos(1),
    status: 'approved',
    trustScore: 82,
    hasVerifiedInspection: true,
  },
  {
    id: seedId(GROUP.listing, 2),
    whistleblowerId: USER_IDS.tenant2,
    address: '11 Sandpiper Crescent, Wuse 2, Abuja',
    city: 'Abuja',
    area: 'Wuse 2',
    bedrooms: 2,
    bathrooms: 2,
    annualRentNgn: 2_800_000,
    outrightPriceNgn: 2_800_000,
    installmentBasePriceNgn: 3_080_000,
    description:
      'A fictional two bedroom flat used for local development. Open plan living area and a small balcony overlooking the estate courtyard.',
    photos: listingPhotos(2),
    status: 'approved',
    trustScore: 74,
    hasVerifiedInspection: true,
  },
  {
    id: seedId(GROUP.listing, 3),
    whistleblowerId: USER_IDS.agent,
    address: '6 Kingfisher Lane, Ikoyi, Lagos',
    city: 'Lagos',
    area: 'Ikoyi',
    bedrooms: 4,
    bathrooms: 4,
    annualRentNgn: 8_500_000,
    outrightPriceNgn: 8_500_000,
    installmentBasePriceNgn: 9_350_000,
    description:
      'A fictional four bedroom duplex used for local development. Private garden, family lounge and a detached boys quarters.',
    photos: listingPhotos(3, [...STANDARD_PHOTOS, 'pool']),
    status: 'approved',
    trustScore: 91,
    hasVerifiedInspection: true,
  },
  {
    id: seedId(GROUP.listing, 4),
    whistleblowerId: USER_IDS.agent,
    address: '19 Ironwood Street, Yaba, Lagos',
    city: 'Lagos',
    area: 'Yaba',
    bedrooms: 1,
    bathrooms: 1,
    annualRentNgn: 1_200_000,
    outrightPriceNgn: 1_200_000,
    installmentBasePriceNgn: 1_320_000,
    description:
      'A fictional studio apartment used for local development. Compact layout aimed at a single occupant, walking distance to the imaginary tech park.',
    photos: listingPhotos(4, ['exterior', 'studio', 'bedroom', 'kitchen', 'bathroom']),
    status: 'approved',
    trustScore: 61,
    hasVerifiedInspection: false,
  },
  {
    id: seedId(GROUP.listing, 5),
    whistleblowerId: USER_IDS.tenant1,
    address: '30 Cobalt Avenue, Victoria Island, Lagos',
    city: 'Lagos',
    area: 'Victoria Island',
    bedrooms: 3,
    bathrooms: 3,
    annualRentNgn: 5_500_000,
    outrightPriceNgn: 5_500_000,
    installmentBasePriceNgn: 6_050_000,
    description:
      'A fictional three bedroom executive apartment used for local development. Serviced building with a shared roof terrace.',
    photos: listingPhotos(5),
    status: 'approved',
    trustScore: 78,
    hasVerifiedInspection: true,
  },
  {
    id: seedId(GROUP.listing, 6),
    whistleblowerId: USER_IDS.tenant1,
    address: '8 Tamarind Way, Gwarimpa, Abuja',
    city: 'Abuja',
    area: 'Gwarimpa',
    bedrooms: 4,
    bathrooms: 3,
    annualRentNgn: 4_200_000,
    outrightPriceNgn: 4_200_000,
    installmentBasePriceNgn: 4_620_000,
    description:
      'A fictional four bedroom bungalow used for local development. Large compound with a detached boys quarters.',
    photos: listingPhotos(6),
    status: 'approved',
    trustScore: 69,
    hasVerifiedInspection: false,
  },
  {
    id: seedId(GROUP.listing, 7),
    whistleblowerId: USER_IDS.agent,
    address: '23 Peppercorn Road, Ikeja GRA, Lagos',
    city: 'Lagos',
    area: 'Ikeja GRA',
    bedrooms: 2,
    bathrooms: 2,
    annualRentNgn: 2_400_000,
    outrightPriceNgn: 2_400_000,
    installmentBasePriceNgn: 2_640_000,
    description:
      'A fictional two bedroom apartment used for local development. Submitted but not yet reviewed, so the admin queue is never empty.',
    photos: listingPhotos(7),
    status: 'pending_review',
    trustScore: 50,
    hasVerifiedInspection: false,
  },
  {
    id: seedId(GROUP.listing, 8),
    whistleblowerId: USER_IDS.tenant2,
    address: '2 Almandine Drive, Banana Island, Lagos',
    city: 'Lagos',
    area: 'Banana Island',
    bedrooms: 5,
    bathrooms: 5,
    annualRentNgn: 15_000_000,
    outrightPriceNgn: 15_000_000,
    installmentBasePriceNgn: 16_500_000,
    description:
      'A fictional five bedroom penthouse used for local development. Already rented, so listing search has an inactive row to filter out.',
    photos: listingPhotos(8, [...STANDARD_PHOTOS, 'pool']),
    status: 'rented',
    trustScore: 88,
    hasVerifiedInspection: true,
  },
]

export const LISTING_IDS = {
  lekki: SEED_LISTINGS[0].id,
  wuse: SEED_LISTINGS[1].id,
  ikoyi: SEED_LISTINGS[2].id,
  yaba: SEED_LISTINGS[3].id,
  victoriaIsland: SEED_LISTINGS[4].id,
  gwarimpa: SEED_LISTINGS[5].id,
  ikejaPending: SEED_LISTINGS[6].id,
  bananaIslandRented: SEED_LISTINGS[7].id,
} as const

export interface SeedDeal {
  id: string
  tenantId: string
  landlordId: string
  listingId: string
  annualRentNgn: number
  depositNgn: number
  financedAmountNgn: number
  termMonths: number
  status: 'draft' | 'active' | 'completed' | 'defaulted'
  /** Months before the current month that the first instalment fell due. */
  startedMonthsAgo: number
  /** Number of instalments already settled. */
  paidInstalments: number
  /** Instalments that are past due and unpaid. */
  overdueInstalments: number
}

export const SEED_DEALS: SeedDeal[] = [
  {
    id: seedId(GROUP.deal, 1),
    tenantId: USER_IDS.tenant1,
    landlordId: USER_IDS.landlord1,
    listingId: LISTING_IDS.lekki,
    annualRentNgn: 3_500_000,
    depositNgn: 700_000,
    financedAmountNgn: 2_800_000,
    termMonths: 12,
    status: 'active',
    startedMonthsAgo: 4,
    paidInstalments: 3,
    overdueInstalments: 1,
  },
  {
    id: seedId(GROUP.deal, 2),
    tenantId: USER_IDS.tenant2,
    landlordId: USER_IDS.landlord2,
    listingId: LISTING_IDS.victoriaIsland,
    annualRentNgn: 5_500_000,
    depositNgn: 1_100_000,
    financedAmountNgn: 4_400_000,
    termMonths: 6,
    status: 'completed',
    startedMonthsAgo: 8,
    paidInstalments: 6,
    overdueInstalments: 0,
  },
]

export const DEAL_IDS = {
  activeLekki: SEED_DEALS[0].id,
  completedVictoriaIsland: SEED_DEALS[1].id,
} as const

export interface SeedInstalment {
  /** Deterministic repayment_schedule.id. */
  id: string
  dealId: string
  period: number
  dueDate: Date
  amountNgn: number
  principalNgn: number
  interestNgn: number
  /** tenant_deal_schedules.status */
  scheduleStatus: 'upcoming' | 'due' | 'paid' | 'late'
  /** repayment_schedule.status */
  repaymentStatus: 'pending' | 'paid' | 'overdue' | 'waived'
  paidAt: Date | null
}

/** First day of the month containing `now`, in UTC. */
function startOfMonthUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
}

function addMonthsUtc(date: Date, months: number): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, date.getUTCDate()),
  )
}

/**
 * Builds a deal's instalment history. Amounts and statuses are fixed; only the
 * due dates move, anchored to the first of the current month so a freshly
 * seeded database always shows a plausible mix of settled, due and upcoming
 * payments rather than a calendar stuck in the past.
 */
export function buildInstalments(
  deal: SeedDeal,
  now: Date,
  dealIndex: number,
): SeedInstalment[] {
  const firstDue = addMonthsUtc(startOfMonthUtc(now), -deal.startedMonthsAgo)
  const monthly = Math.round(deal.financedAmountNgn / deal.termMonths)
  // A flat 10% of each instalment is treated as interest for display purposes.
  const interest = Math.round(monthly * 0.1)
  const principal = monthly - interest

  return Array.from({ length: deal.termMonths }, (_, i) => {
    const period = i + 1
    const dueDate = addMonthsUtc(firstDue, i)
    const isPaid = period <= deal.paidInstalments
    const isOverdue =
      !isPaid && period <= deal.paidInstalments + deal.overdueInstalments
    const isDue = !isPaid && !isOverdue && period === deal.paidInstalments + deal.overdueInstalments + 1

    return {
      id: seedId(GROUP.repayment, dealIndex * 100 + period),
      dealId: deal.id,
      period,
      dueDate,
      amountNgn: monthly,
      principalNgn: principal,
      interestNgn: interest,
      scheduleStatus: isPaid ? 'paid' : isOverdue ? 'late' : isDue ? 'due' : 'upcoming',
      repaymentStatus: isPaid ? 'paid' : isOverdue ? 'overdue' : 'pending',
      paidAt: isPaid ? dueDate : null,
    }
  })
}

export interface SeedInspectionJob {
  id: string
  listingId: string
  inspectorId: string | null
  status: 'available' | 'claimed' | 'in_progress' | 'submitted' | 'approved' | 'rejected'
  offeredFeeNgn: number
}

export const SEED_INSPECTION_JOBS: SeedInspectionJob[] = [
  {
    id: seedId(GROUP.inspectionJob, 1),
    listingId: LISTING_IDS.lekki,
    inspectorId: USER_IDS.inspector,
    status: 'approved',
    offeredFeeNgn: 25_000,
  },
  {
    id: seedId(GROUP.inspectionJob, 2),
    listingId: LISTING_IDS.ikejaPending,
    inspectorId: null,
    status: 'available',
    offeredFeeNgn: 20_000,
  },
  {
    id: seedId(GROUP.inspectionJob, 3),
    listingId: LISTING_IDS.gwarimpa,
    inspectorId: USER_IDS.inspector,
    status: 'in_progress',
    offeredFeeNgn: 22_500,
  },
]

export interface SeedTenantApplication {
  id: string
  userId: string
  propertyId: number
  propertyTitle: string
  propertyLocation: string
  annualRent: number
  deposit: number
  duration: number
  totalAmount: number
  monthlyPayment: number
  status: 'pending' | 'approved' | 'rejected' | 'cancelled'
}

export const SEED_TENANT_APPLICATIONS: SeedTenantApplication[] = [
  {
    id: 'APP-SEED-0001',
    userId: USER_IDS.tenant1,
    propertyId: 1,
    propertyTitle: '3 Bedroom Serviced Apartment',
    propertyLocation: 'Lekki Phase 1, Lagos',
    annualRent: 3_500_000,
    deposit: 700_000,
    duration: 12,
    totalAmount: 2_800_000,
    monthlyPayment: 233_333,
    status: 'approved',
  },
  {
    id: 'APP-SEED-0002',
    userId: USER_IDS.tenant2,
    propertyId: 5,
    propertyTitle: '3 Bedroom Executive Apartment',
    propertyLocation: 'Victoria Island, Lagos',
    annualRent: 5_500_000,
    deposit: 1_100_000,
    duration: 6,
    totalAmount: 4_400_000,
    monthlyPayment: 733_333,
    status: 'pending',
  },
]

export const SEED_INSPECTOR_PROFILE = {
  userId: USER_IDS.inspector,
  verificationStatus: 'verified' as const,
  bio: 'Fictional inspector account used for local development.',
  serviceAreas: ['Lagos', 'Abuja'],
  completedInspections: 12,
}
