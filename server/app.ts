import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import websocket from '@fastify/websocket'
import staticFiles from '@fastify/static'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import { credentialsSchema, checkPassword, hashPassword, LoginLimiter } from './auth.js'
import type { Config } from './config.js'
import { AppError } from './errors.js'
import { Store } from './store.js'
import type { Login } from './store.js'
import { CopilotAgent } from './agent.js'
import type { Agent } from './agent.js'
import { AgentHost } from './host.js'
import { ToolRegistry } from './tools.js'

declare module 'fastify' {
  interface FastifyRequest { login?: Login }
}
export async function buildApp(config: Config, options: { agent?: Agent; store?: Store; serveUi?: boolean; logger?: boolean } = {}) {
  const app = Fastify({ logger: options.logger ?? true, disableRequestLogging: true, bodyLimit: 32 * 1024, trustProxy: false })
  const store = options.store ?? new Store(config.dataDir)
  const tools = new ToolRegistry(config.toolsFile)
  const host = new AgentHost(store, options.agent ?? new CopilotAgent(config, tools), message => app.log.error(message))
  const limiter = new LoginLimiter()
  const dummyPassword = await hashPassword(randomBytes(32).toString('hex'))
  const cookieName = config.secureCookie ? '__Host-studio' : 'studio'
  await app.register(cookie)
  await app.register(websocket, { options: { maxPayload: 32 * 1024 } })
  app.decorateRequest('login', undefined)
  app.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    reply.header('X-Content-Type-Options', 'nosniff')
    reply.header('Referrer-Policy', 'no-referrer')
    reply.header('X-Frame-Options', 'DENY')
    if (process.env.NODE_ENV === 'production') {
      reply.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'; form-action 'self'")
    }
    if (!request.url.startsWith('/api/')) return
    if (request.method !== 'GET' && request.headers.origin !== config.origin) throw new AppError(403, '请求来源无效')
    if (request.routeOptions.url === '/api/login' || request.routeOptions.url === '/api/health') return
    const token = request.cookies[cookieName]
    request.login = token ? store.login(token) : undefined
    if (!request.login) throw new AppError(401, '请先登录')
    if (request.method !== 'GET' && request.headers['x-csrf-token'] !== request.login.csrf) throw new AppError(403, '会话验证失败，请刷新页面')
    if (request.routeOptions.url === '/api/ahp' && request.headers.origin !== config.origin) throw new AppError(403, 'WebSocket 来源无效')
  })
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) return reply.code(error.status).send({ error: error.message })
    if (error instanceof z.ZodError) return reply.code(400).send({ error: '输入格式不正确' })
    const status = error instanceof Error && 'statusCode' in error && typeof error.statusCode === 'number' && error.statusCode < 500 ? error.statusCode : 500
    app.log.error('Request failed; details withheld')
    return reply.code(status).send({ error: '请求失败，请稍后重试' })
  })
  app.get('/api/health', async () => ({ status: 'ok', protocol: 'AHP/1.1', modelConfigured: Boolean(config.endpoint && config.deployment) }))
  app.post('/api/login', async (request, reply) => {
    if (!limiter.attempt(request.ip)) throw new AppError(429, '登录尝试过多，请稍后再试')
    const input = credentialsSchema.parse(request.body)
    const user = store.user(input.username)
    const valid = await checkPassword(input.password, user?.password ?? dummyPassword)
    if (!user || !valid) throw new AppError(401, '账号或密码不正确')
    const { token, login } = store.createLogin(user)
    reply.setCookie(cookieName, token, { httpOnly: true, secure: config.secureCookie, sameSite: 'strict', path: '/', maxAge: 12 * 3600 })
    return { id: login.userId, username: login.username, csrf: login.csrf }
  })
  app.get('/api/me', async request => ({ id: request.login!.userId, username: request.login!.username, csrf: request.login!.csrf }))
  app.post('/api/logout', async (request, reply) => {
    store.revokeLogin(request.login!.tokenHash)
    host.revoke(request.login!.tokenHash)
    reply.clearCookie(cookieName, { path: '/', secure: config.secureCookie, sameSite: 'strict' })
    return { ok: true }
  })
  app.get('/api/settings', async request => ({
    skills: store.skills(request.login!.userId), tools: tools.publicTools(),
    model: { configured: Boolean(config.endpoint && config.deployment), deployment: config.deployment, authMode: config.authMode },
  }))
  app.put('/api/settings/skills', async request => {
    const skills = z.object({ 'image-production': z.boolean(), 'video-production': z.boolean() }).strict().parse(request.body)
    store.setSkills(request.login!.userId, skills)
    return { skills }
  })
  app.get('/api/conversations', async request => store.conversations(request.login!.userId).map(conversation => store.summary(conversation)))
  app.post('/api/conversations', async request => {
    const { title } = z.object({ title: z.string().trim().min(1).max(80).default('新对话') }).strict().parse(request.body)
    return store.summary(store.createConversation(request.login!.userId, title))
  })
  app.get('/api/conversations/:id', async request => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params)
    return store.conversation(request.login!.userId, id).state
  })
  app.get('/api/ahp', { websocket: true }, (socket, request) => host.attach(socket, request.login!))
  if (options.serveUi !== false) {
    if (process.env.NODE_ENV === 'production') {
      const root = resolve('dist')
      if (!existsSync(root)) throw new Error('Production UI not built; run npm run build')
      await app.register(staticFiles, { root })
      app.get('/', async (_request, reply) => reply.sendFile('index.html'))
    } else {
      const { createServer } = await import('vite')
      const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'spa' })
      app.setNotFoundHandler((request, reply) => {
        if (request.url.startsWith('/api/')) return reply.code(404).send({ error: '接口不存在' })
        reply.hijack()
        vite.middlewares(request.raw, reply.raw)
      })
      app.addHook('onClose', async () => vite.close())
    }
  }
  app.addHook('onClose', async () => { await host.close(); store.close() })
  return { app, store, host }
}
