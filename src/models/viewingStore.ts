/**
 * Apartment viewings. Postgres when a database is configured, otherwise memory.
 */

import { randomUUID } from 'node:crypto'
import { getPool } from '../db.js'

/** `open` until someone ends it; the status people see is derived from the rest. */
export type ViewingState = 'open' | 'declined' | 'cancelled'

export type ViewingStatus =
  | 'requested' // waiting for the reporter to accept
  | 'awaiting_inspector' // accepted, but a first-time reporter needs an inspector
  | 'confirmed'
  | 'declined'
  | 'cancelled'

export interface Viewing {
  viewingId: string
  listingId: string
  tenantId: string
  whistleblowerId: string
  startsAt: string
  requiresInspector: boolean
  inspectorId: string | null
  whistleblowerAccepted: boolean
  state: ViewingState
  createdAt: string
  updatedAt: string
}

export function viewingStatus(v: Viewing): ViewingStatus {
  if (v.state === 'declined') return 'declined'
  if (v.state === 'cancelled') return 'cancelled'
  if (!v.whistleblowerAccepted) return 'requested'
  if (v.requiresInspector && !v.inspectorId) return 'awaiting_inspector'
  return 'confirmed'
}

export interface CreateViewingInput {
  listingId: string
  tenantId: string
  whistleblowerId: string
  startsAt: string
  requiresInspector: boolean
}

function fromRow(row: Record<string, unknown>): Viewing {
  return {
    viewingId: row.viewing_id as string,
    listingId: row.listing_id as string,
    tenantId: row.tenant_id as string,
    whistleblowerId: row.whistleblower_id as string,
    startsAt: new Date(row.starts_at as string).toISOString(),
    requiresInspector: Boolean(row.requires_inspector),
    inspectorId: (row.inspector_id as string | null) ?? null,
    whistleblowerAccepted: Boolean(row.whistleblower_accepted),
    state: row.state as ViewingState,
    createdAt: new Date(row.created_at as string).toISOString(),
    updatedAt: new Date(row.updated_at as string).toISOString(),
  }
}

class ViewingStore {
  private memory = new Map<string, Viewing>()

  async create(input: CreateViewingInput): Promise<Viewing> {
    const now = new Date().toISOString()
    const viewing: Viewing = {
      viewingId: randomUUID(),
      ...input,
      inspectorId: null,
      whistleblowerAccepted: false,
      state: 'open',
      createdAt: now,
      updatedAt: now,
    }
    const pool = await getPool()
    if (pool) {
      await pool.query(
        `INSERT INTO viewings
           (viewing_id, listing_id, tenant_id, whistleblower_id, starts_at, requires_inspector,
            inspector_id, whistleblower_accepted, state)
         VALUES ($1, $2, $3, $4, $5, $6, NULL, FALSE, 'open')`,
        [
          viewing.viewingId,
          viewing.listingId,
          viewing.tenantId,
          viewing.whistleblowerId,
          viewing.startsAt,
          viewing.requiresInspector,
        ],
      )
    } else {
      this.memory.set(viewing.viewingId, viewing)
    }
    return viewing
  }

  async getById(viewingId: string): Promise<Viewing | null> {
    const pool = await getPool()
    if (pool) {
      const { rows } = await pool.query(`SELECT * FROM viewings WHERE viewing_id = $1`, [viewingId])
      return rows[0] ? fromRow(rows[0]) : null
    }
    return this.memory.get(viewingId) ?? null
  }

  /** Viewings the user is part of: booked by them, or on a listing they reported. */
  async listForUser(userId: string): Promise<Viewing[]> {
    const pool = await getPool()
    if (pool) {
      const { rows } = await pool.query(
        `SELECT * FROM viewings
          WHERE tenant_id = $1 OR whistleblower_id = $1 OR inspector_id = $1
          ORDER BY starts_at ASC`,
        [userId],
      )
      return rows.map(fromRow)
    }
    return [...this.memory.values()]
      .filter((v) => v.tenantId === userId || v.whistleblowerId === userId || v.inspectorId === userId)
      .sort((a, b) => a.startsAt.localeCompare(b.startsAt))
  }

  /** Accepted viewings of first-time reporters that still need an inspector. */
  async listAwaitingInspector(): Promise<Viewing[]> {
    const pool = await getPool()
    if (pool) {
      const { rows } = await pool.query(
        `SELECT * FROM viewings
          WHERE state = 'open' AND requires_inspector = TRUE
            AND inspector_id IS NULL AND whistleblower_accepted = TRUE
          ORDER BY starts_at ASC`,
      )
      return rows.map(fromRow)
    }
    return [...this.memory.values()]
      .filter((v) => viewingStatus(v) === 'awaiting_inspector')
      .sort((a, b) => a.startsAt.localeCompare(b.startsAt))
  }

  /** Open viewings of one listing, to catch double-booking. */
  async listActiveForListing(listingId: string): Promise<Viewing[]> {
    const pool = await getPool()
    if (pool) {
      const { rows } = await pool.query(
        `SELECT * FROM viewings WHERE listing_id = $1 AND state = 'open'`,
        [listingId],
      )
      return rows.map(fromRow)
    }
    return [...this.memory.values()].filter((v) => v.listingId === listingId && v.state === 'open')
  }

  async update(
    viewingId: string,
    patch: Partial<Pick<Viewing, 'inspectorId' | 'whistleblowerAccepted' | 'state'>>,
  ): Promise<Viewing | null> {
    const current = await this.getById(viewingId)
    if (!current) return null
    const next: Viewing = { ...current, ...patch, updatedAt: new Date().toISOString() }
    const pool = await getPool()
    if (pool) {
      await pool.query(
        `UPDATE viewings
            SET inspector_id = $2, whistleblower_accepted = $3, state = $4, updated_at = NOW()
          WHERE viewing_id = $1`,
        [viewingId, next.inspectorId, next.whistleblowerAccepted, next.state],
      )
    } else {
      this.memory.set(viewingId, next)
    }
    return next
  }

  async clear(): Promise<void> {
    const pool = await getPool()
    if (pool) await pool.query(`DELETE FROM viewings`)
    this.memory.clear()
  }
}

export const viewingStore = new ViewingStore()
