import test from 'node:test'
import assert from 'node:assert/strict'
import { parseDecision } from './decision.mjs'

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
  const input = JSON.stringify({ action: 'edit', reply: '准备修改', imagePrompt: 'Change only the mug to red' })
  assert.equal(parseDecision(input, 'auto', true).action, 'edit')
  assert.equal(parseDecision(input, 'image', true).action, 'edit')
  assert.equal(parseDecision(input, 'chat', true).action, 'chat')
  assert.equal(parseDecision(input, 'auto', false).action, 'chat')
  assert.equal(parseDecision(input, 'auto', false).imagePrompt, null)
  assert.throws(() => parseDecision(JSON.stringify({ action: 'edit', reply: '修改', imagePrompt: null }), 'auto', true))
})