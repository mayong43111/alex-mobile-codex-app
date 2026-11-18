import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import sharp from 'sharp'
import { SessionStatus } from '@microsoft/agent-host-protocol'
import { CopilotAgent } from '../server/agent.js'
import type { AgentOutput } from '../server/agent.js'
import { readConfig } from '../server/config.js'
import { ToolRegistry } from '../server/tools.js'
import { defaultSkills } from '../src/shared.js'
import type { PermissionMode } from '../src/shared.js'
import { modelCatalogFixture } from './helpers.js'
import { Store } from '../server/store.js'
import { Attachments } from '../server/attachments.js'
import { ImageGeneration } from '../server/image-generation.js'
import { WebSearch } from '../server/web-search.js'

for (const remote of [false, true]) test(`real Copilot runtime uses ${remote ? 'durable remote session files' : 'local session files'} through the production adapter`, { timeout: 90_000 }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'studio-native-test-'))
  const requests: { authorization: string | undefined; body: Record<string, unknown> }[] = []
  const server = createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk
    requests.push({ authorization: request.headers.authorization, body: JSON.parse(body) as Record<string, unknown> })
    if (JSON.stringify(requests.at(-1)!.body.tools) === JSON.stringify([{ type: 'web_search' }])) {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ status: 'completed', output: [
        { type: 'web_search_call', status: 'completed' },
        { type: 'message', content: [{ type: 'output_text', text: 'Grounded public fixture.', annotations: [
          { type: 'url_citation', url: 'https://learn.microsoft.com/', title: 'Microsoft Learn' },
        ] }] },
      ] }))
      return
    }
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
    const event = (type: string, value: Record<string, unknown>) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`)
    if (requests.length === 3 || requests.length === 6) {
      const search = requests.length === 6
      const item = { id: 'fc_fixture', type: 'function_call', call_id: search ? 'search_fixture' : 'image_fixture', name: search ? 'web_search' : 'image_generation', arguments: JSON.stringify(search ? { query: 'public search fixture' } : { prompt: 'A blue square', size: '1024x1024', quality: 'auto' }), status: 'completed' }
      const result = { id: 'resp_tool', object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'completed', model: 'fixture-model-b', output: [item] }
      event('response.created', { response: { ...result, status: 'in_progress', output: [] } })
      event('response.output_item.added', { output_index: 0, item: { ...item, arguments: '', status: 'in_progress' } })
      event('response.function_call_arguments.delta', { item_id: item.id, output_index: 0, delta: item.arguments })
      event('response.function_call_arguments.done', { item_id: item.id, output_index: 0, arguments: item.arguments })
      event('response.output_item.done', { output_index: 0, item })
      event('response.completed', { response: result })
      response.end()
      return
    }
    const text = 'Native runtime fixture reply'
    const item = { id: 'msg_fixture', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }
    const result = {
      id: `resp_${requests.length}`, object: 'response', created_at: Math.floor(Date.now() / 1000),
      status: 'completed', model: 'fixture-model', output: [item],
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
    }
    event('response.created', { response: { ...result, status: 'in_progress', output: [] } })
    event('response.output_item.added', { output_index: 0, item: { ...item, status: 'in_progress', content: [] } })
    event('response.content_part.added', { item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } })
    event('response.output_text.delta', { item_id: item.id, output_index: 0, content_index: 0, delta: text })
    event('response.output_text.done', { item_id: item.id, output_index: 0, content_index: 0, text })
    event('response.content_part.done', { item_id: item.id, output_index: 0, content_index: 0, part: item.content[0] })
    event('response.output_item.done', { output_index: 0, item })
    event('response.completed', { response: result })
    response.end()
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const config = {
    ...readConfig({ DATA_DIR: dataDir, TOOLS_FILE: join(dataDir, 'tools.json') }),
    endpoint: `http://127.0.0.1:${address.port}/openai/v1/`,
    deployment: 'fixture-model',
    imageEndpoint: 'https://images.example/openai/v1/',
    imageDeployment: 'gpt-image-2',
  }
  const store = new Store(dataDir)
  const user = (await store.createUser('native-fixture', 'not-used-for-login'))
  const attachments = new Attachments(store, dataDir)
  const image = await attachments.save(user.id, await sharp({ create: { width: 64, height: 48, channels: 3, background: '#315f91' } }).png().toBuffer(), 'reference.png')
  const credential = { getToken: async () => ({ token: 'local-fixture-token', expiresOnTimestamp: Date.now() + 3600_000 }) }
  let generated = 0
  const imageService = new ImageGeneration(config, attachments, store, credential, async () => {
    generated++
    return Response.json({ data: [{ b64_json: (await attachments.read(user.id, image.id)).data.toString('base64') }] })
  })
  const createAgent = () => new CopilotAgent(config, new ToolRegistry(config.toolsFile), {
    getToken: async () => ({ token: 'local-fixture-token', expiresOnTimestamp: Date.now() + 3600_000 }),
  }, modelCatalogFixture(), attachments, imageService, remote ? store.database : undefined, new WebSearch(config, store, credential))
  let agent = createAgent()
  const output: AgentOutput[] = []
  const conversation = {
    id: randomUUID(), userId: user.id,
    state: { resource: `ahp-chat:/${randomUUID()}`, title: 'Native fixture', status: SessionStatus.Idle, modifiedAt: new Date().toISOString(), turns: [] },
    runtimeId: undefined as string | undefined,
    model: 'fixture-model',
    permissionMode: 'manual' as PermissionMode,
  }
  try {
    const request = {
      conversation, prompt: 'Reply with a short greeting.', skills: { ...defaultSkills }, attachments: [image],
      signal: new AbortController().signal,
      emit: (event: AgentOutput) => output.push(event),
      approve: async () => false,
      saveRuntimeId: (id: string) => { conversation.runtimeId = id },
    }
    await agent.run(request)
    assert.ok(conversation.runtimeId)
    assert.equal(requests.length, 1)
    assert.equal(requests[0].authorization, 'Bearer local-fixture-token')
    assert.equal(requests[0].body.model, 'fixture-model')
    assert.equal(output.filter(event => event.type === 'text').map(event => event.delta).join(''), 'Native runtime fixture reply')
    const firstTools = JSON.stringify(requests[0].body.tools)
    assert.equal(firstTools.includes('bash'), false)
    assert.equal(firstTools.includes('generate_image'), false)
    assert.equal(firstTools.includes('image_generation'), true)
    assert.equal(firstTools.includes('web_search'), true)
    const visualInput = JSON.stringify(requests[0].body.input)
    assert.ok(visualInput.includes('input_image'))
    assert.ok(visualInput.includes(`data:image/webp;base64,${(await attachments.read(user.id, image.id)).data.toString('base64')}`))
    assert.equal(JSON.stringify(requests[0].body).includes('image-production'), true)
    if (remote) {
      await agent.close()
      await rm(join(dataDir, 'runtimes', user.id), { recursive: true, force: true })
      await rm(join(dataDir, 'workspaces', user.id), { recursive: true, force: true })
      agent = createAgent()
    }
    conversation.model = 'fixture-model-b'
    await agent.run({ ...request, prompt: 'Continue our conversation.', skills: { 'image-production': false, 'video-production': false } })
    assert.equal(requests.length, 2)
    assert.equal(requests[1].authorization, 'Bearer local-fixture-token')
    assert.equal(requests[1].body.model, 'fixture-model-b')
    assert.ok(JSON.stringify(requests[1].body.input).includes('Native runtime fixture reply'))
    assert.equal(JSON.stringify(requests[1].body.tools).includes('image_generation'), false)
    await agent.run({ ...request, prompt: 'Generate an image using the references.', approve: async () => true })
    assert.equal(requests.length, 4)
    assert.equal(generated, 1)
    assert.ok(output.some(event => event.type === 'image'))
    assert.ok(output.some(event => event.type === 'tool-complete' && event.success))
    conversation.permissionMode = 'assisted'
    await agent.run({ ...request, prompt: 'Reply without using tools.' })
    assert.equal(requests.length, 5)
    conversation.permissionMode = 'allow-all'
    await agent.run({ ...request, prompt: 'Search public documentation.', approve: async () => true })
    assert.equal(requests.length, 8)
    assert.equal(requests[6].body.input, 'public search fixture')
    assert.ok(JSON.stringify(requests[7].body.input).includes('https://learn.microsoft.com/'))
  } finally {
    await agent.close()
    await store.close()
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    await rm(dataDir, { recursive: true, force: true })
  }
})
