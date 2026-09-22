import test from 'node:test'
import assert from 'node:assert/strict'
import { parseDecision, renderSettings, editOutputSize, imageOutputSize } from './decision.mjs'
import { ImageSourceRequest } from './image-source.mjs'
import { createHash, randomUUID } from 'node:crypto'

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
  const bytes = Buffer.from('selected source test')
  const candidate = { assetId: randomUUID(), name: 'original.png', hash: createHash('sha256').update(bytes).digest('hex'), width: 64, height: 32, kind: 'reference', messageId: randomUUID(), context: 'first upload' }
  const source = { assetId: candidate.assetId, hash: candidate.hash, width: 64, height: 32, png: bytes.toString('base64') }
  const request = new ImageSourceRequest(candidate, new AbortController().signal)
  assert.throws(() => request.provide({ ...source, assetId: randomUUID() }), /selection/)
  assert.throws(() => request.provide({ ...source, png: Buffer.from('other bytes').toString('base64') }), /selection/)
  request.provide(source)
  assert.deepEqual(await request.promise, source)
  request.provide(source)
  const controller = new AbortController()
  const stopped = new ImageSourceRequest(candidate, controller.signal)
  controller.abort()
  await assert.rejects(stopped.promise, /stopped/)
  assert.throws(() => stopped.provide(source), /closed/)
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