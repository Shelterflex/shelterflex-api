/**
 * BankAccountResolverService
 *
 * Resolves bank account holder names against a live payment-provider API
 * (Paystack or Flutterwave).  Uses the existing rotatingSecretProvider for
 * credentials so keys are never hard-coded here.
 *
 * Failure modes are modelled as distinct error types so callers can surface
 * an appropriate message instead of a false success:
 *
 *   UNRESOLVABLE  – provider returned "account not found" (permanent, 422)
 *   PROVIDER_DOWN – timeout, 5xx, or network error     (transient, 503)
 *   RATE_LIMITED  – provider returned 429              (transient, 429)
 */

import { AppError } from '../errors/AppError.js'
import { ErrorCode } from '../errors/errorCodes.js'
import { getRotatingAPIKey } from './rotatingSecretProvider.js'
import { logger } from '../utils/logger.js'

// ── Types ────────────────────────────────────────────────────────────────────

export type PayoutProvider = 'paystack' | 'flutterwave'

export interface ResolveAccountInput {
  /** 10-digit NUBAN account number */
  accountNumber: string
  /** CBN bank code (e.g. "058" for GTBank) – preferred over bankName */
  bankCode?: string
  /** Human-readable bank name – used as fallback when bankCode is absent */
  bankName?: string
  /** Override the default provider (falls back to PAYOUT_PROVIDER env var) */
  provider?: PayoutProvider
}

export interface ResolvedAccount {
  accountNumber: string
  accountName: string
  bankCode: string
  bankName: string
  provider: PayoutProvider
}

// ── Constants ────────────────────────────────────────────────────────────────

const REQUEST_TIMEOUT_MS = 10_000

// ── Paystack ─────────────────────────────────────────────────────────────────

async function resolveViaPaystack(
  accountNumber: string,
  bankCode: string,
  secretKey: string,
): Promise<{ accountName: string; accountNumber: string }> {
  const url = `https://api.paystack.co/bank/resolve?account_number=${encodeURIComponent(accountNumber)}&bank_code=${encodeURIComponent(bankCode)}`

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

  let response: Response
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${secretKey}`,
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    if (message.includes('abort') || message.includes('timeout')) {
      throw new AppError(
        ErrorCode.SERVICE_UNAVAILABLE,
        503,
        'Paystack account resolution timed out. Please try again.',
      )
    }
    throw new AppError(
      ErrorCode.SERVICE_UNAVAILABLE,
      503,
      'Unable to reach Paystack for account verification. Please try again.',
    )
  } finally {
    clearTimeout(timer)
  }

  if (response.status === 429) {
    throw new AppError(
      ErrorCode.TOO_MANY_REQUESTS,
      429,
      'Account verification is temporarily rate-limited. Please retry in a few seconds.',
    )
  }

  if (response.status >= 500) {
    throw new AppError(
      ErrorCode.SERVICE_UNAVAILABLE,
      503,
      `Paystack returned ${response.status}. Please try again later.`,
    )
  }

  const body = await response.json() as Record<string, unknown>

  if (!response.ok || body.status === false) {
    // Paystack uses status:false + message for "account not found"
    const providerMessage = typeof body.message === 'string' ? body.message : 'Account not found'
    throw new AppError(
      ErrorCode.VALIDATION_ERROR,
      422,
      `Could not verify account: ${providerMessage}`,
      { provider: 'paystack', providerMessage },
    )
  }

  const data = body.data as Record<string, unknown>
  const accountName = typeof data?.account_name === 'string' ? data.account_name : null

  if (!accountName) {
    throw new AppError(
      ErrorCode.VALIDATION_ERROR,
      422,
      'Paystack resolved the account but returned no account name.',
    )
  }

  return {
    accountName,
    accountNumber: typeof data?.account_number === 'string' ? data.account_number : accountNumber,
  }
}

// ── Flutterwave ───────────────────────────────────────────────────────────────

async function resolveViaFlutterwave(
  accountNumber: string,
  bankCode: string,
  secretKey: string,
): Promise<{ accountName: string; accountNumber: string }> {
  const url = 'https://api.flutterwave.com/v3/accounts/resolve'

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${secretKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ account_number: accountNumber, account_bank: bankCode }),
      signal: controller.signal,
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    if (message.includes('abort') || message.includes('timeout')) {
      throw new AppError(
        ErrorCode.SERVICE_UNAVAILABLE,
        503,
        'Flutterwave account resolution timed out. Please try again.',
      )
    }
    throw new AppError(
      ErrorCode.SERVICE_UNAVAILABLE,
      503,
      'Unable to reach Flutterwave for account verification. Please try again.',
    )
  } finally {
    clearTimeout(timer)
  }

  if (response.status === 429) {
    throw new AppError(
      ErrorCode.TOO_MANY_REQUESTS,
      429,
      'Account verification is temporarily rate-limited. Please retry in a few seconds.',
    )
  }

  if (response.status >= 500) {
    throw new AppError(
      ErrorCode.SERVICE_UNAVAILABLE,
      503,
      `Flutterwave returned ${response.status}. Please try again later.`,
    )
  }

  const body = await response.json() as Record<string, unknown>

  if (!response.ok || body.status !== 'success') {
    const providerMessage = typeof body.message === 'string' ? body.message : 'Account not found'
    throw new AppError(
      ErrorCode.VALIDATION_ERROR,
      422,
      `Could not verify account: ${providerMessage}`,
      { provider: 'flutterwave', providerMessage },
    )
  }

  const data = body.data as Record<string, unknown>
  const accountName = typeof data?.account_name === 'string' ? data.account_name : null

  if (!accountName) {
    throw new AppError(
      ErrorCode.VALIDATION_ERROR,
      422,
      'Flutterwave resolved the account but returned no account name.',
    )
  }

  return {
    accountName,
    accountNumber: typeof data?.account_number === 'string' ? data.account_number : accountNumber,
  }
}

// ── Service ───────────────────────────────────────────────────────────────────

export class BankAccountResolverService {
  /**
   * Resolves the account holder name for a Nigerian bank account.
   * Throws AppError on all failure paths — never returns a placeholder.
   */
  async resolve(input: ResolveAccountInput): Promise<ResolvedAccount> {
    const provider = input.provider ?? this.defaultProvider()

    if (!input.bankCode && !input.bankName) {
      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        400,
        'Either bankCode or bankName is required.',
      )
    }

    // When only bankName is supplied we cannot do a live lookup because
    // both Paystack and Flutterwave require a numeric bank code.  Fail
    // clearly rather than guessing.
    const bankCode = input.bankCode
    if (!bankCode) {
      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        400,
        'bankCode is required for account resolution. Please provide the CBN bank code (e.g. "058" for GTBank).',
      )
    }

    const secretKey = getRotatingAPIKey(provider)
    if (!secretKey) {
      logger.error('BankAccountResolverService: no API key configured', { provider })
      throw new AppError(
        ErrorCode.SERVICE_UNAVAILABLE,
        503,
        'Account verification is not configured. Please contact support.',
      )
    }

    logger.info('Resolving bank account', {
      provider,
      bankCode,
      accountNumberSuffix: input.accountNumber.slice(-4),
    })

    let resolved: { accountName: string; accountNumber: string }

    if (provider === 'paystack') {
      resolved = await resolveViaPaystack(input.accountNumber, bankCode, secretKey)
    } else {
      resolved = await resolveViaFlutterwave(input.accountNumber, bankCode, secretKey)
    }

    logger.info('Bank account resolved successfully', {
      provider,
      bankCode,
      accountNameLength: resolved.accountName.length,
    })

    return {
      accountNumber: resolved.accountNumber,
      accountName: resolved.accountName,
      bankCode,
      bankName: input.bankName ?? bankCode,
      provider,
    }
  }

  private defaultProvider(): PayoutProvider {
    const raw = process.env.PAYOUT_PROVIDER?.toLowerCase()
    if (raw === 'flutterwave') return 'flutterwave'
    return 'paystack' // paystack is the default
  }
}

export const bankAccountResolverService = new BankAccountResolverService()
