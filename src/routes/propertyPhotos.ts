import { Router, Response } from 'express'
import multer from 'multer'
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth.js'
import { requireAdmin } from '../middleware/requireAdmin.js'
import { propertyPhotoStore } from '../models/propertyPhotoStore.js'
import { landlordPropertyStore } from '../models/landlordPropertyStore.js'
import { validate } from '../middleware/validate.js'
import {
  createPhotoSchema,
  updatePhotoSchema,
  reorderPhotosSchema,
  setFeaturedSchema,
  photoFiltersSchema,
} from '../schemas/propertyPhoto.js'
import { AppError } from '../errors/AppError.js'
import { ErrorCode } from '../errors/errorCodes.js'
import { logger } from '../utils/logger.js'
import { propertyPhotoService } from '../services/propertyPhotoService.js'

const router = Router()

// Configure multer for file uploads
const storage = multer.memoryStorage()
const upload = multer({
  storage,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|webp/
    const isImage = allowedTypes.test(file.mimetype)
    if (isImage) {
      cb(null, true)
    } else {
      cb(new Error('Only image files (jpeg, jpg, png, webp) are allowed'))
    }
  },
})

/**
 * List photos for a property
 * GET /api/properties/:propertyId/photos
 */
router.get(
  '/properties/:propertyId/photos',
  authenticateToken,
  async (req: AuthenticatedRequest, res: Response, next) => {
    try {
      const property = await landlordPropertyStore.getById(req.params.propertyId)
      if (!property) {
        throw new AppError(ErrorCode.NOT_FOUND, 404, 'Property not found')
      }

      if (property.landlordId !== req.user?.id) {
        try {
          requireAdmin({ mode: 'session' })(req as any, {} as any, (err: any) => { if (err) throw err })
        } catch {
          throw new AppError(ErrorCode.FORBIDDEN, 403, 'You do not have permission to view these photos')
        }
      }

      const filters = photoFiltersSchema.parse({ ...req.query, propertyId: req.params.propertyId })
      const photos = await propertyPhotoStore.list(filters)

      res.json(photos)
    } catch (error) {
      next(error)
    }
  }
)

/**
 * Get a single photo
 * GET /api/photos/:id
 */
router.get(
  '/photos/:id',
  authenticateToken,
  async (req: AuthenticatedRequest, res: Response, next) => {
    try {
      const photo = await propertyPhotoStore.getById(req.params.id)
      if (!photo) {
        throw new AppError(ErrorCode.NOT_FOUND, 404, 'Photo not found')
      }

      const property = await landlordPropertyStore.getById(photo.propertyId)
      if (!property) {
        throw new AppError(ErrorCode.NOT_FOUND, 404, 'Property not found')
      }

      if (property.landlordId !== req.user?.id) {
        try {
          requireAdmin({ mode: 'session' })(req as any, {} as any, (err: any) => { if (err) throw err })
        } catch {
          throw new AppError(ErrorCode.FORBIDDEN, 403, 'You do not have permission to view this photo')
        }
      }

      res.json(photo)
    } catch (error) {
      next(error)
    }
  }
)

/**
 * Upload a photo for a property
 * POST /api/properties/:propertyId/photos
 */
router.post(
  '/properties/:propertyId/photos',
  authenticateToken,
  upload.array('photos', 15),
  async (req: AuthenticatedRequest, res: Response, next) => {
    try {
      const files = (req.files as Express.Multer.File[]) || []
      if (files.length === 0) {
        throw new AppError(ErrorCode.VALIDATION_ERROR, 400, 'No photo files provided')
      }

      const property = await landlordPropertyStore.getById(req.params.propertyId)
      if (!property) {
        throw new AppError(ErrorCode.NOT_FOUND, 404, 'Property not found')
      }

      if (property.landlordId !== req.user?.id) {
        throw new AppError(ErrorCode.FORBIDDEN, 403, 'You do not have permission to upload photos to this property')
      }

      const photos = await propertyPhotoService.uploadPropertyPhotos(req.params.propertyId, files)

      logger.info('Photos uploaded', { propertyId: req.params.propertyId, landlordId: req.user.id, count: photos.length })
      res.status(201).json({ photos })
    } catch (error) {
      next(error)
    }
  }
)

router.delete(
  '/properties/:propertyId/photos/:photoId',
  authenticateToken,
  async (req: AuthenticatedRequest, res: Response, next) => {
    try {
      const photo = await propertyPhotoStore.getById(req.params.photoId)
      if (!photo) {
        throw new AppError(ErrorCode.NOT_FOUND, 404, 'Photo not found')
      }

      const property = await landlordPropertyStore.getById(req.params.propertyId)
      if (!property || property.id !== photo.propertyId) {
        throw new AppError(ErrorCode.NOT_FOUND, 404, 'Property not found')
      }

      if (property.landlordId !== req.user?.id) {
        throw new AppError(ErrorCode.FORBIDDEN, 403, 'You do not have permission to delete this photo')
      }

      await propertyPhotoService.deletePhoto(req.params.photoId, req.params.propertyId)
      logger.info('Photo deleted', { photoId: req.params.photoId, propertyId: req.params.propertyId, landlordId: req.user.id })
      res.status(204).end()
    } catch (error) {
      next(error)
    }
  }
)

router.patch(
  '/properties/:propertyId/photos/order',
  authenticateToken,
  validate(reorderPhotosSchema, 'body'),
  async (req: AuthenticatedRequest, res: Response, next) => {
    try {
      const photo = await propertyPhotoStore.getById(req.body.photoId)
      if (!photo) {
        throw new AppError(ErrorCode.NOT_FOUND, 404, 'Photo not found')
      }

      const property = await landlordPropertyStore.getById(req.params.propertyId)
      if (!property || property.id !== photo.propertyId) {
        throw new AppError(ErrorCode.NOT_FOUND, 404, 'Property not found')
      }

      if (property.landlordId !== req.user?.id) {
        throw new AppError(ErrorCode.FORBIDDEN, 403, 'You do not have permission to reorder these photos')
      }

      const reordered = await propertyPhotoService.reorderPhotos(req.params.propertyId, req.body.photoId, req.body.newOrderIndex)
      logger.info('Photos reordered', { propertyId: req.params.propertyId, landlordId: req.user.id })
      res.json({ photos: reordered })
    } catch (error) {
      next(error)
    }
  }
)

router.patch(
  '/properties/:propertyId/photos/:photoId/primary',
  authenticateToken,
  async (req: AuthenticatedRequest, res: Response, next) => {
    try {
      const photo = await propertyPhotoStore.getById(req.params.photoId)
      if (!photo) {
        throw new AppError(ErrorCode.NOT_FOUND, 404, 'Photo not found')
      }

      const property = await landlordPropertyStore.getById(req.params.propertyId)
      if (!property || property.id !== photo.propertyId) {
        throw new AppError(ErrorCode.NOT_FOUND, 404, 'Property not found')
      }

      if (property.landlordId !== req.user?.id) {
        throw new AppError(ErrorCode.FORBIDDEN, 403, 'You do not have permission to set the primary photo')
      }

      const primary = await propertyPhotoService.setPrimaryPhoto(req.params.propertyId, req.params.photoId)
      logger.info('Primary photo set', { photoId: req.params.photoId, propertyId: req.params.propertyId, landlordId: req.user.id })
      res.json(primary)
    } catch (error) {
      next(error)
    }
  }
)

/**
 * Update a photo
 * PATCH /api/photos/:id
 */
router.patch(
  '/photos/:id',
  authenticateToken,
  validate(updatePhotoSchema, 'body'),
  async (req: AuthenticatedRequest, res: Response, next) => {
    try {
      const photo = await propertyPhotoStore.getById(req.params.id)
      if (!photo) {
        throw new AppError(ErrorCode.NOT_FOUND, 404, 'Photo not found')
      }

      const property = await landlordPropertyStore.getById(photo.propertyId)
      if (!property) {
        throw new AppError(ErrorCode.NOT_FOUND, 404, 'Property not found')
      }

      if (property.landlordId !== req.user?.id) {
        throw new AppError(ErrorCode.FORBIDDEN, 403, 'You do not have permission to update this photo')
      }

      const updated = await propertyPhotoStore.update(req.params.id, req.body as any)
      logger.info('Photo updated', { photoId: req.params.id, landlordId: req.user.id })
      res.json(updated)
    } catch (error) {
      next(error)
    }
  }
)

/**
 * Delete a photo
 * DELETE /api/photos/:id
 */
router.delete(
  '/photos/:id',
  authenticateToken,
  async (req: AuthenticatedRequest, res: Response, next) => {
    try {
      const photo = await propertyPhotoStore.getById(req.params.id)
      if (!photo) {
        throw new AppError(ErrorCode.NOT_FOUND, 404, 'Photo not found')
      }

      const property = await landlordPropertyStore.getById(photo.propertyId)
      if (!property) {
        throw new AppError(ErrorCode.NOT_FOUND, 404, 'Property not found')
      }

      if (property.landlordId !== req.user?.id) {
        throw new AppError(ErrorCode.FORBIDDEN, 403, 'You do not have permission to delete this photo')
      }

      await propertyPhotoStore.delete(req.params.id)
      logger.info('Photo deleted', { photoId: req.params.id, landlordId: req.user.id })
      res.status(204).end()
    } catch (error) {
      next(error)
    }
  }
)

/**
 * Reorder photos
 * POST /api/photos/reorder
 */
router.post(
  '/photos/reorder',
  authenticateToken,
  validate(reorderPhotosSchema, 'body'),
  async (req: AuthenticatedRequest, res: Response, next) => {
    try {
      const photo = await propertyPhotoStore.getById(req.body.photoId)
      if (!photo) {
        throw new AppError(ErrorCode.NOT_FOUND, 404, 'Photo not found')
      }

      const property = await landlordPropertyStore.getById(photo.propertyId)
      if (!property) {
        throw new AppError(ErrorCode.NOT_FOUND, 404, 'Property not found')
      }

      if (property.landlordId !== req.user?.id) {
        throw new AppError(ErrorCode.FORBIDDEN, 403, 'You do not have permission to reorder these photos')
      }

      const reordered = await propertyPhotoStore.reorder(req.body as any)
      logger.info('Photos reordered', { propertyId: photo.propertyId, landlordId: req.user.id })
      res.json(reordered)
    } catch (error) {
      next(error)
    }
  }
)

/**
 * Set featured photo
 * POST /api/photos/set-featured
 */
router.post(
  '/photos/set-featured',
  authenticateToken,
  validate(setFeaturedSchema, 'body'),
  async (req: AuthenticatedRequest, res: Response, next) => {
    try {
      const photo = await propertyPhotoStore.getById(req.body.photoId)
      if (!photo) {
        throw new AppError(ErrorCode.NOT_FOUND, 404, 'Photo not found')
      }

      const property = await landlordPropertyStore.getById(req.body.propertyId)
      if (!property) {
        throw new AppError(ErrorCode.NOT_FOUND, 404, 'Property not found')
      }

      if (property.landlordId !== req.user?.id) {
        throw new AppError(ErrorCode.FORBIDDEN, 403, 'You do not have permission to set featured photo')
      }

      const featured = await propertyPhotoStore.setFeatured(req.body.photoId, req.body.propertyId)
      logger.info('Featured photo set', { photoId: req.body.photoId, propertyId: req.body.propertyId, landlordId: req.user.id })
      res.json(featured)
    } catch (error) {
      next(error)
    }
  }
)

// Helper function to get image dimensions
async function getImageDimensions(buffer: Buffer): Promise<{ width: number; height: number }> {
  // Simple implementation - in production, use a proper image processing library
  // For now, return default dimensions
  return { width: 1920, height: 1080 }
}

export function createPropertyPhotosRouter(): Router {
  return router
}
