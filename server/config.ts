import { resolve } from 'node:path'
import { z } from 'zod'

const resourceId = z.string().regex(/^\/subscriptions\/[0-9a-f-]+\/resourceGroups\/[a-z0-9._()-]+\/providers\/Microsoft\.CognitiveServices\/accounts\/[a-z0-9-]+$/i).or(z.literal('')).default('')
const schema = z.object({
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4310),
  HMR_PORT: z.coerce.number().int().min(1).max(65535).default(4311),
  APP_ORIGIN: z.url().default('http://127.0.0.1:4310'),
  DATA_DIR: z.string().default('.data'),
  SQL_SERVER: z.string().regex(/^[a-z0-9-]+\.database\.windows\.net$/).or(z.literal('')).default(''),
  SQL_DATABASE: z.string().regex(/^[a-zA-Z0-9_-]+$/).or(z.literal('')).default(''),
  AZURE_BLOB_CONTAINER_URL: z.union([z.literal(''), z.url()]).default(''),
  AZURE_MODEL_ENDPOINT: z.union([z.literal(''), z.url()]).default(''),
  AZURE_MODEL_DEPLOYMENT: z.string().default(''),
  AZURE_IMAGE_ENDPOINT: z.union([z.literal(''), z.url()]).default(''),
  AZURE_IMAGE_DEPLOYMENT: z.string().default(''),
  AZURE_FOUNDRY_RESOURCE_ID: resourceId,
  AZURE_IMAGE_FOUNDRY_RESOURCE_ID: resourceId,
  AZURE_TOKEN_SCOPE: z.string().default('https://cognitiveservices.azure.com/.default'),
  AZURE_CLIENT_ID: z.string().optional(),
  AZURE_AUTH_MODE: z.enum(['managed-identity', 'azure-cli']).optional(),
  TOOLS_FILE: z.string().default('tools.json'),
})

export function readConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = schema.parse(env)
  if (Boolean(parsed.SQL_SERVER) !== Boolean(parsed.SQL_DATABASE)) throw new Error('SQL_SERVER and SQL_DATABASE must be configured together')
  if (Boolean(parsed.SQL_SERVER) !== Boolean(parsed.AZURE_BLOB_CONTAINER_URL)) throw new Error('Production SQL and Blob storage must be configured together')
  if (parsed.AZURE_BLOB_CONTAINER_URL) {
    const blob = new URL(parsed.AZURE_BLOB_CONTAINER_URL)
    if (blob.protocol !== 'https:' || !/^[a-z0-9]+\.blob\.core\.windows\.net$/.test(blob.hostname) || !/^\/[a-z0-9-]+$/.test(blob.pathname) || blob.username || blob.password || blob.search || blob.hash) {
      throw new Error('Blob container requires an HTTPS Azure Storage URL without credentials')
    }
  }
  const origin = new URL(parsed.APP_ORIGIN)
  if (origin.origin !== parsed.APP_ORIGIN) throw new Error('APP_ORIGIN must be an origin without a trailing slash or path')
  if (!['http:', 'https:'].includes(origin.protocol)) throw new Error('APP_ORIGIN requires HTTP or HTTPS')
  if (origin.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)) {
    throw new Error('Non-loopback access requires HTTPS')
  }
  if (parsed.AZURE_MODEL_ENDPOINT && new URL(parsed.AZURE_MODEL_ENDPOINT).protocol !== 'https:') {
    throw new Error('Azure model endpoint requires HTTPS')
  }
  if (parsed.AZURE_IMAGE_ENDPOINT) {
    const imageEndpoint = new URL(parsed.AZURE_IMAGE_ENDPOINT)
    if (imageEndpoint.protocol !== 'https:' || imageEndpoint.username || imageEndpoint.password || imageEndpoint.search || imageEndpoint.hash) {
      throw new Error('Azure image endpoint requires HTTPS without embedded credentials or query strings')
    }
    if (!imageEndpoint.pathname.endsWith('/openai/v1/')) throw new Error('Azure image endpoint must end with /openai/v1/')
  }
  if (Boolean(parsed.AZURE_IMAGE_ENDPOINT) !== Boolean(parsed.AZURE_IMAGE_DEPLOYMENT)) {
    throw new Error('Azure image endpoint and deployment must be configured together')
  }
  if (parsed.AZURE_IMAGE_FOUNDRY_RESOURCE_ID && !parsed.AZURE_IMAGE_ENDPOINT) throw new Error('Image model discovery requires AZURE_IMAGE_ENDPOINT')
  if (parsed.AZURE_FOUNDRY_RESOURCE_ID && !parsed.AZURE_MODEL_ENDPOINT) {
    throw new Error('Foundry model discovery requires AZURE_MODEL_ENDPOINT')
  }
  if (env.NODE_ENV === 'production' && parsed.AZURE_AUTH_MODE === 'azure-cli') {
    throw new Error('Azure CLI credentials are forbidden in production')
  }
  return {
    host: parsed.HOST, port: parsed.PORT, hmrPort: parsed.HMR_PORT, origin: parsed.APP_ORIGIN,
    dataDir: resolve(parsed.DATA_DIR), toolsFile: resolve(parsed.TOOLS_FILE),
    sqlServer: parsed.SQL_SERVER, sqlDatabase: parsed.SQL_DATABASE, blobContainerUrl: parsed.AZURE_BLOB_CONTAINER_URL,
    endpoint: parsed.AZURE_MODEL_ENDPOINT, deployment: parsed.AZURE_MODEL_DEPLOYMENT,
    imageEndpoint: parsed.AZURE_IMAGE_ENDPOINT, imageDeployment: parsed.AZURE_IMAGE_DEPLOYMENT,
    foundryResourceId: parsed.AZURE_FOUNDRY_RESOURCE_ID,
    imageFoundryResourceId: parsed.AZURE_IMAGE_FOUNDRY_RESOURCE_ID,
    tokenScope: parsed.AZURE_TOKEN_SCOPE, clientId: parsed.AZURE_CLIENT_ID || undefined,
    authMode: parsed.AZURE_AUTH_MODE ?? (env.NODE_ENV === 'production' ? 'managed-identity' : 'azure-cli'),
    secureCookie: origin.protocol === 'https:',
  }
}
export type Config = ReturnType<typeof readConfig>
