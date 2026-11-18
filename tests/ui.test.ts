import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { WebSocket } from 'ws'
import { buildApp } from '../server/app.js'
import { readConfig } from '../server/config.js'
import { FixtureAgent } from './helpers.js'

test('development UI supports React HMR without exposing backend or workspace files', { timeout: 30_000 }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'studio-ui-test-'))
  const reservation = createServer().listen(0, '127.0.0.1')
  await once(reservation, 'listening')
  const hmrAddress = reservation.address()
  assert.ok(hmrAddress && typeof hmrAddress !== 'string')
  await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()))
  const config = readConfig({ DATA_DIR: dataDir, TOOLS_FILE: join(dataDir, 'tools.json'), HMR_PORT: String(hmrAddress.port) })
  const { app } = await buildApp(config, { agent: new FixtureAgent(), logger: false })
  try {
    await app.listen({ host: '127.0.0.1', port: 0 })
    const address = app.server.address()
    assert.ok(address && typeof address !== 'string')
    const origin = `http://127.0.0.1:${address.port}`
    assert.equal((await fetch(origin)).status, 200)
    assert.equal((await fetch(`${origin}/src/main.tsx`)).status, 200)
    const component = await fetch(`${origin}/src/App.tsx`)
    assert.equal(component.status, 200)
    assert.match(await component.text(), /\$RefreshReg\$/)
    const client = await (await fetch(`${origin}/@vite/client`)).text()
    const token = /const wsToken = "([^"]+)"/.exec(client)?.[1]
    assert.ok(token, 'Vite client must include its authenticated HMR token')
    const socket = new WebSocket(`ws://127.0.0.1:${hmrAddress.port}/?token=${token}`, 'vite-hmr', { headers: { Origin: config.origin } })
    try {
      const message = once(socket, 'message')
      await once(socket, 'open')
      assert.equal(JSON.parse(String((await message)[0])).type, 'connected')
    } finally { socket.close() }
    assert.equal((await fetch(`${origin}/server/config.ts`)).status, 403)
    assert.equal((await fetch(`${origin}/README.md`)).status, 403)
    assert.equal((await fetch(`${origin}/api/unknown`)).status, 401)
  } finally {
    await app.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})
