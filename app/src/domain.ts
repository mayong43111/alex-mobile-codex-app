export const ratios = ['auto', '1:1', '3:2', '2:3', '4:3', '3:4', '16:9', '9:16'] as const
export type Ratio = typeof ratios[number]
export type Quality = 'low' | 'medium' | 'high'
export const imageModels = ['azure-image2', 'gpt-image-2.5-flare', 'gpt-image-2.5-sunburst', 'qwen-image-2.1', 'qwen-image-2.1-t4', 'qwen-image-2.1-t4-turbo'] as const
export type ImageModel = typeof imageModels[number]
export const imageModelNames: Record<ImageModel, string> = { 'azure-image2': 'GPT Image 2', 'gpt-image-2.5-flare': 'GPT Image 2.5 Flare', 'gpt-image-2.5-sunburst': 'GPT Image 2.5 Sunburst', 'qwen-image-2.1': 'Qwen Image 2.1', 'qwen-image-2.1-t4': 'Qwen Image 2.1 T4', 'qwen-image-2.1-t4-turbo': 'Qwen Image 2.1 Turbo T4' }
export const isAzureImageModel = (model: ImageModel) => !model.startsWith('qwen-image-')
export type UserSettings = { ratio: Ratio; quality: Quality; imageModel: ImageModel; videoModel: VideoModel }
export const defaultUserSettings: UserSettings = { ratio: '1:1', quality: 'low', imageModel: 'gpt-image-2.5-flare', videoModel: 'none' }
export type VideoModel = 'none' | 'minimax-h3'
export type Project = { id: string; title: string; createdAt: string; updatedAt: string }
export type Asset = {
  id: string; projectId: string; name: string; width: number; height: number
  createdAt: string; hash: string; bytes: number; kind: 'reference' | 'generated'
  model?: string; provider?: string; runId?: string
  sourceAssetId?: string; sourceHash?: string
  narration?: string; frameSeconds?: number
  mediaType?: 'image' | 'video' | 'file'; duration?: number; fps?: number
  mimeType?: string; storageExtension?: 'png' | 'mp4' | 'bin'; hasThumbnail?: boolean
}
export const assetExtension = (asset: Pick<Asset, 'mediaType' | 'storageExtension'>) => asset.storageExtension ?? (asset.mediaType === 'file' ? 'bin' : asset.mediaType === 'video' ? 'mp4' : 'png')
export const assetHasThumbnail = (asset: Pick<Asset, 'mediaType' | 'hasThumbnail'>) => asset.hasThumbnail ?? asset.mediaType !== 'file'
export const assetContentType = (asset: Pick<Asset, 'mediaType' | 'mimeType'>) => asset.mimeType ?? (asset.mediaType === 'file' ? 'application/octet-stream' : asset.mediaType === 'video' ? 'video/mp4' : 'image/png')
export type Message = {
  id: string; projectId: string; text: string; assetIds: string[]; createdAt: string
  role?: 'user' | 'assistant'
}
export type Job = {
  id: string; projectId: string; messageId: string; prompt: string; assetIds: string[]
  ratio: Ratio; status: 'waiting_service' | 'cancelled'; createdAt: string; updatedAt: string
}
export type DirectImage = { operation: 'generate' } | { operation: 'edit'; sourceAssetId: string }
export type AgentInput = { requestId: string; text: string; assetIds?: string[]; mode: 'auto' | 'chat' | 'image'; ratio: Ratio; quality?: Quality; imageModel?: ImageModel; videoModel?: VideoModel; directImage?: DirectImage }
export type AgentProgress = { id: string; label: string; detail?: string; createdAt: string }
export type NarrationProgress = { phase: 'script' | 'speech' | 'queued' | 'rendering' | 'tail' | 'stitching' | 'completed' | 'stopped'; segment: number; updatedAt: string }
export type NarrationState = { segments: { text: string; continueFromPrevious: boolean }[]; progress?: NarrationProgress; stopRequested?: boolean; scriptAssetId?: string }
export type StoryState = { title: string; segments: { text: string; prompt: string }[]; clipIds: string[]; phase: 'script' | 'rendering' | 'stitching' | 'completed' | 'stopped'; segment: number; stopRequested?: boolean; scriptAssetId?: string }
export type AgentRun = {
  id: string; projectId: string; messageId: string; assistantId: string; input: AgentInput
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'
  stage: 'codex' | 'image' | 'video'; reply: string; threadId: string | null; error?: string
  imageOperation?: 'generate' | 'edit'; sourceAssetId?: string
  assetId?: string; processedAssetIds?: string[]; progress?: AgentProgress[]; createdAt: string; updatedAt: string
  avatarJobId?: string
  narration?: NarrationState
  story?: StoryState
}
export type Snapshot = { project: Project; messages: Message[]; assets: Asset[]; jobs: Job[]; runs: AgentRun[]; threadId: string | null; page?: { before: string | null; tailId: string | null } }
export type Submission = { requestId: string; text: string; assetIds: string[]; ratio: Ratio }