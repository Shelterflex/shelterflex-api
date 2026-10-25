/**
 * Repayment mandates: the automatic bank deduction set up for a deal before the
 * tenant is accepted. Every deal repays this way, so there is no opt-out; this
 * only records which account it draws from and whether it is live.
 *
 * Only the last four digits of the account number are kept. The provider's
 * mandate reference is what actually authorises each debit.
 */

import { getPool } from '../db.js'

export type MandateStatus = 'pending' | 'active' | 'failed' | 'cancelled'

export interface RepaymentMandate {
  dealId: string
  bankName: string
  accountName: string
  accountLast4: string
  /** Day of the month each installment is debited (1-28). */
  deductionDay: number
  status: MandateStatus
  /** The payment provider's id for the mandate; null until the provider authorises it. */
  providerReference: string | null
  createdAt: string
  updatedAt: string
}

export interface CreateMandateInput {
  dealId: string
  bankName: string
  accountName: string
  accountLast4: string
  deductionDay: number
  providerReference: string | null
  status?: MandateStatus
}

export interface RepaymentMandateStore {
  upsert(input: CreateMandateInput): Promise<RepaymentMandate>
  findByDealId(dealId: string): Promise<RepaymentMandate | null>
  updateStatus(dealId: string, status: MandateStatus): Promise<RepaymentMandate | null>
  clear(): Promise<void>
}

export class InMemoryRepaymentMandateStore implements RepaymentMandateStore {
  private mandates = new Map<string, RepaymentMandate>()

  async upsert(input: CreateMandateInput): Promise<RepaymentMandate> {
    const now = new Date().toISOString()
    const existing = this.mandates.get(input.dealId)
    const mandate: RepaymentMandate = {
      dealId: input.dealId,
      bankName: input.bankName,
      accountName: input.accountName,
      accountLast4: input.accountLast4,
      deductionDay: input.deductionDay,
      status: input.status ?? 'pending',
      providerReference: input.providerReference,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }
    this.mandates.set(input.dealId, mandate)
    return mandate
  }

  async findByDealId(dealId: string): Promise<RepaymentMandate | null> {
    return this.mandates.get(dealId) ?? null
  }

  async updateStatus(dealId: string, status: MandateStatus): Promise<RepaymentMandate | null> {
    const existing = this.mandates.get(dealId)
    if (!existing) return null
    const updated = { ...existing, status, updatedAt: new Date().toISOString() }
    this.mandates.set(dealId, updated)
    return updated
  }

  async clear(): Promise<void> {
    this.mandates.clear()
  }
}

function mandateFromRow(row: Record<string, unknown>): RepaymentMandate {
  return {
    dealId: row.deal_id as string,
    bankName: row.bank_name as string,
    accountName: row.account_name as string,
    accountLast4: row.account_last4 as string,
    deductionDay: Number(row.deduction_day),
    status: row.status as MandateStatus,
    providerReference: (row.provider_reference as string | null) ?? null,
    createdAt: new Date(row.created_at as string).toISOString(),
    updatedAt: new Date(row.updated_at as string).toISOString(),
  }
}

/** Postgres when a database is configured, otherwise memory (development and tests). */
export class HybridRepaymentMandateStore implements RepaymentMandateStore {
  private memory = new InMemoryRepaymentMandateStore()

  async upsert(input: CreateMandateInput): Promise<RepaymentMandate> {
    const pool = await getPool()
    if (!pool) return this.memory.upsert(input)
    const { rows } = await pool.query(
      `INSERT INTO repayment_mandates
         (deal_id, bank_name, account_name, account_last4, deduction_day, status, provider_reference)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (deal_id) DO UPDATE SET
         bank_name = $2, account_name = $3, account_last4 = $4, deduction_day = $5,
         status = $6, provider_reference = $7, updated_at = NOW()
       RETURNING *`,
      [
        input.dealId,
        input.bankName,
        input.accountName,
        input.accountLast4,
        input.deductionDay,
        input.status ?? 'pending',
        input.providerReference,
      ],
    )
    return mandateFromRow(rows[0])
  }

  async findByDealId(dealId: string): Promise<RepaymentMandate | null> {
    const pool = await getPool()
    if (!pool) return this.memory.findByDealId(dealId)
    const { rows } = await pool.query(`SELECT * FROM repayment_mandates WHERE deal_id = $1`, [dealId])
    return rows[0] ? mandateFromRow(rows[0]) : null
  }

  async updateStatus(dealId: string, status: MandateStatus): Promise<RepaymentMandate | null> {
    const pool = await getPool()
    if (!pool) return this.memory.updateStatus(dealId, status)
    const { rows } = await pool.query(
      `UPDATE repayment_mandates SET status = $2, updated_at = NOW() WHERE deal_id = $1 RETURNING *`,
      [dealId, status],
    )
    return rows[0] ? mandateFromRow(rows[0]) : null
  }

  async clear(): Promise<void> {
    const pool = await getPool()
    if (pool) await pool.query(`DELETE FROM repayment_mandates`)
    await this.memory.clear()
  }
}

let repaymentMandateStore: RepaymentMandateStore = new HybridRepaymentMandateStore()

export function initRepaymentMandateStore(store: RepaymentMandateStore): void {
  repaymentMandateStore = store
}

export function getRepaymentMandateStore(): RepaymentMandateStore {
  return repaymentMandateStore
}
