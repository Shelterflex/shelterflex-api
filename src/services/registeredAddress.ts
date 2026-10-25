import { getPool } from '../db.js'
import { whistleblowerApplicationStore } from '../models/whistleblowerApplicationStore.js'

/**
 * The residential address a user has given Shelterflex, or null if none.
 * Tenants give it during onboarding; whistleblowers give it when they apply
 * (an application only counts once it has been approved).
 */
export async function getRegisteredAddress(userId: string, email: string): Promise<string | null> {
  const pool = await getPool()
  if (pool) {
    const { rows } = await pool.query(
      `SELECT personal_info->>'residentialAddress' AS address
         FROM onboarding_drafts WHERE user_id = $1`,
      [userId],
    )
    const address = rows[0]?.address as string | undefined
    if (address?.trim()) return address.trim()
  }

  const application = await whistleblowerApplicationStore.getByEmail(email)
  if (application?.status === 'approved' && application.address.trim()) {
    return application.address.trim()
  }
  return null
}
