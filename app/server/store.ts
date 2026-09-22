import { DatabaseSync } from 'node:sqlite'
import { randomUUID, createHash } from 'node:crypto'
import type { AgentInput, AgentRun, Asset, Job, Message, Project, Snapshot, Submission } from '../src/domain.ts'

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

  project(id: string): Project {
    const row = this.db.prepare('SELECT data FROM projects WHERE id = ?').get(id)
    if (!row) throw new HttpError(404, 'Project not found')
    return JSON.parse(row.data as string)
  }

  projects(): Project[] {
    return this.db.prepare("SELECT data FROM projects ORDER BY json_extract(data, '$.updatedAt') DESC").all()
      .map(row => JSON.parse(row.data as string))
  }

  createProject(title: string): Project {
    const now = new Date().toISOString()
    const project: Project = { id: randomUUID(), title, createdAt: now, updatedAt: now }
    this.db.prepare('INSERT INTO projects VALUES (?, ?)').run(project.id, JSON.stringify(project))
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

  queueAgent(projectId: string, input: AgentInput): AgentRun {
    return this.transaction(() => {
      this.project(projectId)
      const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex')
      const existing = this.db.prepare('SELECT data, input_hash FROM agent_runs WHERE project_id = ? AND request_id = ?').get(projectId, input.requestId)
      if (existing) {
        if (existing.input_hash !== hash) throw new HttpError(409, 'Request ID already used')
        return JSON.parse(existing.data as string)
      }
      const pending = this.db.prepare("SELECT COUNT(*) AS count FROM agent_runs WHERE json_extract(data, '$.status') IN ('queued', 'running')").get()!
      if (Number(pending.count) >= 10) throw new HttpError(429, 'Too many pending requests')
      const now = new Date().toISOString()
      const message: Message = { id: randomUUID(), projectId, text: input.text, assetIds: [], role: 'user', createdAt: now }
      const run: AgentRun = { id: randomUUID(), projectId, messageId: message.id, assistantId: randomUUID(), input,
        status: 'queued', stage: 'codex', reply: '', threadId: null, createdAt: now, updatedAt: now }
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

  resend(projectId: string, messageId: string, request: { requestId: string; expectedTailId: string }, agent: boolean): AgentRun | Job {
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
      if (agent && message.assetIds.length) throw new HttpError(400, '当前 Codex 不支持带参考图的消息重发。')
      const history = snapshot.messages.slice(0, position)
      if (agent && (history.length > 200 || history.reduce((total, entry) => total + entry.text.length, 0) > 200000)) throw new HttpError(400, '保留的历史过长，请新建项目。')
      if (agent && Number(this.db.prepare("SELECT COUNT(*) AS count FROM agent_runs WHERE json_extract(data, '$.status') IN ('queued', 'running')").get()!.count) >= 10) throw new HttpError(429, 'Too many pending requests')
      for (const removed of snapshot.messages.slice(position)) {
        this.db.prepare("DELETE FROM agent_runs WHERE project_id = ? AND json_extract(data, '$.messageId') = ?").run(projectId, removed.id)
        this.db.prepare("DELETE FROM jobs WHERE project_id = ? AND json_extract(data, '$.messageId') = ?").run(projectId, removed.id)
        if (removed.id !== messageId) this.db.prepare('DELETE FROM messages WHERE id = ? AND project_id = ?').run(removed.id, projectId)
      }
      this.db.prepare('DELETE FROM sessions WHERE project_id = ?').run(projectId)
      const now = new Date().toISOString()
      let result: AgentRun | Job
      if (agent) {
        const input: AgentInput = originalRun ? { ...originalRun.input, requestId: request.requestId } : {
          requestId: request.requestId, text: message.text, mode: 'auto', ratio: '1:1',
        }
        result = { id: randomUUID(), projectId, messageId, assistantId: randomUUID(), input, status: 'queued', stage: 'codex', reply: '', threadId: null, createdAt: now, updatedAt: now }
        this.db.prepare('INSERT INTO agent_runs VALUES (?, ?, ?, ?, ?)').run(result.id, projectId, request.requestId, createHash('sha256').update(JSON.stringify(input)).digest('hex'), JSON.stringify(result))
      } else {
        if (!originalJob) throw new HttpError(503, 'Codex 未配置，无法重新发送此消息。')
        result = { ...originalJob, id: randomUUID(), status: 'waiting_service', createdAt: now, updatedAt: now }
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

  updateAgent(id: string, changes: Partial<Pick<AgentRun, 'status' | 'stage' | 'reply' | 'threadId' | 'error' | 'assetId' | 'progress' | 'imageOperation' | 'sourceAssetId'>>): AgentRun {
    return this.transaction(() => {
      const run = { ...this.agentRun(id), ...changes, updatedAt: new Date().toISOString() }
      this.db.prepare('UPDATE agent_runs SET data = ? WHERE id = ?').run(JSON.stringify(run), id)
      if (run.threadId) this.db.prepare('INSERT INTO sessions VALUES (?, ?) ON CONFLICT(project_id) DO UPDATE SET thread_id = excluded.thread_id').run(run.projectId, run.threadId)
      if (run.reply) {
        const message: Message = { id: run.assistantId, projectId: run.projectId, role: 'assistant', text: run.reply,
          assetIds: run.assetId ? [run.assetId] : [], createdAt: run.createdAt }
        this.db.prepare('INSERT INTO messages VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data').run(message.id, message.projectId, JSON.stringify(message))
      }
      this.event(run.projectId, 'agent.changed')
      return run
    })
  }

  recoverAgentRuns() {
    const rows = this.db.prepare("SELECT id FROM agent_runs WHERE json_extract(data, '$.status') = 'running'").all()
    for (const row of rows) this.updateAgent(row.id as string, { status: 'interrupted', error: '服务已重启，请核实之前的请求结果；未自动重试，已提交调用可能计费。' })
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

  addAsset(asset: Asset) {
    this.transaction(() => {
      this.project(asset.projectId)
      this.db.prepare('INSERT INTO assets VALUES (?, ?, ?)').run(asset.id, asset.projectId, JSON.stringify(asset))
      this.event(asset.projectId, 'asset.created')
    })
    return asset
  }
}