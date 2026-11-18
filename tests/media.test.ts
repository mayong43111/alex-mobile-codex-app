import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import sharp from 'sharp'
import { z } from 'zod'
import { ActionType, MessageAttachmentKind, MessageKind, ResponsePartKind, ToolCallCancellationReason, ToolCallConfirmationReason } from '@microsoft/agent-host-protocol'
import type { AgentRequest, AgentOutput } from '../server/agent.js'
import { ImageGeneration } from '../server/image-generation.js'
import { readConfig } from '../server/config.js'
import { defaultSkills, imageLimits } from '../src/shared.js'
import type { AttachmentInfo } from '../src/shared.js'
import { connect, fixture, until, imageCatalogFixture, FixtureAgent } from './helpers.js'

const picture = (width = 64, height = 48) => sharp({ create: { width, height, channels: 3, background: '#315f91' } }).png().toBuffer()
const toolResult = z.object({ resultType: z.enum(['success', 'failure', 'rejected']), textResultForLlm: z.string() })

test('uploads enforce bytes, dimensions, format, CSRF and private ownership', async t => {
  const f = await fixture(t)
  const alice = await f.login()
  const bob = await f.login('bob')
  const upload = (payload: Buffer, headers = alice.headers) => f.app.inject({
    method: 'POST', url: '/api/attachments?name=sample.png', headers: { ...headers, 'content-type': 'image/png' }, payload,
  })
  const response = await upload(await picture())
  assert.equal(response.statusCode, 200, response.body)
  const image = response.json<AttachmentInfo>()
  assert.deepEqual([image.width, image.height, image.mime], [64, 48, 'image/webp'])
  const read = await f.app.inject({ url: image.url, headers: alice.headers })
  assert.equal(read.statusCode, 200)
  assert.equal((await sharp(read.rawPayload).metadata()).format, 'webp')
  assert.equal((await f.app.inject({ url: image.url, headers: bob.headers })).statusCode, 404)
  assert.equal((await f.app.inject(image.url)).statusCode, 401)
  assert.equal((await upload(await picture(), { cookie: alice.cookie, origin: f.config.origin, 'x-csrf-token': '' })).statusCode, 403)
  assert.equal((await upload(Buffer.alloc(imageLimits.uploadBytes + 1))).statusCode, 413)
  assert.equal((await upload(await picture(2049, 1))).statusCode, 413)
  assert.equal((await upload(Buffer.from('<svg></svg>'))).statusCode, 415)
})

test('AHP canonicalizes owned image references, accepts image-only turns and rejects foreign or excess references', async t => {
  const f = await fixture(t)
  const alice = await f.login()
  const image = await f.attachments.save(f.alice.id, await picture(), 'real.png')
  const foreign = await f.attachments.save(f.bob.id, await picture(), 'private.png')
  const conversation = (await f.store.createConversation(f.alice.id, 'Images'))
  const connection = await connect(f.wsUrl, alice.cookie, conversation.state.resource)
  t.after(() => connection.client.shutdown())
  const errors: string[] = []
  connection.socket.on('message', data => {
    const message = JSON.parse(data.toString())
    if (message.method === 'x-studio/error') errors.push(message.params.message)
  })
  const reference = (id: string) => ({ type: MessageAttachmentKind.Resource as const, uri: `studio-attachment:/${id}`, label: 'forged', contentType: 'text/html' })
  const send = (attachments: ReturnType<typeof reference>[]) => connection.client.dispatch(conversation.state.resource, {
    type: ActionType.ChatTurnStarted, turnId: randomUUID(), startedAt: new Date().toISOString(),
    message: { text: '', origin: { kind: MessageKind.User }, attachments },
  })
  send([reference(foreign.id)])
  await until(() => errors.length === 1)
  assert.equal(f.agent.requests.length, 0)
  send(Array.from({ length: 7 }, () => reference(image.id)))
  await until(() => errors.length === 2)
  assert.equal(f.agent.requests.length, 0)
  send([reference(image.id)])
  await until(async () => (await f.store.conversation(f.alice.id, conversation.id)).state.turns.length === 1)
  assert.deepEqual(f.agent.requests[0].attachments, [image])
  const saved = (await f.store.conversation(f.alice.id, conversation.id)).state.turns[0].message.attachments?.[0]
  assert.equal(saved?.label, 'real.png')
  assert.equal(saved?.type === MessageAttachmentKind.Resource && saved.contentType, 'image/webp')
})

test('permission mode is session-scoped, owner checked, locked during work, and manual denial never executes', async t => {
  const f = await fixture(t)
  const alice = await f.login()
  const bob = await f.login('bob')
  const conversation = (await f.store.createConversation(f.alice.id, 'Permissions'))
  const url = `/api/conversations/${conversation.id}/permissions`
  const set = (permissionMode: string, headers = alice.headers) => f.app.inject({ method: 'PUT', url, headers, payload: { permissionMode } })
  assert.equal((await set('allow-all', bob.headers)).statusCode, 404)
  assert.equal((await set('allow-all', { ...alice.headers, 'x-csrf-token': '' })).statusCode, 403)
  assert.equal((await set('invalid')).statusCode, 400)
  assert.equal((await set('allow-all')).json().permissionMode, 'allow-all')
  assert.equal(f.store.summary((await f.store.createConversation(f.alice.id, 'Other'))).permissionMode, 'manual')
  const connection = await connect(f.wsUrl, alice.cookie, conversation.state.resource)
  t.after(() => connection.client.shutdown())
  const send = (text: string) => {
    const turnId = randomUUID()
    connection.client.dispatch(conversation.state.resource, { type: ActionType.ChatTurnStarted, turnId, startedAt: new Date().toISOString(), message: { text, origin: { kind: MessageKind.User } } })
    return turnId
  }
  send('tool')
  await until(async () => (await f.store.conversation(f.alice.id, conversation.id)).state.turns.length === 1)
  const tool = (await f.store.conversation(f.alice.id, conversation.id)).state.turns[0].responseParts.find(part => part.kind === ResponsePartKind.ToolCall)
  assert.equal(tool?.toolCall.status, 'completed')
  assert.equal(tool?.toolCall.confirmed, ToolCallConfirmationReason.NotNeeded)
  assert.equal((await set('manual')).statusCode, 200)
  const turnId = send('tool')
  await until(async () => Boolean((await f.store.conversation(f.alice.id, conversation.id)).state.activeTurn?.responseParts.some(part => part.kind === ResponsePartKind.ToolCall && part.toolCall.status === 'pending-confirmation')))
  assert.equal((await set('allow-all')).statusCode, 409)
  connection.client.dispatch(conversation.state.resource, { type: ActionType.ChatToolCallConfirmed, turnId, toolCallId: 'fixture-tool', approved: false, reason: ToolCallCancellationReason.Denied })
  await until(async () => (await f.store.conversation(f.alice.id, conversation.id)).state.turns.length === 2)
  assert.ok((await f.store.conversation(f.alice.id, conversation.id)).state.turns[1].responseParts.some(part => part.kind === ResponsePartKind.Markdown && part.content === 'Not executed'))
  assert.equal((await set('assisted')).statusCode, 200)
  send('assisted-tool')
  await until(async () => (await f.store.conversation(f.alice.id, conversation.id)).state.turns.length === 3)
  const assisted = (await f.store.conversation(f.alice.id, conversation.id)).state.turns[2].responseParts.find(part => part.kind === ResponsePartKind.ToolCall)
  assert.equal(assisted?.toolCall.status, 'completed')
  assert.equal(assisted?.toolCall.confirmed, ToolCallConfirmationReason.NotNeeded)
  const pending = send('tool')
  await until(async () => Boolean((await f.store.conversation(f.alice.id, conversation.id)).state.activeTurn?.responseParts.some(part => part.kind === ResponsePartKind.ToolCall && part.toolCall.status === 'pending-confirmation')))
  connection.client.dispatch(conversation.state.resource, { type: ActionType.ChatToolCallConfirmed, turnId: pending, toolCallId: 'fixture-tool', approved: false, reason: ToolCallCancellationReason.Denied })
  await until(async () => (await f.store.conversation(f.alice.id, conversation.id)).state.turns.length === 4)
  assert.equal((await set('allow-all')).statusCode, 200)
  const managed = send('managed-tool')
  await until(async () => Boolean((await f.store.conversation(f.alice.id, conversation.id)).state.activeTurn?.responseParts.some(part => part.kind === ResponsePartKind.ToolCall && part.toolCall.status === 'pending-confirmation')))
  connection.client.dispatch(conversation.state.resource, { type: ActionType.ChatToolCallConfirmed, turnId: managed, toolCallId: 'fixture-tool', approved: false, reason: ToolCallCancellationReason.Denied })
  await until(async () => (await f.store.conversation(f.alice.id, conversation.id)).state.turns.length === 5)
})

test('image model choices use actual deployments, default to Flare, persist per user, and control provider requests', async t => {
  const f = await fixture(t, new FixtureAgent(), undefined, imageCatalogFixture())
  const alice = await f.login()
  const bob = await f.login('bob')
  assert.equal((await f.app.inject('/api/image-models')).statusCode, 401)
  const catalog = (await f.app.inject({ url: '/api/image-models', headers: alice.headers })).json()
  assert.equal(catalog.selectedModel, 'gpt-image-2.5-flare')
  assert.deepEqual(catalog.models.map((model: { id: string }) => model.id), ['gpt-image-2', 'gpt-image-2.5-flare', 'gpt-image-2.5-sunburst'])
  const choose = (model: string, headers = alice.headers) => f.app.inject({ method: 'PUT', url: '/api/settings/image', headers, payload: { model } })
  assert.equal((await choose('gpt-image-2', { ...alice.headers, 'x-csrf-token': '' })).statusCode, 403)
  assert.equal((await choose('chat')).statusCode, 400)
  assert.equal((await choose('undeployed')).statusCode, 400)
  assert.equal((await choose('gpt-image-2')).statusCode, 200)
  assert.equal((await f.app.inject({ url: '/api/settings', headers: (await f.login()).headers })).json().image.model, 'gpt-image-2')
  assert.equal((await f.app.inject({ url: '/api/settings', headers: bob.headers })).json().image.model, 'gpt-image-2.5-flare')
  let actualModel = ''
  const generated = await picture()
  const service = new ImageGeneration(f.config, f.attachments, f.store,
    { getToken: async () => ({ token: 'fixture', expiresOnTimestamp: Date.now() + 3600000 }) },
    async (_url, options) => { actualModel = JSON.parse(String(options?.body)).model; return Response.json({ data: [{ b64_json: generated.toString('base64') }] }) }, imageCatalogFixture())
  const conversation = (await f.store.createConversation(f.alice.id, 'Selected image model'))
  const tool = (await service.definition({ conversation, prompt: 'Generate', skills: { ...defaultSkills }, signal: new AbortController().signal, emit: () => {}, approve: async () => true, saveRuntimeId: () => {} }))
  assert.ok(tool.handler)
  const args = { prompt: 'A blue square', size: '1024x1024', quality: 'auto' as const }
  assert.equal(toolResult.parse(await tool.handler(args, { sessionId: 'choice', toolCallId: 'selected', toolName: 'image_generation', arguments: args })).resultType, 'success')
  assert.equal(actualModel, 'gpt-image-2')
  await f.store.apply(f.alice.id, conversation.id, { type: ActionType.ChatTurnStarted, turnId: randomUUID(), startedAt: new Date().toISOString(), message: { text: 'wait', origin: { kind: MessageKind.User } } })
  assert.equal((await choose('gpt-image-2.5-flare')).statusCode, 409)
})

test('image_generation calls the configured deployment, saves private output and deduplicates paid submissions', async t => {
  const f = await fixture(t)
  const generated = await picture(1024, 1024)
  const calls: { url: string; options: RequestInit }[] = []
  const request: typeof fetch = async (url, options) => {
    calls.push({ url: String(url), options: options! })
    return Response.json({ data: [{ b64_json: generated.toString('base64') }] })
  }
  const service = new ImageGeneration({ ...f.config, imageEndpoint: 'https://images.example/openai/v1/', imageDeployment: 'gpt-image-2' }, f.attachments, f.store,
    { getToken: async () => ({ token: 'image-fixture-token', expiresOnTimestamp: Date.now() + 3600000 }) }, request)
  const output: AgentOutput[] = []
  const conversation = (await f.store.createConversation(f.alice.id, 'Generate'))
  const turn: AgentRequest = {
    conversation, prompt: 'generate', skills: { ...defaultSkills }, signal: new AbortController().signal,
    emit: event => { output.push(event) }, approve: async () => true, saveRuntimeId: () => {},
  }
  const tool = (await service.definition(turn))
  const handler = tool.handler
  assert.ok(handler)
  const invoke = async (toolCallId: string, prompt = 'A blue square') => toolResult.parse(await handler({ prompt, size: '1024x1024', quality: 'auto' }, { sessionId: 'fixture', toolCallId, toolName: 'image_generation', arguments: { prompt } }))
  const first = await invoke('generation')
  assert.equal(first.resultType, 'success')
  assert.equal(calls[0].url, 'https://images.example/openai/v1/images/generations')
  assert.equal(new Headers(calls[0].options.headers).get('authorization'), 'Bearer image-fixture-token')
  assert.deepEqual(JSON.parse(String(calls[0].options.body)), { model: 'gpt-image-2', prompt: 'A blue square', n: 1, size: '1024x1024', quality: 'auto', output_format: 'png' })
  const imageEvent = output.find(event => event.type === 'image')
  assert.ok(imageEvent)
  assert.equal((await f.attachments.info(f.alice.id, imageEvent.id)).width, 1024)
  await assert.rejects(async () => (await f.attachments.info(f.bob.id, imageEvent.id)), /不存在/)
  assert.deepEqual(await invoke('generation'), first)
  assert.equal(calls.length, 1)
  assert.equal((await invoke('generation', 'Changed content')).resultType, 'failure')
  assert.equal(calls.length, 1)
  const references = await Promise.all(['one', 'two'].map(name => f.attachments.save(f.alice.id, generated, name)))
  turn.attachments = references
  assert.equal((await invoke('edit')).resultType, 'success')
  assert.equal(calls[1].url, 'https://images.example/openai/v1/images/edits')
  assert.ok(calls[1].options.body instanceof FormData)
  assert.equal(calls[1].options.body.getAll('image[]').length, 2)
  assert.equal(calls[1].options.body.get('model'), 'gpt-image-2')
  turn.attachments = []
  await Promise.all([invoke('concurrent'), invoke('concurrent')])
  assert.equal(calls.length, 3)
})

test('rejected, invalid and failed image requests do not substitute models or retry', async t => {
  const f = await fixture(t)
  let calls = 0
  const service = new ImageGeneration({ ...f.config, imageEndpoint: 'https://images.example/openai/v1/', imageDeployment: 'gpt-image-2' }, f.attachments, f.store,
    { getToken: async () => ({ token: 'fixture', expiresOnTimestamp: Date.now() + 3600000 }) },
    async () => { calls++; throw new Error('fixture disconnect') })
  const turn: AgentRequest = {
    conversation: (await f.store.createConversation(f.alice.id, 'Failure')), prompt: 'generate', skills: { ...defaultSkills },
    signal: new AbortController().signal, emit: () => {}, approve: async () => false, saveRuntimeId: () => {},
  }
  const handler = (await service.definition(turn)).handler
  assert.ok(handler)
  const invoke = async (toolCallId: string, args: { prompt?: string; model?: string; size?: string; reference_image_ids?: string[] } = {}) => toolResult.parse(await handler(
    { prompt: 'A square', size: '1024x1024', quality: 'auto', ...args }, { sessionId: 'fixture', toolCallId, toolName: 'image_generation', arguments: args }))
  assert.equal((await invoke('denied')).resultType, 'rejected')
  turn.approve = async () => true
  assert.equal((await invoke('wrong-model', { prompt: 'A square', model: 'other' })).resultType, 'failure')
  assert.equal((await invoke('invalid-size', { prompt: 'A square', size: '9999x9999' })).resultType, 'failure')
  const foreign = await f.attachments.save(f.bob.id, await picture(), 'foreign')
  assert.equal((await invoke('foreign', { prompt: 'Edit', reference_image_ids: [foreign.id] })).resultType, 'failure')
  assert.equal(calls, 0)
  assert.equal((await invoke('unknown')).resultType, 'failure')
  assert.equal((await invoke('unknown')).resultType, 'failure')
  assert.equal(calls, 1)
  assert.equal((await f.store.imageJob(f.alice.id, 'fixture:unknown'))?.status, 'unknown')
  assert.throws(() => readConfig({ AZURE_IMAGE_DEPLOYMENT: 'gpt-image-2' }), /together/)
})
