import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ActionType, MessageKind, ResponsePartKind, ToolCallConfirmationReason } from '@microsoft/agent-host-protocol'
import type { ChatState } from '@microsoft/agent-host-protocol'
import { fixture, connect, until } from './helpers.js'
import { ToolRegistry } from '../server/tools.js'
import { readConfig } from '../server/config.js'
import { defaultSkills } from '../src/shared.js'
import { AgentHost } from '../server/host.js'
import { FixtureAgent } from './helpers.js'

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
  assert.deepEqual(f.store.skills(f.alice.id), changed)
  assert.deepEqual(f.store.skills(f.bob.id), defaultSkills)
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
  const conversation = f.store.createConversation(f.alice.id, 'Streaming')
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
  await until(() => f.store.conversation(f.alice.id, conversation.id).state.turns.length === 1)
  const original = connection.transport.sent.find(text => JSON.parse(text).method === 'dispatchAction')!
  connection.socket.send(original)
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(f.agent.requests.length, 1)
  assert.equal(actions.includes(ActionType.ChatDelta), true)
  const persisted = f.store.conversation(f.alice.id, conversation.id).state
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
  const conversation = f.store.createConversation(f.alice.id, 'Approval')
  const channel = conversation.state.resource
  const turnId = randomUUID()
  const first = await connect(f.wsUrl, login.cookie, channel)
  first.client.dispatch(channel, {
    type: ActionType.ChatTurnStarted, turnId, startedAt: new Date().toISOString(),
    message: { text: 'tool', origin: { kind: MessageKind.User } },
  })
  await until(() => Boolean(f.store.conversation(f.alice.id, conversation.id).state.activeTurn?.responseParts.length))
  assert.equal(f.store.conversation(f.alice.id, conversation.id).state.turns.length, 0)
  await first.client.shutdown()
  const second = await connect(f.wsUrl, login.cookie, channel)
  t.after(() => second.client.shutdown())
  second.client.dispatch(channel, { type: ActionType.ChatToolCallConfirmed, turnId, toolCallId: 'fixture-tool', approved: true, confirmed: ToolCallConfirmationReason.UserAction })
  await until(() => f.store.conversation(f.alice.id, conversation.id).state.turns.length === 1)
  const parts = f.store.conversation(f.alice.id, conversation.id).state.turns[0].responseParts
  assert.equal(parts.some(part => part.kind === ResponsePartKind.Markdown && part.content === 'Approved fixture result'), true)
  assert.equal(parts.some(part => part.kind === ResponsePartKind.ToolCall && part.toolCall.status === 'completed' && part.toolCall.success), true)
})

test('AHP channel ownership and server-only actions cannot be bypassed', async t => {
  const f = await fixture(t)
  const alice = await f.login()
  const bob = await f.login('bob')
  const conversation = f.store.createConversation(f.alice.id, 'Private')
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
  const conversation = f.store.createConversation(f.alice.id, 'Stop')
  const turnId = randomUUID()
  const connection = await connect(f.wsUrl, login.cookie, conversation.state.resource)
  t.after(() => connection.client.shutdown())
  connection.client.dispatch(conversation.state.resource, {
    type: ActionType.ChatTurnStarted, turnId, startedAt: new Date().toISOString(),
    message: { text: 'wait', origin: { kind: MessageKind.User } },
  })
  await until(() => f.agent.requests.length === 1)
  connection.client.dispatch(conversation.state.resource, { type: ActionType.ChatTurnCancelled, turnId, duration: 0 })
  await until(() => f.store.conversation(f.alice.id, conversation.id).state.turns.length === 1)
  assert.equal(f.agent.requests[0].signal.aborted, true)
  assert.equal(f.store.conversation(f.alice.id, conversation.id).state.turns[0].state, 'cancelled')
  assert.equal(f.agent.requests.length, 1)
})

test('startup marks interrupted turns explicitly without paid retries', async t => {
  const f = await fixture(t)
  const conversation = f.store.createConversation(f.alice.id, 'Restart')
  f.store.apply(f.alice.id, conversation.id, {
    type: ActionType.ChatTurnStarted, turnId: randomUUID(), startedAt: new Date().toISOString(),
    message: { text: 'in progress', origin: { kind: MessageKind.User } },
  })
  const agent = new FixtureAgent()
  const host = new AgentHost(f.store, agent, () => {})
  const state = f.store.conversation(f.alice.id, conversation.id).state
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

test('skill changes are applied to the next turn, not shared with another account', async t => {
  const f = await fixture(t)
  const login = await f.login()
  const conversation = f.store.createConversation(f.alice.id, 'Skill selection')
  const connection = await connect(f.wsUrl, login.cookie, conversation.state.resource)
  t.after(() => connection.client.shutdown())
  const choices = { ...defaultSkills, 'image-production': false }
  await f.app.inject({ method: 'PUT', url: '/api/settings/skills', headers: login.headers, payload: choices })
  connection.client.dispatch(conversation.state.resource, {
    type: ActionType.ChatTurnStarted, turnId: randomUUID(), startedAt: new Date().toISOString(),
    message: { text: 'hello', origin: { kind: MessageKind.User } },
  })
  await until(() => f.store.conversation(f.alice.id, conversation.id).state.turns.length === 1)
  assert.deepEqual(f.agent.requests[0].skills, choices)
  assert.deepEqual(f.store.skills(f.bob.id), defaultSkills)
})
