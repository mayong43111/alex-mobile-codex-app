import { readFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { homedir } from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import sharp from 'sharp'
import { z } from 'zod'
import type { AgentRun, Asset, Message } from '../src/domain.ts'
import { assetContentType, assetExtension } from '../src/domain.ts'
import { Store, HttpError } from './store.ts'
import { LocalAssetStorage } from './assets.ts'
import type { AssetStorage } from './assets.ts'
import { narrationPlanSchema } from './avatar-provider.ts'
import type { NarrationPlan } from './avatar-provider.ts'
import type { AvatarJobs } from './avatar.ts'

const configSchema = z.object({ gateway: z.literal('http://127.0.0.1:3199'), token: z.string().min(32),
  codex: z.object({ auth: z.enum(['key', 'entra']).optional() }).optional(),
  image: z.object({ auth: z.literal('entra'), subscription: z.string().uuid() }) })
const videoSchema = z.object({ mp4: z.string().max(64 * 1024 * 1024), thumbnail: z.string().max(4 * 1024 * 1024), width: z.number().int().positive().max(1920), height: z.number().int().positive().max(1920), duration: z.number().positive().max(90), fps: z.literal(24), model: z.literal('minimax-h3'), provider: z.literal('comfyui'), checkpoint: z.string() })
const remoteSchema = z.object({
  id: z.string().uuid(), threadId: z.string().uuid().nullable(),
  status: z.enum(['running', 'completed', 'failed', 'cancelled', 'interrupted']),
  stage: z.enum(['codex', 'image', 'video']), reply: z.string().max(20000), error: z.string().optional(),
  imageOperation: z.enum(['generate', 'edit']).optional(),
  sourceAssetId: z.string().uuid().optional(), needsSource: z.boolean().optional(),
  avatarPlan: narrationPlanSchema.optional(),
  story: z.object({ title: z.string().min(1).max(80), segments: z.array(z.object({ text: z.string().min(1).max(300), prompt: z.string().min(1).max(6000) })).min(2).max(12), clipIds: z.array(z.string().uuid()).min(2).max(12), phase: z.enum(['script', 'rendering', 'stitching', 'completed', 'stopped']), segment: z.number().int().min(0).max(12), stopRequested: z.boolean() }).optional(),
  processedVideos: z.array(videoSchema.extend({ assetId: z.string().uuid(), duration: z.number().positive().max(15) })).max(12).optional(),
  processedImages: z.array(z.object({ assetId: z.string().uuid(), sourceAssetId: z.string().uuid(), sourceHash: z.string().regex(/^[a-f0-9]{64}$/), hash: z.string().regex(/^[a-f0-9]{64}$/), width: z.number().int().positive().max(40_000_000), height: z.number().int().positive().max(40_000_000), bytes: z.number().int().positive().max(16 * 1024 * 1024), name: z.string().min(1).max(160), png: z.string().max(24 * 1024 * 1024) }).refine(image => image.width * image.height <= 40_000_000)).max(4).optional(),
  progress: z.array(z.object({ id: z.string().max(200), label: z.string().max(120), detail: z.string().optional(), createdAt: z.string().datetime() })).optional(),
  image: z.object({ png: z.string().max(48 * 1024 * 1024), width: z.number(), height: z.number(), model: z.string(), checkpoint: z.string(),
    provider: z.enum(['azure', 'comfyui']).optional(), operation: z.enum(['generate', 'edit']).optional(), sourceAssetId: z.string().uuid().optional(), sourceHash: z.string().regex(/^[0-9a-f]{64}$/).optional() }).optional(),
  video: videoSchema.optional(),
})
export type RemoteRun = z.infer<typeof remoteSchema>
export type SourceImage = { assetId: string; png: string; hash: string; width: number; height: number }
export type ImageCandidate = Omit<SourceImage, 'png'> & { name: string; kind: Asset['kind']; messageId: string; context: string }
export type AttachmentNotice = { assetId: string; name: string; mediaType: 'image' | 'video' | 'file'; mimeType: string; bytes: number; location: string }
export type ReadableAttachment = AttachmentNotice & { sha256: string }
export type ConversationEntry = Pick<Message, 'role' | 'text'> & { attachments?: AttachmentNotice[] }
export type ProjectContext = { title: string; runs: { id: string; status: AgentRun['status']; reply: string; phase?: string; stopRequested?: boolean; segments?: NarrationPlan['segments']; assetIds: string[] }[]; assets: AttachmentNotice[] }
function attachmentNotice(asset: Asset): AttachmentNotice {
  return { assetId: asset.id, name: asset.name, mediaType: asset.mediaType ?? 'image', mimeType: assetContentType(asset), bytes: asset.bytes, location: `/api/assets/${asset.id}/content` }
}
export interface AgentTransport {
  health(): Promise<unknown>
  submit(run: AgentRun, threadId: string | null, history?: ConversationEntry[], imageCandidates?: ImageCandidate[], attachments?: AttachmentNotice[], readableAttachments?: ReadableAttachment[], avatarEnabled?: boolean, projectContext?: ProjectContext): Promise<void>
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
    async submit(run, threadId, history = [], imageCandidates = [], attachments = [], readableAttachments = [], avatarEnabled = false, projectContext) {
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
        mode: run.input.mode, ratio: run.input.ratio, quality: run.input.quality ?? 'low', imageModel: run.input.imageModel ?? 'azure-image2', videoModel: run.input.videoModel ?? 'none', imageToken, codexToken, attachments, readableAttachments, imageCandidates, avatarEnabled, projectContext, ...(history.length ? { history } : {}) })
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
  private avatars?: AvatarJobs
  constructor(store: Store, dataDir: string, transport: AgentTransport, assetStorage: AssetStorage = new LocalAssetStorage(dataDir), canRun: () => boolean = () => true, avatars?: AvatarJobs) {
    this.store = store
    this.assetStorage = assetStorage
    this.transport = transport
    this.canRun = canRun
    this.avatars = avatars
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
      if (run.avatarJobId || run.story) return
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
        const projectContext: ProjectContext = {
          title: snapshot.project.title,
          runs: snapshot.runs.filter(item => item.id !== run.id).slice(-8).map(item => ({ id: item.id, status: item.status, reply: (item.story ? `${item.reply}\n${item.story.segments.map((segment, index) => `${index + 1}. ${segment.text}`).join('\n')}` : item.reply).slice(0, 6000), phase: item.story?.phase ?? item.narration?.progress?.phase, stopRequested: item.story?.stopRequested ?? item.narration?.stopRequested, segments: item.narration?.segments, assetIds: [...(item.narration?.scriptAssetId ? [item.narration.scriptAssetId] : []), ...(item.story?.scriptAssetId ? [item.story.scriptAssetId] : []), ...(item.processedAssetIds ?? []), ...(item.assetId ? [item.assetId] : [])] })),
          assets: snapshot.assets.slice(-100).map(attachmentNotice),
        }
        await this.transport.submit(run, threadId, history, this.imageCandidates(run), attachments, readableAttachments, !!this.avatars, projectContext)
      }
      catch {
        this.store.updateAgent(run.id, { status: 'interrupted', error: '运行请求未确认，请检查容器及 Azure 登录；可能已计费，未自动重试。' })
        this.activeId = null
      }
      return
    }
    const id = this.activeId
    try {
      const current = this.store.agentRun(id)
      if (current.avatarJobId) { this.advanceAvatar(current); return }
      const remote = await this.transport.get(id)
      if (remote.id !== id) throw new Error('Mismatched runtime result')
      let local = this.store.agentRun(id)
      const progress = remote.progress ?? local.progress
      const progressChanged = JSON.stringify(progress) !== JSON.stringify(local.progress)
      if (local.status === 'cancelled' && !remote.story) {
        if (remote.threadId || progressChanged) this.store.updateAgent(id, { ...(remote.threadId ? { threadId: remote.threadId } : {}), progress })
        if (remote.status !== 'running') this.activeId = null
        return
      }
      let assetId: string | undefined
      if (remote.story) {
        const story = remote.story
        if (local.input.mode === 'chat' || local.input.videoModel !== 'minimax-h3' || remote.image || remote.avatarPlan || story.clipIds.length !== story.segments.length || new Set(story.clipIds).size !== story.clipIds.length || story.clipIds.includes(id)) throw new Error('Invalid story execution')
        if (local.story && JSON.stringify([local.story.title, local.story.segments, local.story.clipIds]) !== JSON.stringify([story.title, story.segments, story.clipIds])) throw new Error('Story plan changed')
        const script = await this.saveProjectScript(local, Buffer.from(`# ${story.title}\n\n${story.segments.map((segment, index) => `## 第 ${index + 1} 镜\n\n${segment.text}\n\n${segment.prompt}\n`).join('\n')}`), 'story-script', `${story.title}-分镜.md`)
        const stopping = this.store.agentRun(id).story?.stopRequested || this.store.agentRun(id).status === 'cancelled'
        if (stopping && !story.stopRequested && remote.status === 'running') { try { await this.transport.stop(id) } catch {} }
        local = this.store.updateAgent(id, { status: 'running', stage: 'video', story: { ...story, stopRequested: stopping || story.stopRequested, scriptAssetId: script.id }, reply: remote.reply, threadId: remote.threadId, progress })
        const clips = remote.processedVideos ?? []
        if (clips.length < (local.processedAssetIds?.length ?? 0)) throw new Error('Story clips regressed')
        const imported = []
        for (const [index, clip] of clips.entries()) {
          if (story.clipIds[index] !== clip.assetId) throw new Error('Story clip identity mismatch')
          imported.push((await this.saveVideo(local, clip, clip.assetId, `${story.title}-第${index + 1}段.mp4`)).id)
          if (imported.length > (local.processedAssetIds?.length ?? 0)) local = this.store.updateAgent(id, { processedAssetIds: [...imported] })
        }
        if (remote.status === 'completed' && (clips.length !== story.segments.length || !remote.video)) throw new Error('Story final output incomplete')
      } else if (remote.processedVideos?.length || local.story) throw new Error('Story state missing')
      if (remote.processedImages?.length) {
        const processedAssetIds = []
        for (const image of remote.processedImages) processedAssetIds.push((await this.saveProcessedImage(local, image)).id)
        if (JSON.stringify(processedAssetIds) !== JSON.stringify(local.processedAssetIds)) local = this.store.updateAgent(id, { processedAssetIds })
      }
      if (remote.needsSource) {
        if (remote.status !== 'running' || remote.imageOperation !== 'edit' || local.input.mode === 'chat' || !this.transport.provideSource) throw new Error('Unexpected source request')
        const candidate = this.imageCandidates(local).find(candidate => candidate.assetId === remote.sourceAssetId) ?? (local.processedAssetIds?.includes(remote.sourceAssetId ?? '') ? { assetId: remote.sourceAssetId! } : undefined)
        if (!candidate || (local.sourceAssetId && local.sourceAssetId !== candidate.assetId)) throw new Error('Source outside run candidates')
        const source = this.store.asset(candidate.assetId)
        const azure = (local.input.imageModel ?? 'azure-image2') === 'azure-image2'
        if (azure ? source.bytes >= 50_000_000 : source.bytes > 32 * 1024 * 1024) {
          await this.transport.stop(id)
          this.store.updateAgent(id, { status: 'failed', threadId: remote.threadId, progress, error: azure ? '编辑原图必须小于 50 MB；未调用图片接口，请先让 Codex 缩放或压缩图片。' : 'Qwen 编辑原图不能超过 32 MiB；未调用图片接口，请先让 Codex 缩放或压缩图片。' })
          this.activeId = null
          return
        }
        const bytes = await this.assetStorage.read(`${source.id}.${assetExtension(source)}`)
        if (bytes.length !== source.bytes || createHash('sha256').update(bytes).digest('hex') !== source.hash) throw new Error('Invalid source image')
        this.store.updateAgent(id, { sourceAssetId: source.id, imageOperation: 'edit', reply: remote.reply, threadId: remote.threadId, progress })
        await this.transport.provideSource(id, { assetId: source.id, png: bytes.toString('base64'), hash: source.hash, width: source.width, height: source.height })
        return
      }
      if (remote.image && remote.video) throw new Error('Ambiguous media result')
      if (remote.status === 'completed' && remote.avatarPlan) {
        const plan = narrationPlanSchema.parse(remote.avatarPlan)
        const candidate = this.imageCandidates(local).find(candidate => candidate.assetId === remote.sourceAssetId)
        if (!this.avatars || local.input.mode === 'chat' || !candidate || remote.image || remote.video) throw new Error('Invalid conversational avatar decision')
        const script = await this.saveNarrationScript(local, plan)
        if (this.store.agentRun(id).status === 'cancelled') { this.activeId = null; return }
        const job = this.avatars.submit(local.projectId, { requestId: local.id, text: plan.segments.map(segment => segment.text).join(''), voice: plan.voice, segments: plan.segments, sourceAssetId: candidate.assetId, character: 'lisa', style: 'casual-sitting' })
        this.store.updateAgent(id, { avatarJobId: job.id, narration: { segments: plan.segments, scriptAssetId: script.id, progress: job.progress }, sourceAssetId: candidate.assetId, status: 'running', stage: 'video', threadId: remote.threadId, progress: (progress ?? []).filter(entry => entry.id !== 'done'), reply: `分段剧本已保存，开始制作 ${plan.segments.length} 段口播。每段完成后会保存到项目，最后拼接整片。` })
        return
      }
      if (remote.status === 'completed' && remote.image) assetId = (await this.saveImage(local, remote.image)).id
      if (remote.status === 'completed' && remote.video) {
        assetId = (await this.saveVideo(local, remote.video, local.id, local.story ? `${local.story.title}-完整故事.mp4` : undefined)).id
        if (local.story) remote.reply = `《${local.story.title}》已完成 ${local.story.segments.length} 段视频并拼接，总时长 ${remote.video.duration.toFixed(2)} 秒。分镜、各段和整片均已保存到项目。`
      }
      if (this.store.agentRun(id).status === 'cancelled' && !remote.story) {
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
      if (this.store.agentRun(id).story) {
        this.store.updateAgent(id, { error: '暂时无法同步故事结果，保留原任务与已完成素材继续查询；不会重新生成。' })
        return
      }
      if (this.store.agentRun(id).status !== 'cancelled') {
        this.store.updateAgent(id, { status: 'interrupted', error: '无法确认运行结果，请检查服务；未自动重试，远端调用可能仍在执行或计费。' })
      }
      this.activeId = null
    }
  }

  private advanceAvatar(run: AgentRun) {
    const job = this.avatars?.list(run.projectId).find(job => job.id === run.avatarJobId)
    if (!job) throw new Error('Original narration job unavailable')
    const terminal = ['completed', 'failed', 'cancelled'].includes(job.status)
    if (run.status === 'cancelled') { if (terminal) this.activeId = null; return }
    const completed = (job.assetIds?.length ?? 0) / 2
    const progress = (run.progress ?? []).filter(entry => entry.id !== 'avatar-sequence')
    const phaseLabels = { script: '分段剧本已保存', speech: `第 ${job.progress?.segment} 段配音中`, queued: '等待 GPU 开始', rendering: `第 ${job.progress?.segment} 段视频生成中`, tail: `第 ${job.progress?.segment} 段尾帧提取中`, stitching: '正在拼接整片', completed: '整片已生成，正在入库', stopped: '后续步骤已停止' }
    progress.push({ id: 'avatar-sequence', label: job.stopRequested && !terminal ? '正在停止后续步骤' : job.status === 'completed' ? '整片已合成并入库' : job.status === 'failed' ? '口播失败，已有素材已保留' : job.progress ? phaseLabels[job.progress.phase] : `口播分段 ${completed} / ${job.segmentCount ?? 1}`, detail: job.status === 'unknown' ? '提交待核实，不会重新生成' : `已保存 ${completed} / ${job.segmentCount ?? 1} 段 · OpenMontage`, createdAt: job.progress?.updatedAt ?? job.createdAt })
    const final = job.assetId ? this.store.asset(job.assetId) : undefined
    const reply = final ? `已完成 ${job.segmentCount ?? 1} 段口播，总时长 ${final.duration?.toFixed(2)} 秒。分段视频、尾帧和整片已保存。尾帧作为后续段源图，衔接效果请以实际播放为准。\n\n完整口播稿：\n${job.text}` : job.status === 'cancelled' ? `后续步骤已停止。已完成的 ${completed} 段视频、尾帧和剧本保留在项目中，尚未拼接整片。已执行的配音或生成仍可能计费。` : job.stopRequested ? `正在停止后续步骤。当前已提交的配音或视频可能继续完成并计费，已完成素材会保留。` : run.reply
    const narration = { ...run.narration, segments: job.segments ?? run.narration?.segments ?? [], progress: job.progress, stopRequested: job.stopRequested }
    const changes = { status: job.status === 'completed' ? 'completed' as const : job.status === 'failed' ? 'failed' as const : job.status === 'cancelled' ? 'cancelled' as const : 'running' as const, assetId: job.assetId, processedAssetIds: job.assetIds ?? [], error: job.error, progress, reply, narration }
    if (JSON.stringify([run.status, run.assetId, run.processedAssetIds, run.error, run.progress, run.reply, run.narration]) !== JSON.stringify([changes.status, changes.assetId, changes.processedAssetIds, changes.error, changes.progress, changes.reply, changes.narration])) this.store.updateAgent(run.id, changes)
    if (terminal) this.activeId = null
  }

  private async saveNarrationScript(run: AgentRun, plan: NarrationPlan) {
    const content = Buffer.from(`# 口播分段剧本\n\n声音：${plan.voice}\n\n${plan.segments.map((segment, index) => `## 第 ${index + 1} 段\n\n${segment.text}\n\n画面来源：${segment.continueFromPrevious ? '上一段实际尾帧' : '指定原图'}\n`).join('\n')}`)
    return this.saveProjectScript(run, content, 'narration-script', `口播剧本-${run.id.slice(0, 8)}.md`)
  }

  private async saveProjectScript(run: AgentRun, content: Buffer, model: string, name: string) {
    const hash = createHash('sha256').update(content).digest('hex')
    const existing = this.store.snapshot(run.projectId).assets.find(asset => asset.runId === run.id && asset.model === model)
    if (existing) { if (existing.hash !== hash) throw new Error('Narration script changed'); return existing }
    const id = randomUUID()
    await this.assetStorage.put(`${id}.bin`, content)
    return this.store.addAsset({ id, projectId: run.projectId, runId: run.id, name, mediaType: 'file', storageExtension: 'bin', mimeType: 'text/markdown', hasThumbnail: false, width: 0, height: 0, bytes: content.length, hash, kind: 'generated', model, provider: 'Codex', createdAt: new Date().toISOString() })
  }

  private async saveProcessedImage(run: AgentRun, image: NonNullable<RemoteRun['processedImages']>[number]): Promise<Asset> {
    const source = this.imageCandidates(run).find(candidate => candidate.assetId === image.sourceAssetId)
    if (!source || source.hash !== image.sourceHash || image.assetId === source.assetId) throw new Error('Invalid processed image source')
    const existing = this.store.snapshot(run.projectId).assets.find(asset => asset.id === image.assetId)
    if (existing) {
      if (existing.hash !== image.hash || existing.runId !== run.id || existing.sourceAssetId !== source.assetId || existing.bytes !== image.bytes || existing.width !== image.width || existing.height !== image.height) throw new Error('Processed image conflict')
      return existing
    }
    const bytes = Buffer.from(image.png, 'base64')
    if (bytes.length !== image.bytes || bytes.length > 16 * 1024 * 1024 || createHash('sha256').update(bytes).digest('hex') !== image.hash) throw new Error('Invalid processed image bytes')
    const metadata = await sharp(bytes, { limitInputPixels: 40_000_000 }).metadata()
    if (metadata.format !== 'png' || metadata.width !== image.width || metadata.height !== image.height) throw new Error('Invalid processed image dimensions')
    const thumbnail = await sharp(bytes).resize(480, 480, { fit: 'inside', withoutEnlargement: true }).webp().toBuffer()
    await this.assetStorage.put(`${image.assetId}.png`, bytes)
    await this.assetStorage.put(`${image.assetId}.webp`, thumbnail)
    return this.store.addAsset({ id: image.assetId, projectId: run.projectId, name: image.name, width: image.width, height: image.height, bytes: image.bytes, hash: image.hash, kind: 'reference', mediaType: 'image', storageExtension: 'png', mimeType: 'image/png', hasThumbnail: true, model: 'sharp', provider: 'local', runId: run.id, sourceAssetId: source.assetId, sourceHash: source.hash, createdAt: new Date().toISOString() })
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

  private async saveVideo(run: AgentRun, video: NonNullable<RemoteRun['video']>, id = run.id, name = `H3-${id.slice(0, 8)}.mp4`): Promise<Asset> {
    if (run.input.videoModel !== 'minimax-h3' || video.model !== 'minimax-h3' || video.provider !== 'comfyui') throw new Error('Unexpected video provider')
    const bytes = Buffer.from(video.mp4, 'base64')
    const existing = this.store.snapshot(run.projectId).assets.find(asset => asset.id === id)
    if (existing) { if (existing.hash !== createHash('sha256').update(bytes).digest('hex') || existing.runId !== run.id) throw new Error('Video output changed'); return existing }
    if (bytes.length < 16 || bytes.length > 48 * 1024 * 1024 || bytes.toString('ascii', 4, 8) !== 'ftyp') throw new Error('Invalid MP4')
    const thumbnail = await sharp(Buffer.from(video.thumbnail, 'base64'), { limitInputPixels: 1920 * 1920 }).resize(480, 480, { fit: 'inside', withoutEnlargement: true }).webp().toBuffer()
    if (!Number.isFinite(video.duration) || video.duration <= 0 || video.duration > (run.story && id === run.id ? 90 : 15) || video.fps !== 24) throw new Error('Invalid video metadata')
    await this.assetStorage.put(`${id}.mp4`, bytes)
    await this.assetStorage.put(`${id}.webp`, thumbnail)
    return this.store.addAsset({ id, projectId: run.projectId, name, mediaType: 'video', width: video.width, height: video.height,
      duration: video.duration, fps: video.fps, bytes: bytes.length, hash: createHash('sha256').update(bytes).digest('hex'), kind: 'generated', model: video.model, provider: video.provider, runId: run.id, createdAt: new Date().toISOString() })
  }

  async stop(id: string) {
    const run = this.store.agentRun(id)
    if (run.status !== 'queued' && run.status !== 'running') return run
    if (run.story) {
      this.store.updateAgent(id, { story: { ...run.story, stopRequested: true } })
      await this.transport.stop(id)
      return this.store.agentRun(id)
    }
    if (run.avatarJobId && this.avatars) {
      await this.avatars.stop(run.avatarJobId)
      this.advanceAvatar(this.store.agentRun(id))
      return this.store.agentRun(id)
    }
    const stopped = this.store.updateAgent(id, { status: 'cancelled', error: '已请求停止等待；已提交的模型任务可能仍在执行或计费，请核实后再重试。' })
    if (run.status === 'running') await this.transport.stop(id)
    return stopped
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