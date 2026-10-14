import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { EventEmitter } from 'node:events'
import { createContext, SourceTextModule, SyntheticModule } from 'node:vm'
import * as crypto from 'node:crypto'
import Fastify from 'fastify'
import { z } from 'zod'
import * as decisions from './decision.mjs'
import * as sources from './image-source.mjs'
import * as attachments from './attachments.mjs'
import * as attachmentStorage from './attachment-store.mjs'

test('direct image ratio is fixed by the form even when the prompt specifies a different ratio', () => {
  const input = { directImage: { operation: 'generate' }, mode: 'image', videoModel: 'none', imageModel: 'gpt-image-2.5-flare', ratio: '9:16', quality: 'medium', imageCandidates: [], text: 'white flowers' }
  const size = text => decisions.imageOutputSize(decisions.directImageDecision({ ...input, text }), input)
  assert.equal(size(input.text), '864x1536')
  assert.equal(size('white flowers, 16:9'), '864x1536')
  assert.equal(size('画幅为 3：4，白色花束'), '864x1536')
  assert.equal(size('16:9，比例 16:9'), '864x1536')
  assert.throws(() => size('比例 2:1'), /不支持指定的比例/)
  assert.throws(() => size('16:9 或 9:16'), /多个不同的图片比例/)
})

for (const operation of ['generate', 'edit', 'missing-source', 'chat', 'multi-edit', 'planned-multi', 'planned-inspect', 'planned-history', 'auto-ratio']) {
  test(`gateway direct image ${operation} bypasses Codex only for explicit image tasks`, { timeout: 10000 }, async () => {
    const planned = operation.startsWith('planned-') || operation === 'auto-ratio'
    const editing = ['edit', 'multi-edit', 'planned-multi'].includes(operation)
    const shouldRender = !['missing-source', 'chat', 'planned-inspect'].includes(operation)
    let app
    let codexCalls = 0
    const rendered = []
    const records = new Map()
    const finished = Promise.withResolvers()
    const requestedSource = Promise.withResolvers()
    const requestedSecondSource = Promise.withResolvers()
    const config = { token: 'internal-test-token'.repeat(3), codex: { auth: 'entra', endpoint: 'https://unused.example', deployment: 'unused' }, image: { auth: 'entra', deployments: { 'gpt-image-2.5-flare': 'flare' } } }
    const context = createContext({ Buffer, AbortController, AbortSignal, console, setTimeout, clearTimeout,
      setInterval: () => ({ unref() {} }), clearInterval() {}, process: { env: { SERVICES_FILE: '/config', PATH: '/test' }, once() {} } })
    const modules = {
      fastify: { default: options => { app = Fastify(options); app.listen = async () => {}; return app } },
      '@openai/codex-sdk': { Codex: class {
        constructor() { codexCalls++; if (!planned) throw new Error('Codex forbidden in direct-image test') }
        startThread() { return { runStreamed: async () => ({ events: (async function* () {
          yield { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ action: operation === 'planned-inspect' ? 'chat' : 'image', reply: '准备', imagePrompt: operation === 'planned-inspect' ? null : input.text, ratio: '16:9', sourceAssetId: null }) } }
          yield { type: 'turn.completed', usage: {} }
        })() }) } }
      } },
      zod: { z }, 'node:crypto': crypto,
      'node:fs/promises': { mkdir: async () => {}, readdir: async () => [], readFile: async path => {
        if (path === '/config') return JSON.stringify(config)
        if (records.has(path)) return JSON.stringify(records.get(path))
        throw Object.assign(new Error('Missing run'), { code: 'ENOENT' })
      } },
      'node:child_process': { spawn: () => {
        const child = new EventEmitter()
        child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = new EventEmitter()
        child.stdin.end = body => {
          rendered.push(JSON.parse(body))
          queueMicrotask(() => { child.stdout.emit('data', Buffer.from(JSON.stringify({ success: true, png: 'test-output' }))); child.emit('exit', 0) })
        }
        return child
      } },
      './decision.mjs': decisions, './image-source.mjs': sources, './attachments.mjs': attachments,
      './attachment-store.mjs': { ...attachmentStorage, AttachmentStore: class {
        async prune() {} async remove() {} async processed() { return [] }
        async seal() { throw new Error('Attachment MCP must not start') }
      } },
      './persistence.mjs': { appendCodexEvent() {}, saveRun: async (path, run) => {
        records.set(path, structuredClone(run))
        if (run.needsSource) (run.requestedSourceAssetId === second.assetId ? requestedSecondSource : requestedSource).resolve(run)
        if (['completed', 'failed', 'cancelled'].includes(run.status)) finished.resolve(run)
      } },
      './story.mjs': { executeStory: async () => { throw new Error('Unexpected story') } },
    }
    const module = new SourceTextModule(await readFile(new URL('./gateway.mjs', import.meta.url), 'utf8'), { context })
    await module.link(name => new SyntheticModule(Object.keys(modules[name]), function () {
      for (const [key, value] of Object.entries(modules[name])) this.setExport(key, value)
    }, { context }))
    await module.evaluate()
    const bytes = Buffer.from('explicit-source-test-bytes')
    const source = { assetId: crypto.randomUUID(), name: 'selected.png', hash: crypto.createHash('sha256').update(bytes).digest('hex'), width: 1024, height: 1024, kind: 'reference', messageId: crypto.randomUUID(), context: '' }
    const second = { ...source, assetId: crypto.randomUUID(), name: 'second.png' }
    const references = ['multi-edit', 'planned-multi', 'planned-inspect'].includes(operation) ? [source, second] : editing || operation === 'planned-history' ? [source] : []
    const input = { id: crypto.randomUUID(), projectId: crypto.randomUUID(), threadId: null, text: 'literal image prompt', mode: operation === 'chat' ? 'chat' : 'image', imageModel: 'gpt-image-2.5-flare', videoModel: 'none', ratio: operation === 'edit' ? '3:4' : '1:1', quality: 'medium', imageToken: 'image-only-token',
      imageCandidates: references,
      attachments: operation === 'planned-history' ? [] : references.map(candidate => ({ assetId: candidate.assetId, name: candidate.name, mediaType: 'image', mimeType: 'image/png', bytes: bytes.length, location: `/api/assets/${candidate.assetId}/content` })),
      ...(planned || operation === 'chat' ? { codexToken: 'chat-token' } : { directImage: operation === 'generate' ? { operation } : { operation: 'edit', sourceAssetId: source.assetId } }),
      ...(operation === 'auto-ratio' ? { ratio: 'auto', directImage: { operation: 'generate' } } : {}) }
    const headers = { authorization: `Bearer ${config.token}` }
    try {
      assert.equal((await app.inject({ method: 'POST', url: '/runs', headers, payload: input })).statusCode, 202)
      if (editing) for (const reference of references) {
        await Promise.race([(reference === source ? requestedSource : requestedSecondSource).promise, finished.promise])
        assert.equal(rendered.length, 0)
        const delivery = await app.inject({ method: 'PUT', url: `/runs/${input.id}/source`, headers, payload: { assetId: reference.assetId, hash: reference.hash, width: reference.width, height: reference.height, png: bytes.toString('base64') } })
        assert.equal(delivery.statusCode, 202)
      }
      const result = await finished.promise
      assert.equal(codexCalls, planned || operation === 'chat' ? 1 : 0)
      assert.equal(result.status, shouldRender || operation === 'planned-inspect' ? 'completed' : 'failed')
      assert.equal(rendered.length, shouldRender ? 1 : 0)
      if (rendered.length) {
        assert.equal(rendered[0].prompt, input.text)
        assert.equal(rendered[0].operation, editing ? 'edit' : 'generate')
        assert.equal(rendered[0].imageModel, input.imageModel)
        assert.equal(rendered[0].size, operation === 'edit' ? '960x1280' : operation === 'auto-ratio' ? '1536x864' : '1024x1024')
        assert.equal(rendered[0].sourceImage?.assetId, editing ? source.assetId : undefined)
        if (editing) {
          assert.deepEqual(rendered[0].sourceImages.map(image => image.assetId), references.map(image => image.assetId))
          assert.equal(rendered[0].sourceImage.png, bytes.toString('base64'))
          assert.equal(rendered[0].sourceImage.width, source.width)
          assert.equal(rendered[0].sourceImage.height, source.height)
        }
        assert.equal((await app.inject({ method: 'POST', url: '/runs', headers, payload: input })).statusCode, 202)
        assert.equal(rendered.length, 1)
      }
    } finally { await app.close() }
  })
}