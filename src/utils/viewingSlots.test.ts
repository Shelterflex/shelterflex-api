import { describe, it, expect } from 'vitest'
import { checkViewingSlot } from './viewingSlots.js'

// 12:00 UTC on 1 Jan is 1pm in Lagos (WAT = UTC+1).
const now = new Date('2030-01-01T12:00:00.000Z')
const at = (iso: string) => new Date(iso)

describe('checkViewingSlot', () => {
  it('allows a daytime slot with enough notice', () => {
    expect(checkViewingSlot(at('2030-01-03T10:00:00.000Z'), now)).toBeNull() // 11am WAT
    expect(checkViewingSlot(at('2030-01-03T08:00:00.000Z'), now)).toBeNull() // 9am WAT, first slot
    expect(checkViewingSlot(at('2030-01-03T15:00:00.000Z'), now)).toBeNull() // 4pm WAT, last slot
  })

  it('rejects evenings, nights and early mornings in Lagos time', () => {
    expect(checkViewingSlot(at('2030-01-03T16:00:00.000Z'), now)).toMatch(/daytime only/) // 5pm WAT
    expect(checkViewingSlot(at('2030-01-03T20:00:00.000Z'), now)).toMatch(/daytime only/) // 9pm WAT
    expect(checkViewingSlot(at('2030-01-03T06:00:00.000Z'), now)).toMatch(/daytime only/) // 7am WAT
  })

  it('needs a day of notice and no more than thirty days', () => {
    expect(checkViewingSlot(at('2030-01-02T10:00:00.000Z'), now)).toMatch(/at least 24 hours/)
    expect(checkViewingSlot(at('2030-03-01T10:00:00.000Z'), now)).toMatch(/30 days/)
  })

  it('only allows slots on the hour and valid dates', () => {
    expect(checkViewingSlot(at('2030-01-03T10:30:00.000Z'), now)).toMatch(/on the hour/)
    expect(checkViewingSlot(new Date('nope'), now)).toMatch(/valid date/)
  })
})
