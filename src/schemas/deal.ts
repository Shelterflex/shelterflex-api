import { z } from 'zod'
import { DealStatus } from '../models/deal.js'

/**
 * Schema for creating a new deal
 */
export const createDealSchema = z.object({
  tenantId: z.string().min(1, 'Tenant ID is required'),
  landlordId: z.string().min(1, 'Landlord ID is required'),
  listingId: z.string().optional(),
  annualRentNgn: z
    .number()
    .positive('Annual rent must be greater than 0')
    .int('Annual rent must be a whole number'),
  depositNgn: z
    .number()
    .positive('Deposit must be greater than 0')
    .int('Deposit must be a whole number'),
  termMonths: z
    .number()
    .int('Term months must be a whole number')
    .refine((val) => [3, 6, 12].includes(val), {
      message: 'Term months must be one of: 3, 6, 12',
    }),
  repaymentMethod: z.enum(['self_pay', 'salary_deduction']).default('self_pay'),
  employerId: z.string().uuid().optional(),
  employeeId: z.string().min(1).max(128).optional(),
  deductionDay: z.number().int().min(1).max(28).optional(),
}).refine(
  (data) => data.depositNgn >= data.annualRentNgn * 0.2,
  {
    message: 'Deposit must be at least 20% of annual rent',
    path: ['depositNgn'],
  }
).refine(
  (data) => data.depositNgn < data.annualRentNgn,
  {
    message: 'Deposit must be less than annual rent',
    path: ['depositNgn'],
  }
).superRefine((data, ctx) => {
  if (data.repaymentMethod === 'salary_deduction') {
    if (!data.employerId) {
      ctx.addIssue({ code: 'custom', message: 'employerId is required for salary deduction', path: ['employerId'] })
    }
    if (!data.employeeId) {
      ctx.addIssue({ code: 'custom', message: 'employeeId is required for salary deduction', path: ['employeeId'] })
    }
    if (!data.deductionDay) {
      ctx.addIssue({ code: 'custom', message: 'deductionDay is required for salary deduction', path: ['deductionDay'] })
    }
  }
})

export type CreateDealRequest = z.infer<typeof createDealSchema>

/**
 * Schema for deal filters (query params)
 */
export const dealFiltersSchema = z.object({
  tenantId: z.string().optional(),
  landlordId: z.string().optional(),
  status: z.nativeEnum(DealStatus).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
})

export type DealFiltersRequest = z.infer<typeof dealFiltersSchema>

/**
 * Schema for updating deal status
 */
export const updateDealStatusSchema = z.object({
  status: z.nativeEnum(DealStatus),
})

export type UpdateDealStatusRequest = z.infer<typeof updateDealStatusSchema>

/**
 * Schema for updating schedule item status
 */
export const updateScheduleItemSchema = z.object({
  period: z.number().int().min(1, 'Period must be a positive integer'),
  status: z.enum(['upcoming', 'due', 'paid', 'late']),
})

export type UpdateScheduleItemRequest = z.infer<typeof updateScheduleItemSchema>

/** Bank details collected when the deduction is set up; the full account number is never kept. */
export const setupMandateSchema = z.object({
  bankName: z.string().min(1).max(100),
  accountName: z.string().min(1).max(150),
  accountNumber: z.string().regex(/^\d{10}$/, 'Account number must be 10 digits'),
  deductionDay: z.number().int().min(1).max(28),
  providerReference: z.string().min(1).max(255),
})

export type SetupMandateRequest = z.infer<typeof setupMandateSchema>
