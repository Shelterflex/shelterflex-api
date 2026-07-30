import type express from 'express'
import { uploadFile, buildPropertyMediaObjectKey } from './storageService.js'
import { propertyPhotoStore } from '../models/propertyPhotoStore.js'
import type { PropertyPhoto } from '../models/propertyPhoto.js'

export class PropertyPhotoService {
  async uploadPropertyPhotos(propertyId: string, files: any[]): Promise<PropertyPhoto[]> {
    const uploadedPhotos: PropertyPhoto[] = []

    for (const file of files) {
      const objectKey = buildPropertyMediaObjectKey(propertyId, file.mimetype)
      const { url } = await uploadFile(objectKey, file.buffer, file.mimetype)
      const dimensions = await this.getImageDimensions(file.buffer)

      const photo = await propertyPhotoStore.create({
        propertyId,
        url,
        fileName: file.originalname,
        fileSize: file.size,
        width: dimensions.width,
        height: dimensions.height,
        mimeType: file.mimetype,
      })

      uploadedPhotos.push(photo)
    }

    return uploadedPhotos
  }

  async deletePhoto(photoId: string, propertyId: string): Promise<void> {
    const photo = await propertyPhotoStore.getById(photoId)
    if (!photo || photo.propertyId !== propertyId) {
      throw new Error('Photo not found for property')
    }

    await propertyPhotoStore.delete(photoId)
  }

  async reorderPhotos(propertyId: string, photoId: string, newOrderIndex: number): Promise<PropertyPhoto[]> {
    const photo = await propertyPhotoStore.getById(photoId)
    if (!photo || photo.propertyId !== propertyId) {
      throw new Error('Photo not found for property')
    }

    const reordered = await propertyPhotoStore.reorder({ photoId, newOrderIndex })
    return reordered
  }

  async setPrimaryPhoto(propertyId: string, photoId: string): Promise<PropertyPhoto> {
    const photo = await propertyPhotoStore.getById(photoId)
    if (!photo || photo.propertyId !== propertyId) {
      throw new Error('Photo not found for property')
    }

    return propertyPhotoStore.setFeatured(photoId, propertyId)
  }

  private async getImageDimensions(buffer: Buffer): Promise<{ width: number; height: number }> {
    // Production should use a real image processing library for exact dimensions.
    return {
      width: 1920,
      height: 1080,
    }
  }
}

export const propertyPhotoService = new PropertyPhotoService()
