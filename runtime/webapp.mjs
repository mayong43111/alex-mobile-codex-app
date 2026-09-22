import { mkdir, writeFile, mkdtemp } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { z } from 'zod'

const environment = z.object({
  WEBSITE_HOSTNAME: z.string().min(1), ENTRA_TENANT_ID: z.string().uuid(),
  ENTRA_ALLOWED_USER_IDS: z.string().min(1),
  AZURE_GPT_ENDPOINT: z.url().startsWith('https://'), AZURE_GPT_DEPLOYMENT: z.string().min(1),
  AZURE_IMAGE_ENDPOINT: z.url().startsWith('https://'), AZURE_IMAGE_DEPLOYMENT: z.string().min(1),
  AZURE_MODEL_SUBSCRIPTION: z.string().uuid(),
  AZURE_STORAGE_BLOB_ENDPOINT: z.url().startsWith('https://'), AZURE_STORAGE_CONTAINER: z.string().min(1),
}).parse(process.env)
environment.ENTRA_ALLOWED_USER_IDS.split(',').forEach(id => z.string().uuid().parse(id))
await mkdir('/home/studio/runtime', { recursive: true })
await mkdir('/home/node', { recursive: true })
const temporary = await mkdtemp('/tmp/studio-')
const configFile = `${temporary}/services.json`
await writeFile(configFile, JSON.stringify({
  gateway: 'http://127.0.0.1:3199', token: randomBytes(32).toString('hex'),
  codex: { auth: 'entra', endpoint: environment.AZURE_GPT_ENDPOINT.replace(/\/$/, ''), deployment: environment.AZURE_GPT_DEPLOYMENT },
  image: { auth: 'entra', endpoint: environment.AZURE_IMAGE_ENDPOINT.replace(/\/$/, ''), deployment: environment.AZURE_IMAGE_DEPLOYMENT, subscription: environment.AZURE_MODEL_SUBSCRIPTION },
}), { mode: 0o600 })

const children = new Set()
let stopping = false
let exitCode = 0
let forceStop
const startup = setTimeout(() => stop(1), 60000)
function stop(code) {
  if (stopping) return
  stopping = true
  exitCode = code
  clearTimeout(startup)
  for (const child of children) child.kill('SIGTERM')
  forceStop = setTimeout(() => { for (const child of children) child.kill('SIGKILL') }, 20000)
  forceStop.unref()
}
function launch(args, options) {
  const child = spawn(process.execPath, args, { stdio: ['ignore', 'inherit', 'inherit', 'ipc'], ...options })
  children.add(child)
  child.once('error', () => stop(1))
  child.once('exit', code => {
    children.delete(child)
    if (!stopping) stop(code || 1)
    if (!children.size) { clearTimeout(forceStop); process.exit(exitCode) }
  })
  return child
}
const gateway = launch(['runtime/gateway.mjs'], { env: {
  PATH: process.env.PATH, HOME: '/home/node', CODEX_HOME: '/state/codex',
  SERVICES_FILE: configFile, RUNTIME_HOST: '127.0.0.1',
} })
gateway.once('message', message => {
  if (message.type !== 'ready' || stopping) return
  clearTimeout(startup)
  launch(['--experimental-strip-types', 'server/index.ts'], { cwd: '/opt/studio/app', env: {
    PATH: process.env.PATH, HOME: '/home/node', NODE_ENV: 'production', HOSTING_MODE: 'appservice', API_PORT: '8080',
    DATA_DIR: '/home/studio/data', RUNTIME_CONFIG: configFile,
    APP_ORIGINS: `https://${environment.WEBSITE_HOSTNAME}`,
    WEBSITE_HOSTNAME: environment.WEBSITE_HOSTNAME, ENTRA_TENANT_ID: environment.ENTRA_TENANT_ID, ENTRA_ALLOWED_USER_IDS: environment.ENTRA_ALLOWED_USER_IDS,
    IDENTITY_ENDPOINT: process.env.IDENTITY_ENDPOINT, IDENTITY_HEADER: process.env.IDENTITY_HEADER,
    AZURE_STORAGE_BLOB_ENDPOINT: environment.AZURE_STORAGE_BLOB_ENDPOINT, AZURE_STORAGE_CONTAINER: environment.AZURE_STORAGE_CONTAINER,
  } })
})
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => stop(0))