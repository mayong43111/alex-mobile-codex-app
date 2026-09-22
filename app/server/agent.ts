import { readFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'
import sharp from 'sharp'
import { z } from 'zod'
import type { AgentRun, Asset, Message } from '../src/domain.ts'
import { assetContentType, assetExtension } from '../src/domain.ts'
import { Store, HttpError } from './store.ts'
import { LocalAssetStorage } from './assets.ts'
import type { AssetStorage } from './assets.ts'

const configSchema = z.object({ gateway: z.literal('http://127.0.0.1:3199'), token: z.string().min(32),
  codex: z.object({ auth: z.enum(['key', 'entra']).optional() }).optional(),
  image: z.object({ auth: z.literal('entra'), subscription: z.string().uuid() }) })
const remoteSchema = z.object({
  id: z.string().uuid(), threadId: z.string().uuid().nullable(),
  status: z.enum(['running', 'completed', 'failed', 'cancelled', 'interrupted']),
  stage: z.enum(['codex', 'image', 'video']), reply: z.string().max(20000), error: z.string().optional(),
  imageOperation: z.enum(['generate', 'edit']).optional(),
  sourceAssetId: z.string().uuid().optional(), needsSource: z.boolean().optional(),
  progress: z.array(z.object({ id: z.string().max(200), label: z.string().max(120), detail: z.string().optional(), createdAt: z.string().datetime() })).optional(),
  image: z.object({ png: z.string().max(48 * 1024 * 1024), width: z.number(), height: z.number(), model: z.string(), checkpoint: z.string(),
    provider: z.enum(['azure', 'comfyui']).optional(), operation: z.enum(['generate', 'edit']).optional(), sourceAssetId: z.string().uuid().optional(), sourceHash: z.string().regex(/^[0-9a-f]{64}$/).optional() }).optional(),
  video: z.object({ mp4: z.string().max(64 * 1024 * 1024), thumbnail: z.string().max(4 * 1024 * 1024), width: z.number().int().positive().max(1920), height: z.number().int().positive().max(1920), duration: z.number().positive().max(15), fps: z.literal(24), model: z.literal('minimax-h3'), provider: z.literal('comfyui'), checkpoint: z.string() }).optional(),
})
export type RemoteRun = z.infer<typeof remoteSchema>
export type SourceImage = { assetId: string; png: string; hash: string; width: number; height: number }
export type ImageCandidate = Omit<SourceImage, 'png'> & { name: string; kind: Asset['kind']; messageId: string; context: string }
export type AttachmentNotice = { assetId: string; name: string; mediaType: 'image' | 'video' | 'file'; mimeType: string; bytes: number; location: string }
export type ReadableAttachment = AttachmentNotice & { sha256: string }
export type ConversationEntry = Pick<Message, 'role' | 'text'> & { attachments?: AttachmentNotice[] }
function attachmentNotice(asset: Asset): AttachmentNotice {
  return { assetId: asset.id, name: asset.name, mediaType: asset.mediaType ?? 'image', mimeType: assetContentType(asset), bytes: asset.bytes, location: `/api/assets/${asset.id}/content` }
}
export interface AgentTransport {
  health(): Promise<unknown>
  submit(run: AgentRun, threadId: string | null, history?: ConversationEntry[], imageCandidates?: ImageCandidate[], attachments?: AttachmentNotice[], readableAttachments?: ReadableAttachment[]): Promise<void>
  provideSource?(runId: string, source: SourceImage): Promise<void>
  uploadAttachment?(runId: string, asset: ReadableAttachment, bytes: Buffer): Promise<void>
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
    async uploadAttachment(runId, asset, bytes) {
      const response = await fetch(`${config.gateway}/attachment-runs/${runId}/${asset.assetId}`, { method: 'PUT', signal: AbortSignal.timeout(60000), headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/octet-stream', 'X-Content-SHA256': asset.sha256 }, body: new Uint8Array(bytes) })
      if (!response.ok) throw new Error(`Attachment staging HTTP ${response.status}`)
    },
    async provideSource(runId, source) { await request(`/runs/${runId}/source`, 'PUT', source) },
    async submit(run, threadId, history = [], imageCandidates = [], attachments = [], readableAttachments = []) {
      let imageToken: string | undefined
      let codexToken: string | undefined
      if (config.codex?.auth === 'entra') {
        codexToken = await managedModelToken()
        imageToken = codexToken
      } else if ((run.input.mode === 'image' || run.input.mode === 'auto') && (run.input.imageModel ?? 'azure-image2') === 'azure-image2') {
        try {
          const { stdout } = await promisify(execFile)(`${homedir()}/.local/share/qwen-azure-cli/bin/az`,
            ['account', 'get-access-token', '--subscription', config.image.subscription, '--resource', 'https://cognitiveservices.azure.com/', '-o', 'json'], { timeout: 30000, maxBuffer: 256 * 1024 })
          imageToken = z.string().min(1).parse(JSON.parse(stdout).accessToken)
        } catch { if (run.input.mode === 'image') throw new Error('Azure 登录不可用，请在本机重新登录；未发送图片请求。') }
      }
      await request('/runs', 'POST', { id: run.id, projectId: run.projectId, threadId, text: run.input.text,
        mode: run.input.mode, ratio: run.input.ratio, quality: run.input.quality ?? 'low', imageModel: run.input.imageModel ?? 'azure-image2', videoModel: run.input.videoModel ?? 'none', imageToken, codexToken, attachments, readableAttachments, imageCandidates, ...(history.length ? { history } : {}) })
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
  private canRun: () => boolean
  constructor(store: Store, dataDir: string, transport: AgentTransport, assetStorage: AssetStorage = new LocalAssetStorage(dataDir), canRun: () => boolean = () => true) {
    this.store = store
    this.assetStorage = assetStorage
    this.transport = transport
    this.canRun = canRun
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

  private imageCandidates(run: AgentRun): ImageCandidate[] {
    const snapshot = this.store.snapshot(run.projectId)
    const position = snapshot.messages.findIndex(message => message.id === run.messageId)
    if (position < 0) throw new Error('Run message missing')
    const candidates = new Map<string, ImageCandidate>()
    for (const message of snapshot.messages.slice(0, position + 1)) {
      const completed = snapshot.runs.find(candidate => candidate.messageId === message.id && candidate.id !== run.id && candidate.status === 'completed')
      for (const id of [...message.assetIds, ...(completed?.assetId ? [completed.assetId] : [])]) {
        const asset = this.store.asset(id)
        if (asset.projectId !== run.projectId) throw new Error('Image project mismatch')
        if ((asset.mediaType ?? 'image') !== 'image') continue
        if (!candidates.has(id)) candidates.set(id, { assetId: id, name: asset.name, hash: asset.hash, width: asset.width, height: asset.height, kind: asset.kind, messageId: message.id, context: message.text.slice(0, 6000) })
      }
    }
    return [...candidates.values()]
  }

  private async advance() {
    if (!this.activeId) {
      if (!this.canRun()) return
      const run = this.store.nextAgentRun()
      if (!run) return
      this.activeId = run.id
      this.store.updateAgent(run.id, { status: 'running' })
      try {
        const threadId = this.store.threadId(run.projectId)
        const snapshot = this.store.snapshot(run.projectId)
        const messages = snapshot.messages
        const notices = (ids: string[]) => ids.map(id => {
          const asset = this.store.asset(id)
          if (asset.projectId !== run.projectId) throw new Error('Attachment project mismatch')
          return attachmentNotice(asset)
        })
        const attachments = notices(run.input.assetIds ?? [])
        const previousMessages = messages.slice(0, messages.findIndex(message => message.id === run.messageId))
        const readableIds = attachments.length ? run.input.assetIds! : [...previousMessages].reverse().find(message => message.role !== 'assistant' && message.assetIds.length)?.assetIds ?? []
        const readableAttachments: ReadableAttachment[] = this.transport.uploadAttachment ? notices(readableIds).map(notice => ({ ...notice, sha256: this.store.asset(notice.assetId).hash })) : []
        for (const notice of readableAttachments) {
          const asset = this.store.asset(notice.assetId)
          const bytes = await this.assetStorage.read(`${asset.id}.${assetExtension(asset)}`)
          if (bytes.length !== notice.bytes || bytes.length > 64 * 1024 * 1024 || createHash('sha256').update(bytes).digest('hex') !== notice.sha256) throw new Error('Invalid attachment bytes')
          await this.transport.uploadAttachment!(run.id, notice, bytes)
        }
        const history = threadId ? [] : messages.slice(0, messages.findIndex(message => message.id === run.messageId)).map(message => ({ role: message.role ?? 'user', text: message.text, ...(message.assetIds.length ? { attachments: notices(message.assetIds) } : {}) }))
        await this.transport.submit(run, threadId, history, this.imageCandidates(run), attachments, readableAttachments)
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
      if (remote.needsSource) {
        if (remote.status !== 'running' || remote.imageOperation !== 'edit' || local.input.mode === 'chat' || !this.transport.provideSource) throw new Error('Unexpected source request')
        const candidate = this.imageCandidates(local).find(candidate => candidate.assetId === remote.sourceAssetId)
        if (!candidate || (local.sourceAssetId && local.sourceAssetId !== candidate.assetId)) throw new Error('Source outside run candidates')
        const source = this.store.asset(candidate.assetId)
        const bytes = await this.assetStorage.read(`${source.id}.${assetExtension(source)}`)
        if (bytes.length !== source.bytes || bytes.length > 32 * 1024 * 1024 || createHash('sha256').update(bytes).digest('hex') !== source.hash) throw new Error('Invalid source image')
        this.store.updateAgent(id, { sourceAssetId: source.id, imageOperation: 'edit', reply: remote.reply, threadId: remote.threadId, progress })
        await this.transport.provideSource(id, { assetId: source.id, png: bytes.toString('base64'), hash: source.hash, width: source.width, height: source.height })
        return
      }
      if (remote.image && remote.video) throw new Error('Ambiguous media result')
      if (remote.status === 'completed' && remote.image) assetId = (await this.saveImage(local, remote.image)).id
      if (remote.status === 'completed' && remote.video) assetId = (await this.saveVideo(local, remote.video)).id
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
    const provider = image.provider ?? 'azure'
    const selected = run.input.imageModel ?? 'azure-image2'
    if (provider !== (selected === 'azure-image2' ? 'azure' : 'comfyui') || (selected === 'qwen-image-2.1' && image.model !== selected)) throw new Error('Unexpected image provider or model')
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
    return this.store.addAsset({ id: run.id, projectId: run.projectId, name: `${provider}-${run.id.slice(0, 8)}.png`,
      width: image.width, height: image.height, bytes: bytes.length, hash: createHash('sha256').update(bytes).digest('hex'),
      kind: 'generated', model: image.model, provider, runId: run.id, createdAt: new Date().toISOString(),
      ...(image.operation === 'edit' ? { sourceAssetId: image.sourceAssetId, sourceHash: image.sourceHash } : {}) })
  }

  private async saveVideo(run: AgentRun, video: NonNullable<RemoteRun['video']>): Promise<Asset> {
    if (run.input.videoModel !== 'minimax-h3' || video.model !== 'minimax-h3' || video.provider !== 'comfyui') throw new Error('Unexpected video provider')
    const existing = this.store.snapshot(run.projectId).assets.find(asset => asset.id === run.id)
    if (existing) return existing
    const bytes = Buffer.from(video.mp4, 'base64')
    if (bytes.length < 16 || bytes.length > 48 * 1024 * 1024 || bytes.toString('ascii', 4, 8) !== 'ftyp') throw new Error('Invalid MP4')
    const thumbnail = await sharp(Buffer.from(video.thumbnail, 'base64'), { limitInputPixels: 1920 * 1920 }).resize(480, 480, { fit: 'inside', withoutEnlargement: true }).webp().toBuffer()
    if (!Number.isFinite(video.duration) || video.duration <= 0 || video.duration > 15 || video.fps !== 24) throw new Error('Invalid video metadata')
    await this.assetStorage.put(`${run.id}.mp4`, bytes)
    await this.assetStorage.put(`${run.id}.webp`, thumbnail)
    return this.store.addAsset({ id: run.id, projectId: run.projectId, name: `H3-${run.id.slice(0, 8)}.mp4`, mediaType: 'video', width: video.width, height: video.height,
      duration: video.duration, fps: video.fps, bytes: bytes.length, hash: createHash('sha256').update(bytes).digest('hex'), kind: 'generated', model: video.model, provider: video.provider, runId: run.id, createdAt: new Date().toISOString() })
  }

  async stop(id: string) {
    const run = this.store.agentRun(id)
    if (run.status !== 'queued' && run.status !== 'running') return run
    if (run.status === 'running') await this.transport.stop(id)
    return this.store.updateAgent(id, { status: 'cancelled', error: '已请求停止等待；已提交的模型任务可能仍在执行或计费，请核实后再重试。' })
  }

  resend(projectId: string, messageId: string, request: { requestId: string; expectedTailId: string }) {
    if (this.activeId && this.store.agentRun(this.activeId).projectId === projectId) throw new HttpError(409, '请先停止当前回复，待运行结束后重新发送。')
    return this.store.resend(projectId, messageId, request, true)
  }

  async close() {
    clearInterval(this.timer)
    await this.operation
  }

  hasActiveProject(projectId?: string) {
    return !!this.activeId && (!projectId || this.store.agentRun(this.activeId).projectId === projectId)
  }
}