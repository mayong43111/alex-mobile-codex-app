import { createHash } from 'node:crypto'
import { z } from 'zod'

export const sourceBodyLimit = 68 * 1024 * 1024

export const imageCandidateSchema = z.object({
  assetId: z.string().uuid(), name: z.string().min(1).max(160), hash: z.string().regex(/^[a-f0-9]{64}$/),
  width: z.number().int().positive(), height: z.number().int().positive(), kind: z.enum(['reference', 'generated']),
  messageId: z.string().uuid(), context: z.string().max(6000),
}).strict()
const sourceSchema = imageCandidateSchema.pick({ assetId: true, hash: true, width: true, height: true }).extend({ png: z.string().min(1).max(66_666_668) }).strict()

export class ImageSourceRequest {
  constructor(candidate, signal) {
    this.candidate = imageCandidateSchema.parse(candidate)
    this.signal = signal
    this.closed = false
    this.promise = new Promise((resolve, reject) => {
      this.resolve = resolve
      this.abort = () => { this.closed = true; reject(new Error('Source delivery stopped; no image request sent')) }
      signal.addEventListener('abort', this.abort, { once: true })
      if (signal.aborted) this.abort()
    })
    this.promise.catch(() => {})
  }
  provide(value) {
    if (this.closed) throw new Error('Source request closed')
    const source = sourceSchema.parse(value)
    const bytes = Buffer.from(source.png, 'base64')
    if (['assetId', 'hash', 'width', 'height'].some(key => source[key] !== this.candidate[key]) || !bytes.length || bytes.length >= 50_000_000 || createHash('sha256').update(bytes).digest('hex') !== source.hash) throw new Error('Source does not match Codex selection')
    this.signal.removeEventListener('abort', this.abort)
    this.resolve(source)
  }
}