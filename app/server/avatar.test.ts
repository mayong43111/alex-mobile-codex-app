import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { avatarInputSchema, AvatarSubmissionRejected, createAvatarProvider } from './avatar-provider.ts'
import { AvatarJobs, inspectAvatar } from './avatar.ts'
import { Store } from './store.ts'
import { buildApp } from './app.ts'
import { provisionLocalUser } from './auth.ts'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('queued avatar status accepts empty outputs and zero duration', async () => {
  const provider = createAvatarProvider('https://speech.cognitiveservices.azure.com', async () => ({}), async () => Response.json({ status: 'NotStarted', outputs: {}, properties: { durationInMilliseconds: 0 } }))
  assert.equal((await provider.status(randomUUID())).status, 'NotStarted')
})

test('definitively rejected avatar submission fails without retry and expired jobs stop polling', async () => {
  const store = new Store(':memory:')
  const project = store.createProject('Rejected avatar')
  let calls = 0
  const provider = createAvatarProvider('https://speech.cognitiveservices.azure.com', async () => ({}), async () => { calls++; return new Response(null, { status: 403 }) })
  const jobs = new AvatarJobs(store, { put: async () => {}, read: async () => Buffer.alloc(0), remove: async () => {} }, provider)
  try {
    const input = avatarInputSchema.parse({ requestId: randomUUID(), text: ' Hello ', voice: 'zh-CN-XiaoxiaoNeural', character: 'lisa', style: 'casual-sitting' })
    assert.equal(input.text, ' Hello ')
    assert.throws(() => avatarInputSchema.parse({ ...input, text: '   ' }))
    const job = jobs.submit(project.id, input)
    await jobs.close()
    assert.equal(jobs.list(project.id)[0].status, 'failed')
    assert.equal(calls, 1)
    store.db.prepare('UPDATE avatar_jobs SET data = ? WHERE id = ?').run(JSON.stringify({ ...job, status: 'running', createdAt: '2020-01-01T00:00:00Z' }), job.id)
    await jobs.tick()
    await jobs.tick()
    assert.equal(calls, 1)
    assert.equal(jobs.list(project.id)[0].status, 'unknown')
    assert.match(jobs.list(project.id)[0].error!, /24 小时/)
    const unauthorized = createAvatarProvider('https://speech.cognitiveservices.azure.com', async () => { throw new Error('Token unavailable') }, async () => { throw new Error('Must not send') })
    await assert.rejects(unauthorized.submit(randomUUID(), input), AvatarSubmissionRejected)
  } finally { await jobs.close(); store.db.close() }
})

test('avatar API requires login, CSRF, ownership and explicit paid-generation confirmation', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'avatar-api-'))
  const origin = 'https://studio.example'
  let calls = 0
  const app = await buildApp({ dataDir, auth: { origin }, origins: [origin], avatar: { submit: async () => { calls++ }, status: async () => ({ status: 'Running' }), download: async () => Buffer.alloc(0) } })
  const store = new Store(join(dataDir, 'studio.sqlite'))
  try {
    const owner = await provisionLocalUser(store.db, 'avatar-owner', 'long-avatar-password', 'Owner')
    await provisionLocalUser(store.db, 'avatar-other', 'long-avatar-password', 'Other')
    const project = store.createProject('Private avatar', owner)
    const payload = { requestId: randomUUID(), text: 'Literal script', voice: 'zh-CN-XiaoxiaoNeural', character: 'lisa', style: 'casual-sitting', confirmed: true }
    const url = `/api/projects/${project.id}/avatar-jobs`
    assert.equal((await app.inject(url)).statusCode, 401)
    for (const username of ['avatar-other', 'avatar-owner']) {
      const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin }, payload: { username, password: 'long-avatar-password' } })
      const cookies = { [login.cookies[0].name]: login.cookies[0].value }
      const headers = { origin, 'x-csrf-token': login.json().csrf }
      if (username === 'avatar-other') {
        assert.equal((await app.inject({ url, cookies })).statusCode, 404)
        assert.equal((await app.inject({ method: 'POST', url, cookies, headers, payload })).statusCode, 404)
      } else {
        assert.equal((await app.inject({ method: 'POST', url, cookies, headers: { origin }, payload })).statusCode, 403)
        assert.equal((await app.inject({ method: 'POST', url, cookies, headers, payload: { ...payload, confirmed: false } })).statusCode, 400)
        assert.equal((await app.inject({ method: 'POST', url, cookies, headers, payload })).statusCode, 202)
        assert.equal((await app.inject({ method: 'POST', url, cookies, headers, payload })).statusCode, 202)
        assert.equal((await app.inject({ url, cookies })).json().length, 1)
      }
    }
    assert.equal(calls, 1)
  } finally { await app.close(); store.db.close(); await rm(dataDir, { recursive: true, force: true }) }
})

test('avatar ledger deduplicates submission, protects active projects and imports the result', async () => {
  const store = new Store(':memory:')
  const project = store.createProject('Avatar')
  let submissions = 0
  const objects = new Map<string, Buffer>()
  const storage = { put: async (name: string, bytes: Buffer) => { objects.set(name, bytes) }, read: async (name: string) => objects.get(name)!, remove: async (name: string) => { objects.delete(name) } }
  const provider = { submit: async () => { submissions++ }, status: async () => ({ status: 'Succeeded' as const, result: 'https://output.blob.core.windows.net/video.mp4' }), download: async () => Buffer.from('video-fixture') }
  const jobs = new AvatarJobs(store, storage, provider, async () => ({ width: 1920, height: 1080, duration: 10 }))
  try {
    const input = avatarInputSchema.parse({ requestId: randomUUID(), text: 'Hello', voice: 'zh-CN-XiaoxiaoNeural', character: 'lisa', style: 'casual-sitting' })
    const job = jobs.submit(project.id, input)
    assert.equal(jobs.submit(project.id, input).id, job.id)
    assert.throws(() => jobs.submit(project.id, { ...input, text: 'Changed' }), { statusCode: 409 })
    assert.throws(() => store.deleteProject(project.id, project.updatedAt), { statusCode: 409 })
    await jobs.close()
    await jobs.tick()
    assert.equal(submissions, 1)
    assert.equal(jobs.list(project.id)[0].status, 'completed')
    assert.equal(store.asset(job.id).provider, 'Azure Speech')
    assert(objects.has(`${job.id}.mp4`))
  } finally { await jobs.close(); store.db.close() }
})

test('uncertain avatar submission is queried after restart and never resubmitted', async () => {
  const store = new Store(':memory:')
  const project = store.createProject('Avatar')
  let submissions = 0, queries = 0
  const storage = { put: async () => {}, read: async () => Buffer.alloc(0), remove: async () => {} }
  const provider = { submit: async () => { submissions++; throw new Error('Connection lost') }, status: async () => { queries++; return { status: 'Running' as const } }, download: async () => Buffer.alloc(0) }
  let jobs = new AvatarJobs(store, storage, provider)
  try {
    jobs.submit(project.id, avatarInputSchema.parse({ requestId: randomUUID(), text: 'Hello', voice: 'zh-CN-YunxiNeural', character: 'lisa', style: 'graceful-sitting' }))
    await jobs.close()
    assert.equal(jobs.list(project.id)[0].status, 'unknown')
    jobs = new AvatarJobs(store, storage, provider)
    await jobs.tick()
    assert.equal(jobs.list(project.id)[0].status, 'running')
    assert.equal(submissions, 1)
    assert.equal(queries, 1)
    await assert.rejects(inspectAvatar(Buffer.from('not-a-video')))
  } finally { await jobs.close(); store.db.close() }
})

test('avatar sends literal narration once and polls the same job without exposing credentials', async () => {
  const id = randomUUID()
  const input = avatarInputSchema.parse({ requestId: id, text: 'Read <break/> literally & keep the original.', voice: 'zh-CN-XiaoxiaoNeural', character: 'lisa', style: 'casual-sitting' })
  const calls: { url: string; options?: RequestInit }[] = []
  const provider = createAvatarProvider('https://speech-example.cognitiveservices.azure.com/', async () => ({ Authorization: 'Bearer offline-token' }), async (url, options) => {
    calls.push({ url: String(url), options })
    return options?.method === 'PUT' ? new Response('{}', { status: 201 }) : new Response(JSON.stringify({ status: 'Succeeded', outputs: { result: 'https://output.blob.core.windows.net/result/video.mp4?sig=offline' }, properties: { durationInMilliseconds: 1000 } }))
  })
  await provider.submit(id, input)
  const status = await provider.status(id)
  assert.equal(status.status, 'Succeeded')
  assert.equal(calls[0].url, calls[1].url)
  const body = JSON.parse(calls[0].options!.body as string)
  assert.equal(body.inputKind, 'PlainText')
  assert.equal(body.inputs[0].content, input.text)
  assert.equal(body.avatarConfig.videoCodec, 'h264')
  assert.equal(calls.filter(call => call.options?.method === 'PUT').length, 1)
})

test('avatar rejects unsupported inputs and unsafe endpoints and never retries a submission', async () => {
  assert.throws(() => createAvatarProvider('http://localhost/', async () => ({})))
  const input = { requestId: randomUUID(), text: 'Test', voice: 'zh-CN-YunxiNeural', character: 'lisa', style: 'graceful-sitting' }
  assert.equal(avatarInputSchema.safeParse({ ...input, text: 'a'.repeat(501) }).success, false)
  assert.equal(avatarInputSchema.safeParse({ ...input, character: 'custom' }).success, false)
  let calls = 0
  const provider = createAvatarProvider('https://speech-example.cognitiveservices.azure.com/', async () => ({}), async () => { calls++; return new Response('private provider details', { status: 503 }) })
  await assert.rejects(provider.submit(input.requestId, avatarInputSchema.parse(input)), /HTTP 503/)
  assert.equal(calls, 1)
  await assert.rejects(provider.download('http://169.254.169.254/metadata'), /Invalid/)
  await assert.rejects(provider.download('https://example.com/result'), /Invalid/)
  assert.equal(calls, 1)
})