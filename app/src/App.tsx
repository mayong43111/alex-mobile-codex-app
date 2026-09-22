import { useEffect, useRef, useState } from 'react'
import type { ButtonHTMLAttributes, FormEvent, ReactNode } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { TransformWrapper, TransformComponent } from 'react-zoom-pan-pinch'
import { ArrowDownToLine, ArrowUp, Check, ChevronRight, CirclePause, Copy, Cpu, Folder, ImagePlus, Images, ListTodo, LoaderCircle, Maximize, MessageSquare, PanelLeft, Plus, RefreshCw, Search, Square, X, ZoomIn, ZoomOut, Aperture, Settings, Trash2, Power, RotateCw, Paperclip, FileText, Film } from 'lucide-react'
import type { AgentRun, Asset, ImageModel, VideoModel, Job, Message, Project, Ratio, Quality, Snapshot, Submission } from './domain'
import { assetHasThumbnail } from './domain'
import type { VmStatus, VmAction } from '../server/vm'
import './MobileApp.css'

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, options)
  if (!response.ok) {
    const detail = await response.json().catch(() => null)
    throw new Error(detail?.error ?? `请求失败 (${response.status})`)
  }
  return response.json()
}
const json = (method: string, payload: unknown): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
const imageUrl = (asset: Asset, thumbnail = true) => `/api/assets/${asset.id}/content${thumbnail ? '?thumbnail=1' : ''}`
const fileSize = (bytes: number) => bytes < 1024 * 1024 ? `${Math.max(1, Math.ceil(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`
const assetDetails = (asset: Asset) => `${asset.width && asset.height ? `${asset.width} × ${asset.height} · ` : ''}${asset.duration ? `${asset.duration.toFixed(2)} 秒 · ` : ''}${fileSize(asset.bytes)}`
function AssetPreview({ asset }: { asset: Asset }) {
  return assetHasThumbnail(asset) ? <img src={imageUrl(asset)} alt={asset.name} loading="lazy" /> : <span className="file-preview" aria-label={asset.name}>{asset.mediaType === 'video' ? <Film size={28} /> : <FileText size={28} />}</span>
}
const time = (value: string) => new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
type Health = { storage: string; agentConfigured?: boolean; agent: string; renderer: string; openmontage?: string; models?: { images: ImageModel[]; videos: Exclude<VideoModel, 'none'>[] } }
const runLabel = (run: AgentRun) => ({ queued: '等待处理', running: run.stage === 'video' ? '正在生成视频' : run.stage === 'image' ? run.imageOperation === 'edit' ? '正在修改图片' : '正在生成图片' : 'Codex 正在回复', completed: '已完成', failed: '失败', cancelled: '已停止', interrupted: '结果待核实' })[run.status]
const runModel = (run: AgentRun) => run.stage === 'video' ? 'MiniMax H3 · 24fps' : run.stage === 'image' ? run.input.imageModel === 'qwen-image-2.1' ? 'Qwen Image 2.1 · BF16' : 'Azure image2 · 1 张' : 'Codex · GPT-5.4'
const qualityNames = { low: '低', medium: '中', high: '高' }
const references = [
  { name: '午后空间', file: '/reference-interior.jpg', prompt: '保留空间结构，营造午后自然光下安静、通透的室内氛围。' },
  { name: '静物与光', file: '/reference-still-life.jpg', prompt: '参考这张图片的构图，创作一幅自然光静物照片，保留细腻材质。' },
]

function IconButton({ label, children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; children: ReactNode }) {
  return <button type="button" className="icon-button" aria-label={label} title={label} {...props}>{children}</button>
}

function Modal({ open, onOpenChange, title, children, className = '' }: { open: boolean; onOpenChange: (open: boolean) => void; title: string; children: ReactNode; className?: string }) {
  return <Dialog.Root open={open} onOpenChange={onOpenChange}><Dialog.Portal>
    <Dialog.Overlay className="overlay" />
    <Dialog.Content className={`modal ${className}`} aria-describedby={undefined}>
      <div className="modal-heading"><Dialog.Title>{title}</Dialog.Title><Dialog.Close asChild><IconButton label="关闭"><X size={20} /></IconButton></Dialog.Close></div>
      {children}
    </Dialog.Content>
  </Dialog.Portal></Dialog.Root>
}

function RunProgress({ run }: { run: AgentRun }) {
  const entries = run.progress ?? []
  const running = run.status === 'running' || run.status === 'queued'
  return <details className="run-progress">
    <summary aria-label="处理过程" title="处理过程"><Aperture size={16} /><strong>Codex</strong><span className="progress-state">{running && <LoaderCircle size={13} className="spin" />}{runLabel(run)}</span><ChevronRight size={14} className="progress-chevron" /></summary>
    {entries.length ? <ol>{entries.map(entry => <li key={entry.id}><div className="progress-heading"><strong>{entry.label}</strong><time dateTime={entry.createdAt}>{time(entry.createdAt)}</time></div>{entry.detail && (entry.id.startsWith('codex:') ? <pre>{entry.detail}</pre> : <p>{entry.detail}</p>)}</li>)}</ol> : <p className="progress-empty">{running ? (run.status === 'queued' ? '等待开始处理' : '等待 Codex 运行事件') : '此运行未记录详细过程'}</p>}
  </details>
}

function CopyReply({ text, createdAt }: { text: string; createdAt: string }) {
  const [state, setState] = useState<'idle' | 'copying' | 'copied' | 'failed'>('idle')
  useEffect(() => {
    if (state !== 'copied') return
    const timer = setTimeout(() => setState('idle'), 2000)
    return () => clearTimeout(timer)
  }, [state])
  async function copy() {
    setState('copying')
    try { await navigator.clipboard.writeText(text); setState('copied') }
    catch { setState('failed') }
  }
  return <div className="reply-actions"><time dateTime={createdAt}>{time(createdAt)}</time><IconButton label={state === 'copied' ? '已复制回复' : '复制回复'} disabled={state === 'copying'} onClick={() => void copy()}>{state === 'copied' ? <Check size={16} /> : <Copy size={16} />}</IconButton><span role="status">{state === 'copied' ? '已复制' : state === 'failed' ? '复制失败，请重试或长按选择文字' : ''}</span></div>
}

function ImagePending({ run, connected }: { run: AgentRun; connected: boolean }) {
  if (run.status !== 'running' || !['image', 'video'].includes(run.stage)) return null
  return <div className="image-pending" role="status" aria-label={run.stage === 'video' ? '视频生成中' : '图片生成中'} aria-live="polite" aria-busy="true"><LoaderCircle size={24} className="spin" aria-hidden="true" /><span>{connected ? runLabel(run) : '连接已断开，正在同步生成状态'}</span></div>
}

function Viewer({ asset, close, reference }: { asset: Asset | null; close: () => void; reference: (asset: Asset) => void }) {
  return <Modal open={!!asset} onOpenChange={open => { if (!open) close() }} title={asset?.name ?? '图片'} className="viewer">
    {asset?.mediaType === 'file' ? <div className="file-viewer"><AssetPreview asset={asset} /><p>{asset.mimeType ?? '文件'} · {fileSize(asset.bytes)}</p><div className="actions"><a className="icon-button" href={`${imageUrl(asset, false)}?download=1`} aria-label="下载文件" title="下载文件"><ArrowDownToLine size={19} /></a><button className="primary" onClick={() => reference(asset)}><Paperclip size={17} />附加到对话</button></div></div> : asset?.mediaType === 'video' ? <><video className="generated-video" controls playsInline preload="metadata" poster={assetHasThumbnail(asset) ? imageUrl(asset) : undefined} src={imageUrl(asset, false)} aria-label={asset.name} /><div className="viewer-footer"><span>{assetDetails(asset)}</span><div className="actions"><a className="icon-button" href={`${imageUrl(asset, false)}?download=1`} aria-label="下载视频" title="下载视频"><ArrowDownToLine size={19} /></a><button className="primary" onClick={() => reference(asset)}><Paperclip size={17} />附加到对话</button></div></div></> : asset && <TransformWrapper initialScale={1} minScale={0.5} maxScale={8}>
      {({ zoomIn, zoomOut, resetTransform }) => <>
        <div className="image-stage"><TransformComponent wrapperClass="zoom-wrapper" contentClass="zoom-content"><img src={imageUrl(asset, false)} alt={asset.name} /></TransformComponent></div>
        <div className="viewer-footer"><span>{asset.width} × {asset.height} · {asset.kind === 'generated' ? `${asset.provider} / ${asset.model}` : '参考图'}</span><div className="actions">
          <IconButton label="放大" onClick={() => zoomIn()}><ZoomIn size={19} /></IconButton><IconButton label="缩小" onClick={() => zoomOut()}><ZoomOut size={19} /></IconButton><IconButton label="重置缩放" onClick={() => resetTransform()}><Maximize size={19} /></IconButton>
          <a className="icon-button" href={`${imageUrl(asset, false)}?download=1`} aria-label="下载图片" title="下载图片"><ArrowDownToLine size={19} /></a>
          <button className="primary" onClick={() => reference(asset)}><ImagePlus size={17} />用作参考</button>
        </div></div>
      </>}
    </TransformWrapper>}
  </Modal>
}

function VmPanel() {
  const [status, setStatus] = useState<VmStatus | null>(null)
  const [error, setError] = useState('')
  const [statusError, setStatusError] = useState('')
  const [refreshKey, setRefreshKey] = useState(0)
  const [refreshing, setRefreshing] = useState(true)
  const [checkedAt, setCheckedAt] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirmation, setConfirmation] = useState<{ action: VmAction; requestId: string } | null>(null)
  const [force, setForce] = useState(false)
  useEffect(() => {
    let active = true
    let checking = false
    const refresh = async () => {
      if (checking) return
      checking = true
      if (active) setRefreshing(true)
      try { const result = await api<VmStatus>('/vm'); if (active) { setStatus(result); setStatusError(''); setCheckedAt(new Date().toISOString()) } }
      catch (failure) { if (active) setStatusError(failure instanceof Error ? failure.message : 'VM 状态读取失败') }
      finally { checking = false; if (active) setRefreshing(false) }
    }
    void refresh()
    const timer = setInterval(() => void refresh(), 10000)
    return () => { active = false; clearInterval(timer) }
  }, [refreshKey])
  const labels = { start: '启动', deallocate: '关闭并解除分配', restart: '重启' }
  const pending = busy || !!status?.operation && ['pending', 'unknown'].includes(status.operation.status)
  const canStart = ['deallocated', 'stopped'].includes(status?.powerState ?? '')
  const primaryAction: VmAction = canStart ? 'start' : 'deallocate'
  const powerLabel = { running: '运行中', deallocated: '已解除分配', stopped: '已停止', starting: '正在启动', deallocating: '正在解除分配', stopping: '正在停止' }[status?.powerState ?? ''] ?? status?.powerState ?? '未知'
  function confirm(action: VmAction) {
    setConfirmation({ action, requestId: crypto.randomUUID() }); setForce(false); setError('')
  }
  async function submit() {
    if (!confirmation || !status?.name || busy) return
    setBusy(true); setError('')
    try {
      setStatus(await api<VmStatus>('/vm/actions', json('POST', { ...confirmation, confirmedName: status.name, force })))
      setConfirmation(null); setForce(false)
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'VM 操作失败') }
    finally { setBusy(false) }
  }
  return <div className="vm-panel">
    <div className="vm-identity"><Cpu size={24} aria-hidden="true" /><div><span>GPU 实例</span><strong>{status?.name ?? 'VM'}</strong></div><IconButton label="刷新 VM 状态" disabled={refreshing || busy} onClick={() => setRefreshKey(value => value + 1)}><RefreshCw size={18} className={refreshing ? 'spin' : ''} /></IconButton></div>
    {!status ? <p className="vm-empty">{statusError ? '暂时无法获取状态' : '正在读取 VM 状态'}</p> : !status.configured ? <p className="vm-empty">VM 管理未配置</p> : <>
      <div role="status" aria-live="polite" className="vm-state">
        <dl className="vm-facts"><div><dt>电源</dt><dd><span className={`status-dot ${status.powerState === 'running' ? '' : canStart ? 'gray' : 'amber'}`} />{powerLabel}</dd></div><div><dt>ComfyUI</dt><dd>{status.gpuReady ? <Check size={15} /> : <CirclePause size={15} />}{status.gpuReady ? '已就绪' : status.powerState === 'running' ? '等待服务' : '未就绪'}</dd></div><div><dt>计算计费</dt><dd>{status.powerState === 'deallocated' ? '已停止' : status.powerState === 'unknown' ? '待核实' : '可能持续计费'}</dd></div></dl>
        <p className="vm-storage-note">磁盘保留，继续计费</p>
      </div>
      {status.operation && <p className={`vm-operation ${status.operation.status}`} aria-live="polite">{status.operation.status === 'pending' ? <LoaderCircle size={17} className="spin" /> : status.operation.status === 'succeeded' ? <Check size={17} /> : <CirclePause size={17} />}<span>{labels[status.operation.action]} · {{ pending: '执行中', succeeded: '已完成', failed: '失败', unknown: '结果待核实，禁止重复操作' }[status.operation.status]}</span></p>}
      {!confirmation ? <div className="vm-controls"><button className={`primary vm-primary ${primaryAction === 'deallocate' ? 'vm-stop' : ''}`} disabled={pending || !!statusError || (!canStart && status.powerState !== 'running')} onClick={() => confirm(primaryAction)}><Power size={18} />{labels[primaryAction]}</button><button className="vm-restart" disabled={pending || !!statusError || status.powerState !== 'running'} onClick={() => confirm('restart')}><RotateCw size={17} />重启</button></div> : <div className="vm-confirmation">
        <strong>确认{labels[confirmation.action]}？</strong>
        <p>{confirmation.action === 'start' ? '启动后按实际运行时间计费，Spot 容量可能不足，且可能随时被回收。' : confirmation.action === 'deallocate' ? '将停止 VM 并释放计算资源；磁盘仍可能计费。' : '将中断 VM 上的服务，重启完成后需等待 ComfyUI 就绪。'}</p>
        {confirmation.action !== 'start' && <label className="risk-check"><input type="checkbox" checked={force} onChange={event => setForce(event.target.checked)} />队列无法读取时，仍确认可能中断 GPU 任务的风险</label>}
        <div className="vm-confirm-actions"><button disabled={busy} onClick={() => setConfirmation(null)}>取消</button><button className={`primary ${confirmation.action === 'start' ? '' : 'danger'}`} disabled={busy || !!statusError || pending} onClick={() => void submit()}>{busy ? <LoaderCircle size={18} className="spin" /> : <Check size={18} />}确认{labels[confirmation.action]}</button></div>
      </div>}
    </>}
    {statusError && <p role="alert" className="form-error">{statusError}</p>}
    {error && <p role="alert" className="form-error">{error}</p>}
    {checkedAt && <p className="vm-updated">上次同步 <time dateTime={checkedAt}>{time(checkedAt)}</time></p>}
  </div>
}

export default function App() {
  const [projects, setProjects] = useState<Project[]>([])
  const [projectId, setProjectId] = useState('')
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [view, setView] = useState<'chat' | 'images' | 'tasks'>('chat')
  const [draft, setDraft] = useState('')
  const [ratio, setRatio] = useState<Ratio>(() => (['1:1', '3:2', '2:3', '4:3', '3:4', '16:9', '9:16'].includes(localStorage.getItem('studio-ratio') ?? '') ? localStorage.getItem('studio-ratio') : '1:1') as Ratio)
  const [quality, setQuality] = useState<Quality>(() => (['low', 'medium', 'high'].includes(localStorage.getItem('studio-quality') ?? '') ? localStorage.getItem('studio-quality') : 'low') as Quality)
  const [imageModel, setImageModel] = useState<ImageModel>(() => localStorage.getItem('studio-image-model') === 'qwen-image-2.1' ? 'qwen-image-2.1' : 'azure-image2')
  const [videoModel, setVideoModel] = useState<VideoModel>(() => localStorage.getItem('studio-video-model') === 'minimax-h3' ? 'minimax-h3' : 'none')
  const [attachments, setAttachments] = useState<Asset[]>([])
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState('all')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [connected, setConnected] = useState(false)
  const [initializing, setInitializing] = useState(true)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [projectDialog, setProjectDialog] = useState<'new' | 'rename' | null>(null)
  const [projectName, setProjectName] = useState('')
  const [selectedAsset, setSelectedAsset] = useState<Asset | null>(null)
  const [servicesOpen, setServicesOpen] = useState(false)
  const [optionsOpen, setOptionsOpen] = useState(false)
  const [vmOpen, setVmOpen] = useState(false)
  const [deleting, setDeleting] = useState<Project | null>(null)
  const [resending, setResending] = useState<{ message: Message; requestId: string; expectedTailId: string } | null>(null)
  const [storageStatus, setStorageStatus] = useState<'checking' | 'ready' | 'offline'>('checking')
  const [health, setHealth] = useState<Health | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const draftInput = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    const input = draftInput.current
    if (!input) return
    input.style.height = '60px'
    input.style.height = `${Math.min(input.scrollHeight, 100)}px`
  }, [draft, view])
  const submitRequest = useRef<{ projectId: string; body: Submission & { imageModel?: ImageModel; videoModel?: VideoModel; quality?: Quality }; mode?: 'auto' } | null>(null)
  const currentProject = useRef(projectId)
  useEffect(() => { currentProject.current = projectId }, [projectId])

  function switchProject(id: string) {
    setProjectId(id); setSnapshot(null); setAttachments([]); setDraft(''); setSidebarOpen(false); setView('chat'); setConnected(false)
    setResending(null)
    submitRequest.current = null
  }

  useEffect(() => {
    let active = true
    api<Health>('/health').then(result => { if (active) setHealth(result) }).catch(() => { if (active) setError('无法读取服务状态，请重试连接。') })
    return () => { active = false }
  }, [])

  useEffect(() => {
    const viewport = window.visualViewport
    const resize = () => {
      if (viewport && viewport.scale !== 1) return
      document.documentElement.style.setProperty('--app-height', `${viewport?.height ?? window.innerHeight}px`)
      document.documentElement.style.setProperty('--app-top', `${viewport?.offsetTop ?? 0}px`)
    }
    resize()
    viewport?.addEventListener('resize', resize)
    viewport?.addEventListener('scroll', resize)
    window.addEventListener('resize', resize)
    return () => {
      viewport?.removeEventListener('resize', resize)
      viewport?.removeEventListener('scroll', resize)
      window.removeEventListener('resize', resize)
      document.documentElement.style.removeProperty('--app-height')
      document.documentElement.style.removeProperty('--app-top')
    }
  }, [])

  useEffect(() => {
    if (!servicesOpen && !optionsOpen) return
    let active = true
    api<Health>('/health').then(result => {
      if (active) { setStorageStatus(result.storage === 'ready' ? 'ready' : 'offline'); setHealth(result) }
    }).catch(() => { if (active) setStorageStatus('offline') })
    return () => { active = false }
  }, [servicesOpen, optionsOpen])

  async function loadProjects() {
    const result = await api<Project[]>('/projects')
    setProjects(result)
    return result
  }
  async function refresh(id: string) {
    const result = await api<Snapshot>(`/projects/${id}`)
    if (currentProject.current === id) setSnapshot(result)
    await loadProjects()
  }
  useEffect(() => {
    let alive = true
    api<Project[]>('/projects').then(result => {
      if (!alive) return
      setProjects(result)
      const saved = localStorage.getItem('qwen-project')
      setProjectId(result.some(project => project.id === saved) ? saved! : result[0]?.id ?? '')
    }).catch(() => { if (alive) setError('本地服务未连接，请重试。') }).finally(() => { if (alive) setInitializing(false) })
    return () => { alive = false }
  }, [])

  useEffect(() => {
    if (!projectId) return
    localStorage.setItem('qwen-project', projectId)
    let active = true
    const sync = () => api<Snapshot>(`/projects/${projectId}`).then(result => { if (active) setSnapshot(result) }).catch(() => { if (active) setConnected(false) })
    void sync()
    const stream = new EventSource(`/api/projects/${projectId}/events`)
    stream.addEventListener('connected', () => { setConnected(true); void sync() })
    stream.addEventListener('changed', () => { void sync() })
    stream.addEventListener('deleted', () => {
      stream.close()
      void loadProjects().then(result => { if (active) switchProject(result[0]?.id ?? '') })
    })
    stream.onerror = () => setConnected(false)
    return () => { active = false; stream.close() }
  }, [projectId])

  const perform = async (operation: () => Promise<void>) => {
    setBusy(true); setError('')
    try { await operation() } catch (failure) { setError(failure instanceof Error ? failure.message : '操作失败，请重试') }
    finally { setBusy(false) }
  }
  async function saveProject(event: FormEvent) {
    event.preventDefault()
    await perform(async () => {
      const project = await api<Project>(projectDialog === 'rename' ? `/projects/${projectId}` : '/projects', json(projectDialog === 'rename' ? 'PATCH' : 'POST', { title: projectName }))
      await loadProjects()
      if (projectDialog === 'new') switchProject(project.id)
      else await refresh(project.id)
      setProjectDialog(null)
    })
  }
  function editDraft(text: string) { setDraft(text); submitRequest.current = null }
  async function deleteProject() {
    if (!deleting || busy) return
    const target = deleting
    await perform(async () => {
      const result = await api<{ pendingCleanup: number }>(`/projects/${target.id}`, json('DELETE', { expectedUpdatedAt: target.updatedAt }))
      const remaining = await loadProjects()
      if (projectId === target.id) { localStorage.removeItem('qwen-project'); switchProject(remaining[0]?.id ?? '') }
      setDeleting(null); setSelectedAsset(null)
      if (result.pendingCleanup) setError('项目已删除，部分素材文件等待后台清理。')
    })
  }
  async function submit(event: FormEvent) {
    event.preventDefault()
    if ((!draft.trim() && !attachments.length) || !projectId || busy) return
    await perform(async () => {
      if (!health) throw new Error('服务状态尚未确认，请打开服务状态重试。')
      const body = submitRequest.current?.projectId === projectId ? submitRequest.current.body : { requestId: crypto.randomUUID(), text: draft.trim() || '已上传附件。', assetIds: attachments.map(asset => asset.id), ratio, ...(health.agentConfigured ? { imageModel, videoModel, quality } : {}) }
      const mode = 'auto'
      submitRequest.current = { projectId, body, mode }
      if (health.agentConfigured) await api<AgentRun>(`/projects/${projectId}/chat`, json('POST', { requestId: body.requestId, text: body.text, assetIds: body.assetIds, ratio: body.ratio, quality: body.quality, mode, imageModel: body.imageModel, videoModel: body.videoModel }))
      else await api<Job>(`/projects/${projectId}/messages`, json('POST', body))
      submitRequest.current = null
      setDraft(''); setAttachments([])
      await refresh(projectId)
    })
  }
  async function upload(file: File, id = projectId) {
    const form = new FormData(); form.append('file', file)
    return api<Asset>(`/projects/${id}/uploads`, { method: 'POST', body: form })
  }
  async function uploadFiles(files: File[]) {
    const attach = view === 'chat'
    if (files.length > 10 || (attach && attachments.length + files.length > 10)) throw new Error('每次最多上传 10 个文件，每条消息最多附加 10 个文件')
    if (files.some(file => file.size > 64 * 1024 * 1024)) throw new Error('单个文件不能超过 64 MB')
    if (files.some(file => !file.size)) throw new Error('不能上传空文件')
    try {
      for (const file of files) {
        const asset = await upload(file)
        if (attach) {
          setAttachments(previous => [...previous, asset])
          submitRequest.current = null
        }
      }
    } finally { await refresh(projectId) }
  }
  async function resend() {
    if (!resending || busy) return
    const selected = resending
    await perform(async () => {
      await api(`/projects/${selected.message.projectId}/messages/${selected.message.id}/resend`, json('POST', { requestId: selected.requestId, expectedTailId: selected.expectedTailId }))
      submitRequest.current = null
      setResending(null)
      await refresh(selected.message.projectId)
    })
  }
  function attachReference(asset: Asset) {
    if (attachments.length >= 10 && !attachments.some(item => item.id === asset.id)) { setError('最多选择 10 个附件'); return }
    setAttachments(previous => previous.some(item => item.id === asset.id) ? previous : [...previous, asset])
    submitRequest.current = null
    setSelectedAsset(null); setView('chat')
  }
  const selectSample = (sample: typeof references[number]) => perform(async () => {
    let id = projectId
    if (!id) {
      const project = await api<Project>('/projects', json('POST', { title: sample.name }))
      id = project.id; currentProject.current = id; switchProject(id); await loadProjects()
    }
    const response = await fetch(sample.file)
    if (!response.ok) throw new Error('参考照片加载失败')
    const asset = await upload(new File([await response.blob()], `${sample.name}.jpg`, { type: 'image/jpeg' }), id)
    setAttachments(previous => [...previous, asset].slice(0, 10)); editDraft(sample.prompt)
    await refresh(id)
  })
  const assets = snapshot?.assets ?? []
  const jobs = snapshot?.jobs ?? []
  const runs = snapshot?.runs ?? []
  const activeRuns = runs.filter(run => run.status === 'queued' || run.status === 'running')
  const stopRun = (run: AgentRun) => perform(async () => { await api(`/agent-runs/${run.id}/stop`, { method: 'POST' }); await refresh(run.projectId) })
  const waiting = jobs.filter(job => job.status === 'waiting_service').length + activeRuns.length
  const title = snapshot?.project.title ?? projects.find(project => project.id === projectId)?.title ?? '创作工作台'
  const newProject = () => { setSidebarOpen(false); setProjectName(''); setProjectDialog('new') }
  const projectList = <>
    <div className="sidebar-section"><span>工作空间</span><span className="mono">LOCAL / 01</span></div>
    <button className="new-project" onClick={newProject} disabled={busy}><Plus size={18} />新建项目</button>
    <label className="search"><Search size={16} /><input aria-label="搜索项目" placeholder="搜索项目" value={search} onChange={event => setSearch(event.target.value)} /></label>
    <div className="project-list">{projects.filter(project => project.title.toLowerCase().includes(search.toLowerCase())).map(project => <div className="project-row" key={project.id}><button className={`project-link ${projectId === project.id ? 'active' : ''}`} onClick={() => switchProject(project.id)} disabled={busy}><Folder size={17} /><span>{project.title}</span><ChevronRight size={14} /></button><IconButton label={`删除项目 ${project.title}`} disabled={busy} onClick={() => void perform(async () => { const latest = await api<Snapshot>(`/projects/${project.id}`); setDeleting(latest.project); setSidebarOpen(false) })}><Trash2 size={17} /></IconButton></div>)}
      {!projects.length && <p className="muted small">暂无项目</p>}
      {!!projects.length && !projects.some(project => project.title.toLowerCase().includes(search.toLowerCase())) && <p className="muted small">没有匹配的项目</p>}
    </div>
  </>
  const sampleSection = <section className="reference-section"><div className="section-heading"><h3>参考起点</h3><span>摄影参考 · 非生成结果</span></div><div className="sample-grid">{references.map(sample => <button key={sample.name} className="sample" disabled={busy || attachments.length >= 10} onClick={() => void selectSample(sample)}><img src={sample.file} alt={sample.name} /><span>{sample.name}<Plus size={17} /></span></button>)}</div><small className="source">摄影来源：Unsplash</small></section>

  return <div className="studio">
    <main className="workspace">
      <header className="topbar"><IconButton label="项目列表" onClick={() => setSidebarOpen(true)}><PanelLeft size={21} /></IconButton><div className="breadcrumb"><h1 className="project-heading">{projectId ? <button type="button" aria-label="重命名项目" title={title} disabled={busy} onClick={() => { setProjectName(title); setProjectDialog('rename') }}>{title}</button> : 'Qwen Studio'}</h1><span role="status" aria-label={connected ? '已同步' : '连接中'} title={connected ? '已同步' : '连接中'} className={`status-dot ${connected ? '' : 'gray'}`} /></div><IconButton label="VM 管理" onClick={() => setVmOpen(true)}><Cpu size={19} /></IconButton><IconButton label="设置" onClick={() => setOptionsOpen(true)}><Settings size={19} /></IconButton></header>
      {error && <div className="error-banner" role="alert"><span>{error}</span><IconButton label="关闭提示" onClick={() => setError('')}><X size={16} /></IconButton><IconButton label="重试连接" onClick={() => void perform(async () => { const result = await loadProjects(); if (projectId) await refresh(projectId); else if (result.length) switchProject(result[0].id) })}><RefreshCw size={16} /></IconButton></div>}
      {initializing ? <div className="empty"><LoaderCircle className="spin" /><h2>正在读取工作空间</h2></div> : <div className="workspace-body chat-layout">
          <section className="conversation"><div className="conversation-scroll">
            {!snapshot?.messages.length ? <div className="welcome"><div className="workspace-symbol"><Aperture size={30} /></div><h2>今天，想创作什么？</h2><div className="welcome-status"><CirclePause size={15} />{health?.agent === 'configured' ? 'Codex · GPT-5.4' : 'Codex 尚未连接'}</div>{!projectId && <button className="primary" onClick={newProject}><Plus size={17} />创建项目</button>}{sampleSection}</div> : <div className="messages">{snapshot.messages.filter(message => message.role !== 'assistant').map(message => {
              const job = jobs.find(item => item.messageId === message.id)
              const run = runs.find(item => item.messageId === message.id)
              const reply = run ? snapshot.messages.find(item => item.id === run.assistantId) : undefined
              return <section className="conversation-turn" key={message.id}>
                <article className="message user-message" aria-label="你的消息">
                  <div className="message-content">
                    <p className="message-text">{message.text}</p>
                    {message.assetIds.length > 0 && <div className="message-images">{message.assetIds.map(id => { const asset = assets.find(item => item.id === id); return asset && <button className={asset.mediaType === 'file' || !assetHasThumbnail(asset) ? 'message-file' : ''} key={id} onClick={() => setSelectedAsset(asset)}><AssetPreview asset={asset} />{(asset.mediaType === 'file' || !assetHasThumbnail(asset)) && <span>{asset.name}<small>{fileSize(asset.bytes)}</small></span>}</button> })}</div>}
                    <div className="message-actions"><time dateTime={message.createdAt}>{time(message.createdAt)}</time><IconButton label="重新发送此消息" disabled={busy} onClick={() => { setError(''); setResending({ message, requestId: crypto.randomUUID(), expectedTailId: snapshot.messages.at(-1)!.id }) }}><RefreshCw size={15} /></IconButton></div>
                  </div>
                </article>
                {run && <article className="message assistant-message" aria-label="Codex 回复">
                  <RunProgress run={run} />
                  {reply && <div className="message-content"><p className="message-text">{reply.text}</p></div>}
                  <ImagePending run={run} connected={connected} />
                  {reply && reply.assetIds.length > 0 && <div className="message-images">{reply.assetIds.map(id => { const asset = assets.find(item => item.id === id); return asset && (asset.mediaType === 'video' ? <div className="video-result" key={id}><video className="generated-video" controls playsInline preload="metadata" poster={imageUrl(asset)} src={imageUrl(asset, false)} aria-label={asset.name} /><div className="video-meta"><span>MiniMax H3 · {asset.duration?.toFixed(2)} 秒</span><a className="icon-button" href={`${imageUrl(asset, false)}?download=1`} aria-label="下载视频" title="下载视频"><ArrowDownToLine size={18} /></a></div></div> : <button key={id} onClick={() => setSelectedAsset(asset)}><img src={imageUrl(asset)} alt={asset.name} width={asset.width} height={asset.height} /></button>) })}</div>}
                  {run.stage === 'video' && ['failed', 'cancelled', 'interrupted'].includes(run.status) && <p className="image-outcome" role="status">{run.status === 'failed' ? '视频生成失败' : '视频任务结果待核实'}</p>}
                  {run.stage === 'image' && ['failed', 'cancelled', 'interrupted'].includes(run.status) && <p className="image-outcome" role="status">{{ failed: '图片生成失败', cancelled: '图片生成已停止', interrupted: '图片生成结果待核实' }[run.status as 'failed' | 'cancelled' | 'interrupted']}</p>}
                  {run.error && <div className="run-status" role="status"><p>{run.error}</p></div>}
                  {reply?.text && <CopyReply key={reply.id} text={reply.text} createdAt={reply.createdAt} />}
                </article>}
                {job && <div className="job-inline"><CirclePause size={16} /><span>{job.status === 'cancelled' ? '已取消' : '已保存 · 等待服务接入'}</span><span className="mono">{job.ratio}</span><button onClick={() => setView('tasks')}>查看任务<ChevronRight size={14} /></button></div>}
              </section>
            })}</div>}
          </div>
          {activeRuns.some(run => run.stage !== 'codex' && run.status === 'running') && <div className="generation-status" role="status" aria-label={activeRuns.some(run => run.stage === 'video') ? '当前视频任务' : '当前图片任务'}><LoaderCircle size={16} className="spin" aria-hidden="true" /><span>{connected ? runLabel(activeRuns.find(run => run.stage !== 'codex' && run.status === 'running')!) : '连接已断开，正在同步生成状态'}</span></div>}
          <form className="composer" onSubmit={event => void submit(event)}>
            {attachments.length > 0 && <div className="attachments">{attachments.map(asset => <div key={asset.id}><button type="button" className="attachment-preview" aria-label={`查看附件 ${asset.name}`} onClick={() => setSelectedAsset(asset)}><AssetPreview asset={asset} /><span>{asset.name}</span></button><IconButton label={`移除附件 ${asset.name}`} disabled={busy} onClick={() => { setAttachments(previous => previous.filter(item => item.id !== asset.id)); submitRequest.current = null }}><X size={13} /></IconButton></div>)}</div>}
            <div className="composer-input"><textarea ref={draftInput} aria-label="创作需求" placeholder={projectId ? '说说你的想法…' : '先创建一个项目'} value={draft} disabled={!projectId || busy} maxLength={6000} onChange={event => editDraft(event.target.value)} rows={2} /></div>
            <div className="composer-row"><IconButton label="上传文件" disabled={!projectId || busy || attachments.length >= 10} onClick={() => fileInput.current?.click()}><Paperclip size={20} /></IconButton><div className="composer-submit">{activeRuns.length > 0 && <IconButton label="停止当前回复" disabled={busy} onClick={() => void stopRun(activeRuns[0])}><Square size={18} /></IconButton>}<button className="send" type="submit" aria-label="提交需求" title="提交需求" disabled={!projectId || (!draft.trim() && !attachments.length) || busy || !health}>{busy ? <LoaderCircle size={16} className="spin" /> : <ArrowUp size={17} />}</button></div></div>
          </form></section>
        <Modal open={view !== 'chat'} onOpenChange={open => { if (!open) setView('chat') }} title={view === 'images' ? '素材库' : '任务记录'} className="project-panel">
        {view === 'images' && <section className="collection"><div className="collection-toolbar"><h2>{assets.length} 个素材</h2><button className="primary" disabled={!projectId || busy} onClick={() => fileInput.current?.click()}><Plus size={17} />上传文件</button></div>{!assets.length ? <div className="empty"><Images size={32} /><h2>还没有项目资料</h2>{!projectId && <button className="primary" onClick={newProject}><Plus size={16} />创建项目</button>}</div> : <div className="asset-grid">{assets.slice().reverse().map(asset => <button className="asset" key={asset.id} onClick={() => { setView('chat'); setSelectedAsset(asset) }}><div className="asset-image"><AssetPreview asset={asset} /><span className="asset-kind">{asset.kind === 'generated' ? asset.mediaType === 'video' ? 'H3 视频' : `${asset.provider ?? 'Azure'} 生成` : asset.mediaType === 'file' ? '文件' : asset.mediaType === 'video' ? '视频' : '参考图'}</span></div><strong>{asset.name}</strong><small>{assetDetails(asset)}</small></button>)}</div>}</section>}
        {view === 'tasks' && runs.length > 0 && <section className="collection"><div className="collection-toolbar"><h2>{runs.length} 条运行记录</h2></div><div className="task-list">{runs.slice().reverse().map(run => <article className="task agent-task" key={run.id}><div className="task-icon">{run.stage === 'image' ? <Images size={20} /> : run.stage === 'video' ? <Aperture size={20} /> : <MessageSquare size={20} />}</div><div className="task-content"><div><span className="badge">{runLabel(run)}</span><time>{time(run.createdAt)}</time></div><p>{run.input.text}</p><small>{runModel(run)}</small>{run.error && <p className="form-error">{run.error}</p>}</div>{['queued', 'running'].includes(run.status) && <IconButton label="停止运行" disabled={busy} onClick={() => void stopRun(run)}><Square size={18} /></IconButton>}</article>)}</div></section>}
        {view === 'tasks' && (jobs.length > 0 || !runs.length) && <section className="collection"><div className="collection-toolbar"><h2>{jobs.length} 条任务</h2><select aria-label="任务状态筛选" value={filter} onChange={event => setFilter(event.target.value)}><option value="all">全部状态</option><option value="waiting_service">等待服务</option><option value="cancelled">已取消</option></select></div>{!jobs.length ? <div className="empty"><ListTodo size={32} /><h2>暂无任务</h2></div> : <div className="task-list">{jobs.filter(job => filter === 'all' || job.status === filter).slice().reverse().map(job => <article className="task" key={job.id}><div className={`task-icon ${job.status === 'cancelled' ? 'cancelled' : ''}`}><CirclePause size={21} /></div><div className="task-content"><div><span className={`badge ${job.status === 'cancelled' ? 'neutral' : ''}`}>{job.status === 'cancelled' ? '已取消' : '等待服务'}</span><time>{time(job.createdAt)}</time></div><p>{job.prompt}</p><small>Qwen-Image-2.1 · {job.ratio} · {job.assetIds.length} 张参考图</small></div>{job.status === 'waiting_service' ? <IconButton label="取消任务" disabled={busy} onClick={() => void perform(async () => { await api(`/jobs/${job.id}/cancel`, { method: 'POST' }); await refresh(projectId) })}><X size={19} /></IconButton> : <IconButton label="重新编辑需求" disabled={busy} onClick={() => { editDraft(job.prompt); setRatio(health?.agentConfigured ? '1:1' : job.ratio); setAttachments(assets.filter(asset => job.assetIds.includes(asset.id))); setView('chat') }}><RefreshCw size={18} /></IconButton>}</article>)}{jobs.filter(job => filter === 'all' || job.status === filter).length === 0 && <div className="empty">没有符合条件的任务</div>}</div>}</section>}
        </Modal>
      </div>}
    </main>
    <input ref={fileInput} type="file" multiple hidden onChange={event => { const files = Array.from(event.target.files ?? []); event.target.value = ''; if (files.length) void perform(() => uploadFiles(files)) }} />
    <Modal open={sidebarOpen} onOpenChange={setSidebarOpen} title="项目列表" className="project-drawer">{projectList}<div className="project-shortcuts"><button className="service-entry" type="button" disabled={!projectId} onClick={() => { setSidebarOpen(false); setView('images') }}><Images size={19} />素材库</button><button className="service-entry" type="button" disabled={!projectId} onClick={() => { setSidebarOpen(false); setFilter('all'); setView('tasks') }}><ListTodo size={19} />任务记录{waiting > 0 && <small>{waiting}</small>}</button><button className="service-entry" type="button" onClick={() => { setSidebarOpen(false); setStorageStatus('checking'); setServicesOpen(true) }}><Cpu size={19} />{health?.agentConfigured ? '服务状态' : '服务未接入'}</button></div></Modal>
    <Modal open={optionsOpen} onOpenChange={setOptionsOpen} title="设置">
      <div className="creation-options"><label className="ratio-control">默认比例<select aria-label="默认比例" value={ratio} disabled={busy} onChange={event => { setRatio(event.target.value as Ratio); localStorage.setItem('studio-ratio', event.target.value); submitRequest.current = null }}>{(health?.agentConfigured ? ['1:1', '3:2', '2:3', '4:3', '3:4', '16:9', '9:16'] : ['1:1', '4:3', '3:4', '16:9']).map(value => <option key={value}>{value}</option>)}</select></label>{health?.agentConfigured && <label className="ratio-control">默认质量<select aria-label="默认质量" value={quality} disabled={busy} onChange={event => { setQuality(event.target.value as Quality); localStorage.setItem('studio-quality', event.target.value); submitRequest.current = null }}>{(['low', 'medium', 'high'] as const).map(value => <option key={value} value={value}>{qualityNames[value]}</option>)}</select></label>}</div>
      {health?.agentConfigured && <div className="model-options"><label>图片模型<select aria-label="图片模型" value={imageModel} disabled={busy} onChange={event => { const value = event.target.value as ImageModel; setImageModel(value); localStorage.setItem('studio-image-model', value); submitRequest.current = null }}><option value="azure-image2">Azure image2</option><option value="qwen-image-2.1" disabled={!health.models?.images.includes('qwen-image-2.1')}>Qwen Image 2.1{health.models?.images.includes('qwen-image-2.1') ? '' : ' · 未就绪'}</option></select></label><label>视频模型<select aria-label="视频模型" value={videoModel} disabled={busy} onChange={event => { const value = event.target.value as VideoModel; setVideoModel(value); localStorage.setItem('studio-video-model', value); submitRequest.current = null }}><option value="none">不启用</option><option value="minimax-h3" disabled={!health.models?.videos.includes('minimax-h3')}>MiniMax H3{health.models?.videos.includes('minimax-h3') ? '' : ' · 未就绪'}</option></select></label></div>}
      {snapshot?.threadId && <p className="session-info">会话 {snapshot.threadId.slice(-8)}</p>}
    </Modal>
    <Modal open={!!resending} onOpenChange={open => { if (!open && !busy) setResending(null) }} title="重新发送这条消息？">
      <div className="resend-confirmation"><blockquote>{resending?.message.text}</blockquote><p>此消息之后的对话和任务记录将被清除，无法撤销。图片仍保留在素材库。</p>{health?.agentConfigured && <p>将重新调用模型，可能再次计费。</p>}<div className="actions"><button type="button" disabled={busy} onClick={() => setResending(null)}>取消</button><button type="button" className="primary" disabled={busy} onClick={() => void resend()}>{busy ? <LoaderCircle size={17} className="spin" /> : <RefreshCw size={17} />}清理并重新发送</button></div>{error && <p role="alert" className="form-error">{error}</p>}</div>
    </Modal>
    <Modal open={!!projectDialog} onOpenChange={open => { if (!open && !busy) setProjectDialog(null) }} title={projectDialog === 'rename' ? '重命名项目' : '新建项目'}><form className="project-form" onSubmit={event => void saveProject(event)}><label htmlFor="project-title">项目名称</label><input id="project-title" autoFocus required maxLength={80} value={projectName} placeholder="为这次创作命名" onChange={event => setProjectName(event.target.value)} /><button className="primary" disabled={busy || !projectName.trim()} type="submit">{busy ? <LoaderCircle size={17} className="spin" /> : <Check size={17} />}保存项目</button>{error && <p role="alert" className="form-error">{error}</p>}</form></Modal>
    <Modal open={servicesOpen} onOpenChange={setServicesOpen} title="服务状态"><div className="service-list"><p>{storageStatus === 'ready' ? <Check size={18} /> : <CirclePause size={18} />}<strong>本地数据</strong><span>{storageStatus === 'ready' ? 'SQLite 已连接' : storageStatus === 'checking' ? '检查中' : '连接失败'}</span></p><p><CirclePause size={18} /><strong>Codex / GPT-5.4</strong><span>{storageStatus === 'ready' && health?.agent === 'configured' ? '容器已配置' : '未连接'}</span></p><p><Cpu size={18} /><strong>OpenMontage</strong><span>{storageStatus === 'ready' && health?.openmontage === 'installed' ? '已安装' : '未连接'}</span></p><p><Images size={18} /><strong>Azure image2</strong><span>{storageStatus === 'ready' && health?.renderer === 'azure_image2' ? '已配置 · 按量计费' : '未连接'}</span></p><p><Cpu size={18} /><strong>ComfyUI / GPU</strong><span>{storageStatus === 'ready' && (health?.models?.images.includes('qwen-image-2.1') || health?.models?.videos.includes('minimax-h3')) ? '已连接 · GPU 计费' : '未就绪'}</span></p></div></Modal>
    <Viewer asset={selectedAsset} close={() => setSelectedAsset(null)} reference={attachReference} />
    <Modal open={vmOpen} onOpenChange={setVmOpen} title="VM 管理"><VmPanel /></Modal>
    <Modal open={!!deleting} onOpenChange={open => { if (!open && !busy) setDeleting(null) }} title="删除项目？"><div className="resend-confirmation"><strong>{deleting?.title}</strong><p>将删除项目、对话、任务及素材，无法撤销。运行时检查点、模型会话及备份不在此次清理范围内。</p><div className="actions"><button disabled={busy} onClick={() => setDeleting(null)}>取消</button><button className="primary danger" disabled={busy} onClick={() => void deleteProject()}><Trash2 size={18} />确认删除</button></div>{error && <p role="alert" className="form-error">{error}</p>}</div></Modal>
  </div>
}