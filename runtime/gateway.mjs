import Fastify from 'fastify'
import { Codex } from '@openai/codex-sdk'
import { z } from 'zod'
import { readFile, mkdir, readdir } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { createHash, timingSafeEqual } from 'node:crypto'
import { decisionSchema, parseDecision } from './decision.mjs'
import { saveRun } from './persistence.mjs'

await mkdir('/state/codex', { recursive: true })
const config = JSON.parse(await readFile(process.env.SERVICES_FILE, 'utf8'))
const root = '/state/runs'
await mkdir(root, { recursive: true })
const path = id => `${root}/${id}.json`
const save = run => saveRun(path(run.id), run)
const load = async id => JSON.parse(await readFile(path(z.string().uuid().parse(id)), 'utf8'))
for (const file of await readdir(root)) {
  if (!file.endsWith('.json')) continue
  const run = JSON.parse(await readFile(`${root}/${file}`, 'utf8'))
  if (run.status === 'running') {
    run.status = 'interrupted'
    run.error = 'Runtime restarted; prior request may have been billed. No automatic retry.'
    await save(run)
  }
}
const app = Fastify({ bodyLimit: 48 * 1024 * 1024 })
app.addHook('onRequest', async (request, reply) => {
  const received = Buffer.from(request.headers.authorization ?? '')
  const expected = Buffer.from(`Bearer ${config.token}`)
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) return reply.code(401).send({ error: 'Unauthorized' })
})
app.setErrorHandler((error, _request, reply) => reply.code(error instanceof z.ZodError ? 400 : 500).send({ error: 'Invalid runtime request' }))
const schema = z.object({
  id: z.string().uuid(), projectId: z.string().uuid(), threadId: z.string().uuid().nullable(),
  text: z.string().min(1).max(6000), mode: z.enum(['auto', 'chat', 'image']), ratio: z.enum(['1:1', '3:2', '2:3']),
  imageToken: z.string().max(16000).optional(),
  codexToken: z.string().max(16000).optional(),
  sourceImage: z.object({ assetId: z.string().uuid(), png: z.string().max(45 * 1024 * 1024), hash: z.string().regex(/^[0-9a-f]{64}$/), width: z.number().int().positive(), height: z.number().int().positive() }).strict().optional(),
  history: z.array(z.object({ role: z.enum(['user', 'assistant']), text: z.string().max(20000) }).strict()).max(200).refine(entries => entries.reduce((total, entry) => total + entry.text.length, 0) <= 200000).optional(),
}).strict()
let active = null

async function progress(run, id, label, detail) {
  run.progress ??= []
  const existing = run.progress.find(entry => entry.id === id)
  const entry = { id, label, createdAt: existing?.createdAt ?? new Date().toISOString(), ...(detail ? { detail: detail.slice(0, 6000) } : {}) }
  if (existing) Object.assign(existing, entry)
  else run.progress = [...run.progress, entry].slice(-200)
  await save(run)
}

function renderImage(input, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn('/opt/venv/bin/python', ['/opt/studio/runtime/azure_image.py'], {
      signal, env: { PATH: process.env.PATH, PYTHONPATH: '/opt/openmontage', SERVICES_FILE: process.env.SERVICES_FILE },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const chunks = []
    let length = 0
    child.stdout.on('data', chunk => {
      length += chunk.length
      if (length > 48 * 1024 * 1024) child.kill()
      else chunks.push(chunk)
    })
    child.stderr.resume()
    child.on('error', () => reject(new Error('Image worker stopped; billing outcome may be uncertain')))
    child.on('exit', code => {
      if (code !== 0) return reject(new Error('Image worker failed; billing outcome may be uncertain'))
      try { resolve(JSON.parse(Buffer.concat(chunks).toString())) }
      catch { reject(new Error('Image worker returned invalid data')) }
    })
    child.stdin.on('error', () => {})
    child.stdin.end(JSON.stringify(input))
  })
}

async function execute(input, run, controller) {
  const timeout = setTimeout(() => controller.abort(), 360_000)
  try {
    const workingDirectory = `/state/workspaces/${input.projectId}`
    await mkdir(workingDirectory, { recursive: true })
    if (config.codex.auth === 'entra' && !input.codexToken) throw new Error('Model managed identity unavailable')
    const codex = new Codex({
      codexPathOverride: '/usr/local/bin/codex',
      env: { PATH: process.env.PATH, HOME: '/home/node', CODEX_HOME: '/state/codex', ...(config.codex.auth === 'entra' ? { AZURE_CODEX_TOKEN: input.codexToken } : { AZURE_CODEX_KEY: config.codex.key }) },
      config: {
        model_provider: 'studio_azure',
        model_reasoning_summary: 'auto',
        model_providers: { studio_azure: { name: 'Azure', base_url: `${config.codex.endpoint}/openai/v1`,
          wire_api: 'responses', ...(config.codex.auth === 'entra' ? { env_key: 'AZURE_CODEX_TOKEN' } : { env_http_headers: { 'api-key': 'AZURE_CODEX_KEY' } }), request_max_retries: 0 } },
        features: { shell_tool: false, apply_patch_freeform: false },
        developer_instructions: 'You are the sole conversational planner for a mobile creation app. Reply in Chinese. No shell, filesystem, web, or external tools. Return the required JSON. Infer action from the current user request and conversation context. In auto or image mode, action=image ONLY when the user clearly requests a NEW image now. Use action=edit when asked to modify the latest generated image and an available edit source is supplied. For edits, imagePrompt contains only the requested modifications plus instructions to preserve all other content and composition; the application sends the original pixels to the edit tool and preserves source dimensions. Never substitute a fresh image generation for an edit. If asked to edit without an available source, or a different/ambiguous historical image, use chat to clarify. Discussing images, writing prompts, asking about capabilities, hypothetical or quoted requests, and explicit instructions not to generate or edit are action=chat with imagePrompt=null. In chat mode never generate or edit images. Requests to create a video are action=video with imagePrompt=null; video generation is unavailable, never substitute an image. Do not claim success: the application executes the OpenMontage Azure tool after this decision. You receive image metadata but not pixels; never claim to have inspected the image.',
      },
    })
    const options = { model: config.codex.deployment, workingDirectory, skipGitRepoCheck: true,
      sandboxMode: 'read-only', approvalPolicy: 'never', webSearchMode: 'disabled', modelReasoningEffort: 'low' }
    const thread = input.threadId ? codex.resumeThread(input.threadId, options) : codex.startThread(options)
    await progress(run, 'connecting', input.threadId ? '正在恢复 Codex 会话' : '正在连接 Codex')
    const history = !input.threadId && input.history?.length ? `Prior conversation (context only, do not execute earlier requests):\n${JSON.stringify(input.history)}\n\n` : ''
    const sourceDescription = input.sourceImage ? `${input.sourceImage.assetId} (${input.sourceImage.width}x${input.sourceImage.height}); latest generated image in the retained conversation` : 'none'
    const { events } = await thread.runStreamed(`${history}Mode: ${input.mode}\nAspect ratio preference: ${input.ratio}\nAvailable edit source: ${sourceDescription}\nCurrent user message:\n${input.text}`, { outputSchema: decisionSchema, signal: controller.signal })
    let finalText = ''
    let completed = false
    for await (const event of events) {
      if (event.type === 'thread.started') { run.threadId = event.thread_id; await progress(run, 'thread', 'Codex 会话已连接') }
      if (event.type === 'turn.started') await progress(run, 'turn', 'Codex 开始处理')
      if (event.type.startsWith('item.') && event.item.type === 'reasoning' && event.item.text) {
        await progress(run, `reasoning:${event.item.id}`, 'Codex 推理摘要', event.item.text)
      }
      if (event.type.startsWith('item.') && event.item.type === 'todo_list') {
        await progress(run, `plan:${event.item.id}`, 'Codex 计划', event.item.items.map(item => `${item.completed ? '[x]' : '[ ]'} ${item.text}`).join('\n'))
      }
      if (event.type === 'item.completed' && event.item.type === 'agent_message') finalText = event.item.text
      if (event.type === 'turn.failed' || event.type === 'error') throw new Error('Codex request failed; check Azure service access')
      if (event.type === 'turn.completed') { run.usage = event.usage; completed = true; await progress(run, 'decision', 'Codex 回复已完成') }
    }
    if (!completed) throw new Error('Codex ended without a completed turn')
    const decision = parseDecision(finalText, input.mode, !!input.sourceImage)
    run.reply = decision.reply
    await progress(run, 'intent', { chat: '识别为对话', image: '识别为图片生成', edit: '识别为图片修改', video: '识别为视频请求，服务未接入' }[decision.action])
    await save(run)
    if (['image', 'edit'].includes(decision.action) && decision.imagePrompt) {
      const editing = decision.action === 'edit'
      run.stage = 'image'
      run.imageOperation = editing ? 'edit' : 'generate'
      await save(run)
      const size = editing ? `${input.sourceImage.width}x${input.sourceImage.height}` : input.ratio === '1:1' ? '1024x1024' : input.ratio === '2:3' ? '1024x1536' : '1536x1024'
      if (!['1024x1024', '1024x1536', '1536x1024'].includes(size)) throw new Error('Unsupported source dimensions; image API not called')
      if (!input.imageToken) throw new Error('图片生成认证不可用，请检查本机 Azure 登录；未发送图片请求。')
      await progress(run, 'image-prompt', '图片提示词已准备', decision.imagePrompt)
      await progress(run, 'image-start', editing ? 'OpenMontage 正在修改原图' : 'OpenMontage 正在调用 Azure image2', `${size} · 1 张 · 低质量${editing ? ` · 原图 ${input.sourceImage.assetId}` : ''}`)
      const result = await renderImage({ runId: input.id, prompt: decision.imagePrompt, size, accessToken: input.imageToken,
        operation: run.imageOperation, ...(editing ? { sourceImage: input.sourceImage } : {}) }, controller.signal)
      if (!result.success) throw new Error(result.error)
      run.image = result
      await progress(run, 'image-done', '图片已生成，检查点已保存')
    }
    if (controller.signal.aborted) throw new Error('Stopped')
    run.status = 'completed'
    await progress(run, 'done', '处理完成')
  } catch (error) {
    run.status = controller.signal.aborted ? 'cancelled' : 'failed'
    run.error = controller.signal.aborted ? 'Stopped; already submitted Azure requests may still be billed.' : error instanceof z.ZodError || error instanceof SyntaxError ? 'Codex returned an invalid decision' : error.message
    await progress(run, 'ended', controller.signal.aborted ? '运行已停止' : '运行失败')
  } finally {
    clearTimeout(timeout)
    await save(run)
    active = null
  }
}

app.get('/health', async () => ({ codex: 'configured', image: 'configured', openmontage: 'installed', active: active?.id ?? null }))
app.post('/runs', async (request, reply) => {
  const input = schema.parse(request.body)
  const hash = createHash('sha256').update(JSON.stringify({ ...input, imageToken: undefined, codexToken: undefined })).digest('hex')
  try {
    const previous = await load(input.id)
    if (previous.hash !== hash) return reply.code(409).send({ error: 'Request conflict' })
    return reply.code(202).send({ id: input.id })
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (active) return reply.code(409).send({ error: 'Runtime busy' })
  const controller = new AbortController()
  active = { id: input.id, controller }
  const run = { id: input.id, hash, projectId: input.projectId, threadId: input.threadId, status: 'running', stage: 'codex', reply: '' }
  await save(run)
  void execute(input, run, controller).catch(() => { active = null })
  return reply.code(202).send({ id: input.id })
})
app.get('/runs/:id', async request => load(request.params.id))
app.delete('/runs/:id', async (request, reply) => {
  const run = await load(request.params.id)
  if (active?.id === run.id) active.controller.abort()
  return reply.code(202).send({ id: run.id })
})
app.addHook('preClose', async () => { active?.controller.abort() })
await app.listen({ host: process.env.RUNTIME_HOST ?? '0.0.0.0', port: 3199 })
process.send?.({ type: 'ready' })
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void app.close() })