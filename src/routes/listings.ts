/**
 * Public property search routes
 */

import { Router, Request, Response } from 'express'
import { listingStore } from '../models/listingStore.js'
import { ListingStatus } from '../models/listing.js'
import { listingFiltersSchema, listingSuggestSchema } from '../schemas/listing.js'
import { AppError } from '../errors/AppError.js'
import { ErrorCode } from '../errors/errorCodes.js'

const router = Router()

/**
 * GET /api/listings
 * List approved listings (paginated collection root)
 */
router.get('/', async (req: Request, res: Response, next) => {
  try {
    const filters = listingFiltersSchema.parse(req.query)

    const result = await listingStore.search({
      ...filters,
      query: filters.q ?? filters.query,
      status: ListingStatus.APPROVED,
    })

    res.json({
      success: true,
      data: result.listings,
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
      totalPages: result.totalPages,
    })
  } catch (error) {
    if (error instanceof Error && error.name === 'ZodError') {
      return next(new AppError(ErrorCode.VALIDATION_ERROR, 400, error.message))
    }
    next(error)
  }
})

/**
 * GET /api/listings/search
 * Search approved listings with advanced filters
 */
router.get('/search', async (req: Request, res: Response, next) => {
  try {
    const filters = listingFiltersSchema.parse(req.query)

    const result = await listingStore.search({
      ...filters,
      query: filters.q ?? filters.query,
      status: ListingStatus.APPROVED,
    })

    res.json({
      success: true,
      data: result.listings,
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
      totalPages: result.totalPages,
    })
  } catch (error) {
    if (error instanceof Error && error.name === 'ZodError') {
      return next(new AppError(ErrorCode.VALIDATION_ERROR, 400, error.message))
    }
    next(error)
  }
})

/**
 * GET /api/listings/search/suggest
 * Return top matching listing titles/addresses and LGAs for autocomplete
 */
router.get('/search/suggest', async (req: Request, res: Response, next) => {
  try {
    const { q } = listingSuggestSchema.parse(req.query)
    const suggestions = await listingStore.suggest(q)

    res.json({
      success: true,
      data: suggestions,
    })
  } catch (error) {
    if (error instanceof Error && error.name === 'ZodError') {
      return next(new AppError(ErrorCode.VALIDATION_ERROR, 400, error.message))
    }
    next(error)
  }
})

/**
 * GET /api/listings/:id
 * Get a single approved listing by ID
 */
router.get('/:id', async (req: Request, res: Response, next) => {
  try {
    const listing = await listingStore.getById(req.params.id)

    if (!listing || listing.status !== ListingStatus.APPROVED) {
      throw new AppError(ErrorCode.NOT_FOUND, 404, 'Property not found')
    }

    res.json({
      success: true,
      data: listing,
    })
  } catch (error) {
    next(error)
  }
})

export function createListingsRouter(): Router {
  return router
}
