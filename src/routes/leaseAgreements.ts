/**
 * Lease Agreement routes
 */

import { Router, Response, Request } from 'express'
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth.js'
import { leaseAgreementStore } from '../models/leaseAgreementStore.js'
import { LeaseStatus } from '../models/leaseAgreement.js'
import { dealStore } from '../models/dealStore.js'
import { generateLeaseDraft, buildLeaseTemplateData } from '../services/leaseDocumentService.js'
import { createESignatureProvider, computeDocumentHash } from '../services/eSignatureService.js'
import { AppError } from '../errors/AppError.js'
import { ErrorCode } from '../errors/errorCodes.js'

const router = Router()
const esignProvider = createESignatureProvider()

/**
 * POST /api/deals/:dealId/lease/generate
 * Generate a lease draft for a deal
 */
router.post(
  '/deals/:dealId/lease/generate',
  authenticateToken,
  async (req: AuthenticatedRequest, res: Response, next) => {
    try {
      const { dealId } = req.params

      const deal = await dealStore.findById(dealId)
      if (!deal) {
        throw new AppError(ErrorCode.NOT_FOUND, 404, 'Deal not found')
      }

      // Only landlord can generate leases for their deals
      if (req.user?.role !== 'landlord') {
        throw new AppError(ErrorCode.FORBIDDEN, 403, 'Only landlords can generate leases')
      }

      const templateData = buildLeaseTemplateData(deal, deal.listingId || 'Property')
      const { leaseId, documentKey } = await generateLeaseDraft(dealId, templateData)

      res.status(201).json({
        success: true,
        data: { leaseId, documentKey, status: LeaseStatus.DRAFT },
      })
    } catch (error) {
      next(error)
    }
  },
)

/**
 * POST /api/deals/:dealId/lease/send
 * Send signing requests to both tenant and landlord
 */
router.post(
  '/deals/:dealId/lease/send',
  authenticateToken,
  async (req: AuthenticatedRequest, res: Response, next) => {
    try {
      const { dealId } = req.params

      const deal = await dealStore.findById(dealId)
      if (!deal) {
        throw new AppError(ErrorCode.NOT_FOUND, 404, 'Deal not found')
      }

      const lease = await leaseAgreementStore.getByDealId(dealId)
      if (!lease) {
        throw new AppError(ErrorCode.NOT_FOUND, 404, 'No lease agreement found for this deal. Generate one first.')
      }

      if (lease.status !== LeaseStatus.DRAFT) {
        throw new AppError(ErrorCode.VALIDATION_ERROR, 400, 'Lease must be in draft status to send')
      }

      // Create signing request with stub provider
      await esignProvider.createSigningRequest(lease.documentKey, computeDocumentHash(lease.documentKey), [
        { id: deal.tenantId, name: `Tenant ${deal.tenantId}`, email: '', role: 'tenant' },
        { id: deal.landlordId, name: `Landlord ${deal.landlordId}`, email: '', role: 'landlord' },
      ])

      // Update lease status
      await leaseAgreementStore.updateStatus(lease.leaseId, LeaseStatus.PENDING_TENANT_SIGNATURE)

      res.json({
        success: true,
        data: { message: 'Signing requests sent to tenant and landlord' },
      })
    } catch (error) {
      next(error)
    }
  },
)

/**
 * GET /api/deals/:dealId/lease/sign-url
 * Get a signing URL for the authenticated user
 */
router.get(
  '/deals/:dealId/lease/sign-url',
  authenticateToken,
  async (req: AuthenticatedRequest, res: Response, next) => {
    try {
      const { dealId } = req.params

      const deal = await dealStore.findById(dealId)
      if (!deal) {
        throw new AppError(ErrorCode.NOT_FOUND, 404, 'Deal not found')
      }

      const lease = await leaseAgreementStore.getByDealId(dealId)
      if (!lease) {
        throw new AppError(ErrorCode.NOT_FOUND, 404, 'No lease agreement found for this deal')
      }

      // Determine which signer the user is
      let signerId: string
      if (req.user?.id === deal.tenantId) {
        signerId = deal.tenantId
      } else if (req.user?.id === deal.landlordId) {
        signerId = deal.landlordId
      } else {
        throw new AppError(ErrorCode.FORBIDDEN, 403, 'You are not a party to this lease')
      }

      // Get signing URL from provider
      // In stub mode, we create a new request for each URL request
      const signingRequest = await esignProvider.createSigningRequest(lease.documentKey, computeDocumentHash(lease.documentKey), [
        { id: deal.tenantId, name: '', email: '', role: 'tenant' },
        { id: deal.landlordId, name: '', email: '', role: 'landlord' },
      ])

      const signingUrl = await esignProvider.getSigningUrl(signingRequest.requestId, signerId)

      res.json({
        success: true,
        data: {
          url: signingUrl.url,
          expiresAt: signingUrl.expiresAt,
          signerRole: signerId === deal.tenantId ? 'tenant' : 'landlord',
        },
      })
    } catch (error) {
      next(error)
    }
  },
)

/**
 * GET /api/deals/:dealId/lease
 * Get the current lease agreement status
 */
router.get(
  '/deals/:dealId/lease',
  authenticateToken,
  async (req: AuthenticatedRequest, res: Response, next) => {
    try {
      const { dealId } = req.params

      const deal = await dealStore.findById(dealId)
      if (!deal) {
        throw new AppError(ErrorCode.NOT_FOUND, 404, 'Deal not found')
      }

      const lease = await leaseAgreementStore.getByDealId(dealId)
      if (!lease) {
        throw new AppError(ErrorCode.NOT_FOUND, 404, 'No lease agreement found for this deal')
      }

      res.json({
        success: true,
        data: lease,
      })
    } catch (error) {
      next(error)
    }
  },
)

/**
 * POST /api/deals/:dealId/lease/void
 * Void a lease agreement
 */
router.post(
  '/deals/:dealId/lease/void',
  authenticateToken,
  async (req: AuthenticatedRequest, res: Response, next) => {
    try {
      const { dealId } = req.params

      const lease = await leaseAgreementStore.getByDealId(dealId)
      if (!lease) {
        throw new AppError(ErrorCode.NOT_FOUND, 404, 'No lease agreement found for this deal')
      }

      if (lease.status === LeaseStatus.FULLY_SIGNED) {
        throw new AppError(ErrorCode.VALIDATION_ERROR, 400, 'Cannot void a fully signed lease')
      }

      await leaseAgreementStore.void(lease.leaseId)

      res.json({
        success: true,
        data: { message: 'Lease agreement voided' },
      })
    } catch (error) {
      next(error)
    }
  },
)

/**
 * POST /api/webhooks/esignature
 * Webhook endpoint for e-signature events
 */
router.post(
  '/webhooks/esignature',
  async (req: Request, res: Response, next) => {
    try {
      const result = await esignProvider.handleWebhook(req.body)

      // Find the lease by deal ID (from the request)
      // In production, the webhook would include the lease/deal reference
      // For now, we just acknowledge the webhook

      res.json({
        success: true,
        data: result,
      })
    } catch (error) {
      next(error)
    }
  },
)

/**
 * POST /api/webhooks/esignature/stub
 * Stub webhook for local development - simulates signing
 */
router.post(
  '/webhooks/esignature/stub',
  async (req: Request, res: Response, next) => {
    try {
      const { token, signer, requestId } = (req as any).query as {
        token: string
        signer: string
        requestId: string
      }

      if (!token || !signer || !requestId) {
        throw new AppError(ErrorCode.VALIDATION_ERROR, 400, 'Missing required query params: token, signer, requestId')
      }

      const result = await esignProvider.handleWebhook({ token, signer, requestId })

      res.json({
        success: true,
        data: {
          message: `Signature recorded for ${signer}`,
          ...result,
        },
      })
    } catch (error) {
      next(error)
    }
  },
)

export function createLeaseAgreementsRouter(): Router {
  return router
}
