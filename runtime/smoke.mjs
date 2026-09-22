import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createHash } from 'node:crypto'

const base = 'http://127.0.0.1:3188/api'
const models = { imageModel: process.env.IMAGE_MODEL ?? 'azure-image2', videoModel: process.env.VIDEO_MODEL ?? 'none' }
if (process.env.WEB_SEARCH_TEST === '1' && ['EDIT_TEST', 'IMAGE_TEST', 'AUTO_TEST'].some(name => process.env[name] === '1')) throw new Error('Web search verification must run in chat mode without image tests')
const request = async (path, body) => {
  const response = await fetch(base + path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {})
  assert(response.ok, `HTTP ${response.status}`)
  return response.json()
}
if (process.env.EDIT_TEST === '1') {
  const project = process.env.PROJECT_ID ? { id: process.env.PROJECT_ID } : await request('/projects', { title: '原图编辑本地验收' })
  async function turn(text) {
    const run = await request(`/projects/${project.id}/chat`, { requestId: randomUUID(), text, mode: 'auto', ratio: '1:1', ...models })
    console.log(JSON.stringify({ projectId: project.id, runId: run.id, submitted: true }))
    const stream = await fetch(`${base}/projects/${project.id}/events`, { signal: AbortSignal.timeout(420000) })
    const reader = stream.body.getReader()
    try {
      while (true) {
        const snapshot = await request(`/projects/${project.id}`)
        const current = snapshot.runs.find(item => item.id === run.id)
        if (!['queued', 'running'].includes(current.status)) {
          console.log(JSON.stringify({ runId: run.id, status: current.status, operation: current.imageOperation, error: current.error }))
          assert.equal(current.status, 'completed')
          assert(current.assetId, 'No output image')
          return { run: current, asset: snapshot.assets.find(asset => asset.id === current.assetId) }
        }
        if ((await reader.read()).done) throw new Error('SSE closed before completion')
      }
    } finally { await reader.cancel() }
  }
  async function imageBytes(id) {
    const response = await fetch(`${base}/assets/${id}/content`)
    assert(response.ok)
    return Buffer.from(await response.arrayBuffer())
  }
  let first
  if (process.env.GENERATION_RUN_ID) {
    const snapshot = await request(`/projects/${project.id}`)
    const run = snapshot.runs.find(item => item.id === process.env.GENERATION_RUN_ID)
    assert.equal(run?.status, 'completed')
    const asset = snapshot.assets.find(item => item.id === run.assetId)
    assert(asset, 'Existing generation has no imported image')
    first = { run, asset }
  } else {
    first = await turn('请直接生成一张方形图片：浅灰色桌面中央放着一个蓝色陶瓷马克杯，杯柄朝右，杯子左侧放一颗黄色柠檬，柔和自然光，极简产品摄影，不要文字。只生成一张。')
  }
  assert.equal(first.run.imageOperation, 'generate')
  const original = await imageBytes(first.asset.id)
  const second = await turn('请修改刚才生成的这张图片，只把蓝色马克杯改成红色；保持杯子的形状、杯柄朝向、左侧黄色柠檬的位置、背景、光线和构图不变。请基于原图编辑，不要重新创作另一张场景。')
  assert.equal(second.run.imageOperation, 'edit')
  assert.equal(second.run.threadId, first.run.threadId)
  assert.equal(second.asset.sourceAssetId, first.asset.id)
  assert.equal(second.asset.sourceHash, createHash('sha256').update(original).digest('hex'))
  assert.equal(second.asset.width, first.asset.width)
  assert.equal(second.asset.height, first.asset.height)
  assert.deepEqual(await imageBytes(first.asset.id), original)
  assert.notDeepEqual(await imageBytes(second.asset.id), original)
  const snapshot = await request(`/projects/${project.id}`)
  assert.equal(snapshot.assets.length, 2)
  console.log(JSON.stringify({ verified: true, projectId: project.id, originalAssetId: first.asset.id, editedAssetId: second.asset.id,
    sourceHash: second.asset.sourceHash, originalPreserved: true, sameThread: true, dimensions: [second.asset.width, second.asset.height] }))
  process.exit(0)
}
const project = process.env.PROJECT_ID ? { id: process.env.PROJECT_ID } : await request('/projects', { title: 'Codex 与 Azure 接入验收' })
const mode = process.env.AUTO_TEST === '1' ? 'auto' : process.env.IMAGE_TEST === '1' ? 'image' : 'chat'
const text = process.env.PROMPT ?? (process.env.WEB_SEARCH_TEST === '1'
  ? '请实际使用网页搜索，查找 Microsoft 官方关于 Edge 安装 PWA 的文档，说明官方安装入口并附上本次查阅的官方 HTTPS 链接。不要凭记忆回答，不生成图片；搜索失败就明确说明。'
  : '请记住本项目的验收代号是青竹七号。只回复已记住，不要生成图片。')
const run = await request(`/projects/${project.id}/chat`, { requestId: randomUUID(), text, mode, ratio: process.env.RATIO ?? '1:1', ...models })
console.log(JSON.stringify({ projectId: project.id, runId: run.id, mode }))
const stream = await fetch(`${base}/projects/${project.id}/events`, { signal: AbortSignal.timeout(models.videoModel === 'minimax-h3' ? 1800000 : 420000) })
const reader = stream.body.getReader()
try {
  while (true) {
    const snapshot = await request(`/projects/${project.id}`)
    const current = snapshot.runs.find(item => item.id === run.id)
    if (!['queued', 'running'].includes(current.status)) {
      console.log(JSON.stringify({ status: current.status, threadId: current.threadId, reply: current.reply, error: current.error,
        images: snapshot.assets.filter(asset => asset.runId === run.id).map(asset => ({ id: asset.id, width: asset.width, height: asset.height })) }))
      assert.equal(current.status, 'completed')
      assert(current.reply)
      if (mode === 'image') assert(current.assetId, 'No generated image')
      if (process.env.EXPECT_MODEL) {
        const asset = snapshot.assets.find(item => item.id === current.assetId)
        assert.equal(asset?.model, process.env.EXPECT_MODEL)
        const content = await fetch(`${base}/assets/${asset.id}/content`)
        assert.equal(content.headers.get('content-type'), asset.mediaType === 'video' ? 'video/mp4' : 'image/png')
        assert.equal((await content.arrayBuffer()).byteLength, asset.bytes)
        console.log(JSON.stringify({ assetVerified: asset.id, model: asset.model, mediaType: asset.mediaType ?? 'image', duration: asset.duration, fps: asset.fps }))
      }
      if (process.env.NO_IMAGE === '1') assert.equal(current.assetId, undefined, 'Unexpected generated image')
      if (process.env.EXPECT_INTENT) assert.equal(current.progress?.find(entry => entry.id === 'intent')?.label, process.env.EXPECT_INTENT)
      if (process.env.WEB_SEARCH_TEST === '1') {
        const searches = current.progress?.filter(entry => {
          if (!entry.id.startsWith('codex:') || !entry.detail) return false
          const event = JSON.parse(entry.detail)
          return event.type === 'item.completed' && event.item?.type === 'web_search'
        }) ?? []
        assert(searches.length > 0, 'No completed web search tool event')
        assert.match(current.reply, /https:\/\//, 'No source URL in reply')
        assert.equal(current.assetId, undefined, 'Search unexpectedly generated an image')
        console.log(JSON.stringify({ webSearchVerified: true, searches }))
      }
      break
    }
    if ((await reader.read()).done) throw new Error('SSE closed before completion')
  }
} finally { await reader.cancel() }