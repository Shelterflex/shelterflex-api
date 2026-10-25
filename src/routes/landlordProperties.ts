import { Router, Response } from 'express'
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth.js'
import { hasRole } from '../utils/hasRole.js'
import { landlordPropertyStore } from '../models/landlordPropertyStore.js'
import {
  createPropertySchema,
  updatePropertySchema,
  propertyFiltersSchema,
} from '../schemas/landlordProperty.js'
import { AppError } from '../errors/AppError.js'
import { ErrorCode } from '../errors/errorCodes.js'
import { logger } from '../utils/logger.js'
import { PropertyStatus } from '../models/landlordProperty.js'
import { PricingValidationError } from '../services/pricingService.js'
import { syncLandlordPropertyListing } from '../services/landlordPropertyListingSync.js'

const router = Router()

function assertLandlord(req: AuthenticatedRequest) {
  if (!req.user || !hasRole(req.user, 'landlord', 'admin')) {
    throw new AppError(ErrorCode.FORBIDDEN, 403, 'Only landlords can access this resource')
  }
}

function assertOwner(propertyLandlordId: string, req: AuthenticatedRequest) {
  if (req.user?.role === 'admin') return
  if (propertyLandlordId !== req.user?.id) {
    throw new AppError(ErrorCode.FORBIDDEN, 403, 'You do not have permission to modify this property')
  }
}

router.get(
  '/',
  authenticateToken,
  async (req: AuthenticatedRequest, res: Response, next) => {
    try {
      assertLandlord(req)
      const filters = propertyFiltersSchema.parse(req.query)
      const result = await landlordPropertyStore.list({
        ...filters,
        landlordId: req.user!.id,
      })
      res.json(result)
    } catch (error) {
      next(error)
    }
  },
)

router.get(
  '/:id',
  authenticateToken,
  async (req: AuthenticatedRequest, res: Response, next) => {
    try {
      assertLandlord(req)
      const property = await landlordPropertyStore.getById(req.params.id)
      if (!property) {
        throw new AppError(ErrorCode.NOT_FOUND, 404, 'Property not found')
      }
      assertOwner(property.landlordId, req)
      res.json(property)
    } catch (error) {
      next(error)
    }
  },
)

router.post(
  '/',
  authenticateToken,
  async (req: AuthenticatedRequest, res: Response, next) => {
    try {
      if (!req.user || !hasRole(req.user, 'landlord')) {
        throw new AppError(ErrorCode.FORBIDDEN, 403, 'Only landlords can create properties')
      }

      const input = createPropertySchema.parse(req.body)
      let property = await landlordPropertyStore.create({
        ...input,
        landlordId: req.user.id,
      })

      property = await syncLandlordPropertyListing(property)

      logger.info('Property created', { propertyId: property.id, landlordId: req.user.id })
      res.status(201).json(property)
    } catch (error) {
      if (error instanceof PricingValidationError) {
        return next(new AppError(ErrorCode.VALIDATION_ERROR, 400, error.message))
      }
      next(error)
    }
  },
)

router.patch(
  '/:id',
  authenticateToken,
  async (req: AuthenticatedRequest, res: Response, next) => {
    try {
      if (!req.user || !hasRole(req.user, 'landlord')) {
        throw new AppError(ErrorCode.FORBIDDEN, 403, 'Only landlords can update properties')
      }

      const existing = await landlordPropertyStore.getById(req.params.id)
      if (!existing) {
        throw new AppError(ErrorCode.NOT_FOUND, 404, 'Property not found')
      }
      assertOwner(existing.landlordId, req)

      const input = updatePropertySchema.parse(req.body)
      let updated = await landlordPropertyStore.update(req.params.id, input)
      if (!updated) {
        throw new AppError(ErrorCode.NOT_FOUND, 404, 'Property not found')
      }

      updated = await syncLandlordPropertyListing(updated)

      logger.info('Property updated', { propertyId: req.params.id, landlordId: req.user.id })
      res.json(updated)
    } catch (error) {
      if (error instanceof PricingValidationError) {
        return next(new AppError(ErrorCode.VALIDATION_ERROR, 400, error.message))
      }
      next(error)
    }
  },
)

router.patch(
  '/:id/deactivate',
  authenticateToken,
  async (req: AuthenticatedRequest, res: Response, next) => {
    try {
      const existing = await landlordPropertyStore.getById(req.params.id)
      if (!existing) {
        throw new AppError(ErrorCode.NOT_FOUND, 404, 'Property not found')
      }
      assertOwner(existing.landlordId, req)

      let updated = await landlordPropertyStore.update(req.params.id, {
        status: PropertyStatus.DEACTIVATED,
      })
      if (!updated) {
        throw new AppError(ErrorCode.NOT_FOUND, 404, 'Property not found')
      }

      updated = await syncLandlordPropertyListing(updated)

      logger.info('Property deactivated', { propertyId: req.params.id })
      res.json(updated)
    } catch (error) {
      next(error)
    }
  },
)

router.patch(
  '/:id/relist',
  authenticateToken,
  async (req: AuthenticatedRequest, res: Response, next) => {
    try {
      const existing = await landlordPropertyStore.getById(req.params.id)
      if (!existing) {
        throw new AppError(ErrorCode.NOT_FOUND, 404, 'Property not found')
      }
      assertOwner(existing.landlordId, req)

      if (existing.status !== PropertyStatus.DEACTIVATED) {
        throw new AppError(
          ErrorCode.VALIDATION_ERROR,
          400,
          'Only deactivated listings can be relisted',
        )
      }

      let updated = await landlordPropertyStore.update(req.params.id, {
        status: PropertyStatus.PENDING_REVIEW,
      })
      if (!updated) {
        throw new AppError(ErrorCode.NOT_FOUND, 404, 'Property not found')
      }

      updated = await syncLandlordPropertyListing(updated)

      logger.info('Property relisted', { propertyId: req.params.id })
      res.json(updated)
    } catch (error) {
      next(error)
    }
  },
)

router.delete(
  '/:id',
  authenticateToken,
  async (req: AuthenticatedRequest, res: Response, next) => {
    try {
      if (!req.user || !hasRole(req.user, 'landlord')) {
        throw new AppError(ErrorCode.FORBIDDEN, 403, 'Only landlords can delete properties')
      }

      const existing = await landlordPropertyStore.getById(req.params.id)
      if (!existing) {
        throw new AppError(ErrorCode.NOT_FOUND, 404, 'Property not found')
      }
      assertOwner(existing.landlordId, req)

      await landlordPropertyStore.delete(req.params.id)
      logger.info('Property deleted', { propertyId: req.params.id, landlordId: req.user.id })
      res.status(204).end()
    } catch (error) {
      next(error)
    }
  },
)

export function createLandlordPropertiesRouter(): Router {
  return router
}
