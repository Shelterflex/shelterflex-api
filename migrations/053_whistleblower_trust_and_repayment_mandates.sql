-- Migration 053: persistent whistleblower identity/safety records and repayment mandates
--
-- These were in-memory stores, so every restart forgot who had verified their
-- identity, who was suspended after safety reports, and which bank account each
-- deal repays from.

CREATE TABLE IF NOT EXISTS whistleblower_identities (
    user_id TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'unverified',
    reference TEXT,
    verified_at TIMESTAMP WITH TIME ZONE,
    consent_at TIMESTAMP WITH TIME ZONE,
    failed_attempts JSONB NOT NULL DEFAULT '[]',
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS whistleblower_safety_reports (
    report_id TEXT PRIMARY KEY,
    whistleblower_id TEXT NOT NULL,
    reporter_id TEXT NOT NULL,
    listing_id TEXT,
    details TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wb_safety_reports_whistleblower
    ON whistleblower_safety_reports (whistleblower_id);

CREATE TABLE IF NOT EXISTS whistleblower_suspensions (
    user_id TEXT PRIMARY KEY,
    reason TEXT NOT NULL,
    suspended_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS repayment_mandates (
    deal_id TEXT PRIMARY KEY,
    bank_name TEXT NOT NULL,
    account_name TEXT NOT NULL,
    account_last4 VARCHAR(4) NOT NULL,
    deduction_day INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    provider_reference TEXT,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
