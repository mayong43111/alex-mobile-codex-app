import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import { createContext, SourceTextModule, SyntheticModule } from 'node:vm'

const { z } = createRequire(new URL('../app/package.json', import.meta.url))('zod')

test('WebApp passes native avatar configuration only to the authenticated API process', async () => {
  const identifier = '11111111-1111-4111-8111-111111111111'
  const env = { WEBSITE_HOSTNAME: 'studio.example', ENTRA_TENANT_ID: identifier, ENTRA_CLIENT_ID: identifier, ENTRA_CLIENT_SECRET: 'test-secret', ENTRA_ALLOWED_USER_IDS: identifier, AZURE_GPT_ENDPOINT: 'https://model.example', AZURE_GPT_DEPLOYMENT: 'gpt', AZURE_IMAGE_ENDPOINT: 'https://model.example', AZURE_IMAGE_DEPLOYMENT: 'image', AZURE_MODEL_SUBSCRIPTION: identifier, AZURE_STORAGE_BLOB_ENDPOINT: 'https://storage.blob.core.windows.net', AZURE_STORAGE_CONTAINER: 'assets', COMFYUI_SERVER_URL: 'http://10.252.0.4:8188', SPEECH_AVATAR_ENDPOINT: 'https://speech.cognitiveservices.azure.com', OPENMONTAGE_AVATAR_ENABLED: '1', IDENTITY_ENDPOINT: 'http://identity.local', IDENTITY_HEADER: 'private-identity-header', PATH: '/test/bin' }
  const children = []
  const context = createContext({ process: { env, execPath: '/usr/local/bin/node', once() {} }, setTimeout: () => ({ unref() {} }), clearTimeout() {} })
  const modules = {
    'node:fs/promises': { mkdir: async () => {}, writeFile: async () => {}, mkdtemp: async () => '/tmp/test' },
    'node:crypto': { randomBytes: () => Buffer.from('test-runtime-token') },
    'node:child_process': { spawn: (_command, args, options) => { const child = new EventEmitter(); child.args = args; child.options = options; children.push(child); return child } },
    zod: { z },
  }
  const source = await readFile(new URL('./webapp.mjs', import.meta.url), 'utf8')
  const launcher = new SourceTextModule(source, { context })
  await launcher.link(name => new SyntheticModule(Object.keys(modules[name]), function () { for (const [key, value] of Object.entries(modules[name])) this.setExport(key, value) }, { context }))
  await launcher.evaluate()
  assert.equal(children.length, 1)
  assert.equal(children[0].options.env.OPENMONTAGE_AVATAR_ENABLED, undefined)
  assert.equal(children[0].options.env.IDENTITY_HEADER, undefined)
  children[0].emit('message', { type: 'ready' })
  assert.equal(children.length, 2)
  const api = children[1].options.env
  assert.equal(api.OPENMONTAGE_AVATAR_ENABLED, '1')
  assert.equal(api.COMFYUI_SERVER_URL, env.COMFYUI_SERVER_URL)
  assert.equal(api.SPEECH_AVATAR_ENDPOINT, env.SPEECH_AVATAR_ENDPOINT)
  assert.equal(api.IDENTITY_HEADER, env.IDENTITY_HEADER)
})