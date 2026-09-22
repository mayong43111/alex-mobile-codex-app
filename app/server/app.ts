import Fastify from 'fastify'
import multipart from '@fastify/multipart'
import staticFiles from '@fastify/static'
import sharp from 'sharp'
import { z } from 'zod'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { Store, HttpError } from './store.ts'
import type { Asset } from '../src/domain.ts'
import { AgentWorker } from './agent.ts'
import type { AgentTransport } from './agent.ts'
import { BlobAssetStorage, LocalAssetStorage } from './assets.ts'
import type { AssetStorage } from './assets.ts'

const titleSchema = z.object({ title: z.string().trim().min(1).max(80) }).strict()
const submissionSchema = z.object({
  requestId: z.string().uuid(), text: z.string().trim().min(1).max(6000),
  assetIds: z.array(z.string().uuid()).max(10).refine(ids => new Set(ids).size === ids.length),
  ratio: z.enum(['1:1', '4:3', '3:4', '16:9']),
}).strict()

export async function buildApp(options: { dataDir: string; origins?: string[]; agent?: AgentTransport; hosts?: string[]; staticRoot?: string; entra?: { tenantId: string; userIds: string[] }; journalMode?: 'WAL' | 'DELETE'; assetStorage?: AssetStorage }) {
  await mkdir(join(options.dataDir, 'images'), { recursive: true, mode: 0o700 })
  const store = new Store(join(options.dataDir, 'studio.sqlite'), options.journalMode)
  const assetStorage = options.assetStorage ?? new LocalAssetStorage(options.dataDir)
  if (assetStorage instanceof BlobAssetStorage) {
    let stage = 'access-check'
    try {
      await assetStorage.verifyAccess()
      stage = 'migration'
      const ids = store.projects().flatMap(project => store.snapshot(project.id).assets.map(asset => asset.id))
      const migrated = await assetStorage.migrateLocal(options.dataDir, ids)
      console.log(`Blob read/write/delete verified; migrated ${migrated} files`)
    } catch (error) {
      const failure = error as { name?: string; code?: string; statusCode?: number }
      const safe = (value: unknown) => typeof value === 'string' && /^[a-zA-Z0-9_]{1,80}$/.test(value) ? value : 'unknown'
      console.error(JSON.stringify({ storage: 'blob', stage, name: safe(failure.name), code: safe(failure.code), status: failure.statusCode }))
      store.db.close()
      throw new Error('Blob asset migration failed; local originals retained')
    }
  }
  const app = Fastify({ bodyLimit: 64 * 1024, logger: false })
  await app.register(multipart, { limits: { fileSize: 12 * 1024 * 1024, files: 1, fields: 0 } })
  const origins = new Set(options.origins ?? ['http://localhost:5173', 'http://127.0.0.1:5173'])
  const streams = new Set<() => void>()
  const worker = options.agent ? new AgentWorker(store, options.dataDir, options.agent, assetStorage) : undefined
  worker?.start()

  app.addHook('onRequest', async (request, reply) => {
    if (request.url.split('?')[0] === '/healthz' && request.method === 'GET') return
    const host = request.headers.host?.split(':')[0]
    if (!host || !(options.hosts ?? ['localhost', '127.0.0.1']).includes(host)) throw new HttpError(403, 'Host not allowed')
    reply.header('X-Content-Type-Options', 'nosniff').header('Cache-Control', 'no-store')
    const publicPaths = ['/manifest.webmanifest', '/sw.js', '/icons/icon-180.png', '/icons/icon-192.png', '/icons/icon-512.png']
    if (['GET', 'HEAD'].includes(request.method) && publicPaths.includes(request.url.split('?')[0])) return
    if (options.entra) {
      const encoded = request.headers['x-ms-client-principal']
      if (typeof encoded !== 'string') throw new HttpError(401, 'Sign in required')
      let principal: { auth_typ?: string; claims?: { typ: string; val: string }[] }
      try { principal = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) }
      catch { throw new HttpError(401, 'Invalid identity') }
      const claims = Array.isArray(principal?.claims) ? principal.claims : []
      const tenant = claims.find(claim => claim.typ === 'http://schemas.microsoft.com/identity/claims/tenantid' || claim.typ === 'tid')?.val
      const user = claims.find(claim => claim.typ === 'http://schemas.microsoft.com/identity/claims/objectidentifier' || claim.typ === 'oid')?.val
      if (principal?.auth_typ !== 'aad' || tenant !== options.entra.tenantId || !user || !options.entra.userIds.includes(user)) throw new HttpError(403, 'User not authorized')
    }
    const origin = request.headers.origin
    if (origin && !origins.has(origin)) throw new HttpError(403, 'Origin not allowed')
    reply.header('X-Content-Type-Options', 'nosniff').header('Cache-Control', 'no-store')
  })
  app.setErrorHandler((error, _request, reply) => {
    const failure = error as Error & { statusCode?: number }
    const status = error instanceof z.ZodError ? 400 : (failure.statusCode ?? 500)
    reply.code(status).send({ error: status === 500 ? 'Internal error' : error instanceof z.ZodError ? 'Invalid input' : failure.message })
  })
  app.addHook('preClose', async () => { for (const close of streams) close() })
  app.addHook('onClose', async () => { await worker?.close(); store.db.close() })

  app.get('/healthz', async () => ({ status: 'ok' }))
  if (options.staticRoot) await app.register(staticFiles, { root: options.staticRoot, index: 'index.html', cacheControl: false })

  app.get('/api/health', async () => {
    const ready = options.agent ? await options.agent.health().then(() => true).catch(() => false) : false
    return { storage: 'ready', agentConfigured: !!options.agent, agent: ready ? 'configured' : 'not_connected', renderer: ready ? 'azure_image2' : 'not_connected',
      openmontage: ready ? 'installed' : 'not_connected', mode: options.entra ? 'entra-shared-workspace' : 'local-development' }
  })
  app.post<{ Params: { id: string } }>('/api/projects/:id/chat', async (request, reply) => {
    if (!worker) throw new HttpError(503, 'Codex 未配置')
    const input = z.object({ requestId: z.string().uuid(), text: z.string().trim().min(1).max(6000),
      mode: z.enum(['auto', 'chat', 'image']), ratio: z.enum(['1:1', '3:2', '2:3']) }).strict().parse(request.body)
    return reply.code(202).send(store.queueAgent(request.params.id, input))
  })
  app.post<{ Params: { id: string } }>('/api/agent-runs/:id/stop', async request => {
    if (!worker) throw new HttpError(503, 'Codex 未配置')
    return worker.stop(request.params.id)
  })
  app.post<{ Params: { id: string; messageId: string } }>('/api/projects/:id/messages/:messageId/resend', async (request, reply) => {
    const input = z.object({ requestId: z.string().uuid(), expectedTailId: z.string().uuid() }).strict().parse(request.body)
    const result = worker ? worker.resend(request.params.id, request.params.messageId, input) : store.resend(request.params.id, request.params.messageId, input, false)
    return reply.code(202).send(result)
  })
  app.get('/api/projects', async () => store.projects())
  app.post('/api/projects', async (request, reply) => {
    reply.code(201)
    return store.createProject(titleSchema.parse(request.body).title)
  })
  app.patch<{ Params: { id: string } }>('/api/projects/:id', async request => store.rename(request.params.id, titleSchema.parse(request.body).title))
  app.get<{ Params: { id: string } }>('/api/projects/:id', async request => store.snapshot(request.params.id))
  app.post<{ Params: { id: string } }>('/api/projects/:id/messages', async (request, reply) => {
    const job = store.submit(request.params.id, submissionSchema.parse(request.body))
    return reply.code(202).send(job)
  })
  app.post<{ Params: { id: string } }>('/api/jobs/:id/cancel', async request => store.cancel(request.params.id))

  app.post<{ Params: { id: string } }>('/api/projects/:id/uploads', async (request, reply) => {
    store.project(request.params.id)
    const file = await request.file()
    if (!file) throw new HttpError(400, 'Image required')
    const bytes = await file.toBuffer()
    let original: Buffer
    let thumbnail: Buffer
    let width: number
    let height: number
    try {
      const image = sharp(bytes, { limitInputPixels: 40_000_000, animated: false })
      const metadata = await image.metadata()
      if (!['jpeg', 'png', 'webp'].includes(metadata.format ?? '') || (metadata.pages ?? 1) > 1) throw new Error('Unsupported image')
      const decoded = await image.rotate().png().toBuffer({ resolveWithObject: true })
      original = decoded.data
      width = decoded.info.width
      height = decoded.info.height
      thumbnail = await sharp(original).resize(480, 480, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 82 }).toBuffer()
    } catch {
      throw new HttpError(400, 'Upload a valid, single-frame PNG, JPEG or WebP image (max 40 megapixels)')
    }
    const id = randomUUID()
    const asset: Asset = {
      id, projectId: request.params.id, kind: 'reference', name: file.filename.slice(0, 160),
      width, height, bytes: original.length, hash: createHash('sha256').update(original).digest('hex'), createdAt: new Date().toISOString(),
    }
    try {
      await assetStorage.put(`${id}.png`, original)
      await assetStorage.put(`${id}.webp`, thumbnail)
      store.addAsset(asset)
    } catch (error) {
      await Promise.allSettled(['png', 'webp'].map(extension => assetStorage.remove(`${id}.${extension}`)))
      throw error
    }
    return reply.code(201).send(asset)
  })

  app.get<{ Params: { id: string }; Querystring: { thumbnail?: string; download?: string } }>('/api/assets/:id/content', async (request, reply) => {
    const asset = store.asset(request.params.id)
    const thumbnail = request.query.thumbnail === '1'
    if (request.query.download === '1') reply.header('Content-Disposition', `attachment; filename="${asset.id}.png"`)
    reply.type(thumbnail ? 'image/webp' : 'image/png')
    return assetStorage.read(`${asset.id}.${thumbnail ? 'webp' : 'png'}`)
  })

  app.get<{ Params: { id: string } }>('/api/projects/:id/events', async (request, reply) => {
    store.project(request.params.id)
    let cursor = Number(request.headers['last-event-id'] ?? 0)
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new HttpError(400, 'Invalid event cursor')
    reply.hijack()
    reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' })
    reply.raw.write('event: connected\ndata: {}\n\n')
    const pump = () => {
      for (const event of store.events(request.params.id, cursor)) {
        cursor = Number(event.id)
        if (!reply.raw.write(`id: ${cursor}\nevent: changed\ndata: ${JSON.stringify(event)}\n\n`)) break
      }
    }
    pump()
    const timer = setInterval(pump, 1000)
    const heartbeat = setInterval(() => reply.raw.write(': heartbeat\n\n'), 15000)
    const close = () => {
      clearInterval(timer)
      clearInterval(heartbeat)
      streams.delete(close)
      reply.raw.end()
    }
    streams.add(close)
    reply.raw.on('close', close)
  })
  return app
}