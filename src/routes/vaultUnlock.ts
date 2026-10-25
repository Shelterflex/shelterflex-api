/**
 * Step-up verification for the document vault: an emailed one-time code that
 * unlocks the vault for the current session for a short while.
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import { z } from 'zod'
import { authenticateToken, type AuthenticatedRequest } from '../middleware/auth.js'
import { bearerToken } from '../middleware/requireVaultUnlocked.js'
import { validate } from '../middleware/validate.js'
import { createRateLimiter } from '../middleware/rateLimiter.js'
import { rateLimitProfiles } from '../config/rateLimitConfig.js'
import { AppError } from '../errors/AppError.js'
import { ErrorCode } from '../errors/errorCodes.js'
import { otpChallengeStore } from '../models/authStore.js'
import { createOtpDeliveryProvider } from '../services/otpDeliveryFactory.js'
import { vaultUnlockStore } from '../services/vaultUnlockStore.js'
import { generateOtp } from '../utils/tokens.js'
import { generateOtpSalt, hashOtp, verifyOtpHash } from '../utils/otp.js'
import { auditLog, extractAuditContext } from '../utils/auditLogger.js'

const OTP_TTL_MS = 10 * 60 * 1000
const OTP_MAX_ATTEMPTS = 5

const unlockSchema = z.object({ otp: z.string().length(6) })

// Vault codes are kept apart from login codes so one can't be used for the other.
const challengeKey = (email: string) => `vault:${email.toLowerCase()}`

export function createVaultUnlockRouter(): Router {
  const router = Router()
  const otpDelivery = createOtpDeliveryProvider()
  const otpLimiter = createRateLimiter(rateLimitProfiles.otp)

  /** GET /unlock: is this session's vault unlocked, and until when? */
  router.get('/', authenticateToken, (req: Request, res: Response) => {
    const until = vaultUnlockStore.unlockedUntil(bearerToken(req) ?? '')
    res.json({ success: true, data: { unlocked: until !== null, unlockedUntil: until?.toISOString() ?? null } })
  })

  /** POST /unlock/request: email a one-time code. */
  router.post(
    '/request',
    authenticateToken,
    otpLimiter,
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const email = req.user!.email.toLowerCase()
        const otp = generateOtp()
        const salt = generateOtpSalt()
        await otpChallengeStore.set({
          email: challengeKey(email),
          otpHash: hashOtp(otp, salt),
          salt,
          expiresAt: new Date(Date.now() + OTP_TTL_MS),
          attempts: 0,
        })
        await otpDelivery.sendOtp(email, otp, OTP_TTL_MS / 60000)
        auditLog('VAULT_UNLOCK_REQUESTED', extractAuditContext(req, 'user'), {})
        res.json({ success: true, message: 'We emailed you a code' })
      } catch (error) {
        next(error)
      }
    },
  )

  /** POST /unlock: check the code and unlock this session's vault. */
  router.post(
    '/',
    authenticateToken,
    validate(unlockSchema, 'body'),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const key = challengeKey(req.user!.email)
        const challenge = await otpChallengeStore.getByEmail(key)
        if (!challenge || new Date() > challenge.expiresAt) {
          if (challenge) await otpChallengeStore.deleteByEmail(key)
          throw new AppError(ErrorCode.UNAUTHORIZED, 401, 'That code has expired. Request a new one.')
        }
        if (challenge.attempts >= OTP_MAX_ATTEMPTS) {
          await otpChallengeStore.deleteByEmail(key)
          throw new AppError(ErrorCode.UNAUTHORIZED, 401, 'Too many attempts. Request a new code.')
        }
        if (!verifyOtpHash(req.body.otp as string, challenge.salt, challenge.otpHash)) {
          await otpChallengeStore.updateAttempts(key, challenge.attempts + 1)
          auditLog('VAULT_UNLOCK_FAILED', extractAuditContext(req, 'user'), {})
          throw new AppError(ErrorCode.UNAUTHORIZED, 401, 'That code is not right.')
        }

        await otpChallengeStore.deleteByEmail(key)
        const until = vaultUnlockStore.unlock(bearerToken(req)!)
        auditLog('VAULT_UNLOCKED', extractAuditContext(req, 'user'), {})
        res.json({ success: true, data: { unlocked: true, unlockedUntil: until.toISOString() } })
      } catch (error) {
        next(error)
      }
    },
  )

  /** DELETE /unlock: lock the vault again now. */
  router.delete('/', authenticateToken, (req: Request, res: Response) => {
    vaultUnlockStore.lock(bearerToken(req) ?? '')
    res.json({ success: true, data: { unlocked: false, unlockedUntil: null } })
  })

  return router
}
