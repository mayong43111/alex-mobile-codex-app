import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const required = ['AZURE_SUBSCRIPTION_ID', 'AZURE_RESOURCE_GROUP', 'AZURE_WEBAPP_NAME', 'RELEASE_IMAGE', 'GITHUB_SHA', 'RELEASE_RECORD_DIR', 'SQL_SERVER', 'SQL_DATABASE', 'AZURE_BLOB_CONTAINER_URL', 'AZURE_MODEL_ENDPOINT', 'AZURE_MODEL_DEPLOYMENT', 'AZURE_FOUNDRY_RESOURCE_ID', 'AZURE_IMAGE_ENDPOINT', 'AZURE_IMAGE_DEPLOYMENT', 'AZURE_IMAGE_FOUNDRY_RESOURCE_ID']
for (const name of required) if (!process.env[name]) throw new Error(`Missing release configuration: ${name}`)
const env = process.env
if (!/^[a-z0-9]+\.azurecr\.io\/copilot-mobile@sha256:[a-f0-9]{64}$/.test(env.RELEASE_IMAGE)) throw new Error('Release requires an immutable Copilot container digest')
if (!/^[a-f0-9]{40}$/.test(env.GITHUB_SHA)) throw new Error('Invalid release revision')
const siteArgs = ['--subscription', env.AZURE_SUBSCRIPTION_ID, '--resource-group', env.AZURE_RESOURCE_GROUP, '--name', env.AZURE_WEBAPP_NAME]
const siteId = `/subscriptions/${env.AZURE_SUBSCRIPTION_ID}/resourceGroups/${env.AZURE_RESOURCE_GROUP}/providers/Microsoft.Web/sites/${env.AZURE_WEBAPP_NAME}`
const siteUrl = `https://${env.AZURE_WEBAPP_NAME}.azurewebsites.net`
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const az = args => {
  const result = spawnSync('az', [...args, '--output', 'json', '--only-show-errors'], { encoding: 'utf8', timeout: 180_000, maxBuffer: 8 * 1024 * 1024 })
  if (result.status !== 0) throw new Error(`Azure operation failed: ${args.slice(0, 3).join(' ')}`)
  return result.stdout.trim() ? JSON.parse(result.stdout) : undefined
}
const token = () => az(['account', 'get-access-token', '--subscription', env.AZURE_SUBSCRIPTION_ID, '--resource', 'https://management.azure.com/']).accessToken
const azure = async (path, method, properties) => {
  const response = await fetch(`https://management.azure.com${siteId}/${path}?api-version=2023-12-01`, {
    method, headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
    ...(properties ? { body: JSON.stringify({ properties }) } : {}), signal: AbortSignal.timeout(120_000),
  })
  if (!response.ok) throw new Error(`Azure ${path} failed (HTTP ${response.status})`)
  return response.json()
}
const record = (name, data) => {
  mkdirSync(env.RELEASE_RECORD_DIR, { recursive: true })
  writeFileSync(join(env.RELEASE_RECORD_DIR, `${name}.json`), JSON.stringify(data, null, 2))
}
const get = async path => {
  const response = await fetch(`${siteUrl}${path}`, { redirect: 'manual', headers: { 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(20_000) })
  return { status: response.status, bytes: Buffer.from(await response.arrayBuffer()) }
}
const stop = () => {
  az(['webapp', 'stop', ...siteArgs])
  if (az(['webapp', 'show', ...siteArgs]).state !== 'Stopped') throw new Error('Site did not stop; deployment blocked')
}
const start = () => az(['webapp', 'start', ...siteArgs])
const expected = spawnSync('docker', ['run', '--rm', '--entrypoint', 'node', env.RELEASE_IMAGE, '-e', "console.log(require('node:crypto').createHash('sha256').update(require('node:fs').readFileSync('/app/dist/index.html')).digest('hex'))"], { encoding: 'utf8', timeout: 30_000 })
if (expected.status !== 0 || !/^[a-f0-9]{64}$/.test(expected.stdout.trim())) throw new Error('Cannot verify built container assets')
const expectedHash = expected.stdout.trim()
const previousConfig = az(['webapp', 'config', 'show', ...siteArgs])
const previousSettings = Object.fromEntries(az(['webapp', 'config', 'appsettings', 'list', ...siteArgs]).map(item => [item.name, item.value]))
const resource = az(['webapp', 'show', ...siteArgs])
if (resource.state !== 'Running' || !resource.identity?.principalId) throw new Error('Release requires a running site with a system-assigned identity')
const oldHome = await get('/')
if (oldHome.status !== 200) throw new Error('Current production homepage is unavailable')
const oldHash = sha(oldHome.bytes)
const isRebuild = previousConfig.linuxFxVersion.includes('/copilot-mobile@sha256:')
if (isRebuild) {
  const health = await get('/api/health')
  if (health.status !== 200 || JSON.parse(health.bytes).activeTurns !== 0) throw new Error('Active turns or unhealthy storage prevent release')
}
const changedSettings = {
  NODE_ENV: 'production', HOST: '0.0.0.0', PORT: '8080', DATA_DIR: '/tmp/copilot-mobile',
  APP_ORIGIN: siteUrl, AZURE_AUTH_MODE: 'managed-identity',
  SQL_SERVER: env.SQL_SERVER, SQL_DATABASE: env.SQL_DATABASE, AZURE_BLOB_CONTAINER_URL: env.AZURE_BLOB_CONTAINER_URL,
  AZURE_MODEL_ENDPOINT: env.AZURE_MODEL_ENDPOINT, AZURE_MODEL_DEPLOYMENT: env.AZURE_MODEL_DEPLOYMENT,
  AZURE_FOUNDRY_RESOURCE_ID: env.AZURE_FOUNDRY_RESOURCE_ID,
  AZURE_IMAGE_ENDPOINT: env.AZURE_IMAGE_ENDPOINT, AZURE_IMAGE_DEPLOYMENT: env.AZURE_IMAGE_DEPLOYMENT,
  AZURE_IMAGE_FOUNDRY_RESOURCE_ID: env.AZURE_IMAGE_FOUNDRY_RESOURCE_ID,
  WEBSITES_PORT: '8080', WEBSITES_ENABLE_APP_SERVICE_STORAGE: 'true', WEBSITES_CONTAINER_STOP_TIME_LIMIT: '120',
}
const settings = { ...previousSettings, ...changedSettings }
delete settings.AZURE_CLIENT_ID
delete settings.STUDIO_BOOTSTRAP_USERS
delete settings.STUDIO_BOOTSTRAP_PRINCIPAL_ID
if (env.STUDIO_BOOTSTRAP_USERS) {
  settings.STUDIO_BOOTSTRAP_USERS = env.STUDIO_BOOTSTRAP_USERS
  settings.STUDIO_BOOTSTRAP_PRINCIPAL_ID = resource.identity.principalId
}
record('rollback', {
  site: env.AZURE_WEBAPP_NAME, image: previousConfig.linuxFxVersion, homepageSha256: oldHash,
  config: { alwaysOn: previousConfig.alwaysOn, webSocketsEnabled: previousConfig.webSocketsEnabled, healthCheckPath: previousConfig.healthCheckPath },
  settings: Object.fromEntries([...Object.keys(changedSettings), 'AZURE_CLIENT_ID'].map(key => [key, previousSettings[key] ?? null])),
})
const legacyBackup = async () => {
  const release = `copilot-mobile-${env.GITHUB_SHA}-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`
  if (!/^[a-z0-9-]+$/.test(release)) throw new Error('Invalid backup identifier')
  const script = `import os,json,sqlite3,hashlib
source='/home/studio/data/studio.sqlite'
target='/home/studio/backups/${release}/studio.sqlite'
assert os.path.isfile(source), 'Legacy database missing'
db=sqlite3.connect('file:'+source+'?mode=ro',uri=True,timeout=30)
assert db.execute('PRAGMA integrity_check').fetchone()[0]=='ok', 'Legacy integrity failed'
for table,active in [('agent_runs',['queued','running']),('avatar_jobs',['submitting','running','unknown'])]:
    states=dict(db.execute("SELECT json_extract(data,'$.status'),count(*) FROM "+table+" GROUP BY json_extract(data,'$.status')"))
    assert not any(states.get(state,0) for state in active), 'Active or uncertain legacy tasks prevent release'
assert not os.path.exists(target), 'Backup already exists'
os.makedirs(os.path.dirname(target),exist_ok=True)
backup=sqlite3.connect(target)
db.backup(backup)
assert backup.execute('PRAGMA integrity_check').fetchone()[0]=='ok', 'Backup integrity failed'
backup.close()
db.close()
print(json.dumps({'path':target,'bytes':os.path.getsize(target),'sha256':hashlib.sha256(open(target,'rb').read()).hexdigest()}))`
  const command = `python3 -c "import base64;exec(base64.b64decode('${Buffer.from(script).toString('base64')}'))"`
  const response = await fetch(`https://${env.AZURE_WEBAPP_NAME}.scm.azurewebsites.net/api/command`, {
    method: 'POST', headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ command, dir: '/home' }), signal: AbortSignal.timeout(120_000),
  })
  if (!response.ok) throw new Error(`Legacy backup access failed (HTTP ${response.status})`)
  const result = await response.json()
  if (result.ExitCode !== 0) throw new Error('Legacy integrity, task or backup check failed; no data logged')
  record('legacy-backup', JSON.parse(result.Output))
}
const ready = async (wantedHash, rebuilt) => {
  const deadline = Date.now() + 8 * 60_000
  while (Date.now() < deadline) {
    try {
      const home = await get('/')
      if (home.status === 200 && sha(home.bytes) === wantedHash) {
        if (!rebuilt) return
        const health = await get('/api/health')
        const data = health.status === 200 ? JSON.parse(health.bytes) : undefined
        if (data?.status === 'ok' && data.storage === 'azure-sql-blob' && data.revision === env.GITHUB_SHA) {
          if ((await get('/api/conversations')).status !== 401) throw new Error('Anonymous access boundary failed')
          return
        }
      }
    } catch (error) {
      console.log(`Readiness probe pending: ${error instanceof Error ? error.name : 'request failure'}`)
    }
    console.log('Waiting for expected container revision and database lease')
    await delay(10_000)
  }
  throw new Error('Expected application revision did not become ready')
}
let stopped = false
try {
  stop()
  stopped = true
  if (!isRebuild) await legacyBackup()
  await azure('config/appsettings', 'PUT', settings)
  await azure('config/web', 'PATCH', {
    linuxFxVersion: `DOCKER|${env.RELEASE_IMAGE}`, alwaysOn: true, webSocketsEnabled: true, healthCheckPath: '/api/health',
  })
  start()
  await ready(expectedHash, true)
  if (env.STUDIO_BOOTSTRAP_USERS) {
    stop()
    delete settings.STUDIO_BOOTSTRAP_USERS
    delete settings.STUDIO_BOOTSTRAP_PRINCIPAL_ID
    await azure('config/appsettings', 'PUT', settings)
    start()
    await ready(expectedHash, true)
  }
  record('release', { revision: env.GITHUB_SHA, image: env.RELEASE_IMAGE, url: siteUrl, storage: 'azure-sql-blob', homepageSha256: expectedHash })
  console.log(`Released ${env.GITHUB_SHA} to ${siteUrl}`)
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Release failed')
  if (stopped) {
    console.error('Restoring previous image and configuration')
    stop()
    await azure('config/appsettings', 'PUT', previousSettings)
    await azure('config/web', 'PATCH', {
      linuxFxVersion: previousConfig.linuxFxVersion, alwaysOn: previousConfig.alwaysOn,
      webSocketsEnabled: previousConfig.webSocketsEnabled, healthCheckPath: previousConfig.healthCheckPath,
    })
    start()
    await ready(oldHash, false)
    record('rollback-completed', { image: previousConfig.linuxFxVersion, homepageSha256: oldHash })
  }
  process.exitCode = 1
}
