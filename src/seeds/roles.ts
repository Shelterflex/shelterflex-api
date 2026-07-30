import { getPool } from '../db.js'
import { logger } from '../utils/logger.js'

export async function seedRolesAndPermissions(): Promise<void> {
  const pool = await getPool()
  if (!pool) {
    logger.warn('[seeds] Database pool not available, skipping seeding')
    return
  }

  logger.info('[seeds] Seeding roles and permissions...')

  try {
    await pool.query('BEGIN')

    // 1. Seed Roles
    const roles = [
      { name: 'support', description: 'Customer support agent role with limited access to view disputes' },
      { name: 'finance', description: 'Financial admin role capable of viewing payouts and resolving transactions' },
      { name: 'operations', description: 'Operations role with access to view disputes and manage platform logs' },
      { name: 'super_admin', description: 'Implicitly has all permissions and full administrative rights' },
    ]

    for (const role of roles) {
      await pool.query(
        `INSERT INTO roles (name, description) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING`,
        [role.name, role.description],
      )
    }

    // 2. Seed Permissions
    const permissions = [
      { resource: 'disputes', action: 'view' },
      { resource: 'disputes', action: 'resolve' },
      { resource: 'payouts', action: 'trigger' },
      { resource: 'kyc', action: 'view' },
      { resource: 'kyc', action: 'verify' },
    ]

    for (const permission of permissions) {
      await pool.query(
        `INSERT INTO permissions (resource, action) VALUES ($1, $2) ON CONFLICT (resource, action) DO NOTHING`,
        [permission.resource, permission.action],
      )
    }

    // Helper to link roles and permissions
    const linkRolePermission = async (roleName: string, resource: string, action: string) => {
      await pool.query(
        `INSERT INTO role_permissions (role_id, permission_id)
         SELECT r.id, p.id FROM roles r, permissions p
         WHERE r.name = $1 AND p.resource = $2 AND p.action = $3
         ON CONFLICT DO NOTHING`,
        [roleName, resource, action],
      )
    }

    // Link support role
    await linkRolePermission('support', 'disputes', 'view')
    await linkRolePermission('support', 'kyc', 'view')

    // Link finance role
    await linkRolePermission('finance', 'payouts', 'trigger')
    await linkRolePermission('finance', 'kyc', 'view')

    // Link operations role
    await linkRolePermission('operations', 'disputes', 'view')
    await linkRolePermission('operations', 'kyc', 'view')

    await pool.query('COMMIT')
    logger.info('[seeds] Roles and permissions seeded successfully')
  } catch (error) {
    await pool.query('ROLLBACK')
    logger.error('[seeds] Seeding failed:', undefined, error)
    throw error
  }
}
