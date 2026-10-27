import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { backupCleanupScript, checkConfiguration, checkDatabase, runRelease } from './release-webapp.mjs'

function fixture() {
  const configuration = { state: 'Running', image: 'DOCKER|registry/previous', settings: { secret: 'not-for-evidence' }, auth: { enabled: true }, identity: { principal: 'existing' }, network: 'private' }
  const database = { integrity: 'ok', activeTasks: 0, counts: Object.fromEntries(['projects', 'project_owners', 'messages', 'assets', 'jobs', 'agent_runs', 'avatar_jobs', 'message_resends', 'user_settings'].map(table => [table, 2])) }
  const events = []
  const records = {}
  const adapter = {
    configuration: async () => structuredClone(configuration),
    currentHashes: async () => ({ '/index.html': 'old-hash' }),
    database: async backup => ({ ...structuredClone(database), ...(backup ? { backup: '/backup.sqlite', bytes: 4096, sha256: 'a'.repeat(64) } : {}) }),
    stop: async () => { events.push('stop'); configuration.state = 'Stopped' },
    start: async () => { events.push('start'); configuration.state = 'Running' },
    setImage: async image => { events.push(image); configuration.image = image },
    verifyHttp: async old => { events.push(old ? 'verify-old' : 'verify-new') },
    pruneBackups: async backup => { events.push('prune'); return { state: 'completed', kept: backup.backup, removed: ['/older/studio.sqlite'] } },
    record: (name, value) => { records[name] = value },
  }
  return { adapter, configuration, database, events, records }
}

test('release preserves configuration, verifies stopped backup and new image, and records no secrets', async () => {
  const { adapter, events, records } = fixture()
  await runRelease(adapter, 'DOCKER|registry/new')
  assert.deepEqual(events, ['stop', 'DOCKER|registry/new', 'start', 'verify-new', 'prune'])
  assert.equal(records.result.state, 'verified')
  assert.equal(records.retention.kept, records.backup.backup)
  assert.equal(JSON.stringify(records).includes('not-for-evidence'), false)
})

test('active tasks and invalid database counts prevent stopping production', async () => {
  const { adapter, database, events } = fixture()
  database.activeTasks = 1
  await assert.rejects(runRelease(adapter, 'DOCKER|registry/new'), /tasks/)
  assert.deepEqual(events, [])
  database.activeTasks = 0
  delete database.counts.assets
  assert.throws(() => checkDatabase(database), /assets/)
})

test('security patch releases a stopped site without requesting the old homepage or pruning backups', async () => {
  const { adapter, configuration, events, records } = fixture()
  configuration.state = 'Stopped'
  adapter.currentHashes = async () => { throw new Error('Old image must not be started') }
  await runRelease(adapter, 'DOCKER|registry/patched', { securityPatch: true })
  assert.deepEqual(events, ['stop', 'DOCKER|registry/patched', 'start', 'verify-new'])
  assert.equal(records.result.state, 'verified')
  assert.equal(records.retention.state, 'preserved-for-security')
})

test('security patch failure stops the site and never restores the vulnerable image', async () => {
  for (const stage of ['backup', 'verification']) {
    const { adapter, configuration, events, records } = fixture()
    configuration.state = 'Stopped'
    const database = adapter.database
    adapter.database = async backup => {
      if (backup && stage === 'backup') throw new Error('Patch backup failed')
      return database(backup)
    }
    adapter.verifyHttp = async () => { throw new Error('Patch verification failed') }
    await assert.rejects(runRelease(adapter, 'DOCKER|registry/patched', { securityPatch: true }), /Patch/)
    assert.equal(configuration.state, 'Stopped')
    assert.equal(events.includes('DOCKER|registry/previous'), false)
    assert.equal(records.rollback.oldImageRestarted, false)
    assert.equal(events.at(-1), 'stop')
  }
})

test('ordinary releases still reject a stopped site before any mutation', async () => {
  const { adapter, configuration, events } = fixture()
  configuration.state = 'Stopped'
  await assert.rejects(runRelease(adapter, 'DOCKER|registry/patched'), /eligible site/)
  assert.deepEqual(events, [])
})

test('configuration drift before the switch prevents stopping', async () => {
  const { adapter, events } = fixture()
  const original = adapter.configuration
  let calls = 0
  adapter.configuration = async () => ({ ...await original(), network: ++calls === 1 ? 'old' : 'changed' })
  await assert.rejects(runRelease(adapter, 'DOCKER|registry/new'), /baseline changed/)
  assert.deepEqual(events, [])
})

test('failed verification stops new container before rollback and verifies old image', async () => {
  const { adapter, events, records } = fixture()
  adapter.verifyHttp = async old => {
    events.push(old ? 'verify-old' : 'verify-new')
    if (!old) throw new Error('New image failed')
  }
  await assert.rejects(runRelease(adapter, 'DOCKER|registry/new'), /New image failed/)
  assert.deepEqual(events, ['stop', 'DOCKER|registry/new', 'start', 'verify-new', 'stop', 'DOCKER|registry/previous', 'start', 'verify-old'])
  assert.equal(records.rollback.state, 'verified')
})

test('newly active tasks prevent an unsafe rollback stop', async () => {
  const { adapter, database, events, records } = fixture()
  adapter.verifyHttp = async () => { database.activeTasks = 1; throw new Error('Verification failed') }
  await assert.rejects(runRelease(adapter, 'DOCKER|registry/new'), /operator attention/)
  assert.equal(events.filter(event => event === 'stop').length, 1)
  assert.equal(records.rollback.state, 'requires-attention')
})

test('a failed backup cannot switch to the new image', async () => {
  const { adapter, events } = fixture()
  const original = adapter.database
  adapter.database = async backup => {
    if (backup) throw new Error('Backup failed')
    return original(false)
  }
  await assert.rejects(runRelease(adapter, 'DOCKER|registry/new'), /Backup failed/)
  assert.equal(events.includes('DOCKER|registry/new'), false)
  assert.equal(events.at(-1), 'verify-old')
})

test('configuration comparison ignores JSON key order but protects identity and settings', () => {
  const { configuration } = fixture()
  checkConfiguration(configuration, { ...configuration, settings: { ...configuration.settings } }, configuration.image)
  assert.throws(() => checkConfiguration(configuration, { ...configuration, identity: {} }, configuration.image), /identity/)
  assert.throws(() => checkConfiguration(configuration, { ...configuration, settings: {} }, configuration.image), /settings/)
})

test('cleanup runs only after data verification and never rolls back a verified release on failure', async () => {
  const { adapter, records, events } = fixture()
  adapter.pruneBackups = async () => {
    assert.equal(records.result.state, 'verified')
    throw new Error('Cleanup unavailable')
  }
  await assert.rejects(runRelease(adapter, 'DOCKER|registry/new'), /new image remains running/)
  assert.equal(records.retention.state, 'failed')
  assert.equal(records.rollback, undefined)
  assert.deepEqual(events, ['stop', 'DOCKER|registry/new', 'start', 'verify-new'])
  const changed = fixture()
  changed.adapter.verifyHttp = async () => { changed.database.counts.assets++ }
  await assert.rejects(runRelease(changed.adapter, 'DOCKER|registry/new'), /counts changed/)
  assert.equal(changed.events.includes('prune'), false)
})

function python(script, args = []) {
  const result = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-c', script, ...args], { encoding: 'utf8' })
  if (result.error) throw result.error
  return result
}

function snapshots(context) {
  const root = mkdtempSync(join(tmpdir(), 'studio-retention-'))
  context.after(() => rmSync(root, { recursive: true, force: true }))
  const create = (name, seconds) => {
    const path = join(root, name, 'studio.sqlite')
    mkdirSync(join(root, name))
    const result = python('import sqlite3, sys; database = sqlite3.connect(sys.argv[1]); database.execute("CREATE TABLE snapshot (id INTEGER)"); database.close()', [path])
    assert.equal(result.status, 0, result.stderr)
    utimesSync(path, seconds, seconds)
    const bytes = readFileSync(path)
    return { backup: path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
  }
  return { root, create }
}

test('retention script validates the kept SQLite snapshot, previews deletions and removes only older snapshots', context => {
  const { root, create } = snapshots(context)
  const old = create('old', 100)
  const kept = create('kept', 200)
  const newer = create('newer', 300)
  const unrelated = create('unrelated', 100)
  writeFileSync(join(root, 'unrelated', 'notes.txt'), 'preserve')
  const flat = join(root, 'old-flat.sqlite')
  const legacy = join(root, 'old', 'studio-stopped.sqlite')
  for (const path of [flat, legacy]) {
    writeFileSync(path, readFileSync(old.backup))
    utimesSync(path, 100, 100)
  }
  const notDatabase = join(root, 'not-a-database.sqlite')
  writeFileSync(notDatabase, 'preserve')
  utimesSync(notDatabase, 100, 100)
  const expected = new Set([old.backup, unrelated.backup, flat, legacy])
  const preview = python(backupCleanupScript(kept, { root, dryRun: true }))
  assert.equal(preview.status, 0, preview.stderr)
  assert.deepEqual(new Set(JSON.parse(preview.stdout).candidates), expected)
  assert.equal(existsSync(old.backup), true)
  const result = python(backupCleanupScript(kept, { root }))
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(new Set(JSON.parse(result.stdout).removed), expected)
  assert.equal(existsSync(join(root, 'old')), false)
  for (const asset of [kept, newer]) assert.equal(existsSync(asset.backup), true)
  assert.equal(existsSync(unrelated.backup), false)
  assert.equal(existsSync(join(root, 'unrelated', 'notes.txt')), true)
  assert.equal(existsSync(notDatabase), true)
  assert.equal(createHash('sha256').update(readFileSync(kept.backup)).digest('hex'), kept.sha256)
  const repeated = python(backupCleanupScript(kept, { root }))
  assert.equal(repeated.status, 0, repeated.stderr)
  assert.deepEqual(JSON.parse(repeated.stdout).removed, [])
})

test('missing, corrupt, mismatched or out-of-scope retained backups prevent any deletion', context => {
  const { root, create } = snapshots(context)
  const old = create('old', 100)
  const kept = create('kept', 200)
  for (const invalid of [
    { ...kept, sha256: '0'.repeat(64) },
    { ...kept, bytes: kept.bytes + 1 },
    { ...kept, backup: join(root, 'missing', 'studio.sqlite') },
    { ...kept, backup: join(root, '..', 'outside', 'studio.sqlite') },
  ]) {
    assert.notEqual(python(backupCleanupScript(invalid, { root })).status, 0)
    assert.equal(existsSync(old.backup), true)
  }
  const corrupt = Buffer.from('not a sqlite database')
  writeFileSync(kept.backup, corrupt)
  assert.notEqual(python(backupCleanupScript({ ...kept, bytes: corrupt.length, sha256: createHash('sha256').update(corrupt).digest('hex') }, { root })).status, 0)
  assert.equal(existsSync(old.backup), true)
})

test('retention refuses symlinked retained snapshots and skips symlinked older snapshots', { skip: process.platform === 'win32' }, context => {
  const { root, create } = snapshots(context)
  const old = create('old', 100)
  const kept = create('kept', 200)
  mkdirSync(join(root, 'linked-file'))
  symlinkSync(old.backup, join(root, 'linked-file', 'studio.sqlite'))
  symlinkSync(join(root, 'kept'), join(root, 'linked-directory'))
  assert.notEqual(python(backupCleanupScript({ ...kept, backup: join(root, 'linked-directory', 'studio.sqlite') }, { root })).status, 0)
  assert.equal(existsSync(old.backup), true)
  const result = python(backupCleanupScript(kept, { root }))
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout).skipped, [join(root, 'linked-directory'), join(root, 'linked-file', 'studio.sqlite')])
  assert.equal(existsSync(kept.backup), true)
})