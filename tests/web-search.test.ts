import test from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import { fixture } from './helpers.js'
import { WebSearch } from '../server/web-search.js'
import { readConfig } from '../server/config.js'
import { defaultSkills } from '../src/shared.js'
import type { AgentRequest } from '../server/agent.js'

const config = readConfig({ AZURE_MODEL_ENDPOINT: 'https://models.example/openai/v1/', AZURE_MODEL_DEPLOYMENT: 'fixture-model' })
const credential = { getToken: async () => ({ token: 'fixture-search-token', expiresOnTimestamp: Date.now() + 60000 }) }
const output = z.object({ resultType: z.string(), textResultForLlm: z.string() })
const grounded = {
  status: 'completed',
  output: [
    { type: 'web_search_call', status: 'completed' },
    { type: 'message', content: [{ type: 'output_text', text: 'Public verified result.', annotations: [
      { type: 'url_citation', url: 'https://learn.microsoft.com/', title: 'Microsoft Learn' },
    ] }] },
  ],
}
async function execute(search: WebSearch, turn: AgentRequest, query: string) {
  const tool = search.definition(turn, 'fixture-model')
  assert.ok(tool.handler)
  const input = { query }
  return output.parse(await tool.handler(input, { sessionId: 'fixture', toolCallId: 'search', toolName: 'web_search', arguments: input }))
}

test('search requires approval, sends only the public query and returns grounded citations', async t => {
  const f = await fixture(t)
  const conversation = await f.store.createConversation(f.alice.id, 'Search')
  const requests: Record<string, unknown>[] = []
  const search = new WebSearch(config, f.store, credential, async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
    return Response.json(grounded)
  })
  const turn: AgentRequest = {
    conversation, skills: defaultSkills, prompt: 'Private conversation content must stay private.',
    signal: new AbortController().signal, emit: () => {}, approve: async () => false, saveRuntimeId: () => {},
  }
  const input = { query: 'public documentation' }
  assert.equal((await execute(search, turn, input.query)).resultType, 'rejected')
  assert.equal(requests.length, 0)
  const result = await execute(search, { ...turn, approve: async () => true }, input.query)
  assert.equal(result.resultType, 'success')
  assert.equal(JSON.parse(result.textResultForLlm).sources[0].url, 'https://learn.microsoft.com/')
  assert.equal(requests.length, 1)
  assert.equal(requests[0].input, input.query)
  assert.equal(requests[0].store, false)
  assert.deepEqual(requests[0].tools, [{ type: 'web_search' }])
  assert.equal(JSON.stringify(requests).includes('Private conversation'), false)
})

test('search rejects ungrounded results, reports HTTP errors and does not retry or submit after cancellation', async t => {
  const f = await fixture(t)
  const conversation = await f.store.createConversation(f.alice.id, 'Failures')
  const turn: AgentRequest = {
    conversation, skills: defaultSkills, prompt: 'Search', signal: new AbortController().signal,
    emit: () => {}, approve: async () => true, saveRuntimeId: () => {},
  }
  const input = { query: 'public query' }
  for (const response of [() => new Response(null, { status: 403 }), () => Response.json({ ...grounded, output: grounded.output.slice(1) }), () => Response.json({ status: 'completed', output: [] })]) {
    let calls = 0
    const errors: string[] = []
    const search = new WebSearch(config, f.store, credential, async () => { calls++; return response() }, message => errors.push(message))
    assert.equal((await execute(search, turn, input.query)).resultType, 'failure')
    assert.equal(calls, 1)
    assert.equal(errors.length, 1)
  }
  const controller = new AbortController()
  controller.abort()
  let submitted = false
  const search = new WebSearch(config, f.store, credential, async () => { submitted = true; return Response.json(grounded) }, () => {})
  assert.equal((await execute(search, { ...turn, signal: controller.signal }, input.query)).resultType, 'failure')
  assert.equal(submitted, false)
})
