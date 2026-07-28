-- Add landlord_id to whistleblower_listings to resolve listing ownership
-- This fixes issue #19 where listing applications use a hardcoded placeholder landlord

-- Add landlord_id column
ALTER TABLE whistleblower_listings
  ADD COLUMN IF NOT EXISTS landlord_id TEXT;

-- Create index for efficient lookups
CREATE INDEX IF NOT EXISTS whistleblower_listings_landlord_id_idx
  ON whistleblower_listings (landlord_id)
  WHERE landlord_id IS NOT NULL;

-- Backfill: resolve landlord_id from landlord_properties where listing_id matches
UPDATE whistleblower_listings wl
SET landlord_id = lp.landlord_id::TEXT
FROM landlord_properties lp
WHERE wl.listing_id = lp.listing_id
  AND wl.landlord_id IS NULL;

-- Mark existing placeholder-landlord applications as invalid where landlord cannot be resolved
-- These applications will need to be resubmitted by tenants
UPDATE listing_applications
SET status = 'invalid',
    reviewer_notes = 'Auto-marked invalid during migration: landlord could not be resolved from listing'
WHERE landlord_id = 'placeholder-landlord'
  AND listing_id IN (
    SELECT listing_id FROM whistleblower_listings WHERE landlord_id IS NULL
  );

-- For placeholder-landlord applications where landlord CAN be resolved, update them
UPDATE listing_applications la
SET landlord_id = wl.landlord_id
FROM whistleblower_listings wl
WHERE la.listing_id = wl.listing_id::TEXT
  AND la.landlord_id = 'placeholder-landlord'
  AND wl.landlord_id IS NOT NULL;

-- Add comment documenting the ownership model
COMMENT ON COLUMN whistleblower_listings.landlord_id IS 
  'The landlord who owns this property. Populated when a listing is created from landlord_properties via sync. 
   Whistleblower-reported listings may have NULL landlord_id until claimed by a landlord.';
