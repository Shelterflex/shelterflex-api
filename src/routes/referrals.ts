import { Router, type Request, type Response, type NextFunction } from 'express'
import { authenticateToken, type AuthenticatedRequest } from '../middleware/auth.js'
import { AppError } from '../errors/AppError.js'
import { ErrorCode } from '../errors/errorCodes.js'
import { applyReferralCodeSchema } from '../schemas/referral.js'
import { referralService } from '../services/referralService.js'
import { referralRepository } from '../repositories/ReferralRepository.js'
import { getPool } from '../db.js'
import { auditLog, extractAuditContext } from '../utils/auditLogger.js'

const router = Router()

function requireTenant(req: Request): string {
  const user = (req as any).user
  if (!user?.id) {
    throw new AppError(ErrorCode.UNAUTHORIZED, 401, 'User not authenticated')
  }
  if (user.role !== 'tenant') {
    throw new AppError(ErrorCode.FORBIDDEN, 403, 'Only tenants can access referrals')
  }
  return user.id as string
}

/**
 * GET /api/v1/tenant/referral
 * Get tenant's referral code and stats
 */
router.get('/tenant/referral', authenticateToken, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tenantId = requireTenant(req)

    const stats = await referralService.getReferralStats(tenantId)

    auditLog('REFERRAL_VIEWED', extractAuditContext(req, 'user'), {
      tenantId,
    })

    res.json({
      success: true,
      data: stats,
    })
  } catch (error) {
    next(error)
  }
})

/**
 * POST /api/v1/referrals/apply
 * Apply a referral code at registration (public endpoint)
 */
router.post('/referrals/apply', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = applyReferralCodeSchema.safeParse(req.body)
    if (!parsed.success) {
      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        400,
        'Invalid referral code format',
      )
    }

    const { referralCode } = parsed.data
    const referredTenantId = req.body.referredTenantId || (req as any).user?.id

    if (!referredTenantId) {
      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        400,
        'Referred tenant ID is required',
      )
    }

    const conversion = await referralService.applyReferralCode(referralCode, referredTenantId)

    auditLog('REFERRAL_APPLIED', extractAuditContext(req, 'user'), {
      referralCode,
      referredTenantId,
    })

    res.status(201).json({
      success: true,
      data: {
        message: 'Referral code applied successfully',
        conversionId: conversion.id,
      },
    })
  } catch (error) {
    next(error)
  }
})

/**
 * GET /api/v1/admin/referrals
 * Admin view of all referral conversions with details
 */
router.get('/admin/referrals', authenticateToken, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as any).user
    if (user?.role !== 'admin') {
      throw new AppError(ErrorCode.FORBIDDEN, 403, 'Only admins can view all referrals')
    }

    const conversions = await referralRepository.getAllConversions()

    // Fetch user details for each conversion
    const pool = await getPool()
    if (!pool) throw new Error('Database not configured')

    const enriched = await Promise.all(
      conversions.map(async (conv) => {
        const { rows } = await pool.query(
          `SELECT u1.email as referrer_email, u2.email as referred_email, rc.code
           FROM referral_conversions rc
           JOIN referral_codes r ON rc.referral_code_id = r.id
           JOIN users u1 ON r.tenant_id = u1.id
           JOIN users u2 ON rc.referred_tenant_id = u2.id
           WHERE rc.id = $1`,
          [conv.id],
        )

        if (rows.length === 0) return null

        const row = rows[0]
        return {
          id: conv.id,
          referrerCode: row.code,
          referrerEmail: row.referrer_email,
          referredEmail: row.referred_email,
          dealId: conv.dealId,
          rewardAmountNgn: conv.rewardAmountNgn,
          status: conv.status,
          createdAt: conv.createdAt,
        }
      }),
    )

    auditLog('ADMIN_REFERRALS_VIEWED', extractAuditContext(req, 'user'), {
      totalCount: conversions.length,
    })

    res.json({
      success: true,
      data: enriched.filter(Boolean),
    })
  } catch (error) {
    next(error)
  }
})

export function createReferralsRouter(): Router {
  return router
}
