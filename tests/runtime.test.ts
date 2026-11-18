import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { SessionStatus } from '@microsoft/agent-host-protocol'
import { CopilotAgent } from '../server/agent.js'
import type { AgentOutput } from '../server/agent.js'
import { readConfig } from '../server/config.js'
import { ToolRegistry } from '../server/tools.js'
import { defaultSkills } from '../src/shared.js'

test('real Copilot runtime calls a local Responses fixture through the production adapter', { timeout: 90_000 }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'studio-native-test-'))
  const requests: { authorization: string | undefined; body: Record<string, unknown> }[] = []
  const server = createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk
    requests.push({ authorization: request.headers.authorization, body: JSON.parse(body) as Record<string, unknown> })
    const text = 'Native runtime fixture reply'
    const item = { id: 'msg_fixture', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }
    const result = {
      id: `resp_${requests.length}`, object: 'response', created_at: Math.floor(Date.now() / 1000),
      status: 'completed', model: 'fixture-model', output: [item],
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
    }
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
    const event = (type: string, value: Record<string, unknown>) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`)
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
  }
  const agent = new CopilotAgent(config, new ToolRegistry(config.toolsFile), {
    getToken: async () => ({ token: 'local-fixture-token', expiresOnTimestamp: Date.now() + 3600_000 }),
  })
  const output: AgentOutput[] = []
  const conversation = {
    id: randomUUID(), userId: randomUUID(),
    state: { resource: `ahp-chat:/${randomUUID()}`, title: 'Native fixture', status: SessionStatus.Idle, modifiedAt: new Date().toISOString(), turns: [] },
    runtimeId: undefined as string | undefined,
  }
  try {
    const request = {
      conversation, prompt: 'Reply with a short greeting.', skills: { ...defaultSkills },
      signal: new AbortController().signal,
      emit: (event: AgentOutput) => output.push(event),
      approve: async () => false,
      saveRuntimeId: (id: string) => { conversation.runtimeId = id },
    }
    await agent.run(request)
    assert.ok(conversation.runtimeId)
    assert.equal(requests.length, 1)
    assert.equal(requests[0].authorization, 'Bearer local-fixture-token')
    assert.equal(output.filter(event => event.type === 'text').map(event => event.delta).join(''), 'Native runtime fixture reply')
    const firstTools = JSON.stringify(requests[0].body.tools)
    assert.equal(firstTools.includes('bash'), false)
    assert.equal(firstTools.includes('generate_image'), false)
    assert.equal(JSON.stringify(requests[0].body).includes('image-production'), true)
    await agent.run({ ...request, prompt: 'Continue our conversation.', skills: { 'image-production': false, 'video-production': false } })
    assert.equal(requests.length, 2)
    assert.equal(requests[1].authorization, 'Bearer local-fixture-token')
  } finally {
    await agent.close()
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    await rm(dataDir, { recursive: true, force: true })
  }
})
