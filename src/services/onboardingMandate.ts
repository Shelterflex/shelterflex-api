import { getPool } from '../db.js'
import { getRepaymentMandateStore, type RepaymentMandate } from '../models/repaymentMandateStore.js'
import type { RepaymentInfo } from '../schemas/onboarding.js'
import { logger } from '../utils/logger.js'

/**
 * Opens the deal's automatic-deduction mandate from the account the tenant
 * authorised during onboarding. It starts "pending" until the payment provider
 * confirms the authorisation. Returns null if the tenant has none on file.
 */
export async function openMandateFromOnboarding(
  dealId: string,
  tenantId: string,
): Promise<RepaymentMandate | null> {
  const pool = await getPool()
  if (!pool) return null

  const { rows } = await pool.query(
    `SELECT repayment_info FROM onboarding_drafts WHERE user_id = $1`,
    [tenantId],
  )
  const info = rows[0]?.repayment_info as RepaymentInfo | null | undefined
  if (!info) {
    logger.warn('deal.mandate_no_onboarding_account', { dealId, tenantId })
    return null
  }

  return getRepaymentMandateStore().upsert({
    dealId,
    bankName: info.bankName,
    accountName: info.accountName,
    accountLast4: info.accountLast4,
    deductionDay: info.deductionDay,
    providerReference: null,
    status: 'pending',
  })
}
