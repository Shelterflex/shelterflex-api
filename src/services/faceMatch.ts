/**
 * Face verification for whistleblowers: a live selfie is matched against the
 * photo held for their national ID number (NIN), with a liveness check, so each
 * reporter is a real, identifiable person.
 *
 * The matching itself belongs to an identity provider (Smile ID, Dojah,
 * Prembly and the like). This file is the seam: implement `FaceMatchProvider`
 * for the provider you contract and select it with FACE_MATCH_PROVIDER. Until
 * one is configured, production refuses to verify anyone rather than guess.
 *
 * Neither the selfie nor the NIN is kept: only the outcome and the provider's
 * reference are stored.
 */

import { AppError } from '../errors/AppError.js'
import { ErrorCode } from '../errors/errorCodes.js'
import { logger } from '../utils/logger.js'

export interface FaceMatchRequest {
  userId: string
  /** The selfie image bytes. */
  selfie: Buffer
  selfieContentType: string
  /** 11-digit National Identification Number. */
  nin: string
}

export interface FaceMatchResult {
  passed: boolean
  /** The provider's id for this check, for support and audits. */
  reference: string
  /** Why it failed, in words safe to show the user. */
  failureReason?: string
}

export interface FaceMatchProvider {
  verify(request: FaceMatchRequest): Promise<FaceMatchResult>
}

/**
 * For local development and tests only: passes any non-trivial selfie. It
 * proves nothing about the person, so it is never used in production.
 */
class DevFaceMatchProvider implements FaceMatchProvider {
  async verify(request: FaceMatchRequest): Promise<FaceMatchResult> {
    logger.warn('Using the development face-match provider; no real verification took place', {
      userId: request.userId,
    })
    if (request.selfie.length < 1024) {
      return { passed: false, reference: 'dev-face-match', failureReason: 'The photo was too small to check.' }
    }
    return { passed: true, reference: `dev-${Date.now()}` }
  }
}

let override: FaceMatchProvider | null = null

/** Lets a test (or a real provider module) supply the provider. */
export function setFaceMatchProvider(provider: FaceMatchProvider | null): void {
  override = provider
}

export function getFaceMatchProvider(): FaceMatchProvider {
  if (override) return override

  const configured = process.env.FACE_MATCH_PROVIDER
  if (configured === 'dev' && process.env.NODE_ENV !== 'production') {
    return new DevFaceMatchProvider()
  }
  if (process.env.NODE_ENV !== 'production' && !configured) {
    return new DevFaceMatchProvider()
  }

  throw new AppError(
    ErrorCode.SERVICE_UNAVAILABLE,
    503,
    'Identity verification is not available right now. Please try again later.',
  )
}
