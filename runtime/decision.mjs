import { z } from 'zod'

export const decisionSchema = {
  type: 'object',
  properties: { reply: { type: 'string' }, action: { type: 'string', enum: ['chat', 'image', 'edit', 'video'] }, imagePrompt: { type: ['string', 'null'] }, videoPrompt: { type: ['string', 'null'] }, ratio: { type: ['string', 'null'], enum: ['1:1', '3:2', '2:3', '4:3', '3:4', '16:9', '9:16', null] }, quality: { type: ['string', 'null'], enum: ['low', 'medium', 'high', null] } },
  required: ['reply', 'action', 'imagePrompt', 'videoPrompt', 'ratio', 'quality', 'sourceAssetId'], additionalProperties: false,
}
decisionSchema.properties.sourceAssetId = { type: ['string', 'null'], description: 'For edit, the exact assetId chosen from the available image candidates; otherwise null.' }
decisionSchema.properties.size = { type: ['string', 'null'], description: 'Explicit requested image output pixels as WIDTHxHEIGHT, e.g. 2048x1152. Null when only an aspect ratio is requested or no size is specified. Never silently round or replace an unsupported explicit size.' }
decisionSchema.required.push('size')

export function parseDecision(text, mode, candidateIds = [], videoEnabled = false) {
  const decision = z.object({ reply: z.string().min(1).max(20000), action: z.enum(['chat', 'image', 'edit', 'video']), sourceAssetId: z.string().uuid().nullable().default(null), imagePrompt: z.string().min(1).max(6000).nullable(), videoPrompt: z.string().min(1).max(6000).nullable().default(null), size: z.string().regex(/^[1-9][0-9]{0,4}x[1-9][0-9]{0,4}$/).nullable().optional(), ratio: z.enum(['1:1', '3:2', '2:3', '4:3', '3:4', '16:9', '9:16']).nullable().optional(), quality: z.enum(['low', 'medium', 'high']).nullable().optional() }).strict().parse(JSON.parse(text))
  if (mode === 'chat' || decision.action === 'chat') return { ...decision, action: 'chat', imagePrompt: null, videoPrompt: null, sourceAssetId: null }
  if (decision.action === 'edit') {
    if (!decision.sourceAssetId || !candidateIds.includes(decision.sourceAssetId)) throw new Error('Codex must select an allowed sourceAssetId for editing; no fallback image was selected')
  } else if (decision.sourceAssetId !== null) throw new Error('Only edit decisions may select a sourceAssetId')
  if (decision.action === 'video') {
    if (!videoEnabled) return { action: 'video', reply: '视频生成暂未接入，当前不能生成视频。可以先讨论分镜或明确要求生成一张图片。', imagePrompt: null, videoPrompt: null }
    if (!decision.videoPrompt) throw new Error('Video decision requires a prompt')
    return { ...decision, imagePrompt: null }
  }
  if (!decision.imagePrompt) throw new Error('Image decision requires a prompt')
  return { ...decision, videoPrompt: null }
}

export function renderSettings(decision, defaults) {
  const ratio = decision.ratio ?? defaults.ratio
  const quality = decision.quality ?? defaults.quality ?? 'low'
  return { ratio, quality }
}

function validImageSize(size, model) {
  if (!/^[1-9][0-9]{0,4}x[1-9][0-9]{0,4}$/.test(size)) return false
  const [width, height] = size.split('x').map(Number)
  if (model === 'azure-image2') return width % 16 === 0 && height % 16 === 0 && Math.max(width, height) <= 3840 && Math.max(width, height) <= 3 * Math.min(width, height) && width * height >= 655360 && width * height <= 8294400
  return width % 32 === 0 && height % 32 === 0 && width * height <= 4194304
}

export function editOutputSize(source, model) {
  const size = `${source.width}x${source.height}`
  return model === 'azure-image2' && !validImageSize(size, model) ? 'auto' : size
}

export function imageOutputSize(decision, defaults, source) {
  if (decision.action === 'edit' && !decision.size && !decision.ratio) return editOutputSize(source, defaults.imageModel)
  const ratio = decision.ratio ?? defaults.ratio
  const size = decision.size ?? ({ '1:1': '1024x1024', '3:2': '1536x1024', '2:3': '1024x1536', '4:3': '1280x960', '3:4': '960x1280', '16:9': '1536x864', '9:16': '864x1536' })[ratio]
  if (!validImageSize(size, defaults.imageModel)) throw new Error(`当前模型不支持输出尺寸 ${size}；未发送图片请求，不会替换为默认尺寸。`)
  if (decision.size && decision.ratio) {
    const [width, height] = size.split('x').map(Number)
    const [horizontal, vertical] = decision.ratio.split(':').map(Number)
    if (width * vertical !== height * horizontal) throw new Error('指定像素尺寸与比例冲突；未发送图片请求，请确认尺寸。')
  }
  return size
}