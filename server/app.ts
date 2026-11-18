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
import { ModelCatalog, createAzureCredential } from './models.js'
import { Attachments } from './attachments.js'
import { ImageGeneration } from './image-generation.js'
import { imageLimits, permissionModes } from '../src/shared.js'

declare module 'fastify' {
  interface FastifyRequest { login?: Login }
}
export async function buildApp(config: Config, options: { agent?: Agent; store?: Store; models?: ModelCatalog; imageModels?: ModelCatalog; serveUi?: boolean; logger?: boolean } = {}) {
  const app = Fastify({ logger: options.logger ?? true, disableRequestLogging: true, bodyLimit: 32 * 1024, trustProxy: false })
  const store = options.store ?? await Store.open(config)
  const tools = new ToolRegistry(config.toolsFile)
  const credential = createAzureCredential(config)
  const models = options.models ?? new ModelCatalog(config, credential)
  const attachments = new Attachments(store, config.dataDir, config)
  const imageGeneration = new ImageGeneration(config, attachments, store, credential, fetch, options.imageModels)
  const host = new AgentHost(store, options.agent ?? new CopilotAgent(config, tools, credential, models, attachments, imageGeneration, config.sqlServer ? store.database : undefined), message => app.log.error(message), attachments)
  await host.initialize()
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
      reply.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'; form-action 'self'")
    }
    if (!request.url.startsWith('/api/')) return
    if (request.method !== 'GET' && request.headers.origin !== config.origin) throw new AppError(403, '请求来源无效')
    if (request.routeOptions.url === '/api/login' || request.routeOptions.url === '/api/health') return
    const token = request.cookies[cookieName]
    request.login = token ? await store.login(token) : undefined
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
  app.get('/api/health', async () => {
    await store.check()
    return { status: 'ok', protocol: 'AHP/1.1', modelConfigured: models.configured, storage: config.sqlServer ? 'azure-sql-blob' : 'local', revision: process.env.APP_REVISION, activeTurns: host.activeCount }
  })
  app.post('/api/login', async (request, reply) => {
    if (!limiter.attempt(request.ip)) throw new AppError(429, '登录尝试过多，请稍后再试')
    const input = credentialsSchema.parse(request.body)
    const user = await store.user(input.username)
    const valid = await checkPassword(input.password, user?.password ?? dummyPassword)
    if (!user || !valid) throw new AppError(401, '账号或密码不正确')
    const { token, login } = await store.createLogin(user)
    reply.setCookie(cookieName, token, { httpOnly: true, secure: config.secureCookie, sameSite: 'strict', path: '/', maxAge: 12 * 3600 })
    return { id: login.userId, username: login.username, csrf: login.csrf }
  })
  app.get('/api/me', async request => ({ id: request.login!.userId, username: request.login!.username, csrf: request.login!.csrf }))
  app.post('/api/logout', async (request, reply) => {
    await store.revokeLogin(request.login!.tokenHash)
    host.revoke(request.login!.tokenHash)
    reply.clearCookie(cookieName, { path: '/', secure: config.secureCookie, sameSite: 'strict' })
    return { ok: true }
  })
  app.get('/api/settings', async request => ({
    skills: await store.skills(request.login!.userId), tools: [...tools.publicTools(), await imageGeneration.publicTool(request.login!.userId)],
    model: { configured: models.configured, deployment: config.deployment, authMode: config.authMode },
    image: { configured: imageGeneration.configured, model: await imageGeneration.model(request.login!.userId) },
  }))
  app.get('/api/image-models', async request => imageGeneration.list(request.login!.userId))
  app.post('/api/image-models/refresh', async request => imageGeneration.list(request.login!.userId, true))
  app.put('/api/settings/image', async request => {
    const { model } = z.object({ model: z.string().min(1).max(200) }).strict().parse(request.body)
    return imageGeneration.choose(request.login!.userId, model)
  })
  app.get('/api/models', async () => models.list())
  app.post('/api/models/refresh', async () => models.list(true))
  app.addContentTypeParser(['image/jpeg', 'image/png', 'image/webp'], { parseAs: 'buffer', bodyLimit: imageLimits.uploadBytes }, (_request, body, done) => done(null, body))
  app.post('/api/attachments', { bodyLimit: imageLimits.uploadBytes }, async request => {
    const { name } = z.object({ name: z.string().min(1).max(180) }).strict().parse(request.query)
    if (!Buffer.isBuffer(request.body)) throw new AppError(415, '仅支持 JPEG、PNG 和 WebP 图片。')
    return attachments.save(request.login!.userId, request.body, name)
  })
  app.get('/api/attachments/:id', async (request, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params)
    const image = await attachments.read(request.login!.userId, id)
    return reply.type(image.info.mime).header('Content-Disposition', 'inline').send(image.data)
  })
  app.put('/api/settings/skills', async request => {
    const skills = z.object({ 'image-production': z.boolean(), 'video-production': z.boolean() }).strict().parse(request.body)
    await store.setSkills(request.login!.userId, skills)
    return { skills }
  })
  app.get('/api/conversations', async request => (await store.conversations(request.login!.userId)).map(conversation => store.summary(conversation)))
  app.post('/api/conversations', async request => {
    const { title, model, permissionMode } = z.object({
      title: z.string().trim().min(1).max(80).default('新对话'), model: z.string().min(1).max(200).optional(),
      permissionMode: z.enum(permissionModes).default('manual'),
    }).strict().parse(request.body)
    const selected = await models.select(model)
    return store.summary(await store.createConversation(request.login!.userId, title, selected?.id, permissionMode))
  })
  app.put('/api/conversations/:id/permissions', async request => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params)
    const { permissionMode } = z.object({ permissionMode: z.enum(permissionModes) }).strict().parse(request.body)
    const conversation = await store.updateConversation(request.login!.userId, id, conversation => {
      if (conversation.state.activeTurn) throw new AppError(409, '当前回复结束后才能切换权限。')
      conversation.permissionMode = permissionMode
    })
    return store.summary(conversation)
  })
  app.put('/api/conversations/:id/model', async request => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params)
    const userId = request.login!.userId
    await store.conversation(userId, id)
    const { model } = z.object({ model: z.string().min(1).max(200) }).strict().parse(request.body)
    const selected = await models.select(model)
    const conversation = await store.updateConversation(userId, id, conversation => {
      if (conversation.state.activeTurn) throw new AppError(409, '请等待当前回复结束或停止后再切换模型。')
      conversation.model = selected!.id
    })
    return store.summary(conversation)
  })
  app.get('/api/conversations/:id', async request => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params)
    return (await store.conversation(request.login!.userId, id)).state
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
      const vite = await createServer({
        server: {
          middlewareMode: true,
          hmr: { host: config.host, port: config.hmrPort, clientPort: config.hmrPort },
        },
        appType: 'spa',
      })
      app.setNotFoundHandler((request, reply) => {
        if (request.url.startsWith('/api/')) return reply.code(404).send({ error: '接口不存在' })
        reply.hijack()
        vite.middlewares(request.raw, reply.raw)
      })
      app.addHook('onClose', async () => vite.close())
    }
  }
  app.addHook('onClose', async () => { await host.close(); await store.close() })
  return { app, store, host, attachments }
}
