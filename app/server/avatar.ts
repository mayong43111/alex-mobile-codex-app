import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { promisify } from 'node:util'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AvatarProvider, AvatarInput } from './avatar-provider.ts'
import { AvatarSubmissionRejected, AvatarSubmissionStopped } from './avatar-provider.ts'
import type { AssetStorage } from './assets.ts'
import { Store, HttpError } from './store.ts'
import { assetExtension } from '../src/domain.ts'
import type { NarrationProgress } from '../src/domain.ts'
import sharp from 'sharp'
import type { AvatarArtifact } from './avatar-provider.ts'

export type AvatarJob = { id: string; projectId: string; text: string; status: 'submitting' | 'running' | 'unknown' | 'completed' | 'failed' | 'cancelled'; createdAt: string; assetId?: string; error?: string; sourceAssetId?: string; sourceHash?: string; assetIds?: string[]; segmentCount?: number; segments?: AvatarInput['segments']; progress?: NarrationProgress; stopRequested?: boolean; stopSent?: boolean }
const execute = promisify(execFile)
const ffprobe = (createRequire(import.meta.url)('ffprobe-static') as { path: string }).path
export async function inspectAvatar(bytes: Buffer) {
  const directory = await mkdtemp(join(tmpdir(), 'studio-avatar-'))
  try {
    const path = join(directory, 'video.mp4')
    await writeFile(path, bytes, { mode: 0o600 })
    const { stdout } = await execute(ffprobe, ['-v', 'error', '-protocol_whitelist', 'file', '-show_streams', '-show_format', '-of', 'json', path], { timeout: 30000, maxBuffer: 1024 * 1024 })
    const info = JSON.parse(stdout)
    const video = info.streams?.find((stream: { codec_type: string }) => stream.codec_type === 'video')
    const audio = info.streams?.find((stream: { codec_type: string }) => stream.codec_type === 'audio')
    const duration = Number(info.format?.duration)
    if (!video || !audio || video.codec_name !== 'h264' || !info.format?.format_name?.includes('mp4') || !(duration > 0 && duration <= 600) || !Number.isInteger(video.width) || !Number.isInteger(video.height) || video.width < 1 || video.height < 1 || video.width * video.height > 3840 * 2160) throw new Error('Invalid avatar video')
    return { width: video.width as number, height: video.height as number, duration }
  } finally { await rm(directory, { recursive: true, force: true }) }
}

export class AvatarJobs {
  private active = new Set<Promise<unknown>>()
  private checking: Promise<void> | undefined
  private timer: ReturnType<typeof setInterval> | undefined
  private store: Store
  private storage: AssetStorage
  private provider: AvatarProvider
  private nativeProvider: AvatarProvider | undefined
  private inspect: typeof inspectAvatar
  constructor(store: Store, storage: AssetStorage, provider: AvatarProvider, inspect = inspectAvatar, nativeProvider?: AvatarProvider) {
    this.store = store
    this.storage = storage
    this.provider = provider
    this.nativeProvider = nativeProvider
    this.inspect = inspect
    store.db.prepare("UPDATE avatar_jobs SET data = json_set(data, '$.status', 'unknown') WHERE json_extract(data, '$.status') = 'submitting'").run()
  }
  list(projectId: string): AvatarJob[] {
    this.store.project(projectId)
    return this.store.db.prepare('SELECT data FROM avatar_jobs WHERE project_id = ? ORDER BY rowid DESC').all(projectId).map(row => JSON.parse(row.data as string))
  }
  private save(job: AvatarJob) {
    const current = this.current(job.id)
    if (current.stopRequested) job.stopRequested = true
    if (current.stopSent) job.stopSent = true
    this.store.db.prepare('UPDATE avatar_jobs SET data = ? WHERE id = ?').run(JSON.stringify(job), job.id)
    this.store.event(job.projectId, 'avatar.updated')
  }
  private current(id: string): AvatarJob {
    const row = this.store.db.prepare('SELECT data FROM avatar_jobs WHERE id = ?').get(id)
    if (!row) throw new HttpError(404, '口播任务不存在')
    return JSON.parse(row.data as string)
  }
  async stop(id: string) {
    const job = this.current(id)
    if (['completed', 'failed', 'cancelled'].includes(job.status)) return job
    if (!job.segmentCount || !this.nativeProvider?.stop) throw new HttpError(409, '此任务不支持停止后续步骤')
    this.save({ ...job, stopRequested: true })
    if (!job.stopSent) {
      try {
        await this.nativeProvider.stop(id)
        this.save({ ...this.current(id), stopSent: true })
      } catch {
        this.save({ ...this.current(id), error: '停止请求尚未确认，正在重发停止标记；不会重新生成。' })
      }
    }
    return this.current(id)
  }
  submit(projectId: string, input: AvatarInput) {
    this.store.project(projectId)
    const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex')
    const existing = this.store.db.prepare('SELECT data, input_hash FROM avatar_jobs WHERE project_id = ? AND request_id = ?').get(projectId, input.requestId)
    if (existing) {
      if (existing.input_hash !== hash) throw new HttpError(409, '请求已存在且内容不同')
      return JSON.parse(existing.data as string) as AvatarJob
    }
    if (this.store.db.prepare("SELECT 1 FROM avatar_jobs WHERE json_extract(data, '$.status') IN ('submitting','running','unknown')").get()) throw new HttpError(409, '已有数字人任务处理中或待核实，请先等待或核查原任务')
    const source = input.sourceAssetId ? this.store.asset(input.sourceAssetId) : undefined
    if (source && (source.projectId !== projectId || (source.mediaType ?? 'image') !== 'image' || !source.hash)) throw new HttpError(400, '请选择当前项目中具有校验值的主播图片')
    if (source && !this.nativeProvider) throw new HttpError(503, 'OpenMontage 数字人未配置')
    const provider = source ? this.nativeProvider! : this.provider
    const job: AvatarJob = { id: randomUUID(), projectId, text: input.text, status: 'submitting', createdAt: new Date().toISOString(), ...(source ? { sourceAssetId: source.id, sourceHash: source.hash } : {}), ...(input.segments ? { segmentCount: input.segments.length, segments: input.segments, progress: { phase: 'script', segment: 0, updatedAt: new Date().toISOString() } } : {}) }
    this.store.db.prepare('INSERT INTO avatar_jobs VALUES (?, ?, ?, ?, ?)').run(job.id, projectId, input.requestId, hash, JSON.stringify(job))
    const pending = (async () => {
      const bytes = source ? await this.storage.read(`${source.id}.${assetExtension(source)}`) : undefined
      if (source && createHash('sha256').update(bytes!).digest('hex') !== source.hash) throw new AvatarSubmissionRejected('Source image changed')
      await provider.submit(job.id, input, bytes, progress => this.save({ ...this.current(job.id), progress }))
    })().then(() => this.save({ ...this.current(job.id), status: 'running' })).catch(failure => {
      const current = this.current(job.id)
      if (failure instanceof AvatarSubmissionStopped) this.save({ ...current, status: 'cancelled', error: undefined, progress: { phase: 'stopped', segment: current.progress?.segment ?? 0, updatedAt: new Date().toISOString() } })
      else this.save(failure instanceof AvatarSubmissionRejected
        ? { ...current, status: 'failed', error: '数字人服务未接受请求，请检查身份、配额和配置；未自动重试。' }
        : { ...current, status: 'unknown', error: '提交结果待核实，系统不会自动重新生成。' })
    }).finally(() => this.active.delete(pending))
    this.active.add(pending)
    return job
  }
  async tick() {
    if (this.checking) return this.checking
    this.checking = this.check().finally(() => { this.checking = undefined })
    return this.checking
  }
  private async check() {
    const rows = this.store.db.prepare("SELECT data FROM avatar_jobs WHERE json_extract(data, '$.status') IN ('running','unknown')").all()
    for (const row of rows) {
      const job: AvatarJob = JSON.parse(row.data as string)
      if (Date.now() - Date.parse(job.createdAt) >= 24 * 60 * 60 * 1000) {
        const error = '任务已超过 24 小时，停止自动查询。请联系管理员核查此任务 ID，勿重新生成。'
        if (job.error !== error) this.save({ ...job, status: 'unknown', error })
        continue
      }
      try {
        const provider = job.sourceAssetId ? this.nativeProvider : this.provider
        if (!provider) throw new Error('Original avatar provider unavailable')
        if (job.stopRequested && !job.stopSent) await this.stop(job.id)
        const result = await provider.status(job.id)
        if (result.progress) { job.progress = result.progress; this.save(job) }
        if (provider.artifacts) {
          const artifacts = await provider.artifacts(job.id)
          if (artifacts.length < (job.assetIds?.length ?? 0)) throw new Error('Intermediate manifest regressed')
          for (const artifact of artifacts) await this.importArtifact(job, artifact)
          job.assetIds = artifacts.map(artifact => artifact.id)
        }
        if (result.status === 'Cancelled') { this.save({ ...job, status: 'cancelled', error: undefined }); continue }
        if (result.status === 'Failed') { this.save({ ...job, status: 'failed', error: '数字人服务生成失败，未自动重试。' }); continue }
        if (result.status !== 'Succeeded') { this.save({ ...job, status: 'running', error: undefined }); continue }
        if (job.segmentCount && job.assetIds?.length !== job.segmentCount * 2) throw new Error('Incomplete sequence artifacts')
        if (!result.result) throw new Error('Missing output')
        const bytes = await provider.download(result.result)
        const metadata = await this.inspect(bytes)
        await this.storage.put(`${job.id}.mp4`, bytes)
        this.store.transaction(() => {
          const asset = { id: job.id, projectId: job.projectId, name: job.segmentCount ? '完整口播.mp4' : '数字人口播.mp4', kind: 'generated', mediaType: 'video', storageExtension: 'mp4', mimeType: 'video/mp4', hasThumbnail: false, model: job.sourceAssetId ? 'sadtalker' : 'azure-avatar', provider: job.sourceAssetId ? 'OpenMontage' : 'Azure Speech', narration: job.text, bytes: bytes.length, hash: createHash('sha256').update(bytes).digest('hex'), createdAt: new Date().toISOString(), ...(job.sourceAssetId ? { sourceAssetId: job.sourceAssetId, sourceHash: job.sourceHash } : {}), ...metadata }
          this.store.db.prepare('INSERT INTO assets VALUES (?, ?, ?)').run(asset.id, asset.projectId, JSON.stringify(asset))
          this.store.event(job.projectId, 'asset.created')
          this.save({ ...job, status: 'completed', assetId: job.id, error: undefined })
        })
      } catch { this.save({ ...job, error: '暂时无法确认结果，保留原任务继续查询，不会重新生成。' }) }
    }
  }
  private async importArtifact(job: AvatarJob, artifact: AvatarArtifact) {
    if (artifact.id === job.id || createHash('sha256').update(artifact.bytes).digest('hex') !== artifact.hash) throw new Error('Invalid intermediate artifact')
    const source = this.store.asset(artifact.sourceAssetId)
    if (source.projectId !== job.projectId || source.hash !== artifact.sourceHash) throw new Error('Invalid intermediate source')
    const existing = this.store.db.prepare('SELECT data FROM assets WHERE id = ?').get(artifact.id)
    if (existing) {
      const saved = JSON.parse(existing.data as string)
      if (saved.projectId !== job.projectId || saved.hash !== artifact.hash || saved.sourceAssetId !== source.id || saved.sourceHash !== source.hash) throw new Error('Intermediate artifact conflict')
      return
    }
    const metadata = artifact.mediaType === 'video' ? await this.inspect(artifact.bytes) : await sharp(artifact.bytes, { limitInputPixels: 3840 * 2160 }).metadata()
    if (!metadata.width || !metadata.height || (artifact.mediaType === 'image' && (!('format' in metadata) || metadata.format !== 'png'))) throw new Error('Invalid intermediate media')
    const extension = artifact.mediaType === 'video' ? 'mp4' : 'png'
    await this.storage.put(`${artifact.id}.${extension}`, artifact.bytes)
    if (artifact.mediaType === 'image') await this.storage.put(`${artifact.id}.webp`, await sharp(artifact.bytes).resize(480, 480, { fit: 'inside', withoutEnlargement: true }).webp().toBuffer())
    this.store.addAsset({ id: artifact.id, projectId: job.projectId, name: artifact.name, kind: 'generated', mediaType: artifact.mediaType, storageExtension: extension, mimeType: artifact.mediaType === 'video' ? 'video/mp4' : 'image/png', hasThumbnail: artifact.mediaType === 'image', model: artifact.mediaType === 'video' ? 'sadtalker' : 'frame_sampler', provider: 'OpenMontage', sourceAssetId: source.id, sourceHash: source.hash, bytes: artifact.bytes.length, hash: artifact.hash, width: metadata.width, height: metadata.height, ...('duration' in metadata ? { duration: metadata.duration } : {}), ...(artifact.text ? { narration: artifact.text } : {}), ...(artifact.seconds !== undefined ? { frameSeconds: artifact.seconds } : {}), createdAt: new Date().toISOString() })
  }
  start() { this.timer = setInterval(() => { void this.tick().catch(() => {}) }, 5000) }
  async close() { clearInterval(this.timer); await Promise.allSettled([...this.active]); await this.checking }
}