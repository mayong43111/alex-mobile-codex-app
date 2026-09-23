import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { promisify } from 'node:util'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AvatarProvider, AvatarInput } from './avatar-provider.ts'
import { AvatarSubmissionRejected } from './avatar-provider.ts'
import type { AssetStorage } from './assets.ts'
import { Store, HttpError } from './store.ts'

export type AvatarJob = { id: string; projectId: string; text: string; status: 'submitting' | 'running' | 'unknown' | 'completed' | 'failed'; createdAt: string; assetId?: string; error?: string }
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
  private inspect: typeof inspectAvatar
  constructor(store: Store, storage: AssetStorage, provider: AvatarProvider, inspect = inspectAvatar) {
    this.store = store
    this.storage = storage
    this.provider = provider
    this.inspect = inspect
    store.db.prepare("UPDATE avatar_jobs SET data = json_set(data, '$.status', 'unknown') WHERE json_extract(data, '$.status') = 'submitting'").run()
  }
  list(projectId: string): AvatarJob[] {
    this.store.project(projectId)
    return this.store.db.prepare('SELECT data FROM avatar_jobs WHERE project_id = ? ORDER BY rowid DESC').all(projectId).map(row => JSON.parse(row.data as string))
  }
  private save(job: AvatarJob) {
    this.store.db.prepare('UPDATE avatar_jobs SET data = ? WHERE id = ?').run(JSON.stringify(job), job.id)
    this.store.event(job.projectId, 'avatar.updated')
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
    const job: AvatarJob = { id: randomUUID(), projectId, text: input.text, status: 'submitting', createdAt: new Date().toISOString() }
    this.store.db.prepare('INSERT INTO avatar_jobs VALUES (?, ?, ?, ?, ?)').run(job.id, projectId, input.requestId, hash, JSON.stringify(job))
    const pending = this.provider.submit(job.id, input).then(() => this.save({ ...job, status: 'running' })).catch(failure => this.save(failure instanceof AvatarSubmissionRejected
      ? { ...job, status: 'failed', error: '数字人服务未接受请求，请检查身份、配额和配置；未自动重试。' }
      : { ...job, status: 'unknown', error: '提交结果待核实，系统不会自动重新生成。' })).finally(() => this.active.delete(pending))
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
        const result = await this.provider.status(job.id)
        if (result.status === 'Failed') { this.save({ ...job, status: 'failed', error: '数字人服务生成失败，未自动重试。' }); continue }
        if (result.status !== 'Succeeded') { this.save({ ...job, status: 'running', error: undefined }); continue }
        if (!result.result) throw new Error('Missing output')
        const bytes = await this.provider.download(result.result)
        const metadata = await this.inspect(bytes)
        await this.storage.put(`${job.id}.mp4`, bytes)
        this.store.transaction(() => {
          const asset = { id: job.id, projectId: job.projectId, name: '数字人口播.mp4', kind: 'generated', mediaType: 'video', storageExtension: 'mp4', mimeType: 'video/mp4', hasThumbnail: false, model: 'azure-avatar', provider: 'Azure Speech', bytes: bytes.length, hash: createHash('sha256').update(bytes).digest('hex'), createdAt: new Date().toISOString(), ...metadata }
          this.store.db.prepare('INSERT INTO assets VALUES (?, ?, ?)').run(asset.id, asset.projectId, JSON.stringify(asset))
          this.store.event(job.projectId, 'asset.created')
          this.save({ ...job, status: 'completed', assetId: job.id, error: undefined })
        })
      } catch { this.save({ ...job, error: '暂时无法确认结果，保留原任务继续查询，不会重新生成。' }) }
    }
  }
  start() { this.timer = setInterval(() => { void this.tick().catch(() => {}) }, 10000) }
  async close() { clearInterval(this.timer); await Promise.allSettled([...this.active]); await this.checking }
}