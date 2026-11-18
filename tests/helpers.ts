import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import type { TestContext } from 'node:test'
import { WebSocket } from 'ws'
import { AhpClient } from '@microsoft/agent-host-protocol/client'
import type { AhpTransport, TransportFrame } from '@microsoft/agent-host-protocol/client'
import { PROTOCOL_VERSION } from '@microsoft/agent-host-protocol'
import { buildApp } from '../server/app.js'
import { readConfig } from '../server/config.js'
import { hashPassword } from '../server/auth.js'
import type { Agent, AgentRequest } from '../server/agent.js'
import type { UserInfo } from '../src/shared.js'
import { ModelCatalog } from '../server/models.js'

export function modelCatalogFixture() {
  const config = readConfig({
    AZURE_MODEL_ENDPOINT: 'https://models.example/openai/v1/',
    AZURE_FOUNDRY_RESOURCE_ID: '/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/test/providers/Microsoft.CognitiveServices/accounts/fixture',
  })
  const definitions = [
    { name: 'fixture-model', version: '1', format: 'OpenAI', capabilities: { responses: 'true', chatCompletion: 'true' } },
    { name: 'fixture-model-b', version: '2', format: 'OpenAI', capabilities: { responses: 'true', chatCompletion: 'true' } },
    { name: 'embedding', version: '1', format: 'OpenAI', capabilities: { embeddings: 'true' } },
    { name: 'image', version: '1', format: 'OpenAI', capabilities: { imageGeneration: 'true' } },
  ]
  const request: typeof fetch = async url => Response.json({
    value: String(url).includes('/deployments?') ? definitions.map(model => ({
      name: model.name, properties: { provisioningState: 'Succeeded', model },
    })) : definitions,
  })
  return new ModelCatalog(config, { getToken: async () => ({ token: 'catalog-fixture-token', expiresOnTimestamp: Date.now() + 3600_000 }) }, request)
}
export function imageCatalogFixture() {
  const config = readConfig({
    AZURE_IMAGE_ENDPOINT: 'https://images.example/openai/v1/', AZURE_IMAGE_DEPLOYMENT: 'gpt-image-2.5-flare',
    AZURE_IMAGE_FOUNDRY_RESOURCE_ID: '/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/test/providers/Microsoft.CognitiveServices/accounts/images',
  })
  const definitions = ['gpt-image-2', 'gpt-image-2.5-flare', 'gpt-image-2.5-sunburst', 'chat'].map(name => ({
    name, version: '1', format: 'OpenAI', capabilities: name === 'chat'
      ? { responses: 'true', chatCompletion: 'true' } : { imageGenerations: 'true', imageEdits: 'true' },
  }))
  const request: typeof fetch = async url => Response.json({
    value: String(url).includes('/deployments?') ? definitions.map(model => ({
      name: model.name, properties: { provisioningState: 'Succeeded', model },
    })) : definitions,
  })
  return new ModelCatalog(config, { getToken: async () => ({ token: 'image-catalog-fixture-token', expiresOnTimestamp: Date.now() + 3600000 }) }, request, 'image')
}

export class FixtureAgent implements Agent {
  requests: AgentRequest[] = []
  assertConfigured() {}
  async run(request: AgentRequest) {
    this.requests.push(request)
    if (request.prompt === 'wait') {
      await new Promise<void>(resolve => request.signal.addEventListener('abort', () => resolve(), { once: true }))
      return
    }
    if (request.prompt === 'tool' || request.prompt === 'assisted-tool' || request.prompt === 'managed-tool') {
      request.emit({ type: 'tool-start', id: 'fixture-tool', name: 'image / generate' })
      const approved = await request.approve('fixture-tool', 'image / generate', '{"prompt":"fixture"}', request.prompt === 'assisted-tool', request.prompt === 'managed-tool')
      if (approved) {
        request.emit({ type: 'tool-start', id: 'fixture-tool', name: 'image / generate' })
        request.emit({ type: 'tool-complete', id: 'fixture-tool', success: true })
      }
      request.emit({ type: 'text', id: 'answer', delta: approved ? 'Approved fixture result' : 'Not executed' })
      return
    }
    request.emit({ type: 'text', id: 'answer', delta: 'Hello ' })
    await new Promise(resolve => setTimeout(resolve, 15))
    request.emit({ type: 'text', id: 'answer', delta: 'from fixture' })
  }
  async close() {}
}
export async function fixture(t: TestContext, agent = new FixtureAgent(), models?: ModelCatalog, imageModels?: ModelCatalog) {
  const dataDir = await mkdtemp(join(tmpdir(), 'copilot-studio-test-'))
  const config = readConfig({
    DATA_DIR: dataDir, TOOLS_FILE: join(dataDir, 'tools.json'),
    ...(imageModels ? { AZURE_IMAGE_ENDPOINT: 'https://images.example/openai/v1/', AZURE_IMAGE_DEPLOYMENT: 'gpt-image-2.5-flare' } : {}),
  })
  const result = await buildApp(config, { agent, models, imageModels, serveUi: false, logger: false })
  const password = await hashPassword('test-password-1234')
  const alice = (await result.store.createUser('alice', password))
  const bob = (await result.store.createUser('bob', password))
  await result.app.listen({ host: '127.0.0.1', port: 0 })
  t.after(async () => { await result.app.close(); await rm(dataDir, { recursive: true, force: true }) })
  const address = result.app.server.address()
  if (!address || typeof address === 'string') throw new Error('Missing fixture address')
  async function login(username = 'alice') {
    const response = await result.app.inject({
      method: 'POST', url: '/api/login', headers: { origin: config.origin },
      payload: { username, password: 'test-password-1234' },
    })
    if (response.statusCode !== 200) throw new Error(`Fixture login failed: ${response.body}`)
    const user = response.json<UserInfo>()
    const cookie = response.cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ')
    return { user, cookie, headers: { cookie, origin: config.origin, 'x-csrf-token': user.csrf } }
  }
  return { ...result, agent, dataDir, config, alice, bob, login, wsUrl: `ws://127.0.0.1:${address.port}/api/ahp` }
}

class TestTransport implements AhpTransport {
  private queue: (TransportFrame | null)[] = []
  private waiting: ((frame: TransportFrame | null) => void)[] = []
  sent: string[] = []
  constructor(readonly socket: WebSocket) {
    socket.on('message', data => this.push({ kind: 'text', text: data.toString() }))
    socket.on('close', () => this.push(null))
  }
  private push(frame: TransportFrame | null) {
    const waiter = this.waiting.shift()
    if (waiter) waiter(frame)
    else this.queue.push(frame)
  }
  send(message: Parameters<AhpTransport['send']>[0]) {
    const text = typeof message === 'string' ? message : JSON.stringify(message)
    this.sent.push(text)
    this.socket.send(text)
  }
  async recv(): Promise<TransportFrame | null> {
    if (this.queue.length) return this.queue.shift()!
    if (this.socket.readyState === WebSocket.CLOSED) return null
    return new Promise(resolve => this.waiting.push(resolve))
  }
  async close() {
    if (this.socket.readyState === WebSocket.CLOSED) return
    const closed = once(this.socket, 'close')
    this.socket.close()
    await closed
  }
}
export async function connect(url: string, cookie: string, channel: string, clientId = crypto.randomUUID()) {
  const socket = new WebSocket(url, { headers: { Cookie: cookie, Origin: 'http://127.0.0.1:4310' } })
  await once(socket, 'open')
  const transport = new TestTransport(socket)
  const client = new AhpClient(transport, { requestTimeoutMs: 2000 })
  const subscription = client.attachSubscription(channel)
  client.connect()
  const initialized = await client.initialize({ clientId, protocolVersions: [PROTOCOL_VERSION], initialSubscriptions: [channel] })
  return { socket, transport, client, subscription, initialized }
}
export async function until(predicate: () => boolean | Promise<boolean>, timeout = 3000) {
  const end = Date.now() + timeout
  while (!await predicate()) {
    if (Date.now() > end) throw new Error('Timed out waiting for expected state')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}
