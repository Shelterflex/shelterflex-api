/**
 * Listing Application Repository
 * Data access layer for tenant applications
 */

import { randomUUID } from "crypto";
import { getPool } from "../db.js";
import {
  ListingApplication,
  ListingApplicationStatus,
  CreateListingApplicationInput,
  PaymentPlan,
} from "../models/listingApplication.js";

export interface IListingApplicationRepository {
  create(input: CreateListingApplicationInput): Promise<ListingApplication>;
  findById(id: string): Promise<ListingApplication | null>;
  findByTenantId(
    tenantId: string,
    filters?: { status?: ListingApplicationStatus },
  ): Promise<ListingApplication[]>;
  findByListingId(
    listingId: string,
    filters?: { status?: ListingApplicationStatus },
  ): Promise<ListingApplication[]>;
  findDuplicateActive(
    tenantId: string,
    listingId: string,
  ): Promise<ListingApplication | null>;
  updateStatus(
    id: string,
    status: ListingApplicationStatus,
    reviewedBy?: string,
    reviewerNotes?: string,
  ): Promise<ListingApplication | null>;
  withdraw(id: string): Promise<ListingApplication | null>;
}

class PostgresListingApplicationRepository implements IListingApplicationRepository {
  async create(
    input: CreateListingApplicationInput,
  ): Promise<ListingApplication> {
    const pool = await getPool();
    const id = randomUUID();
    const now = new Date();

    const query = `
      INSERT INTO listing_applications
      (id, listing_id, tenant_id, landlord_id, status, cover_note, preferred_start_date, 
       payment_plan, applied_at, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING id, listing_id, tenant_id, landlord_id, status, cover_note, preferred_start_date,
                payment_plan, applied_at, reviewed_at, reviewed_by, reviewer_notes, created_at, updated_at
    `;

    const result = await pool!.query(query, [
      id,
      input.listingId,
      input.tenantId,
      input.landlordId,
      ListingApplicationStatus.PENDING,
      input.coverNote || null,
      input.preferredStartDate,
      input.paymentPlan,
      now,
      now,
      now,
    ]);

    return this.mapRow(result.rows[0]);
  }

  async findById(id: string): Promise<ListingApplication | null> {
    const pool = await getPool();

    const query = `
      SELECT id, listing_id, tenant_id, landlord_id, status, cover_note, preferred_start_date,
             payment_plan, applied_at, reviewed_at, reviewed_by, reviewer_notes, created_at, updated_at
      FROM listing_applications
      WHERE id = $1
    `;

    const result = await pool!.query(query, [id]);
    return result.rows.length > 0 ? this.mapRow(result.rows[0]) : null;
  }

  async findByTenantId(
    tenantId: string,
    filters?: { status?: ListingApplicationStatus },
  ): Promise<ListingApplication[]> {
    const pool = await getPool();

    let query = `
      SELECT id, listing_id, tenant_id, landlord_id, status, cover_note, preferred_start_date,
             payment_plan, applied_at, reviewed_at, reviewed_by, reviewer_notes, created_at, updated_at
      FROM listing_applications
      WHERE tenant_id = $1
    `;

    const params: any[] = [tenantId];

    if (filters?.status) {
      query += ` AND status = $2`;
      params.push(filters.status);
    }

    query += ` ORDER BY applied_at DESC`;

    const result = await pool!.query(query, params);
    return result.rows.map((row) => this.mapRow(row));
  }

  async findByListingId(
    listingId: string,
    filters?: { status?: ListingApplicationStatus },
  ): Promise<ListingApplication[]> {
    const pool = await getPool();

    let query = `
      SELECT id, listing_id, tenant_id, landlord_id, status, cover_note, preferred_start_date,
             payment_plan, applied_at, reviewed_at, reviewed_by, reviewer_notes, created_at, updated_at
      FROM listing_applications
      WHERE listing_id = $1
    `;

    const params: any[] = [listingId];

    if (filters?.status) {
      query += ` AND status = $2`;
      params.push(filters.status);
    }

    query += ` ORDER BY applied_at DESC`;

    const result = await pool!.query(query, params);
    return result.rows.map((row) => this.mapRow(row));
  }

  async findDuplicateActive(
    tenantId: string,
    listingId: string,
  ): Promise<ListingApplication | null> {
    const pool = await getPool();

    const query = `
      SELECT id, listing_id, tenant_id, landlord_id, status, cover_note, preferred_start_date,
             payment_plan, applied_at, reviewed_at, reviewed_by, reviewer_notes, created_at, updated_at
      FROM listing_applications
      WHERE tenant_id = $1 AND listing_id = $2 AND status != $3
      ORDER BY applied_at DESC
      LIMIT 1
    `;

    const result = await pool!.query(query, [
      tenantId,
      listingId,
      ListingApplicationStatus.REJECTED,
    ]);
    return result.rows.length > 0 ? this.mapRow(result.rows[0]) : null;
  }

  async updateStatus(
    id: string,
    status: ListingApplicationStatus,
    reviewedBy?: string,
    reviewerNotes?: string,
  ): Promise<ListingApplication | null> {
    const pool = await getPool();
    const now = new Date();

    const query = `
      UPDATE listing_applications
      SET status = $2, reviewed_at = $3, reviewed_by = $4, reviewer_notes = $5, updated_at = $6
      WHERE id = $1
      RETURNING id, listing_id, tenant_id, landlord_id, status, cover_note, preferred_start_date,
                payment_plan, applied_at, reviewed_at, reviewed_by, reviewer_notes, created_at, updated_at
    `;

    const result = await pool!.query(query, [
      id,
      status,
      now,
      reviewedBy || null,
      reviewerNotes || null,
      now,
    ]);
    return result.rows.length > 0 ? this.mapRow(result.rows[0]) : null;
  }

  async withdraw(id: string): Promise<ListingApplication | null> {
    return this.updateStatus(id, ListingApplicationStatus.WITHDRAWN);
  }

  private mapRow(row: any): ListingApplication {
    return {
      id: row.id,
      listingId: row.listing_id,
      tenantId: row.tenant_id,
      landlordId: row.landlord_id,
      status: row.status,
      coverNote: row.cover_note,
      preferredStartDate: new Date(row.preferred_start_date),
      paymentPlan: row.payment_plan,
      appliedAt: new Date(row.applied_at),
      reviewedAt: row.reviewed_at ? new Date(row.reviewed_at) : undefined,
      reviewedBy: row.reviewed_by,
      reviewerNotes: row.reviewer_notes,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }
}

export const listingApplicationRepository =
  new PostgresListingApplicationRepository();
