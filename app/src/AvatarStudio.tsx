import { useEffect, useRef, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { ArrowDownToLine, Film, LoaderCircle, RefreshCw, X } from 'lucide-react'
import { authenticatedFetch } from './auth-client'
import type { AvatarJob } from '../server/avatar'
import { ShareAssetButton } from './ShareAssetButton'
import type { Asset } from './domain'

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await authenticatedFetch(`/api${path}`, options)
  const body = await response.json()
  if (!response.ok) throw new Error(body.error ?? `请求失败 (${response.status})`)
  return body
}
const labels = { submitting: '正在提交', running: '正在制作', unknown: '提交待核实', completed: '已完成', failed: '生成失败', cancelled: '已停止' }

export function AvatarStudio({ projectId, open, onOpenChange, assets = [] }: { projectId: string; open: boolean; onOpenChange: (open: boolean) => void; assets?: Asset[] }) {
  const [text, setText] = useState('')
  const [voice, setVoice] = useState('zh-CN-XiaoxiaoNeural')
  const [style, setStyle] = useState('casual-sitting')
  const [confirmed, setConfirmed] = useState(false)
  const [configured, setConfigured] = useState<boolean | null>(null)
  const [nativeConfigured, setNativeConfigured] = useState(false)
  const [sourceAssetId, setSourceAssetId] = useState('')
  const [jobs, setJobs] = useState<AvatarJob[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [syncError, setSyncError] = useState('')
  const requestId = useRef(crypto.randomUUID())
  const pending = jobs.some(job => ['submitting', 'running', 'unknown'].includes(job.status))
  const images = assets.filter(asset => (asset.mediaType ?? 'image') === 'image' && asset.hash)
  const sourceAvailable = !sourceAssetId || nativeConfigured && images.some(asset => asset.id === sourceAssetId)
  useEffect(() => {
    if (!open || !projectId) return
    let active = true
    let loading = false
    async function refresh() {
      if (loading) return
      loading = true
      try {
        const [capability, latest] = await Promise.all([
          request<{ configured: boolean; nativeConfigured?: boolean }>('/avatar'),
          request<AvatarJob[]>(`/projects/${projectId}/avatar-jobs`),
        ])
        if (active) { setConfigured(capability.configured); setNativeConfigured(capability.nativeConfigured ?? false); setJobs(latest); setSyncError('') }
      } catch (failure) { if (active) setSyncError((failure as Error).message) }
      finally { loading = false }
    }
    void refresh()
    const timer = setInterval(() => { void refresh() }, 5000)
    return () => { active = false; clearInterval(timer) }
  }, [open, projectId])
  async function submit() {
    setBusy(true); setError('')
    try {
      const job = await request<AvatarJob>(`/projects/${projectId}/avatar-jobs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: requestId.current, text, voice, character: 'lisa', style, confirmed, ...(sourceAssetId ? { sourceAssetId } : {}) }) })
      setJobs(previous => [job, ...previous.filter(item => item.id !== job.id)])
      requestId.current = crypto.randomUUID()
      setConfirmed(false)
    } catch (failure) { setError((failure as Error).message) }
    finally { setBusy(false) }
  }
  return <Dialog.Root open={open} onOpenChange={onOpenChange}><Dialog.Portal>
    <Dialog.Overlay className="overlay" />
    <Dialog.Content className="modal avatar-studio" aria-describedby={undefined}>
      <div className="modal-heading"><Dialog.Title>数字人口播</Dialog.Title><Dialog.Close asChild><button type="button" className="icon-button" aria-label="关闭" title="关闭"><X size={20} /></button></Dialog.Close></div>
      <form className="avatar-form" onSubmit={event => { event.preventDefault(); void submit() }}>
        <label>播报文案<textarea aria-label="播报文案" required maxLength={500} rows={3} value={text} disabled={busy} onChange={event => { setText(event.target.value); setConfirmed(false) }} /></label>
        <span className="avatar-count">{text.length} / 500</span>
        {nativeConfigured && <label>主播来源<select aria-label="主播来源" value={sourceAssetId} disabled={busy || pending} onChange={event => { setSourceAssetId(event.target.value); setConfirmed(false) }}><option value="">Azure Speech · 预设 Lisa</option>{images.map(asset => <option key={asset.id} value={asset.id}>OpenMontage · {asset.name}</option>)}</select></label>}
        {!sourceAssetId && <label>数字人形象<select aria-label="数字人形象" value={style} disabled={busy} onChange={event => { setStyle(event.target.value); setConfirmed(false) }}><option value="casual-sitting">Lisa · 休闲坐姿</option><option value="graceful-sitting">Lisa · 优雅坐姿</option></select></label>}
        <label>播报声音<select aria-label="播报声音" value={voice} disabled={busy} onChange={event => { setVoice(event.target.value); setConfirmed(false) }}><option value="zh-CN-XiaoxiaoNeural">晓晓 · 普通话女声</option><option value="zh-CN-YunxiNeural">云希 · 普通话男声</option></select></label>
        <label className="risk-check"><input type="checkbox" checked={confirmed} disabled={busy || pending} onChange={event => setConfirmed(event.target.checked)} />{sourceAssetId ? '确认使用所选主播图片，文案发送至 Azure Speech，并承担配音和 GPU 费用' : '确认将文案发送至 Azure Speech 并按量计费'}</label>
        <button type="submit" className="primary" disabled={!configured || !sourceAvailable || !projectId || !text.trim() || !confirmed || busy || pending}>{busy ? <LoaderCircle size={18} className="spin" /> : <Film size={18} />}制作短片</button>
        <p className="muted" role="status">{configured === null ? '正在检查服务' : !configured ? '数字人服务未配置' : !sourceAvailable ? '主播图片或原生服务不可用' : pending ? '已有任务处理中或待核实' : sourceAssetId ? 'OpenMontage · SadTalker · Azure TTS' : 'Azure Speech · MP4'}</p>
        {error && <p className="form-error" role="alert">{error}</p>}
        {syncError && <p className="form-error" role="alert">状态同步失败：{syncError}</p>}
      </form>
      <section className="avatar-history" aria-label="数字人任务">
        <h3>口播记录</h3>
        {!jobs.length && <p className="muted">暂无任务</p>}
        {jobs.map(job => <article key={job.id} className="avatar-job">
          <div className="avatar-job-heading"><strong>{labels[job.status]}</strong><time dateTime={job.createdAt}>{new Date(job.createdAt).toLocaleString('zh-CN')}</time></div>
          <p>{job.text}</p>
          {job.error && <p className="form-error">{job.error}</p>}
          {job.assetId && <><video className="generated-video" src={`/api/assets/${job.assetId}/content`} controls playsInline preload="metadata" aria-label="数字人口播视频" /><a className="icon-button" href={`/api/assets/${job.assetId}/content?download=1`} download target="_blank" rel="noopener noreferrer" aria-label="下载口播视频" title="下载口播视频"><ArrowDownToLine size={20} /></a></>}
          {!['completed', 'failed'].includes(job.status) && <span className="avatar-job-pending"><RefreshCw size={14} />等待原任务结果</span>}
          <small className="avatar-job-id">{job.id}</small>
          {job.assetId && <ShareAssetButton key={job.assetId} asset={{ id: job.assetId, name: '数字人口播.mp4', mediaType: 'video', mimeType: 'video/mp4' }} />}
        </article>)}
      </section>
    </Dialog.Content>
  </Dialog.Portal></Dialog.Root>
}