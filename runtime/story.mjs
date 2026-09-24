import { randomUUID } from 'node:crypto'
import { storyPlanSchema } from './decision.mjs'

export async function executeStory(run, input, plan, { render, stitch, save }) {
  if (run.story) throw new Error('Story already started; verify persisted clips instead of resubmitting')
  const approved = storyPlanSchema.parse(plan)
  run.story = { ...approved, clipIds: approved.segments.map(() => randomUUID()), phase: 'script', segment: 0, stopRequested: false }
  run.processedVideos = []
  run.stage = 'video'
  await save(run)
  const stopped = async () => {
    if (!run.story.stopRequested) return false
    run.story.phase = 'stopped'
    run.status = 'cancelled'
    run.reply = `后续步骤已停止，已完成的 ${run.processedVideos.length} 段视频及剧本保留在项目中。当前已执行的生成可能计费。`
    await save(run)
    return true
  }
  for (const [index, segment] of approved.segments.entries()) {
    if (await stopped()) return
    run.story.phase = 'rendering'
    run.story.segment = index + 1
    await save(run)
    const assetId = run.story.clipIds[index]
    const result = await render({ ...input, runId: assetId, model: 'minimax-h3', prompt: segment.prompt })
    if (!result.success) throw new Error(result.error ?? 'Story clip unavailable; no automatic retry')
    run.processedVideos.push({ ...result, assetId })
    await save(run)
    if (run.processedVideos.reduce((size, clip) => size + Buffer.byteLength(clip.mp4, 'base64'), 0) > 96 * 1024 * 1024) throw new Error('Story output limit exceeded; completed clips retained')
  }
  if (await stopped()) return
  run.story.phase = 'stitching'
  await save(run)
  const result = await stitch({ runId: run.id, clipIds: run.story.clipIds, width: run.processedVideos[0].width, height: run.processedVideos[0].height })
  if (!result.success) throw new Error(result.error ?? 'Story assembly failed; clips retained')
  run.video = result
  run.story.phase = 'completed'
  run.reply = `《${approved.title}》已生成 ${approved.segments.length} 段并完成拼接，时长 ${result.duration.toFixed(2)} 秒；正在保存到项目。`
  await save(run)
}