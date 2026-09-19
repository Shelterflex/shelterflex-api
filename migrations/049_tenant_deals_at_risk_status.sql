-- Migration 049: allow 'at_risk' in tenant_deals.status
--
-- DealStatus.AT_RISK ('at_risk') has been used throughout the application
-- (dealStore, latePaymentEscalationService, adminAnalytics, DealStateMachine,
-- salaryDeductionService, platformStatsService) since the late-payment
-- escalation feature was added, but the original CHECK constraint from
-- migration 006 only allowed ('draft', 'active', 'completed', 'defaulted').
-- Any deal reaching the at-risk escalation step fails with:
--   new row for relation "tenant_deals" violates check constraint
--   "tenant_deals_status_check"

ALTER TABLE tenant_deals DROP CONSTRAINT IF EXISTS tenant_deals_status_check;
ALTER TABLE tenant_deals ADD CONSTRAINT tenant_deals_status_check
  CHECK (status IN ('draft', 'active', 'at_risk', 'completed', 'defaulted'));
