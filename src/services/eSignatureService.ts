/**
 * E-Signature Service
 * Abstract interface with stub provider for local development
 */

import { createHash, randomUUID } from 'node:crypto'

export function computeDocumentHash(documentKey: string): string {
  return createHash('sha256').update(documentKey).digest('hex')
}

export interface Signer {
  id: string
  name: string
  email: string
  role: 'tenant' | 'landlord'
}

export interface SigningRequest {
  requestId: string
  documentKey: string
  documentHash: string
  signers: Signer[]
  status: 'pending' | 'completed' | 'expired'
  createdAt: Date
}

export interface SigningUrl {
  url: string
  expiresAt: Date
}

export interface ESignatureProvider {
  createSigningRequest(documentKey: string, documentHash: string, signers: Signer[]): Promise<SigningRequest>
  getSigningUrl(requestId: string, signerId: string): Promise<SigningUrl>
  handleWebhook(payload: unknown): Promise<{ requestId: string; signerId: string; signed: boolean }>
  verifySignature(requestId: string, signerId: string): Promise<boolean>
}

interface SignerState {
  token: string
  expiresAt: Date
  signed: boolean
}

interface StoredRequest {
  requestId: string
  documentKey: string
  documentHash: string
  signers: Signer[]
  status: 'pending' | 'completed' | 'expired'
  createdAt: Date
  signerState: Map<string, SignerState>
}

/**
 * Stub e-signature provider for local development
 * Uses in-memory tokens instead of real e-signature service
 */
export class StubESignatureProvider implements ESignatureProvider {
  private requests = new Map<string, StoredRequest>()

  async createSigningRequest(documentKey: string, documentHash: string, signers: Signer[]): Promise<SigningRequest> {
    const requestId = randomUUID()
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000)
    const signerState = new Map<string, SignerState>()

    for (const signer of signers) {
      signerState.set(signer.id, { token: randomUUID(), expiresAt, signed: false })
    }

    const stored: StoredRequest = {
      requestId,
      documentKey,
      documentHash,
      signers,
      status: 'pending',
      createdAt: new Date(),
      signerState,
    }

    this.requests.set(requestId, stored)
    return { requestId, documentKey, documentHash, signers, status: 'pending', createdAt: stored.createdAt }
  }

  async getSigningUrl(requestId: string, signerId: string): Promise<SigningUrl> {
    const request = this.requests.get(requestId)
    if (!request) {
      throw new Error(`Signing request ${requestId} not found`)
    }

    const state = request.signerState.get(signerId)
    if (!state) {
      throw new Error(`Signer ${signerId} not found in request ${requestId}`)
    }

    return {
      url: `/api/webhooks/esignature/stub?token=${state.token}&signer=${signerId}&requestId=${requestId}`,
      expiresAt: state.expiresAt,
    }
  }

  async handleWebhook(payload: unknown): Promise<{ requestId: string; signerId: string; signed: boolean }> {
    const { token, signer, requestId } = payload as {
      token: string
      signer: string
      requestId: string
    }

    const request = this.requests.get(requestId)
    if (!request) {
      throw new Error(`Signing request ${requestId} not found`)
    }

    const state = request.signerState.get(signer)
    if (!state || state.token !== token) {
      throw new Error('Invalid signing token')
    }

    if (Date.now() > state.expiresAt.getTime()) {
      throw new Error('Signing token has expired')
    }

    if (state.signed) {
      throw new Error('Token has already been used')
    }

    state.signed = true

    return { requestId, signerId: signer, signed: true }
  }

  async verifySignature(requestId: string, signerId: string): Promise<boolean> {
    const request = this.requests.get(requestId)
    if (!request) return false

    const state = request.signerState.get(signerId)
    return state?.signed === true
  }
}

/**
 * Create e-signature provider based on environment config.
 *
 * 'stub'   – in-memory provider for local dev / tests (default).
 * 'docuseal' – real DocuSeal-backed provider; requires DOCUSEAL_API_KEY,
 *              DOCUSEAL_API_URL and DOCUSEAL_WEBHOOK_SECRET.
 */
export async function createESignatureProvider(): Promise<ESignatureProvider> {
  const provider = process.env.ESIGN_PROVIDER || 'stub'

  switch (provider) {
    case 'docuseal': {
      const mod = await import('./docusealESignatureProvider.js')
      return new mod.DocuSealESignatureProvider()
    }
    case 'stub':
      return new StubESignatureProvider()
    default:
      return new StubESignatureProvider()
  }
}
