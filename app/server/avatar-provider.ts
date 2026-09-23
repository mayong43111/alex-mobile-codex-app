import { z } from 'zod'

export const avatarInputSchema = z.object({
  requestId: z.string().uuid(),
  text: z.string().min(1).max(500).refine(text => !!text.trim()),
  voice: z.enum(['zh-CN-XiaoxiaoNeural', 'zh-CN-YunxiNeural']),
  character: z.literal('lisa'),
  style: z.enum(['casual-sitting', 'graceful-sitting']),
}).strict()
export type AvatarInput = z.infer<typeof avatarInputSchema>
export type AvatarStatus = { status: 'NotStarted' | 'Running' | 'Succeeded' | 'Failed'; result?: string; durationMs?: number }
export type AvatarProvider = {
  submit(id: string, input: AvatarInput): Promise<void>
  status(id: string): Promise<AvatarStatus>
  download(url: string): Promise<Buffer>
}

export class AvatarSubmissionRejected extends Error {}

export function createAvatarProvider(endpoint: string, headers: () => Promise<Record<string, string>>, request: typeof fetch = fetch): AvatarProvider {
  const base = new URL(endpoint)
  if (base.protocol !== 'https:' || !/^[a-z0-9-]+\.cognitiveservices\.azure\.com$/.test(base.hostname) || base.port || base.username || base.password || base.pathname !== '/' || base.search || base.hash) throw new Error('Invalid Speech endpoint')
  function jobUrl(id: string) {
    z.string().uuid().parse(id)
    return `${base.origin}/avatar/batchsyntheses/${id}?api-version=2024-08-01`
  }
  return {
    async submit(id, input) {
      const checked = avatarInputSchema.parse(input)
      const authorization = await headers().catch(() => { throw new AvatarSubmissionRejected('Speech authentication unavailable') })
      const response = await request(jobUrl(id), { method: 'PUT', redirect: 'error', signal: AbortSignal.timeout(30000), headers: { ...authorization, 'Content-Type': 'application/json' }, body: JSON.stringify({
        inputKind: 'PlainText', synthesisConfig: { voice: checked.voice }, inputs: [{ content: checked.text }],
        avatarConfig: { talkingAvatarCharacter: checked.character, talkingAvatarStyle: checked.style, videoFormat: 'Mp4', videoCodec: 'h264', subtitleType: 'soft_embedded', backgroundColor: '#FFFFFF' },
        properties: { timeToLiveInHours: 24 },
      }) })
      if (!response.ok) {
        await response.body?.cancel()
        if ([400, 401, 403, 404, 413, 422, 429].includes(response.status)) throw new AvatarSubmissionRejected(`Avatar submission rejected: HTTP ${response.status}`)
        throw new Error(`Avatar submission returned HTTP ${response.status}; verify the existing job before retrying`)
      }
      await response.body?.cancel()
    },
    async status(id) {
      const response = await request(jobUrl(id), { headers: await headers(), redirect: 'error', signal: AbortSignal.timeout(30000) })
      if (!response.ok) throw new Error(`Avatar status returned HTTP ${response.status}`)
      const result = z.object({ status: z.enum(['NotStarted', 'Running', 'Succeeded', 'Failed']), outputs: z.object({ result: z.string().url().optional() }).optional(), properties: z.object({ durationInMilliseconds: z.number().nonnegative().optional() }).optional() }).parse(await response.json())
      return { status: result.status, result: result.outputs?.result, durationMs: result.properties?.durationInMilliseconds }
    },
    async download(url) {
      const target = new URL(url)
      if (target.protocol !== 'https:' || !/^[a-z0-9]+\.blob\.core\.windows\.net$/.test(target.hostname) || target.port || target.username || target.password || target.hash) throw new Error('Invalid avatar output URL')
      const response = await request(target, { redirect: 'error', signal: AbortSignal.timeout(120000) })
      if (!response.ok || !response.body) throw new Error('Avatar download failed')
      const maximum = 64 * 1024 * 1024
      if (Number(response.headers.get('content-length')) > maximum) { await response.body.cancel(); throw new Error('Avatar output too large') }
      const chunks: Buffer[] = []
      let bytes = 0
      for await (const chunk of response.body) {
        bytes += chunk.length
        if (bytes > maximum) throw new Error('Avatar output too large')
        chunks.push(Buffer.from(chunk))
      }
      return Buffer.concat(chunks)
    },
  }
}