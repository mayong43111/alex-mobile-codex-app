import { defineTool } from '@microsoft/copilot-sdk'
import { z } from 'zod'
import { imageLimits } from '../src/shared.js'
import type { AttachmentInfo, PublicTool } from '../src/shared.js'
import type { AgentRequest } from './agent.js'
import type { Config } from './config.js'
import { createAzureCredential, ModelCatalog } from './models.js'
import type { AzureCredential } from './models.js'
import { Attachments } from './attachments.js'
import { Store, hash } from './store.js'
import { AppError } from './errors.js'

const parameters = z.object({
  prompt: z.string().trim().min(1).max(12000),
  model: z.string().optional(),
  size: z.string().regex(/^\d{3,4}x\d{3,4}$/).default('1024x1024').refine(value => {
    const [width, height] = value.split('x').map(Number)
    return width >= 256 && height >= 256 && width <= 3840 && height <= 3840
      && width % 16 === 0 && height % 16 === 0 && width / height <= 3 && height / width <= 3 && width * height <= 3840 * 2160
  }, 'Unsupported image dimensions'),
  quality: z.enum(['auto', 'low', 'medium', 'high']).default('auto'),
  reference_image_ids: z.array(z.uuid()).max(imageLimits.maxAttachments).optional(),
}).strict()

export class ImageGeneration {
  constructor(
    private config: Config, private attachments: Attachments, private store: Store,
    private credential: AzureCredential = createAzureCredential(config),
    private request: typeof fetch = fetch,
    private catalog = new ModelCatalog(config, credential, fetch, 'image'),
  ) {}
  get configured() { return Boolean(this.config.imageEndpoint && this.config.imageDeployment) }
  async model(userId: string) { return await this.store.imageModel(userId) ?? this.config.imageDeployment }
  async list(userId: string, refresh = false) {
    return { ...await this.catalog.list(refresh), selectedModel: await this.model(userId) || undefined }
  }
  async choose(userId: string, model: string) {
    const selected = await this.catalog.select(model)
    if (!selected) throw new AppError(503, '图片工具未配置。')
    await this.store.setImageModel(userId, selected.id)
    return { model: selected.id }
  }
  async publicTool(userId: string): Promise<PublicTool> {
    return { id: 'image_generation', label: await this.model(userId) || 'image_generation', skill: 'image-production', tools: ['image_generation'], configured: this.configured }
  }
  async definition(turn: AgentRequest) {
    const deployment = await this.model(turn.conversation.userId)
    return defineTool('image_generation', {
      title: `image_generation · ${deployment}`,
      description: `Generate or edit an image using the selected ${deployment} deployment. Use only after an explicit user request to generate/edit. Attached images are used as references by default. Returns a saved private image; never retry failed or unknown submissions automatically.`,
      parameters, defer: 'never',
      handler: async (raw, invocation) => {
        const key = `${invocation.sessionId}:${invocation.toolCallId}`
        const userId = turn.conversation.userId
        let submitted = false
        let began = false
        try {
          const input = parameters.parse(raw)
          if (!this.configured || !turn.skills['image-production']) throw new AppError(403, '图片工具未启用或未配置。')
          if (input.model && input.model !== deployment) throw new AppError(400, '指定模型与图片工具设置不一致，未调用替代模型。')
          const ids = input.reference_image_ids ?? turn.attachments?.map(image => image.id) ?? []
          if (new Set(ids).size !== ids.length) throw new AppError(400, '参考图片不能重复。')
          const images = await Promise.all(ids.map(id => this.attachments.read(userId, id)))
          const fingerprint = hash(JSON.stringify({ ...input, reference_image_ids: ids, model: deployment }))
          const existing = await this.store.imageJob(userId, key)
          const output = (image: AttachmentInfo) => {
            turn.emit({ type: 'image', id: image.id, url: image.url })
            return { resultType: 'success' as const, textResultForLlm: JSON.stringify({
              status: 'completed', attachmentId: image.id, model: deployment,
              width: image.width, height: image.height, displayed: true,
            }) }
          }
          if (existing) {
            if (existing.fingerprint !== fingerprint) throw new AppError(409, '生图操作编号已被其他内容使用。')
            if (existing.status === 'completed' && existing.attachmentId) return output(await this.attachments.info(userId, existing.attachmentId))
            throw new AppError(409, '此生图请求已提交或已结束，未重复调用；请先核对结果和计费。')
          }
          await this.catalog.select(deployment)
          const approved = await turn.approve(invocation.toolCallId, 'image_generation', JSON.stringify({
            model: deployment, prompt: input.prompt, size: input.size, quality: input.quality, reference_image_ids: ids,
          }))
          if (!approved) return { resultType: 'rejected', textResultForLlm: '用户拒绝了本次图片生成，未调用图片服务。' }
          turn.signal.throwIfAborted()
          if (!await this.store.claimImageJob(userId, key, { fingerprint, status: 'running' })) throw new AppError(409, '生图请求已提交，未重复调用。')
          began = true
          let token: Awaited<ReturnType<AzureCredential['getToken']>>
          try { token = await this.credential.getToken(this.config.tokenScope) }
          catch { throw new AppError(503, '无法获取图片模型的 Azure 身份，请检查登录态和资源权限。') }
          if (!token?.token) throw new AppError(503, 'Azure 身份未返回图片模型访问令牌。')
          let body: BodyInit
          const headers: Record<string, string> = { Authorization: `Bearer ${token.token}` }
          if (images.length) {
            const form = new FormData()
            form.set('model', deployment)
            form.set('prompt', input.prompt)
            form.set('n', '1')
            form.set('size', input.size)
            form.set('quality', input.quality)
            form.set('output_format', 'png')
            for (const image of images) form.append('image[]', new Blob([new Uint8Array(image.data)], { type: image.info.mime }), `${image.info.id}.${image.info.mime.split('/')[1]}`)
            body = form
          } else {
            headers['Content-Type'] = 'application/json'
            body = JSON.stringify({ model: deployment, prompt: input.prompt, n: 1, size: input.size, quality: input.quality, output_format: 'png' })
          }
          turn.signal.throwIfAborted()
          await this.store.check()
          submitted = true
          const response = await this.request(new URL(images.length ? 'images/edits' : 'images/generations', this.config.imageEndpoint), {
            method: 'POST', headers, body, redirect: 'error',
            signal: AbortSignal.any([turn.signal, AbortSignal.timeout(150_000)]),
          })
          if (!response.ok) {
            await response.body?.cancel()
            throw new AppError(502, `图片服务请求失败（HTTP ${response.status}），未自动重试；请先核对计费。`)
          }
          if (!response.body) throw new AppError(502, '图片服务未返回结果，请先核对计费。')
          const reader = response.body.getReader()
          const chunks: Uint8Array[] = []
          let length = 0
          try {
            while (true) {
              const { done, value } = await reader.read()
              if (done) break
              length += value.byteLength
              if (length > 28 * 1024 * 1024) { await reader.cancel(); throw new AppError(502, '图片服务返回内容过大，请先核对计费。') }
              chunks.push(value)
            }
          } finally { reader.releaseLock() }
          const parsed = z.object({ data: z.array(z.object({ b64_json: z.string().min(1) })).length(1) }).safeParse(JSON.parse(Buffer.concat(chunks).toString('utf8')))
          if (!parsed.success) throw new AppError(502, '图片服务未返回可保存的图片，请先核对计费。')
          const data = Buffer.from(parsed.data.data[0].b64_json, 'base64')
          const image = await this.attachments.save(userId, data, `generated-${invocation.toolCallId.slice(0, 40)}.png`, 'generated')
          await this.store.saveImageJob(userId, key, { fingerprint, status: 'completed', attachmentId: image.id })
          return output(image)
        } catch (error) {
          const message = error instanceof AppError ? error.message
            : submitted ? '图片生成状态未知，可能已计费；未自动重试，请先核对结果。' : '图片工具调用失败，未提交生成。'
          if (began) {
            const job = (await this.store.imageJob(userId, key))!
            if (job.status !== 'completed') await this.store.saveImageJob(userId, key, { ...job, status: submitted ? 'unknown' : 'failed' })
          }
          turn.emit({ type: 'error', message })
          return { resultType: 'failure', textResultForLlm: message, error: message }
        }
      },
    })
  }
}
