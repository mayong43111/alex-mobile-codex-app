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
const resourceGroup = required('AZURE_MODEL_RESOURCE_GROUP')
const account = required('AZURE_GPT_ACCOUNT')
const gptEndpoint = required('AZURE_GPT_ENDPOINT')
const gptDeployment = required('AZURE_GPT_DEPLOYMENT')
const imageEndpoint = required('AZURE_IMAGE_ENDPOINT')
const imageDeployment = required('AZURE_IMAGE_DEPLOYMENT')
const az = process.env.AZURE_CLI_PATH || 'az'
function key(account) {
  try {
    const output = execFileSync(az, ['cognitiveservices', 'account', 'keys', 'list', '--subscription', subscription,
      '-g', resourceGroup, '-n', account, '-o', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    const result = JSON.parse(output).key1
    if (!result) throw new Error('Missing key')
    return result
  } catch { throw new Error(`Could not obtain credential for ${account}; no secret output retained`) }
}
const config = {
  gateway: 'http://127.0.0.1:3199', token: randomBytes(32).toString('hex'),
  codex: { endpoint: gptEndpoint, deployment: gptDeployment, key: key(account) },
  image: { endpoint: imageEndpoint, deployment: imageDeployment, auth: 'entra', subscription },
}
mkdirSync(new URL('../.local/', import.meta.url), { recursive: true, mode: 0o700 })
writeFileSync(target, JSON.stringify(config), { mode: 0o600, flag: 'wx' })
console.log('Saved isolated runtime configuration (0600); credentials not printed.')