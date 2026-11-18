import test from 'node:test'
import assert from 'node:assert/strict'
import { ModelCatalog } from '../server/models.js'
import { readConfig } from '../server/config.js'
import { modelCatalogFixture } from './helpers.js'

test('Foundry catalog lists only deployed Responses chat models and rejects arbitrary selections', async () => {
  const catalog = modelCatalogFixture()
  const result = await catalog.list()
  assert.deepEqual(result.models.map(model => model.id), ['fixture-model', 'fixture-model-b'])
  assert.equal((await catalog.select('fixture-model-b'))?.version, '2')
  await assert.rejects(catalog.select('image'), /不可用/)
  await assert.rejects(catalog.select('unknown-model'), /不可用/)
})

test('Foundry catalog uses CLI tokens, follows safe pagination and caches until refresh', async () => {
  const config = readConfig({
    AZURE_MODEL_ENDPOINT: 'https://models.example/openai/v1/',
    AZURE_FOUNDRY_RESOURCE_ID: '/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/test/providers/Microsoft.CognitiveServices/accounts/fixture',
  })
  const calls: string[] = []
  const model = { name: 'fixture-model', format: 'OpenAI', version: '1' }
  const request: typeof fetch = async (url, options) => {
    calls.push(String(url))
    assert.equal(new Headers(options?.headers).get('authorization'), 'Bearer fixture-token')
    if (String(url).includes('/models?')) return Response.json({ value: [{ ...model, capabilities: { responses: 'true', chatCompletion: 'true' } }] })
    if (String(url).includes('page=2')) return Response.json({ value: [{ name: 'alias', properties: { model, provisioningState: 'Succeeded' } }] })
    return Response.json({ value: [], nextLink: `${url}&page=2` })
  }
  const catalog = new ModelCatalog(config, { getToken: async () => ({ token: 'fixture-token', expiresOnTimestamp: Date.now() + 3600_000 }) }, request)
  assert.deepEqual((await catalog.list()).models.map(model => model.id), ['alias'])
  await catalog.list()
  assert.equal(calls.length, 3)
  await catalog.list(true)
  assert.equal(calls.length, 6)
})

test('Foundry auth, permission and unsafe pagination errors are explicit, without token leakage', async () => {
  const config = readConfig({
    AZURE_MODEL_ENDPOINT: 'https://models.example/openai/v1/',
    AZURE_FOUNDRY_RESOURCE_ID: '/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/test/providers/Microsoft.CognitiveServices/accounts/fixture',
  })
  const credential = { getToken: async () => ({ token: 'private-fixture-token', expiresOnTimestamp: Date.now() + 3600_000 }) }
  const expired = new ModelCatalog(config, { getToken: async () => { throw new Error('expired private-fixture-token') } })
  await assert.rejects(expired.list(), error => error instanceof Error && error.message.includes('az login') && !error.message.includes('private-fixture-token'))
  await assert.rejects(new ModelCatalog(config, credential, async () => new Response(null, { status: 403 })).list(), /权限/)
  const unsafe = new ModelCatalog(config, credential, async () => Response.json({ value: [], nextLink: 'https://untrusted.example/collect' }))
  await assert.rejects(unsafe.list(), /分页地址/)
})
