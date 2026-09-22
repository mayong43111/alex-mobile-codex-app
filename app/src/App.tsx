import { useEffect, useRef, useState } from 'react'
import type { ButtonHTMLAttributes, FormEvent, ReactNode } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { TransformWrapper, TransformComponent } from 'react-zoom-pan-pinch'
import { ArrowDownToLine, ArrowUp, Check, ChevronRight, CirclePause, Copy, Cpu, Folder, ImagePlus, Images, ListTodo, LoaderCircle, Maximize, MessageSquare, PanelLeft, Plus, RefreshCw, Search, Square, X, ZoomIn, ZoomOut, Aperture, Settings } from 'lucide-react'
import type { AgentRun, Asset, Job, Message, Project, Ratio, Snapshot, Submission } from './domain'
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
const time = (value: string) => new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
type Health = { storage: string; agentConfigured?: boolean; agent: string; renderer: string; openmontage?: string }
const runLabel = (run: AgentRun) => ({ queued: '等待处理', running: run.stage === 'image' ? run.imageOperation === 'edit' ? '正在修改图片' : '正在生成图片' : 'Codex 正在回复', completed: '已完成', failed: '失败', cancelled: '已停止', interrupted: '结果待核实' })[run.status]
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
    {entries.length ? <ol>{entries.map(entry => <li key={entry.id}><div className="progress-heading"><strong>{entry.label}</strong><time dateTime={entry.createdAt}>{time(entry.createdAt)}</time></div>{entry.detail && <p>{entry.detail}</p>}</li>)}</ol> : <p className="progress-empty">{running ? (run.status === 'queued' ? '等待开始处理' : '等待 Codex 运行事件') : '此运行未记录详细过程'}</p>}
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
  if (run.status !== 'running' || run.stage !== 'image') return null
  return <div className="image-pending" role="status" aria-label="图片生成中" aria-live="polite" aria-busy="true"><LoaderCircle size={24} className="spin" aria-hidden="true" /><span>{connected ? runLabel(run) : '连接已断开，正在同步生成状态'}</span></div>
}

function Viewer({ asset, close, reference }: { asset: Asset | null; close: () => void; reference: (asset: Asset) => void }) {
  return <Modal open={!!asset} onOpenChange={open => { if (!open) close() }} title={asset?.name ?? '图片'} className="viewer">
    {asset && <TransformWrapper initialScale={1} minScale={0.5} maxScale={8}>
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

export default function App() {
  const [projects, setProjects] = useState<Project[]>([])
  const [projectId, setProjectId] = useState('')
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [view, setView] = useState<'chat' | 'images' | 'tasks'>('chat')
  const [draft, setDraft] = useState('')
  const [ratio, setRatio] = useState<Ratio>('1:1')
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
  const submitRequest = useRef<{ projectId: string; body: Submission; mode?: 'auto' } | null>(null)
  const currentProject = useRef(projectId)
  useEffect(() => { currentProject.current = projectId }, [projectId])

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
    }
    resize()
    viewport?.addEventListener('resize', resize)
    window.addEventListener('resize', resize)
    return () => {
      viewport?.removeEventListener('resize', resize)
      window.removeEventListener('resize', resize)
      document.documentElement.style.removeProperty('--app-height')
    }
  }, [])

  useEffect(() => {
    if (!servicesOpen) return
    let active = true
    api<Health>('/health').then(result => {
      if (active) { setStorageStatus(result.storage === 'ready' ? 'ready' : 'offline'); setHealth(result) }
    }).catch(() => { if (active) setStorageStatus('offline') })
    return () => { active = false }
  }, [servicesOpen])

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
    stream.onerror = () => setConnected(false)
    return () => { active = false; stream.close() }
  }, [projectId])

  const perform = async (operation: () => Promise<void>) => {
    setBusy(true); setError('')
    try { await operation() } catch (failure) { setError(failure instanceof Error ? failure.message : '操作失败，请重试') }
    finally { setBusy(false) }
  }
  function switchProject(id: string) {
    setProjectId(id); setSnapshot(null); setAttachments([]); setDraft(''); setSidebarOpen(false); setView('chat'); setConnected(false)
    setResending(null)
    submitRequest.current = null
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
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!draft.trim() || !projectId || busy) return
    await perform(async () => {
      if (!health) throw new Error('服务状态尚未确认，请打开服务状态重试。')
      if (health.agentConfigured && attachments.length) throw new Error('当前 Codex 与 Azure 图片测试仅支持文字，请先移除参考图；素材仍保存在项目中。')
      const body = submitRequest.current?.projectId === projectId ? submitRequest.current.body : { requestId: crypto.randomUUID(), text: draft.trim(), assetIds: attachments.map(asset => asset.id), ratio }
      const mode = 'auto'
      submitRequest.current = { projectId, body, mode }
      if (health.agentConfigured) await api<AgentRun>(`/projects/${projectId}/chat`, json('POST', { requestId: body.requestId, text: body.text, ratio: body.ratio, mode }))
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
    if (attachments.length >= 10 && !attachments.some(item => item.id === asset.id)) { setError('最多选择 10 张参考图'); return }
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
    <div className="project-list">{projects.filter(project => project.title.toLowerCase().includes(search.toLowerCase())).map(project => <button className={`project-link ${projectId === project.id ? 'active' : ''}`} key={project.id} onClick={() => switchProject(project.id)} disabled={busy}><Folder size={17} /><span>{project.title}</span><ChevronRight size={14} /></button>)}
      {!projects.length && <p className="muted small">暂无项目</p>}
      {!!projects.length && !projects.some(project => project.title.toLowerCase().includes(search.toLowerCase())) && <p className="muted small">没有匹配的项目</p>}
    </div>
    <div className="sidebar-bottom"><div className="avatar">研</div><div><strong>研究工作空间</strong><p>本地单用户</p></div><span className="status-dot" /></div>
  </>
  const sampleSection = <section className="reference-section"><div className="section-heading"><h3>参考起点</h3><span>摄影参考 · 非生成结果</span></div><div className="sample-grid">{references.map(sample => <button key={sample.name} className="sample" disabled={busy || attachments.length >= 10} onClick={() => void selectSample(sample)}><img src={sample.file} alt={sample.name} /><span>{sample.name}<Plus size={17} /></span></button>)}</div><small className="source">摄影来源：Unsplash</small></section>

  return <div className="studio">
    <main className="workspace">
      <header className="topbar"><IconButton label="项目列表" onClick={() => setSidebarOpen(true)}><PanelLeft size={21} /></IconButton><div className="breadcrumb"><h1 className="project-heading">{projectId ? <button type="button" aria-label="重命名项目" title={title} disabled={busy} onClick={() => { setProjectName(title); setProjectDialog('rename') }}>{title}</button> : 'Qwen Studio'}</h1><span role="status" aria-label={connected ? '已同步' : '连接中'} title={connected ? '已同步' : '连接中'} className={`status-dot ${connected ? '' : 'gray'}`} /></div><IconButton label="设置" onClick={() => setOptionsOpen(true)}><Settings size={19} /></IconButton></header>
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
                    {message.assetIds.length > 0 && <div className="message-images">{message.assetIds.map(id => { const asset = assets.find(item => item.id === id); return asset && <button key={id} onClick={() => setSelectedAsset(asset)}><img src={imageUrl(asset)} alt={asset.name} width={asset.width} height={asset.height} /></button> })}</div>}
                    <div className="message-actions"><time dateTime={message.createdAt}>{time(message.createdAt)}</time><IconButton label="重新发送此消息" disabled={busy} onClick={() => { setError(''); setResending({ message, requestId: crypto.randomUUID(), expectedTailId: snapshot.messages.at(-1)!.id }) }}><RefreshCw size={15} /></IconButton></div>
                  </div>
                </article>
                {run && <article className="message assistant-message" aria-label="Codex 回复">
                  <RunProgress run={run} />
                  {reply && <div className="message-content"><p className="message-text">{reply.text}</p></div>}
                  <ImagePending run={run} connected={connected} />
                  {reply && reply.assetIds.length > 0 && <div className="message-images">{reply.assetIds.map(id => { const asset = assets.find(item => item.id === id); return asset && <button key={id} onClick={() => setSelectedAsset(asset)}><img src={imageUrl(asset)} alt={asset.name} width={asset.width} height={asset.height} /></button> })}</div>}
                  {run.stage === 'image' && ['failed', 'cancelled', 'interrupted'].includes(run.status) && <p className="image-outcome" role="status">{{ failed: '图片生成失败', cancelled: '图片生成已停止', interrupted: '图片生成结果待核实' }[run.status as 'failed' | 'cancelled' | 'interrupted']}</p>}
                  {run.error && <div className="run-status" role="status"><p>{run.error}</p></div>}
                  {reply?.text && <CopyReply key={reply.id} text={reply.text} createdAt={reply.createdAt} />}
                </article>}
                {job && <div className="job-inline"><CirclePause size={16} /><span>{job.status === 'cancelled' ? '已取消' : '已保存 · 等待服务接入'}</span><span className="mono">{job.ratio}</span><button onClick={() => setView('tasks')}>查看任务<ChevronRight size={14} /></button></div>}
              </section>
            })}</div>}
          </div>
          {activeRuns.some(run => run.stage === 'image' && run.status === 'running') && <div className="generation-status" role="status" aria-label="当前图片任务"><LoaderCircle size={16} className="spin" aria-hidden="true" /><span>{connected ? runLabel(activeRuns.find(run => run.stage === 'image' && run.status === 'running')!) : '连接已断开，正在同步生成状态'}</span></div>}
          <form className="composer" onSubmit={event => void submit(event)}>
            {attachments.length > 0 && <div className="attachments">{attachments.map(asset => <div key={asset.id}><img src={imageUrl(asset)} alt={asset.name} /><IconButton label={`移除参考图 ${asset.name}`} disabled={busy} onClick={() => { setAttachments(previous => previous.filter(item => item.id !== asset.id)); submitRequest.current = null }}><X size={13} /></IconButton></div>)}</div>}
            <div className="composer-input"><textarea ref={draftInput} aria-label="创作需求" placeholder={projectId ? '说说你的想法…' : '先创建一个项目'} value={draft} disabled={!projectId || busy} maxLength={6000} onChange={event => editDraft(event.target.value)} rows={2} /></div>
            <div className="composer-row"><IconButton label="上传参考图" disabled={!projectId || busy || attachments.length >= 10} onClick={() => fileInput.current?.click()}><ImagePlus size={20} /></IconButton><div className="composer-submit">{activeRuns.length > 0 && <IconButton label="停止当前回复" disabled={busy} onClick={() => void stopRun(activeRuns[0])}><Square size={18} /></IconButton>}<button className="send" type="submit" aria-label="提交需求" title="提交需求" disabled={!projectId || !draft.trim() || busy || !health}>{busy ? <LoaderCircle size={16} className="spin" /> : <ArrowUp size={17} />}</button></div></div>
          </form></section>
        <Modal open={view !== 'chat'} onOpenChange={open => { if (!open) setView('chat') }} title={view === 'images' ? '素材库' : '任务记录'} className="project-panel">
        {view === 'images' && <section className="collection"><div className="collection-toolbar"><h2>{assets.length} 张图片</h2><button className="primary" disabled={!projectId || busy} onClick={() => fileInput.current?.click()}><Plus size={17} />上传图片</button></div>{!assets.length ? <div className="empty"><Images size={32} /><h2>还没有项目图片</h2>{!projectId && <button className="primary" onClick={newProject}><Plus size={16} />创建项目</button>}</div> : <div className="asset-grid">{assets.slice().reverse().map(asset => <button className="asset" key={asset.id} onClick={() => { setView('chat'); setSelectedAsset(asset) }}><div className="asset-image"><img src={imageUrl(asset)} alt={asset.name} loading="lazy" /><span>{asset.kind === 'generated' ? 'Azure 生成' : '参考图'}</span></div><strong>{asset.name}</strong><small>{asset.width} × {asset.height} <span>PNG</span></small></button>)}</div>}</section>}
        {view === 'tasks' && runs.length > 0 && <section className="collection"><div className="collection-toolbar"><h2>{runs.length} 条运行记录</h2></div><div className="task-list">{runs.slice().reverse().map(run => <article className="task agent-task" key={run.id}><div className="task-icon">{run.stage === 'image' ? <Images size={20} /> : <MessageSquare size={20} />}</div><div className="task-content"><div><span className="badge">{runLabel(run)}</span><time>{time(run.createdAt)}</time></div><p>{run.input.text}</p><small>{run.stage === 'image' ? 'Azure image2 · 低质量 · 1 张' : 'Codex · GPT-5.4'} · {run.input.ratio}</small>{run.error && <p className="form-error">{run.error}</p>}</div>{['queued', 'running'].includes(run.status) && <IconButton label="停止运行" disabled={busy} onClick={() => void stopRun(run)}><Square size={18} /></IconButton>}</article>)}</div></section>}
        {view === 'tasks' && (jobs.length > 0 || !runs.length) && <section className="collection"><div className="collection-toolbar"><h2>{jobs.length} 条任务</h2><select aria-label="任务状态筛选" value={filter} onChange={event => setFilter(event.target.value)}><option value="all">全部状态</option><option value="waiting_service">等待服务</option><option value="cancelled">已取消</option></select></div>{!jobs.length ? <div className="empty"><ListTodo size={32} /><h2>暂无任务</h2></div> : <div className="task-list">{jobs.filter(job => filter === 'all' || job.status === filter).slice().reverse().map(job => <article className="task" key={job.id}><div className={`task-icon ${job.status === 'cancelled' ? 'cancelled' : ''}`}><CirclePause size={21} /></div><div className="task-content"><div><span className={`badge ${job.status === 'cancelled' ? 'neutral' : ''}`}>{job.status === 'cancelled' ? '已取消' : '等待服务'}</span><time>{time(job.createdAt)}</time></div><p>{job.prompt}</p><small>Qwen-Image-2.1 · {job.ratio} · {job.assetIds.length} 张参考图</small></div>{job.status === 'waiting_service' ? <IconButton label="取消任务" disabled={busy} onClick={() => void perform(async () => { await api(`/jobs/${job.id}/cancel`, { method: 'POST' }); await refresh(projectId) })}><X size={19} /></IconButton> : <IconButton label="重新编辑需求" disabled={busy} onClick={() => { editDraft(job.prompt); setRatio(health?.agentConfigured ? '1:1' : job.ratio); setAttachments(assets.filter(asset => job.assetIds.includes(asset.id))); setView('chat') }}><RefreshCw size={18} /></IconButton>}</article>)}{jobs.filter(job => filter === 'all' || job.status === filter).length === 0 && <div className="empty">没有符合条件的任务</div>}</div>}</section>}
        </Modal>
      </div>}
    </main>
    <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (!file) return; void perform(async () => { if (file.size > 12 * 1024 * 1024) throw new Error('图片不能超过 12MB'); const asset = await upload(file); if (view === 'chat') attachReference(asset); await refresh(projectId) }) }} />
    <Modal open={sidebarOpen} onOpenChange={setSidebarOpen} title="项目列表" className="project-drawer">{projectList}<div className="project-shortcuts"><button className="service-entry" type="button" disabled={!projectId} onClick={() => { setSidebarOpen(false); setView('images') }}><Images size={19} />素材库</button><button className="service-entry" type="button" disabled={!projectId} onClick={() => { setSidebarOpen(false); setFilter('all'); setView('tasks') }}><ListTodo size={19} />任务记录{waiting > 0 && <small>{waiting}</small>}</button><button className="service-entry" type="button" onClick={() => { setSidebarOpen(false); setStorageStatus('checking'); setServicesOpen(true) }}><Cpu size={19} />{health?.agentConfigured ? '服务状态' : '服务未接入'}</button></div></Modal>
    <Modal open={optionsOpen} onOpenChange={setOptionsOpen} title="设置">
      <div className="creation-options"><label className="ratio-control">图片比例<select aria-label="图片比例" value={ratio} disabled={busy} onChange={event => { setRatio(event.target.value as Ratio); submitRequest.current = null }}>{(health?.agentConfigured ? ['1:1', '3:2', '2:3'] : ['1:1', '4:3', '3:4', '16:9']).map(value => <option key={value}>{value}</option>)}</select></label></div>
      {health?.agentConfigured && <p className="image-cost">Azure image2 · 1张 · 低质量 · 按量计费</p>}
      <p className="session-info">视频生成未接入</p>
      {snapshot?.threadId && <p className="session-info">会话 {snapshot.threadId.slice(-8)}</p>}
    </Modal>
    <Modal open={!!resending} onOpenChange={open => { if (!open && !busy) setResending(null) }} title="重新发送这条消息？">
      <div className="resend-confirmation"><blockquote>{resending?.message.text}</blockquote><p>此消息之后的对话和任务记录将被清除，无法撤销。图片仍保留在素材库。</p>{health?.agentConfigured && <p>将重新调用模型，可能再次计费。</p>}<div className="actions"><button type="button" disabled={busy} onClick={() => setResending(null)}>取消</button><button type="button" className="primary" disabled={busy} onClick={() => void resend()}>{busy ? <LoaderCircle size={17} className="spin" /> : <RefreshCw size={17} />}清理并重新发送</button></div>{error && <p role="alert" className="form-error">{error}</p>}</div>
    </Modal>
    <Modal open={!!projectDialog} onOpenChange={open => { if (!open && !busy) setProjectDialog(null) }} title={projectDialog === 'rename' ? '重命名项目' : '新建项目'}><form className="project-form" onSubmit={event => void saveProject(event)}><label htmlFor="project-title">项目名称</label><input id="project-title" autoFocus required maxLength={80} value={projectName} placeholder="为这次创作命名" onChange={event => setProjectName(event.target.value)} /><button className="primary" disabled={busy || !projectName.trim()} type="submit">{busy ? <LoaderCircle size={17} className="spin" /> : <Check size={17} />}保存项目</button>{error && <p role="alert" className="form-error">{error}</p>}</form></Modal>
    <Modal open={servicesOpen} onOpenChange={setServicesOpen} title="服务状态"><div className="service-list"><p>{storageStatus === 'ready' ? <Check size={18} /> : <CirclePause size={18} />}<strong>本地数据</strong><span>{storageStatus === 'ready' ? 'SQLite 已连接' : storageStatus === 'checking' ? '检查中' : '连接失败'}</span></p><p><CirclePause size={18} /><strong>Codex / GPT-5.4</strong><span>{storageStatus === 'ready' && health?.agent === 'configured' ? '容器已配置' : '未连接'}</span></p><p><Cpu size={18} /><strong>OpenMontage</strong><span>{storageStatus === 'ready' && health?.openmontage === 'installed' ? '已安装' : '未连接'}</span></p><p><Images size={18} /><strong>Azure image2</strong><span>{storageStatus === 'ready' && health?.renderer === 'azure_image2' ? '已配置 · 按量计费' : '未连接'}</span></p><p><Cpu size={18} /><strong>ComfyUI / GPU</strong><span>未接入</span></p></div></Modal>
    <Viewer asset={selectedAsset} close={() => setSelectedAsset(null)} reference={attachReference} />
  </div>
}