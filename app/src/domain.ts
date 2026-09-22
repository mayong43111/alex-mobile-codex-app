export type Ratio = '1:1' | '4:3' | '3:4' | '16:9' | '9:16' | '3:2' | '2:3'
export type Quality = 'low' | 'medium' | 'high'
export type ImageModel = 'azure-image2' | 'qwen-image-2.1'
export type VideoModel = 'none' | 'minimax-h3'
export type Project = { id: string; title: string; createdAt: string; updatedAt: string }
export type Asset = {
  id: string; projectId: string; name: string; width: number; height: number
  createdAt: string; hash: string; bytes: number; kind: 'reference' | 'generated'
  model?: string; provider?: string; runId?: string
  sourceAssetId?: string; sourceHash?: string
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
export type AgentInput = { requestId: string; text: string; assetIds?: string[]; mode: 'auto' | 'chat' | 'image'; ratio: Ratio; quality?: Quality; imageModel?: ImageModel; videoModel?: VideoModel }
export type AgentProgress = { id: string; label: string; detail?: string; createdAt: string }
export type AgentRun = {
  id: string; projectId: string; messageId: string; assistantId: string; input: AgentInput
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'
  stage: 'codex' | 'image' | 'video'; reply: string; threadId: string | null; error?: string
  imageOperation?: 'generate' | 'edit'; sourceAssetId?: string
  assetId?: string; progress?: AgentProgress[]; createdAt: string; updatedAt: string
}
export type Snapshot = { project: Project; messages: Message[]; assets: Asset[]; jobs: Job[]; runs: AgentRun[]; threadId: string | null }
export type Submission = { requestId: string; text: string; assetIds: string[]; ratio: Ratio }