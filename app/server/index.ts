import { resolve } from 'node:path'
import { buildApp } from './app.ts'
import { loadAgentTransport } from './agent.ts'
import { BlobAssetStorage } from './assets.ts'
import { loadVmController } from './vm.ts'

const cloud = process.env.HOSTING_MODE === 'appservice'
const dataDir = resolve(process.env.DATA_DIR ?? '.data')
if (cloud && (!process.env.AZURE_STORAGE_BLOB_ENDPOINT || !process.env.AZURE_STORAGE_CONTAINER)) throw new Error('Cloud Blob storage configuration missing')
if (cloud && (!process.env.WEBSITE_HOSTNAME || !process.env.ENTRA_TENANT_ID || !process.env.ENTRA_ALLOWED_USER_IDS)) throw new Error('Cloud access policy missing')
const app = await buildApp({
  dataDir,
  vm: process.env.DATA_DIR && !process.env.VM_CONFIG ? undefined : await loadVmController(resolve(process.env.VM_CONFIG ?? '../.local/vm.json'), resolve(dataDir, 'vm-operation.json')),
  origins: process.env.APP_ORIGINS?.split(','),
  ...(cloud ? {
    hosts: [process.env.WEBSITE_HOSTNAME!, 'localhost', '127.0.0.1'],
    staticRoot: resolve('dist'),
    entra: { tenantId: process.env.ENTRA_TENANT_ID!, userIds: process.env.ENTRA_ALLOWED_USER_IDS!.split(',') },
    journalMode: 'DELETE' as const,
    assetStorage: new BlobAssetStorage(process.env.AZURE_STORAGE_BLOB_ENDPOINT!, process.env.AZURE_STORAGE_CONTAINER!),
  } : {}),
  agent: process.env.DATA_DIR && !process.env.RUNTIME_CONFIG ? undefined : await loadAgentTransport(resolve(process.env.RUNTIME_CONFIG ?? '../.local/services.json')),
})
await app.listen({ host: cloud ? '0.0.0.0' : '127.0.0.1', port: Number(process.env.API_PORT ?? 3001) })
console.log(`Studio API: ${app.server.address() instanceof Object ? JSON.stringify(app.server.address()) : ''}`)
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void app.close() })