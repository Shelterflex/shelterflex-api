import { Router, type Response, type NextFunction } from 'express'
import multer from 'multer'
import { authenticateToken, type AuthenticatedRequest } from '../middleware/auth.js'
import { AppError } from '../errors/AppError.js'
import { ErrorCode } from '../errors/errorCodes.js'
import { storePublicImage } from '../services/publicMediaService.js'
import { getImageSize } from '../utils/imageDimensions.js'
import { logger } from '../utils/logger.js'

export const MAX_PHOTOS_PER_UPLOAD = 20
const MAX_PHOTO_BYTES = 10 * 1024 * 1024

// Photos that advertise an apartment must be sharp enough to judge it by:
// at least 1200px on the long side and 900px on the short side.
export const LISTING_PHOTO_MIN_LONG_SIDE = 1200
export const LISTING_PHOTO_MIN_SHORT_SIDE = 900

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_PHOTO_BYTES, files: MAX_PHOTOS_PER_UPLOAD },
})

/**
 * POST /api/v1/media/photos
 *
 * Uploads photos that will be shown publicly (whistleblower reports,
 * inspection reports) before the form that references them is submitted.
 * Multipart field: `photos`. Responds with `{ urls }` in upload order.
 * With the field `purpose=listing`, photos below the minimum resolution are
 * rejected.
 */
export function createMediaRouter(): Router {
  const router = Router()

  router.post(
    '/photos',
    authenticateToken,
    (req, res, next) => {
      upload.array('photos', MAX_PHOTOS_PER_UPLOAD)(req, res, (err: unknown) => {
        if (err instanceof multer.MulterError) {
          const message =
            err.code === 'LIMIT_FILE_SIZE'
              ? 'Each photo must be 10MB or smaller'
              : err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE'
                ? `Upload at most ${MAX_PHOTOS_PER_UPLOAD} photos at a time`
                : err.message
          next(new AppError(ErrorCode.VALIDATION_ERROR, 400, message))
          return
        }
        next(err as Error | undefined)
      })
    },
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const files = (req.files as Express.Multer.File[] | undefined) ?? []
        if (files.length === 0) {
          throw new AppError(ErrorCode.VALIDATION_ERROR, 400, 'No photos provided')
        }

        if (req.body?.purpose === 'listing') {
          for (const file of files) {
            const size = getImageSize(file.buffer)
            const long = size ? Math.max(size.width, size.height) : 0
            const short = size ? Math.min(size.width, size.height) : 0
            if (long < LISTING_PHOTO_MIN_LONG_SIDE || short < LISTING_PHOTO_MIN_SHORT_SIDE) {
              throw new AppError(
                ErrorCode.VALIDATION_ERROR,
                422,
                `"${file.originalname}" is too low quality${size ? ` (${size.width}×${size.height})` : ''}. ` +
                  `Photos must be at least ${LISTING_PHOTO_MIN_LONG_SIDE}×${LISTING_PHOTO_MIN_SHORT_SIDE} pixels.`,
              )
            }
          }
        }

        const userId = req.user!.id
        const urls: string[] = []
        for (const file of files) {
          urls.push(await storePublicImage(file.buffer, `photos/${userId}`))
        }

        logger.info('Photos uploaded', { userId, count: urls.length, requestId: req.requestId })
        res.status(201).json({ urls })
      } catch (error) {
        next(error)
      }
    },
  )

  return router
}
