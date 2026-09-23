import test from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { DatabaseSync } from 'node:sqlite'
import { registerAuth, provisionLocalUser } from './auth.ts'
import { buildApp } from './app.ts'
import { Store } from './store.ts'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { ConfidentialClientApplication } from '@azure/msal-node'

test('password sessions require origin and CSRF, rotate on login and revoke on logout', async () => {
  const database = new DatabaseSync(':memory:')
  const app = Fastify()
  const origin = 'https://studio.example'
  await registerAuth(app, database, { origin })
  const userId = await provisionLocalUser(database, 'test-user', 'a-long-test-password', 'Test')
  app.get('/api/private', async request => request.studioSession!.user)
  app.post('/api/private', async () => ({ ok: true }))
  try {
    assert.equal((await app.inject('/api/private')).statusCode, 401)
    const payload = { username: 'test-user', password: 'a-long-test-password' }
    assert.equal((await app.inject({ method: 'POST', url: '/api/auth/login', payload })).statusCode, 403)
    assert.equal((await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin }, payload: { ...payload, password: 'wrong' } })).statusCode, 401)
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin }, payload })
    assert.equal(login.statusCode, 200)
    const cookie = login.cookies[0]
    assert.equal(cookie.httpOnly, true)
    assert.equal(cookie.secure, true)
    const cookies = { [cookie.name]: cookie.value }
    const session = (await app.inject({ url: '/api/auth/session', cookies })).json()
    assert.equal(session.user.id, userId)
    assert.equal((await app.inject({ url: '/api/private', cookies })).statusCode, 200)
    assert.equal((await app.inject({ method: 'POST', url: '/api/private', headers: { origin }, cookies })).statusCode, 403)
    assert.equal((await app.inject({ method: 'POST', url: '/api/private', headers: { origin, 'x-csrf-token': session.csrf }, cookies })).statusCode, 200)
    assert.equal((await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { origin, 'x-csrf-token': session.csrf }, cookies })).statusCode, 200)
    assert.equal((await app.inject({ url: '/api/private', cookies })).statusCode, 401)
    const headers = { 'x-ms-client-principal': Buffer.from(JSON.stringify({ auth_typ: 'aad' })).toString('base64') }
    assert.equal((await app.inject({ url: '/api/private', headers })).statusCode, 401)
    assert.equal((await app.inject('/api/auth/callback?state=invalid&code=fake')).headers.location, '/?login=failed')
  } finally { await app.close(); database.close() }
})

test('two users cannot access each other projects, assets, tasks or streams', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'studio-auth-'))
  const origin = 'https://localhost'
  const app = await buildApp({ dataDir, auth: { origin }, origins: [origin] })
  const store = new Store(join(dataDir, 'studio.sqlite'))
  try {
    const headers = []
    for (const username of ['user-one', 'user-two']) {
      await provisionLocalUser(store.db, username, 'test-password-123', username)
      const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin }, payload: { username, password: 'test-password-123' } })
      assert.equal(login.statusCode, 200)
      headers.push({ origin, cookie: `${login.cookies[0].name}=${login.cookies[0].value}`, 'x-csrf-token': login.json().csrf })
    }
    const created = await app.inject({ method: 'POST', url: '/api/projects', headers: headers[0], payload: { title: 'Private' } })
    assert.equal(created.statusCode, 201)
    const project = created.json()
    assert.equal((await app.inject({ url: '/api/auth/users', headers: headers[0] })).statusCode, 403)
    assert.equal((await app.inject({ method: 'POST', url: '/api/auth/users', headers: headers[0], payload: {} })).statusCode, 403)
    assert.deepEqual((await app.inject({ url: '/api/projects', headers: headers[1] })).json(), [])
    const asset = store.addAsset({ id: randomUUID(), projectId: project.id, name: 'private.png', kind: 'reference', width: 1, height: 1, bytes: 1, hash: 'private', createdAt: new Date().toISOString() })
    const run = store.queueAgent(project.id, { requestId: randomUUID(), text: 'private', mode: 'chat', ratio: '1:1' })
    const job = store.submit(project.id, { requestId: randomUUID(), text: 'private', ratio: '1:1', assetIds: [] })
    for (const url of [`/api/projects/${project.id}`, `/api/projects/${project.id}/events`, `/api/assets/${asset.id}/content`, `/api/assets/${asset.id}/content?thumbnail=1`, `/api/assets/${asset.id}/content?download=1`]) assert.equal((await app.inject({ url, headers: headers[1] })).statusCode, 404, url)
    for (const url of [`/api/projects/${project.id}/chat`, `/api/projects/${project.id}/uploads`, `/api/projects/${project.id}/messages`, `/api/projects/${project.id}/messages/${run.messageId}/resend`, `/api/agent-runs/${run.id}/stop`, `/api/jobs/${job.id}/cancel`]) assert.equal((await app.inject({ method: 'POST', url, headers: headers[1], payload: {} })).statusCode, 404, url)
    for (const method of ['PATCH', 'DELETE'] as const) assert.equal((await app.inject({ method, url: `/api/projects/${project.id}`, headers: headers[1], payload: {} })).statusCode, 404)
    assert.equal((await app.inject({ url: `/api/projects/${project.id}`, headers: headers[0] })).statusCode, 200)
  } finally { await app.close(); store.db.close(); await rm(dataDir, { recursive: true, force: true }) }
})

test('MSAL code flow binds state, nonce and browser, restricts identities and rejects replay', async context => {
  const database = new DatabaseSync(':memory:')
  const app = Fastify()
  const origin = 'https://studio.example', tenantId = randomUUID(), clientId = randomUUID(), userId = randomUUID()
  let nonce = '', state = '', rejection = ''
  let exchanges = 0
  context.mock.method(ConfidentialClientApplication.prototype, 'getAuthCodeUrl', async (request: { nonce: string; state: string; codeChallenge: string; codeChallengeMethod: string; redirectUri: string }) => {
    nonce = request.nonce; state = request.state
    assert.equal(request.codeChallengeMethod, 'S256')
    assert(request.codeChallenge.length >= 43)
    assert.equal(request.redirectUri, `${origin}/api/auth/callback`)
    return `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize?state=${state}`
  })
  context.mock.method(ConfidentialClientApplication.prototype, 'acquireTokenByCode', async (request: { codeVerifier: string }) => {
    assert(request.codeVerifier.length >= 43); exchanges++
    return { idTokenClaims: { tid: rejection === 'tenant' ? randomUUID() : tenantId, oid: rejection === 'user' ? randomUUID() : userId, aud: clientId, iss: `https://login.microsoftonline.com/${tenantId}/v2.0`, exp: Date.now() / 1000 + 300, nonce: rejection === 'nonce' ? 'wrong' : nonce, name: 'Admin' } }
  })
  await registerAuth(app, database, { origin, entra: { tenantId, clientId, clientSecret: 'offline-test-secret', userIds: [userId], adminUserIds: [userId] } })
  try {
    let start = await app.inject('/api/auth/entra')
    assert.equal(start.statusCode, 302)
    assert.equal((await app.inject(`/api/auth/callback?state=${state}&code=code`)).headers.location, '/?login=failed')
    assert.equal(exchanges, 0)
    for (rejection of ['nonce', 'tenant', 'user']) {
      start = await app.inject('/api/auth/entra')
      const response = await app.inject({ url: `/api/auth/callback?state=${state}&code=code`, cookies: { [start.cookies[0].name]: start.cookies[0].value } })
      assert.equal(response.headers.location, '/?login=failed')
      assert(!response.cookies.some(cookie => cookie.name.includes('session')))
    }
    rejection = ''
    start = await app.inject('/api/auth/entra')
    const url = `/api/auth/callback?state=${state}&code=code`
    const cookies = { [start.cookies[0].name]: start.cookies[0].value }
    const callback = await app.inject({ url, cookies })
    assert.equal(callback.headers.location, '/')
    const sessionCookie = callback.cookies.find(cookie => cookie.name.includes('session'))!
    const sessionCookies = { [sessionCookie.name]: sessionCookie.value }
    const session = (await app.inject({ url: '/api/auth/session', cookies: sessionCookies })).json()
    assert.equal(session.user.id, `entra:${tenantId}:${userId}`)
    assert.equal(session.user.admin, true)
    assert.equal((await app.inject({ url, cookies })).headers.location, '/?login=failed')
    const headers = { origin, 'x-csrf-token': session.csrf }
    const payload = { username: 'new-local', name: 'New', password: 'a-long-local-password' }
    assert.equal((await app.inject({ method: 'POST', url: '/api/auth/users', headers, cookies: sessionCookies, payload })).statusCode, 200)
    assert.equal((await app.inject({ method: 'POST', url: '/api/auth/users', headers, cookies: sessionCookies, payload })).statusCode, 409)
    const local = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin }, payload: { username: payload.username, password: payload.password } })
    assert.equal(local.statusCode, 200)
    assert.equal((await app.inject({ method: 'POST', url: '/api/auth/users', headers, cookies: sessionCookies, payload: { ...payload, reset: true, password: 'another-long-password' } })).statusCode, 200)
    assert.equal((await app.inject({ url: '/api/auth/session', cookies: { [local.cookies[0].name]: local.cookies[0].value } })).json().user, null)
    const listing = await app.inject({ url: '/api/auth/users', cookies: sessionCookies })
    assert.equal(listing.json().length, 1)
    assert(!listing.body.includes('password'))
  } finally { await app.close(); database.close() }
})