import { resolve } from 'node:path'
import { buildApp } from './app.ts'
import { loadAgentTransport } from './agent.ts'
import { BlobAssetStorage } from './assets.ts'
import { loadVmController } from './vm.ts'
import type { AuthOptions } from './auth.ts'
import { AzureCliCredential, ManagedIdentityCredential } from '@azure/identity'
import { createAvatarProvider } from './avatar-provider.ts'

const cloud = process.env.HOSTING_MODE === 'appservice'
const avatarCredential = process.env.SPEECH_AVATAR_ENDPOINT ? cloud ? new ManagedIdentityCredential() : new AzureCliCredential() : undefined
const dataDir = resolve(process.env.DATA_DIR ?? '.data')
if (cloud && (!process.env.AZURE_STORAGE_BLOB_ENDPOINT || !process.env.AZURE_STORAGE_CONTAINER)) throw new Error('Cloud Blob storage configuration missing')
if (cloud && (!process.env.WEBSITE_HOSTNAME || !process.env.ENTRA_TENANT_ID || !process.env.ENTRA_ALLOWED_USER_IDS || !process.env.ENTRA_CLIENT_ID || !process.env.ENTRA_CLIENT_SECRET)) throw new Error('Cloud application authentication missing')
const auth: AuthOptions | undefined = cloud ? {
  origin: `https://${process.env.WEBSITE_HOSTNAME}`,
  entra: { tenantId: process.env.ENTRA_TENANT_ID!, clientId: process.env.ENTRA_CLIENT_ID!, clientSecret: process.env.ENTRA_CLIENT_SECRET!, userIds: process.env.ENTRA_ALLOWED_USER_IDS!.split(','), adminUserIds: process.env.ENTRA_ADMIN_USER_IDS?.split(',') },
} : process.env.AUTH_ORIGIN ? { origin: process.env.AUTH_ORIGIN } : undefined
const app = await buildApp({
  dataDir,
  avatar: process.env.SPEECH_AVATAR_ENDPOINT ? createAvatarProvider(process.env.SPEECH_AVATAR_ENDPOINT, async () => {
    const token = await avatarCredential!.getToken('https://cognitiveservices.azure.com/.default')
    if (!token) throw new Error('Speech authentication unavailable')
    return { Authorization: `Bearer ${token.token}` }
  }) : undefined,
  vm: process.env.DATA_DIR && !process.env.VM_CONFIG ? undefined : await loadVmController(resolve(process.env.VM_CONFIG ?? '../.local/vm.json'), resolve(dataDir, 'vm-operation.json')),
  origins: process.env.APP_ORIGINS?.split(','),
  auth,
  ...(cloud ? {
    hosts: [process.env.WEBSITE_HOSTNAME!, 'localhost', '127.0.0.1'],
    staticRoot: resolve('dist'),
    journalMode: 'DELETE' as const,
    assetStorage: new BlobAssetStorage(process.env.AZURE_STORAGE_BLOB_ENDPOINT!, process.env.AZURE_STORAGE_CONTAINER!),
  } : {}),
  agent: process.env.DATA_DIR && !process.env.RUNTIME_CONFIG ? undefined : await loadAgentTransport(resolve(process.env.RUNTIME_CONFIG ?? '../.local/services.json')),
})
await app.listen({ host: cloud ? '0.0.0.0' : '127.0.0.1', port: Number(process.env.API_PORT ?? 3001) })
console.log(`Studio API: ${app.server.address() instanceof Object ? JSON.stringify(app.server.address()) : ''}`)
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void app.close() })