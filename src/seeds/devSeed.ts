/**
 * Development seed.
 *
 * `seedDevData` performs every write through the client it is handed and never
 * issues BEGIN/COMMIT itself — the caller owns the transaction, so a failure at
 * any point rolls the whole seed back and leaves the database untouched.
 *
 * Every statement is an upsert keyed on a deterministic id, so running the seed
 * repeatedly refreshes the same rows instead of duplicating them.
 */
import {
  buildInstalments,
  SEED_DEALS,
  SEED_INSPECTION_JOBS,
  SEED_INSPECTOR_PROFILE,
  SEED_LANDLORD_PROFILES,
  SEED_LANDLORD_PROPERTIES,
  SEED_LISTINGS,
  SEED_TENANT_APPLICATIONS,
  SEED_USERS,
  USER_IDS,
} from './devData.js'

export interface SeedClient {
  query: (text: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount: number }>
}

/** Stages, in execution order. `--simulate-failure=<stage>` throws after one. */
export const SEED_STAGES = [
  'users',
  'properties',
  'listings',
  'deals',
  'inspections',
  'applications',
] as const

export type SeedStage = (typeof SEED_STAGES)[number]

export interface SeedOptions {
  /** Anchor for generated payment dates. Defaults to the current time. */
  now?: Date
  /** Throw after this stage completes, to prove the transaction rolls back. */
  simulateFailureAfter?: SeedStage
  log?: (message: string) => void
}

export type SeedSummary = Record<string, number>

export class SeedDataError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SeedDataError'
  }
}

/**
 * Fails early and clearly when a non-seed row already owns a seeded email.
 * Without this the transaction would abort on a bare unique-violation from
 * Postgres, which tells a new contributor nothing useful.
 */
async function assertNoConflictingUsers(client: SeedClient): Promise<void> {
  const { rows } = await client.query(
    `SELECT email FROM users WHERE email = ANY($1::text[]) AND NOT (id = ANY($2::uuid[]))`,
    [SEED_USERS.map((u) => u.email), SEED_USERS.map((u) => u.id)],
  )

  if (rows.length > 0) {
    const emails = rows.map((row: { email: string }) => row.email).join(', ')
    throw new SeedDataError(
      `These seed email addresses are already taken by non-seed users: ${emails}. ` +
        'Delete those rows (or run `npm run db:reset`) and seed again.',
    )
  }
}

async function seedUsers(client: SeedClient): Promise<SeedSummary> {
  await assertNoConflictingUsers(client)

  for (const user of SEED_USERS) {
    await client.query(
      `INSERT INTO users (id, email, name, role)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE
       SET email = EXCLUDED.email,
           name = EXCLUDED.name,
           role = EXCLUDED.role,
           deleted_at = NULL,
           deactivated_at = NULL,
           updated_at = NOW()`,
      [user.id, user.email, user.name, user.role],
    )
  }

  // Admin dashboards authorise against user_roles, not users.role.
  let adminGrants = 0
  for (const user of SEED_USERS) {
    if (!user.adminRole) continue
    await client.query(
      `INSERT INTO roles (name, description)
       VALUES ($1, 'Implicitly has all permissions and full administrative rights')
       ON CONFLICT (name) DO NOTHING`,
      [user.adminRole],
    )
    await client.query(
      `INSERT INTO user_roles (user_id, role_id)
       SELECT $1, r.id FROM roles r WHERE r.name = $2
       ON CONFLICT (user_id, role_id) DO NOTHING`,
      [user.id, user.adminRole],
    )
    adminGrants++
  }

  for (const profile of SEED_LANDLORD_PROFILES) {
    await client.query(
      `INSERT INTO landlord_profiles (
         user_id, phone, address, company_name, bank_name, account_number,
         account_name, verification_level, verified_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
       ON CONFLICT (user_id) DO UPDATE
       SET phone = EXCLUDED.phone,
           address = EXCLUDED.address,
           company_name = EXCLUDED.company_name,
           bank_name = EXCLUDED.bank_name,
           account_number = EXCLUDED.account_number,
           account_name = EXCLUDED.account_name,
           verification_level = EXCLUDED.verification_level,
           deleted_at = NULL,
           updated_at = NOW()`,
      [
        profile.userId,
        profile.phone,
        profile.address,
        profile.companyName,
        profile.bankName,
        profile.accountNumber,
        profile.accountName,
        profile.verificationLevel,
      ],
    )
  }

  await client.query(
    `INSERT INTO inspector_profiles (user_id, verification_status, bio, service_areas, completed_inspections)
     VALUES ($1, $2, $3, $4::jsonb, $5)
     ON CONFLICT (user_id) DO UPDATE
     SET verification_status = EXCLUDED.verification_status,
         bio = EXCLUDED.bio,
         service_areas = EXCLUDED.service_areas,
         completed_inspections = EXCLUDED.completed_inspections,
         updated_at = NOW()`,
    [
      SEED_INSPECTOR_PROFILE.userId,
      SEED_INSPECTOR_PROFILE.verificationStatus,
      SEED_INSPECTOR_PROFILE.bio,
      JSON.stringify(SEED_INSPECTOR_PROFILE.serviceAreas),
      SEED_INSPECTOR_PROFILE.completedInspections,
    ],
  )

  return {
    users: SEED_USERS.length,
    user_roles: adminGrants,
    landlord_profiles: SEED_LANDLORD_PROFILES.length,
    inspector_profiles: 1,
  }
}

async function seedProperties(client: SeedClient): Promise<SeedSummary> {
  let photoCount = 0

  for (const property of SEED_LANDLORD_PROPERTIES) {
    await client.query(
      `INSERT INTO landlord_properties (
         id, landlord_id, title, address, city, area, bedrooms, bathrooms, sqm,
         annual_rent_ngn, outright_price_ngn, installment_base_price_ngn,
         description, photos, amenities, property_type, status, views, inquiries,
         primary_photo_index
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb,
         $15::jsonb, $16, $17, $18, $19, 0
       )
       ON CONFLICT (id) DO UPDATE
       SET landlord_id = EXCLUDED.landlord_id,
           title = EXCLUDED.title,
           address = EXCLUDED.address,
           city = EXCLUDED.city,
           area = EXCLUDED.area,
           bedrooms = EXCLUDED.bedrooms,
           bathrooms = EXCLUDED.bathrooms,
           sqm = EXCLUDED.sqm,
           annual_rent_ngn = EXCLUDED.annual_rent_ngn,
           outright_price_ngn = EXCLUDED.outright_price_ngn,
           installment_base_price_ngn = EXCLUDED.installment_base_price_ngn,
           description = EXCLUDED.description,
           photos = EXCLUDED.photos,
           amenities = EXCLUDED.amenities,
           property_type = EXCLUDED.property_type,
           status = EXCLUDED.status,
           views = EXCLUDED.views,
           inquiries = EXCLUDED.inquiries,
           deleted_at = NULL,
           updated_at = NOW()`,
      [
        property.id,
        property.landlordId,
        property.title,
        property.address,
        property.city,
        property.area,
        property.bedrooms,
        property.bathrooms,
        property.sqm,
        property.annualRentNgn,
        property.outrightPriceNgn,
        property.installmentBasePriceNgn,
        property.description,
        JSON.stringify(property.photos.map((photo) => photo.url)),
        JSON.stringify(property.amenities),
        property.propertyType,
        property.status,
        property.views,
        property.inquiries,
      ],
    )

    for (const photo of property.photos) {
      await client.query(
        `INSERT INTO property_photos (
           id, property_id, url, order_index, is_featured, file_name, mime_type
         ) VALUES ($1, $2, $3, $4, $5, $6, 'image/jpeg')
         ON CONFLICT (id) DO UPDATE
         SET property_id = EXCLUDED.property_id,
             url = EXCLUDED.url,
             order_index = EXCLUDED.order_index,
             is_featured = EXCLUDED.is_featured,
             file_name = EXCLUDED.file_name,
             deleted_at = NULL`,
        [photo.id, property.id, photo.url, photo.orderIndex, photo.isFeatured, photo.fileName],
      )
      photoCount++
    }
  }

  return {
    landlord_properties: SEED_LANDLORD_PROPERTIES.length,
    property_photos: photoCount,
  }
}

async function seedListings(client: SeedClient): Promise<SeedSummary> {
  for (const listing of SEED_LISTINGS) {
    await client.query(
      `INSERT INTO whistleblower_listings (
         listing_id, whistleblower_id, address, city, area, bedrooms, bathrooms,
         annual_rent_ngn, outright_price_ngn, installment_base_price_ngn,
         description, photos, status, trust_score, has_verified_inspection,
         reviewed_by, reviewed_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $14, $15,
         $16, CASE WHEN $13 = 'pending_review' THEN NULL ELSE NOW() END
       )
       ON CONFLICT (listing_id) DO UPDATE
       SET whistleblower_id = EXCLUDED.whistleblower_id,
           address = EXCLUDED.address,
           city = EXCLUDED.city,
           area = EXCLUDED.area,
           bedrooms = EXCLUDED.bedrooms,
           bathrooms = EXCLUDED.bathrooms,
           annual_rent_ngn = EXCLUDED.annual_rent_ngn,
           outright_price_ngn = EXCLUDED.outright_price_ngn,
           installment_base_price_ngn = EXCLUDED.installment_base_price_ngn,
           description = EXCLUDED.description,
           photos = EXCLUDED.photos,
           status = EXCLUDED.status,
           trust_score = EXCLUDED.trust_score,
           has_verified_inspection = EXCLUDED.has_verified_inspection,
           deleted_at = NULL,
           updated_at = NOW()`,
      [
        listing.id,
        listing.whistleblowerId,
        listing.address,
        listing.city,
        listing.area,
        listing.bedrooms,
        listing.bathrooms,
        listing.annualRentNgn,
        listing.outrightPriceNgn,
        listing.installmentBasePriceNgn,
        listing.description,
        JSON.stringify(listing.photos),
        listing.status,
        listing.trustScore,
        listing.hasVerifiedInspection,
        listing.status === 'pending_review' ? null : USER_IDS.admin,
      ],
    )
  }

  return { whistleblower_listings: SEED_LISTINGS.length }
}

async function seedDeals(client: SeedClient, now: Date): Promise<SeedSummary> {
  let scheduleRows = 0
  let repaymentRows = 0

  for (const [index, deal] of SEED_DEALS.entries()) {
    await client.query(
      `INSERT INTO tenant_deals (
         deal_id, tenant_id, landlord_id, listing_id, annual_rent_ngn,
         deposit_ngn, financed_amount_ngn, term_months, status
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (deal_id) DO UPDATE
       SET tenant_id = EXCLUDED.tenant_id,
           landlord_id = EXCLUDED.landlord_id,
           listing_id = EXCLUDED.listing_id,
           annual_rent_ngn = EXCLUDED.annual_rent_ngn,
           deposit_ngn = EXCLUDED.deposit_ngn,
           financed_amount_ngn = EXCLUDED.financed_amount_ngn,
           term_months = EXCLUDED.term_months,
           status = EXCLUDED.status,
           deleted_at = NULL,
           updated_at = NOW()`,
      [
        deal.id,
        deal.tenantId,
        deal.landlordId,
        deal.listingId,
        deal.annualRentNgn,
        deal.depositNgn,
        deal.financedAmountNgn,
        deal.termMonths,
        deal.status,
      ],
    )

    for (const instalment of buildInstalments(deal, now, index + 1)) {
      await client.query(
        `INSERT INTO tenant_deal_schedules (deal_id, period, due_date, amount_ngn, status)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (deal_id, period) DO UPDATE
         SET due_date = EXCLUDED.due_date,
             amount_ngn = EXCLUDED.amount_ngn,
             status = EXCLUDED.status,
             updated_at = NOW()`,
        [
          instalment.dealId,
          instalment.period,
          instalment.dueDate,
          instalment.amountNgn,
          instalment.scheduleStatus,
        ],
      )
      scheduleRows++

      await client.query(
        `INSERT INTO repayment_schedule (
           id, deal_id, payment_number, due_date, principal_amount_ngn,
           interest_amount_ngn, total_amount_ngn, status, paid_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (deal_id, payment_number) DO UPDATE
         SET due_date = EXCLUDED.due_date,
             principal_amount_ngn = EXCLUDED.principal_amount_ngn,
             interest_amount_ngn = EXCLUDED.interest_amount_ngn,
             total_amount_ngn = EXCLUDED.total_amount_ngn,
             status = EXCLUDED.status,
             paid_at = EXCLUDED.paid_at,
             updated_at = NOW()`,
        [
          instalment.id,
          instalment.dealId,
          instalment.period,
          instalment.dueDate,
          instalment.principalNgn,
          instalment.interestNgn,
          instalment.amountNgn,
          instalment.repaymentStatus,
          instalment.paidAt,
        ],
      )
      repaymentRows++
    }
  }

  return {
    tenant_deals: SEED_DEALS.length,
    tenant_deal_schedules: scheduleRows,
    repayment_schedule: repaymentRows,
  }
}

async function seedInspections(client: SeedClient): Promise<SeedSummary> {
  for (const job of SEED_INSPECTION_JOBS) {
    await client.query(
      `INSERT INTO inspection_jobs (
         id, listing_id, inspector_id, status, offered_fee_ngn, submitted_at, approved_at
       ) VALUES (
         $1, $2, $3, $4, $5,
         CASE WHEN $4 IN ('submitted', 'approved') THEN NOW() ELSE NULL END,
         CASE WHEN $4 = 'approved' THEN NOW() ELSE NULL END
       )
       ON CONFLICT (id) DO UPDATE
       SET listing_id = EXCLUDED.listing_id,
           inspector_id = EXCLUDED.inspector_id,
           status = EXCLUDED.status,
           offered_fee_ngn = EXCLUDED.offered_fee_ngn,
           updated_at = NOW()`,
      [job.id, job.listingId, job.inspectorId, job.status, job.offeredFeeNgn],
    )
  }

  return { inspection_jobs: SEED_INSPECTION_JOBS.length }
}

async function seedApplications(client: SeedClient): Promise<SeedSummary> {
  for (const application of SEED_TENANT_APPLICATIONS) {
    await client.query(
      `INSERT INTO tenant_applications (
         id, user_id, property_id, property_title, property_location, annual_rent,
         deposit, duration, total_amount, monthly_payment, status, has_agreed_to_terms
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, true)
       ON CONFLICT (id) DO UPDATE
       SET user_id = EXCLUDED.user_id,
           property_id = EXCLUDED.property_id,
           property_title = EXCLUDED.property_title,
           property_location = EXCLUDED.property_location,
           annual_rent = EXCLUDED.annual_rent,
           deposit = EXCLUDED.deposit,
           duration = EXCLUDED.duration,
           total_amount = EXCLUDED.total_amount,
           monthly_payment = EXCLUDED.monthly_payment,
           status = EXCLUDED.status,
           deleted_at = NULL,
           updated_at = NOW()`,
      [
        application.id,
        application.userId,
        application.propertyId,
        application.propertyTitle,
        application.propertyLocation,
        application.annualRent,
        application.deposit,
        application.duration,
        application.totalAmount,
        application.monthlyPayment,
        application.status,
      ],
    )
  }

  return { tenant_applications: SEED_TENANT_APPLICATIONS.length }
}

/**
 * Writes the full development dataset using the supplied client. The caller is
 * responsible for the surrounding transaction.
 */
export async function seedDevData(
  client: SeedClient,
  options: SeedOptions = {},
): Promise<SeedSummary> {
  const { now = new Date(), simulateFailureAfter, log = () => {} } = options

  const stages: Array<[SeedStage, () => Promise<SeedSummary>]> = [
    ['users', () => seedUsers(client)],
    ['properties', () => seedProperties(client)],
    ['listings', () => seedListings(client)],
    ['deals', () => seedDeals(client, now)],
    ['inspections', () => seedInspections(client)],
    ['applications', () => seedApplications(client)],
  ]

  const summary: SeedSummary = {}

  for (const [stage, run] of stages) {
    const counts = await run()
    Object.assign(summary, counts)
    log(
      `  ${stage}: ${Object.entries(counts)
        .map(([table, count]) => `${table}=${count}`)
        .join(' ')}`,
    )

    if (simulateFailureAfter === stage) {
      throw new SeedDataError(
        `Injected failure after the "${stage}" stage (--simulate-failure). ` +
          'The transaction will roll back and nothing should be written.',
      )
    }
  }

  return summary
}
