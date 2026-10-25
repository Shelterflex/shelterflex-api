import { describe, it, expect } from 'vitest'
import { addressesMatch } from './addressMatch.js'

describe('addressesMatch', () => {
  const registered = '15 Admiralty Way, Lekki Phase 1, Lagos'

  it('matches the same address written differently', () => {
    expect(addressesMatch(registered, '15, Admiralty Way, Lekki Phase 1')).toBe(true)
    expect(addressesMatch(registered, 'No 15 admiralty way lekki ph 1 lagos state')).toBe(true)
  })

  it('matches when the report adds a flat number', () => {
    expect(addressesMatch(registered, 'Flat 3, 15 Admiralty Way, Lekki Phase 1, Lagos')).toBe(true)
  })

  it('rejects a different house number on the same street', () => {
    expect(addressesMatch(registered, '17 Admiralty Way, Lekki Phase 1, Lagos')).toBe(false)
  })

  it('rejects a different area', () => {
    expect(addressesMatch(registered, '15 Allen Avenue, Ikeja, Lagos')).toBe(false)
  })

  it('rejects an empty or meaningless address', () => {
    expect(addressesMatch(registered, 'Lagos Nigeria')).toBe(false)
    expect(addressesMatch('', registered)).toBe(false)
  })
})
