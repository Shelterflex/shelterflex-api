/**
 * Tracks which login sessions have re-verified themselves to open the document
 * vault. A session that has been open for days still has to prove it is the
 * account's owner (with an emailed code) before its documents are shown, so a
 * stolen or left-open session isn't enough to read them.
 *
 * Kept in memory, keyed by session token: a restart simply locks every vault
 * again, which is the safe direction to fail.
 */

const DEFAULT_UNLOCK_MINUTES = 10

function unlockWindowMs(): number {
  const minutes = Number(process.env.VAULT_UNLOCK_MINUTES)
  return (Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_UNLOCK_MINUTES) * 60 * 1000
}

const unlockedUntil = new Map<string, number>()

export const vaultUnlockStore = {
  /** Unlocks the session and returns when the unlock ends. */
  unlock(token: string): Date {
    const until = Date.now() + unlockWindowMs()
    unlockedUntil.set(token, until)
    return new Date(until)
  },

  unlockedUntil(token: string): Date | null {
    const until = unlockedUntil.get(token)
    if (!until) return null
    if (until <= Date.now()) {
      unlockedUntil.delete(token)
      return null
    }
    return new Date(until)
  },

  isUnlocked(token: string): boolean {
    return this.unlockedUntil(token) !== null
  },

  lock(token: string): void {
    unlockedUntil.delete(token)
  },

  clear(): void {
    unlockedUntil.clear()
  },
}
