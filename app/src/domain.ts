export type Ratio = '1:1' | '4:3' | '3:4' | '16:9' | '3:2' | '2:3'
export type Project = { id: string; title: string; createdAt: string; updatedAt: string }
export type Asset = {
  id: string; projectId: string; name: string; width: number; height: number
  createdAt: string; hash: string; bytes: number; kind: 'reference' | 'generated'
  model?: string; provider?: string; runId?: string
  sourceAssetId?: string; sourceHash?: string
}
export type Message = {
  id: string; projectId: string; text: string; assetIds: string[]; createdAt: string
  role?: 'user' | 'assistant'
}
export type Job = {
  id: string; projectId: string; messageId: string; prompt: string; assetIds: string[]
  ratio: Ratio; status: 'waiting_service' | 'cancelled'; createdAt: string; updatedAt: string
}
export type AgentInput = { requestId: string; text: string; mode: 'auto' | 'chat' | 'image'; ratio: Ratio }
export type AgentProgress = { id: string; label: string; detail?: string; createdAt: string }
export type AgentRun = {
  id: string; projectId: string; messageId: string; assistantId: string; input: AgentInput
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'
  stage: 'codex' | 'image'; reply: string; threadId: string | null; error?: string
  imageOperation?: 'generate' | 'edit'; sourceAssetId?: string
  assetId?: string; progress?: AgentProgress[]; createdAt: string; updatedAt: string
}
export type Snapshot = { project: Project; messages: Message[]; assets: Asset[]; jobs: Job[]; runs: AgentRun[]; threadId: string | null }
export type Submission = { requestId: string; text: string; assetIds: string[]; ratio: Ratio }