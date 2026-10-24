/**
 * Loads the approved demo listings into a deployed database so the public
 * /properties page has something to show.
 *
 * Unlike `npm run db:seed`, which refuses production and writes a full set of
 * fictional users, deals and payments, this touches only whistleblower_listings
 * rows with the fixed seed IDs. Re-running it updates those rows in place.
 *
 * Photo paths are rewritten to absolute URLs under MEDIA_BASE_URL, which should
 * point at this API's /media route (see PUBLIC_MEDIA_DIR):
 *
 *   MEDIA_BASE_URL=https://api.example.com/media node dist/scripts/seedDemoListings.js
 *
 * Pass --remove to delete the demo listings again.
 */
import 'dotenv/config'
import pg from 'pg'
import { SEED_LISTINGS, USER_IDS } from '../seeds/devData.js'

const databaseUrl = process.env.DATABASE_URL
const mediaBaseUrl = process.env.MEDIA_BASE_URL?.replace(/\/$/, '')
const remove = process.argv.includes('--remove')

if (!databaseUrl) {
  console.error('[seed:demo-listings] DATABASE_URL is not set.')
  process.exit(1)
}
if (!remove && !mediaBaseUrl) {
  console.error('[seed:demo-listings] MEDIA_BASE_URL is not set, e.g. https://api.example.com/media')
  process.exit(1)
}

const demoListings = SEED_LISTINGS.filter((listing) => listing.status === 'approved')

async function main() {
  const pool = new pg.Pool({ connectionString: databaseUrl })
  try {
    if (remove) {
      const result = await pool.query(
        'DELETE FROM whistleblower_listings WHERE listing_id = ANY($1::uuid[])',
        [demoListings.map((listing) => listing.id)],
      )
      console.log(`[seed:demo-listings] Removed ${result.rowCount} demo listings.`)
      return
    }

    for (const listing of demoListings) {
      const photos = listing.photos.map((path) => `${mediaBaseUrl}${path}`)
      await pool.query(
        `INSERT INTO whistleblower_listings (
           listing_id, whistleblower_id, address, city, area, bedrooms, bathrooms,
           annual_rent_ngn, outright_price_ngn, installment_base_price_ngn,
           description, photos, status, trust_score, has_verified_inspection,
           reviewed_by, reviewed_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $14, $15, $16, NOW()
         )
         ON CONFLICT (listing_id) DO UPDATE
         SET address = EXCLUDED.address,
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
          JSON.stringify(photos),
          listing.status,
          listing.trustScore,
          listing.hasVerifiedInspection,
          USER_IDS.admin,
        ],
      )
    }
    console.log(`[seed:demo-listings] Upserted ${demoListings.length} demo listings.`)
  } finally {
    await pool.end()
  }
}

main().catch((error: unknown) => {
  console.error('[seed:demo-listings] Failed:', error)
  process.exit(1)
})
