-- Migration 050: tables for cached credit bureau reports and listing applications
--
-- creditBureauReportStore and ListingApplicationRepository query these tables,
-- but they were only ever defined in src/migrations/001-features-961-965.ts,
-- which the migration runner never executes (it applies migrations/*.sql).
-- Without them both features fail against a real database.

CREATE TABLE IF NOT EXISTS credit_bureau_reports (
    id UUID PRIMARY KEY,
    tenant_id VARCHAR(255) NOT NULL,
    bvn VARCHAR(255) NOT NULL,
    nin VARCHAR(255) NOT NULL,
    report JSONB NOT NULL,
    cached_at TIMESTAMP NOT NULL,
    expires_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP NOT NULL,
    updated_at TIMESTAMP NOT NULL,
    CONSTRAINT credit_bureau_reports_tenant_expiry_unique UNIQUE (tenant_id, expires_at)
);

CREATE INDEX IF NOT EXISTS idx_credit_bureau_reports_tenant_id ON credit_bureau_reports (tenant_id);
CREATE INDEX IF NOT EXISTS idx_credit_bureau_reports_expires_at ON credit_bureau_reports (expires_at);

CREATE TABLE IF NOT EXISTS listing_applications (
    id UUID PRIMARY KEY,
    listing_id VARCHAR(255) NOT NULL,
    tenant_id VARCHAR(255) NOT NULL,
    landlord_id VARCHAR(255) NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'pending',
    cover_note TEXT,
    preferred_start_date DATE NOT NULL,
    payment_plan VARCHAR(50) NOT NULL,
    applied_at TIMESTAMP NOT NULL,
    reviewed_at TIMESTAMP,
    reviewed_by VARCHAR(255),
    reviewer_notes TEXT,
    created_at TIMESTAMP NOT NULL,
    updated_at TIMESTAMP NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_listing_applications_listing_id ON listing_applications (listing_id);
CREATE INDEX IF NOT EXISTS idx_listing_applications_tenant_id ON listing_applications (tenant_id);
CREATE INDEX IF NOT EXISTS idx_listing_applications_status ON listing_applications (status);

-- One live application per tenant per listing; a rejected one may be retried.
CREATE UNIQUE INDEX IF NOT EXISTS idx_listing_applications_unique_active
    ON listing_applications (tenant_id, listing_id)
    WHERE status != 'rejected';
