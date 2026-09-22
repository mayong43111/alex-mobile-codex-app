import { readFile, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { BlobServiceClient } from '@azure/storage-blob'
import { ManagedIdentityCredential } from '@azure/identity'

export interface AssetStorage {
  put(name: string, bytes: Buffer): Promise<void>
  read(name: string): Promise<Buffer>
  remove(name: string): Promise<void>
}

function assetName(name: string) {
  if (!/^[0-9a-f-]{36}\.(png|webp)$/.test(name)) throw new Error('Invalid asset key')
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
      blobHTTPHeaders: { blobContentType: name.endsWith('.webp') ? 'image/webp' : 'image/png', blobCacheControl: 'private, no-store' },
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
  async migrateLocal(dataDir: string, ids: string[]) {
    let count = 0
    for (const id of ids) {
      for (const extension of ['png', 'webp']) {
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