import { getPool } from '../db.js'
import { auditLog, extractAuditContext } from '../utils/auditLogger.js'
import { notificationService } from './notificationService.js'

export async function setLandlordVerification(adminReq: any, landlordId: string, level: string, note: string) {
  const pool = await getPool()
  if (!pool) throw new Error('DB not available')

  const verifiedAt = new Date().toISOString()
  await pool.query(
    `INSERT INTO landlord_profiles (user_id, verification_level, verified_at, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (user_id) DO UPDATE
     SET verification_level = EXCLUDED.verification_level,
         verified_at = EXCLUDED.verified_at,
         updated_at = NOW()`,
    [landlordId, level, verifiedAt],
  )

  auditLog('LANDLORD_VERIFICATION_UPDATED', extractAuditContext(adminReq, 'admin'), {
    landlordId,
    level,
    note,
  })

  await notificationService.create(landlordId, {
    category: 'landlord_verification',
    title: 'Landlord verification status changed',
    body: `Your verification status was updated to ${level}`,
    data: { level, note },
    dedupeKey: `landlord_verification:${landlordId}`,
  })
}

export async function getLandlordVerificationPublic(landlordId: string) {
  const pool = await getPool()
  if (!pool) return null

  const { rows } = await pool.query(
    `SELECT u.id AS user_id, p.verification_level AS level, p.verified_at
     FROM users u
     LEFT JOIN landlord_profiles p ON u.id = p.user_id
     WHERE u.id = $1 AND ('landlord' = ANY(u.roles) OR u.role = 'landlord')`,
    [landlordId],
  )

  if (rows.length === 0) return null

  return {
    level: rows[0].level ?? 'unverified',
    verifiedAt: rows[0].verified_at ?? null,
  }
}
