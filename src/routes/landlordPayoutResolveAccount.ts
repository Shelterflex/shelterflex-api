import { Router, Response, NextFunction } from 'express'
import { z } from 'zod'
import { validate } from '../middleware/validate.js'
import { authenticateToken, type AuthenticatedRequest } from '../middleware/auth.js'
import { bankAccountResolverService } from '../services/BankAccountResolverService.js'

const resolveAccountSchema = z.object({
  body: z.object({
    accountNumber: z
      .string()
      .trim()
      .regex(/^\d{10}$/, 'accountNumber must be exactly 10 digits'),
    bankCode: z.string().trim().min(1, 'bankCode is required').optional(),
    bankName: z.string().trim().min(1).optional(),
    provider: z.enum(['paystack', 'flutterwave']).optional(),
  }).refine(
    (d) => d.bankCode || d.bankName,
    { message: 'Either bankCode or bankName is required', path: ['bankCode'] },
  ),
})

export function createLandlordPayoutResolveAccountRouter(): Router {
  const router = Router()

  /**
   * POST /api/v1/landlord/payout/resolve-account
   *
   * Resolves the real account-holder name for a Nigerian bank account via
   * Paystack or Flutterwave.  Never returns a placeholder — if the account
   * cannot be verified a clear error is returned instead.
   */
  router.post(
    '/resolve-account',
    authenticateToken,
    validate(resolveAccountSchema.shape.body),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const { accountNumber, bankCode, bankName, provider } = req.body as z.infer<
          typeof resolveAccountSchema.shape.body
        >

        const result = await bankAccountResolverService.resolve({
          accountNumber,
          bankCode,
          bankName,
          provider,
        })

        res.json({
          success: true,
          data: {
            accountNumber: result.accountNumber,
            accountName: result.accountName,
            bankCode: result.bankCode,
            bankName: result.bankName,
            provider: result.provider,
          },
        })
      } catch (err) {
        next(err)
      }
    },
  )

  return router
}
