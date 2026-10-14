import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'

const protectedKeys = ['settings', 'auth', 'identity', 'network', 'vnetRouteAllEnabled', 'acrUseManagedIdentityCreds', 'acrUserManagedIdentityID']
const preservedTables = ['projects', 'project_owners', 'messages', 'assets', 'jobs', 'agent_runs', 'avatar_jobs', 'message_resends', 'user_settings']
const hash = value => createHash('sha256').update(value).digest('hex')

export function checkDatabase(database) {
  if (database.integrity !== 'ok' || database.activeTasks !== 0) throw new Error('Database is unhealthy or has active/uncertain tasks; deployment blocked')
  for (const table of preservedTables) {
    if (!Number.isSafeInteger(database.counts?.[table]) || database.counts[table] < 0) throw new Error(`Missing database count: ${table}`)
  }
}

export function checkConfiguration(before, after, image) {
  if (after.state !== 'Running' || after.image !== image) throw new Error('Expected image is not running')
  for (const key of protectedKeys) {
    if (!isDeepStrictEqual(before[key], after[key])) throw new Error(`Production configuration changed: ${key}`)
  }
}

export async function runRelease(adapter, image) {
  const before = await adapter.configuration()
  if (before.state !== 'Running' || !before.image?.startsWith('DOCKER|') || before.image === image) throw new Error('Expected a running site on the previous Docker image')
  const oldHashes = await adapter.currentHashes()
  const initial = await adapter.database()
  checkDatabase(initial)
  adapter.record('before', { image: before.image, database: initial, oldHashes })
  const current = await adapter.configuration()
  if (!isDeepStrictEqual(before, current)) throw new Error('Production baseline changed before stopping')
  checkDatabase(await adapter.database())
  let stopAttempted = false
  try {
    stopAttempted = true
    await adapter.stop()
    const backup = await adapter.database(true)
    checkDatabase(backup)
    if (!backup.backup || backup.bytes <= 0 || !/^[a-f0-9]{64}$/.test(backup.sha256)) throw new Error('Stopped database backup evidence is missing')
    adapter.record('backup', backup)
    await adapter.setImage(image)
    await adapter.start()
    await adapter.verifyHttp()
    const after = await adapter.configuration()
    checkConfiguration(before, after, image)
    const database = await adapter.database()
    checkDatabase(database)
    for (const table of preservedTables) {
      if (backup.counts[table] !== database.counts[table]) throw new Error(`Database counts changed: ${table}; reconcile before accepting release`)
    }
    adapter.record('result', { state: 'verified', image, previousImage: before.image, configurationUnchanged: true, database })
  } catch (error) {
    adapter.record('failure', { message: error.message })
    if (stopAttempted) {
      try {
        checkDatabase(await adapter.database())
        await adapter.stop()
        try { await adapter.setImage(before.image) }
        finally { await adapter.start() }
        await adapter.verifyHttp(oldHashes)
        checkConfiguration(before, await adapter.configuration(), before.image)
        adapter.record('rollback', { state: 'verified', image: before.image })
      } catch (rollbackError) {
        adapter.record('rollback', { state: 'requires-attention', message: rollbackError.message, previousImage: before.image })
        throw new AggregateError([error, rollbackError], 'Release failed; rollback needs operator attention')
      }
    }
    throw error
  }
}

function createAdapter(environment) {
  for (const key of ['AZURE_SUBSCRIPTION_ID', 'AZURE_RESOURCE_GROUP', 'AZURE_WEBAPP_NAME', 'RELEASE_IMAGE', 'RELEASE_DIGEST', 'RELEASE_EVIDENCE']) {
    if (!environment[key]) throw new Error(`Missing ${key}`)
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(environment.RELEASE_DIGEST)) throw new Error('Invalid production image digest')
  const directory = resolve(environment.RELEASE_EVIDENCE)
  const expected = JSON.parse(readFileSync(resolve(directory, 'frontend-hashes.json'), 'utf8'))
  if (!expected['/index.html'] || Object.keys(expected).length < 3) throw new Error('Missing production frontend hashes')
  for (const [path, digest] of Object.entries(expected)) {
    if (!/^\/[a-zA-Z0-9/_.-]+$/.test(path) || path.includes('..') || !/^[a-f0-9]{64}$/.test(digest)) throw new Error('Invalid frontend manifest')
  }
  const site = environment.AZURE_WEBAPP_NAME
  const subscription = environment.AZURE_SUBSCRIPTION_ID
  const group = environment.AZURE_RESOURCE_GROUP
  const siteId = `/subscriptions/${subscription}/resourceGroups/${group}/providers/Microsoft.Web/sites/${site}`
  const baseUrl = `https://${site}.azurewebsites.net`
  const releaseId = environment.RELEASE_IMAGE.split(':').at(-1)
  if (!/^[a-zA-Z0-9._-]+$/.test(releaseId)) throw new Error('Invalid unique release tag')
  const image = `DOCKER|${environment.RELEASE_IMAGE.slice(0, environment.RELEASE_IMAGE.lastIndexOf(':'))}@${environment.RELEASE_DIGEST}`
  const siteArguments = ['--subscription', subscription, '--resource-group', group, '--name', site]
  const az = args => {
    const result = spawnSync('az', [...args, '--output', 'json', '--only-show-errors'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 180_000 })
    if (result.status !== 0) throw new Error(`Azure command failed: ${args[0]} ${args[1]} (exit ${result.status})`)
    return result.stdout.trim() ? JSON.parse(result.stdout) : null
  }
  const token = () => az(['account', 'get-access-token', '--subscription', subscription, '--resource', 'https://management.azure.com/']).accessToken
  const request = async (url, options = {}) => {
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(120_000), ...options })
    if (!response.ok) throw new Error(`Azure HTTP request failed (${response.status})`)
    return response.json()
  }
  const configuration = async () => {
    const resource = az(['webapp', 'show', ...siteArguments])
    const config = az(['webapp', 'config', 'show', ...siteArguments])
    const settings = Object.fromEntries(az(['webapp', 'config', 'appsettings', 'list', ...siteArguments]).map(setting => [setting.name, { value: setting.value, slotSetting: setting.slotSetting }]))
    const auth = az(['rest', '--method', 'get', '--url', `https://management.azure.com${siteId}/config/authsettingsV2?api-version=2023-12-01`])
    return {
      state: resource.state, image: config.linuxFxVersion, settings, auth: auth.properties,
      identity: resource.identity, network: resource.virtualNetworkSubnetId,
      vnetRouteAllEnabled: config.vnetRouteAllEnabled,
      acrUseManagedIdentityCreds: config.acrUseManagedIdentityCreds,
      acrUserManagedIdentityID: config.acrUserManagedIdentityID,
    }
  }
  const database = async (backup = false) => {
    const options = Buffer.from(JSON.stringify({ backup, path: `/home/studio/backups/${releaseId}/studio.sqlite` })).toString('base64')
    const script = `import base64, hashlib, json, os, sqlite3
options = json.loads(base64.b64decode('${options}'))
database = sqlite3.connect('file:/home/studio/data/studio.sqlite?mode=ro', uri=True, timeout=30)
tables = ${JSON.stringify([...preservedTables, 'sessions'])}
result = {'integrity': database.execute('PRAGMA integrity_check').fetchone()[0], 'counts': {table: database.execute('SELECT COUNT(*) FROM ' + table).fetchone()[0] for table in tables}}
result['activeTasks'] = 0
for table, active in [('agent_runs', ['queued', 'running']), ('avatar_jobs', ['submitting', 'running', 'unknown'])]:
    statuses = dict(database.execute("SELECT json_extract(data, '$.status'), COUNT(*) FROM " + table + " GROUP BY json_extract(data, '$.status')").fetchall())
    result[table + 'Statuses'] = statuses
    result['activeTasks'] += sum(statuses.get(status, 0) for status in active)
assert result['integrity'] == 'ok', 'Database integrity failed'
assert result['activeTasks'] == 0, 'Active or uncertain tasks prevent release'
if options['backup']:
    path = options['path']
    assert not os.path.exists(path), 'Backup already exists; reconcile before retrying'
    os.makedirs(os.path.dirname(path), exist_ok=True)
    target = sqlite3.connect(path)
    database.backup(target)
    assert target.execute('PRAGMA integrity_check').fetchone()[0] == 'ok', 'Backup integrity failed'
    assert {table: target.execute('SELECT COUNT(*) FROM ' + table).fetchone()[0] for table in tables} == result['counts'], 'Backup counts differ'
    target.close()
    result.update(backup=path, bytes=os.path.getsize(path), sha256=hashlib.sha256(open(path, 'rb').read()).hexdigest())
database.close()
print(json.dumps(result))`
    const command = `python3 -c "import base64;exec(base64.b64decode('${Buffer.from(script).toString('base64')}'))"`
    const response = await request(`https://${site}.scm.azurewebsites.net/api/command`, {
      method: 'POST', headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ command, dir: '/home' }),
    })
    if (response.ExitCode !== 0) throw new Error('SCM database validation failed; no database contents logged')
    return JSON.parse(response.Output)
  }
  const get = async path => {
    const response = await fetch(`${baseUrl}${path}`, { redirect: 'manual', headers: { 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(30_000) })
    return { status: response.status, location: response.headers.get('location'), bytes: Buffer.from(await response.arrayBuffer()) }
  }
  const record = (name, value) => {
    mkdirSync(directory, { recursive: true })
    writeFileSync(resolve(directory, `${name}.json`), JSON.stringify(value, null, 2) + '\n')
    console.log(JSON.stringify({ step: name, ...value }))
  }
  return {
    image,
    configuration, database, record,
    currentHashes: async () => {
      const response = await get('/')
      if (response.status !== 200) throw new Error('Current production homepage is unavailable')
      return { '/index.html': hash(response.bytes) }
    },
    stop: async () => {
      az(['webapp', 'stop', ...siteArguments])
      if (az(['webapp', 'show', ...siteArguments]).state !== 'Stopped') throw new Error('Site has not stopped; image switch blocked')
    },
    start: async () => { az(['webapp', 'start', ...siteArguments]) },
    setImage: async version => {
      const response = await request(`https://management.azure.com${siteId}/config/web?api-version=2023-12-01`, {
        method: 'PATCH', headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ properties: { linuxFxVersion: version } }),
      })
      if (response.properties.linuxFxVersion !== version) throw new Error('ARM returned an unexpected image')
    },
    verifyHttp: async (hashes = expected) => {
      const deadline = Date.now() + 8 * 60_000
      let ready = false
      while (Date.now() < deadline) {
        try {
          const response = await get('/')
          ready = response.status === 200 && hash(response.bytes) === hashes['/index.html']
        } catch {}
        if (ready) break
        console.log('Waiting for the expected production homepage during container startup')
        await delay(10_000)
      }
      if (!ready) throw new Error('Expected production homepage did not become ready within eight minutes')
      const checks = {}
      for (const [path, expectedHash] of Object.entries(hashes)) {
        const response = await get(path)
        if (response.status !== 200 || hash(response.bytes) !== expectedHash) throw new Error(`Frontend hash mismatch: ${path}`)
        checks[path] = expectedHash
      }
      for (const path of ['/healthz', '/api/auth/session', '/api/projects', '/api/references', '/api/health', '/manifest.webmanifest', '/sw.js', '/api/auth/entra']) {
        const response = await get(path)
        const wanted = ['/api/projects', '/api/references', '/api/health'].includes(path) ? 401 : path === '/api/auth/entra' ? 302 : 200
        if (response.status !== wanted) throw new Error(`HTTP validation failed: ${path} (${response.status})`)
        if (path === '/api/auth/session') {
          const session = JSON.parse(response.bytes.toString())
          if (!session.enabled || session.user !== null) throw new Error('Anonymous session boundary failed')
        }
        if (path === '/api/auth/entra' && new URL(response.location).host !== 'login.microsoftonline.com') throw new Error('Entra redirect failed')
        checks[path] = response.status
      }
      record(hashes === expected ? 'http' : 'rollback-http', checks)
    },
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const adapter = createAdapter(process.env)
    await runRelease(adapter, adapter.image)
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}