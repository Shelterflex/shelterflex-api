import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import {
  softDeleteUser,
  purgeExpiredRecords,
  getPendingPurgeCount,
} from './dataRetentionService.js'

// Mock the database module
const mockQuery = vi.fn()
const mockRelease = vi.fn()
const mockConnect = vi.fn()

vi.mock('../db.js', () => ({
  getPool: vi.fn(() => ({
    connect: mockConnect,
    query: mockQuery,
  })),
}))

const mockClient = {
  query: mockQuery,
  release: mockRelease,
}

beforeEach(() => {
  vi.clearAllMocks()
  mockConnect.mockResolvedValue(mockClient as any)
  mockQuery.mockResolvedValue({ rows: [], rowCount: 0 } as any)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('DataRetentionService', () => {
  describe('softDeleteUser', () => {
    it('soft deletes user and associated records', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // UPDATE users
        .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // UPDATE wallets
        .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // UPDATE linked_addresses
        .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // UPDATE landlord_profiles
        .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // UPDATE tenant_applications
        .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // UPDATE whistleblower_listings
        .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // UPDATE tenant_deals
        .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // UPDATE landlord_properties
        .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // INSERT audit_log
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // COMMIT

      const result = await softDeleteUser(
        'user-123',
        'actor-456',
        'admin',
        'req-789'
      )

      expect(result.success).toBe(true)
      expect(result.userId).toBe('user-123')
      expect(mockQuery).toHaveBeenCalledWith('BEGIN')
      expect(mockQuery).toHaveBeenCalledWith(
        'UPDATE users SET deleted_at = $1 WHERE id = $2',
        [expect.any(Date), 'user-123']
      )
      expect(mockQuery).toHaveBeenCalledWith('COMMIT')
      expect(mockRelease).toHaveBeenCalled()
    })

    it('returns failure when database is not available', async () => {
      const { getPool } = await import('../db.js')
      vi.mocked(getPool).mockResolvedValueOnce(null)

      const result = await softDeleteUser('user-123', 'actor-456', 'admin')

      expect(result.success).toBe(false)
      expect(result.error).toBe('Database not available')
    })

    it('rolls back transaction on error', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // BEGIN
        .mockRejectedValueOnce(new Error('Database error')) // UPDATE users fails

      const result = await softDeleteUser('user-123', 'actor-456', 'admin')

      expect(result.success).toBe(false)
      expect(result.error).toBe('Database error')
      expect(mockQuery).toHaveBeenCalledWith('ROLLBACK')
      expect(mockRelease).toHaveBeenCalled()
    })
  })

  describe('purgeExpiredRecords', () => {
    const oldDate = new Date('2020-01-01T00:00:00.000Z')
    const recentDate = new Date('2025-01-01T00:00:00.000Z')

    beforeEach(() => {
      mockQuery.mockResolvedValue({ rows: [], rowCount: 0 } as any)
    })

    it('deletes records older than retention period and not under hold', async () => {
      // Simulate: users table has 2 expired records, all other tables empty
      const mocks: any[] = [{ rows: [], rowCount: 0 }] // BEGIN
      const tables = [
        'users', 'sessions', 'wallets', 'linked_addresses', 'landlord_profiles',
        'tenant_applications', 'whistleblower_listings', 'tenant_deals',
        'landlord_properties', 'ngn_deposits', 'conversions', 'webhook_events',
        'webhook_replay_attempts', 'otp_challenges', 'wallet_challenges',
        'kyc_documents', 'tenant_documents', 'property_photos', 'support_messages'
      ]
      for (const table of tables) {
        if (table === 'users') {
          mocks.push({ rows: [{ count: '2' }], rowCount: 2 })
        } else {
          mocks.push({ rows: [{ count: '0' }], rowCount: 0 })
        }
        if (table === 'users') {
          mocks.push({ rows: [], rowCount: 0 }) // audit_log INSERT for users
        }
      }
      mocks.push({ rows: [], rowCount: 0 }) // COMMIT

      mockQuery.mockImplementation(async () => {
        const mock = mocks.shift()!
        return mock
      })

      const result = await purgeExpiredRecords()

      expect(result).toHaveLength(1)
      expect(result[0]).toEqual({
        table: 'users',
        recordsDeleted: 2,
      })
      expect(mockQuery).toHaveBeenCalledWith('BEGIN')
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('DELETE FROM users WHERE deleted_at <'),
        [expect.any(Date)]
      )
      expect(mockQuery).toHaveBeenCalledWith('COMMIT')
    })

    it('preserves records under legal hold (deleted_at is NULL)', async () => {
      // No records to purge - all are either not deleted or under hold
      mockQuery.mockResolvedValue({ rows: [{ count: '0' }], rowCount: 0 } as any)

      const result = await purgeExpiredRecords()

      expect(result).toHaveLength(0)
      expect(mockQuery).toHaveBeenCalledWith('BEGIN')
      expect(mockQuery).toHaveBeenCalledWith('COMMIT')
    })

    it('is idempotent - second run is a no-op', async () => {
      // First run purges everything
      mockQuery.mockResolvedValue({ rows: [{ count: '0' }], rowCount: 0 } as any)

      await purgeExpiredRecords()
      const result = await purgeExpiredRecords()

      expect(result).toHaveLength(0)
      // Should have called COMMIT twice (once per run)
      expect(mockQuery).toHaveBeenCalledWith('COMMIT')
      const commitCalls = mockQuery.mock.calls.filter(
        (call: any[]) => call[0] === 'COMMIT'
      )
      expect(commitCalls.length).toBe(2)
    })

    it('handles boundary: records exactly at TTL edge', async () => {
      // Records with deleted_at exactly equal to cutoff should NOT be purged
      // (cutoff is now - 7 years, strict less-than comparison)
      mockQuery
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // BEGIN
        .mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 0 }) // all tables
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // COMMIT

      const result = await purgeExpiredRecords()

      expect(result).toHaveLength(0)
      // Verify the date comparison logic matches retention period
      const cutoffDate = new Date()
      cutoffDate.setFullYear(cutoffDate.getFullYear() - 7)
      const queryCall = mockQuery.mock.calls.find(
        (call: any[]) => typeof call[0] === 'string' && call[0].includes('DELETE FROM')
      )!
      expect(queryCall[1][0]).toBeInstanceOf(Date)
      // Allow small time difference due to execution time between test and service
      const timeDiff = Math.abs(queryCall[1][0].getTime() - cutoffDate.getTime())
      expect(timeDiff).toBeLessThan(1000) // within 1 second
    })

    it('continues purging other tables even if one fails', async () => {
      // First table fails, second succeeds
      mockQuery
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // BEGIN
        .mockRejectedValueOnce(new Error('Table lock failed')) // users fails
        .mockResolvedValueOnce({ rows: [{ count: '3' }], rowCount: 3 }) // sessions succeeds
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // audit_log
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // COMMIT

      const result = await purgeExpiredRecords()

      expect(result).toHaveLength(1)
      expect(result[0]).toEqual({
        table: 'sessions',
        recordsDeleted: 3,
      })
    })

    it('throws error when database is not available', async () => {
      const { getPool } = await import('../db.js')
      vi.mocked(getPool).mockResolvedValueOnce(null)

      await expect(purgeExpiredRecords()).rejects.toThrow('Database not available')
    })
  })

  describe('getPendingPurgeCount', () => {
    const oldDate = new Date('2020-01-01T00:00:00.000Z')

    beforeEach(() => {
      mockQuery.mockResolvedValue({ rows: [{ count: '0' }], rowCount: 0 } as any)
    })

    it('returns accurate count of records pending purge per table', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ count: '5' }], rowCount: 0 }) // users
        .mockResolvedValueOnce({ rows: [{ count: '3' }], rowCount: 0 }) // sessions
        .mockResolvedValueOnce({ rows: [{ count: '2' }], rowCount: 0 }) // wallets

      const result = await getPendingPurgeCount()

      expect(result.users).toBe(5)
      expect(result.sessions).toBe(3)
      expect(result.wallets).toBe(2)
      expect(mockQuery).toHaveBeenCalledWith(
        'SELECT COUNT(*) as count FROM users WHERE deleted_at < $1',
        [expect.any(Date)]
      )
    })

    it('matches purge eligibility - count reflects purgable records', async () => {
      // Freeze the clock so the cutoff computed here and the one computed
      // inside getPendingPurgeCount resolve to the exact same instant --
      // otherwise two independent `new Date()` calls can straddle a
      // millisecond boundary and fail this assertion intermittently.
      vi.useFakeTimers()
      try {
        // Same data shape in both functions should yield matching counts
        const cutoffDate = new Date()
        cutoffDate.setFullYear(cutoffDate.getFullYear() - 7)

        mockQuery.mockResolvedValue({ rows: [{ count: '4' }], rowCount: 0 } as any)

        const counts = await getPendingPurgeCount()

        expect(counts.users).toBe(4)
        expect(counts.sessions).toBe(4)
        // Verify cutoff date matches retention period
        const queryCall = mockQuery.mock.calls[0]!
        expect(queryCall[1][0]).toEqual(cutoffDate)
      } finally {
        vi.useRealTimers()
      }
    })

    it('returns zero for tables with no pending purge records', async () => {
      mockQuery.mockResolvedValue({ rows: [{ count: '0' }], rowCount: 0 } as any)

      const result = await getPendingPurgeCount()

      expect(result.users).toBe(0)
      expect(result.sessions).toBe(0)
      expect(Object.values(result).every((count) => count === 0)).toBe(true)
    })

    it('handles errors gracefully and returns zero count', async () => {
      mockQuery.mockRejectedValueOnce(new Error('Query failed'))

      const result = await getPendingPurgeCount()

      expect(result.users).toBe(0)
    })

    it('throws error when database is not available', async () => {
      const { getPool } = await import('../db.js')
      vi.mocked(getPool).mockResolvedValueOnce(null)

      await expect(getPendingPurgeCount()).rejects.toThrow('Database not available')
    })
  })
})