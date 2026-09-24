import test from 'node:test'
import assert from 'node:assert/strict'
import { parseDecision, renderSettings, editOutputSize, imageOutputSize, narrationEditingSkill } from './decision.mjs'
import { ImageSourceRequest, sourceBodyLimit } from './image-source.mjs'
import Fastify from 'fastify'
import { createHash, randomUUID } from 'node:crypto'
import { executeStory } from './story.mjs'

test('story execution persists each clip, stops at boundaries and never retries a started plan', async context => {
  for (const stopAt of [0, 1, 2, null]) await context.test(`stop ${stopAt}`, async () => {
    const run = { id: randomUUID(), status: 'running' }
    const plan = { title: '故事', segments: [{ text: '开头', prompt: 'first' }, { text: '结尾', prompt: 'last' }] }
    const events = [], calls = []
    const operations = {
      save: async state => { events.push({ phase: state.story.phase, clips: state.processedVideos.length }); if (stopAt === state.processedVideos.length) state.story.stopRequested = true },
      render: async input => { calls.push(input); return { success: true, mp4: Buffer.from('clip').toString('base64'), width: 576, height: 1024 } },
      stitch: async input => { assert.equal(input.clipIds.length, 2); assert.equal(run.processedVideos.length, 2); return { success: true, duration: 10.334 } },
    }
    await executeStory(run, { ratio: '9:16', quality: 'low' }, plan, operations)
    assert.equal(calls.length, stopAt ?? 2)
    assert.equal(run.story.phase, stopAt === null ? 'completed' : 'stopped')
    assert.equal(!!run.video, stopAt === null)
    assert.equal(new Set(calls.map(call => call.runId)).size, calls.length)
    assert(calls.every(call => call.ratio === '9:16' && call.model === 'minimax-h3'))
    if (stopAt === null) assert(events.some(event => event.clips === 1 && event.phase === 'rendering'))
    await assert.rejects(executeStory(run, {}, plan, operations), /already started/)
  })
})

test('uncertain story clip failure preserves earlier clips without submitting later ones', async () => {
  const run = { id: randomUUID() }
  let calls = 0
  await assert.rejects(executeStory(run, {}, { title: '故事', segments: Array(3).fill({ text: '镜头', prompt: 'scene' }) }, {
    save: async () => {}, stitch: async () => assert.fail('Must not stitch incomplete clips'),
    render: async () => { if (++calls === 2) return { success: false, error: 'Uncertain submission' }; return { success: true, mp4: 'YQ==' } },
  }), /Uncertain/)
  assert.equal(calls, 2)
  assert.equal(run.processedVideos.length, 1)
})

test('multi-clip story is explicit, bounded, and cannot execute in chat or without the video model', () => {
  const decision = { action: 'video', reply: '开始制作', imagePrompt: null, videoPrompt: null, ratio: '9:16', storyPlan: { title: '迟到的明信片', segments: Array.from({ length: 8 }, (_, index) => ({ text: `第${index + 1}镜`, prompt: `Shot ${index + 1}, portrait, natural ambient audio` })) } }
  const parse = (value = decision, mode = 'auto', enabled = true) => parseDecision(JSON.stringify(value), mode, [], enabled)
  assert.equal(parse().storyPlan.segments.length, 8)
  assert.equal(parse().ratio, '9:16')
  assert.equal(parse(decision, 'chat').storyPlan, null)
  assert.equal(parse(decision, 'auto', false).storyPlan, undefined)
  const redundant = parse({ ...decision, videoPrompt: 'redundant summary, never execute an extra clip' })
  assert.equal(redundant.videoPrompt, null)
  assert.equal(redundant.storyPlan.segments.length, 8)
  assert.throws(() => parse({ ...decision, storyPlan: null }), /requires/)
  assert.throws(() => parse({ ...decision, action: 'image', imagePrompt: 'wrong media' }), /video action/)
  assert.throws(() => parse({ ...decision, storyPlan: { ...decision.storyPlan, segments: Array(13).fill(decision.storyPlan.segments[0]) } }))
})

test('narration editing skill loads as advice rather than a continuation limit', () => {
  assert.match(narrationEditingSkill, /name: narration-editing/)
  assert.match(narrationEditingSkill, /at most two consecutive generated clips/)
  assert.match(narrationEditingSkill, /preference, not a hard limit/)
  assert.match(narrationEditingSkill, /Resetting to the same source is NOT/)
})

test('conversational avatar requires an enabled service, selected image and bounded narration plan', () => {
  const source = randomUUID()
  const decision = { action: 'avatar', reply: '准备分段口播', imagePrompt: null, sourceAssetId: source, avatarPlan: { voice: 'zh-CN-XiaoxiaoNeural', segments: [{ text: '第一段。', continueFromPrevious: false }, { text: '第二段。', continueFromPrevious: true }] } }
  const parse = (value = decision, mode = 'auto', candidates = [source], enabled = true) => parseDecision(JSON.stringify(value), mode, candidates, false, enabled)
  assert.equal(parse().action, 'avatar')
  assert.equal(parse().avatarPlan.segments[1].continueFromPrevious, true)
  assert.equal(parse({ ...decision, avatarPlan: { ...decision.avatarPlan, segments: [...decision.avatarPlan.segments, { text: '第三段。', continueFromPrevious: true }] } }).avatarPlan.segments.length, 3)
  assert.equal(parse({ ...decision, avatarPlan: { ...decision.avatarPlan, segments: [...decision.avatarPlan.segments, { text: '第三段。', continueFromPrevious: false }, { text: '第四段。', continueFromPrevious: true }] } }).avatarPlan.segments.length, 4)
  assert.equal(parse(decision, 'chat').avatarPlan, null)
  assert.equal(parse(decision, 'auto', [source], false).action, 'chat')
  assert.throws(() => parse(decision, 'auto', []), /allowed sourceAssetId/)
  assert.throws(() => parse({ ...decision, avatarPlan: null }), /narration plan/)
  assert.throws(() => parse({ ...decision, avatarPlan: { ...decision.avatarPlan, segments: [{ text: '第一段。', continueFromPrevious: true }] } }))
  assert.throws(() => parse({ ...decision, avatarPlan: { ...decision.avatarPlan, segments: Array(13).fill(decision.avatarPlan.segments[0]) } }))
})

test('Azure edits accept phone photos without changing the source or GPU dimensions', () => {
  const source = { width: 3024, height: 4032 }
  assert.equal(editOutputSize(source, 'azure-image2'), 'auto')
  assert.equal(editOutputSize({ width: 4032, height: 3024 }, 'azure-image2'), 'auto')
  assert.equal(editOutputSize({ width: 640, height: 640 }, 'azure-image2'), 'auto')
  for (const [width, height] of [[1024, 1024], [1536, 1024], [1024, 1536]]) {
    assert.equal(editOutputSize({ width, height }, 'azure-image2'), `${width}x${height}`)
  }
  assert.equal(editOutputSize(source, 'qwen-image-2.1'), '3024x4032')
  assert.deepEqual(source, { width: 3024, height: 4032 })
})

test('selected source delivery validates identity and bytes and supports cancellation', async () => {
  const bytes = Buffer.alloc(38_823_614, 42)
  const candidate = { assetId: randomUUID(), name: 'original.png', hash: createHash('sha256').update(bytes).digest('hex'), width: 64, height: 32, kind: 'reference', messageId: randomUUID(), context: 'first upload' }
  const source = { assetId: candidate.assetId, hash: candidate.hash, width: 64, height: 32, png: bytes.toString('base64') }
  const request = new ImageSourceRequest(candidate, new AbortController().signal)
  assert.throws(() => request.provide({ ...source, assetId: randomUUID() }), /selection/)
  assert.throws(() => request.provide({ ...source, png: Buffer.from('other bytes').toString('base64') }), /selection/)
  const app = Fastify({ bodyLimit: sourceBodyLimit })
  app.put('/source', async requestBody => { request.provide(requestBody.body); return { accepted: true } })
  try {
    const response = await app.inject({ method: 'PUT', url: '/source', payload: source })
    assert.equal(response.statusCode, 200)
    assert.equal(response.json().accepted, true)
  } finally { await app.close() }
  assert.deepEqual(await request.promise, source)
  request.provide(source)
  const controller = new AbortController()
  const stopped = new ImageSourceRequest(candidate, controller.signal)
  controller.abort()
  await assert.rejects(stopped.promise, /stopped/)
  assert.throws(() => stopped.provide(source), /closed/)
})

test('source delivery refuses the 50 MB boundary before resolving', async () => {
  const bytes = Buffer.alloc(50_000_000)
  const candidate = { assetId: randomUUID(), name: 'oversize.png', hash: createHash('sha256').update(bytes).digest('hex'), width: 64, height: 32, kind: 'reference', messageId: randomUUID(), context: '' }
  const controller = new AbortController()
  const request = new ImageSourceRequest(candidate, controller.signal)
  assert.throws(() => request.provide({ assetId: candidate.assetId, hash: candidate.hash, width: 64, height: 32, png: bytes.toString('base64') }), /selection/)
  controller.abort()
  await assert.rejects(request.promise, /stopped/)
})

test('conversation settings override defaults without provider substitution', () => {
  const defaults = { ratio: '1:1', quality: 'low', imageModel: 'qwen-image-2.1' }
  const decision = parseDecision(JSON.stringify({ action: 'image', reply: '准备', imagePrompt: 'wide scene', ratio: '16:9', quality: 'high' }), 'auto')
  assert.deepEqual(renderSettings(decision, defaults), { ratio: '16:9', quality: 'high' })
  assert.deepEqual(renderSettings({ action: 'image', ratio: null, quality: null }, defaults), { ratio: '1:1', quality: 'low' })
  assert.equal(imageOutputSize(decision, { ...defaults, imageModel: 'azure-image2' }), '1536x864')
})

test('explicit conversational pixels and edit aspect override default and source dimensions', () => {
  const defaults = { ratio: '1:1', imageModel: 'azure-image2' }
  const source = { width: 1024, height: 1024 }
  for (const action of ['image', 'edit']) {
    const decision = parseDecision(JSON.stringify({ action, reply: '准备', imagePrompt: 'test', size: '2048x1152', ratio: '16:9', sourceAssetId: action === 'edit' ? '00000000-0000-4000-8000-000000000001' : null }), 'auto', ['00000000-0000-4000-8000-000000000001'])
    assert.equal(imageOutputSize(decision, defaults, source), '2048x1152')
    assert.equal(imageOutputSize({ action, ratio: '9:16' }, defaults, source), '864x1536')
    assert.throws(() => imageOutputSize({ action, size: '1920x1080' }, defaults, source), /不会替换/)
    assert.throws(() => imageOutputSize({ action, size: '4096x4096' }, defaults, source), /不会替换/)
    assert.throws(() => imageOutputSize({ action, size: '2048x1152', ratio: '1:1' }, defaults, source), /冲突/)
  }
  assert.equal(imageOutputSize({ action: 'edit' }, defaults, source), '1024x1024')
  assert.equal(imageOutputSize({ action: 'edit' }, defaults, { width: 1536, height: 864 }), '1536x864')
  assert.equal(imageOutputSize({ action: 'edit', size: '2048x1152' }, { ...defaults, imageModel: 'qwen-image-2.1' }, source), '2048x1152')
})

test('automatic decisions permit images only for an explicit image action', () => {
  const decision = { action: 'image', reply: '准备生成', imagePrompt: 'A glass on a white table' }
  assert.equal(parseDecision(JSON.stringify(decision), 'auto').action, 'image')
  assert.equal(parseDecision(JSON.stringify(decision), 'image').action, 'image')
  assert.equal(parseDecision(JSON.stringify(decision), 'chat').imagePrompt, null)
  assert.equal(parseDecision(JSON.stringify({ ...decision, action: 'chat' }), 'auto').imagePrompt, null)
  assert.throws(() => parseDecision(JSON.stringify({ ...decision, imagePrompt: null }), 'auto'))
  assert.throws(() => parseDecision(JSON.stringify({ ...decision, action: 'unknown' }), 'auto'))
})

test('video decisions never trigger image generation or claim completion', () => {
  const decision = parseDecision(JSON.stringify({ action: 'video', reply: '已生成视频', imagePrompt: 'An unwanted image' }), 'auto')
  assert.equal(decision.action, 'video')
  assert.equal(decision.imagePrompt, null)
  assert.match(decision.reply, /视频生成暂未接入/)
})

test('editing requires a source and never silently falls back to generation', () => {
  const older = '00000000-0000-4000-8000-000000000001'
  const latest = '00000000-0000-4000-8000-000000000002'
  const decision = { action: 'edit', reply: '准备修改第一张', imagePrompt: 'Change only the mug to red', sourceAssetId: older }
  const input = JSON.stringify(decision)
  assert.equal(parseDecision(input, 'auto', [older, latest]).sourceAssetId, older)
  assert.equal(parseDecision(input, 'image', [older, latest]).action, 'edit')
  assert.equal(parseDecision(input, 'chat', [older]).sourceAssetId, null)
  assert.throws(() => parseDecision(input, 'auto', [latest]), /allowed sourceAssetId/)
  assert.throws(() => parseDecision(JSON.stringify({ ...decision, sourceAssetId: null }), 'auto', [older]), /allowed sourceAssetId/)
  assert.throws(() => parseDecision(JSON.stringify({ ...decision, imagePrompt: null }), 'auto', [older]))
  assert.throws(() => parseDecision(JSON.stringify({ ...decision, action: 'image' }), 'auto', [older]), /Only edit/)
  assert.equal(parseDecision(JSON.stringify({ ...decision, action: 'image', sourceAssetId: null }), 'auto', [older, latest]).sourceAssetId, null)
})

test('enabled video uses its own prompt and chat mode cannot render', () => {
  const input = JSON.stringify({ action: 'video', reply: '准备视频', imagePrompt: 'unused', videoPrompt: 'Steam rising from a cup' })
  assert.equal(parseDecision(input, 'auto', [], true).videoPrompt, 'Steam rising from a cup')
  assert.equal(parseDecision(input, 'auto', [], true).imagePrompt, null)
  assert.equal(parseDecision(input, 'chat', [], true).action, 'chat')
  assert.equal(parseDecision(input, 'chat', [], true).videoPrompt, null)
  assert.throws(() => parseDecision(JSON.stringify({ action: 'video', reply: '准备', imagePrompt: null, videoPrompt: null }), 'auto', [], true))
})