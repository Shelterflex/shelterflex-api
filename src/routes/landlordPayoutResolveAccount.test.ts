import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { createTestAgent } from '../test-helpers.js'
import { sessionStore, userStore } from '../models/authStore.js'
import { _testOnly_clearAuthRateLimits } from '../middleware/authRateLimit.js'

// ── Mock OTP + token generation so login works deterministically ──────────────

vi.mock('../utils/tokens.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../utils/tokens.js')>()
  return {
    ...mod,
    generateOtp: () => '123456',
    generateToken: () => `tok-${Math.random().toString(36).slice(2)}`,
  }
})

// ── Mock the resolver service so tests never make real HTTP calls ─────────────

vi.mock('../services/BankAccountResolverService.js', () => ({
  bankAccountResolverService: {
    resolve: vi.fn(),
  },
  BankAccountResolverService: vi.fn(),
}))

import { bankAccountResolverService } from '../services/BankAccountResolverService.js'
import { AppError } from '../errors/AppError.js'
import { ErrorCode } from '../errors/errorCodes.js'
import { otpChallengeStore } from '../models/authStore.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

const TEST_EMAIL = 'landlord-payout@example.com'

async function loginAsLandlord(agent: ReturnType<typeof createTestAgent>): Promise<string> {
  _testOnly_clearAuthRateLimits()
  await agent.post('/api/auth/request-otp').send({ email: TEST_EMAIL })
  const res = await agent
    .post('/api/auth/verify-otp')
    .send({ email: TEST_EMAIL, otp: '123456' })
  return res.body.token as string
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('POST /api/v1/landlord/payout/resolve-account', () => {
  let agent: ReturnType<typeof createTestAgent>
  let token: string

  beforeEach(async () => {
    sessionStore.clear()
    userStore.clear()
    otpChallengeStore.clear()
    _testOnly_clearAuthRateLimits()
    vi.mocked(bankAccountResolverService.resolve).mockReset()

    agent = createTestAgent()
    token = await loginAsLandlord(agent)
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  // ── Auth guard ──────────────────────────────────────────────────────────────

  it('returns 401 when no auth token is provided', async () => {
    const res = await agent
      .post('/api/v1/landlord/payout/resolve-account')
      .send({ accountNumber: '0123456789', bankCode: '058' })

    expect(res.status).toBe(401)
  })

  // ── Validation ──────────────────────────────────────────────────────────────

  it('returns 400 when accountNumber is missing', async () => {
    const res = await agent
      .post('/api/v1/landlord/payout/resolve-account')
      .set('Authorization', `Bearer ${token}`)
      .send({ bankCode: '058' })

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('VALIDATION_ERROR')
  })

  it('returns 400 when accountNumber has wrong length', async () => {
    const res = await agent
      .post('/api/v1/landlord/payout/resolve-account')
      .set('Authorization', `Bearer ${token}`)
      .send({ accountNumber: '12345', bankCode: '058' })

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('VALIDATION_ERROR')
  })

  it('returns 400 when accountNumber contains non-digits', async () => {
    const res = await agent
      .post('/api/v1/landlord/payout/resolve-account')
      .set('Authorization', `Bearer ${token}`)
      .send({ accountNumber: '012345678X', bankCode: '058' })

    expect(res.status).toBe(400)
  })

  it('returns 400 when neither bankCode nor bankName is provided', async () => {
    const res = await agent
      .post('/api/v1/landlord/payout/resolve-account')
      .set('Authorization', `Bearer ${token}`)
      .send({ accountNumber: '0123456789' })

    expect(res.status).toBe(400)
  })

  // ── Success ─────────────────────────────────────────────────────────────────

  it('returns 200 with the real account name on success', async () => {
    vi.mocked(bankAccountResolverService.resolve).mockResolvedValueOnce({
      accountNumber: '0123456789',
      accountName: 'JOHN A DOE',
      bankCode: '058',
      bankName: 'Guaranty Trust Bank',
      provider: 'paystack',
    })

    const res = await agent
      .post('/api/v1/landlord/payout/resolve-account')
      .set('Authorization', `Bearer ${token}`)
      .send({ accountNumber: '0123456789', bankCode: '058', bankName: 'Guaranty Trust Bank' })

    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
    expect(res.body.data.accountName).toBe('JOHN A DOE')
    expect(res.body.data.accountNumber).toBe('0123456789')
    expect(res.body.data.bankCode).toBe('058')
    expect(res.body.data.provider).toBe('paystack')
    // Critically: must NOT return a hardcoded placeholder
    expect(res.body.data.accountName).not.toBe('JOHN DOE')
  })

  it('passes the explicit provider through to the service', async () => {
    vi.mocked(bankAccountResolverService.resolve).mockResolvedValueOnce({
      accountNumber: '0123456789',
      accountName: 'JANE B DOE',
      bankCode: '033',
      bankName: 'UBA',
      provider: 'flutterwave',
    })

    await agent
      .post('/api/v1/landlord/payout/resolve-account')
      .set('Authorization', `Bearer ${token}`)
      .send({ accountNumber: '0123456789', bankCode: '033', provider: 'flutterwave' })

    expect(vi.mocked(bankAccountResolverService.resolve)).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'flutterwave', bankCode: '033' }),
    )
  })

  // ── Provider error propagation ──────────────────────────────────────────────

  it('returns 422 when the account is unresolvable', async () => {
    vi.mocked(bankAccountResolverService.resolve).mockRejectedValueOnce(
      new AppError(ErrorCode.VALIDATION_ERROR, 422, 'Could not verify account: Account number not found'),
    )

    const res = await agent
      .post('/api/v1/landlord/payout/resolve-account')
      .set('Authorization', `Bearer ${token}`)
      .send({ accountNumber: '9999999999', bankCode: '058' })

    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('VALIDATION_ERROR')
    // Must surface the provider error, not a placeholder
    expect(res.body.error.message).not.toContain('JOHN DOE')
  })

  it('returns 503 when the provider is down', async () => {
    vi.mocked(bankAccountResolverService.resolve).mockRejectedValueOnce(
      new AppError(ErrorCode.SERVICE_UNAVAILABLE, 503, 'Paystack account resolution timed out. Please try again.'),
    )

    const res = await agent
      .post('/api/v1/landlord/payout/resolve-account')
      .set('Authorization', `Bearer ${token}`)
      .send({ accountNumber: '0123456789', bankCode: '058' })

    expect(res.status).toBe(503)
    expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE')
  })

  it('returns 429 when the provider rate-limits the call', async () => {
    vi.mocked(bankAccountResolverService.resolve).mockRejectedValueOnce(
      new AppError(ErrorCode.TOO_MANY_REQUESTS, 429, 'Account verification is temporarily rate-limited.'),
    )

    const res = await agent
      .post('/api/v1/landlord/payout/resolve-account')
      .set('Authorization', `Bearer ${token}`)
      .send({ accountNumber: '0123456789', bankCode: '058' })

    expect(res.status).toBe(429)
    expect(res.body.error.code).toBe('TOO_MANY_REQUESTS')
  })
})
