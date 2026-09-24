import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { avatarInputSchema, AvatarSubmissionRejected, AvatarSubmissionStopped, createAvatarProvider } from './avatar-provider.ts'
import { AvatarJobs, inspectAvatar } from './avatar.ts'
import { Store } from './store.ts'
import { buildApp } from './app.ts'
import { provisionLocalUser } from './auth.ts'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { createOpenMontageAvatarProvider } from './openmontage-avatar.ts'
import { AgentWorker } from './agent.ts'
import type { AgentTransport, ProjectContext } from './agent.ts'

test('native stop during narration skips later speech and GPU submission and survives provider restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'avatar-stop-'))
  const id = randomUUID()
  const source = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#fff' } }).png().toBuffer()
  const options = { directory, comfyUrl: 'http://10.0.0.4:8188', speechEndpoint: 'https://speech.cognitiveservices.azure.com', headers: async () => ({ Authorization: 'Bearer private' }) }
  let speechCalls = 0, promptCalls = 0, releaseSpeech!: () => void, announceSpeech!: () => void
  const started = new Promise<void>(resolve => { announceSpeech = resolve })
  const paused = new Promise<void>(resolve => { releaseSpeech = resolve })
  const uploads: string[] = []
  const request: typeof fetch = async (url, init) => {
    const target = new URL(String(url))
    if (target.pathname.startsWith('/object_info')) return Response.json({ StudioOpenMontageTalkingHead: {} })
    if (target.pathname === '/queue') return Response.json({ queue_running: [], queue_pending: [] })
    if (target.pathname === '/prompt') { promptCalls++; return Response.json({ prompt_id: randomUUID() }) }
    assert.equal(target.pathname, '/upload/image')
    const form = init!.body as FormData
    const name = (form.get('image') as File).name
    uploads.push(name)
    assert.equal(form.get('overwrite'), 'true')
    return Response.json({ name, subfolder: 'studio-avatar' })
  }
  const provider = createOpenMontageAvatarProvider(options, request, async () => { speechCalls++; announceSpeech(); await paused; return Buffer.from('audio') })
  const segments = [{ text: 'First', continueFromPrevious: false }, { text: 'Second', continueFromPrevious: true }]
  const input = avatarInputSchema.parse({ requestId: id, text: 'FirstSecond', segments, sourceAssetId: randomUUID(), voice: 'zh-CN-XiaoxiaoNeural', character: 'lisa', style: 'casual-sitting' })
  const progress: string[] = []
  const submitted = provider.submit(id, input, source, event => progress.push(`${event.phase}:${event.segment}`))
  try {
    await started
    await provider.stop!(id)
    releaseSpeech()
    await assert.rejects(submitted, AvatarSubmissionStopped)
    assert.deepEqual(progress, ['speech:1'])
    assert.equal(speechCalls, 1); assert.equal(promptCalls, 0)
    assert.deepEqual(uploads, [`${id}.stop`])
    const restored = createOpenMontageAvatarProvider(options, request)
    await assert.rejects(restored.submit(id, input, source), AvatarSubmissionStopped)
  } finally { releaseSpeech(); await submitted.catch(() => {}); await rm(directory, { recursive: true, force: true }) }
})

test('conversation executes complete narration and resumes the same job with retained segment assets', async () => {
  const store = new Store(':memory:')
  const project = store.createProject('Conversation narration')
  const image = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#fff' } }).png().toBuffer()
  const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
  const source = store.addAsset({ id: randomUUID(), projectId: project.id, name: 'host.png', kind: 'reference', width: 32, height: 32, bytes: image.length, hash: hash(image), createdAt: new Date().toISOString() })
  const objects = new Map<string, Buffer>([[`${source.id}.png`, image]])
  const storage = { put: async (key: string, bytes: Buffer) => { objects.set(key, bytes) }, read: async (key: string) => objects.get(key)!, remove: async (key: string) => { objects.delete(key) } }
  const clip = { id: randomUUID(), sourceAssetId: source.id, sourceHash: source.hash, hash: hash(Buffer.from('clip')), bytes: Buffer.from('clip'), mediaType: 'video' as const, name: 'segment.mp4', text: '第一句。' }
  const tail = { id: randomUUID(), sourceAssetId: clip.id, sourceHash: clip.hash, hash: hash(image), bytes: image, mediaType: 'image' as const, name: 'tail.png', seconds: 0.96 }
  const secondClip = { ...clip, id: randomUUID(), sourceAssetId: tail.id, sourceHash: tail.hash, text: '第二句。' }
  const secondTail = { ...tail, id: randomUUID(), sourceAssetId: secondClip.id, sourceHash: secondClip.hash }
  let nativeCalls = 0, codexCalls = 0, finished = false, artifactsReady = false
  const contexts: ProjectContext[] = []
  const provider = { submit: async () => { nativeCalls++ }, status: async () => ({ status: finished ? 'Succeeded' as const : 'Running' as const, result: 'final', progress: finished ? { phase: 'completed' as const, segment: 2, updatedAt: new Date().toISOString() } : undefined }), download: async () => Buffer.from('final'), artifacts: async () => artifactsReady ? [clip, tail, secondClip, secondTail] : [clip, tail] }
  const jobs = new AvatarJobs(store, storage, provider, async () => ({ width: 32, height: 32, duration: 1 }), provider)
  const threadId = randomUUID()
  const transport: AgentTransport = { health: async () => ({}), submit: async (...args) => { codexCalls++; assert.equal(args[6], true); contexts.push(args[7]!) }, get: async id => ({ id, status: 'completed', stage: 'video', threadId, reply: '准备', sourceAssetId: source.id, avatarPlan: { voice: 'zh-CN-XiaoxiaoNeural', segments: [{ text: '第一句。', continueFromPrevious: false }, { text: '第二句。', continueFromPrevious: true }] } }), stop: async () => {} }
  let worker = new AgentWorker(store, '', transport, storage, () => true, jobs)
  try {
    const run = store.queueAgent(project.id, { requestId: randomUUID(), text: '使用这张图片制作完整口播，文案第一句。', assetIds: [source.id], mode: 'auto', ratio: '16:9' })
    await worker.tick(); await worker.tick(); await jobs.close(); await jobs.tick(); await worker.tick()
    const originalJob = store.agentRun(run.id).avatarJobId
    assert(originalJob)
    assert.deepEqual(store.agentRun(run.id).processedAssetIds, [clip.id, tail.id])
    assert.equal(store.asset(tail.id).sourceAssetId, clip.id)
    await worker.close()
    worker = new AgentWorker(store, '', transport, storage, () => true, jobs)
    worker.start()
    await worker.tick()
    finished = true
    await jobs.tick(); await worker.tick()
    assert.equal(store.agentRun(run.id).status, 'running')
    assert.equal(store.agentRun(run.id).assetId, undefined)
    assert.equal(store.agentRun(run.id).progress?.at(-1)?.label, '整片已生成，正在入库')
    artifactsReady = true
    await jobs.tick(); await worker.tick()
    assert.equal(store.agentRun(run.id).status, 'completed')
    assert.equal(store.agentRun(run.id).progress?.at(-1)?.label, '整片已合成并入库')
    assert.equal(store.agentRun(run.id).avatarJobId, originalJob)
    assert.equal(nativeCalls, 1)
    assert.equal(codexCalls, 1)
    const message = store.snapshot(project.id).messages.find(message => message.id === run.assistantId)!
    const scriptId = store.agentRun(run.id).narration!.scriptAssetId!
    assert.deepEqual(message.assetIds, [scriptId, clip.id, tail.id, secondClip.id, secondTail.id, originalJob])
    assert.equal(store.asset(scriptId).mediaType, 'file')
    assert.match(objects.get(`${scriptId}.bin`)!.toString(), /第一句。[\s\S]*第二句。/)
    assert.equal(store.asset(secondClip.id).sourceAssetId, tail.id)
    assert.equal(store.asset(originalJob).narration, '第一句。第二句。')
    assert.match(message.text, /完整口播稿/)
    assert.equal(store.asset(source.id).hash, hash(image))
    store.queueAgent(project.id, { requestId: randomUUID(), text: '只讨论项目现有成果，不生成。', assetIds: [], mode: 'chat', ratio: '16:9' })
    await worker.tick()
    assert.equal(store.threadId(project.id), threadId)
    assert.equal(contexts[1].runs[0].status, 'completed')
    assert(contexts[1].runs[0].assetIds.includes(originalJob))
    assert(contexts[1].assets.some(asset => asset.assetId === scriptId))
    assert(contexts[1].assets.some(asset => asset.assetId === secondClip.id))
  } finally { await worker.close(); await jobs.close(); store.db.close() }
})

test('stop during script persistence prevents paid handoff while planner stop is still pending', async () => {
  const store = new Store(':memory:')
  const project = store.createProject('Stop handoff')
  const bytes = Buffer.from('source')
  const source = store.addAsset({ id: randomUUID(), projectId: project.id, name: 'host.png', kind: 'reference', width: 32, height: 32, bytes: bytes.length, hash: createHash('sha256').update(bytes).digest('hex'), createdAt: new Date().toISOString() })
  let releaseScript!: () => void, announceScript!: () => void, releaseStop!: () => void, submissions = 0
  const scriptStarted = new Promise<void>(resolve => { announceScript = resolve })
  const scriptPaused = new Promise<void>(resolve => { releaseScript = resolve })
  const stopPaused = new Promise<void>(resolve => { releaseStop = resolve })
  const storage = { put: async () => { announceScript(); await scriptPaused }, read: async () => bytes, remove: async () => {} }
  const provider = { submit: async () => { submissions++ }, status: async () => ({ status: 'Running' as const }), download: async () => bytes }
  const jobs = new AvatarJobs(store, storage, provider, undefined, provider)
  const transport: AgentTransport = { health: async () => ({}), submit: async () => {}, stop: async () => { await stopPaused }, get: async id => ({ id, threadId: null, status: 'completed', stage: 'video', reply: '剧本', sourceAssetId: source.id, avatarPlan: { voice: 'zh-CN-XiaoxiaoNeural', segments: [{ text: '第一句。', continueFromPrevious: false }] } }) }
  const worker = new AgentWorker(store, '', transport, storage, () => true, jobs)
  try {
    const run = store.queueAgent(project.id, { requestId: randomUUID(), text: '制作口播', assetIds: [source.id], mode: 'auto', ratio: '16:9' })
    await worker.tick()
    const advancing = worker.tick()
    await scriptStarted
    const stopping = worker.stop(run.id)
    releaseScript()
    await advancing
    releaseStop()
    await stopping
    assert.equal(store.agentRun(run.id).status, 'cancelled')
    assert.equal(jobs.list(project.id).length, 0)
    assert.equal(submissions, 0)
    assert.equal(store.snapshot(project.id).assets.filter(asset => asset.model === 'narration-script').length, 1)
  } finally { releaseScript(); releaseStop(); await worker.close(); await jobs.close(); store.db.close() }
})

test('conversation stop waits for acknowledgement, retries only control after restart and preserves completion races', async context => {
  for (const outcome of ['cancelled', 'completed'] as const) await context.test(outcome, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'conversation-stop-'))
    let store = new Store(join(directory, 'studio.sqlite'))
    const project = store.createProject('Stop sequence')
    const bytes = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#fff' } }).png().toBuffer()
    const hash = (content: Buffer) => createHash('sha256').update(content).digest('hex')
    const source = store.addAsset({ id: randomUUID(), projectId: project.id, name: 'host.png', kind: 'reference', width: 32, height: 32, bytes: bytes.length, hash: hash(bytes), createdAt: new Date().toISOString() })
    const objects = new Map<string, Buffer>([[`${source.id}.png`, bytes]])
    const storage = { put: async (key: string, value: Buffer) => { objects.set(key, value) }, read: async (key: string) => objects.get(key)!, remove: async () => {} }
    const clip = { id: randomUUID(), sourceAssetId: source.id, sourceHash: source.hash, hash: hash(Buffer.from('clip')), bytes: Buffer.from('clip'), mediaType: 'video' as const, name: 'segment.mp4', text: '第一句。' }
    const tail = { id: randomUUID(), sourceAssetId: clip.id, sourceHash: clip.hash, hash: hash(bytes), bytes, mediaType: 'image' as const, name: 'tail.png', seconds: 0.96 }
    let submissions = 0, plans = 0, stops = 0, settled = false
    const provider = {
      submit: async () => { submissions++ },
      stop: async () => { if (++stops === 1) throw new Error('Transient control failure') },
      status: async () => ({ status: settled ? outcome === 'completed' ? 'Succeeded' as const : 'Cancelled' as const : 'Running' as const, result: 'final', progress: { phase: settled ? outcome === 'completed' ? 'completed' as const : 'stopped' as const : 'rendering' as const, segment: 1, updatedAt: new Date().toISOString() } }),
      artifacts: async () => [clip, tail], download: async () => Buffer.from('final'),
    }
    const transport: AgentTransport = { health: async () => ({}), submit: async () => { plans++ }, stop: async () => { assert.fail('Do not stop completed planner') }, get: async id => ({ id, threadId: null, status: 'completed', stage: 'video', reply: '剧本已生成', sourceAssetId: source.id, avatarPlan: { voice: 'zh-CN-XiaoxiaoNeural', segments: [{ text: '第一句。', continueFromPrevious: false }] } }) }
    let jobs = new AvatarJobs(store, storage, provider, async () => ({ width: 32, height: 32, duration: 1 }), provider)
    let worker = new AgentWorker(store, '', transport, storage, () => true, jobs)
    try {
      const run = store.queueAgent(project.id, { requestId: randomUUID(), text: '制作口播', assetIds: [source.id], mode: 'auto', ratio: '16:9' })
      await worker.tick(); await worker.tick(); await jobs.close(); await jobs.tick(); await worker.tick()
      const jobId = store.agentRun(run.id).avatarJobId!
      await worker.stop(run.id)
      assert.equal(store.agentRun(run.id).status, 'running')
      assert.equal(store.agentRun(run.id).narration?.stopRequested, true)
      assert.deepEqual(store.agentRun(run.id).processedAssetIds, [clip.id, tail.id])
      await worker.close(); await jobs.close(); store.db.close()
      store = new Store(join(directory, 'studio.sqlite'))
      jobs = new AvatarJobs(store, storage, provider, async () => ({ width: 32, height: 32, duration: 1 }), provider)
      worker = new AgentWorker(store, '', transport, storage, () => true, jobs)
      worker.start()
      await worker.tick(); await jobs.tick(); await worker.tick()
      assert.equal(stops, 2)
      assert.equal(store.agentRun(run.id).status, 'running')
      settled = true
      await jobs.tick(); await worker.tick()
      const restored = store.agentRun(run.id)
      assert.equal(restored.status, outcome)
      assert.deepEqual(restored.processedAssetIds, [clip.id, tail.id])
      assert.equal(restored.assetId, outcome === 'completed' ? jobId : undefined)
      assert.equal(store.snapshot(project.id).assets.filter(asset => asset.model === 'narration-script').length, 1)
      assert.equal(submissions, 1); assert.equal(plans, 1); assert.equal(stops, 2)
      assert.equal(worker.hasActiveProject(project.id), false)
    } finally { await worker.close(); await jobs.close(); store.db.close(); await rm(directory, { recursive: true, force: true }) }
  })
})

test('native sequence submits once and validates fixed-path intermediate lineage', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'avatar-sequence-'))
  const id = randomUUID(), sourceAssetId = randomUUID()
  const source = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#fff' } }).png().toBuffer()
  const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
  const segments = [{ text: '第一句。', continueFromPrevious: false }, { text: '第二句。', continueFromPrevious: true }]
  const firstClip = { id: randomUUID(), hash: hash(Buffer.from('clip')), sourceAssetId, sourceHash: hash(source) }
  const firstTail = { id: randomUUID(), hash: hash(source), sourceAssetId: firstClip.id, sourceHash: firstClip.hash, seconds: 0.96 }
  const secondClip = { id: randomUUID(), hash: firstClip.hash, sourceAssetId: firstTail.id, sourceHash: firstTail.hash }
  const secondTail = { ...firstTail, id: randomUUID(), sourceAssetId: secondClip.id }
  const manifest = { status: 'completed', phase: 'completed', segment: 2, updatedAt: new Date().toISOString(), segments: [{ ...segments[0], clip: firstClip, tail: firstTail }, { ...segments[1], clip: secondClip, tail: secondTail }] }
  const narration: string[] = [], uploads: string[] = []
  let submitted = 0
  const provider = createOpenMontageAvatarProvider({ directory, comfyUrl: 'http://10.0.0.4:8188', speechEndpoint: 'https://speech.cognitiveservices.azure.com', headers: async () => ({ Authorization: 'Bearer secret' }) }, async (url, options) => {
    const target = new URL(String(url))
    assert.equal(new Headers(options?.headers).has('Authorization'), false)
    if (target.pathname.startsWith('/object_info')) return Response.json({ StudioOpenMontageTalkingHead: {} })
    if (target.pathname === '/queue') return Response.json({ queue_running: [], queue_pending: [] })
    if (target.pathname === '/upload/image') {
      const file = (options!.body as FormData).get('image') as File
      uploads.push(file.name)
      if (file.name.endsWith('.json')) {
        const plan = JSON.parse(await file.text())
        assert.equal(plan.segments.length, 2)
        assert.equal(plan.segments[1].audioHash, hash(Buffer.from('第二句。')))
        assert.doesNotMatch(await file.text(), /secret/)
      }
      return Response.json({ name: file.name, subfolder: 'studio-avatar' })
    }
    if (target.pathname === '/prompt') { submitted++; return Response.json({ prompt_id: randomUUID() }) }
    assert.equal(target.pathname, '/view')
    if (target.searchParams.get('filename') === 'manifest.json') return Response.json(manifest)
    assert.match(target.searchParams.get('subfolder')!, new RegExp(`^studio-avatar/${id}/segment-0[12]$`))
    return new Response(new Uint8Array(target.searchParams.get('filename') === 'tail.png' ? source : Buffer.from('clip')))
  }, async input => { narration.push(input.text); return Buffer.from(input.text) })
  try {
    const input = avatarInputSchema.parse({ requestId: id, text: '第一句。第二句。', voice: 'zh-CN-XiaoxiaoNeural', character: 'lisa', style: 'casual-sitting', sourceAssetId, segments })
    await provider.submit(id, input, source)
    await assert.rejects(provider.submit(id, input, source))
    assert.deepEqual(narration, ['第一句。', '第二句。'])
    assert.deepEqual(uploads, [`${id}.png`, `${id}.wav`, `${id}-02.wav`, `${id}.json`])
    assert.equal(submitted, 1)
    const artifacts = await provider.artifacts!(id)
    assert.equal(artifacts.length, 4)
    assert.equal(artifacts[2].sourceAssetId, artifacts[1].id)
    manifest.status = 'cancelled'; manifest.phase = 'stopped'
    const cancelled = await provider.status(id)
    assert.equal(cancelled.status, 'Cancelled')
    assert.equal(cancelled.progress?.phase, 'stopped')
    assert.equal((await provider.artifacts!(id)).length, 4)
    manifest.segments[1].clip.sourceAssetId = sourceAssetId
    await assert.rejects(provider.artifacts!(id), /lineage/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('native avatar reuses OpenMontage nodes without exposing Speech credentials or resubmitting', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'native-avatar-'))
  const id = randomUUID(), promptId = randomUUID()
  let narrations = 0, submissions = 0
  const calls: string[] = []
  const source = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#ffffff' } }).png().toBuffer()
  const options = { directory, comfyUrl: 'http://10.0.0.4:8188', speechEndpoint: 'https://speech.cognitiveservices.azure.com', headers: async () => ({ Authorization: 'Bearer private-test-token' }) }
  const provider = createOpenMontageAvatarProvider(options, async (url, request) => {
    const route = new URL(String(url)).pathname
    calls.push(route)
    if (route.startsWith('/object_info')) return Response.json({ StudioOpenMontageTalkingHead: {} })
    if (route === '/queue') return Response.json({ queue_running: [], queue_pending: [] })
    if (route === '/upload/image') return Response.json({ name: ((request!.body as FormData).get('image') as File).name, subfolder: 'studio-avatar' })
    if (route === '/prompt') {
      submissions++
      assert.doesNotMatch(request!.body as string, /private-test-token|Literal narration/)
      assert.equal(JSON.parse(request!.body as string).prompt['1'].inputs.job_id, id)
      return Response.json({ prompt_id: promptId })
    }
    if (route === `/history/${promptId}`) return Response.json({ [promptId]: { status: { completed: true }, outputs: { '1': { videos: [{ filename: 'video.mp4', subfolder: `studio-avatar/${id}`, type: 'output' }] } } } })
    if (route === '/view') return new Response('video-fixture')
    throw new Error('Unexpected request')
  }, async input => { narrations++; assert.equal(input.token, 'private-test-token'); return Buffer.from('wave-fixture') })
  const input = avatarInputSchema.parse({ requestId: id, text: 'Literal narration', voice: 'zh-CN-XiaoxiaoNeural', character: 'lisa', style: 'casual-sitting' })
  try {
    await provider.submit(id, input, source)
    await assert.rejects(provider.submit(id, input, source))
    assert.equal((await provider.status(id)).result, id)
    assert.equal((await provider.download(id)).toString(), 'video-fixture')
    assert.equal(narrations, 1)
    assert.equal(submissions, 1)
    assert.equal(calls.filter(route => route === '/upload/image').length, 2)
    const ledger = await (await import('node:fs/promises')).readFile(join(directory, `${id}.json`), 'utf8')
    assert.doesNotMatch(ledger, /private-test-token|Literal narration/)
    assert.throws(() => createOpenMontageAvatarProvider({ ...options, comfyUrl: 'http://169.254.169.254' }))
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('queued avatar status accepts empty outputs and zero duration', async () => {
  const provider = createAvatarProvider('https://speech.cognitiveservices.azure.com', async () => ({}), async () => Response.json({ status: 'NotStarted', outputs: {}, properties: { durationInMilliseconds: 0 } }))
  assert.equal((await provider.status(randomUUID())).status, 'NotStarted')
})

test('native avatar ledger enforces image ownership, content hash and original provider on recovery', async () => {
  const store = new Store(':memory:')
  const project = store.createProject('Native avatar')
  const other = store.createProject('Other project')
  const bytes = Buffer.from('image-fixture')
  const asset = store.addAsset({ id: randomUUID(), projectId: project.id, name: 'host.png', kind: 'reference', mediaType: 'image', width: 64, height: 64, bytes: bytes.length, hash: createHash('sha256').update(bytes).digest('hex'), createdAt: new Date().toISOString() })
  const foreign = store.addAsset({ ...asset, id: randomUUID(), projectId: other.id })
  let nativeCalls = 0, presetCalls = 0
  const storage = { put: async () => {}, read: async () => bytes, remove: async () => {} }
  const preset = { submit: async () => { presetCalls++ }, status: async () => ({ status: 'Running' as const }), download: async () => Buffer.alloc(0) }
  const native = { submit: async (_id: string, _input: unknown, source?: Buffer) => { nativeCalls++; assert.deepEqual(source, bytes) }, status: async () => ({ status: 'Succeeded' as const, result: 'native-job' }), download: async () => Buffer.from('video') }
  const inspect = async () => ({ width: 64, height: 64, duration: 5 })
  let jobs = new AvatarJobs(store, storage, preset, inspect, native)
  const input = avatarInputSchema.parse({ requestId: randomUUID(), text: 'Hello', voice: 'zh-CN-XiaoxiaoNeural', character: 'lisa', style: 'casual-sitting', sourceAssetId: asset.id })
  try {
    assert.throws(() => jobs.submit(project.id, { ...input, sourceAssetId: foreign.id }), { statusCode: 400 })
    const job = jobs.submit(project.id, input)
    assert.equal(jobs.submit(project.id, input).id, job.id)
    await jobs.close()
    jobs = new AvatarJobs(store, storage, preset, inspect, native)
    await jobs.tick()
    assert.equal(store.asset(job.id).provider, 'OpenMontage')
    assert.equal(store.asset(job.id).sourceAssetId, asset.id)
    assert.equal(store.asset(job.id).sourceHash, asset.hash)
    assert.equal(nativeCalls, 1)
    assert.equal(presetCalls, 0)
    const changed = new AvatarJobs(store, { ...storage, read: async () => Buffer.from('changed') }, preset, inspect, native)
    changed.submit(project.id, { ...input, requestId: randomUUID() })
    await changed.close()
    assert.equal(nativeCalls, 1)
    assert.equal(changed.list(project.id)[0].status, 'failed')
  } finally { await jobs.close(); store.db.close() }
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