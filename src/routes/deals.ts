/**
 * Deal management routes
 */

import { Router, Request, Response } from 'express'
import { dealStore } from '../models/dealStore.js'
import { listingStore } from '../models/listingStore.js'
import { ListingStatus } from '../models/listing.js'
import { 
  createDealSchema, 
  dealFiltersSchema, 
  updateDealStatusSchema,
  updateScheduleItemSchema,
  CreateDealRequest,
  DealFiltersRequest,
  UpdateDealStatusRequest,
  UpdateScheduleItemRequest
} from '../schemas/deal.js'
import { AppError } from '../errors/AppError.js'
import { ErrorCode } from '../errors/errorCodes.js'
import { outboxStore } from '../outbox/index.js'
import { TxType } from '../outbox/types.js'
import { computeDealProgress } from '../services/dealProgress.js'
import { detectDuplicateDealSpam } from '../services/abuseDetectionService.js'
import { enqueueDelivery } from '../services/webhookDeliveryService.js'
import { WebhookEventType } from '../models/webhookSubscription.js'
import { logger } from '../utils/logger.js'
import { recordDealActivationDuration } from '../metrics.js'
import { applyDealRepaymentMethod } from '../services/salaryDeductionService.js'
import { updateDealRepaymentSchema } from '../schemas/employer.js'
import { idempotency } from '../middleware/idempotency.js'
import { authenticateToken, type AuthenticatedRequest } from '../middleware/auth.js'
import { getRepaymentMandateStore } from '../models/repaymentMandateStore.js'
import { setupMandateSchema } from '../schemas/deal.js'
import { openRewardForDeal } from '../services/whistleblowerRewardService.js'
import { openMandateFromOnboarding } from '../services/onboardingMandate.js'
import { auditLog, extractAuditContext } from '../utils/auditLogger.js'

const router = Router()



/**
 * POST /api/deals
 * Create a new deal with repayment schedule
 * 
 * RACE CONDITION HANDLING (MVP):
 * This implementation uses synchronous validation and locking for the in-memory store.
 * While this prevents most race conditions in single-threaded Node.js execution,
 * it does NOT provide true atomicity guarantees.
 * 
 * Known limitations:
 * - Multiple concurrent requests could theoretically pass validation before any locks
 * - No distributed locking mechanism for multi-instance deployments
 * 
 * Production recommendations:
 * - Use database transactions (BEGIN/COMMIT) to ensure atomic read-check-update
 * - Implement optimistic locking with version numbers on the listing record
 * - Use distributed locks (Redis, etc.) for multi-instance deployments
 * - Add unique constraint on listing.dealId at database level
 */
router.post('/', idempotency(), async (req: Request, res: Response, next) => {
  try {
    const validatedData: CreateDealRequest = createDealSchema.parse(req.body)

    const userId = req.headers['x-user-id'] || (req as any).user?.id
    if (userId && validatedData.listingId) {
      const flagged = await detectDuplicateDealSpam(String(userId), validatedData.listingId)
      if (flagged) {
        throw new AppError(
          ErrorCode.TOO_MANY_REQUESTS,
          429,
          'Your account is temporarily blocked from submitting deal applications.'
        )
      }
    }

    
    // Validate listing if listingId is provided
    if (validatedData.listingId) {
      const listing = await listingStore.getById(validatedData.listingId)
      
      // Check if listing exists
      if (!listing) {
        throw new AppError(
          ErrorCode.NOT_FOUND,
          404,
          `Listing with ID ${validatedData.listingId} not found`
        )
      }
      
      // Check if listing is already rented
      if (listing.status === ListingStatus.RENTED) {
        throw new AppError(
          ErrorCode.LISTING_ALREADY_RENTED,
          409,
          `Listing with ID ${validatedData.listingId} is already rented`
        )
      }
      
      // Check if listing already has a dealId
      if (listing.dealId) {
        throw new AppError(
          ErrorCode.LISTING_ALREADY_RENTED,
          409,
          `Listing with ID ${validatedData.listingId} is already linked to deal ${listing.dealId}`
        )
      }
      
      // Check if listing is approved
      if (listing.status !== ListingStatus.APPROVED) {
        throw new AppError(
          ErrorCode.VALIDATION_ERROR,
          400,
          `Listing must be approved to create a deal. Current status: ${listing.status}`
        )
      }
    }
    
    const deal = await dealStore.create(validatedData as any)

    if (validatedData.repaymentMethod === 'salary_deduction') {
      await applyDealRepaymentMethod(deal.dealId, 'salary_deduction', {
        employerId: validatedData.employerId,
        employeeId: validatedData.employeeId,
        deductionDay: validatedData.deductionDay,
      })
    }
    
    try {
      await openMandateFromOnboarding(deal.dealId, deal.tenantId)
    } catch (mandateError) {
      logger.error('deal.mandate_open_failed', { dealId: deal.dealId, error: mandateError })
    }

    // Lock listing to deal if listingId is provided
    if (validatedData.listingId) {
      await listingStore.lockToDeal(validatedData.listingId, deal.dealId)
    }

    const responseDeal = await dealStore.findById(deal.dealId)
    
    res.status(201).json({
      success: true,
      data: responseDeal ?? deal
    })
  } catch (error) {
    if (error instanceof Error && error.name === 'ZodError') {
      return next(new AppError(ErrorCode.VALIDATION_ERROR, 400, error.message))
    }
    next(error)
  }
})

/**
 * GET /api/deals/:dealId/progress
 * Get a deal's payment progress computed from on-chain receipts
 */
router.get('/:dealId/progress', async (req: Request, res: Response, next) => {
  try {
    const { dealId } = req.params

    if (!dealId) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, 400, 'Deal ID is required')
    }

    const deal = await dealStore.findById(dealId)

    if (!deal) {
      throw new AppError(ErrorCode.NOT_FOUND, 404, `Deal with ID ${dealId} not found`)
    }

    // Fetch all outbox items for this deal filtered to TENANT_REPAYMENT
    const receipts = await outboxStore.listByDealId(dealId, TxType.TENANT_REPAYMENT)

    const progress = computeDealProgress(deal, receipts)

    res.json({
      success: true,
      data: progress,
    })
  } catch (error) {
    next(error)
  }
})

/**
 * GET /api/deals/:dealId
 * Get a specific deal by ID with schedule
 */
router.get('/:dealId', async (req: Request, res: Response, next) => {
  try {
    const { dealId } = req.params
    
    if (!dealId) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, 400, 'Deal ID is required')
    }
    
    const deal = await dealStore.findById(dealId)
    
    if (!deal) {
      throw new AppError(ErrorCode.NOT_FOUND, 404, `Deal with ID ${dealId} not found`)
    }
    
    res.json({
      success: true,
      data: deal
    })
  } catch (error) {
    next(error)
  }
})

/**
 * GET /api/deals
 * Get deals with optional filtering
 */
router.get('/', async (req: Request, res: Response, next) => {
  try {
    const validatedFilters: DealFiltersRequest = dealFiltersSchema.parse(req.query)
    
    const result = await dealStore.findMany(validatedFilters)
    
    res.json({
      success: true,
      data: result
    })
  } catch (error) {
    if (error instanceof Error && error.name === 'ZodError') {
      return next(new AppError(ErrorCode.VALIDATION_ERROR, 400, error.message))
    }
    next(error)
  }
})

/**
 * PATCH /api/deals/:dealId/status
 * Update deal status
 */
router.patch('/:dealId/status', async (req: Request, res: Response, next) => {
  const { dealId } = req.params
  
  if (!dealId) {
    return next(new AppError(ErrorCode.VALIDATION_ERROR, 400, 'Deal ID is required'))
  }
  
  try {
    const validatedData: UpdateDealStatusRequest = updateDealStatusSchema.parse(req.body)
    const activationStart =
      validatedData.status === 'active' ? Date.now() : null
    
    const deal = await dealStore.updateStatus(dealId, validatedData.status)
    
    if (!deal) {
      throw new AppError(ErrorCode.NOT_FOUND, 404, `Deal with ID ${dealId} not found`)
    }

    if (deal) {
      let eventType: WebhookEventType | undefined
      if (validatedData.status === 'active') {
        if (activationStart !== null) {
          recordDealActivationDuration(Date.now() - activationStart)
        }
        eventType = WebhookEventType.DEAL_ACTIVATED

        // The reporter of this apartment earns a reward, held until the rental has held.
        try {
          await openRewardForDeal(deal)
        } catch (rewardError) {
          logger.error('Failed to open whistleblower reward on activation', {
            dealId: deal.dealId,
            error: rewardError,
          })
        }

        // Generate and save repayment schedule on activation
        try {
          const { generateSchedule, saveSchedule } = await import('../services/repaymentScheduleService.js')
          
          // Determine plan based on term months
          const planMap: Record<number, '3m' | '6m' | '12m' | 'outright'> = {
            3: '3m',
            6: '6m',
            12: '12m',
          }
          const plan = planMap[deal.termMonths] || '12m'
          
          const schedule = generateSchedule({
            dealId: deal.dealId,
            startDate: deal.createdAt,
            plan,
            installmentBasePriceNgn: deal.annualRentNgn,
            depositPct: Math.round((deal.depositNgn / deal.annualRentNgn) * 100),
          })
          
          await saveSchedule(
            deal.dealId,
            schedule.schedule,
            schedule.depositAmountNgn,
            schedule.financedBalanceNgn,
            schedule.interestAmountNgn,
            schedule.totalRepaymentNgn
          )
          
          logger.info('Repayment schedule generated and saved on deal activation', {
            dealId: deal.dealId,
            plan,
            totalRepaymentNgn: schedule.totalRepaymentNgn,
          })
        } catch (scheduleError) {
          logger.error('Failed to generate repayment schedule on activation', {
            dealId: deal.dealId,
            error: scheduleError,
          })
        }
      } else if (validatedData.status === 'completed') {
        eventType = WebhookEventType.DEAL_COMPLETED
      } else if (validatedData.status === 'defaulted') {
        eventType = WebhookEventType.DEAL_DEFAULTED
      }

      if (eventType) {
        await enqueueDelivery(eventType, {
          dealId: deal.dealId,
          status: deal.status,
          listingId: deal.listingId,
          tenantId: deal.tenantId,
          landlordId: deal.landlordId,
          totalFinancedAmount: deal.financedAmountNgn
        }).catch(err => logger.error('Failed to enqueue deal webhook:', err))
      }
    }

    
    res.json({
      success: true,
      data: deal
    })
  } catch (error) {
    if (error instanceof Error && error.name === 'ZodError') {
      return next(new AppError(ErrorCode.VALIDATION_ERROR, 400, error.message))
    }
    next(error)
  }
})

/**
 * PATCH /api/deals/:dealId/schedule/:period
 * Update schedule item status
 */
router.patch('/:dealId/schedule/:period', async (req: Request, res: Response, next) => {
  const { dealId } = req.params
  const period = parseInt(req.params.period, 10)
  
  if (!dealId || isNaN(period)) {
    return next(new AppError(ErrorCode.VALIDATION_ERROR, 400, 'Deal ID and period are required'))
  }
  
  try {
    const validatedData: UpdateScheduleItemRequest = updateScheduleItemSchema.parse({
      ...req.body,
      period
    })
    
    const deal = await dealStore.updateScheduleItemStatus(
      dealId, 
      validatedData.period, 
      validatedData.status as any
    )
    
    if (!deal) {
      throw new AppError(ErrorCode.NOT_FOUND, 404, `Deal with ID ${dealId} not found`)
    }
    
    res.json({
      success: true,
      data: deal
    })
  } catch (error) {
    if (error instanceof Error && error.name === 'ZodError') {
      return next(new AppError(ErrorCode.VALIDATION_ERROR, 400, error.message))
    }
    next(error)
  }
})

/**
 * PATCH /api/deals/:dealId/repayment
 * Update repayment method and salary deduction linkage
 */
router.patch('/:dealId/repayment', async (req: Request, res: Response, next) => {
  const { dealId } = req.params
  if (!dealId) {
    return next(new AppError(ErrorCode.VALIDATION_ERROR, 400, 'Deal ID is required'))
  }
  try {
    const body = updateDealRepaymentSchema.parse(req.body)
    await applyDealRepaymentMethod(dealId, body.repaymentMethod, {
      employerId: body.employerId,
      employeeId: body.employeeId,
      deductionDay: body.deductionDay,
    })
    const deal = await dealStore.findById(dealId)
    res.json({ success: true, data: deal })
  } catch (error) {
    if (error instanceof Error && error.name === 'ZodError') {
      return next(new AppError(ErrorCode.VALIDATION_ERROR, 400, error.message))
    }
    next(error)
  }
})

/**
 * GET /api/deals/:dealId/schedule
 * Get repayment schedule for a deal
 * Authenticated; tenant or landlord of the deal can view
 */
router.get('/:dealId/schedule', async (req: Request, res: Response, next) => {
  try {
    const { dealId } = req.params
    
    if (!dealId) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, 400, 'Deal ID is required')
    }
    
    const deal = await dealStore.findById(dealId)
    
    if (!deal) {
      throw new AppError(ErrorCode.NOT_FOUND, 404, `Deal with ID ${dealId} not found`)
    }
    
    const userId = req.headers['x-user-id'] || (req as any).user?.id
    
    // Check if user is tenant or landlord
    if (userId && userId !== deal.tenantId && userId !== deal.landlordId) {
      throw new AppError(ErrorCode.FORBIDDEN, 403, 'You are not authorized to view this schedule')
    }
    
    const { getSchedule } = await import('../services/repaymentScheduleService.js')
    const schedule = await getSchedule(dealId)
    
    if (!schedule) {
      throw new AppError(ErrorCode.NOT_FOUND, 404, `Repayment schedule not found for deal ${dealId}`)
    }
    
    res.json({
      success: true,
      data: schedule
    })
  } catch (error) {
    next(error)
  }
})

/** Loads the deal and checks that the signed-in user is its tenant. */
async function requireDealTenant(req: AuthenticatedRequest, dealId: string | undefined) {
  if (!dealId) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, 400, 'Deal ID is required')
  }
  const deal = await dealStore.findById(dealId)
  if (!deal) {
    throw new AppError(ErrorCode.NOT_FOUND, 404, `Deal with ID ${dealId} not found`)
  }
  if (req.user?.id !== deal.tenantId) {
    throw new AppError(ErrorCode.FORBIDDEN, 403, 'Only the tenant on this deal can use its repayment mandate')
  }
  return deal
}

/**
 * GET /api/deals/:dealId/mandate
 * The automatic bank deduction for this deal. Every deal repays this way.
 */
router.get('/:dealId/mandate', authenticateToken, async (req: AuthenticatedRequest, res: Response, next) => {
  try {
    const deal = await requireDealTenant(req, req.params.dealId)
    const mandate = await getRepaymentMandateStore().findByDealId(deal.dealId)
    if (!mandate) {
      throw new AppError(ErrorCode.NOT_FOUND, 404, 'Automatic deduction has not been set up for this deal yet')
    }
    const { providerReference: _ref, ...visible } = mandate
    res.json({ success: true, data: visible })
  } catch (error) {
    next(error)
  }
})

/**
 * PUT /api/deals/:dealId/mandate
 * Records the bank account the deduction draws from, once the tenant has
 * authorised it with the payment provider during onboarding. Only the last four
 * digits of the account number are stored.
 */
router.put('/:dealId/mandate', authenticateToken, async (req: AuthenticatedRequest, res: Response, next) => {
  try {
    const deal = await requireDealTenant(req, req.params.dealId)
    const body = setupMandateSchema.parse(req.body)

    const mandate = await getRepaymentMandateStore().upsert({
      dealId: deal.dealId,
      bankName: body.bankName,
      accountName: body.accountName,
      accountLast4: body.accountNumber.slice(-4),
      deductionDay: body.deductionDay,
      providerReference: body.providerReference,
      status: 'active',
    })

    auditLog('REPAYMENT_MANDATE_SET', extractAuditContext(req, 'user'), {
      dealId: deal.dealId,
      deductionDay: body.deductionDay,
    })

    const { providerReference: _ref, ...visible } = mandate
    res.json({ success: true, data: visible })
  } catch (error) {
    if (error instanceof Error && error.name === 'ZodError') {
      return next(new AppError(ErrorCode.VALIDATION_ERROR, 400, error.message))
    }
    next(error)
  }
})

export function createDealsRouter(): Router {
  return router
}
