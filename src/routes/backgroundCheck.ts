/**
 * Background Check Routes
 * Admin endpoints for triggering and retrieving background check results
 */

import { Router, Request, Response } from "express";
import { authenticateToken, type AuthenticatedRequest } from "../middleware/auth.js";
import { requirePermission } from "../middleware/rbac.js";
import { backgroundCheckService } from "../services/backgroundCheckService.js";
import { AppError } from "../errors/AppError.js";
import { ErrorCode } from "../errors/errorCodes.js";

const router = Router();

/**
 * POST /api/admin/tenants/:tenantId/background-check
 * Trigger a full background check for a tenant
 *
 * @authenticated
 * @body {
 *   applicationId?: string,
 *   employerName?: string,
 *   employeeId?: string,
 *   bankAccountRef?: string,
 *   statementFile?: string,
 *   skipEmployment?: boolean,
 *   skipIncome?: boolean,
 *   skipBankStatement?: boolean
 * }
 */
router.post(
  "/tenants/:tenantId/background-check",
  authenticateToken,
  requirePermission("background-check", "trigger"),
  async (req: AuthenticatedRequest, res: Response, next) => {
    try {
      const { tenantId } = req.params;

      if (!tenantId) {
        throw new AppError(ErrorCode.VALIDATION_ERROR, 400, "Tenant ID is required");
      }

      const {
        applicationId,
        employerName,
        employeeId,
        bankAccountRef,
        statementFile,
        skipEmployment,
        skipIncome,
        skipBankStatement,
      } = req.body;

      // Validate that at least one verification type is requested
      if (
        skipEmployment &&
        skipIncome &&
        skipBankStatement &&
        !employerName &&
        !bankAccountRef &&
        !statementFile
      ) {
        throw new AppError(
          ErrorCode.VALIDATION_ERROR,
          400,
          "At least one verification type must be requested",
        );
      }

      const result = await backgroundCheckService.runFullCheck({
        tenantId,
        applicationId,
        employerName,
        employeeId,
        bankAccountRef,
        statementFile,
        skipEmployment,
        skipIncome,
        skipBankStatement,
      });

      res.status(201).json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  },
);

/**
 * GET /api/admin/tenants/:tenantId/background-check
 * Retrieve the latest background check result for a tenant
 *
 * @authenticated
 */
router.get(
  "/tenants/:tenantId/background-check",
  authenticateToken,
  requirePermission("background-check", "view"),
  async (req: AuthenticatedRequest, res: Response, next) => {
    try {
      const { tenantId } = req.params;

      if (!tenantId) {
        throw new AppError(ErrorCode.VALIDATION_ERROR, 400, "Tenant ID is required");
      }

      const result = await backgroundCheckService.getLatestCheck(tenantId);

      if (!result) {
        throw new AppError(
          ErrorCode.NOT_FOUND,
          404,
          `No background check found for tenant ${tenantId}`,
        );
      }

      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  },
);

/**
 * GET /api/admin/background-check/:checkId
 * Retrieve a specific background check result by ID
 *
 * @authenticated
 */
router.get(
  "/background-check/:checkId",
  authenticateToken,
  requirePermission("background-check", "view"),
  async (req: AuthenticatedRequest, res: Response, next) => {
    try {
      const { checkId } = req.params;

      if (!checkId) {
        throw new AppError(ErrorCode.VALIDATION_ERROR, 400, "Check ID is required");
      }

      const result = await backgroundCheckService.getCheckById(checkId);

      if (!result) {
        throw new AppError(
          ErrorCode.NOT_FOUND,
          404,
          `Background check ${checkId} not found`,
        );
      }

      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  },
);

/**
 * GET /api/admin/applications/:applicationId/background-checks
 * Retrieve all background checks for a specific application
 *
 * @authenticated
 */
router.get(
  "/applications/:applicationId/background-checks",
  authenticateToken,
  requirePermission("background-check", "view"),
  async (req: AuthenticatedRequest, res: Response, next) => {
    try {
      const { applicationId } = req.params;

      if (!applicationId) {
        throw new AppError(
          ErrorCode.VALIDATION_ERROR,
          400,
          "Application ID is required",
        );
      }

      const results = await backgroundCheckService.getChecksByApplicationId(
        applicationId,
      );

      res.json({
        success: true,
        data: results,
        total: results.length,
      });
    } catch (error) {
      next(error);
    }
  },
);

export { router as backgroundCheckRouter };
