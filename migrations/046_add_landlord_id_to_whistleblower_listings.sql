-- Add landlord_id to whistleblower_listings to resolve listing ownership
-- This fixes issue #19 where listing applications use a hardcoded placeholder landlord

-- Add landlord_id column
ALTER TABLE whistleblower_listings
  ADD COLUMN IF NOT EXISTS landlord_id TEXT;

-- Create index for efficient lookups
CREATE INDEX IF NOT EXISTS whistleblower_listings_landlord_id_idx
  ON whistleblower_listings (landlord_id)
  WHERE landlord_id IS NOT NULL;

-- Add comment documenting the ownership model
COMMENT ON COLUMN whistleblower_listings.landlord_id IS
  'The landlord who owns this property. Populated when a listing is created from landlord_properties via sync.
   Whistleblower-reported listings may have NULL landlord_id until claimed by a landlord.';
