import { readFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'
import sharp from 'sharp'
import { z } from 'zod'
import type { AgentRun, Asset, Message } from '../src/domain.ts'
import { Store, HttpError } from './store.ts'
import { LocalAssetStorage } from './assets.ts'
import type { AssetStorage } from './assets.ts'

const configSchema = z.object({ gateway: z.literal('http://127.0.0.1:3199'), token: z.string().min(32),
  codex: z.object({ auth: z.enum(['key', 'entra']).optional() }).optional(),
  image: z.object({ auth: z.literal('entra'), subscription: z.string().uuid() }) })
const remoteSchema = z.object({
  id: z.string().uuid(), threadId: z.string().uuid().nullable(),
  status: z.enum(['running', 'completed', 'failed', 'cancelled', 'interrupted']),
  stage: z.enum(['codex', 'image']), reply: z.string().max(20000), error: z.string().optional(),
  imageOperation: z.enum(['generate', 'edit']).optional(),
  progress: z.array(z.object({ id: z.string().max(200), label: z.string().max(120), detail: z.string().max(6000).optional(), createdAt: z.string().datetime() })).max(200).optional(),
  image: z.object({ png: z.string().max(48 * 1024 * 1024), width: z.number(), height: z.number(), model: z.string(), checkpoint: z.string(),
    operation: z.enum(['generate', 'edit']).optional(), sourceAssetId: z.string().uuid().optional(), sourceHash: z.string().regex(/^[0-9a-f]{64}$/).optional() }).optional(),
})
export type RemoteRun = z.infer<typeof remoteSchema>
export type SourceImage = { assetId: string; png: string; hash: string; width: number; height: number }
export interface AgentTransport {
  health(): Promise<unknown>
  submit(run: AgentRun, threadId: string | null, history?: Pick<Message, 'role' | 'text'>[], sourceImage?: SourceImage): Promise<void>
  get(id: string): Promise<RemoteRun>
  stop(id: string): Promise<void>
}

export async function managedModelToken(environment: NodeJS.ProcessEnv = process.env, fetcher: typeof fetch = fetch): Promise<string> {
  if (!environment.IDENTITY_ENDPOINT || !environment.IDENTITY_HEADER) throw new Error('Managed identity unavailable')
  const endpoint = new URL(environment.IDENTITY_ENDPOINT)
  endpoint.searchParams.set('resource', 'https://cognitiveservices.azure.com/')
  endpoint.searchParams.set('api-version', '2019-08-01')
  const response = await fetcher(endpoint, { headers: { 'X-IDENTITY-HEADER': environment.IDENTITY_HEADER }, signal: AbortSignal.timeout(15000) })
  if (!response.ok) throw new Error(`Managed identity HTTP ${response.status}`)
  const result = z.object({ access_token: z.string().min(1).max(16000), expires_on: z.coerce.number() }).parse(await response.json())
  if (result.expires_on < Date.now() / 1000 + 420) throw new Error('Managed identity token expires too soon')
  return result.access_token
}

export async function loadAgentTransport(file: string): Promise<AgentTransport | undefined> {
  let config: z.infer<typeof configSchema>
  try { config = configSchema.parse(JSON.parse(await readFile(file, 'utf8'))) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new Error('Invalid runtime configuration; credential contents omitted')
  }
  async function request(path: string, method = 'GET', body?: unknown): Promise<unknown> {
    const response = await fetch(`${config.gateway}${path}`, { method, signal: AbortSignal.timeout(15000),
      headers: { Authorization: `Bearer ${config.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined })
    if (!response.ok) throw new Error(`Runtime HTTP ${response.status}`)
    return response.json()
  }
  return {
    health: () => request('/health'),
    async submit(run, threadId, history = [], sourceImage) {
      let imageToken: string | undefined
      let codexToken: string | undefined
      if (config.codex?.auth === 'entra') {
        codexToken = await managedModelToken()
        imageToken = codexToken
      } else if (run.input.mode === 'image' || run.input.mode === 'auto') {
        try {
          const { stdout } = await promisify(execFile)(`${homedir()}/.local/share/qwen-azure-cli/bin/az`,
            ['account', 'get-access-token', '--subscription', config.image.subscription, '--resource', 'https://cognitiveservices.azure.com/', '-o', 'json'], { timeout: 30000, maxBuffer: 256 * 1024 })
          imageToken = z.string().min(1).parse(JSON.parse(stdout).accessToken)
        } catch { if (run.input.mode === 'image') throw new Error('Azure 登录不可用，请在本机重新登录；未发送图片请求。') }
      }
      await request('/runs', 'POST', { id: run.id, projectId: run.projectId, threadId, text: run.input.text,
        mode: run.input.mode, ratio: run.input.ratio, imageToken, codexToken, ...(history.length ? { history } : {}), ...(sourceImage ? { sourceImage } : {}) })
    },
    async get(id) { return remoteSchema.parse(await request(`/runs/${id}`)) },
    async stop(id) { await request(`/runs/${id}`, 'DELETE') },
  }
}

export class AgentWorker {
  private timer?: ReturnType<typeof setInterval>
  private activeId: string | null = null
  private operation: Promise<void> | null = null
  private store: Store
  private assetStorage: AssetStorage
  private transport: AgentTransport
  constructor(store: Store, dataDir: string, transport: AgentTransport, assetStorage: AssetStorage = new LocalAssetStorage(dataDir)) {
    this.store = store
    this.assetStorage = assetStorage
    this.transport = transport
  }

  start() {
    this.store.recoverAgentRuns()
    this.timer = setInterval(() => { void this.tick() }, 1000)
  }

  async tick() {
    if (this.operation) return this.operation
    this.operation = this.advance().finally(() => { this.operation = null })
    return this.operation
  }

  private async advance() {
    if (!this.activeId) {
      const run = this.store.nextAgentRun()
      if (!run) return
      this.activeId = run.id
      this.store.updateAgent(run.id, { status: 'running' })
      try {
        const threadId = this.store.threadId(run.projectId)
        const snapshot = this.store.snapshot(run.projectId)
        const messages = snapshot.messages
        const history = threadId ? [] : messages.slice(0, messages.findIndex(message => message.id === run.messageId)).map(message => ({ role: message.role ?? 'user', text: message.text }))
        let sourceImage: SourceImage | undefined
        if (run.input.mode !== 'chat') {
          const previous = messages.slice(0, messages.findIndex(message => message.id === run.messageId)).reverse()
          const sourceRun = previous.map(message => snapshot.runs.find(candidate => candidate.messageId === message.id && candidate.status === 'completed' && candidate.assetId)).find(Boolean)
          const source = snapshot.assets.find(asset => asset.id === sourceRun?.assetId && asset.kind === 'generated')
          if (source) {
            const bytes = await this.assetStorage.read(`${source.id}.png`)
            if (bytes.length > 32 * 1024 * 1024 || createHash('sha256').update(bytes).digest('hex') !== source.hash) throw new Error('Invalid source image')
            sourceImage = { assetId: source.id, png: bytes.toString('base64'), hash: source.hash, width: source.width, height: source.height }
            this.store.updateAgent(run.id, { sourceAssetId: source.id })
          }
        }
        await this.transport.submit(run, threadId, history, sourceImage)
      }
      catch {
        this.store.updateAgent(run.id, { status: 'interrupted', error: '运行请求未确认，请检查容器及 Azure 登录；可能已计费，未自动重试。' })
        this.activeId = null
      }
      return
    }
    const id = this.activeId
    try {
      const remote = await this.transport.get(id)
      if (remote.id !== id) throw new Error('Mismatched runtime result')
      const local = this.store.agentRun(id)
      const progress = remote.progress ?? local.progress
      const progressChanged = JSON.stringify(progress) !== JSON.stringify(local.progress)
      if (local.status === 'cancelled') {
        if (remote.threadId || progressChanged) this.store.updateAgent(id, { ...(remote.threadId ? { threadId: remote.threadId } : {}), progress })
        if (remote.status !== 'running') this.activeId = null
        return
      }
      let assetId: string | undefined
      if (remote.status === 'completed' && remote.image) assetId = (await this.saveImage(local, remote.image)).id
      if (this.store.agentRun(id).status === 'cancelled') {
        if (remote.threadId) this.store.updateAgent(id, { threadId: remote.threadId })
        if (remote.status !== 'running') this.activeId = null
        return
      }
      if (remote.status !== local.status || remote.reply !== local.reply || remote.threadId !== local.threadId || remote.stage !== local.stage || remote.imageOperation !== local.imageOperation || progressChanged) {
        this.store.updateAgent(id, { status: remote.status, reply: remote.reply, threadId: remote.threadId, stage: remote.stage,
          error: remote.error, progress, imageOperation: remote.imageOperation, ...(assetId ? { assetId } : {}) })
      }
      if (remote.status !== 'running') this.activeId = null
    } catch {
      if (this.store.agentRun(id).status !== 'cancelled') {
        this.store.updateAgent(id, { status: 'interrupted', error: '无法确认运行结果，请检查服务；未自动重试，远端调用可能仍在执行或计费。' })
      }
      this.activeId = null
    }
  }

  private async saveImage(run: AgentRun, image: NonNullable<RemoteRun['image']>): Promise<Asset> {
    if (image.operation === 'edit') {
      if (!image.sourceAssetId || image.sourceAssetId !== run.sourceAssetId) throw new Error('Mismatched edit source')
      const source = this.store.asset(image.sourceAssetId)
      if (source.projectId !== run.projectId || source.hash !== image.sourceHash) throw new Error('Invalid edit lineage')
    } else if (image.sourceAssetId || image.sourceHash) throw new Error('Unexpected edit source')
    const existing = this.store.snapshot(run.projectId).assets.find(asset => asset.id === run.id)
    if (existing) return existing
    const bytes = Buffer.from(image.png, 'base64')
    if (bytes.length > 32 * 1024 * 1024) throw new Error('Image too large')
    const source = sharp(bytes, { limitInputPixels: 40_000_000 })
    const metadata = await source.metadata()
    if (metadata.format !== 'png' || metadata.width !== image.width || metadata.height !== image.height) throw new Error('Invalid image')
    const thumbnail = await source.resize(480, 480, { fit: 'inside', withoutEnlargement: true }).webp().toBuffer()
    await this.assetStorage.put(`${run.id}.png`, bytes)
    await this.assetStorage.put(`${run.id}.webp`, thumbnail)
    return this.store.addAsset({ id: run.id, projectId: run.projectId, name: `Azure-${run.id.slice(0, 8)}.png`,
      width: image.width, height: image.height, bytes: bytes.length, hash: createHash('sha256').update(bytes).digest('hex'),
      kind: 'generated', model: image.model, provider: 'azure', runId: run.id, createdAt: new Date().toISOString(),
      ...(image.operation === 'edit' ? { sourceAssetId: image.sourceAssetId, sourceHash: image.sourceHash } : {}) })
  }

  async stop(id: string) {
    const run = this.store.agentRun(id)
    if (run.status !== 'queued' && run.status !== 'running') return run
    if (run.status === 'running') await this.transport.stop(id)
    return this.store.updateAgent(id, { status: 'cancelled', error: '已请求停止；已提交的 Azure 调用仍可能计费。' })
  }

  resend(projectId: string, messageId: string, request: { requestId: string; expectedTailId: string }) {
    if (this.activeId && this.store.agentRun(this.activeId).projectId === projectId) throw new HttpError(409, '请先停止当前回复，待运行结束后重新发送。')
    return this.store.resend(projectId, messageId, request, true)
  }

  async close() {
    clearInterval(this.timer)
    await this.operation
  }
}