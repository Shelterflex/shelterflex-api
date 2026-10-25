/**
 * When a viewing may happen. Viewings are daytime only, in Nigerian time
 * (WAT, UTC+1, no daylight saving), so nobody is asked to meet a stranger at
 * night; and they need a day's notice so an inspector can be arranged.
 */

const WAT_OFFSET_HOURS = 1
export const FIRST_VIEWING_HOUR = 9
/** The last slot starts at 4pm so every viewing ends by 5pm. */
export const LAST_VIEWING_HOUR = 16
export const MIN_NOTICE_HOURS = 24
export const MAX_ADVANCE_DAYS = 30

export function watHour(date: Date): number {
  return (date.getUTCHours() + WAT_OFFSET_HOURS) % 24
}

/** Returns why the time is not allowed, or null if it is. */
export function checkViewingSlot(startsAt: Date, now: Date = new Date()): string | null {
  if (Number.isNaN(startsAt.getTime())) return 'Choose a valid date and time.'
  if (startsAt.getUTCMinutes() !== 0 || startsAt.getUTCSeconds() !== 0) {
    return 'Viewings start on the hour.'
  }
  const hour = watHour(startsAt)
  if (hour < FIRST_VIEWING_HOUR || hour > LAST_VIEWING_HOUR) {
    return 'Viewings are daytime only: between 9am and 5pm.'
  }
  const hoursAhead = (startsAt.getTime() - now.getTime()) / (60 * 60 * 1000)
  if (hoursAhead < MIN_NOTICE_HOURS) {
    return `Book at least ${MIN_NOTICE_HOURS} hours ahead so an inspector can be arranged.`
  }
  if (hoursAhead > MAX_ADVANCE_DAYS * 24) {
    return `Viewings can be booked up to ${MAX_ADVANCE_DAYS} days ahead.`
  }
  return null
}
