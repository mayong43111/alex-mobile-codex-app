import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildApp } from '../server/app.js'
import { readConfig } from '../server/config.js'
import { FixtureAgent } from './helpers.js'

test('development UI serves only the frontend, not backend or workspace files', { timeout: 30_000 }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'studio-ui-test-'))
  const config = readConfig({ DATA_DIR: dataDir, TOOLS_FILE: join(dataDir, 'tools.json') })
  const { app } = await buildApp(config, { agent: new FixtureAgent(), logger: false })
  try {
    await app.listen({ host: '127.0.0.1', port: 0 })
    const address = app.server.address()
    assert.ok(address && typeof address !== 'string')
    const origin = `http://127.0.0.1:${address.port}`
    assert.equal((await fetch(origin)).status, 200)
    assert.equal((await fetch(`${origin}/src/main.tsx`)).status, 200)
    assert.equal((await fetch(`${origin}/server/config.ts`)).status, 403)
    assert.equal((await fetch(`${origin}/README.md`)).status, 403)
    assert.equal((await fetch(`${origin}/api/unknown`)).status, 401)
  } finally {
    await app.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})
