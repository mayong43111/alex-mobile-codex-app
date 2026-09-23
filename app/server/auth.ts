import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import cookie from '@fastify/cookie'
import rateLimit from '@fastify/rate-limit'
import { ConfidentialClientApplication } from '@azure/msal-node'
import argon2 from 'argon2'
import { z } from 'zod'
import { HttpError } from './store.ts'

export type AuthUser = { id: string; name: string; provider: 'local' | 'entra'; admin?: boolean }
export type AuthOptions = { origin: string; entra?: { tenantId: string; clientId: string; clientSecret: string; userIds: string[]; adminUserIds?: string[] } }
type Session = { user: AuthUser; csrf: string; expires: number }
declare module 'fastify' { interface FastifyRequest { studioSession: Session | null } }
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const secret = () => randomBytes(32).toString('base64url')
const equal = (left: string, right: string) => { const first = Buffer.from(left), second = Buffer.from(right); return first.length === second.length && timingSafeEqual(first, second) }
const usernameSchema = z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9._-]{2,63}$/)
const passwordSchema = z.string().min(12).max(256)

export function initializeAuth(database: DatabaseSync) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS auth_users (id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, name TEXT NOT NULL, password_hash TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS auth_sessions (hash TEXT PRIMARY KEY, user_json TEXT NOT NULL, csrf TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS auth_flows (hash TEXT PRIMARY KEY, binding_hash TEXT NOT NULL, verifier TEXT NOT NULL, nonce TEXT NOT NULL, expires INTEGER NOT NULL);
  `)
}

export async function provisionLocalUser(database: DatabaseSync, username: string, password: string, name: string) {
  username = usernameSchema.parse(username)
  passwordSchema.parse(password)
  name = z.string().trim().min(1).max(80).parse(name)
  initializeAuth(database)
  const hash = await argon2.hash(password, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1 })
  const existing = database.prepare('SELECT id FROM auth_users WHERE username = ?').get(username)
  const id = existing?.id as string ?? randomUUID()
  database.prepare('INSERT INTO auth_users VALUES (?, ?, ?, ?) ON CONFLICT(username) DO UPDATE SET name = excluded.name, password_hash = excluded.password_hash').run(id, username, name, hash)
  database.prepare("DELETE FROM auth_sessions WHERE json_extract(user_json, '$.id') = ?").run(id)
  return id
}

export async function registerAuth(app: FastifyInstance, database: DatabaseSync, options: AuthOptions) {
  const origin = new URL(options.origin).origin
  if (!origin.startsWith('https://') && !['http://localhost:5188', 'http://127.0.0.1:5188'].includes(origin)) throw new Error('HTTPS authentication origin required')
  const secure = origin.startsWith('https://')
  const sessionCookie = secure ? '__Host-studio-session' : 'studio-session'
  const flowCookie = secure ? '__Host-studio-flow' : 'studio-flow'
  const cookieOptions = { path: '/', httpOnly: true, secure, sameSite: 'lax' as const }
  initializeAuth(database)
  await app.register(cookie)
  await app.register(rateLimit, { global: false })
  app.decorateRequest('studioSession', null)
  const dummyHash = await argon2.hash(secret(), { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1 })
  const authenticate = (request: FastifyRequest): Session | null => {
    const value = request.cookies[sessionCookie]
    if (!value || value.length > 128) return null
    const row = database.prepare('SELECT user_json, csrf, expires FROM auth_sessions WHERE hash = ? AND expires > ?').get(digest(value), Date.now())
    if (!row) return null
    const user = JSON.parse(row.user_json as string) as AuthUser
    if (user.provider === 'entra' && !options.entra?.userIds.some(id => user.id === `entra:${options.entra!.tenantId}:${id}`)) return null
    user.admin = user.provider === 'entra' && !!options.entra?.adminUserIds?.some(id => user.id === `entra:${options.entra!.tenantId}:${id}`)
    return { user, csrf: row.csrf as string, expires: Number(row.expires) }
  }
  app.addHook('onRequest', async (request, reply) => {
    request.studioSession = authenticate(request)
    const path = request.url.split('?')[0]
    if (!path.startsWith('/api/')) return
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) {
      if (request.headers.origin !== origin) throw new HttpError(403, 'Origin not allowed')
      if (path !== '/api/auth/login' && (!request.studioSession || typeof request.headers['x-csrf-token'] !== 'string' || !equal(request.headers['x-csrf-token'], request.studioSession.csrf))) throw new HttpError(403, 'Invalid CSRF token')
    }
    if (['/api/auth/session', '/api/auth/login', '/api/auth/entra', '/api/auth/callback'].includes(path)) return
    if (!request.studioSession) { reply.clearCookie(sessionCookie, cookieOptions); throw new HttpError(401, 'Sign in required') }
  })
  function establish(request: FastifyRequest, user: AuthUser) {
    const old = request.cookies[sessionCookie]
    if (old) database.prepare('DELETE FROM auth_sessions WHERE hash = ?').run(digest(old))
    const value = secret(), csrf = secret(), expires = Date.now() + 12 * 60 * 60 * 1000
    database.prepare('DELETE FROM auth_sessions WHERE expires <= ?').run(Date.now())
    database.prepare('INSERT INTO auth_sessions VALUES (?, ?, ?, ?)').run(digest(value), JSON.stringify(user), csrf, expires)
    return { value, csrf, user }
  }
  const loginRate = { rateLimit: { max: 8, timeWindow: '15 minutes', keyGenerator: () => 'login' } }
  app.get('/api/auth/session', async request => ({ enabled: true, entra: !!options.entra, user: request.studioSession?.user ?? null, csrf: request.studioSession?.csrf ?? null }))
  app.post('/api/auth/login', { config: loginRate }, async (request, reply) => {
    const input = z.object({ username: usernameSchema, password: z.string().min(1).max(256) }).strict().parse(request.body)
    const row = database.prepare('SELECT * FROM auth_users WHERE username = ?').get(input.username)
    const valid = await argon2.verify((row?.password_hash as string) ?? dummyHash, input.password)
    if (!row || !valid) throw new HttpError(401, '账号或密码不正确')
    const session = establish(request, { id: row.id as string, name: row.name as string, provider: 'local' })
    reply.setCookie(sessionCookie, session.value, { ...cookieOptions, maxAge: 12 * 60 * 60 })
    return { user: session.user, csrf: session.csrf }
  })
  app.post('/api/auth/logout', async (request, reply) => {
    const value = request.cookies[sessionCookie]
    if (value) database.prepare('DELETE FROM auth_sessions WHERE hash = ?').run(digest(value))
    reply.clearCookie(sessionCookie, cookieOptions)
    return { signedOut: true }
  })
  app.get('/api/auth/users', async request => {
    if (!request.studioSession?.user.admin) throw new HttpError(403, 'Administrator required')
    return database.prepare('SELECT id, username, name FROM auth_users ORDER BY username').all()
  })
  app.post('/api/auth/users', { config: { rateLimit: { max: 20, timeWindow: '15 minutes', keyGenerator: () => 'provision' } } }, async request => {
    if (!request.studioSession?.user.admin) throw new HttpError(403, 'Administrator required')
    const input = z.object({ username: usernameSchema, password: passwordSchema, name: z.string().trim().min(1).max(80), reset: z.boolean().default(false) }).strict().parse(request.body)
    const existing = database.prepare('SELECT id FROM auth_users WHERE username = ?').get(input.username)
    if (existing && !input.reset) throw new HttpError(409, '账号已存在，请明确选择重置密码')
    if (!existing && input.reset) throw new HttpError(404, '账号不存在')
    const id = await provisionLocalUser(database, input.username, input.password, input.name)
    return { id, username: input.username, name: input.name }
  })
  const client = () => {
    if (!options.entra) throw new HttpError(404, 'Entra login not configured')
    return new ConfidentialClientApplication({ auth: { clientId: options.entra.clientId, clientSecret: options.entra.clientSecret, authority: `https://login.microsoftonline.com/${options.entra.tenantId}` }, system: { loggerOptions: { piiLoggingEnabled: false, loggerCallback: () => {} } } })
  }
  app.get('/api/auth/entra', { config: { rateLimit: { max: 20, timeWindow: '15 minutes', keyGenerator: () => 'entra' } } }, async (_request, reply) => {
    const msal = client(), state = secret(), binding = secret(), verifier = secret(), nonce = secret()
    database.prepare('DELETE FROM auth_flows WHERE expires <= ?').run(Date.now())
    database.prepare('INSERT INTO auth_flows VALUES (?, ?, ?, ?, ?)').run(digest(state), digest(binding), verifier, nonce, Date.now() + 600000)
    const url = await msal.getAuthCodeUrl({ scopes: ['openid', 'profile', 'email'], redirectUri: `${origin}/api/auth/callback`, state, nonce, codeChallenge: createHash('sha256').update(verifier).digest('base64url'), codeChallengeMethod: 'S256', prompt: 'select_account', responseMode: 'query' })
    reply.setCookie(flowCookie, binding, { ...cookieOptions, maxAge: 600 })
    return reply.redirect(url)
  })
  app.get('/api/auth/callback', async (request, reply) => {
    reply.header('Referrer-Policy', 'no-referrer')
    const parsed = z.object({ state: z.string().max(128), code: z.string().max(16000).optional(), error: z.string().optional() }).safeParse(request.query)
    if (!parsed.success) return reply.redirect('/?login=failed')
    const { state, code, error } = parsed.data
    const flow = database.prepare('DELETE FROM auth_flows WHERE hash = ? RETURNING *').get(digest(state))
    const binding = request.cookies[flowCookie]
    reply.clearCookie(flowCookie, cookieOptions)
    if (!flow || Number(flow.expires) <= Date.now() || !binding || !equal(digest(binding), flow.binding_hash as string) || error || !code) return reply.redirect('/?login=failed')
    try {
      const token = await client().acquireTokenByCode({ code, scopes: ['openid', 'profile', 'email'], redirectUri: `${origin}/api/auth/callback`, codeVerifier: flow.verifier as string })
      const claims = token?.idTokenClaims as Record<string, unknown> | undefined
      const entra = options.entra!
      if (!claims || claims.nonce !== flow.nonce || claims.tid !== entra.tenantId || claims.aud !== entra.clientId || claims.iss !== `https://login.microsoftonline.com/${entra.tenantId}/v2.0` || typeof claims.exp !== 'number' || claims.exp * 1000 <= Date.now() || typeof claims.oid !== 'string' || !entra.userIds.includes(claims.oid)) throw new Error('Identity rejected')
      const session = establish(request, { id: `entra:${entra.tenantId}:${claims.oid}`, name: typeof claims.name === 'string' ? claims.name.slice(0, 80) : 'Entra user', provider: 'entra' })
      reply.setCookie(sessionCookie, session.value, { ...cookieOptions, maxAge: 12 * 60 * 60 })
      return reply.redirect('/')
    } catch { return reply.redirect('/?login=failed') }
  })
  return { authenticate }
}