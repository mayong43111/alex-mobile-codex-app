import { z } from 'zod'

export const decisionSchema = {
  type: 'object',
  properties: { reply: { type: 'string' }, action: { type: 'string', enum: ['chat', 'image', 'edit', 'video'] }, imagePrompt: { type: ['string', 'null'] }, videoPrompt: { type: ['string', 'null'] }, ratio: { type: ['string', 'null'], enum: ['1:1', '3:2', '2:3', '4:3', '3:4', '16:9', '9:16', null] }, quality: { type: ['string', 'null'], enum: ['low', 'medium', 'high', null] } },
  required: ['reply', 'action', 'imagePrompt', 'videoPrompt', 'ratio', 'quality', 'sourceAssetId'], additionalProperties: false,
}
decisionSchema.properties.sourceAssetId = { type: ['string', 'null'], description: 'For edit, the exact assetId chosen from the available image candidates; otherwise null.' }

export function parseDecision(text, mode, candidateIds = [], videoEnabled = false) {
  const decision = z.object({ reply: z.string().min(1).max(20000), action: z.enum(['chat', 'image', 'edit', 'video']), sourceAssetId: z.string().uuid().nullable().default(null), imagePrompt: z.string().min(1).max(6000).nullable(), videoPrompt: z.string().min(1).max(6000).nullable().default(null), ratio: z.enum(['1:1', '3:2', '2:3', '4:3', '3:4', '16:9', '9:16']).nullable().optional(), quality: z.enum(['low', 'medium', 'high']).nullable().optional() }).strict().parse(JSON.parse(text))
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
  if (decision.action === 'image' && defaults.imageModel === 'azure-image2' && !['1:1', '3:2', '2:3'].includes(ratio)) throw new Error('Azure image2 当前仅支持 1:1、3:2、2:3；未发送生成请求，请调整比例或选择 Qwen。')
  return { ratio, quality }
}