export const skillIds = ['image-production', 'video-production'] as const
export type SkillId = typeof skillIds[number]
export type SkillChoices = Record<SkillId, boolean>
export const defaultSkills: SkillChoices = {
  'image-production': true,
  'video-production': true,
}
export const skillCatalog = [
  { id: 'image-production', name: '图片创作', description: '生成、编辑与提示词；执行需要配置图片工具。' },
  { id: 'video-production', name: '视频创作', description: '短片、分镜与口播；执行需要配置视频工具。' },
] as const
export const shortcuts: { label: string; icon: string; skill?: SkillId; prompt: string }[] = [
  { label: '自由对话', icon: '✦', prompt: '' },
  { label: '创作图片', icon: '▧', skill: 'image-production', prompt: '请帮我创作一张图片。先和我确认画面内容、风格和比例；未经确认不要调用生成工具。' },
  { label: '图片提示词', icon: '✎', skill: 'image-production', prompt: '请帮我写一份图片提示词。先询问我的想法，只写提示词，不生成图片。' },
  { label: '视频分镜', icon: '▷', skill: 'video-production', prompt: '请帮我规划一个视频的脚本和分镜。先确认主题、时长和画幅，只做规划，不提交生成任务。' },
  { label: '数字人口播', icon: '◉', skill: 'video-production', prompt: '请帮我准备一段数字人口播。先确认文案、人物来源和声音，只做准备，不提交生成任务。' },
]
export interface ConversationSummary {
  id: string
  title: string
  session: string
  chat: string
  updatedAt: string
}
export interface UserInfo { id: string; username: string; csrf: string }
export interface PublicTool { id: string; label: string; skill: SkillId; tools: string[]; configured: boolean }
export interface Settings {
  skills: SkillChoices
  tools: PublicTool[]
  model: { configured: boolean; deployment: string; authMode: string }
}
