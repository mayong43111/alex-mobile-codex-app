import Fastify from 'fastify'
import multipart from '@fastify/multipart'
import staticFiles from '@fastify/static'
import { z } from 'zod'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { Store, HttpError } from './store.ts'
import type { Asset } from '../src/domain.ts'
import { assetExtension, assetHasThumbnail, assetContentType } from '../src/domain.ts'
import { AgentWorker } from './agent.ts'
import type { AgentTransport } from './agent.ts'
import { BlobAssetStorage, LocalAssetStorage, prepareUpload } from './assets.ts'
import type { AssetStorage } from './assets.ts'
import type { VmControl } from './vm.ts'

const titleSchema = z.object({ title: z.string().trim().min(1).max(80) }).strict()
const submissionSchema = z.object({
  requestId: z.string().uuid(), text: z.string().trim().min(1).max(6000),
  assetIds: z.array(z.string().uuid()).max(10).refine(ids => new Set(ids).size === ids.length),
  ratio: z.enum(['1:1', '4:3', '3:4', '16:9']),
}).strict()

export async function buildApp(options: { dataDir: string; origins?: string[]; agent?: AgentTransport; hosts?: string[]; staticRoot?: string; entra?: { tenantId: string; userIds: string[] }; journalMode?: 'WAL' | 'DELETE'; assetStorage?: AssetStorage; vm?: VmControl }) {
  await mkdir(join(options.dataDir, 'images'), { recursive: true, mode: 0o700 })
  const store = new Store(join(options.dataDir, 'studio.sqlite'), options.journalMode)
  const assetStorage = options.assetStorage ?? new LocalAssetStorage(options.dataDir)
  async function cleanupAssets() {
    for (const name of store.pendingAssetCleanup()) {
      try { await assetStorage.remove(name); store.completeAssetCleanup(name) } catch { continue }
    }
    return store.pendingAssetCleanup().length
  }
  await cleanupAssets()
  if (assetStorage instanceof BlobAssetStorage) {
    let stage = 'access-check'
    try {
      await assetStorage.verifyAccess()
      stage = 'migration'
      const assets = store.projects().flatMap(project => store.snapshot(project.id).assets)
      const migrated = await assetStorage.migrateLocal(options.dataDir, assets)
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
  await app.register(multipart, { limits: { fileSize: 64 * 1024 * 1024, files: 1, fields: 0 } })
  const origins = new Set(options.origins ?? ['http://localhost:5173', 'http://127.0.0.1:5173'])
  const streams = new Set<() => void>()
  const worker = options.agent ? new AgentWorker(store, options.dataDir, options.agent, assetStorage, () => !options.vm?.busy) : undefined
  worker?.start()
  let vmCheck: Promise<unknown> | undefined
  const vmTimer = options.vm ? setInterval(() => {
    if (options.vm?.busy && !vmCheck) vmCheck = options.vm.status().catch(() => {}).finally(() => { vmCheck = undefined })
  }, 10000) : undefined

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
  app.addHook('onClose', async () => { clearInterval(vmTimer); await vmCheck; await worker?.close(); store.db.close() })

  app.get('/healthz', async () => ({ status: 'ok' }))
  app.get('/api/vm', async () => options.vm ? options.vm.status() : { configured: false })
  app.post('/api/vm/actions', async (request, reply) => {
    if (!options.vm) throw new HttpError(503, 'VM 管理未配置。')
    const input = z.object({ action: z.enum(['start', 'deallocate', 'restart']), requestId: z.string().uuid(), confirmedName: z.string().min(1), force: z.boolean().default(false) }).strict().parse(request.body)
    if (store.hasPendingRuns() || worker?.hasActiveProject()) throw new HttpError(409, '应用有运行或排队任务，请先等待任务结束。')
    return reply.code(202).send(await options.vm.act(input.action, input.requestId, input.confirmedName, input.force))
  })
  if (options.staticRoot) await app.register(staticFiles, { root: options.staticRoot, index: 'index.html', cacheControl: false })

  app.get('/api/health', async () => {
    const status = options.agent ? await options.agent.health().catch(() => null) : null
    const ready = status !== null
    const models = z.object({ models: z.object({ images: z.array(z.enum(['azure-image2', 'qwen-image-2.1'])), videos: z.array(z.literal('minimax-h3')) }) }).safeParse(status)
    return { storage: 'ready', agentConfigured: !!options.agent, agent: ready ? 'configured' : 'not_connected', renderer: ready ? 'azure_image2' : 'not_connected',
      openmontage: ready ? 'installed' : 'not_connected', mode: options.entra ? 'entra-shared-workspace' : 'local-development', models: models.success ? models.data.models : { images: ready ? ['azure-image2'] : [], videos: [] } }
  })
  app.post<{ Params: { id: string } }>('/api/projects/:id/chat', async (request, reply) => {
    if (!worker) throw new HttpError(503, 'Codex 未配置')
    if (options.vm?.busy) throw new HttpError(409, 'VM 操作尚未确认完成，请先刷新 VM 状态。')
    const input = z.object({ requestId: z.string().uuid(), text: z.string().trim().min(1).max(6000),
      assetIds: z.array(z.string().uuid()).max(10).refine(ids => new Set(ids).size === ids.length).default([]),
      mode: z.enum(['auto', 'chat', 'image']), ratio: z.enum(['1:1', '3:2', '2:3', '4:3', '3:4', '16:9', '9:16']), quality: z.enum(['low', 'medium', 'high']).default('low'),
      imageModel: z.enum(['azure-image2', 'qwen-image-2.1']).default('azure-image2'), videoModel: z.enum(['none', 'minimax-h3']).default('none') }).strict().parse(request.body)
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
  app.delete<{ Params: { id: string } }>('/api/projects/:id', async request => {
    const input = z.object({ expectedUpdatedAt: z.string().datetime() }).strict().parse(request.body)
    if (worker?.hasActiveProject(request.params.id)) throw new HttpError(409, '运行尚未结束，请稍后再删除。')
    store.deleteProject(request.params.id, input.expectedUpdatedAt)
    return { deleted: true, pendingCleanup: await cleanupAssets() }
  })
  app.get<{ Params: { id: string } }>('/api/projects/:id', async request => store.snapshot(request.params.id))
  app.post<{ Params: { id: string } }>('/api/projects/:id/messages', async (request, reply) => {
    const job = store.submit(request.params.id, submissionSchema.parse(request.body))
    return reply.code(202).send(job)
  })
  app.post<{ Params: { id: string } }>('/api/jobs/:id/cancel', async request => store.cancel(request.params.id))

  app.post<{ Params: { id: string } }>('/api/projects/:id/uploads', async (request, reply) => {
    store.project(request.params.id)
    const file = await request.file()
    if (!file) throw new HttpError(400, 'File required')
    const bytes = await file.toBuffer()
    const name = (file.filename.split(/[\\/]/).at(-1) ?? 'file').replace(/\p{Cc}/gu, '').slice(0, 160) || 'file'
    const { original, thumbnail, metadata } = await prepareUpload(bytes, name, file.mimetype)
    const id = randomUUID()
    const asset: Asset = {
      id, projectId: request.params.id, kind: 'reference', name, ...metadata,
      bytes: original.length, hash: createHash('sha256').update(original).digest('hex'), createdAt: new Date().toISOString(),
    }
    const keys = [`${id}.${assetExtension(asset)}`, ...(thumbnail ? [`${id}.webp`] : [])]
    try {
      await assetStorage.put(keys[0], original)
      if (thumbnail) await assetStorage.put(`${id}.webp`, thumbnail)
      store.addAsset(asset)
    } catch (error) {
      await Promise.allSettled(keys.map(key => assetStorage.remove(key)))
      throw error
    }
    return reply.code(201).send(asset)
  })

  app.get<{ Params: { id: string }; Querystring: { thumbnail?: string; download?: string } }>('/api/assets/:id/content', async (request, reply) => {
    const asset = store.asset(request.params.id)
    const thumbnail = request.query.thumbnail === '1'
    if (thumbnail && !assetHasThumbnail(asset)) throw new HttpError(404, 'No thumbnail')
    const extension = thumbnail ? 'webp' : assetExtension(asset)
    if (request.query.download === '1' || asset.mediaType === 'file') {
      const filename = thumbnail ? `${asset.id}.webp` : asset.mediaType === 'file' || asset.storageExtension === 'bin' ? asset.name : `${asset.name.replace(/\.[^.]+$/, '')}.${extension}`
      reply.header('Content-Disposition', `attachment; filename="${asset.id}.${extension}"; filename*=UTF-8''${encodeURIComponent(filename).replace(/['()*]/g, character => `%${character.charCodeAt(0).toString(16)}`)}`)
    }
    reply.type(thumbnail ? 'image/webp' : asset.mediaType === 'file' ? 'application/octet-stream' : assetContentType(asset))
    if (asset.mediaType === 'file') reply.header('Content-Security-Policy', "sandbox; default-src 'none'")
    const bytes = await assetStorage.read(`${asset.id}.${extension}`)
    if (!thumbnail && asset.mediaType === 'video') {
      reply.header('Accept-Ranges', 'bytes')
      const range = request.headers.range
      if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range)
        const start = match?.[1] ? Number(match[1]) : match?.[2] ? Math.max(0, bytes.length - Number(match[2])) : NaN
        const end = match?.[1] && match?.[2] ? Math.min(Number(match[2]), bytes.length - 1) : bytes.length - 1
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= bytes.length) return reply.code(416).header('Content-Range', `bytes */${bytes.length}`).send()
        return reply.code(206).header('Content-Range', `bytes ${start}-${end}/${bytes.length}`).send(bytes.subarray(start, end + 1))
      }
    }
    return bytes
  })

  app.get<{ Params: { id: string } }>('/api/projects/:id/events', async (request, reply) => {
    store.project(request.params.id)
    let cursor = Number(request.headers['last-event-id'] ?? 0)
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new HttpError(400, 'Invalid event cursor')
    reply.hijack()
    reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' })
    reply.raw.write('event: connected\ndata: {}\n\n')
    const pump = () => {
      try { store.project(request.params.id) } catch {
        reply.raw.write('event: deleted\ndata: {}\n\n')
        reply.raw.end()
        return
      }
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