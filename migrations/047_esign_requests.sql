-- E-signature request persistence for lease signing.
-- Stores signing requests so they survive process restarts when using a real
-- e-signature provider (DocuSeal).  The stub provider ignores this table.

CREATE TABLE IF NOT EXISTS esign_requests (
  request_id    TEXT PRIMARY KEY,
  document_key  TEXT        NOT NULL,
  document_hash TEXT        NOT NULL,
  signers       JSONB       NOT NULL DEFAULT '[]',
  status        TEXT        NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending', 'completed', 'expired')),
  provider_id   TEXT,
  signer_states JSONB       NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_esign_requests_document_key
  ON esign_requests (document_key);

COMMENT ON TABLE esign_requests IS 'E-signature request tracking for lease agreements';
COMMENT ON COLUMN esign_requests.signer_states IS 'Map of signerId -> { signed, providerRecipientId, token, expiresAt }';
COMMENT ON COLUMN esign_requests.provider_id IS 'Provider-assigned document/template ID for status lookups';
