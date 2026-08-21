import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { BankAccountResolverService } from './BankAccountResolverService.js'
import { AppError } from '../errors/AppError.js'
import { ErrorCode } from '../errors/errorCodes.js'

// ── Mock the rotating secret provider ────────────────────────────────────────

vi.mock('./rotatingSecretProvider.js', () => ({
  getRotatingAPIKey: vi.fn(),
}))

import { getRotatingAPIKey } from './rotatingSecretProvider.js'

// ── Mock global fetch ─────────────────────────────────────────────────────────

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

// ── Helpers ───────────────────────────────────────────────────────────────────

function makePaystackSuccess(accountName = 'JOHN A DOE', accountNumber = '0123456789') {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      status: true,
      message: 'Account details fetched',
      data: { account_name: accountName, account_number: accountNumber },
    }),
  }
}

function makePaystackNotFound(message = 'Could not resolve account') {
  return {
    ok: false,
    status: 400,
    json: async () => ({ status: false, message }),
  }
}

function makeFlutterwaveSuccess(accountName = 'JANE B DOE', accountNumber = '0123456789') {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      status: 'success',
      message: 'Account details fetched',
      data: { account_name: accountName, account_number: accountNumber },
    }),
  }
}

function makeFlutterwaveNotFound(message = 'Account not found') {
  return {
    ok: false,
    status: 400,
    json: async () => ({ status: 'error', message }),
  }
}

function make5xxResponse(provider: 'paystack' | 'flutterwave') {
  return {
    ok: false,
    status: 503,
    json: async () => ({ message: 'Service Unavailable' }),
  }
}

function make429Response() {
  return {
    ok: false,
    status: 429,
    json: async () => ({ message: 'Rate limit exceeded' }),
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('BankAccountResolverService', () => {
  let service: BankAccountResolverService

  beforeEach(() => {
    service = new BankAccountResolverService()
    vi.mocked(getRotatingAPIKey).mockReturnValue('sk_test_fake_key')
    mockFetch.mockReset()
    delete process.env.PAYOUT_PROVIDER
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  // ── Validation ──────────────────────────────────────────────────────────────

  it('throws VALIDATION_ERROR when neither bankCode nor bankName is supplied', async () => {
    await expect(
      service.resolve({ accountNumber: '0123456789' }),
    ).rejects.toMatchObject({
      code: ErrorCode.VALIDATION_ERROR,
      status: 400,
    })
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('throws VALIDATION_ERROR when only bankName is supplied (no bankCode)', async () => {
    await expect(
      service.resolve({ accountNumber: '0123456789', bankName: 'GTBank' }),
    ).rejects.toMatchObject({
      code: ErrorCode.VALIDATION_ERROR,
      status: 400,
    })
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('throws SERVICE_UNAVAILABLE when no API key is configured', async () => {
    vi.mocked(getRotatingAPIKey).mockReturnValue(undefined)
    await expect(
      service.resolve({ accountNumber: '0123456789', bankCode: '058' }),
    ).rejects.toMatchObject({
      code: ErrorCode.SERVICE_UNAVAILABLE,
      status: 503,
    })
    expect(mockFetch).not.toHaveBeenCalled()
  })

  // ── Paystack — success ──────────────────────────────────────────────────────

  it('resolves account name via Paystack on success', async () => {
    mockFetch.mockResolvedValueOnce(makePaystackSuccess('JOHN A DOE'))

    const result = await service.resolve({
      accountNumber: '0123456789',
      bankCode: '058',
      bankName: 'GTBank',
      provider: 'paystack',
    })

    expect(result.accountName).toBe('JOHN A DOE')
    expect(result.accountNumber).toBe('0123456789')
    expect(result.bankCode).toBe('058')
    expect(result.bankName).toBe('GTBank')
    expect(result.provider).toBe('paystack')

    // Must have called the Paystack resolve endpoint
    expect(mockFetch).toHaveBeenCalledOnce()
    const [url] = mockFetch.mock.calls[0]
    expect(url).toContain('api.paystack.co/bank/resolve')
    expect(url).toContain('account_number=0123456789')
    expect(url).toContain('bank_code=058')
  })

  it('uses PAYOUT_PROVIDER env var when no explicit provider is given', async () => {
    process.env.PAYOUT_PROVIDER = 'paystack'
    mockFetch.mockResolvedValueOnce(makePaystackSuccess())

    const result = await service.resolve({ accountNumber: '0123456789', bankCode: '058' })
    expect(result.provider).toBe('paystack')
  })

  // ── Paystack — failures ─────────────────────────────────────────────────────

  it('throws VALIDATION_ERROR (422) when Paystack returns account-not-found', async () => {
    mockFetch.mockResolvedValueOnce(makePaystackNotFound('Account number not found'))

    const err = await service
      .resolve({ accountNumber: '9999999999', bankCode: '058', provider: 'paystack' })
      .catch((e) => e)

    expect(err).toBeInstanceOf(AppError)
    expect(err.code).toBe(ErrorCode.VALIDATION_ERROR)
    expect(err.status).toBe(422)
    expect(err.message).toContain('Account number not found')
    // Must NOT be a placeholder
    expect(err.message).not.toContain('JOHN DOE')
  })

  it('throws SERVICE_UNAVAILABLE (503) when Paystack returns 5xx', async () => {
    mockFetch.mockResolvedValueOnce(make5xxResponse('paystack'))

    await expect(
      service.resolve({ accountNumber: '0123456789', bankCode: '058', provider: 'paystack' }),
    ).rejects.toMatchObject({ code: ErrorCode.SERVICE_UNAVAILABLE, status: 503 })
  })

  it('throws TOO_MANY_REQUESTS (429) when Paystack rate-limits the call', async () => {
    mockFetch.mockResolvedValueOnce(make429Response())

    await expect(
      service.resolve({ accountNumber: '0123456789', bankCode: '058', provider: 'paystack' }),
    ).rejects.toMatchObject({ code: ErrorCode.TOO_MANY_REQUESTS, status: 429 })
  })

  it('throws SERVICE_UNAVAILABLE (503) when Paystack request times out (fetch throws abort)', async () => {
    mockFetch.mockRejectedValueOnce(new DOMException('The operation was aborted', 'AbortError'))

    await expect(
      service.resolve({ accountNumber: '0123456789', bankCode: '058', provider: 'paystack' }),
    ).rejects.toMatchObject({ code: ErrorCode.SERVICE_UNAVAILABLE, status: 503 })
  })

  it('throws SERVICE_UNAVAILABLE (503) on a network error to Paystack', async () => {
    mockFetch.mockRejectedValueOnce(new TypeError('fetch failed'))

    await expect(
      service.resolve({ accountNumber: '0123456789', bankCode: '058', provider: 'paystack' }),
    ).rejects.toMatchObject({ code: ErrorCode.SERVICE_UNAVAILABLE, status: 503 })
  })

  // ── Flutterwave — success ───────────────────────────────────────────────────

  it('resolves account name via Flutterwave on success', async () => {
    process.env.PAYOUT_PROVIDER = 'flutterwave'
    mockFetch.mockResolvedValueOnce(makeFlutterwaveSuccess('JANE B DOE'))

    const result = await service.resolve({
      accountNumber: '0123456789',
      bankCode: '058',
      provider: 'flutterwave',
    })

    expect(result.accountName).toBe('JANE B DOE')
    expect(result.provider).toBe('flutterwave')

    const [url, init] = mockFetch.mock.calls[0]
    expect(url).toContain('flutterwave.com/v3/accounts/resolve')
    const body = JSON.parse(init.body)
    expect(body.account_number).toBe('0123456789')
    expect(body.account_bank).toBe('058')
  })

  // ── Flutterwave — failures ──────────────────────────────────────────────────

  it('throws VALIDATION_ERROR (422) when Flutterwave returns account-not-found', async () => {
    mockFetch.mockResolvedValueOnce(makeFlutterwaveNotFound('Account not found'))

    const err = await service
      .resolve({ accountNumber: '9999999999', bankCode: '033', provider: 'flutterwave' })
      .catch((e) => e)

    expect(err).toBeInstanceOf(AppError)
    expect(err.code).toBe(ErrorCode.VALIDATION_ERROR)
    expect(err.status).toBe(422)
    expect(err.message).not.toContain('JOHN DOE')
  })

  it('throws SERVICE_UNAVAILABLE (503) when Flutterwave returns 5xx', async () => {
    mockFetch.mockResolvedValueOnce(make5xxResponse('flutterwave'))

    await expect(
      service.resolve({ accountNumber: '0123456789', bankCode: '033', provider: 'flutterwave' }),
    ).rejects.toMatchObject({ code: ErrorCode.SERVICE_UNAVAILABLE, status: 503 })
  })

  it('throws TOO_MANY_REQUESTS (429) when Flutterwave rate-limits the call', async () => {
    mockFetch.mockResolvedValueOnce(make429Response())

    await expect(
      service.resolve({ accountNumber: '0123456789', bankCode: '033', provider: 'flutterwave' }),
    ).rejects.toMatchObject({ code: ErrorCode.TOO_MANY_REQUESTS, status: 429 })
  })

  it('throws SERVICE_UNAVAILABLE (503) on a network error to Flutterwave', async () => {
    mockFetch.mockRejectedValueOnce(new TypeError('fetch failed'))

    await expect(
      service.resolve({ accountNumber: '0123456789', bankCode: '033', provider: 'flutterwave' }),
    ).rejects.toMatchObject({ code: ErrorCode.SERVICE_UNAVAILABLE, status: 503 })
  })

  // ── Default provider fallback ───────────────────────────────────────────────

  it('defaults to paystack when PAYOUT_PROVIDER is not set', async () => {
    delete process.env.PAYOUT_PROVIDER
    mockFetch.mockResolvedValueOnce(makePaystackSuccess())

    const result = await service.resolve({ accountNumber: '0123456789', bankCode: '058' })
    expect(result.provider).toBe('paystack')
    const [url] = mockFetch.mock.calls[0]
    expect(url).toContain('api.paystack.co')
  })

  it('uses flutterwave when PAYOUT_PROVIDER=flutterwave', async () => {
    process.env.PAYOUT_PROVIDER = 'flutterwave'
    mockFetch.mockResolvedValueOnce(makeFlutterwaveSuccess())

    const result = await service.resolve({ accountNumber: '0123456789', bankCode: '033' })
    expect(result.provider).toBe('flutterwave')
    const [url] = mockFetch.mock.calls[0]
    expect(url).toContain('flutterwave.com')
  })
})
