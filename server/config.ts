import { resolve } from 'node:path'
import { z } from 'zod'

const schema = z.object({
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4310),
  APP_ORIGIN: z.url().default('http://127.0.0.1:4310'),
  DATA_DIR: z.string().default('.data'),
  AZURE_MODEL_ENDPOINT: z.union([z.literal(''), z.url()]).default(''),
  AZURE_MODEL_DEPLOYMENT: z.string().default(''),
  AZURE_TOKEN_SCOPE: z.string().default('https://cognitiveservices.azure.com/.default'),
  AZURE_CLIENT_ID: z.string().optional(),
  AZURE_AUTH_MODE: z.enum(['managed-identity', 'azure-cli']).default('managed-identity'),
  TOOLS_FILE: z.string().default('tools.json'),
})

export function readConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = schema.parse(env)
  const origin = new URL(parsed.APP_ORIGIN)
  if (origin.origin !== parsed.APP_ORIGIN) throw new Error('APP_ORIGIN must be an origin without a trailing slash or path')
  if (!['http:', 'https:'].includes(origin.protocol)) throw new Error('APP_ORIGIN requires HTTP or HTTPS')
  if (origin.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)) {
    throw new Error('Non-loopback access requires HTTPS')
  }
  if (parsed.AZURE_MODEL_ENDPOINT && new URL(parsed.AZURE_MODEL_ENDPOINT).protocol !== 'https:') {
    throw new Error('Azure model endpoint requires HTTPS')
  }
  if (env.NODE_ENV === 'production' && parsed.AZURE_AUTH_MODE === 'azure-cli') {
    throw new Error('Azure CLI credentials are forbidden in production')
  }
  return {
    host: parsed.HOST, port: parsed.PORT, origin: parsed.APP_ORIGIN,
    dataDir: resolve(parsed.DATA_DIR), toolsFile: resolve(parsed.TOOLS_FILE),
    endpoint: parsed.AZURE_MODEL_ENDPOINT, deployment: parsed.AZURE_MODEL_DEPLOYMENT,
    tokenScope: parsed.AZURE_TOKEN_SCOPE, clientId: parsed.AZURE_CLIENT_ID || undefined,
    authMode: parsed.AZURE_AUTH_MODE, secureCookie: origin.protocol === 'https:',
  }
}
export type Config = ReturnType<typeof readConfig>
