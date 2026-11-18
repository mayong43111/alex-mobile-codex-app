import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { ActionType, ResponsePartKind, SessionLifecycle, SessionStatus, chatReducer } from '@microsoft/agent-host-protocol'
import type { ActionEnvelope, ActionOrigin, ChatAction, ChatState, SessionSummary, Snapshot } from '@microsoft/agent-host-protocol'
import { defaultSkills } from '../src/shared.js'
import type { AttachmentInfo, ConversationSummary, PermissionMode, SkillChoices } from '../src/shared.js'
import { AppError } from './errors.js'
import { SqliteDatabase, SqlServerDatabase, upsert } from './database.js'
import type { Database, Queries } from './database.js'
import type { Config } from './config.js'

export const hash = (value: string) => createHash('sha256').update(value).digest('hex')
export interface User { id: string; username: string; password: string }
export interface Login { tokenHash: string; userId: string; username: string; csrf: string; expiresAt: number }
export interface Conversation {
  id: string; userId: string; state: ChatState; runtimeId?: string; model?: string; permissionMode?: PermissionMode
}
export interface ImageJob { fingerprint: string; status: 'running' | 'completed' | 'unknown' | 'failed'; attachmentId?: string }

export class Store {
  readonly database: Database
  constructor(dataDir: string | Database) {
    this.database = typeof dataDir === 'string' ? new SqliteDatabase(dataDir) : dataDir
  }
  static async open(config: Config) {
    return new Store(config.sqlServer ? await SqlServerDatabase.connect(config) : config.dataDir)
  }
  close() { return this.database.close() }
  check() { return this.database.check() }
  async sequence() { return Number((await this.database.get('SELECT value FROM [sequence] WHERE id=1'))!.value) }
  private async nextSequence(db: Queries) {
    await db.run('UPDATE [sequence] SET value=value+1 WHERE id=1')
    return Number((await db.get('SELECT value FROM [sequence] WHERE id=1'))!.value)
  }
  async createUser(username: string, password: string): Promise<User> {
    const user = { id: randomUUID(), username, password }
    await this.database.transaction(async db => {
      if (await db.get('SELECT id FROM users WHERE username=?', [username])) throw new AppError(409, '账号已存在')
      await db.run('INSERT INTO users VALUES (?, ?, ?)', [user.id, user.username, user.password])
    })
    return user
  }
  async user(username: string): Promise<User | undefined> {
    const row = await this.database.get('SELECT id, username, password FROM users WHERE username=?', [username])
    return row ? { id: String(row.id), username: String(row.username), password: String(row.password) } : undefined
  }
  async createLogin(user: User) {
    const token = randomBytes(32).toString('base64url')
    const login: Login = { tokenHash: hash(token), userId: user.id, username: user.username, csrf: randomBytes(32).toString('base64url'), expiresAt: Date.now() + 12 * 3600_000 }
    await this.database.transaction(async db => {
      const current = await db.get('SELECT password FROM users WHERE id=?', [user.id])
      if (!current || current.password !== user.password) throw new AppError(401, '密码已更改，请重新登录')
      await db.run('DELETE FROM logins WHERE expires_at<=?', [Date.now()])
      await db.run('INSERT INTO logins VALUES (?, ?, ?, ?)', [login.tokenHash, user.id, login.csrf, login.expiresAt])
    })
    return { token, login }
  }
  async login(token: string): Promise<Login | undefined> {
    const row = await this.database.get('SELECT l.*, u.username FROM logins l JOIN users u ON u.id=l.user_id WHERE token_hash=? AND expires_at>?', [hash(token), Date.now()])
    return row ? { tokenHash: String(row.token_hash), userId: String(row.user_id), username: String(row.username), csrf: String(row.csrf), expiresAt: Number(row.expires_at) } : undefined
  }
  async revokeLogin(tokenHash: string) { await this.database.run('DELETE FROM logins WHERE token_hash=?', [tokenHash]) }
  async changePassword(user: User, password: string) {
    return this.database.transaction(async db => {
      const current = await db.get('SELECT password FROM users WHERE id=?', [user.id])
      if (!current || current.password !== user.password) throw new AppError(409, '密码已更改，请重新登录后再试')
      const logins = await db.all('SELECT token_hash FROM logins WHERE user_id=?', [user.id])
      await db.run('UPDATE users SET password=? WHERE id=?', [password, user.id])
      await db.run('DELETE FROM logins WHERE user_id=?', [user.id])
      return logins.map(row => String(row.token_hash))
    })
  }
  async skills(userId: string): Promise<SkillChoices> {
    const row = await this.database.get('SELECT data FROM settings WHERE user_id=?', [userId])
    return row ? JSON.parse(String(row.data)) as SkillChoices : { ...defaultSkills }
  }
  async setSkills(userId: string, choices: SkillChoices) {
    await this.database.transaction(db => upsert(db, 'settings', { user_id: userId }, { data: JSON.stringify(choices) }))
  }
  async imageModel(userId: string) {
    const row = await this.database.get('SELECT model FROM image_preferences WHERE user_id=?', [userId])
    return row ? String(row.model) : undefined
  }
  async setImageModel(userId: string, model: string) {
    await this.database.transaction(async db => {
      const conversations = await db.all('SELECT data FROM conversations WHERE user_id=?', [userId])
      if (conversations.some(row => (JSON.parse(String(row.data)) as Conversation).state.activeTurn)) throw new AppError(409, '当前回复结束后才能切换图片模型。')
      await upsert(db, 'image_preferences', { user_id: userId }, { model })
    })
  }
  async createConversation(userId: string, title: string, model?: string, permissionMode: PermissionMode = 'manual'): Promise<Conversation> {
    const id = randomUUID()
    const conversation: Conversation = { id, userId, model, permissionMode, state: { resource: `ahp-chat:/${id}`, title, status: SessionStatus.Idle, modifiedAt: new Date().toISOString(), turns: [] } }
    await this.database.run('INSERT INTO conversations VALUES (?, ?, ?)', [id, userId, JSON.stringify(conversation)])
    return conversation
  }
  private async readConversation(db: Queries, userId: string, id: string): Promise<Conversation> {
    const row = await db.get('SELECT data FROM conversations WHERE id=? AND user_id=?', [id, userId])
    if (!row) throw new AppError(404, '会话不存在')
    return JSON.parse(String(row.data)) as Conversation
  }
  conversation(userId: string, id: string) { return this.readConversation(this.database, userId, id) }
  async conversations(userId: string): Promise<Conversation[]> {
    const modified = this.database.kind === 'sqlserver' ? "JSON_VALUE(data, '$.state.modifiedAt')" : "json_extract(data, '$.state.modifiedAt')"
    return (await this.database.all(`SELECT data FROM conversations WHERE user_id=? ORDER BY ${modified} DESC`, [userId])).map(row => JSON.parse(String(row.data)) as Conversation)
  }
  summary(conversation: Conversation): ConversationSummary {
    return { id: conversation.id, title: conversation.state.title, session: `ahp-session:/${conversation.id}`, chat: conversation.state.resource, updatedAt: conversation.state.modifiedAt, model: conversation.model, permissionMode: conversation.permissionMode ?? 'manual' }
  }
  private async bytes(db: Queries, userId: string) {
    const size = this.database.kind === 'sqlserver' ? "CAST(JSON_VALUE(data, '$.bytes') AS BIGINT)" : "json_extract(data, '$.bytes')"
    return Number((await db.get(`SELECT coalesce(sum(${size}), 0) AS bytes FROM attachments WHERE user_id=?`, [userId]))!.bytes)
  }
  async saveAttachment(userId: string, attachment: AttachmentInfo) {
    await this.database.transaction(async db => {
      if (await this.bytes(db, userId) + attachment.bytes > 200 * 1024 * 1024) throw new AppError(413, '图片存储空间已满，请联系管理员清理。')
      await db.run('INSERT INTO attachments VALUES (?, ?, ?)', [attachment.id, userId, JSON.stringify(attachment)])
    })
  }
  async attachment(userId: string, id: string): Promise<AttachmentInfo> {
    const row = await this.database.get('SELECT data FROM attachments WHERE user_id=? AND id=?', [userId, id])
    if (!row) throw new AppError(404, '图片不存在')
    return JSON.parse(String(row.data)) as AttachmentInfo
  }
  attachmentBytes(userId: string) { return this.bytes(this.database, userId) }
  async imageJob(userId: string, callId: string): Promise<ImageJob | undefined> {
    const row = await this.database.get('SELECT data FROM image_jobs WHERE user_id=? AND call_id=?', [userId, callId])
    return row ? JSON.parse(String(row.data)) as ImageJob : undefined
  }
  async claimImageJob(userId: string, callId: string, job: ImageJob) {
    return this.database.transaction(async db => {
      if (await db.get('SELECT data FROM image_jobs WHERE user_id=? AND call_id=?', [userId, callId])) return false
      await db.run('INSERT INTO image_jobs VALUES (?, ?, ?)', [userId, callId, JSON.stringify(job)])
      return true
    })
  }
  async saveImageJob(userId: string, callId: string, job: ImageJob) {
    await this.database.transaction(db => upsert(db, 'image_jobs', { user_id: userId, call_id: callId }, { data: JSON.stringify(job) }))
  }
  sessionSummary(conversation: Conversation): SessionSummary {
    return { resource: `ahp-session:/${conversation.id}`, provider: 'copilot-azure', title: conversation.state.title, status: conversation.state.status, createdAt: conversation.state.modifiedAt, modifiedAt: conversation.state.modifiedAt }
  }
  async save(conversation: Conversation) {
    await this.database.run('UPDATE conversations SET data=? WHERE id=? AND user_id=?', [JSON.stringify(conversation), conversation.id, conversation.userId])
  }
  async updateConversation(userId: string, id: string, update: (conversation: Conversation) => void) {
    return this.database.transaction(async db => {
      const conversation = await this.readConversation(db, userId, id)
      update(conversation)
      await db.run('UPDATE conversations SET data=? WHERE id=? AND user_id=?', [JSON.stringify(conversation), id, userId])
      return conversation
    })
  }
  async accepted(userId: string, clientId: string, clientSeq: number, fingerprint: string): Promise<ActionEnvelope | undefined> {
    const row = await this.database.get('SELECT input_hash, envelope FROM commands WHERE user_id=? AND client_id=? AND client_seq=?', [userId, clientId, clientSeq])
    if (!row) return undefined
    if (row.input_hash !== fingerprint) throw new AppError(409, '客户端操作编号已被其他内容使用')
    return JSON.parse(String(row.envelope)) as ActionEnvelope
  }
  async apply(userId: string, id: string, action: ChatAction, command?: { clientId: string; clientSeq: number; fingerprint: string }): Promise<ActionEnvelope> {
    return this.database.transaction(async db => {
      const serverSeq = await this.nextSequence(db)
      const conversation = await this.readConversation(db, userId, id)
      conversation.state = chatReducer(conversation.state, action)
      conversation.state.modifiedAt = new Date().toISOString()
      await db.run('UPDATE conversations SET data=? WHERE id=? AND user_id=?', [JSON.stringify(conversation), id, userId])
      const origin: ActionOrigin | undefined = command ? { clientId: command.clientId, clientSeq: command.clientSeq } : undefined
      const envelope: ActionEnvelope = { channel: conversation.state.resource, action, serverSeq, origin }
      if (command) await db.run('INSERT INTO commands VALUES (?, ?, ?, ?, ?)', [userId, command.clientId, command.clientSeq, command.fingerprint, JSON.stringify(envelope)])
      return envelope
    })
  }
  async sessionUpdate(userId: string, id: string): Promise<ActionEnvelope> {
    return this.database.transaction(async db => {
      const serverSeq = await this.nextSequence(db)
      const { state } = await this.readConversation(db, userId, id)
      return {
        channel: `ahp-session:/${id}`, serverSeq, origin: undefined,
        action: { type: ActionType.SessionChatUpdated, chat: state.resource, changes: {
          title: state.title, status: state.status, modifiedAt: state.modifiedAt, activity: state.activity,
        } },
      }
    })
  }
  async snapshot(userId: string, channel: string): Promise<Snapshot> {
    return this.database.transaction(async db => {
      const fromSeq = Number((await db.get('SELECT value FROM [sequence] WHERE id=1'))!.value)
      if (channel === 'ahp-root://') return { resource: channel, fromSeq, state: {
        agents: [{ provider: 'copilot-azure', displayName: 'Copilot · Azure', description: 'Mobile creation assistant', models: [] }],
        activeSessions: Number((await db.get('SELECT count(*) AS count FROM conversations WHERE user_id=?', [userId]))!.count),
      } }
      const match = /^ahp-(session|chat):\/([0-9a-f-]{36})$/.exec(channel)
      if (!match) throw new AppError(404, '通道不存在')
      const conversation = await this.readConversation(db, userId, match[2])
      const { state } = conversation
      if (match[1] === 'chat') return { resource: channel, fromSeq, state }
      return { resource: channel, fromSeq, state: {
        lifecycle: SessionLifecycle.Ready, provider: 'copilot-azure', title: state.title, status: state.status,
        activeClients: [], chats: [{ resource: state.resource, title: state.title, status: state.status, modifiedAt: state.modifiedAt }],
        defaultChat: state.resource,
      } }
    })
  }
  async interruptActiveTurns() {
    for (const row of await this.database.all('SELECT data FROM conversations')) {
      const conversation = JSON.parse(String(row.data)) as Conversation
      if (!conversation.state.activeTurn) continue
      await this.apply(conversation.userId, conversation.id, {
        type: ActionType.ChatError, turnId: conversation.state.activeTurn.id, duration: 0,
        part: { kind: ResponsePartKind.Error, error: { errorType: 'interrupted', message: '服务重启，对话已中断；外部任务可能已计费，未自动重试。' } },
      })
    }
  }
}
