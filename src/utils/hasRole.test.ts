import { describe, expect, it } from 'vitest'
import { hasRole } from './hasRole.js'

describe('hasRole', () => {
  it('matches the primary role', () => {
    expect(hasRole({ role: 'tenant' }, 'tenant')).toBe(true)
  })

  it('matches an added role', () => {
    expect(hasRole({ role: 'tenant', roles: ['tenant', 'landlord'] }, 'landlord')).toBe(true)
  })

  it('rejects a role the account does not hold', () => {
    expect(hasRole({ role: 'tenant', roles: ['tenant'] }, 'landlord', 'admin')).toBe(false)
  })

  it('rejects a missing user', () => {
    expect(hasRole(undefined, 'tenant')).toBe(false)
  })
})
