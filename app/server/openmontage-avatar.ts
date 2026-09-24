import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import sharp from 'sharp'
import { AvatarSubmissionRejected, AvatarSubmissionStopped, avatarInputSchema } from './avatar-provider.ts'
import type { AvatarArtifact, AvatarProvider } from './avatar-provider.ts'

type Narration = { text: string; voice: string; endpoint: string; token: string }
async function synthesize(input: Narration): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.OPENMONTAGE_PYTHON ?? '/opt/venv/bin/python', [fileURLToPath(new URL('../../runtime/openmontage-tts.py', import.meta.url))], { env: { PATH: '/usr/bin:/bin', PYTHONPATH: process.env.OPENMONTAGE_ROOT ?? '/opt/openmontage' }, stdio: ['pipe', 'pipe', 'ignore'] })
    const chunks: Buffer[] = []
    let size = 0
    const timer = setTimeout(() => child.kill(), 150000)
    child.stdout.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 24 * 1024 * 1024) child.kill(); else chunks.push(chunk) })
    child.on('error', () => { clearTimeout(timer); reject(new Error('Native narration worker unavailable')) })
    child.on('close', code => {
      clearTimeout(timer)
      if (code !== 0) return reject(new Error('Native narration outcome uncertain; no automatic retry'))
      try {
        const result = z.object({ wav: z.string() }).parse(JSON.parse(Buffer.concat(chunks).toString()))
        const bytes = Buffer.from(result.wav, 'base64')
        if (bytes.length > 16 * 1024 * 1024 || bytes.subarray(0, 4).toString() !== 'RIFF' || bytes.subarray(8, 12).toString() !== 'WAVE') throw new Error('Invalid narration')
        resolve(bytes)
      } catch { reject(new Error('Invalid native narration output')) }
    })
    child.stdin.on('error', () => {})
    child.stdin.end(JSON.stringify(input))
  })
}

async function limitedBytes(response: Response, limit = 64 * 1024 * 1024) {
  if (!response.ok || !response.body) throw new Error('Native artifact unavailable')
  const chunks: Uint8Array[] = []
  let size = 0
  const reader = response.body.getReader()
  try {
    for (;;) {
      const result = await reader.read()
      if (result.done) break
      size += result.value.length
      if (size > limit) throw new Error('Native artifact too large')
      chunks.push(result.value)
    }
    return Buffer.concat(chunks)
  } finally { await reader.cancel() }
}

export function createOpenMontageAvatarProvider(options: { directory: string; comfyUrl: string; speechEndpoint: string; headers: () => Promise<Record<string, string>> }, request: typeof fetch = fetch, narration = synthesize): AvatarProvider {
  const comfy = new URL(options.comfyUrl)
  const speech = new URL(options.speechEndpoint)
  if (!/^10\.(?:\d{1,3}\.){2}\d{1,3}$/.test(comfy.hostname) || !['http:', 'https:'].includes(comfy.protocol) || comfy.username || comfy.password || comfy.pathname !== '/' || comfy.search || comfy.hash) throw new Error('Invalid native GPU endpoint')
  if (speech.protocol !== 'https:' || !/^[a-z0-9-]+\.cognitiveservices\.azure\.com$/.test(speech.hostname) || speech.port || speech.username || speech.password || speech.pathname !== '/' || speech.search || speech.hash) throw new Error('Invalid native Speech endpoint')
  const path = (id: string) => join(options.directory, `${z.string().uuid().parse(id)}.json`)
  const json = async (route: string, init?: RequestInit) => {
    const response = await request(`${comfy.origin}${route}`, { ...init, redirect: 'error', signal: init?.signal ?? AbortSignal.timeout(60000) })
    if (!response.ok) { await response.body?.cancel(); throw new Error('Native GPU request failed; verify original job') }
    return response.json()
  }
  const reference = z.object({ id: z.string().uuid(), hash: z.string().regex(/^[a-f0-9]{64}$/), sourceAssetId: z.string().uuid(), sourceHash: z.string().regex(/^[a-f0-9]{64}$/) })
  const manifestSchema = z.object({ status: z.enum(['running', 'completed', 'cancelled']), phase: z.enum(['queued', 'rendering', 'tail', 'stitching', 'completed', 'stopped']).optional(), segment: z.number().int().min(0).max(12).optional(), updatedAt: z.string().datetime({ offset: true }).optional(), segments: z.array(z.object({ text: z.string(), continueFromPrevious: z.boolean(), clip: reference, tail: reference.extend({ seconds: z.number().nonnegative() }) })).max(12) })
  async function manifestFor(id: string) {
    const query = new URLSearchParams({ filename: 'manifest.json', subfolder: `studio-avatar/${id}`, type: 'output' })
    const response = await request(`${comfy.origin}/view?${query}`, { redirect: 'error', signal: AbortSignal.timeout(30000) })
    if (response.status === 404) { await response.body?.cancel(); return undefined }
    return manifestSchema.parse(JSON.parse((await limitedBytes(response, 65536)).toString()))
  }
  async function checkStopped(id: string) {
    const marker = await readFile(`${path(id)}.stop`).catch(error => { if (error.code === 'ENOENT') return undefined; throw error })
    if (marker) throw new AvatarSubmissionStopped('Stopped before the next submission')
  }
  return {
    async submit(id, input, source, onProgress) {
      z.string().uuid().parse(id)
      avatarInputSchema.parse(input)
      if (!source) throw new AvatarSubmissionRejected('Native avatar requires a project image')
      if (input.segments && (!input.sourceAssetId || input.segments.map(segment => segment.text).join('') !== input.text)) throw new AvatarSubmissionRejected('Sequence narration must match the approved text')
      await checkStopped(id)
      const nodes = await json('/object_info/StudioOpenMontageTalkingHead')
      if (!nodes.StudioOpenMontageTalkingHead) throw new AvatarSubmissionRejected('OpenMontage node unavailable')
      const queue = await json('/queue')
      if (queue.queue_running?.length || queue.queue_pending?.length) throw new AvatarSubmissionRejected('GPU is busy')
      const authorization = (await options.headers()).Authorization
      if (!authorization?.startsWith('Bearer ')) throw new AvatarSubmissionRejected('Speech identity unavailable')
      const image = await sharp(source, { limitInputPixels: 40_000_000 }).rotate().png().toBuffer()
      if (image.length > 16 * 1024 * 1024) throw new AvatarSubmissionRejected('Source image too large')
      await mkdir(options.directory, { recursive: true, mode: 0o700 })
      const sequence = input.segments ? { sourceAssetId: input.sourceAssetId, sourceHash: createHash('sha256').update(source).digest('hex'), segments: input.segments } : undefined
      await writeFile(path(id), JSON.stringify({ id, stage: 'narration-submitting', sequence }), { flag: 'wx', mode: 0o600 })
      const files: { name: string; bytes: Buffer; mime: string }[] = [{ name: `${id}.png`, bytes: image, mime: 'image/png' }]
      const segments = []
      for (const [index, segment] of (input.segments ?? [{ text: input.text, continueFromPrevious: false }]).entries()) {
        await checkStopped(id)
        onProgress?.({ phase: 'speech', segment: index + 1, updatedAt: new Date().toISOString() })
        const audio = await narration({ text: segment.text, voice: input.voice, endpoint: speech.origin, token: authorization.slice(7) })
        files.push({ name: index === 0 ? `${id}.wav` : `${id}-${String(index + 1).padStart(2, '0')}.wav`, bytes: audio, mime: 'audio/wav' })
        segments.push({ ...segment, audioHash: createHash('sha256').update(audio).digest('hex') })
      }
      if (sequence) files.push({ name: `${id}.json`, bytes: Buffer.from(JSON.stringify({ ...sequence, segments })), mime: 'application/json' })
      for (const { name, bytes, mime } of files) {
        await checkStopped(id)
        const form = new FormData()
        form.set('image', new Blob([new Uint8Array(bytes)], { type: mime }), name)
        form.set('type', 'input')
        form.set('subfolder', 'studio-avatar')
        const uploaded = await json('/upload/image', { method: 'POST', body: form })
        if (uploaded.name !== name || uploaded.subfolder !== 'studio-avatar') throw new Error('Unexpected uploaded asset path')
      }
      await checkStopped(id)
      onProgress?.({ phase: 'queued', segment: 0, updatedAt: new Date().toISOString() })
      const result = await json('/prompt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_id: id, prompt: { '1': { class_type: 'StudioOpenMontageTalkingHead', inputs: { job_id: id } } } }) })
      const promptId = z.string().uuid().parse(result.prompt_id)
      await writeFile(`${path(id)}.submitted`, JSON.stringify({ id, promptId, stage: 'submitted' }), { flag: 'wx', mode: 0o600 })
    },
    async stop(id) {
      const marker = `${path(id)}.stop`
      await mkdir(options.directory, { recursive: true, mode: 0o700 })
      await writeFile(marker, 'stop', { flag: 'wx', mode: 0o600 }).catch(error => { if (error.code !== 'EEXIST') throw error })
      const form = new FormData()
      form.set('image', new Blob(['stop'], { type: 'text/plain' }), `${id}.stop`)
      form.set('type', 'input'); form.set('subfolder', 'studio-avatar'); form.set('overwrite', 'true')
      const uploaded = await json('/upload/image', { method: 'POST', body: form, signal: AbortSignal.timeout(10000) })
      if (uploaded.name !== `${id}.stop` || uploaded.subfolder !== 'studio-avatar') throw new Error('Stop request not confirmed')
    },
    async status(id) {
      const original = JSON.parse(await readFile(path(id), 'utf8'))
      const manifest = original.sequence ? await manifestFor(id) : undefined
      const progress = manifest?.phase && manifest.updatedAt ? { phase: manifest.phase, segment: manifest.segment ?? 0, updatedAt: manifest.updatedAt } : undefined
      if (manifest?.status === 'cancelled') return { status: 'Cancelled', progress }
      const receipt = await readFile(`${path(id)}.submitted`, 'utf8').catch(error => { if (error.code === 'ENOENT') return undefined; throw error })
      if (!receipt) return { status: 'NotStarted', progress }
      const ledger = JSON.parse(receipt)
      const promptId = z.string().uuid().parse(ledger.promptId)
      const history = (await json(`/history/${promptId}`))[promptId]
      if (!history) return { status: 'Running', progress }
      if (history.status?.status_str === 'error') return { status: 'Failed', progress }
      if (!history.status?.completed) return { status: 'Running', progress }
      const artifact = history.outputs?.['1']?.videos?.[0]
      if (artifact?.filename !== 'video.mp4' || artifact.subfolder !== `studio-avatar/${id}` || artifact.type !== 'output') throw new Error('Unexpected native avatar output')
      return { status: 'Succeeded', result: id, progress }
    },
    async download(id) {
      z.string().uuid().parse(id)
      const query = new URLSearchParams({ filename: 'video.mp4', subfolder: `studio-avatar/${id}`, type: 'output' })
      return limitedBytes(await request(`${comfy.origin}/view?${query}`, { redirect: 'error', signal: AbortSignal.timeout(120000) }))
    },
    async artifacts(id) {
      const ledger = JSON.parse(await readFile(path(id), 'utf8'))
      if (!ledger.sequence) return []
      const manifest = await manifestFor(id)
      if (!manifest) return []
      if (manifest.segments.length > ledger.sequence.segments.length) throw new Error('Unexpected sequence length')
      const artifacts: AvatarArtifact[] = []
      let totalBytes = 0
      for (const [index, segment] of manifest.segments.entries()) {
        const expected = ledger.sequence.segments[index]
        const previous = index > 0 && expected.continueFromPrevious ? manifest.segments[index - 1].tail : { id: ledger.sequence.sourceAssetId, hash: ledger.sequence.sourceHash }
        if (segment.text !== expected.text || segment.continueFromPrevious !== expected.continueFromPrevious || segment.clip.sourceAssetId !== previous.id || segment.clip.sourceHash !== previous.hash || segment.tail.sourceAssetId !== segment.clip.id || segment.tail.sourceHash !== segment.clip.hash) throw new Error('Invalid sequence lineage')
        const number = String(index + 1).padStart(2, '0')
        for (const kind of ['clip', 'tail'] as const) {
          const item = segment[kind]
          if (artifacts.some(artifact => artifact.id === item.id) || item.id === id || item.id === ledger.sequence.sourceAssetId) throw new Error('Duplicate sequence artifact')
          const media = new URLSearchParams({ filename: kind === 'clip' ? 'video.mp4' : 'tail.png', subfolder: `studio-avatar/${id}/segment-${number}`, type: 'output' })
          const content = await limitedBytes(await request(`${comfy.origin}/view?${media}`, { redirect: 'error', signal: AbortSignal.timeout(60000) }))
          totalBytes += content.length
          if (totalBytes > 64 * 1024 * 1024 || createHash('sha256').update(content).digest('hex') !== item.hash) throw new Error('Invalid sequence artifact bytes')
          artifacts.push({ ...item, bytes: content, mediaType: kind === 'clip' ? 'video' : 'image', name: kind === 'clip' ? `口播第${number}段.mp4` : `第${number}段尾帧.png`, ...(kind === 'clip' ? { text: segment.text } : { seconds: segment.tail.seconds }) })
        }
      }
      return artifacts
    },
  }
}