/**
 * Tenant Application Routes
 * Handles tenant property financing application intake and tracking
 */

import { Router, Request, Response } from "express";
import { authenticateToken } from "../middleware/auth.js";
import { tenantApplicationStore } from "../models/tenantApplicationStore.js";
import { TenantApplicationStatus } from "../models/tenantApplication.js";
import {
  createTenantApplicationSchema,
  getTenantApplicationSchema,
  listTenantApplicationsSchema,
  CreateTenantApplicationRequest,
  ListTenantApplicationsRequest,
} from "../schemas/tenantApplication.js";
import { AppError } from "../errors/AppError.js";
import { ErrorCode } from "../errors/errorCodes.js";
import { isNewApplicationsBlocked } from "../models/userApplicationBlockStore.js";

const router = Router();

/**
 * POST /api/tenant/applications
 * Create a new tenant application
 *
 * @authenticated
 */
router.post(
  "/",
  authenticateToken,
  async (req: Request, res: Response, next) => {
    try {
      const userId = (req as any).user?.id;
      if (!userId) {
        throw new AppError(
          ErrorCode.UNAUTHORIZED,
          401,
          "User not authenticated",
        );
      }

      const validatedData: CreateTenantApplicationRequest =
        createTenantApplicationSchema.parse(req.body);

      if (isNewApplicationsBlocked(userId)) {
        throw new AppError(
          ErrorCode.FORBIDDEN,
          403,
          "New applications are blocked due to a defaulted payment. Contact support.",
        );
      }

      // Validate deposit is at least 20% of annual rent
      const minDeposit = validatedData.annualRent * 0.2;
      if (validatedData.deposit < minDeposit) {
        throw new AppError(
          ErrorCode.VALIDATION_ERROR,
          400,
          `Deposit must be at least 20% of annual rent (₦${minDeposit.toFixed(2)})`,
        );
      }

      // Validate deposit doesn't exceed annual rent
      if (validatedData.deposit >= validatedData.annualRent) {
        throw new AppError(
          ErrorCode.VALIDATION_ERROR,
          400,
          "Deposit must be less than annual rent",
        );
      }

      const application = await tenantApplicationStore.create({
        userId,
        ...validatedData,
      });

      res.status(201).json({
        success: true,
        data: application,
      });
    } catch (error) {
      if (error instanceof Error && error.name === "ZodError") {
        return next(
          new AppError(ErrorCode.VALIDATION_ERROR, 400, error.message),
        );
      }
      next(error);
    }
  },
);

/**
 * GET /api/tenant/applications/:applicationId
 * Get a specific application by ID
 *
 * @authenticated
 */
router.get(
  "/:applicationId",
  authenticateToken,
  async (req: Request, res: Response, next) => {
    try {
      const userId = (req as any).user?.id;
      if (!userId) {
        throw new AppError(
          ErrorCode.UNAUTHORIZED,
          401,
          "User not authenticated",
        );
      }

      const { applicationId } = req.params;

      if (!applicationId) {
        throw new AppError(
          ErrorCode.VALIDATION_ERROR,
          400,
          "Application ID is required",
        );
      }

      const application = await tenantApplicationStore.findById(applicationId);

      if (!application) {
        throw new AppError(
          ErrorCode.NOT_FOUND,
          404,
          `Application with ID ${applicationId} not found`,
        );
      }

      // Ensure user can only access their own applications
      if (application.userId !== userId) {
        throw new AppError(ErrorCode.FORBIDDEN, 403, "Access denied");
      }

      res.json({
        success: true,
        data: application,
      });
    } catch (error) {
      next(error);
    }
  },
);

/**
 * GET /api/tenant/applications
 * List applications for the authenticated user
 *
 * @authenticated
 */
router.get(
  "/",
  authenticateToken,
  async (req: Request, res: Response, next) => {
    try {
      const userId = (req as any).user?.id;
      if (!userId) {
        throw new AppError(
          ErrorCode.UNAUTHORIZED,
          401,
          "User not authenticated",
        );
      }

      const validatedFilters: ListTenantApplicationsRequest =
        listTenantApplicationsSchema.parse(req.query);

      const result = await tenantApplicationStore.findByUserId(userId, {
        status: validatedFilters.status as TenantApplicationStatus | undefined,
        limit: validatedFilters.limit,
        cursor: validatedFilters.cursor,
      });

      res.json({
        success: true,
        data: result.applications,
        nextCursor: result.nextCursor,
      });
    } catch (error) {
      if (error instanceof Error && error.name === "ZodError") {
        return next(
          new AppError(ErrorCode.VALIDATION_ERROR, 400, error.message),
        );
      }
      next(error);
    }
  },
);

export function createTenantApplicationsRouter(): Router {
  return router;
}
