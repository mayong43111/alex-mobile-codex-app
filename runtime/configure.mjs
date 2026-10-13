import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { randomBytes } from 'node:crypto'

const target = new URL('../.local/services.json', import.meta.url)
if (existsSync(target)) throw new Error('Configuration already exists; refusing to overwrite credentials')
function required(name) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`Missing required environment variable: ${name}`)
  return value
}
const subscription = required('AZURE_MODEL_SUBSCRIPTION')
const gptEndpoint = required('AZURE_GPT_ENDPOINT')
const gptDeployment = required('AZURE_GPT_DEPLOYMENT')
const imageEndpoint = required('AZURE_IMAGE_ENDPOINT')
const imageDeployment = required('AZURE_IMAGE_DEPLOYMENT')
const auth = process.env.AZURE_CODEX_AUTH || 'entra'
if (!['entra', 'key'].includes(auth)) throw new Error('AZURE_CODEX_AUTH must be entra or key')
function key() {
  const account = required('AZURE_GPT_ACCOUNT')
  const resourceGroup = required('AZURE_MODEL_RESOURCE_GROUP')
  try {
    const output = execFileSync(process.env.AZURE_CLI_PATH || 'az', ['cognitiveservices', 'account', 'keys', 'list', '--subscription', subscription, '-g', resourceGroup, '-n', account, '-o', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    const value = JSON.parse(output).key1
    if (!value) throw new Error('Missing key')
    return value
  } catch { throw new Error('Could not obtain configured key; credential contents omitted') }
}
const config = {
  gateway: 'http://127.0.0.1:3199', token: randomBytes(32).toString('hex'),
  codex: { endpoint: gptEndpoint, deployment: gptDeployment, auth, ...(auth === 'key' ? { key: key() } : {}) },
  image: { endpoint: imageEndpoint, deployment: imageDeployment, auth: 'entra', subscription,
    deployments: { 'gpt-image-2.5-flare': 'gpt-image-2.5-flare', 'gpt-image-2.5-sunburst': 'gpt-image-2.5-sunburst' } },
}
mkdirSync(new URL('../.local/', import.meta.url), { recursive: true, mode: 0o700 })
writeFileSync(target, JSON.stringify(config), { mode: 0o600, flag: 'wx' })
console.log('Saved isolated runtime configuration (0600); credentials not printed.')