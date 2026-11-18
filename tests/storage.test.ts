import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { fixture } from './helpers.js'
import { SessionFiles } from '../server/session-files.js'
import { importAccounts, sqlRuntimeClientId } from '../server/bootstrap.js'
import { hashPassword } from '../server/auth.js'
import { readConfig } from '../server/config.js'

test('session files persist exact bytes, serialize appends and isolate users and sessions', async t => {
  const f = await fixture(t)
  const id = randomUUID()
  const files = new SessionFiles(f.store.database, f.alice.id, id)
  await files.writeFileBytes('/session/image.bin', new Uint8Array([0, 255, 128, 10]))
  const reopened = new SessionFiles(f.store.database, f.alice.id, id)
  assert.deepEqual(await reopened.readFileBytes('/session/image.bin'), Buffer.from([0, 255, 128, 10]))
  await Promise.all(['one\n', 'two\n', 'three\n'].map(text => files.appendFile('/session/events.jsonl', text)))
  assert.equal(await reopened.readFile('/session/events.jsonl'), 'one\ntwo\nthree\n')
  assert.equal(await new SessionFiles(f.store.database, f.bob.id, id).exists('/session/image.bin'), false)
  assert.equal(await new SessionFiles(f.store.database, f.alice.id, randomUUID()).exists('/session/image.bin'), false)
  await assert.rejects(files.readFile('../session/events.jsonl'), /EINVAL/)
  await files.rename('/session/events.jsonl', '/session/renamed.jsonl')
  assert.equal(await files.exists('/session/events.jsonl'), false)
  assert.equal(await files.readFile('/session/renamed.jsonl'), 'one\ntwo\nthree\n')
})

test('session directory rename rolls back every change when a descendant path is invalid', async t => {
  const f = await fixture(t)
  const files = new SessionFiles(f.store.database, f.alice.id, randomUUID())
  await files.writeFile('/src/first', 'retained')
  const long = `/src/${'x'.repeat(390)}`
  await files.writeFile(long, 'also retained')
  const destination = `/${'d'.repeat(20)}`
  await assert.rejects(files.rename('/src', destination), /ENAMETOOLONG/)
  assert.equal(await files.readFile('/src/first'), 'retained')
  assert.equal(await files.readFile(long), 'also retained')
  assert.equal(await files.exists(destination), false)
  await assert.rejects(files.rm('/src', false, false), /ENOTEMPTY/)
  await files.rm('/src', true, false)
  assert.equal(await files.exists(long), false)
})

test('account bootstrap is idempotent and refuses credential replacement', async t => {
  const f = await fixture(t)
  const password = await hashPassword('fixture-import-password')
  const raw = JSON.stringify([{ username: 'imported', password }])
  await importAccounts(f.store, raw)
  const first = await f.store.user('imported')
  await importAccounts(f.store, raw)
  assert.deepEqual(await f.store.user('imported'), first)
  await assert.rejects(importAccounts(f.store, JSON.stringify([{ username: 'imported', password: await hashPassword('different-password') }])), /refusing overwrite/)
  assert.deepEqual(await f.store.user('imported'), first)
  assert.throws(() => readConfig({ SQL_SERVER: 'sql-fixture.database.windows.net', SQL_DATABASE: 'fixture' }), /together/)
  assert.throws(() => readConfig({ SQL_SERVER: 'sql-fixture.database.windows.net', SQL_DATABASE: 'fixture', AZURE_BLOB_CONTAINER_URL: 'https://storage.blob.core.windows.net/private?sig=not-allowed' }), /without credentials/)
})

test('SQL managed-identity SID uses the client ID and verifies the expected object ID', () => {
  const principal = randomUUID()
  const clientId = randomUUID()
  const token = (claims: object) => `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`
  assert.equal(sqlRuntimeClientId(token({ oid: principal, appid: clientId }), principal), clientId)
  assert.equal(sqlRuntimeClientId(token({ oid: principal, azp: clientId }), principal), clientId)
  assert.throws(() => sqlRuntimeClientId(token({ oid: randomUUID(), appid: clientId }), principal), /does not match/)
  assert.throws(() => sqlRuntimeClientId(token({ oid: principal }), principal), /missing its client ID/)
  assert.throws(() => sqlRuntimeClientId('invalid', principal), /Invalid managed-identity token metadata/)
})
