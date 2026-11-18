import { posix } from 'node:path'
import type { SessionFsProvider, SessionFsFileInfo } from '@microsoft/copilot-sdk'
import { upsert } from './database.js'
import type { Database, Queries, Row } from './database.js'

const error = (code: string) => Object.assign(new Error(`Session filesystem: ${code}`), { code })

export class SessionFiles implements SessionFsProvider {
  constructor(private database: Database, private userId: string, private sessionId: string) {}
  private path(path: string) {
    if (path.includes('\0') || path.includes('\\') || path.split('/').includes('..')) throw error('EINVAL')
    const normalized = posix.resolve('/', path)
    if (normalized.length > 400) throw error('ENAMETOOLONG')
    return normalized
  }
  private keys(path: string) { return { user_id: this.userId, session_id: this.sessionId, path } }
  private async row(db: Queries, path: string): Promise<Row | undefined> {
    if (path === '/') return { path, kind: 'directory', content: Buffer.alloc(0), mode: 0o700, created_at: 0, modified_at: 0 }
    return db.get('SELECT * FROM runtime_files WHERE user_id=? AND session_id=? AND path=?', [this.userId, this.sessionId, path])
  }
  private content(row: Row) {
    if (!(row.content instanceof Uint8Array)) throw new Error('Invalid persisted session file content')
    return Buffer.from(row.content)
  }
  private async required(db: Queries, path: string) {
    const row = await this.row(db, path)
    if (!row) throw error('ENOENT')
    return row
  }
  private async entries(db: Queries) {
    return db.all('SELECT * FROM runtime_files WHERE user_id=? AND session_id=?', [this.userId, this.sessionId])
  }
  private async parents(db: Queries, path: string) {
    const parent = posix.dirname(path)
    const existing = await this.row(db, parent)
    if (existing) { if (existing.kind !== 'directory') throw error('ENOTDIR'); return }
    await this.parents(db, parent)
    await this.put(db, parent, Buffer.alloc(0), 'directory', 0o700)
  }
  private async put(db: Queries, path: string, content: Buffer, kind: string, mode: number) {
    const previous = await this.row(db, path)
    if (previous && previous.kind !== kind) throw error(kind === 'file' ? 'EISDIR' : 'ENOTDIR')
    const now = Date.now()
    await upsert(db, 'runtime_files', this.keys(path), {
      kind, content, mode, created_at: previous ? Number(previous.created_at) : now, modified_at: now,
    })
  }
  async readFileBytes(path: string) {
    const row = await this.required(this.database, this.path(path))
    if (row.kind !== 'file') throw error('EISDIR')
    return this.content(row)
  }
  async readFile(path: string) { return (await this.readFileBytes(path)).toString('utf8') }
  async writeFileBytes(path: string, content: Uint8Array, mode = 0o600) {
    const target = this.path(path)
    await this.database.transaction(async db => {
      await this.parents(db, target)
      await this.put(db, target, Buffer.from(content), 'file', mode)
    })
  }
  writeFile(path: string, content: string, mode?: number) { return this.writeFileBytes(path, Buffer.from(content), mode) }
  async appendFile(path: string, content: string, mode = 0o600) {
    const target = this.path(path)
    await this.database.transaction(async db => {
      await this.parents(db, target)
      const previous = await this.row(db, target)
      if (previous && previous.kind !== 'file') throw error('EISDIR')
      await this.put(db, target, Buffer.concat([previous ? this.content(previous) : Buffer.alloc(0), Buffer.from(content)]), 'file', previous ? Number(previous.mode) : mode)
    })
  }
  async exists(path: string) { return Boolean(await this.row(this.database, this.path(path))) }
  async stat(path: string): Promise<SessionFsFileInfo> {
    const row = await this.required(this.database, this.path(path))
    return {
      isFile: row.kind === 'file', isDirectory: row.kind === 'directory', size: this.content(row).length,
      mtime: new Date(Number(row.modified_at)).toISOString(), birthtime: new Date(Number(row.created_at)).toISOString(),
    }
  }
  async mkdir(path: string, recursive: boolean, mode = 0o700) {
    const target = this.path(path)
    if (target === '/') return
    await this.database.transaction(async db => {
      const existing = await this.row(db, target)
      if (existing) {
        if (existing.kind !== 'directory') throw error('ENOTDIR')
        if (!recursive) throw error('EEXIST')
        return
      }
      if (recursive) await this.parents(db, target)
      else if ((await this.required(db, posix.dirname(target))).kind !== 'directory') throw error('ENOTDIR')
      await this.put(db, target, Buffer.alloc(0), 'directory', mode)
    })
  }
  async readdirWithTypes(path: string) {
    const target = this.path(path)
    if ((await this.required(this.database, target)).kind !== 'directory') throw error('ENOTDIR')
    return (await this.entries(this.database)).filter(row => posix.dirname(String(row.path)) === target)
      .map(row => ({ name: posix.basename(String(row.path)), type: row.kind === 'directory' ? 'directory' as const : 'file' as const }))
  }
  async readdir(path: string) { return (await this.readdirWithTypes(path)).map(entry => entry.name) }
  async rm(path: string, recursive: boolean, force: boolean) {
    const target = this.path(path)
    if (target === '/') throw error('EPERM')
    await this.database.transaction(async db => {
      const existing = await this.row(db, target)
      if (!existing) { if (force) return; throw error('ENOENT') }
      const descendants = (await this.entries(db)).filter(row => String(row.path).startsWith(`${target}/`))
      if (descendants.length && !recursive) throw error('ENOTEMPTY')
      for (const row of [...descendants, existing]) {
        await db.run('DELETE FROM runtime_files WHERE user_id=? AND session_id=? AND path=?', [this.userId, this.sessionId, String(row.path)])
      }
    })
  }
  async rename(src: string, dest: string) {
    const source = this.path(src), target = this.path(dest)
    if (source === target) return
    if (source === '/' || target === '/' || target.startsWith(`${source}/`)) throw error('EINVAL')
    await this.database.transaction(async db => {
      const existing = await this.required(db, source)
      const parent = await this.required(db, posix.dirname(target))
      if (parent.kind !== 'directory') throw error('ENOTDIR')
      const destination = await this.row(db, target)
      const entries = await this.entries(db)
      if (destination) {
        if (destination.kind !== existing.kind) throw error('EINVAL')
        if (entries.some(row => String(row.path).startsWith(`${target}/`))) throw error('ENOTEMPTY')
        await db.run('DELETE FROM runtime_files WHERE user_id=? AND session_id=? AND path=?', [this.userId, this.sessionId, target])
      }
      const moved = entries.filter(row => row.path === source || String(row.path).startsWith(`${source}/`))
      for (const row of moved) {
        const path = `${target}${String(row.path).slice(source.length)}`
        this.path(path)
        await db.run('UPDATE runtime_files SET path=? WHERE user_id=? AND session_id=? AND path=?', [path, this.userId, this.sessionId, String(row.path)])
      }
    })
  }
}
