import { Router, Request, Response } from 'express'
import { getPlatformStats } from '../services/platformStatsService.js'
import { cacheControl, CachePresets, registerEndpointCache } from '../middleware/cacheControl.js'

const router = Router()

registerEndpointCache('/api/v1/platform-stats', {
  ...CachePresets.dynamic,
  tags: ['platform', 'stats'],
  cacheKey: 'platform:stats',
})

router.get(
  '/',
  cacheControl(CachePresets.dynamic),
  async (_req: Request, res: Response, next) => {
    try {
      const stats = await getPlatformStats()
      res.json(stats)
    } catch (error) {
      next(error)
    }
  },
)

export function createPlatformStatsRouter(): Router {
  return router
}
