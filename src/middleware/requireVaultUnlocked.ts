import type { Request, Response, NextFunction } from 'express'
import { AppError } from '../errors/AppError.js'
import { ErrorCode } from '../errors/errorCodes.js'
import { vaultUnlockStore } from '../services/vaultUnlockStore.js'

export const VAULT_LOCKED_REASON = 'vault_locked'

export function bearerToken(req: Request): string | null {
  const header = req.headers.authorization
  return header?.startsWith('Bearer ') ? header.slice(7) : null
}

/**
 * Use after `authenticateToken` on every route that reads or changes vault
 * documents. Refuses the request unless this session recently re-verified.
 */
export function requireVaultUnlocked(req: Request, _res: Response, next: NextFunction): void {
  const token = bearerToken(req)
  if (!token || !vaultUnlockStore.isUnlocked(token)) {
    next(
      new AppError(ErrorCode.FORBIDDEN, 403, 'Verify it is you to open your document vault.', {
        reason: VAULT_LOCKED_REASON,
      }),
    )
    return
  }
  next()
}
