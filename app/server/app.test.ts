import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import sharp from 'sharp'
import { buildApp } from './app.ts'
import { Store } from './store.ts'
import { AgentWorker, managedModelToken } from './agent.ts'
import type { AgentTransport, ImageCandidate, RemoteRun, SourceImage } from './agent.ts'
import type { AssetStorage } from './assets.ts'
import { VmController } from './vm.ts'
import { provisionLocalUser } from './auth.ts'

async function loginHeaders(app: Awaited<ReturnType<typeof buildApp>>, dataDir: string, host = 'localhost') {
  const store = new Store(join(dataDir, 'studio.sqlite'))
  await provisionLocalUser(store.db, 'test-user', 'local-test-password', 'Test')
  store.db.close()
  const origin = `https://${host}`
  const response = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { host, origin }, payload: { username: 'test-user', password: 'local-test-password' } })
  assert.equal(response.statusCode, 200)
  return { host, origin, cookie: `${response.cookies[0].name}=${response.cookies[0].value}`, 'x-csrf-token': response.json().csrf }
}

test('project ownership fails closed for foreign and legacy unowned projects', () => {
  const store = new Store(':memory:')
  try {
    const first = store.createProject('Private A', 'user-a')
    const second = store.createProject('Private B', 'user-b')
    const legacy = store.createProject('Unowned')
    assert.deepEqual(store.projects('user-a').map(project => project.id), [first.id])
    assert.deepEqual(store.projects('user-b').map(project => project.id), [second.id])
    store.requireOwner(first.id, 'user-a')
    assert.throws(() => store.requireOwner(second.id, 'user-a'), /not found/)
    assert.throws(() => store.requireOwner(legacy.id, 'user-a'), /not found/)
    store.deleteProject(first.id, first.updatedAt)
    assert.deepEqual(store.projects('user-a'), [])
  } finally { store.db.close() }
})

test('VM controller pins the target, deduplicates operations and refuses busy GPU shutdown', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'studio-vm-'))
  let power = 'deallocated'
  let posts = 0
  let queued = false
  const controller = new VmController({ subscription: randomUUID(), resourceGroup: 'test-rg', name: 'test-vm', comfyUrl: 'http://gpu.invalid', auth: 'cli' }, join(directory, 'vm.json'), async (url, method) => {
    assert(url.startsWith('https://management.azure.com/'))
    if (method === 'POST') { posts++; power = 'running'; return new Response(null, { status: 202, headers: { 'azure-asyncoperation': 'https://management.azure.com/test-operation' } }) }
    return Response.json(url.endsWith('/test-operation') ? { status: 'Succeeded' } : { statuses: [{ code: `PowerState/${power}` }] })
  }, async () => Response.json({ queue_running: queued ? ['task'] : [], queue_pending: [] }))
  try {
    await controller.initialize()
    const id = randomUUID()
    await assert.rejects(controller.act('start', id, 'wrong-vm', false), /名称/)
    assert.equal((await controller.act('start', id, 'test-vm', false)).powerState, 'running')
    await controller.act('start', id, 'test-vm', false)
    assert.equal(posts, 1)
    queued = true
    await assert.rejects(controller.act('deallocate', randomUUID(), 'test-vm', true), /GPU/)
    assert.equal(posts, 1)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('VM API blocks actions while application work is pending', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'studio-vm-api-'))
  const store = new Store(join(dataDir, 'studio.sqlite'))
  const project = store.createProject('Busy')
  store.queueAgent(project.id, { requestId: randomUUID(), text: 'test', ratio: '1:1', mode: 'auto' })
  store.db.close()
  let calls = 0
  const app = await buildApp({ dataDir, vm: { busy: false, async status() { return { configured: true, name: 'test' } }, async act() { calls++; return { configured: true } } } })
  try {
    assert.equal((await app.inject('/api/vm')).json().name, 'test')
    const result = await app.inject({ method: 'POST', url: '/api/vm/actions', payload: { action: 'deallocate', requestId: randomUUID(), confirmedName: 'test' } })
    assert.equal(result.statusCode, 409)
    assert.equal(calls, 0)
  } finally { await app.close(); await rm(dataDir, { recursive: true, force: true }) }
})

test('uncertain VM operation survives restart without resubmission', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'studio-vm-uncertain-'))
  const config = { subscription: randomUUID(), resourceGroup: 'test', name: 'test', comfyUrl: 'http://gpu.invalid', auth: 'cli' as const }
  let posts = 0
  const request = async (_url: string, method?: string) => {
    if (method === 'POST') { posts++; throw new Error('Lost response') }
    return Response.json({ statuses: [{ code: 'PowerState/deallocated' }] })
  }
  try {
    const first = new VmController(config, join(directory, 'vm.json'), request)
    await first.initialize()
    const id = randomUUID()
    await assert.rejects(first.act('start', id, 'test', false), /待核实/)
    const second = new VmController(config, join(directory, 'vm.json'), request)
    await second.initialize()
    assert(second.busy)
    assert.equal((await second.act('start', id, 'test', false)).operation?.status, 'unknown')
    await assert.rejects(second.act('start', randomUUID(), 'test', false), /重复提交/)
    assert.equal(posts, 1)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('cloud VM control uses the application login authorization', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'studio-vm-auth-'))
  const tenantId = randomUUID(), userId = randomUUID()
  let calls = 0
  const app = await buildApp({ dataDir, auth: { origin: 'https://localhost' }, origins: ['https://localhost'], vm: { busy: false, async status() { return { configured: true } }, async act() { calls++; return { configured: true } } } })
  const principal = Buffer.from(JSON.stringify({ auth_typ: 'aad', claims: [{ typ: 'tid', val: tenantId }, { typ: 'oid', val: userId }] })).toString('base64')
  try {
    const payload = { action: 'start', requestId: randomUUID(), confirmedName: 'test' }
    const authenticated = await loginHeaders(app, dataDir)
    assert.equal((await app.inject({ url: '/api/vm', headers: authenticated })).statusCode, 200)
    assert.equal((await app.inject({ method: 'POST', url: '/api/vm/actions', headers: authenticated, payload })).statusCode, 202)
    assert.equal((await app.inject({ url: '/api/vm', headers: { 'x-ms-client-principal': principal } })).statusCode, 401)
    for (const headers of [{}, { 'x-ms-client-principal': Buffer.from(JSON.stringify({ auth_typ: 'aad', claims: [{ typ: 'tid', val: tenantId }, { typ: 'oid', val: randomUUID() }] })).toString('base64') }]) {
      assert.equal((await app.inject({ url: '/api/vm', headers })).statusCode, 401)
      assert.equal((await app.inject({ method: 'POST', url: '/api/vm/actions', headers, payload })).statusCode, 403)
    }
    assert.equal(calls, 1)
  } finally { await app.close(); await rm(dataDir, { recursive: true, force: true }) }
})

function memoryAssets() {
  const objects = new Map<string, Buffer>()
  const storage: AssetStorage = {
    async put(name, bytes) { objects.set(name, bytes) },
    async read(name) { const bytes = objects.get(name); if (!bytes) throw new Error('Missing object'); return bytes },
    async remove(name) { objects.delete(name) },
  }
  return { objects, storage }
}

test('chat attachments belong to the current project and survive resend', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'studio-attachments-'))
  const store = new Store(join(dataDir, 'studio.sqlite'))
  try {
    const project = store.createProject('Files')
    const other = store.createProject('Other')
    const asset = store.addAsset({ id: randomUUID(), projectId: project.id, name: 'reference.png', width: 32, height: 32, bytes: 10, hash: 'test', kind: 'reference', createdAt: new Date().toISOString() })
    const input = { requestId: randomUUID(), text: '附件已上传', mode: 'auto' as const, ratio: '1:1' as const, assetIds: [asset.id] }
    assert.throws(() => store.queueAgent(other.id, input), /another project/)
    assert.throws(() => store.queueAgent(project.id, { ...input, assetIds: [asset.id, asset.id] }), /Invalid attachments/)
    const run = store.queueAgent(project.id, input)
    assert.deepEqual(store.snapshot(project.id).messages[0].assetIds, [asset.id])
    assert.equal(store.queueAgent(project.id, input).id, run.id)
    assert.throws(() => store.queueAgent(project.id, { ...input, assetIds: [] }), /already used/)
    store.updateAgent(run.id, { status: 'completed' })
    const resent = store.resend(project.id, run.messageId, { requestId: randomUUID(), expectedTailId: store.snapshot(project.id).messages.at(-1)!.id }, true)
    assert('input' in resent)
    assert.deepEqual(resent.input.assetIds, [asset.id])
  } finally { store.db.close(); await rm(dataDir, { recursive: true, force: true }) }
})

test('chat API validates attachment IDs and rejects client supplied locations', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'studio-chat-files-'))
  const store = new Store(join(dataDir, 'studio.sqlite'))
  const project = store.createProject('Files')
  const other = store.createProject('Other')
  const asset = store.addAsset({ id: randomUUID(), projectId: project.id, name: 'notes.txt', width: 0, height: 0, bytes: 20, hash: 'test', kind: 'reference', mediaType: 'file', createdAt: new Date().toISOString() })
  store.db.close()
  const app = await buildApp({ dataDir, agent: { async health() { return {} }, async submit() {}, async get() { throw new Error('Not polled') }, async stop() {} } })
  try {
    const input = { requestId: randomUUID(), text: '已上传附件', mode: 'auto', ratio: '1:1', assetIds: [asset.id] }
    const url = `/api/projects/${project.id}/chat`
    assert.equal((await app.inject({ method: 'POST', url: `/api/projects/${other.id}/chat`, payload: input })).statusCode, 400)
    assert.equal((await app.inject({ method: 'POST', url, payload: { ...input, location: '/private/file' } })).statusCode, 400)
    assert.equal((await app.inject({ method: 'POST', url, payload: { ...input, assetIds: [asset.id, asset.id] } })).statusCode, 400)
    assert.equal((await app.inject({ method: 'POST', url, payload: { ...input, assetIds: [randomUUID()] } })).statusCode, 404)
    const accepted = await app.inject({ method: 'POST', url, payload: input })
    assert.equal(accepted.statusCode, 202)
    assert.deepEqual(accepted.json().input.assetIds, [asset.id])
  } finally { await app.close(); await rm(dataDir, { recursive: true, force: true }) }
})

test('worker sends only current attachment metadata and protected locations without reading bytes', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'studio-notices-'))
  const store = new Store(join(dataDir, 'studio.sqlite'))
  const project = store.createProject('Files')
  const asset = store.addAsset({ id: randomUUID(), projectId: project.id, name: 'notes.txt', width: 0, height: 0, bytes: 500, hash: 'private-hash', kind: 'reference', mediaType: 'file', mimeType: 'text/plain', storageExtension: 'bin', hasThumbnail: false, createdAt: new Date().toISOString() })
  const earlierAsset = store.addAsset({ ...asset, id: randomUUID(), name: 'earlier.txt' })
  store.addAsset({ ...asset, id: randomUUID(), name: 'unselected.txt' })
  const earlier = store.queueAgent(project.id, { requestId: randomUUID(), text: 'Earlier attachment', mode: 'chat', ratio: '1:1', assetIds: [earlierAsset.id] })
  store.updateAgent(earlier.id, { status: 'completed' })
  let submissions = 0
  const worker = new AgentWorker(store, dataDir, {
    async health() { return {} }, async stop() {}, async get() { throw new Error('Not polled') },
    async submit(_run, _threadId, history, sourceImage, attachments) {
      submissions++
      assert.deepEqual(sourceImage, [])
      assert.equal(history?.[0].attachments?.[0].assetId, earlierAsset.id)
      assert(!JSON.stringify(history).includes('unselected.txt'))
      assert.deepEqual(attachments, [{ assetId: asset.id, name: 'notes.txt', mediaType: 'file', mimeType: 'text/plain', bytes: 500, location: `/api/assets/${asset.id}/content` }])
    },
  }, { async read() { throw new Error('Attachment bytes must not be read') }, async put() {}, async remove() {} })
  try {
    store.queueAgent(project.id, { requestId: randomUUID(), text: '收到附件了吗', mode: 'auto', ratio: '1:1', assetIds: [asset.id] })
    await worker.tick()
    assert.equal(submissions, 1)
    assert.equal(store.snapshot(project.id).runs.at(-1)!.status, 'running')
  } finally { await worker.close(); store.db.close(); await rm(dataDir, { recursive: true, force: true }) }
})

test('worker stages only selected or latest retained attachments for on-demand reading', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'studio-readable-'))
  const store = new Store(join(dataDir, 'studio.sqlite'))
  const project = store.createProject('Readable')
  const bytes = Buffer.from('Only a tool should reveal this text')
  const hash = createHash('sha256').update(bytes).digest('hex')
  const asset = store.addAsset({ id: randomUUID(), projectId: project.id, name: 'notes.txt', width: 0, height: 0, bytes: bytes.length, hash, kind: 'reference', mediaType: 'file', storageExtension: 'bin', hasThumbnail: false, mimeType: 'text/plain', createdAt: new Date().toISOString() })
  store.addAsset({ ...asset, id: randomUUID(), name: 'unselected.txt' })
  let staged = 0, submitted = 0
  const worker = new AgentWorker(store, dataDir, {
    async health() { return {} }, async stop() {},
    async get(id) { return { id, status: 'completed', stage: 'codex', reply: 'ok', threadId: null } },
    async uploadAttachment(_runId, notice, content) { staged++; assert.equal(notice.assetId, asset.id); assert.deepEqual(content, bytes) },
    async submit(_run, _thread, _history, _source, current, readable) {
      submitted++
      assert.equal(current?.length, submitted === 1 ? 1 : 0)
      assert.equal(readable?.length, 1)
      assert.equal(readable?.[0].assetId, asset.id)
      assert(!JSON.stringify(readable).includes(bytes.toString()))
    },
  }, { async read(key) { assert.equal(key, `${asset.id}.bin`); return bytes }, async put() {}, async remove() {} })
  try {
    store.queueAgent(project.id, { requestId: randomUUID(), text: '看看附件', mode: 'chat', ratio: '1:1', assetIds: [asset.id] })
    await worker.tick(); await worker.tick()
    store.queueAgent(project.id, { requestId: randomUUID(), text: '继续读刚才的资料', mode: 'chat', ratio: '1:1' })
    await worker.tick()
    assert.equal(staged, 2)
    assert.equal(submitted, 2)
  } finally { await worker.close(); store.db.close(); await rm(dataDir, { recursive: true, force: true }) }
})

test('project deletion rejects active and stale changes, removes metadata and files', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'studio-delete-'))
  const store = new Store(join(dataDir, 'studio.sqlite'))
  const project = store.createProject('Delete me')
  const assetId = randomUUID()
  const { storage, objects } = memoryAssets()
  store.addAsset({ id: assetId, projectId: project.id, name: 'video.mp4', mediaType: 'video', width: 32, height: 32, bytes: 4, hash: 'test', kind: 'generated', createdAt: new Date().toISOString() })
  objects.set(`${assetId}.mp4`, Buffer.from('test'))
  objects.set(`${assetId}.webp`, Buffer.from('test'))
  const run = store.queueAgent(project.id, { requestId: randomUUID(), text: 'test', mode: 'auto', ratio: '1:1' })
  assert.throws(() => store.deleteProject(project.id, store.project(project.id).updatedAt), /停止/)
  store.updateAgent(run.id, { status: 'completed' })
  const current = store.project(project.id)
  store.db.close()
  const app = await buildApp({ dataDir, assetStorage: storage })
  try {
    assert.equal((await app.inject({ method: 'DELETE', url: `/api/projects/${project.id}`, payload: { expectedUpdatedAt: '2000-01-01T00:00:00.000Z' } })).statusCode, 409)
    const deleted = await app.inject({ method: 'DELETE', url: `/api/projects/${project.id}`, payload: { expectedUpdatedAt: current.updatedAt } })
    assert.equal(deleted.statusCode, 200)
    assert.equal(deleted.json().pendingCleanup, 0)
    assert.equal(objects.size, 0)
    assert.equal((await app.inject(`/api/projects/${project.id}`)).statusCode, 404)
    assert.equal((await app.inject(`/api/assets/${assetId}/content`)).statusCode, 404)
    assert.equal((await app.inject('/api/projects')).json().length, 0)
  } finally { await app.close(); await rm(dataDir, { recursive: true, force: true }) }
})

test('model choices persist through resend and videos support range downloads', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'studio-video-'))
  const store = new Store(join(dataDir, 'studio.sqlite'))
  const { storage, objects } = memoryAssets()
  const thumbnail = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#047d6a' } }).webp().toBuffer()
  const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(64)])
  let selected: string | undefined
  const transport: AgentTransport = {
    async health() { return { models: { images: ['azure-image2', 'qwen-image-2.1'], videos: ['minimax-h3'] } } },
    async submit(run) { selected = run.input.videoModel },
    async get(id) { return { id, status: 'completed', stage: 'video', threadId: null, reply: '视频已完成', video: { mp4: mp4.toString('base64'), thumbnail: thumbnail.toString('base64'), width: 832, height: 480, duration: 124 / 24, fps: 24, model: 'minimax-h3', provider: 'comfyui', checkpoint: 'test' } } },
    async stop() {},
  }
  const worker = new AgentWorker(store, dataDir, transport, storage)
  const project = store.createProject('Video')
  const run = store.queueAgent(project.id, { requestId: randomUUID(), text: '生成视频', mode: 'auto', ratio: '3:2', imageModel: 'qwen-image-2.1', videoModel: 'minimax-h3' })
  await worker.tick(); await worker.tick()
  assert.equal(selected, 'minimax-h3')
  assert.equal(store.asset(run.id).mediaType, 'video')
  assert.deepEqual(objects.get(`${run.id}.mp4`), mp4)
  assert.equal(store.agentRun(run.id).assetId, run.id)
  const resend = worker.resend(project.id, run.messageId, { requestId: randomUUID(), expectedTailId: store.snapshot(project.id).messages.at(-1)!.id })
  assert('input' in resend)
  assert.equal(resend.input.imageModel, 'qwen-image-2.1')
  assert.equal(resend.input.videoModel, 'minimax-h3')
  store.updateAgent(resend.id, { status: 'cancelled' })
  await worker.close()
  store.db.close()
  const app = await buildApp({ dataDir, assetStorage: storage, agent: transport })
  try {
    assert.deepEqual((await app.inject('/api/health')).json().models.videos, ['minimax-h3'])
    const url = `/api/assets/${run.id}/content`
    const content = await app.inject(url)
    assert.equal(content.headers['content-type'], 'video/mp4')
    assert.deepEqual(content.rawPayload, mp4)
    const range = await app.inject({ url, headers: { range: 'bytes=4-7' } })
    assert.equal(range.statusCode, 206)
    assert.equal(range.body, 'ftyp')
    assert.equal(range.headers['content-range'], `bytes 4-7/${mp4.length}`)
    assert.equal((await app.inject({ url, headers: { range: 'bytes=999999-' } })).statusCode, 416)
    assert.equal((await app.inject({ url, headers: { range: 'bytes=0-1,3-4' } })).statusCode, 416)
    assert.match((await app.inject(`${url}?download=1`)).headers['content-disposition']!, /\.mp4/)
    assert.equal((await app.inject(`${url}?thumbnail=1`)).headers['content-type'], 'image/webp')
    const input = { requestId: randomUUID(), text: '讨论模型', mode: 'auto', ratio: '1:1', imageModel: 'qwen-image-2.1', videoModel: 'minimax-h3' }
    const queued = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/chat`, payload: input })
    assert.equal(queued.statusCode, 202)
    assert.equal(queued.json().input.imageModel, 'qwen-image-2.1')
    assert.equal((await app.inject({ method: 'POST', url: `/api/projects/${project.id}/chat`, payload: { ...input, imageModel: 'arbitrary-model' } })).statusCode, 400)
  } finally { await app.close(); await rm(dataDir, { recursive: true, force: true }) }
})

test('managed model identity uses the model audience and rejects failed or stale tokens', async () => {
  const environment = { IDENTITY_ENDPOINT: 'http://127.0.0.1/identity', IDENTITY_HEADER: 'test-header' }
  let calls = 0
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input))
    assert.equal(url.searchParams.get('resource'), 'https://cognitiveservices.azure.com/')
    assert.equal(url.searchParams.get('api-version'), '2019-08-01')
    assert.equal(new Headers(init?.headers).get('X-IDENTITY-HEADER'), 'test-header')
    calls += 1
    return Response.json({ access_token: `test-token-${calls}`, expires_on: String(Date.now() / 1000 + 3600) })
  }
  assert.equal(await managedModelToken(environment, fetcher), 'test-token-1')
  assert.equal(await managedModelToken(environment, fetcher), 'test-token-2')
  await assert.rejects(managedModelToken({}, fetcher), /unavailable/)
  await assert.rejects(managedModelToken(environment, async () => new Response('', { status: 403 })), /HTTP 403/)
  await assert.rejects(managedModelToken(environment, async () => Response.json({ access_token: 'stale', expires_on: 0 })), /expires/)
})

test('cloud routes require application sessions and ignore platform identity headers', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'studio-cloud-'))
  const tenantId = randomUUID()
  const userId = randomUUID()
  const staticRoot = join(dataDir, 'dist')
  await mkdir(staticRoot)
  await writeFile(join(staticRoot, 'index.html'), '<!doctype html><html><body>Studio</body></html>')
  await writeFile(join(staticRoot, 'manifest.webmanifest'), JSON.stringify({ name: 'Qwen Studio' }))
  await writeFile(join(staticRoot, 'sw.js'), 'self.addEventListener("fetch", () => {})')
  const app = await buildApp({ dataDir, staticRoot, hosts: ['studio.example'], origins: ['https://studio.example'], auth: { origin: 'https://studio.example' }, journalMode: 'DELETE' })
  const principal = (tenant: string, user: string) => Buffer.from(JSON.stringify({ auth_typ: 'aad', claims: [{ typ: 'tid', val: tenant }, { typ: 'oid', val: user }] })).toString('base64')
  try {
    assert.equal((await app.inject('/healthz')).statusCode, 200)
    for (const url of ['/manifest.webmanifest', '/sw.js']) {
      const response = await app.inject({ url, headers: { host: 'studio.example' } })
      assert.equal(response.statusCode, 200)
      assert.equal(response.headers['cache-control'], 'no-store')
    }
    for (const url of ['/api/projects', '/api/health', '/api/assets/unknown/content']) {
      assert.equal((await app.inject({ url, headers: { host: 'studio.example' } })).statusCode, 401)
      assert.equal((await app.inject({ url, headers: { host: 'studio.example', 'x-ms-client-principal': principal(tenantId, randomUUID()) } })).statusCode, 401)
    }
    assert.equal((await app.inject({ url: '/api/projects', headers: { host: 'studio.example', 'x-ms-client-principal': principal(randomUUID(), userId) } })).statusCode, 401)
    const headers = await loginHeaders(app, dataDir, 'studio.example')
    for (const url of ['/', '/index.html', '/?from=login']) {
      const response = await app.inject({ url, headers })
      assert.equal(response.statusCode, 200)
      assert.match(response.headers['content-type'] ?? '', /^text\/html(?:;|$)/)
      assert(!response.headers['content-disposition']?.includes('attachment'))
      assert.match(response.body, /<!doctype html>/)
    }
    assert.equal((await app.inject({ url: '/api/projects', headers })).statusCode, 200)
    assert.equal((await app.inject({ method: 'POST', url: '/api/projects', headers: { ...headers, origin: 'https://untrusted.example' }, payload: { title: 'Denied' } })).statusCode, 403)
    assert.equal((await app.inject({ method: 'POST', url: '/api/projects', headers: { ...headers, origin: 'https://studio.example' }, payload: { title: 'Shared workspace' } })).statusCode, 201)
  } finally { await app.close(); await rm(dataDir, { recursive: true, force: true }) }
})

test('stop is not overwritten by a late completed result or polling error', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'studio-stop-'))
  const store = new Store(join(dataDir, 'test.sqlite'))
  let resolveResult!: (result: RemoteRun) => void
  let rejectResult!: (error: Error) => void
  const transport: AgentTransport = {
    async health() { return {} },
    async submit() {},
    get() { return new Promise((resolve, reject) => { resolveResult = resolve; rejectResult = reject }) },
    async stop() {},
  }
  const worker = new AgentWorker(store, dataDir, transport)
  try {
    const project = store.createProject('Stop race')
    for (const fail of [false, true]) {
      const run = store.queueAgent(project.id, { requestId: randomUUID(), text: 'Stop', mode: 'chat', ratio: '1:1' })
      await worker.tick()
      const pending = worker.tick()
      await worker.stop(run.id)
      if (fail) rejectResult(new Error('Connection lost'))
      else resolveResult({ id: run.id, threadId: randomUUID(), status: 'completed', stage: 'codex', reply: 'Late reply' })
      await pending
      assert.equal(store.agentRun(run.id).status, 'cancelled')
      assert.equal(store.agentRun(run.id).reply, '')
    }
  } finally {
    await worker.close()
    store.db.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('worker serializes turns, imports one image, stops queued work and does not retry uncertainty', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'studio-worker-'))
  await mkdir(join(dataDir, 'images'))
  const store = new Store(join(dataDir, 'test.sqlite'))
  const submitted: { id: string; thread: string | null }[] = []
  const remote = new Map<string, RemoteRun>()
  const thread = randomUUID()
  const transport: AgentTransport = {
    async health() { return {} },
    async submit(run, threadId) {
      submitted.push({ id: run.id, thread: threadId })
      remote.set(run.id, { id: run.id, threadId: thread, status: 'running', stage: 'codex', reply: '' })
    },
    async get(id) { const result = remote.get(id); if (!result) throw new Error('Unreachable'); return result },
    async stop(id) { remote.get(id)!.status = 'cancelled' },
  }
  const { objects, storage } = memoryAssets()
  const worker = new AgentWorker(store, dataDir, transport, storage)
  try {
    const project = store.createProject('Worker')
    const input = { requestId: randomUUID(), text: 'Test', mode: 'image' as const, ratio: '1:1' as const }
    const first = store.queueAgent(project.id, input)
    const second = store.queueAgent(project.id, { ...input, requestId: randomUUID(), mode: 'chat' })
    const cancelled = store.queueAgent(project.id, { ...input, requestId: randomUUID() })
    await worker.stop(cancelled.id)
    await Promise.all([worker.tick(), worker.tick()])
    assert.equal(submitted.length, 1)
    await worker.tick()
    assert.equal(submitted.length, 1)
    const progress = Array.from({ length: 205 }, (_, index) => ({ id: `codex:${index}`, label: 'item.updated', detail: JSON.stringify({ type: 'item.updated', item: { id: 'same-item', type: 'reasoning', text: `${index}: ${'原始内容'.repeat(1600)}` } }), createdAt: new Date().toISOString() }))
    remote.get(first.id)!.progress = progress
    await worker.tick()
    assert.deepEqual(store.agentRun(first.id).progress, progress)
    assert.equal(store.agentRun(first.id).reply, '')
    const reopened = new Store(join(dataDir, 'test.sqlite'))
    assert.deepEqual(reopened.agentRun(first.id).progress, progress)
    reopened.db.close()
    const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#087f6b' } }).png().toBuffer()
    remote.set(first.id, { id: first.id, threadId: thread, status: 'completed', stage: 'image', reply: 'Test fixture response',
      image: { png: png.toString('base64'), width: 64, height: 64, model: 'test-image', checkpoint: 'test' } })
    await worker.tick()
    assert.equal(store.snapshot(project.id).assets.length, 1)
    assert.equal(store.snapshot(project.id).assets[0].kind, 'generated')
    assert.equal(store.agentRun(first.id).assetId, first.id)
    assert.deepEqual(objects.get(`${first.id}.png`), png)
    assert.equal((await sharp(objects.get(`${first.id}.webp`)).metadata()).format, 'webp')
    assert.deepEqual(await readdir(join(dataDir, 'images')), [])
    await worker.tick()
    assert.equal(submitted[1].thread, thread)
    remote.delete(second.id)
    await worker.tick()
    assert.equal(store.agentRun(second.id).status, 'interrupted')
    await worker.tick()
    assert.equal(submitted.length, 2)
    assert.equal(store.agentRun(cancelled.id).status, 'cancelled')
    assert.equal(store.snapshot(project.id).assets.length, 1)
  } finally {
    await worker.close()
    store.db.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('editing transfers only the Codex-selected retained image and checks lineage', async () => {
  const store = new Store(':memory:')
  const { storage, objects } = memoryAssets()
  const original = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#ffffff' } }).png().toBuffer()
  const edited = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#ff0000' } }).png().toBuffer()
  const sourceHash = createHash('sha256').update(original).digest('hex')
  const submissions: ImageCandidate[][] = []
  const sources: SourceImage[] = []
  const remote = new Map<string, RemoteRun>()
  const threadId = randomUUID()
  const transport: AgentTransport = {
    async health() { return {} },
    async submit(run, _thread, _history, candidates = []) {
      submissions.push(candidates)
      if (run.input.text === 'Generate') remote.set(run.id, { id: run.id, status: 'completed', stage: 'image', threadId, reply: 'Done', imageOperation: 'generate', image: { png: original.toString('base64'), width: 64, height: 64, model: 'test', checkpoint: 'test', operation: 'generate' } })
      else remote.set(run.id, { id: run.id, status: 'running', stage: 'codex', threadId, reply: 'Edit the first image', imageOperation: 'edit', needsSource: true, sourceAssetId: candidates[0].assetId })
    },
    async provideSource(id, source) {
      sources.push(source)
      remote.set(id, { id, status: 'completed', stage: 'image', threadId, reply: 'Done', imageOperation: 'edit', image: { png: edited.toString('base64'), width: 64, height: 64, model: 'test', checkpoint: 'test', operation: 'edit', sourceAssetId: source.assetId, sourceHash: source.hash } })
    },
    async get(id) { return remote.get(id)! },
    async stop() {},
  }
  const worker = new AgentWorker(store, '', transport, storage)
  try {
    const project = store.createProject('Edit original')
    const send = (text: string) => store.queueAgent(project.id, { requestId: randomUUID(), text, mode: 'auto', ratio: '1:1' })
    const first = send('Generate')
    await worker.tick(); await worker.tick()
    assert.deepEqual(submissions[0], [])
    const second = send('Generate')
    await worker.tick(); await worker.tick()
    assert.equal(sources.length, 0)
    const edit = send('Make it red')
    const future = send('Later image')
    store.addAsset({ ...store.asset(first.id), id: future.id, runId: future.id })
    store.updateAgent(future.id, { status: 'completed', reply: 'Later', assetId: future.id })
    await worker.tick()
    assert.deepEqual(submissions[2].map(candidate => candidate.assetId), [first.id, second.id])
    assert.equal(store.agentRun(edit.id).sourceAssetId, undefined)
    await worker.tick(); await worker.tick()
    assert.equal(sources[0].assetId, first.id)
    assert.equal(sources[0].hash, sourceHash)
    assert.deepEqual(Buffer.from(sources[0].png, 'base64'), original)
    assert.equal(store.agentRun(edit.id).imageOperation, 'edit')
    assert.equal(store.asset(edit.id).sourceAssetId, first.id)
    assert.equal(store.asset(edit.id).sourceHash, sourceHash)
    assert.deepEqual(objects.get(`${first.id}.png`), original)
    assert.deepEqual(objects.get(`${edit.id}.png`), edited)
    const retry = worker.resend(project.id, edit.messageId, { requestId: randomUUID(), expectedTailId: store.snapshot(project.id).messages.at(-1)!.id })
    await worker.tick()
    assert.deepEqual(submissions[3].map(candidate => candidate.assetId), [first.id, second.id])
    await worker.tick()
    remote.get(retry.id)!.image!.sourceAssetId = future.id
    await worker.tick()
    assert.equal(store.agentRun(retry.id).status, 'interrupted')
    assert.equal(objects.has(`${retry.id}.png`), false)
    assert.equal(store.snapshot(project.id).assets.length, 4)
  } finally { await worker.close(); store.db.close() }
})

test('Codex can select either uploaded image while unselected, foreign and non-image sources are refused', async () => {
  const store = new Store(':memory:')
  const { storage, objects } = memoryAssets()
  const project = store.createProject('Uploaded originals')
  const other = store.createProject('Other project')
  const png = await sharp({ create: { width: 64, height: 32, channels: 3, background: '#0088aa' } }).png().toBuffer()
  const bytes = Buffer.concat([png, Buffer.alloc(38_823_614 - png.length)])
  const original = { projectId: project.id, name: 'upload.png', kind: 'reference' as const, mediaType: 'image' as const, width: 64, height: 32, bytes: bytes.length, hash: createHash('sha256').update(bytes).digest('hex'), createdAt: new Date().toISOString() }
  const first = store.addAsset({ ...original, id: randomUUID() })
  const second = store.addAsset({ ...original, id: randomUUID(), name: 'second.png' })
  const unselected = store.addAsset({ ...original, id: randomUUID() })
  const foreign = store.addAsset({ ...original, id: randomUUID(), projectId: other.id })
  const document = store.addAsset({ ...original, id: randomUUID(), mediaType: 'file', storageExtension: 'bin', name: 'text.txt' })
  objects.set(`${first.id}.png`, bytes)
  objects.set(`${second.id}.png`, bytes)
  let selected = first.id
  let current: RemoteRun
  let deliveries = 0
  const worker = new AgentWorker(store, '', {
    async health() { return {} }, async stop() {}, async get() { return current },
    async submit(run, _thread, _history, candidates) {
      assert.deepEqual(candidates?.map(candidate => candidate.assetId), [first.id, second.id])
      assert(!JSON.stringify(candidates).includes('"png":'))
      current = { id: run.id, status: 'running', stage: 'codex', threadId: null, reply: 'Selected', imageOperation: 'edit', sourceAssetId: selected, needsSource: true }
    },
    async provideSource(id, source) {
      deliveries++
      assert.equal(source.assetId, selected)
      assert.deepEqual(Buffer.from(source.png, 'base64'), bytes)
      current = { id, status: 'completed', stage: 'codex', threadId: null, reply: 'Source verified' }
    },
  }, storage)
  try {
    for (const sourceId of [first.id, second.id, unselected.id, foreign.id, document.id]) {
      selected = sourceId
      const run = store.queueAgent(project.id, { requestId: randomUUID(), text: 'Edit the specified upload', mode: 'auto', ratio: '1:1', assetIds: [first.id, second.id, document.id] })
      await worker.tick()
      assert.equal(store.agentRun(run.id).sourceAssetId, undefined)
      await worker.tick()
      if ([first.id, second.id].includes(sourceId)) {
        await worker.tick()
        assert.equal(store.agentRun(run.id).status, 'completed')
        assert.equal(store.agentRun(run.id).sourceAssetId, sourceId)
      } else assert.equal(store.agentRun(run.id).status, 'interrupted')
    }
    assert.equal(deliveries, 2)
    assert.deepEqual(objects.get(`${first.id}.png`), bytes)
    assert.deepEqual(objects.get(`${second.id}.png`), bytes)
  } finally { await worker.close(); store.db.close() }
})

test('processed images persist in chat and are selectable as the exact edit source', async () => {
  const store = new Store(':memory:')
  const { storage, objects } = memoryAssets()
  const project = store.createProject('Processing')
  const original = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#16785d' } }).png().toBuffer()
  const processed = await sharp(original).resize(32, 32).png().toBuffer()
  const source = store.addAsset({ id: randomUUID(), projectId: project.id, name: 'photo.png', width: 64, height: 64, bytes: original.length, hash: createHash('sha256').update(original).digest('hex'), kind: 'reference', createdAt: new Date().toISOString() })
  objects.set(`${source.id}.png`, original)
  const result = { assetId: randomUUID(), sourceAssetId: source.id, sourceHash: source.hash, hash: createHash('sha256').update(processed).digest('hex'), width: 32, height: 32, bytes: processed.length, name: 'processed.png', png: processed.toString('base64') }
  let current: RemoteRun
  const deliveries: SourceImage[] = []
  const worker = new AgentWorker(store, '', {
    async health() { return {} }, async stop() {}, async get() { return current },
    async submit(run) { current = { id: run.id, threadId: null, status: run.input.mode === 'chat' ? 'completed' : 'running', stage: 'codex', reply: 'Processed', processedImages: [result], ...(run.input.mode === 'chat' ? {} : { imageOperation: 'edit', sourceAssetId: result.assetId, needsSource: true }) } },
    async provideSource(_id, image) { deliveries.push(image); current = { ...current, status: 'completed', needsSource: false, stage: 'image', image: { png: result.png, width: 32, height: 32, model: 'test', checkpoint: 'test', operation: 'edit', sourceAssetId: image.assetId, sourceHash: image.hash } } },
  }, storage)
  try {
    const chat = store.queueAgent(project.id, { requestId: randomUUID(), text: 'Crop', mode: 'chat', ratio: '1:1', assetIds: [source.id] })
    await worker.tick(); await worker.tick()
    assert.equal(store.agentRun(chat.id).status, 'completed')
    assert.equal(deliveries.length, 0)
    assert.deepEqual(store.snapshot(project.id).messages.find(message => message.id === chat.assistantId)?.assetIds, [result.assetId])
    const firstProcessedId = result.assetId
    result.assetId = randomUUID()
    const edit = store.queueAgent(project.id, { requestId: randomUUID(), text: 'Crop and edit', mode: 'auto', ratio: '1:1', assetIds: [source.id] })
    await worker.tick(); await worker.tick()
    assert.equal(deliveries[0].assetId, result.assetId)
    assert.equal(deliveries[0].png, result.png)
    await worker.tick()
    assert.equal(store.agentRun(edit.id).status, 'completed')
    assert.equal(store.asset(edit.id).sourceAssetId, result.assetId)
    assert.equal(store.asset(result.assetId).sourceAssetId, source.id)
    assert.equal(store.asset(firstProcessedId).runId, chat.id)
    assert.equal(store.snapshot(project.id).assets.length, 4)
    assert.deepEqual(store.snapshot(project.id).messages.find(message => message.id === edit.assistantId)?.assetIds, [result.assetId, edit.id])
    assert.deepEqual(objects.get(`${source.id}.png`), original)
  } finally { await worker.close(); store.db.close() }
})

test('invalid processed outputs cannot overwrite originals or import unselected sources', async () => {
  const store = new Store(':memory:')
  const { storage, objects } = memoryAssets()
  const project = store.createProject('Processing validation')
  const bytes = await sharp({ create: { width: 64, height: 32, channels: 3, background: '#0088aa' } }).png().toBuffer()
  const source = store.addAsset({ id: randomUUID(), projectId: project.id, name: 'photo.png', width: 64, height: 32, bytes: bytes.length, hash: createHash('sha256').update(bytes).digest('hex'), kind: 'reference', createdAt: new Date().toISOString() })
  const unselected = store.addAsset({ ...source, id: randomUUID() })
  objects.set(`${source.id}.png`, bytes)
  let result: NonNullable<RemoteRun['processedImages']>[number] = { assetId: randomUUID(), sourceAssetId: source.id, sourceHash: source.hash, hash: source.hash, width: 64, height: 32, bytes: bytes.length, name: 'processed.png', png: bytes.toString('base64') }
  const valid = { ...result }
  let current: RemoteRun
  const worker = new AgentWorker(store, '', {
    async health() { return {} }, async stop() {}, async get() { return current },
    async submit(run) { current = { id: run.id, threadId: null, status: 'completed', stage: 'codex', reply: 'Processed', processedImages: [result] } },
  }, storage)
  try {
    for (const invalid of [{ assetId: source.id }, { sourceAssetId: unselected.id }, { hash: '0'.repeat(64) }, { width: 32 }]) {
      result = { ...valid, ...invalid }
      const run = store.queueAgent(project.id, { requestId: randomUUID(), text: 'Process', mode: 'chat', ratio: '1:1', assetIds: [source.id] })
      await worker.tick(); await worker.tick()
      assert.equal(store.agentRun(run.id).status, 'interrupted')
      assert.equal(store.snapshot(project.id).assets.length, 2)
      assert.deepEqual(objects.get(`${source.id}.png`), bytes)
    }
  } finally { await worker.close(); store.db.close() }
})

test('oversized Azure edit source is explicitly rejected without delivering or reading bytes', async () => {
  const store = new Store(':memory:')
  const { storage } = memoryAssets()
  const reads: string[] = []
  storage.read = async name => { reads.push(name); throw new Error('Must not read') }
  const project = store.createProject('Oversize')
  const source = store.addAsset({ id: randomUUID(), projectId: project.id, name: 'large.png', width: 4284, height: 5712, bytes: 50_000_000, hash: '0'.repeat(64), kind: 'reference', createdAt: new Date().toISOString() })
  let current: RemoteRun
  let stopped = 0
  const worker = new AgentWorker(store, '', {
    async health() { return {} }, async stop() { stopped++ }, async get() { return current }, async provideSource() { assert.fail('Must not deliver') },
    async submit(run) { current = { id: run.id, threadId: null, status: 'running', stage: 'image', reply: 'Edit', imageOperation: 'edit', sourceAssetId: source.id, needsSource: true } },
  }, storage)
  try {
    const run = store.queueAgent(project.id, { requestId: randomUUID(), text: 'Edit', mode: 'auto', ratio: '1:1', assetIds: [source.id] })
    await worker.tick(); await worker.tick()
    assert.equal(store.agentRun(run.id).status, 'failed')
    assert.match(store.agentRun(run.id).error!, /50 MB/)
    assert.equal(stopped, 1)
    assert.deepEqual(reads, [])
  } finally { await worker.close(); store.db.close() }
})

test('agent queue persists sessions, deduplicates and marks uncertain runs', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'studio-agent-'))
  let store = new Store(join(dataDir, 'test.sqlite'))
  try {
    const project = store.createProject('Codex')
    const input = { requestId: randomUUID(), text: 'Hello', mode: 'chat' as const, ratio: '1:1' as const }
    const first = store.queueAgent(project.id, input)
    assert.equal(store.queueAgent(project.id, input).id, first.id)
    assert.throws(() => store.queueAgent(project.id, { ...input, text: 'Changed' }))
    const threadId = randomUUID()
    store.updateAgent(first.id, { status: 'running', threadId, reply: 'Real response' })
    store.db.close()
    store = new Store(join(dataDir, 'test.sqlite'))
    store.recoverAgentRuns()
    assert.equal(store.threadId(project.id), threadId)
    assert.equal(store.agentRun(first.id).status, 'interrupted')
    assert.equal(store.snapshot(project.id).messages[1].role, 'assistant')
    assert.equal(store.snapshot(project.id).messages.length, 2)
    assert.equal(store.nextAgentRun(), null)
  } finally {
    store.db.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('resend truncates atomically, resets context, deduplicates and refuses active or stale requests', async () => {
  const store = new Store(':memory:')
  let submittedHistory: unknown
  let submittedThread: unknown
  let remoteStatus: RemoteRun['status'] = 'running'
  const transport: AgentTransport = {
    async health() { return {} },
    async submit(_run, thread, history) { submittedThread = thread; submittedHistory = history },
    async get(id) { return { id, threadId: randomUUID(), status: remoteStatus, stage: 'codex', reply: 'Late reply' } },
    async stop() {},
  }
  const worker = new AgentWorker(store, '', transport)
  try {
    const project = store.createProject('Resend')
    const send = (text: string) => store.queueAgent(project.id, { requestId: randomUUID(), text, mode: 'auto', ratio: '2:3' })
    const first = send('Remember this')
    store.updateAgent(first.id, { status: 'completed', reply: 'Retained reply', threadId: randomUUID() })
    const target = send('Retry this')
    store.updateAgent(target.id, { status: 'failed', error: 'Codex home missing' })
    const later = send('Discard this')
    store.updateAgent(later.id, { status: 'completed', reply: 'Discard reply' })
    const before = store.snapshot(project.id)
    const request = { requestId: randomUUID(), expectedTailId: before.messages.at(-1)!.id }
    assert.throws(() => worker.resend(project.id, target.messageId, { ...request, expectedTailId: first.messageId }), /对话已更新/)
    assert.throws(() => worker.resend(project.id, first.assistantId, request), /自己的消息/)
    assert.throws(() => worker.resend(store.createProject('Other').id, target.messageId, request), /自己的消息/)
    store.updateAgent(later.id, { status: 'running' })
    assert.throws(() => worker.resend(project.id, target.messageId, request), /停止/)
    store.updateAgent(later.id, { status: 'completed' })
    const resent = worker.resend(project.id, target.messageId, request)
    assert.equal(worker.resend(project.id, target.messageId, request).id, resent.id)
    const after = store.snapshot(project.id)
    assert.deepEqual(after.messages.map(message => message.text), ['Remember this', 'Retained reply', 'Retry this'])
    assert.equal(after.runs.length, 2)
    assert.equal(after.threadId, null)
    assert.equal(after.runs[1].input.ratio, '2:3')
    await worker.tick()
    assert.equal(submittedThread, null)
    assert.deepEqual(submittedHistory, [{ role: 'user', text: 'Remember this' }, { role: 'assistant', text: 'Retained reply' }])
    await worker.stop(resent.id)
    const retryRequest = { requestId: randomUUID(), expectedTailId: target.messageId }
    assert.throws(() => worker.resend(project.id, target.messageId, retryRequest), /停止/)
    await worker.tick()
    assert.throws(() => worker.resend(project.id, target.messageId, retryRequest), /停止/)
    remoteStatus = 'cancelled'
    await worker.tick()
    worker.resend(project.id, target.messageId, retryRequest)
    assert.throws(() => worker.resend(project.id, target.messageId, request), /替代/)
    assert.equal(store.threadId(project.id), null)
    assert.equal(store.snapshot(project.id).messages.length, 3)
  } finally { await worker.close(); store.db.close() }
})

test('resend API retains selected message and assets, removes later jobs, and persists after restart', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'studio-resend-'))
  let app = await buildApp({ dataDir })
  try {
    const project = (await app.inject({ method: 'POST', url: '/api/projects', payload: { title: 'Resend' } })).json()
    for (const text of ['Keep', 'Selected', 'Remove']) await app.inject({ method: 'POST', url: `/api/projects/${project.id}/messages`, payload: { requestId: randomUUID(), text, assetIds: [], ratio: '4:3' } })
    const before = (await app.inject(`/api/projects/${project.id}`)).json()
    const url = `/api/projects/${project.id}/messages/${before.messages[1].id}/resend`
    const payload = { requestId: randomUUID(), expectedTailId: before.messages[2].id }
    assert.equal((await app.inject({ method: 'POST', url, payload, headers: { origin: 'https://untrusted.example' } })).statusCode, 403)
    assert.equal((await app.inject({ method: 'POST', url, payload: { ...payload, expectedTailId: randomUUID() } })).statusCode, 409)
    const response = await app.inject({ method: 'POST', url, payload })
    assert.equal(response.statusCode, 202)
    assert.equal(response.json().ratio, '4:3')
    await app.close()
    app = await buildApp({ dataDir })
    assert.equal((await app.inject({ method: 'POST', url, payload })).json().id, response.json().id)
    const after = (await app.inject(`/api/projects/${project.id}`)).json()
    assert.deepEqual(after.messages, before.messages.slice(0, 2))
    assert.equal(after.jobs.length, 2)
    assert.deepEqual(after.assets, before.assets)
  } finally { await app.close(); await rm(dataDir, { recursive: true, force: true }) }
})

test('project, idempotent message, cancellation and restart persistence', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'studio-'))
  let app = await buildApp({ dataDir })
  try {
    const project = (await app.inject({ method: 'POST', url: '/api/projects', payload: { title: 'Research' } })).json()
    const url = `/api/projects/${project.id}/messages`
    const payload = { requestId: randomUUID(), text: 'A still life', assetIds: [], ratio: '1:1' }
    const first = await app.inject({ method: 'POST', url, payload })
    assert.equal(first.statusCode, 202)
    assert.equal(first.json().status, 'waiting_service')
    const repeat = await app.inject({ method: 'POST', url, payload })
    assert.equal(first.json().id, repeat.json().id)
    assert.equal((await app.inject({ method: 'POST', url, payload: { ...payload, text: 'Changed' } })).statusCode, 409)
    assert.equal((await app.inject({ method: 'POST', url, payload: { ...payload, requestId: randomUUID(), text: '   ' } })).statusCode, 400)
    await app.inject({ method: 'POST', url: `/api/jobs/${first.json().id}/cancel` })
    await app.close()
    app = await buildApp({ dataDir })
    const snapshot = (await app.inject(`/api/projects/${project.id}`)).json()
    assert.equal(snapshot.messages.length, 1)
    assert.equal(snapshot.jobs.length, 1)
    assert.equal(snapshot.jobs[0].status, 'cancelled')
    assert.equal(snapshot.assets.length, 0)
    assert.equal((await app.inject({ method: 'POST', url, payload })).json().status, 'cancelled')
    assert.equal((await app.inject({ method: 'POST', url: '/api/projects', headers: { origin: 'https://untrusted.example' }, payload: { title: 'No' } })).statusCode, 403)
    assert.equal((await app.inject({ url: '/api/projects', headers: { host: 'attacker.example' } })).statusCode, 403)
  } finally {
    await app.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('file uploads preserve bytes, force document downloads and support video ranges', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'studio-files-'))
  const { objects, storage } = memoryAssets()
  const app = await buildApp({ dataDir, assetStorage: storage })
  try {
    const project = (await app.inject({ method: 'POST', url: '/api/projects', payload: { title: 'Files' } })).json()
    const samples = [
      { name: 'notes.txt', bytes: Buffer.from('private notes, not prompt content'), kind: 'file', mime: 'text/plain' },
      { name: 'page.html', bytes: Buffer.from('<script>alert(1)</script>'), kind: 'file', mime: 'text/plain' },
      { name: 'clip.mp4', bytes: Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(20)]), kind: 'video', mime: 'video/mp4' },
    ]
    for (const sample of samples) {
      const response = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/uploads`, headers: { 'content-type': 'multipart/form-data; boundary=studio' }, payload: Buffer.concat([Buffer.from(`--studio\r\nContent-Disposition: form-data; name="file"; filename="${sample.name}"\r\nContent-Type: application/octet-stream\r\n\r\n`), sample.bytes, Buffer.from('\r\n--studio--\r\n')]) })
      assert.equal(response.statusCode, 201, response.body)
      const asset = response.json()
      assert.equal(asset.mediaType, sample.kind)
      assert.equal(asset.mimeType, sample.mime)
      assert.equal(asset.hasThumbnail, false)
      const url = `/api/assets/${asset.id}/content`
      const content = await app.inject(url)
      assert.deepEqual(content.rawPayload, sample.bytes)
      assert.equal((await app.inject(`${url}?thumbnail=1`)).statusCode, 404)
      assert.equal(content.headers['x-content-type-options'], 'nosniff')
      if (sample.kind === 'file') {
        assert.match(content.headers['content-disposition']!, /attachment/)
        assert.equal(content.headers['content-type'], 'application/octet-stream')
        assert.match(content.headers['content-security-policy']!, /sandbox/)
      } else {
        const range = await app.inject({ url, headers: { range: 'bytes=4-7' } })
        assert.equal(range.statusCode, 206)
        assert.equal(range.body, 'ftyp')
      }
    }
    assert.equal(objects.size, samples.length)
    const snapshot = (await app.inject(`/api/projects/${project.id}`)).json()
    assert.equal(snapshot.assets.length, samples.length)
    const removed = await app.inject({ method: 'DELETE', url: `/api/projects/${project.id}`, payload: { expectedUpdatedAt: snapshot.project.updatedAt } })
    assert.equal(removed.statusCode, 200)
    assert.equal(objects.size, 0)
  } finally { await app.close(); await rm(dataDir, { recursive: true, force: true }) }
})

test('uploads validate actual image data, thumbnails and project ownership', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'studio-'))
  const { objects, storage } = memoryAssets()
  const app = await buildApp({ dataDir, assetStorage: storage })
  try {
    const project = (await app.inject({ method: 'POST', url: '/api/projects', payload: { title: 'Images' } })).json()
    const other = (await app.inject({ method: 'POST', url: '/api/projects', payload: { title: 'Other' } })).json()
    const upload = async (content: Buffer) => app.inject({
      method: 'POST', url: `/api/projects/${project.id}/uploads`,
      headers: { 'content-type': 'multipart/form-data; boundary=studio' },
      payload: Buffer.concat([Buffer.from('--studio\r\nContent-Disposition: form-data; name="file"; filename="reference.png"\r\nContent-Type: image/png\r\n\r\n'), content, Buffer.from('\r\n--studio--\r\n')]),
    })
    assert.equal((await upload(Buffer.from('not an image'))).statusCode, 400)
    const image = await sharp({ create: { width: 64, height: 32, channels: 4, background: '#007c68' } }).png().toBuffer()
    const response = await upload(image)
    assert.equal(response.statusCode, 201)
    const asset = response.json()
    assert.equal(asset.width, 64)
    assert.equal(asset.height, 32)
    assert.equal(asset.kind, 'reference')
    assert.equal(objects.size, 2)
    assert.deepEqual(await readdir(join(dataDir, 'images')), [])
    const thumbnail = await app.inject(`/api/assets/${asset.id}/content?thumbnail=1`)
    assert.equal((await sharp(thumbnail.rawPayload).metadata()).format, 'webp')
    const original = await app.inject(`/api/assets/${asset.id}/content?download=1`)
    assert.match(original.headers['content-disposition'] as string, /attachment/)
    assert.equal((await sharp(original.rawPayload).metadata()).hasAlpha, true)
    assert.equal(original.headers['cache-control'], 'no-store')
    const payload = { requestId: randomUUID(), text: 'Reference', assetIds: [asset.id], ratio: '3:4' }
    assert.equal((await app.inject({ method: 'POST', url: `/api/projects/${other.id}/messages`, payload })).statusCode, 400)
    assert.equal((await app.inject({ method: 'POST', url: `/api/projects/${project.id}/messages`, payload })).statusCode, 202)
    assert.equal((await app.inject(`/api/projects/${other.id}`)).json().messages.length, 0)
    const failure = await buildApp({ dataDir: join(dataDir, 'failure'), assetStorage: {
      ...storage,
      async put(name, bytes) { if (name.endsWith('.webp')) throw new Error('Storage unavailable'); await storage.put(name, bytes) },
    } })
    try {
      const failedProject = (await failure.inject({ method: 'POST', url: '/api/projects', payload: { title: 'Failure' } })).json()
      const failedUpload = await failure.inject({ method: 'POST', url: `/api/projects/${failedProject.id}/uploads`, headers: { 'content-type': 'multipart/form-data; boundary=studio' }, payload: Buffer.concat([Buffer.from('--studio\r\nContent-Disposition: form-data; name="file"; filename="reference.png"\r\nContent-Type: image/png\r\n\r\n'), image, Buffer.from('\r\n--studio--\r\n')]) })
      assert.equal(failedUpload.statusCode, 500)
      assert.equal(objects.size, 2)
      assert.equal((await failure.inject(`/api/projects/${failedProject.id}`)).json().assets.length, 0)
    } finally { await failure.close() }
  } finally {
    await app.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})