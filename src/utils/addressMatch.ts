/**
 * Decides whether two free-text addresses describe the same place. Used to make
 * sure a whistleblower reports the apartment they actually live in.
 *
 * Addresses are compared as sets of meaningful words, after dropping filler
 * (street, road, lagos) and spelling out common abbreviations. The house number
 * has to agree when both addresses have one.
 */

const ABBREVIATIONS: Record<string, string> = {
  st: 'street',
  rd: 'road',
  ave: 'avenue',
  av: 'avenue',
  cl: 'close',
  cres: 'crescent',
  dr: 'drive',
  ln: 'lane',
  est: 'estate',
  flt: 'flat',
  apt: 'apartment',
  blk: 'block',
  phs: 'phase',
  ph: 'phase',
}

const FILLER = new Set([
  'the', 'of', 'and', 'off', 'by', 'near', 'opposite', 'opp', 'behind',
  'street', 'road', 'avenue', 'close', 'crescent', 'drive', 'lane', 'estate',
  'flat', 'apartment', 'block', 'phase', 'house', 'no', 'number',
  'nigeria', 'state', 'lga', 'lagos', 'abuja',
])

function words(address: string): string[] {
  return address
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => ABBREVIATIONS[w] ?? w)
}

// A number after one of these is a flat, floor or phase, not the house.
const UNIT_WORDS = new Set(['flat', 'apartment', 'block', 'phase', 'room', 'floor', 'unit'])

function houseNumber(tokens: string[]): string | null {
  const i = tokens.findIndex(
    (t, idx) => /^\d+[a-z]?$/.test(t) && !UNIT_WORDS.has(tokens[idx - 1] ?? ''),
  )
  return i === -1 ? null : tokens[i]!
}

/** Share of the shorter address's meaningful words that also appear in the other. */
export function addressSimilarity(a: string, b: string): number {
  const ta = words(a).filter((w) => !FILLER.has(w))
  const tb = words(b).filter((w) => !FILLER.has(w))
  if (ta.length === 0 || tb.length === 0) return 0

  const setA = new Set(ta)
  const setB = new Set(tb)
  const [small, large] = setA.size <= setB.size ? [setA, setB] : [setB, setA]
  let shared = 0
  for (const w of small) if (large.has(w)) shared += 1
  // One shared word (often just the city) is not enough to call it the same place.
  return shared >= 2 ? shared / small.size : 0
}

export const ADDRESS_MATCH_THRESHOLD = 0.6

export function addressesMatch(registered: string, reported: string): boolean {
  const numA = houseNumber(words(registered))
  const numB = houseNumber(words(reported))
  if (numA && numB && numA !== numB) return false
  return addressSimilarity(registered, reported) >= ADDRESS_MATCH_THRESHOLD
}
