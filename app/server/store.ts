import { DatabaseSync } from 'node:sqlite'
import { randomUUID, createHash } from 'node:crypto'
import type { AgentInput, AgentRun, Asset, Job, Message, Project, Snapshot, Submission } from '../src/domain.ts'
import { assetExtension, assetHasThumbnail, defaultUserSettings } from '../src/domain.ts'
import type { UserSettings } from '../src/domain.ts'

export class HttpError extends Error {
  statusCode: number
  constructor(statusCode: number, message: string) {
    super(message)
    this.statusCode = statusCode
  }
}

export class Store {
  db: DatabaseSync
  constructor(path: string, journalMode: 'WAL' | 'DELETE' = 'WAL') {
    this.db = new DatabaseSync(path)
    this.db.exec(`
      PRAGMA journal_mode = ${journalMode === 'DELETE' ? 'DELETE' : 'WAL'};
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS project_owners (project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE, user_id TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS project_owners_user ON project_owners(user_id);
      CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS assets (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), request_id TEXT NOT NULL, input_hash TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(project_id, request_id));
      CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL REFERENCES projects(id), kind TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS messages_project ON messages(project_id);
      CREATE INDEX IF NOT EXISTS assets_project ON assets(project_id);
      CREATE INDEX IF NOT EXISTS jobs_project ON jobs(project_id);
      CREATE INDEX IF NOT EXISTS events_project ON events(project_id, id);
      CREATE TABLE IF NOT EXISTS agent_runs (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), request_id TEXT NOT NULL, input_hash TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(project_id, request_id));
      CREATE TABLE IF NOT EXISTS sessions (project_id TEXT PRIMARY KEY REFERENCES projects(id), thread_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS message_resends (project_id TEXT NOT NULL REFERENCES projects(id), request_id TEXT NOT NULL, input_hash TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY(project_id, request_id));
      CREATE TABLE IF NOT EXISTS asset_cleanup (name TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS hidden_references (source_id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS user_settings (user_id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS avatar_jobs (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, request_id TEXT NOT NULL, input_hash TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(project_id, request_id));
    `)
  }

  transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = operation()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  userSettings(userId: string): UserSettings {
    const row = this.db.prepare('SELECT data FROM user_settings WHERE user_id = ?').get(userId)
    return { ...defaultUserSettings, ...(row ? JSON.parse(row.data as string) : {}) }
  }

  updateUserSettings(userId: string, changes: Partial<UserSettings>): UserSettings {
    return this.transaction(() => {
      const settings = { ...this.userSettings(userId), ...changes }
      this.db.prepare('INSERT INTO user_settings (user_id, data) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET data = excluded.data').run(userId, JSON.stringify(settings))
      return settings
    })
  }

  project(id: string): Project {
    const row = this.db.prepare('SELECT data FROM projects WHERE id = ?').get(id)
    if (!row) throw new HttpError(404, 'Project not found')
    return JSON.parse(row.data as string)
  }

  requireOwner(projectId: string, userId: string) {
    if (!this.db.prepare('SELECT 1 FROM project_owners WHERE project_id = ? AND user_id = ?').get(projectId, userId)) throw new HttpError(404, 'Project not found')
  }

  projects(userId?: string): Project[] {
    if (userId !== undefined) return this.db.prepare("SELECT projects.data FROM projects JOIN project_owners ON projects.id = project_owners.project_id WHERE user_id = ? ORDER BY json_extract(projects.data, '$.updatedAt') DESC").all(userId).map(row => JSON.parse(row.data as string))
    return this.db.prepare("SELECT data FROM projects ORDER BY json_extract(data, '$.updatedAt') DESC").all()
      .map(row => JSON.parse(row.data as string))
  }

  createProject(title: string, userId?: string): Project {
    const now = new Date().toISOString()
    const project: Project = { id: randomUUID(), title, createdAt: now, updatedAt: now }
    this.transaction(() => {
      this.db.prepare('INSERT INTO projects VALUES (?, ?)').run(project.id, JSON.stringify(project))
      if (userId !== undefined) this.db.prepare('INSERT INTO project_owners VALUES (?, ?)').run(project.id, userId)
    })
    return project
  }

  rename(id: string, title: string) {
    return this.transaction(() => {
      const project = { ...this.project(id), title, updatedAt: new Date().toISOString() }
      this.db.prepare('UPDATE projects SET data = ? WHERE id = ?').run(JSON.stringify(project), id)
      this.event(id, 'project.updated')
      return project
    })
  }

  deleteProject(id: string, expectedUpdatedAt: string) {
    return this.transaction(() => {
      const snapshot = this.snapshot(id)
      if (snapshot.project.updatedAt !== expectedUpdatedAt) throw new HttpError(409, '项目已更新，请重新确认删除。')
      if (snapshot.runs.some(run => ['queued', 'running'].includes(run.status))) throw new HttpError(409, '请先停止并等待项目任务结束。')
      if (this.db.prepare("SELECT 1 FROM avatar_jobs WHERE project_id = ? AND json_extract(data, '$.status') IN ('submitting','running','unknown')").get(id)) throw new HttpError(409, '数字人任务尚未结束，请先等待或核查原任务。')
      for (const asset of snapshot.assets) {
        for (const extension of [assetExtension(asset), ...(assetHasThumbnail(asset) ? ['webp'] : [])]) this.db.prepare('INSERT OR IGNORE INTO asset_cleanup VALUES (?)').run(`${asset.id}.${extension}`)
      }
      for (const table of ['messages', 'assets', 'jobs', 'agent_runs', 'sessions', 'events', 'message_resends']) this.db.prepare(`DELETE FROM ${table} WHERE project_id = ?`).run(id)
      this.db.prepare('DELETE FROM projects WHERE id = ?').run(id)
    })
  }

  requireIdleProject(projectId: string) {
    this.project(projectId)
    if (this.db.prepare("SELECT 1 FROM agent_runs WHERE project_id = ? AND json_extract(data, '$.status') IN ('queued','running')").get(projectId)) throw new HttpError(409, '请先停止并等待项目任务结束。')
    if (this.db.prepare("SELECT 1 FROM avatar_jobs WHERE project_id = ? AND json_extract(data, '$.status') IN ('submitting','running','unknown')").get(projectId)) throw new HttpError(409, '数字人任务尚未结束，请先等待或核查原任务。')
  }

  clearConversation(projectId: string, expectedUpdatedAt: string) {
    return this.transaction(() => {
      this.requireIdleProject(projectId)
      if (this.project(projectId).updatedAt !== expectedUpdatedAt) throw new HttpError(409, '会话已更新，请重新确认清空。')
      for (const table of ['messages', 'jobs', 'agent_runs', 'sessions', 'message_resends', 'avatar_jobs']) this.db.prepare(`DELETE FROM ${table} WHERE project_id = ?`).run(projectId)
      this.event(projectId, 'conversation.cleared')
    })
  }

  deleteImage(id: string, expectedHash: string) {
    return this.transaction(() => {
      const asset = this.asset(id)
      this.requireIdleProject(asset.projectId)
      if ((asset.mediaType ?? 'image') !== 'image') throw new HttpError(400, '此操作仅支持删除图片。')
      if (asset.hash !== expectedHash) throw new HttpError(409, '图片已更新，请重新确认删除。')
      this.db.prepare('INSERT OR IGNORE INTO hidden_references VALUES (?)').run(asset.kind === 'generated' ? asset.id : asset.sourceAssetId ?? asset.id)
      for (const extension of [assetExtension(asset), ...(assetHasThumbnail(asset) ? ['webp'] : [])]) this.db.prepare('INSERT OR IGNORE INTO asset_cleanup VALUES (?)').run(`${asset.id}.${extension}`)
      const messages = this.db.prepare('SELECT id, data FROM messages WHERE project_id = ?').all(asset.projectId)
      for (const row of messages) {
        const message: Message = JSON.parse(row.data as string)
        if (message.assetIds.includes(id)) this.db.prepare('UPDATE messages SET data = ? WHERE id = ?').run(JSON.stringify({ ...message, assetIds: message.assetIds.filter(assetId => assetId !== id) }), row.id)
      }
      const runs = this.db.prepare('SELECT id, data FROM agent_runs WHERE project_id = ?').all(asset.projectId)
      for (const row of runs) {
        const run: AgentRun = JSON.parse(row.data as string)
        if (run.assetId === id || run.processedAssetIds?.includes(id)) {
          if (run.assetId === id) delete run.assetId
          if (run.processedAssetIds) run.processedAssetIds = run.processedAssetIds.filter(assetId => assetId !== id)
          this.db.prepare('UPDATE agent_runs SET data = ? WHERE id = ?').run(JSON.stringify(run), row.id)
        }
      }
      this.db.prepare('DELETE FROM assets WHERE id = ?').run(id)
      this.event(asset.projectId, 'asset.deleted')
    })
  }

  pendingAssetCleanup(): string[] {
    return this.db.prepare('SELECT name FROM asset_cleanup').all().map(row => row.name as string)
  }

  completeAssetCleanup(name: string) {
    this.db.prepare('DELETE FROM asset_cleanup WHERE name = ?').run(name)
  }

  hasPendingRuns() {
    return Number(this.db.prepare("SELECT COUNT(*) AS count FROM agent_runs WHERE json_extract(data, '$.status') IN ('queued', 'running')").get()!.count) > 0
  }

  event(projectId: string, kind: string) {
    const project = { ...this.project(projectId), updatedAt: new Date().toISOString() }
    this.db.prepare('UPDATE projects SET data = ? WHERE id = ?').run(JSON.stringify(project), projectId)
    this.db.prepare('INSERT INTO events(project_id, kind) VALUES (?, ?)').run(projectId, kind)
  }

  events(projectId: string, after: number) {
    this.project(projectId)
    return this.db.prepare('SELECT id, kind FROM events WHERE project_id = ? AND id > ? ORDER BY id LIMIT 501').all(projectId, after)
  }

  snapshot(projectId: string): Snapshot {
    const project = this.project(projectId)
    const list = <T>(table: 'messages' | 'assets' | 'jobs' | 'agent_runs'): T[] => this.db
      .prepare(`SELECT data FROM ${table} WHERE project_id = ? ORDER BY rowid`).all(projectId)
      .map(row => JSON.parse(row.data as string))
    return { project, messages: list<Message>('messages'), assets: list<Asset>('assets'), jobs: list<Job>('jobs'), runs: list<AgentRun>('agent_runs'), threadId: this.threadId(projectId) }
  }

  threadId(projectId: string): string | null {
    return this.db.prepare('SELECT thread_id FROM sessions WHERE project_id = ?').get(projectId)?.thread_id as string ?? null
  }

  conversation(projectId: string, before?: string): Snapshot {
    const project = this.project(projectId)
    const cursor = before ? this.db.prepare('SELECT rowid FROM messages WHERE project_id = ? AND id = ?').get(projectId, before) : undefined
    if (before && !cursor) throw new HttpError(409, '对话已更新，请刷新后加载历史。')
    const rows = this.db.prepare('SELECT data FROM messages WHERE project_id = ? AND rowid < ? ORDER BY rowid DESC LIMIT 11').all(projectId, cursor?.rowid ?? Number.MAX_SAFE_INTEGER)
    const messages: Message[] = rows.slice(0, 10).reverse().map(row => JSON.parse(row.data as string))
    const ids = JSON.stringify(messages.map(message => message.id))
    const runs = this.db.prepare("SELECT json_remove(data, '$.progress') AS data FROM agent_runs WHERE project_id = ? AND (json_extract(data, '$.messageId') IN (SELECT value FROM json_each(?)) OR json_extract(data, '$.assistantId') IN (SELECT value FROM json_each(?)) OR json_extract(data, '$.status') IN ('queued', 'running')) ORDER BY rowid").all(projectId, ids, ids).map(row => JSON.parse(row.data as string))
    const jobs = this.db.prepare("SELECT data FROM jobs WHERE project_id = ? AND json_extract(data, '$.messageId') IN (SELECT value FROM json_each(?)) ORDER BY rowid").all(projectId, ids).map(row => JSON.parse(row.data as string))
    const assets = this.db.prepare('SELECT data FROM assets WHERE project_id = ? ORDER BY rowid').all(projectId).map(row => JSON.parse(row.data as string))
    const tailId = this.db.prepare('SELECT id FROM messages WHERE project_id = ? ORDER BY rowid DESC LIMIT 1').get(projectId)?.id as string ?? null
    return { project, messages, runs, jobs, assets, threadId: this.threadId(projectId), page: { before: rows.length > 10 ? messages[0].id : null, tailId } }
  }

  tasks(projectId: string): Pick<Snapshot, 'runs' | 'jobs'> {
    this.project(projectId)
    const runs = this.db.prepare("SELECT json_remove(data, '$.progress') AS data FROM agent_runs WHERE project_id = ? ORDER BY rowid").all(projectId).map(row => JSON.parse(row.data as string))
    const jobs = this.db.prepare('SELECT data FROM jobs WHERE project_id = ? ORDER BY rowid').all(projectId).map(row => JSON.parse(row.data as string))
    return { runs, jobs }
  }

  queueAgent(projectId: string, input: AgentInput): AgentRun {
    return this.transaction(() => {
      this.project(projectId)
      const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex')
      const existing = this.db.prepare('SELECT data, input_hash FROM agent_runs WHERE project_id = ? AND request_id = ?').get(projectId, input.requestId)
      if (existing) {
        if (existing.input_hash !== hash) throw new HttpError(409, 'Request ID already used')
        return JSON.parse(existing.data as string)
      }
      const assetIds = input.assetIds ?? []
      if (assetIds.length > 10 || new Set(assetIds).size !== assetIds.length) throw new HttpError(400, 'Invalid attachments')
      for (const id of assetIds) {
        if (this.asset(id).projectId !== projectId) throw new HttpError(400, 'Attachment belongs to another project')
      }
      if (input.directImage) {
        if (input.mode !== 'image' || (input.videoModel ?? 'none') !== 'none') throw new HttpError(400, 'Direct image requires image mode without video')
        if (input.directImage.operation === 'generate' && assetIds.length) throw new HttpError(400, 'Direct generation does not accept source attachments')
        if (input.directImage.operation === 'edit') {
          const sourceId = input.directImage.sourceAssetId
          if (!assetIds.length || assetIds[0] !== sourceId || assetIds.some(id => (this.asset(id).mediaType ?? 'image') !== 'image')) throw new HttpError(400, 'Direct edit requires explicitly selected images with the primary source first')
        }
      }
      const pending = this.db.prepare("SELECT COUNT(*) AS count FROM agent_runs WHERE json_extract(data, '$.status') IN ('queued', 'running')").get()!
      if (Number(pending.count) >= 10) throw new HttpError(429, 'Too many pending requests')
      const now = new Date().toISOString()
      const message: Message = { id: randomUUID(), projectId, text: input.text, assetIds, role: 'user', createdAt: now }
      const run: AgentRun = { id: randomUUID(), projectId, messageId: message.id, assistantId: randomUUID(), input,
        status: 'queued', stage: input.directImage ? 'image' : 'codex', reply: '', threadId: null, createdAt: now, updatedAt: now }
      this.db.prepare('INSERT INTO messages VALUES (?, ?, ?)').run(message.id, projectId, JSON.stringify(message))
      this.db.prepare('INSERT INTO agent_runs VALUES (?, ?, ?, ?, ?)').run(run.id, projectId, input.requestId, hash, JSON.stringify(run))
      this.event(projectId, 'agent.queued')
      return run
    })
  }

  agentRun(id: string): AgentRun {
    const row = this.db.prepare('SELECT data FROM agent_runs WHERE id = ?').get(id)
    if (!row) throw new HttpError(404, 'Run not found')
    return JSON.parse(row.data as string)
  }

  resend(projectId: string, messageId: string, request: { requestId: string; expectedTailId: string; text?: string }, agent: boolean): AgentRun | Job {
    return this.transaction(() => {
      const hash = createHash('sha256').update(JSON.stringify({ messageId, ...request, agent })).digest('hex')
      const previous = this.db.prepare('SELECT input_hash, result FROM message_resends WHERE project_id = ? AND request_id = ?').get(projectId, request.requestId)
      if (previous) {
        if (previous.input_hash !== hash) throw new HttpError(409, 'Request ID already used')
        const result: AgentRun | Job = JSON.parse(previous.result as string)
        const table = 'input' in result ? 'agent_runs' : 'jobs'
        if (!this.db.prepare(`SELECT id FROM ${table} WHERE id = ?`).get(result.id)) throw new HttpError(409, '这次重发已被后续操作替代，请刷新对话。')
        return result
      }
      const snapshot = this.snapshot(projectId)
      const position = snapshot.messages.findIndex(message => message.id === messageId)
      const message = snapshot.messages[position]
      if (!message || message.role === 'assistant') throw new HttpError(400, '只能重新发送自己的消息。')
      if (snapshot.messages.at(-1)?.id !== request.expectedTailId) throw new HttpError(409, '对话已更新，请刷新后重新确认。')
      if (snapshot.runs.some(run => run.status === 'running' || run.status === 'queued')) throw new HttpError(409, '请先停止待处理的回复，待运行结束后重新发送。')
      const originalRun = snapshot.runs.find(run => run.messageId === messageId)
      const originalJob = snapshot.jobs.find(job => job.messageId === messageId)
      if (!originalRun && !originalJob) throw new HttpError(400, '找不到这条消息的发送参数。')
      const text = request.text === undefined ? message.text : request.text.trim()
      if (!text || text.length > 6000) throw new HttpError(400, '消息需要包含 1 到 6000 个字符。')
      if (agent && Number(this.db.prepare("SELECT COUNT(*) AS count FROM agent_runs WHERE json_extract(data, '$.status') IN ('queued', 'running')").get()!.count) >= 10) throw new HttpError(429, 'Too many pending requests')
      for (const removed of snapshot.messages.slice(position)) {
        this.db.prepare("DELETE FROM agent_runs WHERE project_id = ? AND json_extract(data, '$.messageId') = ?").run(projectId, removed.id)
        this.db.prepare("DELETE FROM jobs WHERE project_id = ? AND json_extract(data, '$.messageId') = ?").run(projectId, removed.id)
        if (removed.id !== messageId) this.db.prepare('DELETE FROM messages WHERE id = ? AND project_id = ?').run(removed.id, projectId)
      }
      this.db.prepare('DELETE FROM sessions WHERE project_id = ?').run(projectId)
      this.db.prepare('UPDATE messages SET data = ? WHERE id = ?').run(JSON.stringify({ ...message, text }), messageId)
      const now = new Date().toISOString()
      let result: AgentRun | Job
      if (agent) {
        const input: AgentInput = originalRun ? { ...originalRun.input, text, requestId: request.requestId } : {
          requestId: request.requestId, text, assetIds: message.assetIds, mode: 'auto', ratio: '1:1',
        }
        result = { id: randomUUID(), projectId, messageId, assistantId: randomUUID(), input, status: 'queued', stage: input.directImage ? 'image' : 'codex', reply: '', threadId: null, createdAt: now, updatedAt: now }
        this.db.prepare('INSERT INTO agent_runs VALUES (?, ?, ?, ?, ?)').run(result.id, projectId, request.requestId, createHash('sha256').update(JSON.stringify(input)).digest('hex'), JSON.stringify(result))
      } else {
        if (!originalJob) throw new HttpError(503, 'Codex 未配置，无法重新发送此消息。')
        result = { ...originalJob, prompt: text, id: randomUUID(), status: 'waiting_service', createdAt: now, updatedAt: now }
        const input = { text: result.prompt, assetIds: result.assetIds, ratio: result.ratio }
        this.db.prepare('INSERT INTO jobs VALUES (?, ?, ?, ?, ?)').run(result.id, projectId, request.requestId, createHash('sha256').update(JSON.stringify(input)).digest('hex'), JSON.stringify(result))
      }
      this.db.prepare('INSERT INTO message_resends VALUES (?, ?, ?, ?)').run(projectId, request.requestId, hash, JSON.stringify(result))
      this.event(projectId, 'message.resent')
      return result
    })
  }

  nextAgentRun(): AgentRun | null {
    const row = this.db.prepare("SELECT data FROM agent_runs WHERE json_extract(data, '$.status') = 'queued' ORDER BY rowid LIMIT 1").get()
    return row ? JSON.parse(row.data as string) : null
  }

  updateAgent(id: string, changes: Partial<Pick<AgentRun, 'status' | 'stage' | 'reply' | 'threadId' | 'error' | 'assetId' | 'processedAssetIds' | 'progress' | 'imageOperation' | 'sourceAssetId' | 'avatarJobId' | 'narration' | 'story'>>): AgentRun {
    return this.transaction(() => {
      const current = this.agentRun(id)
      if (Object.entries(changes).every(([key, value]) => JSON.stringify(current[key as keyof AgentRun]) === JSON.stringify(value))) return current
      const run = { ...current, ...changes, updatedAt: new Date().toISOString() }
      this.db.prepare('UPDATE agent_runs SET data = ? WHERE id = ?').run(JSON.stringify(run), id)
      if (run.threadId) this.db.prepare('INSERT INTO sessions VALUES (?, ?) ON CONFLICT(project_id) DO UPDATE SET thread_id = excluded.thread_id').run(run.projectId, run.threadId)
      if (run.reply || run.assetId) {
        const message: Message = { id: run.assistantId, projectId: run.projectId, role: 'assistant', text: run.reply,
          assetIds: [...(run.narration?.scriptAssetId ? [run.narration.scriptAssetId] : []), ...(run.story?.scriptAssetId ? [run.story.scriptAssetId] : []), ...(run.processedAssetIds ?? []), ...(run.assetId ? [run.assetId] : [])], createdAt: run.createdAt }
        this.db.prepare('INSERT INTO messages VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data').run(message.id, message.projectId, JSON.stringify(message))
      }
      this.event(run.projectId, 'agent.changed')
      return run
    })
  }

  recoverAgentRuns() {
    const rows = this.db.prepare("SELECT id FROM agent_runs WHERE json_extract(data, '$.status') = 'running'").all()
    for (const row of rows) { const run = this.agentRun(row.id as string); this.updateAgent(run.id, run.avatarJobId || run.story ? { status: 'queued' } : { status: 'interrupted', error: '服务已重启，请核实之前的请求结果；未自动重试，已提交调用可能计费。' }) }
  }

  submit(projectId: string, input: Submission): Job {
    return this.transaction(() => {
      this.project(projectId)
      const hash = createHash('sha256').update(JSON.stringify({ text: input.text, assetIds: input.assetIds, ratio: input.ratio })).digest('hex')
      const previous = this.db.prepare('SELECT input_hash, data FROM jobs WHERE project_id = ? AND request_id = ?').get(projectId, input.requestId)
      if (previous) {
        if (previous.input_hash !== hash) throw new HttpError(409, 'Request ID already used for different content')
        return JSON.parse(previous.data as string)
      }
      for (const id of input.assetIds) {
        if (this.asset(id).projectId !== projectId) throw new HttpError(400, 'Reference belongs to another project')
      }
      const now = new Date().toISOString()
      const message: Message = { id: randomUUID(), projectId, text: input.text, assetIds: input.assetIds, createdAt: now }
      const job: Job = {
        id: randomUUID(), projectId, messageId: message.id, prompt: input.text, assetIds: input.assetIds,
        ratio: input.ratio, status: 'waiting_service', createdAt: now, updatedAt: now,
      }
      this.db.prepare('INSERT INTO messages VALUES (?, ?, ?)').run(message.id, projectId, JSON.stringify(message))
      this.db.prepare('INSERT INTO jobs VALUES (?, ?, ?, ?, ?)').run(job.id, projectId, input.requestId, hash, JSON.stringify(job))
      this.event(projectId, 'message.created')
      return job
    })
  }

  cancel(id: string): Job {
    return this.transaction(() => {
      const row = this.db.prepare('SELECT data FROM jobs WHERE id = ?').get(id)
      if (!row) throw new HttpError(404, 'Job not found')
      const job: Job = JSON.parse(row.data as string)
      if (job.status !== 'cancelled') {
        job.status = 'cancelled'
        job.updatedAt = new Date().toISOString()
        this.db.prepare('UPDATE jobs SET data = ? WHERE id = ?').run(JSON.stringify(job), id)
        this.event(job.projectId, 'job.cancelled')
      }
      return job
    })
  }

  asset(id: string): Asset {
    const row = this.db.prepare('SELECT data FROM assets WHERE id = ?').get(id)
    if (!row) throw new HttpError(404, 'Image not found')
    return JSON.parse(row.data as string)
  }

  renameImage(id: string, name: string, expectedName: string): Asset {
    return this.transaction(() => {
      const asset = this.asset(id)
      if ((asset.mediaType ?? 'image') !== 'image') throw new HttpError(400, '此操作仅支持图片。')
      if (asset.name !== expectedName) throw new HttpError(409, '图片名称已更新，请刷新后重试。')
      const updated = { ...asset, name }
      this.db.prepare('UPDATE assets SET data = ? WHERE id = ?').run(JSON.stringify(updated), id)
      this.event(asset.projectId, 'asset.renamed')
      return updated
    })
  }

  referenceImages(userId?: string, projectId?: string): Asset[] {
    const rows = this.db.prepare(`SELECT assets.data FROM assets
      WHERE json_extract(assets.data, '$.kind') IN ('reference', 'generated')
      AND COALESCE(json_extract(assets.data, '$.mediaType'), 'image') = 'image'
      ${projectId === undefined ? "AND NOT EXISTS (SELECT 1 FROM hidden_references WHERE source_id = CASE WHEN json_extract(assets.data, '$.kind') = 'generated' THEN assets.id ELSE COALESCE(json_extract(assets.data, '$.sourceAssetId'), assets.id) END)" : 'AND assets.project_id = ?'}
      ${userId === undefined ? '' : 'AND EXISTS (SELECT 1 FROM project_owners WHERE project_id = assets.project_id AND user_id = ?)'}
      ORDER BY assets.rowid`).all(...(projectId === undefined ? [] : [projectId]), ...(userId === undefined ? [] : [userId]))
    const images = new Map<string, Asset>()
    for (const row of rows) {
      const asset: Asset = JSON.parse(row.data as string)
      const sourceId = asset.kind === 'generated' ? asset.id : asset.sourceAssetId ?? asset.id
      if (!images.has(sourceId)) images.set(sourceId, asset)
    }
    return [...images.values()].reverse()
  }

  referenceCopy(projectId: string, sourceId: string): Asset | undefined {
    const row = this.db.prepare("SELECT data FROM assets WHERE project_id = ? AND (id = ? OR json_extract(data, '$.sourceAssetId') = ?) AND json_extract(data, '$.kind') = 'reference' LIMIT 1").get(projectId, sourceId, sourceId)
    return row ? JSON.parse(row.data as string) : undefined
  }

  addAsset(asset: Asset) {
    this.transaction(() => {
      this.project(asset.projectId)
      this.db.prepare('INSERT INTO assets VALUES (?, ?, ?)').run(asset.id, asset.projectId, JSON.stringify(asset))
      this.event(asset.projectId, 'asset.created')
    })
    return asset
  }
}