import { readFile, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { BlobServiceClient } from '@azure/storage-blob'
import { ManagedIdentityCredential } from '@azure/identity'
import sharp from 'sharp'
import { fileTypeFromBuffer } from 'file-type'
import { assetExtension, assetHasThumbnail } from '../src/domain.ts'
import type { Asset } from '../src/domain.ts'
import { HttpError } from './store.ts'

export async function prepareUpload(bytes: Buffer, filename: string, mimeType: string) {
  if (!bytes.length) throw new HttpError(400, '文件不能为空')
  if (bytes.length > 64 * 1024 * 1024) throw new HttpError(413, '单个文件不能超过 64 MB')
  const detected = await fileTypeFromBuffer(bytes).catch(() => undefined)
  const isImage = ['image/png', 'image/jpeg', 'image/webp'].includes(detected?.mime ?? '')
  if (isImage || /\.(png|jpe?g|webp)$/i.test(filename) || ['image/png', 'image/jpeg', 'image/webp'].includes(mimeType)) {
    try {
      const image = sharp(bytes, { limitInputPixels: 40_000_000, animated: false })
      const metadata = await image.metadata()
      if (!isImage || (metadata.pages ?? 1) > 1) throw new Error('Unsupported image')
      const decoded = await image.rotate().png().toBuffer({ resolveWithObject: true })
      if (decoded.data.length > 64 * 1024 * 1024) throw new Error('Decoded image too large')
      const thumbnail = await sharp(decoded.data).resize(480, 480, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 82 }).toBuffer()
      return { original: decoded.data, thumbnail, metadata: { width: decoded.info.width, height: decoded.info.height, mediaType: 'image', mimeType: 'image/png', storageExtension: 'png', hasThumbnail: true } satisfies Partial<Asset> }
    } catch { throw new HttpError(400, 'Upload a valid, single-frame PNG, JPEG or WebP image (max 40 megapixels)') }
  }
  let contentType = detected?.mime ?? 'application/octet-stream'
  if (!detected) {
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      if (!/\p{Cc}/u.test(text.replace(/[\t\n\r]/g, ''))) contentType = 'text/plain'
    } catch {}
  }
  const video = ['video/mp4', 'video/webm', 'video/quicktime', 'video/ogg'].includes(contentType)
  return { original: bytes, thumbnail: undefined, metadata: { width: 0, height: 0, mediaType: video ? 'video' : 'file', mimeType: contentType, storageExtension: 'bin', hasThumbnail: false } satisfies Partial<Asset> }
}

export interface AssetStorage {
  put(name: string, bytes: Buffer): Promise<void>
  read(name: string): Promise<Buffer>
  remove(name: string): Promise<void>
}

function assetName(name: string) {
  if (!/^[0-9a-f-]{36}\.(png|webp|mp4|bin)$/.test(name)) throw new Error('Invalid asset key')
  return name
}

export class LocalAssetStorage implements AssetStorage {
  private directory: string
  constructor(dataDir: string) { this.directory = join(dataDir, 'images') }
  async put(name: string, bytes: Buffer) { await writeFile(join(this.directory, assetName(name)), bytes, { mode: 0o600 }) }
  async read(name: string) { return readFile(join(this.directory, assetName(name))) }
  async remove(name: string) { await rm(join(this.directory, assetName(name)), { force: true }) }
}

export class BlobAssetStorage implements AssetStorage {
  private container
  constructor(endpoint: string, container: string) {
    const url = new URL(endpoint)
    if (url.protocol !== 'https:' || !url.hostname.endsWith('.blob.core.windows.net') || url.search || url.username || url.password || url.pathname !== '/') throw new Error('Invalid Blob endpoint')
    this.container = new BlobServiceClient(url.href, new ManagedIdentityCredential()).getContainerClient(container)
  }
  async put(name: string, bytes: Buffer) {
    await this.container.getBlockBlobClient(assetName(name)).uploadData(bytes, {
      blobHTTPHeaders: { blobContentType: name.endsWith('.bin') ? 'application/octet-stream' : name.endsWith('.mp4') ? 'video/mp4' : name.endsWith('.webp') ? 'image/webp' : 'image/png', blobCacheControl: 'private, no-store' },
    })
  }
  async read(name: string) { return this.container.getBlobClient(assetName(name)).downloadToBuffer() }
  async remove(name: string) { await this.container.getBlobClient(assetName(name)).deleteIfExists() }
  async verifyAccess() {
    const name = `${randomUUID()}.png`
    const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64')
    try {
      await this.put(name, bytes)
      if (!(await this.read(name)).equals(bytes)) throw new Error('Blob round trip failed')
    } finally { await this.remove(name) }
  }
  async migrateLocal(dataDir: string, assets: Pick<Asset, 'id' | 'mediaType' | 'storageExtension' | 'hasThumbnail'>[]) {
    let count = 0
    for (const asset of assets) {
      const { id } = asset
      for (const extension of [assetExtension(asset), ...(assetHasThumbnail(asset) ? ['webp'] : [])]) {
        const name = assetName(`${id}.${extension}`)
        const blob = this.container.getBlockBlobClient(name)
        if (await blob.exists()) continue
        const bytes = await readFile(join(dataDir, 'images', name))
        await this.put(name, bytes)
        const stored = await this.read(name)
        if (!stored.equals(bytes)) throw new Error('Blob migration verification failed')
        count += 1
      }
    }
    return count
  }
}