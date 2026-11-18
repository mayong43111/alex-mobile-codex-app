import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ActionType, MessageKind, ResponsePartKind, ToolCallConfirmationReason } from '@microsoft/agent-host-protocol'
import type { ChatState } from '@microsoft/agent-host-protocol'
import { fixture, connect, until, modelCatalogFixture } from './helpers.js'
import { ToolRegistry } from '../server/tools.js'
import { readConfig } from '../server/config.js'
import { hashPassword } from '../server/auth.js'
import { defaultSkills } from '../src/shared.js'
import { AgentHost } from '../server/host.js'
import { FixtureAgent } from './helpers.js'

test('login accepts six-character passwords and rejects shorter input', async t => {
  const f = await fixture(t)
  await f.store.createUser('short-user', await hashPassword('abcdef'))
  const login = (password: string) => f.app.inject({
    method: 'POST', url: '/api/login', headers: { origin: f.config.origin },
    payload: { username: 'short-user', password },
  })
  assert.equal((await login('abcde')).statusCode, 400)
  assert.equal((await login('x'.repeat(257))).statusCode, 400)
  assert.equal((await login('abcdeg')).statusCode, 401)
  const response = await login('abcdef')
  assert.equal(response.statusCode, 200)
  assert.equal(response.json().username, 'short-user')
})

test('login, CSRF, ownership and per-user skill choices are enforced', async t => {
  const f = await fixture(t)
  assert.equal((await f.app.inject('/api/conversations')).statusCode, 401)
  assert.equal((await f.app.inject({ method: 'POST', url: '/api/login', payload: { username: 'alice', password: 'test-password-1234' } })).statusCode, 403)
  const alice = await f.login()
  const bob = await f.login('bob')
  const created = await f.app.inject({ method: 'POST', url: '/api/conversations', headers: alice.headers, payload: { title: 'Private' } })
  const id = created.json<{ id: string }>().id
  assert.equal((await f.app.inject({ url: `/api/conversations/${id}`, headers: bob.headers })).statusCode, 404)
  assert.deepEqual((await f.app.inject({ url: '/api/conversations', headers: bob.headers })).json(), [])
  assert.equal((await f.app.inject({ method: 'PUT', url: '/api/settings/skills', headers: { cookie: alice.cookie, origin: f.config.origin }, payload: defaultSkills })).statusCode, 403)
  const changed = { ...defaultSkills, 'image-production': false }
  assert.equal((await f.app.inject({ method: 'PUT', url: '/api/settings/skills', headers: alice.headers, payload: changed })).statusCode, 200)
  assert.deepEqual((await f.store.skills(f.alice.id)), changed)
  assert.deepEqual((await f.store.skills(f.bob.id)), defaultSkills)
  const relogin = await f.login()
  assert.deepEqual((await f.app.inject({ url: '/api/settings', headers: relogin.headers })).json().skills, changed)
  assert.equal((await f.app.inject({ method: 'PUT', url: '/api/settings/skills', headers: alice.headers, payload: { ...changed, custom: 'untrusted skill' } })).statusCode, 400)
  const settings = (await f.app.inject({ url: '/api/settings', headers: alice.headers })).json()
  assert.equal(settings.model.configured, false)
  assert.equal(JSON.stringify(settings).includes('password'), false)
})

test('official AHP client streams, reconnects and cannot duplicate an accepted turn', async t => {
  const f = await fixture(t)
  const login = await f.login()
  const conversation = (await f.store.createConversation(f.alice.id, 'Streaming'))
  const channel = conversation.state.resource
  const connection = await connect(f.wsUrl, login.cookie, channel)
  t.after(() => connection.client.shutdown())
  const actions: string[] = []
  const consume = (async () => {
    for await (const event of connection.subscription) if (event.type === 'action') actions.push(event.params.action.type)
  })()
  connection.client.dispatch(channel, {
    type: ActionType.ChatTurnStarted, turnId: randomUUID(), startedAt: new Date().toISOString(),
    message: { text: 'hello', origin: { kind: MessageKind.User } },
  })
  await until(async () => (await f.store.conversation(f.alice.id, conversation.id)).state.turns.length === 1)
  const original = connection.transport.sent.find(text => JSON.parse(text).method === 'dispatchAction')!
  connection.socket.send(original)
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(f.agent.requests.length, 1)
  assert.equal(actions.includes(ActionType.ChatDelta), true)
  const persisted = (await f.store.conversation(f.alice.id, conversation.id)).state
  assert.equal(persisted.turns[0].responseParts.find(part => part.kind === ResponsePartKind.Markdown)?.content, 'Hello from fixture')
  await connection.client.shutdown()
  await consume
  const reconnected = await connect(f.wsUrl, login.cookie, channel)
  t.after(() => reconnected.client.shutdown())
  assert.deepEqual(reconnected.initialized.snapshots[0].state, persisted)
  assert.equal(f.agent.requests.length, 1)
})

test('tool execution waits for authenticated AHP approval and survives browser disconnect', async t => {
  const f = await fixture(t)
  const login = await f.login()
  const conversation = (await f.store.createConversation(f.alice.id, 'Approval'))
  const channel = conversation.state.resource
  const turnId = randomUUID()
  const first = await connect(f.wsUrl, login.cookie, channel)
  first.client.dispatch(channel, {
    type: ActionType.ChatTurnStarted, turnId, startedAt: new Date().toISOString(),
    message: { text: 'tool', origin: { kind: MessageKind.User } },
  })
  await until(async () => Boolean((await f.store.conversation(f.alice.id, conversation.id)).state.activeTurn?.responseParts.length))
  assert.equal((await f.store.conversation(f.alice.id, conversation.id)).state.turns.length, 0)
  await first.client.shutdown()
  const second = await connect(f.wsUrl, login.cookie, channel)
  t.after(() => second.client.shutdown())
  second.client.dispatch(channel, { type: ActionType.ChatToolCallConfirmed, turnId, toolCallId: 'fixture-tool', approved: true, confirmed: ToolCallConfirmationReason.UserAction })
  await until(async () => (await f.store.conversation(f.alice.id, conversation.id)).state.turns.length === 1)
  const parts = (await f.store.conversation(f.alice.id, conversation.id)).state.turns[0].responseParts
  assert.equal(parts.some(part => part.kind === ResponsePartKind.Markdown && part.content === 'Approved fixture result'), true)
  assert.equal(parts.some(part => part.kind === ResponsePartKind.ToolCall && part.toolCall.status === 'completed' && part.toolCall.success), true)
})

test('AHP channel ownership and server-only actions cannot be bypassed', async t => {
  const f = await fixture(t)
  const alice = await f.login()
  const bob = await f.login('bob')
  const conversation = (await f.store.createConversation(f.alice.id, 'Private'))
  const connection = await connect(f.wsUrl, bob.cookie, 'ahp-root://')
  t.after(() => connection.client.shutdown())
  await assert.rejects(connection.client.subscribe(conversation.state.resource), /不存在/)
  const own = await connect(f.wsUrl, alice.cookie, conversation.state.resource)
  t.after(() => own.client.shutdown())
  const error = new Promise<string>(resolve => own.socket.on('message', data => {
    const message = JSON.parse(data.toString())
    if (message.method === 'x-studio/error') resolve(message.params.message)
  }))
  own.socket.send(JSON.stringify({ jsonrpc: '2.0', method: 'dispatchAction', params: {
    channel: conversation.state.resource, clientSeq: 900,
    action: { type: 'chat/turnComplete', turnId: randomUUID(), duration: 0 },
  } }))
  assert.match(await error, /无效/)
  assert.equal(f.agent.requests.length, 0)
})

test('stop aborts the active agent and does not rerun it', async t => {
  const f = await fixture(t)
  const login = await f.login()
  const conversation = (await f.store.createConversation(f.alice.id, 'Stop'))
  const turnId = randomUUID()
  const connection = await connect(f.wsUrl, login.cookie, conversation.state.resource)
  t.after(() => connection.client.shutdown())
  connection.client.dispatch(conversation.state.resource, {
    type: ActionType.ChatTurnStarted, turnId, startedAt: new Date().toISOString(),
    message: { text: 'wait', origin: { kind: MessageKind.User } },
  })
  await until(() => f.agent.requests.length === 1)
  connection.client.dispatch(conversation.state.resource, { type: ActionType.ChatTurnCancelled, turnId, duration: 0 })
  await until(async () => (await f.store.conversation(f.alice.id, conversation.id)).state.turns.length === 1)
  assert.equal(f.agent.requests[0].signal.aborted, true)
  assert.equal((await f.store.conversation(f.alice.id, conversation.id)).state.turns[0].state, 'cancelled')
  assert.equal(f.agent.requests.length, 1)
})

test('startup marks interrupted turns explicitly without paid retries', async t => {
  const f = await fixture(t)
  const conversation = (await f.store.createConversation(f.alice.id, 'Restart'))
  await f.store.apply(f.alice.id, conversation.id, {
    type: ActionType.ChatTurnStarted, turnId: randomUUID(), startedAt: new Date().toISOString(),
    message: { text: 'in progress', origin: { kind: MessageKind.User } },
  })
  const agent = new FixtureAgent()
  const host = new AgentHost(f.store, agent, () => {})
  await host.initialize()
  const state = (await f.store.conversation(f.alice.id, conversation.id)).state
  assert.equal(state.activeTurn, undefined)
  assert.equal(state.turns[0].state, 'error')
  assert.equal(state.turns[0].responseParts.some(part => part.kind === ResponsePartKind.Error && part.error.errorType === 'interrupted'), true)
  assert.equal(agent.requests.length, 0)
  await host.close()
})

test('logout revokes the cookie and closes existing AHP connections', async t => {
  const f = await fixture(t)
  const login = await f.login()
  const connection = await connect(f.wsUrl, login.cookie, 'ahp-root://')
  const closed = new Promise<number>(resolve => connection.socket.once('close', code => resolve(code)))
  assert.equal((await f.app.inject({ method: 'POST', url: '/api/logout', headers: login.headers, payload: {} })).statusCode, 200)
  assert.equal(await closed, 4001)
  assert.equal((await f.app.inject({ url: '/api/me', headers: login.headers })).statusCode, 401)
  await connection.client.shutdown()
})

test('configured MCP tools are limited to enabled skills and never expose secrets publicly', async t => {
  const f = await fixture(t)
  const file = join(f.dataDir, 'tools.json')
  await writeFile(file, JSON.stringify({ servers: [{
    id: 'images', label: 'Images', skill: 'image-production',
    url: 'https://tools.example/mcp', tokenEnv: 'IMAGE_TOKEN', tools: ['generate_image'],
  }] }))
  const registry = new ToolRegistry(file, { IMAGE_TOKEN: 'fixture-secret' })
  assert.equal(JSON.stringify(registry.publicTools()).includes('fixture-secret'), false)
  const effective = registry.effective(defaultSkills, f.alice.id)
  assert.deepEqual(effective.allowed.toArray(), ['builtin:skill', 'mcp:images-generate_image'])
  assert.deepEqual(registry.effective({ ...defaultSkills, 'image-production': false }, f.alice.id).servers, {})
  assert.throws(() => new ToolRegistry(file, {}).effective(defaultSkills, f.alice.id), /Missing credential/)
  assert.equal(effective.servers.images.type, 'http')
})

test('production identity and origin configuration fail closed', () => {
  assert.throws(() => readConfig({ NODE_ENV: 'production', AZURE_AUTH_MODE: 'azure-cli' }), /forbidden/)
  assert.throws(() => readConfig({ APP_ORIGIN: 'http://public.example' }), /HTTPS/)
  assert.throws(() => readConfig({ AZURE_MODEL_ENDPOINT: 'http://models.example' }), /HTTPS/)
})

test('model selection is authenticated, persisted, owner-scoped and locked during a turn', async t => {
  const f = await fixture(t, new FixtureAgent(), modelCatalogFixture())
  const alice = await f.login()
  const bob = await f.login('bob')
  assert.equal((await f.app.inject('/api/models')).statusCode, 401)
  const listed = await f.app.inject({ url: '/api/models', headers: alice.headers })
  assert.deepEqual(listed.json().models.map((model: { id: string }) => model.id), ['fixture-model', 'fixture-model-b'])
  const created = await f.app.inject({ method: 'POST', url: '/api/conversations', headers: alice.headers, payload: { title: 'Models', model: 'fixture-model-b' } })
  assert.equal(created.statusCode, 200)
  const conversation = created.json<{ id: string; chat: string; model: string }>()
  assert.equal(conversation.model, 'fixture-model-b')
  const url = `/api/conversations/${conversation.id}/model`
  assert.equal((await f.app.inject({ method: 'PUT', url, headers: bob.headers, payload: { model: 'fixture-model' } })).statusCode, 404)
  assert.equal((await f.app.inject({ method: 'PUT', url, headers: { cookie: alice.cookie, origin: f.config.origin }, payload: { model: 'fixture-model' } })).statusCode, 403)
  assert.equal((await f.app.inject({ method: 'PUT', url, headers: alice.headers, payload: { model: 'image' } })).statusCode, 400)
  assert.equal((await f.app.inject({ method: 'PUT', url, headers: alice.headers, payload: { model: 'fixture-model' } })).statusCode, 200)
  const connection = await connect(f.wsUrl, alice.cookie, conversation.chat)
  t.after(() => connection.client.shutdown())
  const turnId = randomUUID()
  connection.client.dispatch(conversation.chat, {
    type: ActionType.ChatTurnStarted, turnId, startedAt: new Date().toISOString(),
    message: { text: 'wait', origin: { kind: MessageKind.User } },
  })
  await until(() => f.agent.requests.length === 1)
  assert.equal(f.agent.requests[0].conversation.model, 'fixture-model')
  assert.equal((await f.app.inject({ method: 'PUT', url, headers: alice.headers, payload: { model: 'fixture-model-b' } })).statusCode, 409)
  connection.client.dispatch(conversation.chat, { type: ActionType.ChatTurnCancelled, turnId, duration: 0 })
  await until(async () => (await f.store.conversation(f.alice.id, conversation.id)).state.turns.length === 1)
  const changed = await f.app.inject({ method: 'PUT', url, headers: alice.headers, payload: { model: 'fixture-model-b' } })
  assert.equal(changed.statusCode, 200)
  assert.equal((await f.store.conversation(f.alice.id, conversation.id)).model, 'fixture-model-b')
  assert.equal((await f.store.conversation(f.alice.id, conversation.id)).state.turns.length, 1)
})

test('skill changes are applied to the next turn, not shared with another account', async t => {
  const f = await fixture(t)
  const login = await f.login()
  const conversation = (await f.store.createConversation(f.alice.id, 'Skill selection'))
  const connection = await connect(f.wsUrl, login.cookie, conversation.state.resource)
  t.after(() => connection.client.shutdown())
  const choices = { ...defaultSkills, 'image-production': false }
  await f.app.inject({ method: 'PUT', url: '/api/settings/skills', headers: login.headers, payload: choices })
  connection.client.dispatch(conversation.state.resource, {
    type: ActionType.ChatTurnStarted, turnId: randomUUID(), startedAt: new Date().toISOString(),
    message: { text: 'hello', origin: { kind: MessageKind.User } },
  })
  await until(async () => (await f.store.conversation(f.alice.id, conversation.id)).state.turns.length === 1)
  assert.deepEqual(f.agent.requests[0].skills, choices)
  assert.deepEqual((await f.store.skills(f.bob.id)), defaultSkills)
})
