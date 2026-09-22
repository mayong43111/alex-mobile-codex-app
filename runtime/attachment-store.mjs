import { mkdir, readFile, writeFile, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { attachmentSchema } from './attachments.mjs'

export const readableAttachmentSchema = attachmentSchema.safeExtend({ sha256: z.string().regex(/^[a-f0-9]{64}$/) })
export const attachmentManifestSchema = z.object({ runId: z.string().uuid(), files: z.array(readableAttachmentSchema).max(10) }).strict()
export const processedImageSchema = z.object({ assetId: z.string().uuid(), sourceAssetId: z.string().uuid(), sourceHash: z.string().regex(/^[a-f0-9]{64}$/), hash: z.string().regex(/^[a-f0-9]{64}$/), width: z.number().int().positive().max(40_000_000), height: z.number().int().positive().max(40_000_000), bytes: z.number().int().positive().max(16 * 1024 * 1024), name: z.string().min(1).max(160) }).strict().refine(image => image.width * image.height <= 40_000_000)

export class AttachmentStore {
  constructor(root) { this.root = root; this.writing = Promise.resolve() }
  directory(runId) { return join(this.root, z.string().uuid().parse(runId)) }
  file(runId, assetId) { return join(this.directory(runId), `${z.string().uuid().parse(assetId)}.bin`) }
  async stage(runId, assetId, bytes, hash) {
    z.string().regex(/^[a-f0-9]{64}$/).parse(hash)
    if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 64 * 1024 * 1024 || createHash('sha256').update(bytes).digest('hex') !== hash) throw new Error('Invalid attachment bytes')
    const work = this.writing.catch(() => {}).then(async () => {
      const directory = this.directory(runId)
      const target = this.file(runId, assetId)
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const files = await readdir(directory)
      if (files.includes('manifest.json')) throw new Error('Attachments already sealed')
      if (files.includes(`${assetId}.bin`)) {
        if (createHash('sha256').update(await readFile(target)).digest('hex') !== hash) throw new Error('Attachment conflict')
        return
      }
      if (files.length >= 10) throw new Error('Too many attachments')
      await writeFile(target, bytes, { mode: 0o600, flag: 'wx' })
    })
    this.writing = work
    return work
  }
  async seal(runId, files) {
    await this.writing
    const manifest = attachmentManifestSchema.parse({ runId, files })
    if (new Set(files.map(file => file.assetId)).size !== files.length) throw new Error('Duplicate attachments')
    for (const file of manifest.files) {
      const bytes = await readFile(this.file(runId, file.assetId))
      if (bytes.length !== file.bytes || createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new Error('Attachment verification failed')
    }
    const directory = this.directory(runId)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const path = join(directory, 'manifest.json')
    await writeFile(path, JSON.stringify(manifest), { mode: 0o600, flag: 'wx' })
    return path
  }
  async remove(runId) { await rm(this.directory(runId), { recursive: true, force: true }) }
  async processed(runId) {
    const directory = join(this.directory(runId), 'processed')
    const names = await readdir(directory).catch(error => { if (error.code === 'ENOENT') return []; throw error })
    const records = names.filter(name => name.endsWith('.json'))
    if (records.length > 4) throw new Error('Too many processed images')
    return Promise.all(records.map(async name => {
      const metadata = processedImageSchema.parse(JSON.parse(await readFile(join(directory, name), 'utf8')))
      const bytes = await readFile(join(directory, `${metadata.assetId}.png`))
      if (bytes.length !== metadata.bytes || createHash('sha256').update(bytes).digest('hex') !== metadata.hash) throw new Error('Processed image changed')
      return { ...metadata, png: bytes.toString('base64') }
    }))
  }
  async prune(activeId) {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    for (const name of await readdir(this.root)) {
      if (!z.string().uuid().safeParse(name).success || name === activeId) continue
      if (Date.now() - (await stat(this.directory(name))).mtimeMs > 60 * 60 * 1000) await this.remove(name)
    }
  }
}