import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import sql from 'mssql'
import type { Config } from './config.js'
import { AppError } from './errors.js'

export type Parameter = string | number | null | Buffer
export type Row = Record<string, unknown>
export interface Queries {
  all(query: string, parameters?: Parameter[]): Promise<Row[]>
  get(query: string, parameters?: Parameter[]): Promise<Row | undefined>
  run(query: string, parameters?: Parameter[]): Promise<number>
}
export interface Database extends Queries {
  kind: 'sqlite' | 'sqlserver'
  transaction<T>(work: (queries: Queries) => Promise<T>): Promise<T>
  check(): Promise<void>
  close(): Promise<void>
}

export async function upsert(db: Queries, table: string, keys: Record<string, Parameter>, values: Record<string, Parameter>) {
  const where = Object.keys(keys).map(key => `[${key}]=?`).join(' AND ')
  const changed = await db.run(`UPDATE [${table}] SET ${Object.keys(values).map(key => `[${key}]=?`).join(', ')} WHERE ${where}`, [...Object.values(values), ...Object.values(keys)])
  if (!changed) {
    const record = { ...keys, ...values }
    await db.run(`INSERT INTO [${table}] (${Object.keys(record).map(key => `[${key}]`).join(', ')}) VALUES (${Object.keys(record).map(() => '?').join(', ')})`, Object.values(record))
  }
}

export class SqliteDatabase implements Database {
  readonly kind = 'sqlite'
  private db: DatabaseSync
  private queue: Promise<unknown> = Promise.resolve()
  private queries: Queries
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
      CREATE TABLE IF NOT EXISTS attachments (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS attachments_owner ON attachments(user_id);
      CREATE TABLE IF NOT EXISTS image_jobs (user_id TEXT NOT NULL REFERENCES users(id), call_id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(user_id, call_id));
      CREATE TABLE IF NOT EXISTS image_preferences (user_id TEXT PRIMARY KEY REFERENCES users(id), model TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runtime_files (user_id TEXT NOT NULL REFERENCES users(id), session_id TEXT NOT NULL, path TEXT NOT NULL, kind TEXT NOT NULL, content BLOB NOT NULL, mode INTEGER NOT NULL, created_at INTEGER NOT NULL, modified_at INTEGER NOT NULL, PRIMARY KEY(user_id, session_id, path));
    `)
    this.queries = {
      all: async (query, parameters = []) => this.db.prepare(query).all(...parameters),
      get: async (query, parameters = []) => this.db.prepare(query).get(...parameters),
      run: async (query, parameters = []) => Number(this.db.prepare(query).run(...parameters).changes),
    }
  }
  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work, work)
    this.queue = result
    return result
  }
  all(query: string, parameters?: Parameter[]) { return this.exclusive(() => this.queries.all(query, parameters)) }
  get(query: string, parameters?: Parameter[]) { return this.exclusive(() => this.queries.get(query, parameters)) }
  run(query: string, parameters?: Parameter[]) { return this.exclusive(() => this.queries.run(query, parameters)) }
  transaction<T>(work: (queries: Queries) => Promise<T>) {
    return this.exclusive(async () => {
      this.db.exec('BEGIN IMMEDIATE')
      try {
        const result = await work(this.queries)
        this.db.exec('COMMIT')
        return result
      } catch (error) {
        this.db.exec('ROLLBACK')
        throw error
      }
    })
  }
  async check() { await this.get('SELECT 1 AS ready') }
  async close() { await this.exclusive(async () => { this.db.close() }) }
}

const serverTime = "DATEDIFF_BIG(MILLISECOND, '19700101', SYSUTCDATETIME())"

export async function connectSqlPool(config: Config) {
  if (config.authMode !== 'managed-identity') throw new Error('Production SQL storage requires managed identity')
  return new sql.ConnectionPool({
    server: config.sqlServer, database: config.sqlDatabase,
    authentication: { type: 'azure-active-directory-msi-app-service', options: { clientId: config.clientId } },
    connectionTimeout: 30_000, requestTimeout: 15_000,
    options: { encrypt: true, trustServerCertificate: false, maxRetriesOnTransientErrors: 0 },
    pool: { min: 0, max: 8, idleTimeoutMillis: 30_000 },
  }).connect()
}

export class SqlServerDatabase implements Database {
  readonly kind = 'sqlserver'
  private holder = randomUUID()
  private timer?: ReturnType<typeof setInterval>
  private failure?: Error
  private renewing = false
  constructor(private pool: sql.ConnectionPool, private report: (message: string) => void = console.error) {}
  static async connect(config: Config) {
    const pool = await connectSqlPool(config)
    const database = new SqlServerDatabase(pool)
    try { await database.acquire(); return database }
    catch (error) { await pool.close(); throw error }
  }
  private queries(source: sql.ConnectionPool | sql.Transaction): Queries {
    const request = (query: string, parameters: Parameter[] = []) => {
      const request = source.request()
      parameters.forEach((value, i) => {
        if (Buffer.isBuffer(value)) request.input(`p${i}`, sql.VarBinary(sql.MAX), value)
        else request.input(`p${i}`, value)
      })
      let index = 0
      return request.query<Row>(query.replace(/\?/g, () => `@p${index++}`))
    }
    return {
      all: async (query, parameters) => (await request(query, parameters)).recordset,
      get: async (query, parameters) => (await request(query, parameters)).recordset[0],
      run: async (query, parameters) => (await request(query, parameters)).rowsAffected.reduce((sum, count) => sum + count, 0),
    }
  }
  async acquire() {
    const changed = await this.queries(this.pool).run(`UPDATE instance_lease SET holder=?, expires_at=${serverTime}+60000 WHERE id=1 AND (expires_at<=${serverTime} OR holder=?)`, [this.holder, this.holder])
    if (changed !== 1) throw new Error('Another application instance holds the production storage lease')
    this.pool.on('error', () => this.fail())
    this.timer = setInterval(() => {
      if (this.renewing || this.failure) return
      this.renewing = true
      void this.queries(this.pool).run(`UPDATE instance_lease SET expires_at=${serverTime}+60000 WHERE id=1 AND holder=? AND expires_at>${serverTime}`, [this.holder])
        .then(changed => { if (changed !== 1) this.fail() }, () => this.fail())
        .finally(() => { this.renewing = false })
    }, 15_000)
    this.timer.unref()
  }
  private fail() {
    if (this.failure) return
    this.failure = new AppError(503, '生产存储连接或实例租约已失效，请等待服务恢复；未自动重试。')
    this.report('Production database lease lost; writes and new external submissions are blocked')
  }
  private available() { if (this.failure) throw this.failure }
  async check() {
    this.available()
    const lease = await this.queries(this.pool).get(`SELECT id FROM instance_lease WHERE id=1 AND holder=? AND expires_at>${serverTime}`, [this.holder])
    if (!lease) { this.fail(); this.available() }
  }
  async all(query: string, parameters?: Parameter[]) { this.available(); return this.queries(this.pool).all(query, parameters) }
  async get(query: string, parameters?: Parameter[]) { this.available(); return this.queries(this.pool).get(query, parameters) }
  run(query: string, parameters?: Parameter[]) { return this.transaction(db => db.run(query, parameters)) }
  async transaction<T>(work: (queries: Queries) => Promise<T>) {
    this.available()
    const transaction = new sql.Transaction(this.pool)
    await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE)
    try {
      const queries = this.queries(transaction)
      const lease = await queries.get(`SELECT id FROM instance_lease WITH (UPDLOCK, HOLDLOCK) WHERE id=1 AND holder=? AND expires_at>${serverTime}`, [this.holder])
      if (!lease) { this.fail(); this.available() }
      const result = await work(queries)
      await transaction.commit()
      return result
    } catch (error) {
      await transaction.rollback()
      throw error
    }
  }
  async close() {
    if (this.timer) clearInterval(this.timer)
    try { await this.queries(this.pool).run('UPDATE instance_lease SET expires_at=0 WHERE id=1 AND holder=?', [this.holder]) }
    finally { await this.pool.close() }
  }
}
