import test from 'node:test'
import assert from 'node:assert/strict'
import { parseDecision, renderSettings } from './decision.mjs'
import { ImageSourceRequest } from './image-source.mjs'
import { createHash, randomUUID } from 'node:crypto'

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
  assert.throws(() => renderSettings(decision, { ...defaults, imageModel: 'azure-image2' }), /未发送/)
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