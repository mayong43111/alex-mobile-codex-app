import { z } from 'zod'

export const decisionSchema = {
  type: 'object',
  properties: { reply: { type: 'string' }, action: { type: 'string', enum: ['chat', 'image', 'edit', 'video'] }, imagePrompt: { type: ['string', 'null'] } },
  required: ['reply', 'action', 'imagePrompt'], additionalProperties: false,
}

export function parseDecision(text, mode, hasSource = false) {
  const decision = z.object({ reply: z.string().min(1).max(20000), action: z.enum(['chat', 'image', 'edit', 'video']), imagePrompt: z.string().min(1).max(6000).nullable() }).strict().parse(JSON.parse(text))
  if (decision.action === 'video') return { action: 'video', reply: '视频生成暂未接入，当前不能生成视频。可以先讨论分镜或明确要求生成一张图片。', imagePrompt: null }
  if (mode === 'chat' || decision.action === 'chat') return { ...decision, action: 'chat', imagePrompt: null }
  if (decision.action === 'edit' && !hasSource) return { action: 'chat', reply: '当前对话中没有可修改的生成图，请先生成一张图片。', imagePrompt: null }
  if (!decision.imagePrompt) throw new Error('Image decision requires a prompt')
  return decision
}