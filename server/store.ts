import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { ActionType, ResponsePartKind, SessionLifecycle, SessionStatus, chatReducer } from '@microsoft/agent-host-protocol'
import type { ActionEnvelope, ActionOrigin, ChatAction, ChatState, SessionSummary, Snapshot } from '@microsoft/agent-host-protocol'
import { defaultSkills } from '../src/shared.js'
import type { ConversationSummary, SkillChoices } from '../src/shared.js'
import { AppError } from './errors.js'

export const hash = (value: string) => createHash('sha256').update(value).digest('hex')
export interface User { id: string; username: string; password: string }
export interface Login { tokenHash: string; userId: string; username: string; csrf: string; expiresAt: number }
export interface Conversation {
  id: string; userId: string; state: ChatState; runtimeId?: string
}

export class Store {
  private db: DatabaseSync
  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(join(dataDir, 'studio.sqlite'))
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS logins (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), csrf TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS settings (user_id TEXT PRIMARY KEY REFERENCES users(id), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS conversations_owner ON conversations(user_id);
      CREATE TABLE IF NOT EXISTS commands (user_id TEXT NOT NULL, client_id TEXT NOT NULL, client_seq INTEGER NOT NULL, input_hash TEXT NOT NULL, envelope TEXT NOT NULL, PRIMARY KEY(user_id, client_id, client_seq));
      CREATE TABLE IF NOT EXISTS sequence (id INTEGER PRIMARY KEY CHECK(id=1), value INTEGER NOT NULL);
      INSERT OR IGNORE INTO sequence VALUES (1, 0);
    `)
  }
  close() { this.db.close() }
  get sequence(): number { return Number(this.db.prepare('SELECT value FROM sequence WHERE id=1').get()!.value) }
  private nextSequence() { this.db.exec('UPDATE sequence SET value=value+1 WHERE id=1'); return this.sequence }
  createUser(username: string, password: string): User {
    const user = { id: randomUUID(), username, password }
    if (this.user(username)) throw new AppError(409, '账号已存在')
    this.db.prepare('INSERT INTO users VALUES (?, ?, ?)').run(user.id, user.username, user.password)
    return user
  }
  user(username: string): User | undefined {
    const row = this.db.prepare('SELECT id, username, password FROM users WHERE username=?').get(username)
    return row ? { id: String(row.id), username: String(row.username), password: String(row.password) } : undefined
  }
  createLogin(user: User) {
    const token = randomBytes(32).toString('base64url')
    const login: Login = { tokenHash: hash(token), userId: user.id, username: user.username, csrf: randomBytes(32).toString('base64url'), expiresAt: Date.now() + 12 * 3600_000 }
    this.db.prepare('DELETE FROM logins WHERE expires_at<=?').run(Date.now())
    this.db.prepare('INSERT INTO logins VALUES (?, ?, ?, ?)').run(login.tokenHash, user.id, login.csrf, login.expiresAt)
    return { token, login }
  }
  login(token: string): Login | undefined {
    const row = this.db.prepare('SELECT l.*, u.username FROM logins l JOIN users u ON u.id=l.user_id WHERE token_hash=? AND expires_at>?').get(hash(token), Date.now())
    return row ? { tokenHash: String(row.token_hash), userId: String(row.user_id), username: String(row.username), csrf: String(row.csrf), expiresAt: Number(row.expires_at) } : undefined
  }
  revokeLogin(tokenHash: string) { this.db.prepare('DELETE FROM logins WHERE token_hash=?').run(tokenHash) }
  skills(userId: string): SkillChoices {
    const row = this.db.prepare('SELECT data FROM settings WHERE user_id=?').get(userId)
    return row ? JSON.parse(String(row.data)) as SkillChoices : { ...defaultSkills }
  }
  setSkills(userId: string, choices: SkillChoices) {
    this.db.prepare('INSERT INTO settings VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET data=excluded.data').run(userId, JSON.stringify(choices))
  }
  createConversation(userId: string, title: string): Conversation {
    const id = randomUUID()
    const conversation: Conversation = { id, userId, state: { resource: `ahp-chat:/${id}`, title, status: SessionStatus.Idle, modifiedAt: new Date().toISOString(), turns: [] } }
    this.db.prepare('INSERT INTO conversations VALUES (?, ?, ?)').run(id, userId, JSON.stringify(conversation))
    return conversation
  }
  conversation(userId: string, id: string): Conversation {
    const row = this.db.prepare('SELECT data FROM conversations WHERE id=? AND user_id=?').get(id, userId)
    if (!row) throw new AppError(404, '会话不存在')
    return JSON.parse(String(row.data)) as Conversation
  }
  conversations(userId: string): Conversation[] {
    return this.db.prepare('SELECT data FROM conversations WHERE user_id=? ORDER BY json_extract(data, \'$.state.modifiedAt\') DESC').all(userId).map(row => JSON.parse(String(row.data)) as Conversation)
  }
  summary(conversation: Conversation): ConversationSummary {
    return { id: conversation.id, title: conversation.state.title, session: `ahp-session:/${conversation.id}`, chat: conversation.state.resource, updatedAt: conversation.state.modifiedAt }
  }
  sessionSummary(conversation: Conversation): SessionSummary {
    return { resource: `ahp-session:/${conversation.id}`, provider: 'copilot-azure', title: conversation.state.title, status: conversation.state.status, createdAt: conversation.state.modifiedAt, modifiedAt: conversation.state.modifiedAt }
  }
  save(conversation: Conversation) {
    this.db.prepare('UPDATE conversations SET data=? WHERE id=? AND user_id=?').run(JSON.stringify(conversation), conversation.id, conversation.userId)
  }
  accepted(userId: string, clientId: string, clientSeq: number, fingerprint: string): ActionEnvelope | undefined {
    const row = this.db.prepare('SELECT input_hash, envelope FROM commands WHERE user_id=? AND client_id=? AND client_seq=?').get(userId, clientId, clientSeq)
    if (!row) return undefined
    if (row.input_hash !== fingerprint) throw new AppError(409, '客户端操作编号已被其他内容使用')
    return JSON.parse(String(row.envelope)) as ActionEnvelope
  }
  apply(userId: string, id: string, action: ChatAction, command?: { clientId: string; clientSeq: number; fingerprint: string }): ActionEnvelope {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const conversation = this.conversation(userId, id)
      const serverSeq = this.nextSequence()
      conversation.state = chatReducer(conversation.state, action)
      conversation.state.modifiedAt = new Date().toISOString()
      this.save(conversation)
      const origin: ActionOrigin | undefined = command ? { clientId: command.clientId, clientSeq: command.clientSeq } : undefined
      const envelope: ActionEnvelope = { channel: conversation.state.resource, action, serverSeq, origin }
      if (command) this.db.prepare('INSERT INTO commands VALUES (?, ?, ?, ?, ?)').run(userId, command.clientId, command.clientSeq, command.fingerprint, JSON.stringify(envelope))
      this.db.exec('COMMIT')
      return envelope
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
  sessionUpdate(userId: string, id: string): ActionEnvelope {
    const { state } = this.conversation(userId, id)
    return {
      channel: `ahp-session:/${id}`, serverSeq: this.nextSequence(), origin: undefined,
      action: { type: ActionType.SessionChatUpdated, chat: state.resource, changes: {
        title: state.title, status: state.status, modifiedAt: state.modifiedAt, activity: state.activity,
      } },
    }
  }
  snapshot(userId: string, channel: string): Snapshot {
    if (channel === 'ahp-root://') return { resource: channel, fromSeq: this.sequence, state: {
      agents: [{ provider: 'copilot-azure', displayName: 'Copilot · Azure', description: 'Mobile creation assistant', models: [] }],
      activeSessions: this.conversations(userId).length,
    } }
    const match = /^ahp-(session|chat):\/([0-9a-f-]{36})$/.exec(channel)
    if (!match) throw new AppError(404, '通道不存在')
    const conversation = this.conversation(userId, match[2])
    const { state } = conversation
    if (match[1] === 'chat') return { resource: channel, fromSeq: this.sequence, state }
    return { resource: channel, fromSeq: this.sequence, state: {
      lifecycle: SessionLifecycle.Ready, provider: 'copilot-azure', title: state.title, status: state.status,
      activeClients: [], chats: [{ resource: state.resource, title: state.title, status: state.status, modifiedAt: state.modifiedAt }],
      defaultChat: state.resource,
    } }
  }
  interruptActiveTurns() {
    const rows = this.db.prepare('SELECT data FROM conversations').all()
    for (const row of rows) {
      const conversation = JSON.parse(String(row.data)) as Conversation
      if (!conversation.state.activeTurn) continue
      this.apply(conversation.userId, conversation.id, {
        type: ActionType.ChatError, turnId: conversation.state.activeTurn.id, duration: 0,
        part: { kind: ResponsePartKind.Error, error: { errorType: 'interrupted', message: '服务重启，对话已中断；外部任务可能已计费，未自动重试。' } },
      })
    }
  }
}
