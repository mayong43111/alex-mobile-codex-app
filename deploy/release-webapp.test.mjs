import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkConfiguration, checkDatabase, runRelease } from './release-webapp.mjs'

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
    record: (name, value) => { records[name] = value },
  }
  return { adapter, configuration, database, events, records }
}

test('release preserves configuration, verifies stopped backup and new image, and records no secrets', async () => {
  const { adapter, events, records } = fixture()
  await runRelease(adapter, 'DOCKER|registry/new')
  assert.deepEqual(events, ['stop', 'DOCKER|registry/new', 'start', 'verify-new'])
  assert.equal(records.result.state, 'verified')
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