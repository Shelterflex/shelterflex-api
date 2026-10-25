/**
 * Tenant saved property routes
 */

import { Router, Request, Response } from "express";
import { authenticateToken } from "../middleware/auth.js";
import { savedPropertyStore } from "../models/savedPropertyStore.js";
import { AppError } from "../errors/AppError.js";
import { ErrorCode } from "../errors/errorCodes.js";

const router = Router();

function getUserId(req: Request): string {
  const userId = (req as Request & { user?: { id: string } }).user?.id;
  if (!userId) {
    throw new AppError(
      ErrorCode.UNAUTHORIZED,
      401,
      "User not authenticated",
    );
  }
  return userId;
}

/**
 * GET /api/tenant/saved-properties
 * List saved listing IDs for the authenticated tenant.
 */
router.get("/", authenticateToken, async (req: Request, res: Response, next) => {
  try {
    const userId = getUserId(req);
    const listingIds = await savedPropertyStore.listListingIds(userId);
    res.json({ success: true, data: listingIds });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/tenant/saved-properties/:listingId
 * Save a listing (idempotent).
 */
router.post(
  "/:listingId",
  authenticateToken,
  async (req: Request, res: Response, next) => {
    try {
      const userId = getUserId(req);
      const { listingId } = req.params;
      const record = await savedPropertyStore.save(userId, listingId);
      res.status(201).json({
        success: true,
        data: { listingId: record.listingId, saved: true },
      });
    } catch (error) {
      next(error);
    }
  },
);

/**
 * DELETE /api/tenant/saved-properties/:listingId
 * Remove a saved listing.
 */
router.delete(
  "/:listingId",
  authenticateToken,
  async (req: Request, res: Response, next) => {
    try {
      const userId = getUserId(req);
      const { listingId } = req.params;
      await savedPropertyStore.remove(userId, listingId);
      res.json({
        success: true,
        data: { listingId, saved: false },
      });
    } catch (error) {
      next(error);
    }
  },
);

export function createTenantSavedPropertiesRouter(): Router {
  return router;
}
