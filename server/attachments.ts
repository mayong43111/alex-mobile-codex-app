import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import sharp from 'sharp'
import { MessageAttachmentKind } from '@microsoft/agent-host-protocol'
import type { MessageResourceAttachment } from '@microsoft/agent-host-protocol'
import { imageLimits } from '../src/shared.js'
import type { AttachmentInfo } from '../src/shared.js'
import { AppError } from './errors.js'
import { Store } from './store.js'
import { ContainerClient } from '@azure/storage-blob'
import type { Config } from './config.js'
import { createAzureCredential } from './models.js'

export class Attachments {
  private container?: ContainerClient
  constructor(private store: Store, private dataDir: string, config?: Config) {
    if (config?.blobContainerUrl) this.container = new ContainerClient(config.blobContainerUrl, createAzureCredential(config), { retryOptions: { maxTries: 1 } })
  }
  private blob(userId: string, id: string) { return this.container!.getBlockBlobClient(`attachments/${userId}/${id}`) }
  private path(userId: string, id: string) { return join(this.dataDir, 'attachments', userId, id) }
  async save(userId: string, data: Buffer, name: string, kind: AttachmentInfo['kind'] = 'upload'): Promise<AttachmentInfo> {
    const upload = kind === 'upload'
    if (!data.length || data.length > (upload ? imageLimits.uploadBytes : 20 * 1024 * 1024)) throw new AppError(413, upload ? '图片超过 2MB，请降低分辨率或质量后重试。' : '生成结果超过 20MB，未保存；请勿直接重复提交。')
    let bytes = data
    let format: string
    let width: number
    let height: number
    try {
      const image = sharp(data, { limitInputPixels: upload ? 2048 * 2048 : 32 * 1024 * 1024, animated: false })
      const metadata = await image.metadata()
      if (!metadata.width || !metadata.height || !['jpeg', 'png', 'webp'].includes(metadata.format ?? '') || (metadata.pages ?? 1) > 1) throw new AppError(415, '仅支持静态 JPEG、PNG 和 WebP 图片。')
      width = metadata.autoOrient.width
      height = metadata.autoOrient.height
      if (upload && Math.max(width, height) > imageLimits.maxEdge) throw new AppError(413, '图片最长边不能超过 2048px，请先调整分辨率。')
      format = metadata.format!
      if (upload) { bytes = await image.rotate().webp({ quality: 90 }).toBuffer(); format = 'webp' }
      else await image.stats()
    } catch (error) {
      if (error instanceof AppError) throw error
      throw new AppError(415, '无法读取图片，文件可能损坏、尺寸过大或格式不支持。')
    }
    if (upload && bytes.length > imageLimits.uploadBytes) throw new AppError(413, '压缩后仍超过 2MB，请继续降低分辨率。')
    if (await this.store.attachmentBytes(userId) + bytes.length > 200 * 1024 * 1024) throw new AppError(413, '图片存储空间已满，请联系管理员清理。')
    const id = randomUUID()
    const attachment: AttachmentInfo = {
      id, name: name.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 160) || 'image',
      url: `/api/attachments/${id}`, mime: `image/${format}`, width, height, bytes: bytes.length, kind,
    }
    if (this.container) {
      await this.blob(userId, id).uploadData(bytes, { conditions: { ifNoneMatch: '*' }, blobHTTPHeaders: { blobContentType: attachment.mime } })
    } else {
      await mkdir(join(this.dataDir, 'attachments', userId), { recursive: true, mode: 0o700 })
      await writeFile(this.path(userId, id), bytes, { flag: 'wx', mode: 0o600 })
    }
    try { await this.store.saveAttachment(userId, attachment) }
    catch (error) {
      if (this.container) await this.blob(userId, id).delete()
      else await unlink(this.path(userId, id))
      throw error
    }
    return attachment
  }
  info(userId: string, id: string) { return this.store.attachment(userId, id) }
  async read(userId: string, id: string) {
    const info = await this.info(userId, id)
    return { info, data: this.container ? await this.blob(userId, id).downloadToBuffer() : await readFile(this.path(userId, id)) }
  }
  async removeProbe(userId: string, id: string) {
    await this.info(userId, id)
    if (this.container) await this.blob(userId, id).delete()
    else await unlink(this.path(userId, id))
  }
  async reference(userId: string, uri: string): Promise<MessageResourceAttachment> {
    const match = /^studio-attachment:\/([0-9a-f-]{36})$/.exec(uri)
    if (!match) throw new AppError(400, '无效的图片引用')
    const image = await this.info(userId, match[1])
    return { type: MessageAttachmentKind.Resource, uri, label: image.name, contentType: image.mime, sizeHint: image.bytes, displayKind: 'image' }
  }
}
