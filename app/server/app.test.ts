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
import type { AgentTransport, RemoteRun, SourceImage } from './agent.ts'
import type { AssetStorage } from './assets.ts'

function memoryAssets() {
  const objects = new Map<string, Buffer>()
  const storage: AssetStorage = {
    async put(name, bytes) { objects.set(name, bytes) },
    async read(name) { const bytes = objects.get(name); if (!bytes) throw new Error('Missing object'); return bytes },
    async remove(name) { objects.delete(name) },
  }
  return { objects, storage }
}

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

test('cloud routes require a tenant-matched assigned Entra identity except health', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'studio-cloud-'))
  const tenantId = randomUUID()
  const userId = randomUUID()
  const staticRoot = join(dataDir, 'dist')
  await mkdir(staticRoot)
  await writeFile(join(staticRoot, 'index.html'), '<!doctype html><html><body>Studio</body></html>')
  await writeFile(join(staticRoot, 'manifest.webmanifest'), JSON.stringify({ name: 'Qwen Studio' }))
  await writeFile(join(staticRoot, 'sw.js'), 'self.addEventListener("fetch", () => {})')
  const app = await buildApp({ dataDir, staticRoot, hosts: ['studio.example'], origins: ['https://studio.example'], entra: { tenantId, userIds: [userId] }, journalMode: 'DELETE' })
  const principal = (tenant: string, user: string) => Buffer.from(JSON.stringify({ auth_typ: 'aad', claims: [{ typ: 'tid', val: tenant }, { typ: 'oid', val: user }] })).toString('base64')
  try {
    assert.equal((await app.inject('/healthz')).statusCode, 200)
    for (const url of ['/manifest.webmanifest', '/sw.js']) {
      const response = await app.inject({ url, headers: { host: 'studio.example' } })
      assert.equal(response.statusCode, 200)
      assert.equal(response.headers['cache-control'], 'no-store')
    }
    for (const url of ['/', '/index.html', '/api/projects', '/api/health', '/api/assets/unknown/content']) {
      assert.equal((await app.inject({ url, headers: { host: 'studio.example' } })).statusCode, 401)
      assert.equal((await app.inject({ url, headers: { host: 'studio.example', 'x-ms-client-principal': principal(tenantId, randomUUID()) } })).statusCode, 403)
    }
    assert.equal((await app.inject({ url: '/api/projects', headers: { host: 'studio.example', 'x-ms-client-principal': principal(randomUUID(), userId) } })).statusCode, 403)
    const headers = { host: 'studio.example', 'x-ms-client-principal': principal(tenantId, userId) }
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
    const progress = [{ id: 'reasoning:1', label: 'Codex 推理摘要', detail: '测试用公开摘要', createdAt: new Date().toISOString() }]
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

test('editing reads the retained prior original from storage, preserves it and checks lineage', async () => {
  const store = new Store(':memory:')
  const { storage, objects } = memoryAssets()
  const original = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#ffffff' } }).png().toBuffer()
  const edited = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#ff0000' } }).png().toBuffer()
  const sourceHash = createHash('sha256').update(original).digest('hex')
  const submissions: (SourceImage | undefined)[] = []
  const remote = new Map<string, RemoteRun>()
  const threadId = randomUUID()
  const transport: AgentTransport = {
    async health() { return {} },
    async submit(run, _thread, _history, source) {
      submissions.push(source)
      remote.set(run.id, { id: run.id, status: 'completed', stage: 'image', threadId, reply: 'Done', imageOperation: source ? 'edit' : 'generate',
        image: { png: (source ? edited : original).toString('base64'), width: 64, height: 64, model: 'test', checkpoint: 'test', operation: source ? 'edit' : 'generate',
          ...(source ? { sourceAssetId: source.assetId, sourceHash: source.hash } : {}) } })
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
    assert.equal(submissions[0], undefined)
    const edit = send('Make it red')
    const future = send('Later image')
    store.addAsset({ ...store.asset(first.id), id: future.id, runId: future.id })
    store.updateAgent(future.id, { status: 'completed', reply: 'Later', assetId: future.id })
    await worker.tick(); await worker.tick()
    assert.equal(submissions[1]?.assetId, first.id)
    assert.equal(submissions[1]?.hash, sourceHash)
    assert.deepEqual(Buffer.from(submissions[1]!.png, 'base64'), original)
    assert.equal(store.agentRun(edit.id).imageOperation, 'edit')
    assert.equal(store.asset(edit.id).sourceAssetId, first.id)
    assert.equal(store.asset(edit.id).sourceHash, sourceHash)
    assert.deepEqual(objects.get(`${first.id}.png`), original)
    assert.deepEqual(objects.get(`${edit.id}.png`), edited)
    const retry = worker.resend(project.id, edit.messageId, { requestId: randomUUID(), expectedTailId: store.snapshot(project.id).messages.at(-1)!.id })
    await worker.tick()
    assert.equal(submissions[2]?.assetId, first.id)
    remote.get(retry.id)!.image!.sourceAssetId = future.id
    await worker.tick()
    assert.equal(store.agentRun(retry.id).status, 'interrupted')
    assert.equal(objects.has(`${retry.id}.png`), false)
    assert.equal(store.snapshot(project.id).assets.length, 3)
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