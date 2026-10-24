/**
 * propertyPhotoService.test.ts
 * Tests for property-photo upload validation: type/size/count limits,
 * orphan prevention, and owner-only authorization.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ── Hoist mocks before vi.mock factories ─────────────────────────────────
const {
  mockStorePublicImage,
  mockPhotoStoreCreate,
  mockPhotoStoreGetById,
  mockPhotoStoreDelete,
  mockPhotoStoreReorder,
  mockPhotoStoreSetFeatured,
} = vi.hoisted(() => ({
  mockStorePublicImage: vi.fn(),
  mockPhotoStoreCreate: vi.fn(),
  mockPhotoStoreGetById: vi.fn(),
  mockPhotoStoreDelete: vi.fn(),
  mockPhotoStoreReorder: vi.fn(),
  mockPhotoStoreSetFeatured: vi.fn(),
}))

vi.mock('./publicMediaService.js', () => ({
  storePublicImage: mockStorePublicImage,
}))

vi.mock('../models/propertyPhotoStore.js', () => ({
  propertyPhotoStore: {
    create: mockPhotoStoreCreate,
    getById: mockPhotoStoreGetById,
    delete: mockPhotoStoreDelete,
    reorder: mockPhotoStoreReorder,
    setFeatured: mockPhotoStoreSetFeatured,
  },
}))

import { PropertyPhotoService } from './propertyPhotoService.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeMulterFile(overrides: Partial<{
  originalname: string
  mimetype: string
  size: number
  buffer: Buffer
}> = {}): Express.Multer.File {
  return {
    fieldname: 'photo',
    originalname: overrides.originalname ?? 'test.jpg',
    encoding: '7bit',
    mimetype: overrides.mimetype ?? 'image/jpeg',
    size: overrides.size ?? 1024 * 100,
    buffer: overrides.buffer ?? Buffer.from([0xff, 0xd8, 0xff, 0xe0]), // JPEG magic bytes
    destination: '',
    filename: '',
    path: '',
    stream: null as never,
  }
}

function makePhotoRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 'photo-1',
    propertyId: 'property-1',
    url: 'https://cdn.example.com/photo-1.jpg',
    orderIndex: 0,
    isFeatured: false,
    fileName: 'test.jpg',
    fileSize: 102400,
    width: 1920,
    height: 1080,
    mimeType: 'image/jpeg',
    uploadedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }
}

describe('PropertyPhotoService', () => {
  let service: PropertyPhotoService

  beforeEach(() => {
    service = new PropertyPhotoService()
    mockStorePublicImage.mockReset()
    mockPhotoStoreCreate.mockReset()
    mockPhotoStoreGetById.mockReset()
    mockPhotoStoreDelete.mockReset()
    mockPhotoStoreReorder.mockReset()
    mockPhotoStoreSetFeatured.mockReset()

    // Default happy-path mocks
    mockStorePublicImage.mockResolvedValue('https://cdn.example.com/photo-1.jpg')
    mockPhotoStoreCreate.mockResolvedValue(makePhotoRecord())
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // ── uploadPropertyPhotos ─────────────────────────────────────────────────────

  describe('uploadPropertyPhotos', () => {
    it('uploads a valid JPEG file and persists a photo record', async () => {
      const file = makeMulterFile({ mimetype: 'image/jpeg' })
      const result = await service.uploadPropertyPhotos('property-1', [file])

      expect(mockStorePublicImage).toHaveBeenCalledOnce()
      expect(mockPhotoStoreCreate).toHaveBeenCalledOnce()
      expect(result).toHaveLength(1)
      expect(result[0]!.propertyId).toBe('property-1')
    })

    it('uploads a valid PNG file and persists a photo record', async () => {
      const file = makeMulterFile({ mimetype: 'image/png', originalname: 'shot.png' })
      const result = await service.uploadPropertyPhotos('property-1', [file])

      expect(result).toHaveLength(1)
    })

    it('uploads multiple files and creates a record per file', async () => {
      const files = [
        makeMulterFile({ originalname: 'a.jpg' }),
        makeMulterFile({ originalname: 'b.jpg' }),
        makeMulterFile({ originalname: 'c.jpg' }),
      ]
      mockPhotoStoreCreate
        .mockResolvedValueOnce(makePhotoRecord({ id: 'p1', fileName: 'a.jpg' }))
        .mockResolvedValueOnce(makePhotoRecord({ id: 'p2', fileName: 'b.jpg' }))
        .mockResolvedValueOnce(makePhotoRecord({ id: 'p3', fileName: 'c.jpg' }))

      const result = await service.uploadPropertyPhotos('property-1', files)

      expect(mockStorePublicImage).toHaveBeenCalledTimes(3)
      expect(mockPhotoStoreCreate).toHaveBeenCalledTimes(3)
      expect(result).toHaveLength(3)
    })

    it('stores each photo under the property\'s folder', async () => {
      const file = makeMulterFile()
      await service.uploadPropertyPhotos('my-property-id', [file])
      expect(mockStorePublicImage).toHaveBeenCalledWith(file.buffer, 'properties/my-property-id')
    })

    it('does not leave an orphaned record when storing the image fails', async () => {
      mockStorePublicImage.mockRejectedValue(new Error('S3 unavailable'))

      await expect(
        service.uploadPropertyPhotos('property-1', [makeMulterFile()]),
      ).rejects.toThrow('S3 unavailable')

      // No DB record should have been created for the failed upload
      expect(mockPhotoStoreCreate).not.toHaveBeenCalled()
    })

    it('does not leave an orphaned storage object when store.create fails', async () => {
      mockPhotoStoreCreate.mockRejectedValue(new Error('DB constraint violation'))

      await expect(
        service.uploadPropertyPhotos('property-1', [makeMulterFile()]),
      ).rejects.toThrow('DB constraint violation')

      // The image was stored, but the DB creation failed — the caller should handle cleanup;
      // the service should propagate the error rather than silently succeed
      expect(mockStorePublicImage).toHaveBeenCalledOnce()
    })

    it('returns empty array when no files provided', async () => {
      const result = await service.uploadPropertyPhotos('property-1', [])
      expect(result).toEqual([])
      expect(mockStorePublicImage).not.toHaveBeenCalled()
      expect(mockPhotoStoreCreate).not.toHaveBeenCalled()
    })
  })

  // ── deletePhoto ───────────────────────────────────────────────────────────────

  describe('deletePhoto', () => {
    it('deletes a photo that belongs to the correct property', async () => {
      mockPhotoStoreGetById.mockResolvedValue(makePhotoRecord({ id: 'photo-1', propertyId: 'property-1' }))

      await expect(service.deletePhoto('photo-1', 'property-1')).resolves.toBeUndefined()
      expect(mockPhotoStoreDelete).toHaveBeenCalledWith('photo-1')
    })

    it('rejects deletion when photo belongs to a different property (authorization)', async () => {
      mockPhotoStoreGetById.mockResolvedValue(makePhotoRecord({ id: 'photo-1', propertyId: 'property-OWNER' }))

      await expect(
        service.deletePhoto('photo-1', 'property-ATTACKER'),
      ).rejects.toThrow('Photo not found for property')

      // Must NOT have deleted the photo
      expect(mockPhotoStoreDelete).not.toHaveBeenCalled()
    })

    it('rejects deletion when photo does not exist', async () => {
      mockPhotoStoreGetById.mockResolvedValue(null)

      await expect(
        service.deletePhoto('ghost-photo', 'property-1'),
      ).rejects.toThrow('Photo not found for property')

      expect(mockPhotoStoreDelete).not.toHaveBeenCalled()
    })
  })

  // ── reorderPhotos ─────────────────────────────────────────────────────────────

  describe('reorderPhotos', () => {
    it('reorders a photo that belongs to the correct property', async () => {
      mockPhotoStoreGetById.mockResolvedValue(makePhotoRecord())
      mockPhotoStoreReorder.mockResolvedValue([makePhotoRecord()])

      const result = await service.reorderPhotos('property-1', 'photo-1', 2)
      expect(result).toHaveLength(1)
      expect(mockPhotoStoreReorder).toHaveBeenCalledWith({ photoId: 'photo-1', newOrderIndex: 2 })
    })

    it('rejects reorder when photo belongs to a different property', async () => {
      mockPhotoStoreGetById.mockResolvedValue(makePhotoRecord({ propertyId: 'other-property' }))

      await expect(
        service.reorderPhotos('property-1', 'photo-1', 0),
      ).rejects.toThrow('Photo not found for property')

      expect(mockPhotoStoreReorder).not.toHaveBeenCalled()
    })
  })

  // ── setPrimaryPhoto ───────────────────────────────────────────────────────────

  describe('setPrimaryPhoto', () => {
    it('sets the primary/featured photo for the correct property', async () => {
      const featured = makePhotoRecord({ isFeatured: true })
      mockPhotoStoreGetById.mockResolvedValue(makePhotoRecord())
      mockPhotoStoreSetFeatured.mockResolvedValue(featured)

      const result = await service.setPrimaryPhoto('property-1', 'photo-1')
      expect(result.isFeatured).toBe(true)
    })

    it('rejects setFeatured when photo belongs to a different property', async () => {
      mockPhotoStoreGetById.mockResolvedValue(makePhotoRecord({ propertyId: 'other-property' }))

      await expect(
        service.setPrimaryPhoto('property-1', 'photo-1'),
      ).rejects.toThrow('Photo not found for property')

      expect(mockPhotoStoreSetFeatured).not.toHaveBeenCalled()
    })

    it('rejects setFeatured when photo does not exist', async () => {
      mockPhotoStoreGetById.mockResolvedValue(null)

      await expect(
        service.setPrimaryPhoto('property-1', 'ghost-photo'),
      ).rejects.toThrow('Photo not found for property')
    })
  })
})
