import { z } from 'zod'

export const requestOtpSchema = z.object({
  email: z.string().email(),
})

export const verifyOtpSchema = z.object({
  email: z.string().email(),
  otp: z.string().length(6),
  referralCode: z.string().length(8).optional(),
  // Signup details, applied only when this verification creates the account.
  name: z.string().trim().min(1).max(100).optional(),
  role: z.enum(['tenant', 'landlord']).optional(),
})

export const walletChallengeSchema = z.object({
  address: z.string().regex(/^G[A-Z0-9]{55}$/, 'Invalid Stellar public key'),
})

export const walletVerifySchema = z.object({
  address: z.string().regex(/^G[A-Z0-9]{55}$/, 'Invalid Stellar public key'),
  signedChallengeXdr: z.string(),
})
