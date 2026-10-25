import { Router, type Request, type Response, type NextFunction } from 'express'
import { getPool } from '../db.js'
import { authenticateToken } from '../middleware/auth.js'
import { AppError } from '../errors/AppError.js'
import { ErrorCode } from '../errors/errorCodes.js'
import { logger } from '../utils/logger.js'
import {
  encryptPersonalInfoFields,
  encryptPii,
} from '../utils/piiEncryption.js'
import { bankAccountResolverService } from '../services/BankAccountResolverService.js'
import {
  onboardingDraftSchema,
  repaymentAccountRequestSchema,
  type RepaymentInfo,
  ONBOARDING_STEPS,
  type OnboardingStep,
  type OnboardingRecord,
} from '../schemas/onboarding.js'

function deriveCurrentStep(completedSteps: string[]): OnboardingStep {
  for (const step of ONBOARDING_STEPS) {
    if (!completedSteps.includes(step)) return step
  }
  return 'summary'
}

function mapRow(row: Record<string, unknown>): OnboardingRecord {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    personalInfo: row.personal_info ? (row.personal_info as any) : null,
    employmentInfo: row.employment_info ? (row.employment_info as any) : null,
    documents: row.documents ? (row.documents as any) : null,
    walletInfo: row.wallet_info ? (row.wallet_info as any) : null,
    repaymentInfo: row.repayment_info ? (row.repayment_info as RepaymentInfo) : null,
    completedSteps: (row.completed_steps as string[]) ?? [],
    currentStep: (row.current_step as OnboardingStep) ?? 'personal_info',
    submitted: row.submitted as boolean,
    submittedAt: row.submitted_at ? new Date(row.submitted_at as string) : null,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  }
}

export function createOnboardingRouter(): Router {
  const router = Router()

  router.use(authenticateToken)

  /**
   * POST /api/onboarding/draft
   * Upsert the tenant's onboarding draft. Accepts partial payload for any step.
   * Auto-advances completedSteps based on which sections are present.
   */
  router.post('/draft', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = (req as any).user.id as string

      const parsed = onboardingDraftSchema.safeParse(req.body)
      if (!parsed.success) {
        throw new AppError(ErrorCode.VALIDATION_ERROR, 400, 'Invalid onboarding data', {
          fields: parsed.error.errors,
        })
      }

      const { personalInfo, employmentInfo, documents, walletInfo } = parsed.data
      const storedPersonalInfo = personalInfo
        ? encryptPersonalInfoFields(personalInfo as Record<string, unknown>)
        : null

      const pool = await getPool()
      if (!pool) throw new AppError(ErrorCode.INTERNAL_ERROR, 500, 'Database not available')

      // Determine which steps are now completed based on submitted data
      const existing = await pool
        .query(`SELECT * FROM onboarding_drafts WHERE user_id = $1`, [userId])
        .then(r => (r.rows[0] ? mapRow(r.rows[0]) : null))

      const completedSteps = new Set<string>(existing?.completedSteps ?? [])
      if (personalInfo) completedSteps.add('personal_info')
      if (employmentInfo) completedSteps.add('employment_info')
      if (documents) completedSteps.add('documents')
      if (walletInfo !== undefined) completedSteps.add('wallet')

      const completedStepsArr = Array.from(completedSteps)
      const currentStep = deriveCurrentStep(completedStepsArr)

      const { rows } = await pool.query(
        `INSERT INTO onboarding_drafts (
           user_id, personal_info, employment_info, documents, wallet_info,
           completed_steps, current_step, updated_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
         ON CONFLICT (user_id) DO UPDATE SET
           personal_info   = COALESCE($2, onboarding_drafts.personal_info),
           employment_info = COALESCE($3, onboarding_drafts.employment_info),
           documents       = COALESCE($4, onboarding_drafts.documents),
           wallet_info     = COALESCE($5, onboarding_drafts.wallet_info),
           completed_steps = $6,
           current_step    = $7,
           updated_at      = NOW()
         RETURNING *`,
        [
          userId,
          storedPersonalInfo ? JSON.stringify(storedPersonalInfo) : null,
          employmentInfo ? JSON.stringify(employmentInfo) : null,
          documents ? JSON.stringify(documents) : null,
          walletInfo !== undefined ? JSON.stringify(walletInfo) : null,
          completedStepsArr,
          currentStep,
        ],
      )

      const record = mapRow(rows[0])
      res.json({
        success: true,
        completedSteps: record.completedSteps,
        currentStep: record.currentStep,
      })
    } catch (error) {
      next(error)
    }
  })

  /**
   * POST /api/onboarding/repayment-account
   * Verifies the bank account rent will be deducted from and records the
   * tenant's authorisation. The holder's name comes from the bank lookup, so it
   * can't be typed in; the account number is stored encrypted.
   */
  router.post('/repayment-account', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = (req as any).user.id as string
      const parsed = repaymentAccountRequestSchema.safeParse(req.body)
      if (!parsed.success) {
        throw new AppError(
          ErrorCode.VALIDATION_ERROR,
          400,
          parsed.error.issues.map((i) => i.message).join(', '),
        )
      }
      const { bankCode, bankName, accountNumber, deductionDay } = parsed.data

      const resolved = await bankAccountResolverService.resolve({ accountNumber, bankCode, bankName })

      const repaymentInfo: RepaymentInfo = {
        bankCode,
        bankName,
        accountNumberEncrypted: encryptPii(accountNumber),
        accountLast4: accountNumber.slice(-4),
        accountName: resolved.accountName,
        deductionDay,
        consentAcceptedAt: new Date().toISOString(),
      }

      const pool = await getPool()
      if (!pool) throw new AppError(ErrorCode.INTERNAL_ERROR, 500, 'Database not available')

      const existing = await pool
        .query(`SELECT completed_steps FROM onboarding_drafts WHERE user_id = $1`, [userId])
        .then((r) => (r.rows[0]?.completed_steps as string[] | undefined) ?? [])
      const completedSteps = Array.from(new Set([...existing, 'repayment']))

      await pool.query(
        `INSERT INTO onboarding_drafts (user_id, repayment_info, completed_steps, current_step, updated_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (user_id) DO UPDATE SET
           repayment_info  = $2,
           completed_steps = $3,
           current_step    = $4,
           updated_at      = NOW()`,
        [userId, JSON.stringify(repaymentInfo), completedSteps, deriveCurrentStep(completedSteps)],
      )

      res.json({
        success: true,
        data: {
          bankName,
          accountName: resolved.accountName,
          accountLast4: repaymentInfo.accountLast4,
          deductionDay,
        },
      })
    } catch (error) {
      next(error)
    }
  })

  /**
   * GET /api/onboarding/status
   * Returns { completedSteps, currentStep, submitted }
   */
  router.get('/status', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = (req as any).user.id as string
      const pool = await getPool()
      if (!pool) throw new AppError(ErrorCode.INTERNAL_ERROR, 500, 'Database not available')

      const { rows } = await pool.query(
        `SELECT * FROM onboarding_drafts WHERE user_id = $1`,
        [userId],
      )

      if (rows.length === 0) {
        return res.json({
          completedSteps: [],
          currentStep: 'personal_info',
          submitted: false,
        })
      }

      const record = mapRow(rows[0])
      res.json({
        completedSteps: record.completedSteps,
        currentStep: record.currentStep,
        submitted: record.submitted,
        submittedAt: record.submittedAt,
      })
    } catch (error) {
      next(error)
    }
  })

  /**
   * POST /api/onboarding/submit
   * Marks the draft as submitted and enqueues the underwriting pipeline.
   */
  router.post('/submit', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = (req as any).user.id as string
      const pool = await getPool()
      if (!pool) throw new AppError(ErrorCode.INTERNAL_ERROR, 500, 'Database not available')

      const { rows } = await pool.query(
        `SELECT * FROM onboarding_drafts WHERE user_id = $1`,
        [userId],
      )

      if (rows.length === 0) {
        throw new AppError(ErrorCode.NOT_FOUND, 404, 'No onboarding draft found')
      }

      const record = mapRow(rows[0])

      if (record.submitted) {
        throw new AppError(ErrorCode.CONFLICT, 409, 'Onboarding already submitted')
      }

      // Require at minimum personal info and employment info
      if (!record.personalInfo || !record.employmentInfo) {
        throw new AppError(
          ErrorCode.VALIDATION_ERROR,
          400,
          'Personal info and employment info are required before submission',
        )
      }

      if (!record.repaymentInfo) {
        throw new AppError(
          ErrorCode.VALIDATION_ERROR,
          400,
          'Authorise automatic rent deduction from your bank account before submitting',
        )
      }

      await pool.query(
        `UPDATE onboarding_drafts
         SET submitted = TRUE, submitted_at = NOW(), updated_at = NOW()
         WHERE user_id = $1`,
        [userId],
      )

      // Enqueue profile-review job for the underwriting pipeline.
      // The full rule-engine evaluation runs when the tenant submits a property application
      // (which requires an applicationId). This job triggers initial data review.
      try {
        const { getJobStore } = await import('../jobs/scheduler/store.js')
        await getJobStore().create({
          name: 'onboarding_review',
          handler: 'onboardingReview',
          payload: { userId },
          priority: 5,
          maxRetries: 3,
        })
      } catch (jobErr) {
        logger.warn('onboarding.job_enqueue_failed', { userId, error: jobErr })
      }

      logger.info('onboarding.submitted', { userId })

      res.json({ success: true, message: 'Assessment in progress' })
    } catch (error) {
      next(error)
    }
  })

  return router
}
