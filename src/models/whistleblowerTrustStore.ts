/**
 * Who has proved their identity, and who has been suspended after safety
 * reports. Stored in Postgres when a database is configured; without one (local
 * development, tests) it keeps them in memory.
 */

import { randomUUID } from 'node:crypto'
import { getPool } from '../db.js'

export type IdentityStatus = 'unverified' | 'verified'

export interface IdentityRecord {
  userId: string
  status: IdentityStatus
  /** The provider's reference for the passing check. */
  reference: string | null
  verifiedAt: string | null
  /** When the user agreed to biometric verification. */
  consentAt: string | null
  /** Timestamps of failed attempts, to cap how often one can retry. */
  failedAttempts: string[]
}

export interface SafetyReport {
  reportId: string
  whistleblowerId: string
  reporterId: string
  listingId: string | null
  details: string
  createdAt: string
}

export interface Suspension {
  userId: string
  reason: string
  suspendedAt: string
}

/** Distinct people who must report a whistleblower before the account is suspended. */
export const SUSPENSION_THRESHOLD = 3
export const MAX_FAILED_ATTEMPTS_PER_DAY = 5

const DAY_MS = 24 * 60 * 60 * 1000

function blankIdentity(userId: string): IdentityRecord {
  return { userId, status: 'unverified', reference: null, verifiedAt: null, consentAt: null, failedAttempts: [] }
}

const iso = (value: unknown): string | null => (value ? new Date(value as string).toISOString() : null)

function identityFromRow(row: Record<string, unknown>): IdentityRecord {
  const attempts = row.failed_attempts
  return {
    userId: row.user_id as string,
    status: row.status as IdentityStatus,
    reference: (row.reference as string | null) ?? null,
    verifiedAt: iso(row.verified_at),
    consentAt: iso(row.consent_at),
    failedAttempts: (typeof attempts === 'string' ? JSON.parse(attempts) : (attempts as string[] | null)) ?? [],
  }
}

function reportFromRow(row: Record<string, unknown>): SafetyReport {
  return {
    reportId: row.report_id as string,
    whistleblowerId: row.whistleblower_id as string,
    reporterId: row.reporter_id as string,
    listingId: (row.listing_id as string | null) ?? null,
    details: row.details as string,
    createdAt: iso(row.created_at)!,
  }
}

class WhistleblowerTrustStore {
  private identities = new Map<string, IdentityRecord>()
  private reports: SafetyReport[] = []
  private suspensions = new Map<string, Suspension>()

  async getIdentity(userId: string): Promise<IdentityRecord> {
    const pool = await getPool()
    if (pool) {
      const { rows } = await pool.query(`SELECT * FROM whistleblower_identities WHERE user_id = $1`, [userId])
      return rows[0] ? identityFromRow(rows[0]) : blankIdentity(userId)
    }
    return this.identities.get(userId) ?? blankIdentity(userId)
  }

  private async saveIdentity(record: IdentityRecord): Promise<void> {
    const pool = await getPool()
    if (pool) {
      await pool.query(
        `INSERT INTO whistleblower_identities
           (user_id, status, reference, verified_at, consent_at, failed_attempts, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())
         ON CONFLICT (user_id) DO UPDATE SET
           status = $2, reference = $3, verified_at = $4, consent_at = $5,
           failed_attempts = $6, updated_at = NOW()`,
        [
          record.userId,
          record.status,
          record.reference,
          record.verifiedAt,
          record.consentAt,
          JSON.stringify(record.failedAttempts),
        ],
      )
      return
    }
    this.identities.set(record.userId, record)
  }

  async recentFailedAttempts(userId: string): Promise<number> {
    const cutoff = Date.now() - DAY_MS
    return (await this.getIdentity(userId)).failedAttempts.filter((t) => Date.parse(t) > cutoff).length
  }

  async recordFailedAttempt(userId: string): Promise<void> {
    const current = await this.getIdentity(userId)
    await this.saveIdentity({ ...current, failedAttempts: [...current.failedAttempts, new Date().toISOString()] })
  }

  async markVerified(userId: string, reference: string): Promise<IdentityRecord> {
    const now = new Date().toISOString()
    const record: IdentityRecord = {
      ...(await this.getIdentity(userId)),
      status: 'verified',
      reference,
      verifiedAt: now,
      consentAt: now,
    }
    await this.saveIdentity(record)
    return record
  }

  async isVerified(userId: string): Promise<boolean> {
    return (await this.getIdentity(userId)).status === 'verified'
  }

  async listReports(whistleblowerId?: string): Promise<SafetyReport[]> {
    const pool = await getPool()
    if (pool) {
      const { rows } = whistleblowerId
        ? await pool.query(
            `SELECT * FROM whistleblower_safety_reports WHERE whistleblower_id = $1 ORDER BY created_at DESC`,
            [whistleblowerId],
          )
        : await pool.query(`SELECT * FROM whistleblower_safety_reports ORDER BY created_at DESC`)
      return rows.map(reportFromRow)
    }
    return this.reports
      .filter((r) => !whistleblowerId || r.whistleblowerId === whistleblowerId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  /** Files a report and suspends the whistleblower once enough different people have reported them. */
  async addSafetyReport(
    input: Omit<SafetyReport, 'reportId' | 'createdAt'>,
  ): Promise<{ report: SafetyReport; suspended: boolean; newlySuspended: boolean }> {
    const report: SafetyReport = { ...input, reportId: randomUUID(), createdAt: new Date().toISOString() }
    const pool = await getPool()
    if (pool) {
      await pool.query(
        `INSERT INTO whistleblower_safety_reports
           (report_id, whistleblower_id, reporter_id, listing_id, details, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [report.reportId, report.whistleblowerId, report.reporterId, report.listingId, report.details, report.createdAt],
      )
    } else {
      this.reports.push(report)
    }

    const reporters = new Set((await this.listReports(input.whistleblowerId)).map((r) => r.reporterId))
    const wasSuspended = await this.isSuspended(input.whistleblowerId)
    if (reporters.size >= SUSPENSION_THRESHOLD && !wasSuspended) {
      await this.suspend(input.whistleblowerId, `${reporters.size} safety reports from different users`)
    }
    const suspended = await this.isSuspended(input.whistleblowerId)
    return { report, suspended, newlySuspended: suspended && !wasSuspended }
  }

  async suspend(userId: string, reason: string): Promise<void> {
    const suspension: Suspension = { userId, reason, suspendedAt: new Date().toISOString() }
    const pool = await getPool()
    if (pool) {
      await pool.query(
        `INSERT INTO whistleblower_suspensions (user_id, reason, suspended_at)
         VALUES ($1, $2, $3) ON CONFLICT (user_id) DO NOTHING`,
        [userId, reason, suspension.suspendedAt],
      )
      return
    }
    if (!this.suspensions.has(userId)) this.suspensions.set(userId, suspension)
  }

  async isSuspended(userId: string): Promise<boolean> {
    const pool = await getPool()
    if (pool) {
      const { rows } = await pool.query(`SELECT 1 FROM whistleblower_suspensions WHERE user_id = $1`, [userId])
      return rows.length > 0
    }
    return this.suspensions.has(userId)
  }

  async listSuspensions(): Promise<Suspension[]> {
    const pool = await getPool()
    if (pool) {
      const { rows } = await pool.query(`SELECT * FROM whistleblower_suspensions ORDER BY suspended_at DESC`)
      return rows.map((r: Record<string, unknown>) => ({
        userId: r.user_id as string,
        reason: r.reason as string,
        suspendedAt: iso(r.suspended_at)!,
      }))
    }
    return [...this.suspensions.values()].sort((a, b) => b.suspendedAt.localeCompare(a.suspendedAt))
  }

  /** Lifts a suspension. Old reports are cleared so one more doesn't instantly re-suspend. */
  async reinstate(userId: string): Promise<boolean> {
    const pool = await getPool()
    if (pool) {
      const { rowCount } = await pool.query(`DELETE FROM whistleblower_suspensions WHERE user_id = $1`, [userId])
      await pool.query(`DELETE FROM whistleblower_safety_reports WHERE whistleblower_id = $1`, [userId])
      return rowCount > 0
    }
    this.reports = this.reports.filter((r) => r.whistleblowerId !== userId)
    return this.suspensions.delete(userId)
  }

  async clear(): Promise<void> {
    const pool = await getPool()
    if (pool) {
      await pool.query(`DELETE FROM whistleblower_identities`)
      await pool.query(`DELETE FROM whistleblower_safety_reports`)
      await pool.query(`DELETE FROM whistleblower_suspensions`)
    }
    this.identities.clear()
    this.reports = []
    this.suspensions.clear()
  }
}

export const whistleblowerTrustStore = new WhistleblowerTrustStore()
