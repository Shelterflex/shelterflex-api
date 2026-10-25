-- Migration 054: apartment viewings
--
-- A tenant books a viewing of a listing; the whistleblower who listed it accepts
-- it. Viewings are daytime only, arranged in-app (no phone numbers or emails are
-- shared), and viewings with a first-time reporter need a Shelterflex inspector
-- to claim them before they are confirmed.

CREATE TABLE IF NOT EXISTS viewings (
    viewing_id TEXT PRIMARY KEY,
    listing_id TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    whistleblower_id TEXT NOT NULL,
    starts_at TIMESTAMP WITH TIME ZONE NOT NULL,
    requires_inspector BOOLEAN NOT NULL DEFAULT FALSE,
    inspector_id TEXT,
    whistleblower_accepted BOOLEAN NOT NULL DEFAULT FALSE,
    state TEXT NOT NULL DEFAULT 'open',
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_viewings_tenant ON viewings (tenant_id);
CREATE INDEX IF NOT EXISTS idx_viewings_whistleblower ON viewings (whistleblower_id);
CREATE INDEX IF NOT EXISTS idx_viewings_listing ON viewings (listing_id);
