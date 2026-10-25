-- Migration 051: bank account the tenant authorises for automatic rent deduction
--
-- Collected during onboarding, before any deal exists. The account number is
-- stored encrypted (pii:v1 envelope); only the last four digits are kept in the
-- clear. When a deal is created, a repayment mandate is opened from this.

ALTER TABLE onboarding_drafts
  ADD COLUMN IF NOT EXISTS repayment_info JSONB;
