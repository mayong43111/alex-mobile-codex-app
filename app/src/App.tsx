import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ButtonHTMLAttributes, CSSProperties, FormEvent, KeyboardEvent, ReactNode } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { TransformWrapper, TransformComponent } from 'react-zoom-pan-pinch'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ArrowDownToLine, ArrowUp, Check, ChevronRight, CirclePause, Copy, Cpu, Folder, ImagePlus, ImageOff, Images, ListTodo, LoaderCircle, Maximize, MessageSquare, PanelLeft, Plus, RefreshCw, Search, Square, X, ZoomIn, ZoomOut, Aperture, Settings, Trash2, Power, RotateCw, Paperclip, FileText, Film, Pencil, Camera } from 'lucide-react'
import type { AgentRun, Asset, ImageModel, VideoModel, Job, Message, Project, Ratio, Quality, Snapshot, Submission } from './domain'
import { assetHasThumbnail, defaultUserSettings, imageModels, imageModelNames, ratios } from './domain'
import type { AgentInput, UserSettings } from './domain'
import type { VmStatus, VmAction, VmProfile, VmProfileInput, VmProfiles } from '../server/vm'
import './MobileApp.css'
import { authenticatedFetch } from './auth-client'
import type { SignedInUser } from './auth-client'
import { ShareAssetButton } from './ShareAssetButton'
import type { PoseDraft } from './PoseStudio'
import ModelShoot from './ModelShoot'
import type { ShootReferences, ShootRole, ShootSubmission } from './ModelShoot'

const PoseStudio = lazy(() => import('./PoseStudio'))

function RatioOptions() {
  return ratios.map(value => <option key={value} value={value}>{value === 'auto' ? '由AI决定' : value}</option>)
}

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await authenticatedFetch(`/api${path}`, options)
  if (!response.ok) {
    const detail = await response.json().catch(() => null)
    throw new Error(detail?.error ?? `请求失败 (${response.status})`)
  }
  return response.json()
}
const json = (method: string, payload: unknown): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
function mergeLatest(previous: Snapshot | null, latest: Snapshot): Snapshot {
  if (!previous || previous.project.id !== latest.project.id || previous.messages.length <= 10 || !latest.messages.length) return latest
  const overlap = previous.messages.findIndex(message => message.id === latest.messages[0].id)
  if (overlap <= 0) return latest
  const messages = [...previous.messages.slice(0, overlap), ...latest.messages]
  const oldIds = new Set(previous.messages.slice(0, overlap).map(message => message.id))
  const latestRunIds = new Set(latest.runs.map(run => run.messageId))
  return { ...latest, messages,
    runs: [...previous.runs.filter(run => (oldIds.has(run.messageId) || oldIds.has(run.assistantId)) && !latestRunIds.has(run.messageId)), ...latest.runs],
    jobs: [...previous.jobs.filter(job => oldIds.has(job.messageId)), ...latest.jobs],
    page: latest.page ? { ...latest.page, before: previous.page?.before ?? null } : undefined }
}
const imageUrl = (asset: Asset, thumbnail = true) => `/api/assets/${asset.id}/content${thumbnail ? '?thumbnail=1' : ''}`
const fileSize = (bytes: number) => bytes < 1024 * 1024 ? `${Math.max(1, Math.ceil(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`
const assetDetails = (asset: Asset) => `${asset.width && asset.height ? `${asset.width} × ${asset.height} · ` : ''}${asset.duration ? `${asset.duration.toFixed(2)} 秒 · ` : ''}${fileSize(asset.bytes)}`
function AssetImage({ asset, thumbnail = true }: { asset: Asset; thumbnail?: boolean }) {
  const [state, setState] = useState<'loading' | 'loaded' | 'failed'>('loading')
  const label = state === 'failed' ? '图片加载失败' : '图片加载中'
  return <span className="asset-image-frame" data-state={state} style={{ '--image-ratio': asset.width > 0 && asset.height > 0 ? `${asset.width} / ${asset.height}` : '1' } as CSSProperties}>
    <img src={imageUrl(asset, thumbnail)} alt={asset.name} width={asset.width || undefined} height={asset.height || undefined} loading={thumbnail ? 'lazy' : 'eager'} onLoad={() => setState('loaded')} onError={() => setState('failed')} />
    {state !== 'loaded' && <span className="asset-image-status" role="status" aria-label={label} title={label}>{state === 'failed' ? <ImageOff size={22} aria-hidden="true" /> : <LoaderCircle size={22} className="spin" aria-hidden="true" />}</span>}
  </span>
}
function AssetPreview({ asset }: { asset: Asset }) {
  return assetHasThumbnail(asset) ? <AssetImage key={asset.id} asset={asset} /> : <span className="file-preview" aria-label={asset.name}>{asset.mediaType === 'video' ? <Film size={28} /> : <FileText size={28} />}</span>
}
const time = (value: string) => new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
type Health = { storage: string; agentConfigured?: boolean; agent: string; renderer: string; openmontage?: string; models?: { images: ImageModel[]; videos: Exclude<VideoModel, 'none'>[] } }
const runLabel = (run: AgentRun) => ({ queued: '等待处理', running: run.story?.stopRequested ? '正在停止后续步骤' : run.story ? run.story.phase === 'stitching' ? '正在拼接故事' : `故事制作 · 已保存 ${run.processedAssetIds?.length ?? 0}/${run.story.segments.length} 段` : run.avatarJobId ? '正在制作口播' : run.stage === 'video' ? '正在生成视频' : run.stage === 'image' ? run.imageOperation === 'edit' ? '正在修改图片' : '正在生成图片' : 'Codex 正在回复', completed: '已完成', failed: '失败', cancelled: '已停止', interrupted: '结果待核实' })[run.status]
const runModel = (run: AgentRun) => run.avatarJobId ? 'OpenMontage · SadTalker' : run.stage === 'video' ? 'MiniMax H3 · 24fps' : run.stage === 'image' ? `${imageModelNames[run.input.imageModel ?? 'azure-image2']} · ${run.input.imageModel === 'qwen-image-2.1' ? 'BF16' : '1 张'}` : 'Codex · GPT-5.4'
const qualityNames = { low: '低', medium: '中', high: '高' }
const references = [
  { name: '午后空间', file: '/reference-interior.jpg', prompt: '保留空间结构，营造午后自然光下安静、通透的室内氛围。' },
  { name: '静物与光', file: '/reference-still-life.jpg', prompt: '参考这张图片的构图，创作一幅自然光静物照片，保留细腻材质。' },
]
const creationGuides = {
  image: { title: '做图片', icon: Images, subject: '画面内容', placeholder: '例如：窗边的一束白色花，清晨自然光', detail: null, prefix: '请生成一张图片。' },
  edit: { title: '修改图片', icon: ImagePlus, subject: '修改要求', placeholder: '例如：把背景换成浅灰色，保留主体', detail: '需要保留的内容', prefix: '请修改我明确指定的原图，另存结果，不覆盖原图。' },
}
type CreationGuide = keyof typeof creationGuides

function IconButton({ label, children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; children: ReactNode }) {
  return <button type="button" className="icon-button" aria-label={label} title={label} {...props}>{children}</button>
}

function Modal({ open, onOpenChange, title, children, className = '' }: { open: boolean; onOpenChange: (open: boolean) => void; title: string; children: ReactNode; className?: string }) {
  return <Dialog.Root open={open} onOpenChange={onOpenChange}><Dialog.Portal>
    <Dialog.Overlay className="overlay" />
    <Dialog.Content className={`modal ${className}`} aria-describedby={undefined} onEscapeKeyDown={event => {
      if (event.target instanceof HTMLElement && (event.target.closest('.pose-viewport')?.getAttribute('data-selected-joint') || event.target.closest('.pose-studio[data-fullscreen=true]'))) event.preventDefault()
    }}>
      <div className="modal-heading"><Dialog.Title>{title}</Dialog.Title><Dialog.Close asChild><IconButton label="关闭"><X size={20} /></IconButton></Dialog.Close></div>
      {children}
    </Dialog.Content>
  </Dialog.Portal></Dialog.Root>
}

function ReferenceLibrary({ projects, currentProjectId, select, remove, rename, revision }: { projects: Project[]; currentProjectId: string; select: (asset: Asset) => Promise<void>; remove: (asset: Asset) => void; rename: (asset: Asset, name: string) => Promise<void>; revision: number }) {
  const [images, setImages] = useState<Asset[]>([])
  const [loadedRequest, setLoadedRequest] = useState('')
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [project, setProject] = useState(currentProjectId)
  const [limit, setLimit] = useState(48)
  const [retry, setRetry] = useState(0)
  const [selecting, setSelecting] = useState('')
  const [editing, setEditing] = useState<Asset | null>(null)
  const [name, setName] = useState('')
  const [renameError, setRenameError] = useState('')
  const requestKey = `${project}:${revision}:${retry}`
  const loading = loadedRequest !== requestKey
  useEffect(() => {
    const controller = new AbortController()
    void api<Asset[]>(`/references${project ? `?${new URLSearchParams({ projectId: project })}` : ''}`, { signal: controller.signal }).then(result => { if (!controller.signal.aborted) { setImages(result); setError('') } }).catch(failure => {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : '参考图加载失败')
    }).finally(() => { if (!controller.signal.aborted) setLoadedRequest(requestKey) })
    return () => controller.abort()
  }, [retry, revision, project, requestKey])
  const matching = images.filter(asset => (!project || asset.projectId === project) && asset.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
  async function choose(asset: Asset) {
    if (selecting) return
    setSelecting(asset.id); setError('')
    try { await select(asset) }
    catch (failure) { setError(failure instanceof Error ? failure.message : '参考图选用失败') }
    finally { setSelecting('') }
  }
  async function saveName(event: FormEvent) {
    event.preventDefault()
    if (!editing || selecting || !name.trim()) return
    setSelecting(editing.id); setRenameError('')
    try { await rename(editing, name.trim()); setEditing(null) }
    catch (failure) { setRenameError(failure instanceof Error ? failure.message : '名称修改失败') }
    finally { setSelecting('') }
  }
  return <><section className="reference-library" aria-busy={loading || !!selecting}>
    <div className="reference-toolbar"><label className="search"><Search size={16} /><input aria-label="搜索参考图" placeholder="搜索图片名称" value={query} onChange={event => { setQuery(event.target.value); setLimit(48) }} /></label><select aria-label="参考图来源项目" value={project} onChange={event => { setProject(event.target.value); setLimit(48) }}><option value="">全部项目</option>{projects.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select><IconButton label="刷新参考图库" disabled={loading || !!selecting} onClick={() => setRetry(value => value + 1)}><RefreshCw size={18} /></IconButton></div>
    <div className="reference-results">
    {error && <p className="form-error" role="alert">{error}</p>}
    {loading ? <div className="empty" role="status"><LoaderCircle className="spin" />正在读取参考图</div> : <><p className="reference-count" role="status">{matching.length} 张参考图{selecting ? ' · 正在处理' : ''}</p>{!matching.length ? <div className="empty"><Images size={28} /><h2>{images.length || query.trim() ? '没有匹配的参考图' : '暂无图片'}</h2></div> : <div className="asset-grid reference-grid">{matching.slice(0, limit).map(asset => <div className="image-collection-item" key={asset.id}><button type="button" className="asset" aria-label={`选用参考图 ${asset.name}`} disabled={!!selecting} onClick={() => void choose(asset)}><div className="asset-image"><AssetImage asset={asset} /><span className="asset-kind">{selecting === asset.id ? <LoaderCircle size={15} className="spin" /> : <ImagePlus size={15} />}</span></div><strong title={asset.name}>{asset.name}</strong><small>{asset.kind === 'generated' ? '生成' : '上传'} · {projects.find(item => item.id === asset.projectId)?.title ?? '历史项目'}</small><small>{assetDetails(asset)}</small></button><div className="reference-item-actions"><IconButton label={`修改图片名称 ${asset.name}`} disabled={!!selecting} onClick={() => { setEditing(asset); setName(asset.name); setRenameError('') }}><Pencil size={17} /></IconButton><IconButton label={`删除参考图 ${asset.name}`} disabled={!!selecting} onClick={() => remove(asset)}><Trash2 size={17} /></IconButton></div></div>)}</div>}{matching.length > limit && <button type="button" className="reference-more" onClick={() => setLimit(value => value + 48)}>加载更多</button>}</>}
    </div>
  </section><Modal open={!!editing} onOpenChange={open => { if (!open && !selecting) setEditing(null) }} title="修改图片名称"><form className="project-form" onSubmit={event => void saveName(event)}><label htmlFor="reference-name">图片名称</label><input id="reference-name" autoFocus required maxLength={160} value={name} disabled={!!selecting} onChange={event => setName(event.target.value)} /><div className="actions"><button type="button" disabled={!!selecting} onClick={() => setEditing(null)}>取消</button><button className="primary" type="submit" disabled={!!selecting || !name.trim()}>{selecting ? <LoaderCircle size={17} className="spin" /> : <Check size={17} />}保存名称</button></div>{renameError && <p role="alert" className="form-error">{renameError}</p>}</form></Modal></>
}

function RunProgress({ run }: { run: AgentRun }) {
  const [open, setOpen] = useState(false)
  const [fetchedEntries, setEntries] = useState<NonNullable<AgentRun['progress']>>([])
  const entries = run.progress ?? fetchedEntries
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    if (!open || run.progress) return
    let active = true
    api<NonNullable<AgentRun['progress']>>(`/agent-runs/${run.id}/progress`).then(result => { if (active) { setEntries(result); setError('') } }).catch(() => { if (active) setError('过程加载失败') })
    return () => { active = false }
  }, [open, run.id, run.updatedAt, run.progress, retry])
  const running = run.status === 'running' || run.status === 'queued'
  return <details className="run-progress" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary aria-label="处理过程" title="处理过程"><Aperture size={16} /><strong>Codex</strong><span className="progress-state">{running && <LoaderCircle size={13} className="spin" />}{runLabel(run)}</span><ChevronRight size={14} className="progress-chevron" /></summary>
    {open && (error ? <p role="alert">{error}<IconButton label="重试加载过程" onClick={() => setRetry(value => value + 1)}><RefreshCw size={16} /></IconButton></p> : entries.length ? <ol>{entries.map(entry => <li key={entry.id}><div className="progress-heading"><strong>{entry.label}</strong><time dateTime={entry.createdAt}>{time(entry.createdAt)}</time></div>{entry.detail && (entry.id.startsWith('codex:') ? <pre>{entry.detail}</pre> : <p>{entry.detail}</p>)}</li>)}</ol> : <p className="progress-empty">{running ? (run.status === 'queued' ? '等待开始处理' : '等待 Codex 运行事件') : '此运行未记录详细过程'}</p>)}
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

function MarkdownReply({ text }: { text: string }) {
  return <div className="markdown-reply"><Markdown remarkPlugins={[remarkGfm]} skipHtml components={{
    a: ({ href, children }) => href ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> : <span>{children}</span>,
    img: ({ alt }) => <span>{alt}</span>,
    table: ({ children }) => <div className="markdown-table" role="region" aria-label="回复表格" tabIndex={0}><table>{children}</table></div>,
  }}>{text}</Markdown></div>
}

function LocalAccounts() {
  const [accounts, setAccounts] = useState<{ id: string; username: string; name: string }[]>([])
  const [username, setUsername] = useState('')
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [reset, setReset] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  useEffect(() => { void api<typeof accounts>('/auth/users').then(setAccounts).catch(() => setMessage('无法读取账号')) }, [])
  async function save(event: FormEvent) {
    event.preventDefault(); setBusy(true); setMessage('')
    try {
      await api('/auth/users', json('POST', { username, name, password, reset }))
      setPassword(''); setUsername(''); setName(''); setReset(false)
      setAccounts(await api('/auth/users'))
      setMessage('账号已保存')
    } catch (failure) { setMessage(failure instanceof Error ? failure.message : '保存失败') }
    finally { setBusy(false) }
  }
  return <details className="local-accounts"><summary>本地账号管理</summary><ul>{accounts.map(account => <li key={account.id}><span>{account.name} <small>{account.username}</small></span><IconButton label={`重置 ${account.username} 密码`} disabled={busy} onClick={() => { setUsername(account.username); setName(account.name); setPassword(''); setReset(true); setMessage('') }}><RotateCw size={17} /></IconButton></li>)}</ul><form onSubmit={event => void save(event)}><label>账号<input autoComplete="off" autoCapitalize="none" required pattern="[a-z0-9][a-z0-9._-]{2,63}" maxLength={64} disabled={reset || busy} value={username} onChange={event => setUsername(event.target.value)} /></label><label>显示名称<input required maxLength={80} value={name} disabled={busy} onChange={event => setName(event.target.value)} /></label><label>新密码<input type="password" autoComplete="new-password" required minLength={12} maxLength={256} disabled={busy} value={password} onChange={event => setPassword(event.target.value)} /></label><button className="primary" disabled={busy} type="submit"><Check size={17} />{reset ? '确认重置密码' : '创建账号'}</button>{reset && <button type="button" disabled={busy} onClick={() => { setReset(false); setUsername(''); setName(''); setPassword('') }}>取消重置</button>}<p role="status">{message}</p></form></details>
}

function ReplyAssets({ ids, assets, select }: { ids: string[]; assets: Asset[]; select: (asset: Asset) => void }) {
  if (!ids.length) return null
  return <div className="message-images">{ids.map(id => {
    const asset = assets.find(item => item.id === id)
    if (!asset) return null
    return asset.mediaType === 'video' ? <div className="video-result" key={id}>
      <video className="generated-video" controls playsInline preload="metadata" poster={assetHasThumbnail(asset) ? imageUrl(asset) : undefined} src={imageUrl(asset, false)} aria-label={asset.name} />
      <div className="video-meta"><span>{asset.model === 'minimax-h3' ? 'MiniMax H3' : asset.name} · {asset.duration?.toFixed(2)} 秒</span><a className="icon-button" href={`${imageUrl(asset, false)}?download=1`} download target="_blank" rel="noopener noreferrer" aria-label="下载视频" title="下载视频"><ArrowDownToLine size={18} /></a><ShareAssetButton asset={asset} /></div>
    </div> : asset.mediaType === 'file' ? <button className="message-file" key={id} onClick={() => select(asset)}><AssetPreview asset={asset} /><span>{asset.name}<small>{fileSize(asset.bytes)}</small></span></button> : <button key={id} onClick={() => select(asset)}><AssetImage asset={asset} /></button>
  })}</div>
}

function NarrationTimeline({ run, assets, select, connected }: { run: AgentRun; assets: Asset[]; select: (asset: Asset) => void; connected: boolean }) {
  const story = run.story
  const clips = (run.processedAssetIds ?? []).flatMap(id => assets.filter(asset => asset.id === id && asset.mediaType === 'video'))
  const segments = story ? story.segments.map(segment => ({ text: segment.text, continueFromPrevious: false })) : run.narration?.segments ?? clips.map(clip => ({ text: clip.narration ?? '', continueFromPrevious: false }))
  const progress = story ? { phase: story.phase, segment: story.segment } : run.narration?.progress
  const scriptAssetId = story?.scriptAssetId ?? run.narration?.scriptAssetId
  const active = ['running', 'queued'].includes(run.status)
  const stopping = active && (story?.stopRequested || run.narration?.stopRequested)
  const labels = { script: story ? '故事分镜已保存' : '分段剧本已保存', speech: `第 ${progress?.segment} 段配音中`, queued: '等待 GPU 开始', rendering: `第 ${progress?.segment} 段视频生成中`, tail: `第 ${progress?.segment} 段尾帧提取中`, stitching: '正在拼接整片', completed: '整片已生成，正在入库', stopped: '后续步骤已停止' }
  const status = active && !connected ? '连接已断开，正在同步项目状态' : stopping ? '正在停止后续步骤' : run.status === 'completed' ? '整片已保存' : run.status === 'cancelled' ? '后续步骤已停止' : run.status === 'failed' ? '制作失败，已完成素材保留' : run.status === 'interrupted' ? '执行结果待核实，已有素材保留' : progress ? labels[progress.phase] : '正在准备口播'
  return <section className="narration-timeline" aria-label={story ? '故事制作' : '口播制作'}>
    <div className="narration-heading"><strong>{story?.title ?? '分段剧本'}</strong>{scriptAssetId && <a className="icon-button" href={`/api/assets/${scriptAssetId}/content?download=1`} download target="_blank" rel="noopener noreferrer" aria-label={story ? '下载故事分镜' : '下载分段剧本'} title={story ? '下载故事分镜' : '下载分段剧本'}><ArrowDownToLine size={18} /></a>}</div>
    <p className="narration-status" role="status" aria-label={story ? '故事制作进度' : '口播制作进度'}>{active ? <LoaderCircle size={16} className="spin" /> : run.status === 'completed' ? <Check size={16} /> : <Square size={16} />}<span>{status} · 已保存 {clips.length} / {segments.length} 段</span></p>
    {stopping && <p className="narration-notice">当前已提交的步骤可能继续完成并计费，完成的素材会保留。</p>}
    <ol>{segments.map((segment, index) => {
      const clip = clips[index]
      const tail = clip && assets.find(asset => run.processedAssetIds?.includes(asset.id) && asset.sourceAssetId === clip.id && (asset.mediaType ?? 'image') === 'image')
      const current = active && progress?.segment === index + 1 && ['speech', 'rendering', 'tail'].includes(progress.phase)
      return <li key={index}>
        <div className="narration-heading"><strong>第 {index + 1} 段</strong><span>{clip ? '已入库' : current ? labels[progress!.phase] : active ? stopping ? '等待停止确认' : '待生成' : '未完成'}</span></div>
        {segment.text && <p>{segment.text}</p>}
        {run.narration && <small>{segment.continueFromPrevious ? '沿用上一段实际尾帧' : '使用指定原图'}</small>}
        {clip && <ReplyAssets ids={[clip.id]} assets={assets} select={select} />}
        {tail && <details className="narration-tail"><summary>第 {index + 1} 段尾帧</summary><ReplyAssets ids={[tail.id]} assets={assets} select={select} /></details>}
      </li>
    })}</ol>
  </section>
}

function ImagePending({ run, connected }: { run: AgentRun; connected: boolean }) {
  if (run.avatarJobId || run.story || run.status !== 'running' || !['image', 'video'].includes(run.stage)) return null
  return <div className="image-pending" role="status" aria-label={run.stage === 'video' ? '视频生成中' : '图片生成中'} aria-live="polite" aria-busy="true"><LoaderCircle size={24} className="spin" aria-hidden="true" /><span>{connected ? runLabel(run) : '连接已断开，正在同步生成状态'}</span></div>
}

function Viewer({ asset, close, reference, remove, deletingDisabled }: { asset: Asset | null; close: () => void; reference: (asset: Asset) => void; remove: (asset: Asset) => void; deletingDisabled: boolean }) {
  return <Modal open={!!asset} onOpenChange={open => { if (!open) close() }} title={asset?.name ?? '图片'} className="viewer">
    {asset?.mediaType === 'file' ? <div className="file-viewer"><AssetPreview asset={asset} /><p>{asset.mimeType ?? '文件'} · {fileSize(asset.bytes)}</p><div className="actions"><a className="icon-button" href={`${imageUrl(asset, false)}?download=1`} download target="_blank" rel="noopener noreferrer" aria-label="下载文件" title="下载文件"><ArrowDownToLine size={19} /></a><ShareAssetButton key={asset.id} asset={asset} /><button className="primary" onClick={() => reference(asset)}><Paperclip size={17} />附加到对话</button></div></div> : asset?.mediaType === 'video' ? <><video className="generated-video" controls playsInline preload="metadata" poster={assetHasThumbnail(asset) ? imageUrl(asset) : undefined} src={imageUrl(asset, false)} aria-label={asset.name} /><div className="viewer-footer"><span>{assetDetails(asset)}</span><div className="actions"><a className="icon-button" href={`${imageUrl(asset, false)}?download=1`} download target="_blank" rel="noopener noreferrer" aria-label="下载视频" title="下载视频"><ArrowDownToLine size={19} /></a><ShareAssetButton key={asset.id} asset={asset} /><button className="primary" onClick={() => reference(asset)}><Paperclip size={17} />附加到对话</button></div></div></> : asset && <TransformWrapper initialScale={1} minScale={0.5} maxScale={8}>
      {({ zoomIn, zoomOut, resetTransform }) => <>
        <div className="image-stage"><TransformComponent wrapperClass="zoom-wrapper" contentClass="zoom-content"><AssetImage key={asset.id} asset={asset} thumbnail={false} /></TransformComponent></div>
        <div className="viewer-footer"><span>{asset.width} × {asset.height} · {asset.kind === 'generated' ? `${asset.provider} / ${asset.model}` : '参考图'}</span><div className="actions">
          <IconButton label="放大" onClick={() => zoomIn()}><ZoomIn size={19} /></IconButton><IconButton label="缩小" onClick={() => zoomOut()}><ZoomOut size={19} /></IconButton><IconButton label="重置缩放" onClick={() => resetTransform()}><Maximize size={19} /></IconButton>
          <a className="icon-button" href={`${imageUrl(asset, false)}?download=1`} download target="_blank" rel="noopener noreferrer" aria-label="下载图片" title="下载图片"><ArrowDownToLine size={19} /></a>
          <ShareAssetButton key={asset.id} asset={asset} />
          <IconButton label="删除当前图片" disabled={deletingDisabled} onClick={() => remove(asset)}><Trash2 size={19} /></IconButton>
          <button className="primary" onClick={() => reference(asset)}><ImagePlus size={17} />用作参考</button>
        </div></div>
      </>}
    </TransformWrapper>}
  </Modal>
}

function VmPanel() {
  const [catalog, setCatalog] = useState<VmProfiles | null>(null)
  const [selectedId, setSelectedId] = useState(() => localStorage.getItem('studio-vm-profile') ?? '')
  const [editing, setEditing] = useState<{ id?: string; profile: VmProfileInput } | null>(null)
  const [saving, setSaving] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [revisionKey, setRevisionKey] = useState(0)
  useEffect(() => {
    let active = true
    void api<VmProfiles>('/vm/profiles').then(result => {
      if (!active) return
      setCatalog(result); setError('')
      setSelectedId(current => result.profiles.some(profile => profile.id === current) ? current : result.profiles[0]?.id ?? '')
    }).catch(failure => { if (active) setError(failure instanceof Error ? failure.message : 'VM 配置读取失败') })
    return () => { active = false }
  }, [revisionKey])
  const profile = catalog?.profiles.find(item => item.id === selectedId)
  function select(id: string) { setSelectedId(id); localStorage.setItem('studio-vm-profile', id); setEditing(null); setError('') }
  async function save(event: FormEvent) {
    event.preventDefault()
    if (!editing || !catalog || saving) return
    setSaving(true); setError('')
    try {
      const result = await api<VmProfiles>(`/vm/profiles${editing.id ? `/${editing.id}` : ''}`, json(editing.id ? 'PUT' : 'POST', { profile: editing.profile, revision: catalog.revision }))
      setCatalog(result)
      select(editing.id ?? result.profiles.at(-1)!.id)
    } catch (failure) { setError(failure instanceof Error ? failure.message : '配置保存失败') }
    finally { setSaving(false) }
  }
  return <div className="vm-manager">
    {catalog && <div className="vm-profile-toolbar">
      <label>VM 配置<select aria-label="VM 配置" value={selectedId} disabled={saving || submitting || !catalog.profiles.length} onChange={event => select(event.target.value)}>{!catalog.profiles.length && <option value="">暂无配置</option>}{catalog.profiles.map(item => <option key={item.id} value={item.id}>{item.label} · {item.name}</option>)}</select></label>
      {catalog.canManage && <><IconButton label="新增 VM 配置" disabled={saving || submitting} onClick={() => { setEditing({ profile: { label: '', subscription: '', resourceGroup: '', name: '', comfyUrl: '' } }); setError('') }}><Plus size={18} /></IconButton><IconButton label="编辑 VM 配置" disabled={!profile || saving || submitting} onClick={() => { if (profile) { const { id, ...input } = profile; setEditing({ id, profile: input }); setError('') } }}><Pencil size={18} /></IconButton></>}
      <IconButton label="刷新 VM 配置" disabled={saving || submitting} onClick={() => { setEditing(null); setRevisionKey(value => value + 1) }}><RefreshCw size={18} /></IconButton>
    </div>}
    {editing && <form className="vm-profile-form" onSubmit={event => void save(event)}>
      <h3>{editing.id ? '编辑 VM 配置' : '新增 VM 配置'}</h3>
      {([{ key: 'label', label: '配置名称', max: 80 }, { key: 'subscription', label: '订阅 ID', max: 36 }, { key: 'resourceGroup', label: '资源组', max: 90 }, { key: 'name', label: 'VM 名称', max: 64 }, { key: 'comfyUrl', label: 'ComfyUI 私网地址', max: 2048 }] as const).map(field => <label key={field.key}>{field.label}<input required type={field.key === 'comfyUrl' ? 'url' : 'text'} autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={field.max} disabled={saving} value={editing.profile[field.key]} onChange={event => setEditing({ ...editing, profile: { ...editing.profile, [field.key]: event.target.value } })} /></label>)}
      <div className="vm-confirm-actions"><button type="button" disabled={saving} onClick={() => { setEditing(null); setError('') }}>取消</button><button className="primary" type="submit" disabled={saving}>{saving ? <LoaderCircle size={17} className="spin" /> : <Check size={17} />}保存配置</button></div>
    </form>}
    {error && <p role="alert" className="form-error">{error}</p>}
    {!catalog && !error && <p role="status">正在读取 VM 配置</p>}
    {!catalog && error && <button type="button" onClick={() => setRevisionKey(value => value + 1)}><RefreshCw size={17} />重试读取配置</button>}
    {catalog && !editing && <VmInstancePanel key={`${selectedId}:${catalog.revision}`} profile={profile} revision={catalog.revision} onSubmitting={setSubmitting} />}
  </div>
}

function VmInstancePanel({ profile, revision, onSubmitting }: { profile?: VmProfile; revision: string; onSubmitting: (busy: boolean) => void }) {
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
      try { const result = await api<VmStatus>(`/vm${profile ? `?profileId=${profile.id}` : ''}`, { signal: AbortSignal.timeout(15000) }); if (active) { setStatus(result); setStatusError(''); setCheckedAt(new Date().toISOString()) } }
      catch (failure) { if (active) setStatusError(failure instanceof Error ? failure.message : 'VM 状态读取失败') }
      finally { checking = false; if (active) setRefreshing(false) }
    }
    void refresh()
    const timer = setInterval(() => void refresh(), 10000)
    return () => { active = false; clearInterval(timer) }
  }, [refreshKey, profile])
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
    setBusy(true); onSubmitting(true); setError('')
    try {
      setStatus(await api<VmStatus>('/vm/actions', { ...json('POST', { ...confirmation, confirmedName: status.name, force, ...(profile ? { profileId: profile.id, revision } : {}) }), signal: AbortSignal.timeout(30000) }))
      setConfirmation(null); setForce(false)
    } catch (failure) {
      setError(failure instanceof Error && failure.name === 'TimeoutError' ? '请求超时，正在核实原操作；未自动重试。' : failure instanceof Error ? failure.message : 'VM 操作失败')
      setConfirmation(null); setForce(false)
      setStatusError('正在核实 VM 操作结果')
      setRefreshKey(value => value + 1)
    }
    finally { setBusy(false); onSubmitting(false) }
  }
  return <div className="vm-panel">
    <div className="vm-identity"><Cpu size={24} aria-hidden="true" /><div><span>GPU 实例</span><strong>{profile?.name ?? status?.name ?? 'VM'}</strong></div><IconButton label="刷新 VM 状态" disabled={refreshing || busy} onClick={() => setRefreshKey(value => value + 1)}><RefreshCw size={18} className={refreshing ? 'spin' : ''} /></IconButton></div>
    {profile && <dl className="vm-profile-details"><div><dt>订阅</dt><dd>{profile.subscription}</dd></div><div><dt>资源组</dt><dd>{profile.resourceGroup}</dd></div><div><dt>ComfyUI</dt><dd>{profile.comfyUrl}</dd></div></dl>}
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
    {(statusError || error) && <p role="alert" className="form-error">{[error, statusError].filter(Boolean).join(' ')}</p>}
    {status?.operation?.error && <p className="form-error">{status.operation.error}</p>}
    {checkedAt && <p className="vm-updated">上次同步 <time dateTime={checkedAt}>{time(checkedAt)}</time></p>}
  </div>
}

export default function App({ user, onLogout }: { user?: SignedInUser | null; onLogout?: () => Promise<void> }) {
  const [projects, setProjects] = useState<Project[]>([])
  const [projectId, setProjectId] = useState('')
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [view, setView] = useState<'chat' | 'images' | 'works' | 'tasks'>('chat')
  const [draft, setDraft] = useState('')
  const [ratio, setRatio] = useState<Ratio>(defaultUserSettings.ratio)
  const [quality, setQuality] = useState<Quality>(defaultUserSettings.quality)
  const [imageModel, setImageModel] = useState<ImageModel>(defaultUserSettings.imageModel)
  const [videoModel, setVideoModel] = useState<VideoModel>(defaultUserSettings.videoModel)
  const [settingsReady, setSettingsReady] = useState(false)
  const [savingSettings, setSavingSettings] = useState(false)
  const settingsWrite = useRef(false)
  const [settingsError, setSettingsError] = useState('')
  const [settingsLoadAttempt, setSettingsLoadAttempt] = useState(0)
  const [attachments, setAttachments] = useState<Asset[]>([])
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState('all')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [connected, setConnected] = useState(false)
  const [uploading, setUploading] = useState('')
  const uploadController = useRef<AbortController | null>(null)
  useEffect(() => () => uploadController.current?.abort(), [])
  const [initializing, setInitializing] = useState(true)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [projectDialog, setProjectDialog] = useState<'new' | 'rename' | null>(null)
  const [projectName, setProjectName] = useState('')
  const [selectedAsset, setSelectedAsset] = useState<Asset | null>(null)
  const [servicesOpen, setServicesOpen] = useState(false)
  const [optionsOpen, setOptionsOpen] = useState(false)
  const [vmOpen, setVmOpen] = useState(false)
  const [guide, setGuide] = useState<CreationGuide | null>(null)
  const [guidesOpen, setGuidesOpen] = useState(false)
  const [poseOpen, setPoseOpen] = useState(false)
  const [poseDraft, setPoseDraft] = useState<PoseDraft>({ angles: null, presetId: 'ual1Idle' })
  const [shootOpen, setShootOpen] = useState(false)
  const [shootBusy, setShootBusy] = useState(false)
  const [shootPoseOpen, setShootPoseOpen] = useState(false)
  const [shootReferences, setShootReferences] = useState<ShootReferences>({ model: null, pose: null, product: null })
  const shootRequest = useRef<{ signature: string; projectId: string; body: AgentInput } | null>(null)
  const [brief, setBrief] = useState('')
  const [briefExpanded, setBriefExpanded] = useState(false)
  const [briefDetail, setBriefDetail] = useState('')
  const [sourceId, setSourceId] = useState('')
  const [sourceFile, setSourceFile] = useState<File | null>(null)
  const [referenceTarget, setReferenceTarget] = useState<'chat' | 'creation' | `shoot-${ShootRole}` | null>(null)
  const creationRequest = useRef<{ signature: string; projectId: string; body: AgentInput } | null>(null)
  const [deleting, setDeleting] = useState<Project | null>(null)
  const [deletingAsset, setDeletingAsset] = useState<Asset | null>(null)
  const [clearingConversation, setClearingConversation] = useState<Project | null>(null)
  const [referenceRevision, setReferenceRevision] = useState(0)
  const [resending, setResending] = useState<{ message: Message; text: string; requestId: string; expectedTailId: string } | null>(null)
  const [loadingHistory, setLoadingHistory] = useState(false)
  const [historyError, setHistoryError] = useState('')
  const historyRequest = useRef<symbol | null>(null)
  const historyAnchor = useRef<{ height: number; top: number } | null>(null)
  const latestRequest = useRef(0)
  const [taskRecords, setTaskRecords] = useState<Pick<Snapshot, 'runs' | 'jobs'> | null>(null)
  const [storageStatus, setStorageStatus] = useState<'checking' | 'ready' | 'offline'>('checking')
  const [health, setHealth] = useState<Health | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const draftInput = useRef<HTMLTextAreaElement>(null)
  const [expandedDraftProject, setExpandedDraftProject] = useState<string | null>(null)
  const draftExpanded = !!projectId && expandedDraftProject === projectId
  const conversationScroll = useRef<HTMLDivElement>(null)
  const followConversation = useRef(true)
  const conversationReady = !initializing && settingsReady && !savingSettings && snapshot !== null
  useLayoutEffect(() => {
    const viewport = conversationScroll.current
    if (viewport && historyAnchor.current) {
      viewport.scrollTop = historyAnchor.current.top + viewport.scrollHeight - historyAnchor.current.height
      historyAnchor.current = null
    }
  }, [snapshot])
  useEffect(() => {
    const viewport = conversationScroll.current
    const content = viewport?.firstElementChild
    if (!viewport || !content || !conversationReady) return
    followConversation.current = true
    let previousTop = viewport.scrollTop
    const follow = () => {
      if (followConversation.current) {
        viewport.scrollTop = viewport.scrollHeight
        previousTop = viewport.scrollTop
      }
    }
    const onScroll = () => {
      const nearBottom = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop < 48
      if (viewport.scrollTop < previousTop || nearBottom) followConversation.current = nearBottom
      previousTop = viewport.scrollTop
    }
    follow()
    viewport.addEventListener('scroll', onScroll, { passive: true })
    const observer = new ResizeObserver(follow)
    observer.observe(viewport)
    observer.observe(content)
    return () => { observer.disconnect(); viewport.removeEventListener('scroll', onScroll) }
  }, [projectId, conversationReady])
  useEffect(() => {
    const input = draftInput.current
    if (!input) return
    input.style.height = 'auto'
    input.style.height = `${Math.min(input.scrollHeight, Number.parseFloat(getComputedStyle(input).maxHeight))}px`
  }, [draft, view, draftExpanded])
  const submitRequest = useRef<{ projectId: string; body: Submission & { imageModel?: ImageModel; videoModel?: VideoModel; quality?: Quality }; mode?: 'auto' } | null>(null)
  const currentProject = useRef(projectId)
  useEffect(() => { currentProject.current = projectId }, [projectId])

  function switchProject(id: string) {
    uploadController.current?.abort()
    currentProject.current = id
    setGuide(null)
    setReferenceTarget(null)
    setDeletingAsset(null); setClearingConversation(null)
    setGuidesOpen(false)
    setPoseOpen(false)
    setShootOpen(false); setShootPoseOpen(false)
    setShootReferences({ model: null, pose: null, product: null }); shootRequest.current = null
    setPoseDraft({ angles: null, presetId: 'ual1Idle' })
    setProjectId(id); setSnapshot(null); setAttachments([]); setDraft(''); setSidebarOpen(false); setView('chat'); setConnected(false)
    setResending(null)
    latestRequest.current++
    historyRequest.current = null
    historyAnchor.current = null
    setLoadingHistory(false); setHistoryError(''); setTaskRecords(null)
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
  function applySettings(settings: UserSettings) {
    setRatio(settings.ratio); setQuality(settings.quality); setImageModel(settings.imageModel); setVideoModel(settings.videoModel)
    submitRequest.current = null
  }
  async function saveSettings(changes: Partial<UserSettings>) {
    if (!settingsReady || settingsWrite.current) return
    settingsWrite.current = true; setSavingSettings(true); setSettingsError('')
    try { applySettings(await api<UserSettings>('/settings', json('PATCH', changes))) }
    catch { setSettingsError('设置保存失败，请重试。') }
    finally { settingsWrite.current = false; setSavingSettings(false) }
  }
  useEffect(() => {
    let alive = true
    api<UserSettings>('/settings').then(settings => {
      if (alive) { applySettings(settings); setSettingsReady(true); setSettingsError('') }
    }).catch(() => { if (alive) setSettingsError('设置读取失败，请重试。') })
    return () => { alive = false }
  }, [settingsLoadAttempt])

  async function refresh(id: string) {
    const sequence = ++latestRequest.current
    const result = await api<Snapshot>(`/projects/${id}`)
    if (currentProject.current === id && sequence === latestRequest.current) setSnapshot(previous => mergeLatest(previous, result))
    await loadProjects()
  }
  async function loadOlder() {
    const before = snapshot?.page?.before
    if (!before || historyRequest.current || busy) return
    const id = projectId
    const tailId = snapshot.page?.tailId
    const request = Symbol()
    historyRequest.current = request
    setLoadingHistory(true); setHistoryError('')
    try {
      const older = await api<Snapshot>(`/projects/${id}?before=${before}`)
      if (currentProject.current !== id || historyRequest.current !== request) return
      if (older.page?.tailId !== tailId) { setHistoryError('对话已更新，请重试加载历史。'); return }
      followConversation.current = false
      const viewport = conversationScroll.current
      if (viewport) historyAnchor.current = { height: viewport.scrollHeight, top: viewport.scrollTop }
      setSnapshot(previous => {
        if (!previous || previous.page?.tailId !== tailId) { historyAnchor.current = null; return previous }
        const ids = new Set(previous.messages.map(message => message.id))
        const runIds = new Set(previous.runs.map(run => run.id))
        const jobIds = new Set(previous.jobs.map(job => job.id))
        return { ...previous, messages: [...older.messages.filter(message => !ids.has(message.id)), ...previous.messages],
          runs: [...older.runs.filter(run => !runIds.has(run.id)), ...previous.runs], jobs: [...older.jobs.filter(job => !jobIds.has(job.id)), ...previous.jobs],
          page: { before: older.page?.before ?? null, tailId: previous.page?.tailId ?? null } }
      })
    } catch (failure) { if (currentProject.current === id) setHistoryError(failure instanceof Error ? failure.message : '历史加载失败') }
    finally { if (historyRequest.current === request) { historyRequest.current = null; setLoadingHistory(false) } }
  }
  useEffect(() => {
    if (view !== 'tasks' || !projectId) return
    let active = true
    api<Pick<Snapshot, 'runs' | 'jobs'>>(`/projects/${projectId}/tasks`).then(result => { if (active) setTaskRecords(result) }).catch(() => { if (active) setError('任务记录加载失败') })
    return () => { active = false }
  }, [view, projectId, snapshot?.project.updatedAt])
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
    let pending = false
    let inFlight = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const sync = async () => {
      if (inFlight) { pending = true; return }
      inFlight = true
      const sequence = ++latestRequest.current
      try {
        const result = await api<Snapshot>(`/projects/${projectId}`)
        if (active && sequence === latestRequest.current) setSnapshot(previous => mergeLatest(previous, result))
      } catch { if (active) setConnected(false) }
      finally { inFlight = false; if (active && pending) { pending = false; schedule() } }
    }
    const schedule = () => { if (!timer) timer = setTimeout(() => { timer = undefined; void sync() }, 200) }
    void sync()
    const stream = new EventSource(`/api/projects/${projectId}/events`)
    stream.addEventListener('expired', () => { stream.close(); window.dispatchEvent(new Event('studio-session-expired')) })
    stream.addEventListener('connected', () => { setConnected(true); schedule() })
    stream.addEventListener('changed', schedule)
    stream.addEventListener('deleted', () => {
      stream.close()
      void loadProjects().then(result => { if (active) switchProject(result[0]?.id ?? '') })
    })
    stream.onerror = () => setConnected(false)
    return () => { active = false; clearTimeout(timer); stream.close() }
  }, [projectId])

  const perform = async (operation: () => Promise<void>) => {
    setBusy(true); setError('')
    try { await operation() } catch (failure) { if (!(failure instanceof Error && failure.name === 'AbortError')) setError(failure instanceof Error ? failure.message : '操作失败，请重试') }
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
  function handleDraftKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
    event.preventDefault()
    if (event.repeat) return
    const input = event.currentTarget
    if (event.ctrlKey) {
      if (input.value.length - (input.selectionEnd - input.selectionStart) >= input.maxLength) return
      input.setRangeText('\n', input.selectionStart, input.selectionEnd, 'end')
      editDraft(input.value)
    } else input.form?.requestSubmit()
  }
  function openAvatarConversation() {
    setGuidesOpen(false); setSidebarOpen(false); setView('chat')
    if (!draft.trim()) editDraft('我想制作完整的数字人口播。请先确认文案、主播图片和分段续接安排，再开始生成。')
    requestAnimationFrame(() => draftInput.current?.focus())
  }
  function openGuide(kind: CreationGuide) {
    creationRequest.current = null
    setBriefExpanded(false)
    setGuidesOpen(false)
    setSidebarOpen(false); setGuide(kind); setBrief(''); setBriefDetail(''); setSourceId(''); setSourceFile(null); setError('')
  }
  async function prepareCreation(event: FormEvent) {
    event.preventDefault()
    if (!guide || busy || !brief.trim()) return
    const kind = guide
    const direct = (kind === 'image' || kind === 'edit') && (event.nativeEvent as SubmitEvent).submitter?.getAttribute('name') !== 'draft'
    const selected = creationGuides[kind]
    const prefix = kind === 'image' && sourceId ? '请参考我明确选择的图片生成新图片，另存结果，不覆盖参考图。' : selected.prefix
    const requirement = `${prefix}\n${selected.subject}：${brief.trim()}${selected.detail && briefDetail.trim() ? `\n${selected.detail}：${briefDetail.trim()}` : ''}`
    const nextDraft = [draft.trim(), requirement].filter(Boolean).join('\n\n')
    await perform(async () => {
      if (direct && (!settingsReady || savingSettings || !health?.agentConfigured || !health.models?.images.includes(imageModel))) throw new Error('所选图片模型尚未就绪，未提交生成。')
      const signature = JSON.stringify({ kind, requirement, imageModel, ratio, quality, sourceId, file: sourceFile ? [sourceFile.name, sourceFile.size, sourceFile.lastModified] : null })
      const finishDirect = async (request: { projectId: string; body: AgentInput }) => {
        await api<AgentRun>(`/projects/${request.projectId}/chat`, json('POST', request.body))
        creationRequest.current = null
        setView('chat'); setGuide(null); setSourceFile(null)
        await refresh(request.projectId)
      }
      if (direct && creationRequest.current?.signature === signature) { await finishDirect(creationRequest.current); return }
      if ((direct ? requirement : nextDraft).length + (!direct && (kind === 'edit' || (kind === 'image' && sourceId)) ? 60 : 0) > 6000) throw new Error('需求超过 6000 字，请先精简。')
      let source = kind === 'edit' || kind === 'image' ? assets.find(asset => asset.id === sourceId && (asset.mediaType ?? 'image') === 'image') : undefined
      if ((kind === 'edit' || kind === 'image') && sourceId && !source) throw new Error('所选参考图已不可用，请重新选择。')
      if (kind === 'edit' && !source && !sourceFile) throw new Error('请明确选择或上传一张原图。')
      if (!direct && (source || kind === 'edit') && attachments.length >= 10 && !attachments.some(asset => asset.id === source?.id)) throw new Error('最多选择 10 个附件，请先移除一个附件。')
      if (sourceFile && (!sourceFile.size || sourceFile.size > 64 * 1024 * 1024)) throw new Error('原图必须为非空文件且不超过 64 MB。')
      let id = projectId
      if (!id) {
        const project = await api<Project>('/projects', json('POST', { title: brief.trim().slice(0, 80) }))
        id = project.id; currentProject.current = id; switchProject(id)
        setGuide(kind)
        await loadProjects()
      }
      if (kind === 'edit' && sourceFile) source = await upload(sourceFile, id)
      if (source && (source.mediaType ?? 'image') !== 'image') throw new Error('请选择有效的 PNG、JPEG 或 WebP 图片。')
      if (direct) {
        const body: AgentInput = { requestId: crypto.randomUUID(), text: requirement, assetIds: source ? [source.id] : [], mode: 'image', imageModel, ratio, quality, videoModel: 'none', directImage: source ? { operation: 'edit', sourceAssetId: source.id } : { operation: 'generate' } }
        creationRequest.current = { signature, projectId: id, body }
        await finishDirect(creationRequest.current)
        return
      }
      if (source) setAttachments(previous => previous.some(asset => asset.id === source.id) ? previous : [...previous, source])
      editDraft(`${nextDraft}${source ? `\n原图附件 ID：${source.id}` : ''}`)
      setView('chat'); setGuide(null); setSourceFile(null)
      await refresh(id)
      requestAnimationFrame(() => draftInput.current?.focus())
    })
  }
  function requestDeleteImage(asset: Asset) {
    setError(''); setDeletingAsset(asset)
  }
  async function ensureShootProject() {
    if (currentProject.current) return currentProject.current
    const project = await api<Project>('/projects', json('POST', { title: '模特试拍' }))
    currentProject.current = project.id; setProjectId(project.id)
    await loadProjects()
    return project.id
  }
  function changeShootReference(role: ShootRole, asset: Asset | null) {
    setShootReferences(previous => ({ ...previous, [role]: asset }))
  }
  async function uploadShootReference(file: File, signal: AbortSignal) {
    const id = await ensureShootProject()
    signal.throwIfAborted()
    const asset = await upload(file, id, signal)
    signal.throwIfAborted()
    if (currentProject.current !== id) throw new Error('项目已切换，请重新选择参考图')
    if ((asset.mediaType ?? 'image') !== 'image') throw new Error('请选择有效图片')
    await refresh(id)
    return asset
  }
  async function prepareShootPose(file: File, _detail: string, signal: AbortSignal) {
    setShootBusy(true)
    try {
      changeShootReference('pose', await uploadShootReference(file, signal))
      setShootPoseOpen(false)
    } finally { setShootBusy(false) }
  }
  async function submitShoot(input: ShootSubmission, draftOnly = false) {
    if (!settingsReady || savingSettings) throw new Error('设置尚未就绪，请稍后重试')
    if (!draftOnly && (!health?.agentConfigured || !health.models?.images.includes(input.imageModel))) throw new Error('所选图片模型尚未就绪，未提交生成')
    const id = await ensureShootProject()
    const references = input.assetIds.map(assetId => assets.find(asset => asset.id === assetId && asset.projectId === id && (asset.mediaType ?? 'image') === 'image'))
    if (!references.length || references.length > 3 || references.some(asset => !asset) || new Set(input.assetIds).size !== input.assetIds.length) throw new Error('参考图已变化，请重新选择并合并')
    if (draftOnly) {
      setAttachments(references as Asset[]); editDraft(input.text)
      setRatio(input.ratio); setImageModel(input.imageModel)
      setView('chat'); setShootOpen(false)
      requestAnimationFrame(() => draftInput.current?.focus())
      return
    }
    const signature = JSON.stringify({ ...input, quality, projectId: id })
    if (shootRequest.current?.signature !== signature) {
      shootRequest.current = { signature, projectId: id, body: { requestId: crypto.randomUUID(), text: input.text, assetIds: input.assetIds, mode: 'image', ratio: input.ratio, imageModel: input.imageModel, quality, videoModel: 'none', directImage: { operation: 'edit', sourceAssetId: input.assetIds[0] } } }
    }
    await api<AgentRun>(`/projects/${id}/chat`, json('POST', shootRequest.current.body))
    shootRequest.current = null
    setView('chat'); setShootOpen(false)
    await refresh(id)
  }
  async function deleteSelectedImage() {
    if (!deletingAsset || busy) return
    const asset = deletingAsset
    await perform(async () => {
      const result = await api<{ pendingCleanup: number }>(`/assets/${asset.id}`, json('DELETE', { expectedHash: asset.hash }))
      setDeletingAsset(null)
      setSelectedAsset(previous => previous?.id === asset.id ? null : previous)
      setAttachments(previous => previous.filter(item => item.id !== asset.id))
      setShootReferences(previous => Object.fromEntries(Object.entries(previous).map(([role, item]) => [role, item?.id === asset.id ? null : item])) as ShootReferences)
      if (sourceId === asset.id) setSourceId('')
      submitRequest.current = null; creationRequest.current = null
      setReferenceRevision(value => value + 1)
      if (projectId) await refresh(projectId)
      await loadProjects()
      if (result.pendingCleanup) setError('图片记录已删除，部分文件待后续清理重试。')
    })
  }
  async function confirmClearConversation() {
    if (!projectId || busy) return
    await perform(async () => {
      const latest = await api<Snapshot>(`/projects/${projectId}`)
      setClearingConversation(latest.project)
    })
  }
  async function clearConversation() {
    if (!clearingConversation || busy) return
    const id = clearingConversation.id
    await perform(async () => {
      await api(`/projects/${id}/conversation`, json('DELETE', { expectedUpdatedAt: clearingConversation.updatedAt }))
      setClearingConversation(null); setResending(null)
      latestRequest.current++; historyRequest.current = null; historyAnchor.current = null
      submitRequest.current = null; creationRequest.current = null
      setLoadingHistory(false); setHistoryError(''); setTaskRecords(null); setSnapshot(null)
      await refresh(id)
      await loadProjects()
    })
  }
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
  async function preparePose(board: File, detail: string, signal: AbortSignal) {
    if (busy) throw new Error('请等待当前操作完成')
    if (attachments.length >= 10) throw new Error('最多选择 10 个附件，请先移除一个附件')
    const requirement = `请根据姿势与人物参考板生成一张新的人物照片。使用这张参考板作为图片编辑输入：左侧 A 只提供身体姿势、关节位置和相机视角；右侧 B 提供人物身份、面容、发型和服装。把 B 中人物摆成 A 的姿势。不要复制人偶的橙紫材质，不要输出人偶、左右拼图、标签或参考板，只输出一张完整成片。另存结果，不覆盖参考图。${detail ? `\n场景与风格：${detail}` : ''}`
    const nextDraft = [draft.trim(), requirement].filter(Boolean).join('\n\n')
    if (nextDraft.length + 70 > 6000) throw new Error('现有草稿与新需求合计超过 6000 字，请先精简草稿')
    setBusy(true)
    let id = projectId
    try {
      signal.throwIfAborted()
      if (!id) {
        const project = await api<Project>('/projects', json('POST', { title: '姿势生图' }))
        id = project.id
        currentProject.current = id
        setProjectId(id)
        await loadProjects()
      }
      signal.throwIfAborted()
      const asset = await upload(board, id, signal)
      signal.throwIfAborted()
      if (currentProject.current !== id) throw new Error('项目已切换，请重新准备参考板')
      setAttachments(previous => [...previous, asset])
      editDraft(`${nextDraft}\n原图附件 ID：${asset.id}`)
      setView('chat'); setPoseOpen(false)
      await refresh(id)
    } finally { setBusy(false) }
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
      followConversation.current = true
      await refresh(projectId)
    })
  }
  async function upload(file: File, id = projectId, signal?: AbortSignal) {
    const controller = signal ? undefined : new AbortController()
    if (controller) { uploadController.current = controller; setUploading(file.name) }
    const uploadSignal = signal ?? controller!.signal
    const form = new FormData(); form.append('file', file)
    try {
      const asset = await api<Asset>(`/projects/${id}/uploads`, { method: 'POST', body: form, signal: uploadSignal })
      uploadSignal.throwIfAborted()
      return asset
    } finally {
      if (controller && uploadController.current === controller) { uploadController.current = null; setUploading('') }
    }
  }
  async function uploadFiles(files: File[]) {
    const attach = view === 'chat'
    if (files.length > 10 || (attach && attachments.length + files.length > 10)) throw new Error('每次最多上传 10 个文件，每条消息最多附加 10 个文件')
    if (files.some(file => file.size > 64 * 1024 * 1024)) throw new Error('单个文件不能超过 64 MB')
    if (files.some(file => !file.size)) throw new Error('不能上传空文件')
    const id = projectId
    const controller = new AbortController()
    uploadController.current = controller
    try {
      for (const [index, file] of files.entries()) {
        controller.signal.throwIfAborted()
        setUploading(`${index + 1} / ${files.length} · ${file.name}`)
        const asset = await upload(file, id, controller.signal)
        if (attach && currentProject.current === id) {
          setAttachments(previous => [...previous, asset])
          submitRequest.current = null
        }
      }
    } finally {
      if (uploadController.current === controller) { uploadController.current = null; setUploading('') }
      if (controller.signal.aborted) void refresh(id).catch(() => {})
      else await refresh(id)
    }
  }
  async function resend() {
    if (!resending || busy) return
    const selected = resending
    await perform(async () => {
      await api(`/projects/${selected.message.projectId}/messages/${selected.message.id}/resend`, json('POST', { requestId: selected.requestId, expectedTailId: selected.expectedTailId, text: selected.text }))
      submitRequest.current = null
      historyRequest.current = null
      setLoadingHistory(false)
      setSnapshot(null)
      setResending(null)
      await refresh(selected.message.projectId)
    })
  }
  async function renameReference(asset: Asset, name: string) {
    if (busy) throw new Error('请等待当前操作完成')
    setBusy(true)
    try {
      const updated = await api<Asset>(`/assets/${asset.id}`, json('PATCH', { name, expectedName: asset.name }))
      setAttachments(previous => previous.map(item => item.id === updated.id ? updated : item))
      setSelectedAsset(previous => previous?.id === updated.id ? updated : previous)
      setShootReferences(previous => Object.fromEntries(Object.entries(previous).map(([role, item]) => [role, item?.id === updated.id ? updated : item])) as ShootReferences)
      setReferenceRevision(value => value + 1)
      if (projectId) await refresh(projectId)
      await loadProjects()
    } finally { setBusy(false) }
  }
  async function chooseHistoricalReference(asset: Asset) {
    if (busy) throw new Error('请等待当前操作完成')
    const target = referenceTarget
    if (target === 'chat' && attachments.length >= 10) throw new Error('最多选择 10 个附件，请先移除一个附件。')
    setBusy(true)
    try {
      let id = projectId
      if (!id) {
        const project = await api<Project>('/projects', json('POST', { title: '参考图创作' }))
        id = project.id; currentProject.current = id; setProjectId(id)
        await loadProjects()
      }
      const copy = await api<Asset>(`/projects/${id}/references`, json('POST', { assetId: asset.id }))
      await refresh(id)
      if (target?.startsWith('shoot-')) changeShootReference(target.slice(6) as ShootRole, copy)
      else if (target === 'creation') { setSourceId(copy.id); setSourceFile(null) }
      else { attachReference(copy) }
      setReferenceTarget(null)
    } finally { setBusy(false) }
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
  const works = assets.filter(asset => asset.kind === 'generated' && (asset.mediaType ?? 'image') === 'image')
  const jobs = (view === 'tasks' ? taskRecords?.jobs : undefined) ?? snapshot?.jobs ?? []
  const runs = (view === 'tasks' ? taskRecords?.runs : undefined) ?? snapshot?.runs ?? []
  const activeRuns = runs.filter(run => run.status === 'queued' || run.status === 'running')
  const stopRun = (run: AgentRun) => perform(async () => { await api(`/agent-runs/${run.id}/stop`, { method: 'POST' }); await refresh(run.projectId) })
  const waiting = jobs.filter(job => job.status === 'waiting_service').length + activeRuns.length
  const title = snapshot?.project.title ?? projects.find(project => project.id === projectId)?.title ?? '创作工作台'
  const newProject = () => { setSidebarOpen(false); setProjectName(''); setProjectDialog('new') }
  const projectList = <>
    <div className="sidebar-section"><span>工作空间</span><span className="mono">LOCAL / 01</span></div>
    <button className="new-project" onClick={newProject} disabled={busy}><Plus size={18} />新建项目</button>
    <button className="service-entry" type="button" disabled={busy} onClick={() => { setSidebarOpen(false); setReferenceTarget('chat') }}><ImagePlus size={19} />参考图库</button>
    <label className="search"><Search size={16} /><input aria-label="搜索项目" placeholder="搜索项目" value={search} onChange={event => setSearch(event.target.value)} /></label>
    <div className="project-list">{projects.filter(project => project.title.toLowerCase().includes(search.toLowerCase())).map(project => <div className="project-row" key={project.id}><button className={`project-link ${projectId === project.id ? 'active' : ''}`} onClick={() => switchProject(project.id)} disabled={busy}><Folder size={17} /><span>{project.title}</span><ChevronRight size={14} /></button><IconButton label={`删除项目 ${project.title}`} disabled={busy} onClick={() => void perform(async () => { const latest = await api<Snapshot>(`/projects/${project.id}`); setDeleting(latest.project); setSidebarOpen(false) })}><Trash2 size={17} /></IconButton></div>)}
      {!projects.length && <p className="muted small">暂无项目</p>}
      {!!projects.length && !projects.some(project => project.title.toLowerCase().includes(search.toLowerCase())) && <p className="muted small">没有匹配的项目</p>}
    </div>
  </>
  const sampleSection = <section className="reference-section"><div className="section-heading"><h3>参考起点</h3><span>摄影参考 · 非生成结果</span></div><div className="sample-grid">{references.map(sample => <button key={sample.name} className="sample" disabled={busy || attachments.length >= 10} onClick={() => void selectSample(sample)}><img src={sample.file} alt={sample.name} /><span>{sample.name}<Plus size={17} /></span></button>)}</div><small className="source">摄影来源：Unsplash</small></section>
  const creationEntries = <><nav className="creation-entries" aria-label="创作入口">{(Object.keys(creationGuides) as CreationGuide[]).map(kind => { const entry = creationGuides[kind]; const Icon = entry.icon; return <button type="button" key={kind} disabled={busy} onClick={() => openGuide(kind)}><Icon size={21} /><span>{entry.title}</span><ChevronRight size={15} /></button> })}<button type="button" disabled={busy} onClick={() => { setGuidesOpen(false); setPoseOpen(true) }}><Aperture size={21} /><span>姿势生图</span><ChevronRight size={15} /></button><button type="button" disabled={busy} onClick={() => { setGuidesOpen(false); setShootOpen(true) }}><Camera size={21} /><span>模特试拍</span><ChevronRight size={15} /></button></nav><button type="button" className="welcome-secondary" disabled={busy} onClick={() => { setGuidesOpen(false); setReferenceTarget('chat') }}><ImagePlus size={18} /><span>参考图库</span><ChevronRight size={16} /></button></>

  const uploadStatus = uploading && <div className="upload-status" role="status"><LoaderCircle size={16} className="spin" /><span>正在上传 {uploading}</span><IconButton label="取消上传" onClick={() => uploadController.current?.abort()}><X size={18} /></IconButton></div>

  return <div className="studio">
    <main className="workspace">
      <header className="topbar"><IconButton label="项目列表" onClick={() => setSidebarOpen(true)}><PanelLeft size={21} /></IconButton><div className="breadcrumb"><h1 className="project-heading">{projectId ? <button type="button" aria-label="重命名项目" title={title} disabled={busy} onClick={() => { setProjectName(title); setProjectDialog('rename') }}>{title}</button> : 'Codex Studio'}</h1><span role="status" aria-label={connected ? '已同步' : '连接中'} title={connected ? '已同步' : '连接中'} className={`status-dot ${connected ? '' : 'gray'}`} /></div><IconButton label="VM 管理" onClick={() => setVmOpen(true)}><Cpu size={19} /></IconButton><IconButton label="设置" onClick={() => setOptionsOpen(true)}><Settings size={19} /></IconButton></header>
      {error && <div className="error-banner" role="alert"><span>{error}</span><IconButton label="关闭提示" onClick={() => setError('')}><X size={16} /></IconButton><IconButton label="重试连接" onClick={() => void perform(async () => { const result = await loadProjects(); if (projectId) await refresh(projectId); else if (result.length) switchProject(result[0].id) })}><RefreshCw size={16} /></IconButton></div>}
      {initializing ? <div className="empty"><LoaderCircle className="spin" /><h2>正在读取工作空间</h2></div> : <div className="workspace-body chat-layout">
          <section className="conversation"><div className="conversation-scroll" ref={conversationScroll} onScroll={event => { if (event.currentTarget.scrollTop < 80 && !followConversation.current && !historyError) void loadOlder() }}><div className="conversation-content">
            {snapshot?.page?.before && <div className="history-loader"><IconButton label="加载更早消息" disabled={loadingHistory} onClick={() => void loadOlder()}>{loadingHistory ? <LoaderCircle size={18} className="spin" /> : <ArrowUp size={18} />}</IconButton>{historyError && <p role="alert">{historyError}</p>}</div>}
            {!snapshot?.messages.length ? <div className="welcome"><div className="welcome-heading"><div><p className="welcome-brand">Codex Studio</p><h2>今天，想创作什么？</h2></div><Aperture size={25} aria-hidden="true" /></div><div className="welcome-status"><span className={`status-dot ${health?.agent === 'configured' ? '' : 'gray'}`} />{health?.agent === 'configured' ? 'Codex · GPT-5.4' : 'Codex 尚未连接'}</div>{creationEntries}{!projectId ? <button className="welcome-secondary" onClick={newProject}><Plus size={18} /><span>创建项目</span><ChevronRight size={16} /></button> : <button className="welcome-secondary" onClick={openAvatarConversation}><Film size={18} /><span>数字人口播</span><ChevronRight size={16} /></button>}{sampleSection}</div> : <div className="messages">{snapshot.messages.filter(message => message.role !== 'assistant' || !runs.some(run => run.assistantId === message.id && snapshot.messages.some(item => item.id === run.messageId))).map(message => {
              const job = jobs.find(item => item.messageId === message.id)
              const run = runs.find(item => item.messageId === message.id || item.assistantId === message.id)
              const reply = message.role === 'assistant' ? message : run ? snapshot.messages.find(item => item.id === run.assistantId) : undefined
              return <section className="conversation-turn" key={message.id}>
                {message.role !== 'assistant' && <article className="message user-message" aria-label="你的消息">
                  <div className="message-content">
                    <p className="message-text">{message.text}</p>
                    {message.assetIds.length > 0 && <div className="message-images">{message.assetIds.map(id => { const asset = assets.find(item => item.id === id); return asset && <button className={asset.mediaType === 'file' || !assetHasThumbnail(asset) ? 'message-file' : ''} key={id} onClick={() => setSelectedAsset(asset)}><AssetPreview asset={asset} />{(asset.mediaType === 'file' || !assetHasThumbnail(asset)) && <span>{asset.name}<small>{fileSize(asset.bytes)}</small></span>}</button> })}</div>}
                    <div className="message-actions"><time dateTime={message.createdAt}>{time(message.createdAt)}</time><IconButton label="重新发送此消息" disabled={busy} onClick={() => { setError(''); setResending({ message, text: message.text, requestId: crypto.randomUUID(), expectedTailId: snapshot.page?.tailId ?? snapshot.messages.at(-1)!.id }) }}><RefreshCw size={15} /></IconButton></div>
                  </div>
                </article>}
                {run && <article className="message assistant-message" aria-label="Codex 回复">
                  <RunProgress run={run} />
                  {reply && <div className="message-content"><MarkdownReply text={reply.text} /></div>}
                  <ImagePending run={run} connected={connected} />
                  {reply && <ReplyAssets ids={run.avatarJobId || run.story ? run.assetId ? [run.assetId] : [] : reply.assetIds} assets={assets} select={setSelectedAsset} />}
                  {(!!run.avatarJobId || !!run.story) && <NarrationTimeline run={run} assets={assets} select={setSelectedAsset} connected={connected} />}
                  {!run.avatarJobId && !run.story && run.stage === 'video' && ['failed', 'cancelled', 'interrupted'].includes(run.status) && <p className="image-outcome" role="status">{run.status === 'failed' ? '视频生成失败' : '视频任务结果待核实'}</p>}
                  {run.stage === 'image' && ['failed', 'cancelled', 'interrupted'].includes(run.status) && <p className="image-outcome" role="status">{{ failed: '图片生成失败', cancelled: '图片生成已停止', interrupted: '图片生成结果待核实' }[run.status as 'failed' | 'cancelled' | 'interrupted']}</p>}
                  {run.error && <div className="run-status" role="status"><p>{run.error}</p></div>}
                  {reply?.text && <CopyReply key={reply.id} text={reply.text} createdAt={reply.createdAt} />}
                </article>}
                {job && <div className="job-inline"><CirclePause size={16} /><span>{job.status === 'cancelled' ? '已取消' : '已保存 · 等待服务接入'}</span><span className="mono">{job.ratio}</span><button onClick={() => setView('tasks')}>查看任务<ChevronRight size={14} /></button></div>}
              </section>
            })}</div>}
          </div></div>
          {activeRuns.some(run => run.stage !== 'codex' && run.status === 'running') && <div className="generation-status" role="status" aria-label={activeRuns.some(run => run.stage === 'video') ? '当前视频任务' : '当前图片任务'}><LoaderCircle size={16} className="spin" aria-hidden="true" /><span>{connected ? runLabel(activeRuns.find(run => run.stage !== 'codex' && run.status === 'running')!) : '连接已断开，正在同步生成状态'}</span></div>}
          {view === 'chat' && !guide && uploadStatus}
          {projectId && <nav className="conversation-tools" aria-label="当前会话操作"><button type="button" disabled={busy} onClick={() => setView('works')}><Images size={17} />作品集合<span>{works.length}</span></button><IconButton label="清空会话" disabled={busy || !snapshot?.messages.length || activeRuns.length > 0} onClick={() => void confirmClearConversation()}><Trash2 size={17} /></IconButton></nav>}
          <form className={`composer${draftExpanded ? ' is-expanded' : ''}`} onSubmit={event => void submit(event)}>
            {settingsError && <p role="alert" className="form-error">{settingsError}</p>}
            {attachments.length > 0 && <div className="attachments">{attachments.map(asset => <div key={asset.id}><button type="button" className="attachment-preview" aria-label={`查看附件 ${asset.name}`} onClick={() => setSelectedAsset(asset)}><AssetPreview asset={asset} /><span>{asset.name}</span></button><IconButton label={`移除附件 ${asset.name}`} disabled={busy} onClick={() => { setAttachments(previous => previous.filter(item => item.id !== asset.id)); submitRequest.current = null }}><X size={13} /></IconButton></div>)}</div>}
            <div className="composer-input"><textarea ref={draftInput} aria-label="创作需求" placeholder={projectId ? '说说你的想法…' : '先创建一个项目'} value={draft} disabled={!projectId || busy} maxLength={6000} onFocus={() => setExpandedDraftProject(projectId)} onChange={event => editDraft(event.target.value)} onKeyDown={handleDraftKeyDown} rows={2} /></div>
            <div className="composer-row"><IconButton label="历史参考图" disabled={busy || attachments.length >= 10} onClick={() => setReferenceTarget('chat')}><Images size={16} /></IconButton><IconButton label="上传文件" disabled={!projectId || busy || attachments.length >= 10} onClick={() => fileInput.current?.click()}><Paperclip size={16} /></IconButton><IconButton label="创作引导" aria-haspopup="dialog" aria-expanded={guidesOpen} disabled={busy} onClick={() => setGuidesOpen(true)}><Aperture size={16} /></IconButton><div className="composer-model" aria-label="当前图片模型" title={`${imageModelNames[imageModel]} · ${qualityNames[quality]}质量`}><strong>{imageModelNames[imageModel]}</strong><span>{qualityNames[quality]}质量</span></div><select className="composer-ratio" aria-label="作图比例" title="作图比例" value={ratio} disabled={busy || !settingsReady || savingSettings} onChange={event => void saveSettings({ ratio: event.target.value as Ratio })}><RatioOptions /></select><div className="composer-submit">{activeRuns.length > 0 && <IconButton label="停止当前回复" disabled={busy || activeRuns[0].narration?.stopRequested || activeRuns[0].story?.stopRequested} onClick={() => void stopRun(activeRuns[0])}><Square size={16} /></IconButton>}<button className="send" type="submit" aria-label="提交需求" title="提交需求" disabled={!projectId || (!draft.trim() && !attachments.length) || busy || !health}>{busy ? <LoaderCircle size={16} className="spin" /> : <ArrowUp size={16} />}</button></div></div>
          </form></section>
        <Modal open={view !== 'chat'} onOpenChange={open => { if (!open) setView('chat') }} title={view === 'images' ? '素材库' : view === 'works' ? '作品集合' : '任务记录'} className={`project-panel${view === 'works' ? ' reference-panel' : ''}`}>
        {uploadStatus}
        {view === 'works' && <section className="collection"><div className="collection-toolbar"><h2>{works.length} 张作品</h2><span className="muted small">{title}</span></div>{!works.length ? <div className="empty"><Images size={32} /><h2>暂无已生成的图片</h2></div> : <div className="asset-grid reference-grid">{works.slice().reverse().map(asset => <div className="image-collection-item" key={asset.id}><button type="button" className="asset" aria-label={`查看作品 ${asset.name}`} onClick={() => { setView('chat'); setSelectedAsset(asset) }}><div className="asset-image"><AssetImage asset={asset} /></div><strong>{asset.name}</strong><small>{assetDetails(asset)}</small></button><IconButton label={`删除作品 ${asset.name}`} disabled={busy || activeRuns.length > 0} onClick={() => requestDeleteImage(asset)}><Trash2 size={17} /></IconButton></div>)}</div>}</section>}
        {view === 'images' && <section className="collection"><div className="collection-toolbar"><h2>{assets.length} 个素材</h2><button className="primary" disabled={!projectId || busy} onClick={() => fileInput.current?.click()}><Plus size={17} />上传文件</button></div>{!assets.length ? <div className="empty"><Images size={32} /><h2>还没有项目资料</h2>{!projectId && <button className="primary" onClick={newProject}><Plus size={16} />创建项目</button>}</div> : <div className="asset-grid">{assets.slice().reverse().map(asset => <button className="asset" key={asset.id} onClick={() => { setView('chat'); setSelectedAsset(asset) }}><div className="asset-image"><AssetPreview asset={asset} /><span className="asset-kind">{asset.kind === 'generated' ? asset.mediaType === 'video' ? ['azure-avatar', 'sadtalker'].includes(asset.model ?? '') ? '数字人口播' : 'H3 视频' : asset.model === 'frame_sampler' ? '视频尾帧' : `${asset.provider ?? 'Azure'} 生成` : asset.mediaType === 'file' ? '文件' : asset.mediaType === 'video' ? '视频' : '参考图'}</span></div><strong>{asset.name}</strong><small>{assetDetails(asset)}</small></button>)}</div>}</section>}
        {view === 'tasks' && runs.length > 0 && <section className="collection"><div className="collection-toolbar"><h2>{runs.length} 条运行记录</h2></div><div className="task-list">{runs.slice().reverse().map(run => <article className="task agent-task" key={run.id}><div className="task-icon">{run.stage === 'image' ? <Images size={20} /> : run.stage === 'video' ? <Aperture size={20} /> : <MessageSquare size={20} />}</div><div className="task-content"><div><span className="badge">{runLabel(run)}</span><time>{time(run.createdAt)}</time></div><p>{run.input.text}</p><small>{runModel(run)}</small>{run.error && <p className="form-error">{run.error}</p>}</div>{['queued', 'running'].includes(run.status) && <IconButton label="停止运行" disabled={busy} onClick={() => void stopRun(run)}><Square size={18} /></IconButton>}</article>)}</div></section>}
        {view === 'tasks' && (jobs.length > 0 || !runs.length) && <section className="collection"><div className="collection-toolbar"><h2>{jobs.length} 条任务</h2><select aria-label="任务状态筛选" value={filter} onChange={event => setFilter(event.target.value)}><option value="all">全部状态</option><option value="waiting_service">等待服务</option><option value="cancelled">已取消</option></select></div>{!jobs.length ? <div className="empty"><ListTodo size={32} /><h2>暂无任务</h2></div> : <div className="task-list">{jobs.filter(job => filter === 'all' || job.status === filter).slice().reverse().map(job => <article className="task" key={job.id}><div className={`task-icon ${job.status === 'cancelled' ? 'cancelled' : ''}`}><CirclePause size={21} /></div><div className="task-content"><div><span className={`badge ${job.status === 'cancelled' ? 'neutral' : ''}`}>{job.status === 'cancelled' ? '已取消' : '等待服务'}</span><time>{time(job.createdAt)}</time></div><p>{job.prompt}</p><small>Qwen-Image-2.1 · {job.ratio} · {job.assetIds.length} 张参考图</small></div>{job.status === 'waiting_service' ? <IconButton label="取消任务" disabled={busy} onClick={() => void perform(async () => { await api(`/jobs/${job.id}/cancel`, { method: 'POST' }); await refresh(projectId) })}><X size={19} /></IconButton> : <IconButton label="重新编辑需求" disabled={busy} onClick={() => { editDraft(job.prompt); setRatio(health?.agentConfigured ? '1:1' : job.ratio); setAttachments(assets.filter(asset => job.assetIds.includes(asset.id))); setView('chat') }}><RefreshCw size={18} /></IconButton>}</article>)}{jobs.filter(job => filter === 'all' || job.status === filter).length === 0 && <div className="empty">没有符合条件的任务</div>}</div>}</section>}
        </Modal>
      </div>}
    </main>
    <input ref={fileInput} type="file" multiple hidden onChange={event => { const files = Array.from(event.target.files ?? []); event.target.value = ''; if (files.length) void perform(() => uploadFiles(files)) }} />
    <Modal open={guidesOpen} onOpenChange={setGuidesOpen} title="创作引导">{creationEntries}<button type="button" className="welcome-secondary" disabled={!projectId || busy} onClick={openAvatarConversation}><Film size={18} /><span>数字人口播</span><ChevronRight size={16} /></button></Modal>
    <Modal open={poseOpen} onOpenChange={setPoseOpen} title="姿势生图" className="pose-modal"><Suspense fallback={<p role="status">加载姿势工作台</p>}><PoseStudio assets={assets} value={poseDraft} onChange={setPoseDraft} onPrepare={preparePose} /></Suspense></Modal>
    <Modal open={shootOpen} onOpenChange={open => { if (!shootBusy && !busy) setShootOpen(open) }} title="模特试拍" className="model-shoot-panel"><ModelShoot assets={assets} references={shootReferences} onChange={changeShootReference} onUpload={uploadShootReference} onLibrary={role => setReferenceTarget(`shoot-${role}`)} onPose={() => setShootPoseOpen(true)} onGenerate={input => submitShoot(input)} onDraft={input => submitShoot(input, true)} onBusyChange={setShootBusy} initialRatio={ratio} initialModel={imageModel} availableModels={health?.models?.images ?? []} disabled={busy || !settingsReady || savingSettings} preferencesKey={`studio.shoot-categories:${user?.id ?? 'local'}`} /></Modal>
    <Modal open={shootPoseOpen} onOpenChange={open => { if (!shootBusy) setShootPoseOpen(open) }} title="试拍姿势" className="pose-modal"><Suspense fallback={<p role="status">加载姿势工作台</p>}><PoseStudio assets={assets} value={poseDraft} onChange={setPoseDraft} onPrepare={prepareShootPose} referenceOnly /></Suspense></Modal>
    <Modal open={!!guide} onOpenChange={open => { if (!open && !busy) { setGuide(null); setSourceFile(null) } }} title={guide ? creationGuides[guide].title : '创作需求'} className={guide === 'image' ? 'image-create-sheet' : undefined}>
      {guide && <form className="creation-brief" onSubmit={event => void prepareCreation(event)}>
        {uploadStatus}
        {(guide === 'image' || guide === 'edit') && <div className="creation-image-parameters">
          <select className="creation-ratio" aria-label="作图比例" title="作图比例" value={ratio} disabled={busy || !settingsReady || savingSettings} onChange={event => void saveSettings({ ratio: event.target.value as Ratio })}><RatioOptions /></select>
          <div className="creation-model-info" aria-label="当前图片模型" title={`${imageModelNames[imageModel]} · ${qualityNames[quality]}质量`}><strong>{imageModelNames[imageModel]}</strong><small>{qualityNames[quality]}质量</small></div>
        </div>}
        {guide === 'edit' && <><label>项目原图<select aria-label="项目原图" value={sourceId} disabled={busy} onChange={event => { setSourceId(event.target.value); setSourceFile(null) }}><option value="">选择原图</option>{assets.filter(asset => (asset.mediaType ?? 'image') === 'image').map(asset => <option key={asset.id} value={asset.id}>{asset.name} · {asset.id.slice(0, 8)}</option>)}</select></label><label>上传原图<input key={sourceId} aria-label="上传原图" type="file" accept="image/png,image/jpeg,image/webp" disabled={busy} onChange={event => { setSourceFile(event.target.files?.[0] ?? null); setSourceId('') }} /></label>{sourceFile && <span className="brief-source">{sourceFile.name}</span>}</>}
        <label className="creation-subject">{creationGuides[guide].subject}<textarea className={guide === 'image' || guide === 'edit' ? `image-brief-input${briefExpanded ? ' is-expanded' : ''}` : undefined} onFocus={() => setBriefExpanded(true)} required aria-label={creationGuides[guide].subject} maxLength={1600} rows={3} placeholder={creationGuides[guide].placeholder} value={brief} disabled={busy} onChange={event => setBrief(event.target.value)} /></label>
        {creationGuides[guide].detail && <label>{creationGuides[guide].detail}<textarea aria-label={creationGuides[guide].detail ?? undefined} maxLength={1200} rows={2} value={briefDetail} disabled={busy} onChange={event => setBriefDetail(event.target.value)} /></label>}
        {(guide === 'image' || guide === 'edit') && <div className="creation-reference"><button type="button" disabled={busy} onClick={() => setReferenceTarget('creation')}><Images size={17} />历史参考图</button>{sourceId && <div className="selected-reference"><img src={`/api/assets/${sourceId}/content?thumbnail=1`} alt="已选参考图" /><span>{assets.find(asset => asset.id === sourceId)?.name}</span><IconButton label="移除参考图" disabled={busy} onClick={() => setSourceId('')}><X size={16} /></IconButton></div>}</div>}
        <div className="creation-actions">
          {(guide === 'image' || guide === 'edit') && <button type="submit" name="direct" className="primary" disabled={busy || !settingsReady || savingSettings || !health?.models?.images.includes(imageModel) || !brief.trim() || (guide === 'edit' && !sourceId && !sourceFile)}>{busy ? <LoaderCircle size={17} className="spin" /> : <Images size={17} />}{guide === 'edit' ? '修改图片' : '生成图片'}</button>}
          <button type="submit" name="draft" className={guide === 'image' || guide === 'edit' ? '' : 'primary'} disabled={busy || !brief.trim() || (guide === 'edit' && !sourceId && !sourceFile)}>{busy ? <LoaderCircle size={17} className="spin" /> : <Check size={17} />}带入草稿</button>
        </div>
        {error && <p role="alert" className="form-error">{error}</p>}
      </form>}
    </Modal>
    <Modal open={sidebarOpen} onOpenChange={setSidebarOpen} title="项目列表" className="project-drawer">{projectList}<div className="project-shortcuts"><button className="service-entry" type="button" disabled={!projectId} onClick={() => { setSidebarOpen(false); setView('images') }}><Images size={19} />素材库</button><button className="service-entry" type="button" disabled={!projectId} onClick={openAvatarConversation}><Film size={19} />数字人口播</button><button className="service-entry" type="button" disabled={!projectId} onClick={() => { setSidebarOpen(false); setFilter('all'); setView('tasks') }}><ListTodo size={19} />任务记录{waiting > 0 && <small>{waiting}</small>}</button><button className="service-entry" type="button" onClick={() => { setSidebarOpen(false); setStorageStatus('checking'); setServicesOpen(true) }}><Cpu size={19} />{health?.agentConfigured ? '服务状态' : '服务未接入'}</button></div></Modal>
    <Modal open={optionsOpen} onOpenChange={setOptionsOpen} title="设置">
      {user && <div className="account-settings"><span>{user.name}</span><small>{user.provider === 'entra' ? 'Microsoft Entra ID' : '本地账号'}</small><button type="button" onClick={() => void perform(async () => { await onLogout?.() })}>退出登录</button></div>}
      {user?.admin && <LocalAccounts />}
      <div className="creation-options"><label className="ratio-control">默认比例<select aria-label="默认比例" value={ratio} disabled={busy || !settingsReady || savingSettings} onChange={event => void saveSettings({ ratio: event.target.value as Ratio })}><RatioOptions /></select></label>{health?.agentConfigured && <label className="ratio-control">默认质量<select aria-label="默认质量" value={quality} disabled={busy || !settingsReady || savingSettings} onChange={event => void saveSettings({ quality: event.target.value as Quality })}>{(['low', 'medium', 'high'] as const).map(value => <option key={value} value={value}>{qualityNames[value]}</option>)}</select></label>}</div>
      {health?.agentConfigured && <div className="model-options"><label>图片模型<select aria-label="图片模型" value={imageModel} disabled={busy || !settingsReady || savingSettings} onChange={event => void saveSettings({ imageModel: event.target.value as ImageModel })}>{imageModels.map(model => <option key={model} value={model} disabled={!health.models?.images.includes(model)}>{imageModelNames[model]}{!health.models?.images.includes(model) ? ' · 未就绪' : ''}</option>)}</select></label><label>视频模型<select aria-label="视频模型" value={videoModel} disabled={busy || !settingsReady || savingSettings} onChange={event => void saveSettings({ videoModel: event.target.value as VideoModel })}><option value="none">不启用</option><option value="minimax-h3" disabled={!health.models?.videos.includes('minimax-h3')}>MiniMax H3{health.models?.videos.includes('minimax-h3') ? '' : ' · 未就绪'}</option></select></label></div>}
      {savingSettings && <p role="status">正在保存设置</p>}
      {settingsError && <div role="alert" className="form-error">{settingsError}<IconButton label="重新读取设置" disabled={savingSettings} onClick={() => { setSettingsReady(false); setSettingsLoadAttempt(attempt => attempt + 1) }}><RefreshCw size={18} /></IconButton></div>}
      {snapshot?.threadId && <p className="session-info">会话 {snapshot.threadId.slice(-8)}</p>}
    </Modal>
    <Modal open={!!resending} onOpenChange={open => { if (!open && !busy) setResending(null) }} title="重新发送这条消息？">
      <div className="resend-confirmation"><label>消息内容<textarea aria-label="编辑重发消息" rows={3} maxLength={6000} disabled={busy} value={resending?.text ?? ''} onChange={event => { const text = event.target.value; setResending(previous => previous ? { ...previous, text, requestId: crypto.randomUUID() } : null) }} /></label><p>此消息之后的对话和任务记录将被清除，无法撤销。图片仍保留在素材库。</p>{health?.agentConfigured && <p>将重新调用模型，可能再次计费。</p>}<div className="actions"><button type="button" disabled={busy} onClick={() => setResending(null)}>取消</button><button type="button" className="primary" aria-label="清理并重新发送" disabled={busy || !resending?.text.trim()} onClick={() => void resend()}>{busy ? <LoaderCircle size={17} className="spin" /> : <RefreshCw size={17} />}确认重发</button></div>{error && <p role="alert" className="form-error">{error}</p>}</div>
    </Modal>
    <Modal open={!!projectDialog} onOpenChange={open => { if (!open && !busy) setProjectDialog(null) }} title={projectDialog === 'rename' ? '重命名项目' : '新建项目'}><form className="project-form" onSubmit={event => void saveProject(event)}><label htmlFor="project-title">项目名称</label><input id="project-title" autoFocus required maxLength={80} value={projectName} placeholder="为这次创作命名" onChange={event => setProjectName(event.target.value)} /><button className="primary" disabled={busy || !projectName.trim()} type="submit">{busy ? <LoaderCircle size={17} className="spin" /> : <Check size={17} />}保存项目</button>{error && <p role="alert" className="form-error">{error}</p>}</form></Modal>
    <Modal open={servicesOpen} onOpenChange={setServicesOpen} title="服务状态"><div className="service-list"><p>{storageStatus === 'ready' ? <Check size={18} /> : <CirclePause size={18} />}<strong>本地数据</strong><span>{storageStatus === 'ready' ? 'SQLite 已连接' : storageStatus === 'checking' ? '检查中' : '连接失败'}</span></p><p><CirclePause size={18} /><strong>Codex / GPT-5.4</strong><span>{storageStatus === 'ready' && health?.agent === 'configured' ? '容器已配置' : '未连接'}</span></p><p><Cpu size={18} /><strong>OpenMontage</strong><span>{storageStatus === 'ready' && health?.openmontage === 'installed' ? '已安装' : '未连接'}</span></p><p><Images size={18} /><strong>Azure 图片</strong><span>{storageStatus === 'ready' && health?.renderer === 'azure_image2' ? '已配置 · 按量计费' : '未连接'}</span></p><p><Cpu size={18} /><strong>ComfyUI / GPU</strong><span>{storageStatus === 'ready' && (health?.models?.images.some(model => model.startsWith('qwen-image-')) || health?.models?.videos.includes('minimax-h3')) ? '已连接 · GPU 计费' : '未就绪'}</span></p></div></Modal>
    <Modal open={referenceTarget !== null} onOpenChange={open => { if (!open && !busy) setReferenceTarget(null) }} title="参考图库" className="project-panel reference-panel reference-library-panel"><ReferenceLibrary key={projectId} projects={projects} currentProjectId={projectId} select={chooseHistoricalReference} remove={requestDeleteImage} rename={renameReference} revision={referenceRevision} /></Modal>
    <Viewer asset={selectedAsset} close={() => setSelectedAsset(null)} reference={attachReference} remove={requestDeleteImage} deletingDisabled={busy || activeRuns.length > 0} />
    <Modal open={vmOpen} onOpenChange={setVmOpen} title="VM 管理"><VmPanel /></Modal>
    <Modal open={!!clearingConversation} onOpenChange={open => { if (!open && !busy) setClearingConversation(null) }} title="清空会话？"><div className="resend-confirmation"><strong>{clearingConversation?.title}</strong><p>将清空当前项目的全部历史消息及任务文字记录，无法撤销。已生成的图片、参考图和其他素材保留，作品集合不受影响。</p><div className="actions"><button type="button" disabled={busy} onClick={() => setClearingConversation(null)}>取消</button><button type="button" className="primary danger" disabled={busy} onClick={() => void clearConversation()}><Trash2 size={18} />确认清空</button></div>{error && <p role="alert" className="form-error">{error}</p>}</div></Modal>
    <Modal open={!!deletingAsset} onOpenChange={open => { if (!open && !busy) setDeletingAsset(null) }} title="删除图片？"><div className="resend-confirmation"><strong>{deletingAsset?.name}</strong><p>{deletingAsset?.kind === 'reference' ? '将删除这张参考图并从参考图库移除。其他项目已保存的独立副本、已生成的作品不受影响。' : '将永久删除这张作品及其文件，历史消息中的图片链接也会移除。其他作品不受影响。'}</p><p>此操作无法撤销。</p><div className="actions"><button type="button" disabled={busy} onClick={() => setDeletingAsset(null)}>取消</button><button type="button" className="primary danger" disabled={busy} onClick={() => void deleteSelectedImage()}><Trash2 size={18} />确认删除图片</button></div>{error && <p role="alert" className="form-error">{error}</p>}</div></Modal>
    <Modal open={!!deleting} onOpenChange={open => { if (!open && !busy) setDeleting(null) }} title="删除项目？"><div className="resend-confirmation"><strong>{deleting?.title}</strong><p>将删除项目、对话、任务及素材，无法撤销。运行时检查点、模型会话及备份不在此次清理范围内。</p><div className="actions"><button disabled={busy} onClick={() => setDeleting(null)}>取消</button><button className="primary danger" disabled={busy} onClick={() => void deleteProject()}><Trash2 size={18} />确认删除</button></div>{error && <p role="alert" className="form-error">{error}</p>}</div></Modal>
  </div>
}