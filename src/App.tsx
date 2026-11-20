import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import Markdown from 'react-markdown'
import type { Components } from 'react-markdown'
import {
  ActionType, ResponsePartKind, ToolCallCancellationReason, ToolCallConfirmationReason,
} from '@microsoft/agent-host-protocol'
import type { ActiveTurn, ChatState, ResponsePart, Turn } from '@microsoft/agent-host-protocol'
import { api, ApiError } from './api'
import { ChatConnection } from './connection'
import { ImageAttachments } from './Attachments'
import { historyPageSize, imageLimits, permissionLabels, permissionModes, shortcuts, skillCatalog } from './shared'
import type { AttachmentInfo, ChatModel, ConversationSummary, ImageModelCatalogResponse, ModelCatalogResponse, PermissionMode, Settings, TurnPage, UserInfo } from './shared'

const errorText = (error: unknown) => error instanceof Error ? error.message : '操作失败'

function Icon({ name }: { name: 'sparkle' | 'chevron' | 'new-chat' | 'history' | 'settings' | 'close' | 'send' | 'stop' | 'copy' | 'check' | 'image' | 'video' | 'attach' | 'shield' }) {
  const icons = {
    sparkle: 'copilot', chevron: 'chevron-down', 'new-chat': 'comment-add',
    history: 'history', settings: 'gear', close: 'close', send: 'arrow-up',
    stop: 'primitive-square', copy: 'copy', check: 'check', image: 'file-media',
    video: 'device-camera-video', attach: 'add', shield: 'shield',
  }
  return <span className={`codicon codicon-${icons[name]}`} aria-hidden="true" />
}

export function App() {
  const [user, setUser] = useState<UserInfo>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  useEffect(() => {
    let active = true
    void api<UserInfo>('/me').then(value => { if (active) setUser(value) }).catch(error => {
      if (active && (!(error instanceof ApiError) || error.status !== 401)) setError(errorText(error))
    }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [])
  if (loading) return <main className="login"><p role="status">正在打开工作室…</p></main>
  return user ? <Studio key={user.id} user={user} onLogout={(message = '') => { setNotice(message); setUser(undefined) }} />
    : <Login onLogin={setUser} initialError={error} notice={notice} />
}

function Login({ onLogin, initialError, notice }: { onLogin: (user: UserInfo) => void; initialError: string; notice: string }) {
  const [error, setError] = useState(initialError)
  const [busy, setBusy] = useState(false)
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    setBusy(true); setError('')
    try { onLogin(await api<UserInfo>('/login', undefined, { username: form.get('username'), password: form.get('password') })) }
    catch (error) { setError(errorText(error)) }
    finally { setBusy(false) }
  }
  return <main className="login"><div className="brand-mark"><Icon name="sparkle" /></div><h1>Copilot Studio</h1>
    <form onSubmit={submit}>
      <label>账号<input name="username" autoComplete="username" required autoCapitalize="none" /></label>
      <label>密码<input name="password" type="password" autoComplete="current-password" minLength={6} maxLength={256} required /></label>
      {notice && <p role="status">{notice}</p>}
      {error && <p className="error" role="alert">{error}</p>}
      <button className="primary" disabled={busy}>{busy ? '正在登录…' : '进入工作室'}</button>
    </form>
  </main>
}

function Studio({ user, onLogout }: { user: UserInfo; onLogout: (message?: string) => void }) {
  const [settings, setSettings] = useState<Settings>()
  const [conversations, setConversations] = useState<ConversationSummary[]>([])
  const [current, setCurrent] = useState<ConversationSummary>()
  const [state, setState] = useState<ChatState>()
  const [olderTurns, setOlderTurns] = useState<Turn[]>([])
  const [hasMore, setHasMore] = useState(true)
  const [loadingHistory, setLoadingHistory] = useState(false)
  const historyRequest = useRef(false)
  const selectedConversation = useRef<string | undefined>(undefined)
  const [deleteTarget, setDeleteTarget] = useState<ConversationSummary>()
  const [deleting, setDeleting] = useState(false)
  const initialized = useRef(false)
  const [status, setStatus] = useState<'connecting' | 'connected' | 'offline'>('connecting')
  const [panel, setPanel] = useState<'sessions' | 'settings' | 'models' | 'permissions' | 'image-models' | 'password'>()
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('manual')
  const [permissionWarning, setPermissionWarning] = useState<PermissionMode>()
  const acknowledgedPermissions = useRef(new Set<PermissionMode>())
  const [imageCatalog, setImageCatalog] = useState<ImageModelCatalogResponse>()
  const [imageModelError, setImageModelError] = useState('')
  const [loadingImageModels, setLoadingImageModels] = useState(false)
  const [savingImageModel, setSavingImageModel] = useState(false)
  const [savingPermissions, setSavingPermissions] = useState(false)
  const [attachments, setAttachments] = useState<AttachmentInfo[]>([])
  const [uploading, setUploading] = useState(false)
  const attachmentInput = useRef<HTMLInputElement>(null)
  const [models, setModels] = useState<ChatModel[]>([])
  const [selectedModel, setSelectedModel] = useState('')
  const [loadingModels, setLoadingModels] = useState(false)
  const [switchingModel, setSwitchingModel] = useState(false)
  const [modelError, setModelError] = useState('')
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const connection = useRef<ChatConnection | undefined>(undefined)
  const firstMessage = useRef<{ id: string; text: string; attachments: AttachmentInfo[] } | undefined>(undefined)
  const input = useRef<HTMLTextAreaElement>(null)
  const scroll = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const anchor = useRef<{ id: string; top: number } | undefined>(undefined)
  const follow = useRef(true)
  const lastScrollTop = useRef(0)
  const [following, setFollowing] = useState(true)
  const lastSessionKey = `studio:last-conversation:${user.id}`
  function rememberConversation(id?: string) {
    try {
      if (id) localStorage.setItem(lastSessionKey, id)
      else localStorage.removeItem(lastSessionKey)
    } catch { setError('浏览器无法保存上次会话，重新打开时将使用最近更新的会话。') }
  }
  function openConversation(item?: ConversationSummary) {
    if (item && current?.id === item.id) return
    selectedConversation.current = item?.id
    rememberConversation(item?.id)
    setState(undefined); setOlderTurns([]); setHasMore(true)
    anchor.current = undefined
    follow.current = true; setFollowing(true); lastScrollTop.current = 0
    setCurrent(item); setStatus('connecting')
  }
  const expire = useCallback(() => onLogout(), [onLogout])
  const load = useCallback(async () => {
    try {
      const [settings, list] = await Promise.all([api<Settings>('/settings'), api<ConversationSummary[]>('/conversations')])
      setSettings(settings); setConversations(list)
      if (!initialized.current) {
        initialized.current = true
        let lastId: string | null = null
        try { lastId = localStorage.getItem(lastSessionKey) }
        catch { setError('浏览器无法读取上次会话，已使用最近更新的会话。') }
        const restored = list.find(item => item.id === lastId) ?? list[0]
        try {
          if (restored) localStorage.setItem(lastSessionKey, restored.id)
          else localStorage.removeItem(lastSessionKey)
        } catch { setError('浏览器无法保存上次会话，重新打开时将使用最近更新的会话。') }
        selectedConversation.current = restored?.id
        setCurrent(restored)
      }
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) onLogout()
      else setError(errorText(error))
    }
  }, [onLogout, lastSessionKey])
  useEffect(() => { void load() }, [load])
  const loadModels = useCallback(async (refresh = false) => {
    setLoadingModels(true); setModelError('')
    try {
      const catalog = await api<ModelCatalogResponse>(refresh ? '/models/refresh' : '/models', user, refresh ? {} : undefined)
      setModels(catalog.models)
      setSelectedModel(previous => previous || catalog.defaultModel || '')
    } catch (error) {
      setModels([]); setModelError(errorText(error))
      if (error instanceof ApiError && error.status === 401) onLogout()
    } finally { setLoadingModels(false) }
  }, [user, onLogout])
  useEffect(() => { void loadModels() }, [loadModels])
  useEffect(() => {
    if (current) setSelectedModel(current.model ?? (settings?.model.deployment || models[0]?.id || ''))
  }, [current?.id, current?.model, models, settings?.model.deployment])
  useEffect(() => { if (current) setPermissionMode(current.permissionMode ?? 'manual') }, [current?.id, current?.permissionMode])
  function acknowledge(text: string, sent: AttachmentInfo[]) {
    setDraft(value => value.trim() === text ? '' : value)
    setAttachments(value => value.filter(image => !sent.some(item => item.id === image.id)))
  }
  useEffect(() => {
    setState(undefined)
    if (!current) return
    follow.current = true
    const next = new ChatConnection(current.chat, (state, resetHistory) => {
      if (resetHistory) { setOlderTurns([]); setHasMore(true); anchor.current = undefined }
      setState(state)
    }, status => {
      setStatus(status)
      const queued = firstMessage.current
      if (status === 'connected' && queued?.id === current.id) {
        firstMessage.current = undefined
        void next.send(queued.text, queued.attachments).then(() => acknowledge(queued.text, queued.attachments))
          .catch(error => setError(errorText(error))).finally(() => setBusy(false))
      }
    }, setError, expire)
    connection.current = next
    void next.run().catch(error => setError(errorText(error)))
    return () => { next.close(); connection.current = undefined }
  }, [current?.id, expire])
  function scrollToLatest() {
    follow.current = true; setFollowing(true)
    if (scroll.current) {
      scroll.current.scrollTop = scroll.current.scrollHeight
      lastScrollTop.current = scroll.current.scrollTop
    }
  }
  useLayoutEffect(() => {
    const element = scroll.current
    if (!element) return
    if (anchor.current) {
      const saved = anchor.current
      const turn = element.querySelector<HTMLElement>(`[data-turn-id="${saved.id}"]`)
      if (turn) element.scrollTop += turn.getBoundingClientRect().top - saved.top
      anchor.current = undefined
      lastScrollTop.current = element.scrollTop
    } else if (follow.current) {
      element.scrollTop = element.scrollHeight
      lastScrollTop.current = element.scrollTop
    }
  }, [state, olderTurns, current?.id])
  useEffect(() => {
    const observer = new ResizeObserver(() => {
      if (follow.current) scrollToLatest()
    })
    if (content.current) observer.observe(content.current)
    if (scroll.current) observer.observe(scroll.current)
    return () => observer.disconnect()
  }, [])
  const recentTurns = state?.turns ?? []
  const recentIds = new Set(recentTurns.map(turn => turn.id))
  const visibleTurns = [...olderTurns.filter(turn => !recentIds.has(turn.id)), ...recentTurns]
  async function loadHistory() {
    const id = current?.id
    const first = visibleTurns[0]
    if (!id || !first || !hasMore || historyRequest.current) return
    historyRequest.current = true; setLoadingHistory(true)
    try {
      const page = await api<TurnPage>(`/conversations/${id}/turns?before=${first.id}`)
      if (selectedConversation.current !== id) return
      const element = scroll.current?.querySelector<HTMLElement>(`[data-turn-id="${first.id}"]`)
      if (element) anchor.current = { id: first.id, top: element.getBoundingClientRect().top }
      follow.current = false; setFollowing(false)
      setOlderTurns(turns => [...page.turns, ...turns]); setHasMore(page.hasMore)
    } catch (error) {
      if (selectedConversation.current === id) setError(errorText(error))
    } finally { historyRequest.current = false; setLoadingHistory(false) }
  }
  const active = Boolean(state?.activeTurn)
  const unavailableModel = Boolean(selectedModel && !loadingModels && !modelError && !models.some(model => model.id === selectedModel))
  async function send(event: FormEvent) {
    event.preventDefault()
    if ((!draft.trim() && !attachments.length) || busy || active || uploading) return
    if (!selectedModel || modelError || loadingModels || switchingModel || savingPermissions || unavailableModel) {
      setError('请先连接 Foundry 并选择一个可用的对话模型。')
      return
    }
    setBusy(true); setError('')
    try {
      if (!current) {
        const created = await api<ConversationSummary>('/conversations', user, { title: draft.trim().slice(0, 40) || '图片对话', model: selectedModel, permissionMode })
        firstMessage.current = { id: created.id, text: draft.trim(), attachments: [...attachments] }
        setConversations(list => [created, ...list]); openConversation(created)
        return
      }
      if (!connection.current) throw new Error('请等待对话连接')
      const text = draft.trim()
      const sent = [...attachments]
      scrollToLatest()
      await connection.current.send(text, sent)
      acknowledge(text, sent)
    } catch (error) { setError(errorText(error)) }
    finally { if (!firstMessage.current) setBusy(false) }
  }
  function chooseShortcut(shortcut: typeof shortcuts[number]) {
    setDraft(shortcut.prompt)
    setPanel(undefined)
    input.current?.focus()
  }
  async function chooseModel(id: string) {
    if (busy || active || switchingModel) return
    if (!current) { setSelectedModel(id); setPanel(undefined); return }
    setSwitchingModel(true); setError('')
    try {
      const updated = await api<ConversationSummary>(`/conversations/${current.id}/model`, user, { model: id }, 'PUT')
      setCurrent(updated)
      setConversations(list => list.map(item => item.id === updated.id ? updated : item))
      setSelectedModel(id); setPanel(undefined)
    } catch (error) { setError(errorText(error)) }
    finally { setSwitchingModel(false) }
  }
  async function choosePermission(mode: PermissionMode, confirmed = false) {
    if (busy || active || savingPermissions) return
    if (mode !== 'manual' && !confirmed && !acknowledgedPermissions.current.has(mode)) { setPermissionWarning(mode); return }
    if (!current) { setPermissionMode(mode); setPanel(undefined); return }
    setSavingPermissions(true); setError('')
    try {
      const updated = await api<ConversationSummary>(`/conversations/${current.id}/permissions`, user, { permissionMode: mode }, 'PUT')
      setCurrent(updated)
      setConversations(list => list.map(item => item.id === updated.id ? updated : item))
      setPermissionMode(mode); setPanel(undefined)
    } catch (error) { setError(errorText(error)) }
    finally { setSavingPermissions(false) }
  }
  async function loadImageModels(refresh = false) {
    setLoadingImageModels(true); setImageModelError('')
    try { setImageCatalog(await api<ImageModelCatalogResponse>(refresh ? '/image-models/refresh' : '/image-models', user, refresh ? {} : undefined)) }
    catch (error) { setImageModelError(errorText(error)) }
    finally { setLoadingImageModels(false) }
  }
  async function chooseImageModel(model: string) {
    if (!settings || savingImageModel || active || busy) return
    setSavingImageModel(true); setImageModelError('')
    try {
      const selected = await api<{ model: string }>('/settings/image', user, { model }, 'PUT')
      setSettings(value => value ? { ...value, image: { ...value.image, model: selected.model }, tools: value.tools.map(tool => tool.id === 'image_generation' ? { ...tool, label: selected.model } : tool) } : value)
      setImageCatalog(value => value ? { ...value, selectedModel: selected.model } : value)
      setPanel('settings')
    } catch (error) { setImageModelError(errorText(error)) }
    finally { setSavingImageModel(false) }
  }
  async function toggle(id: keyof Settings['skills']) {
    if (!settings || saving) return
    setSaving(true); setError('')
    try {
      const result = await api<Pick<Settings, 'skills'>>('/settings/skills', user, { ...settings.skills, [id]: !settings.skills[id] }, 'PUT')
      setSettings({ ...settings, skills: result.skills })
    } catch (error) { setError(errorText(error)) }
    finally { setSaving(false) }
  }
  function stop() {
    try {
      if (!state?.activeTurn || !connection.current) throw new Error('当前没有运行中的对话')
      connection.current.dispatch({ type: ActionType.ChatTurnCancelled, turnId: state.activeTurn.id, duration: 0 })
    } catch (error) { setError(errorText(error)) }
  }
  function approve(turnId: string, toolCallId: string, approved: boolean) {
    try {
      if (!connection.current) throw new Error('请等待重新连接')
      connection.current.dispatch(approved
        ? { type: ActionType.ChatToolCallConfirmed, turnId, toolCallId, approved: true, confirmed: ToolCallConfirmationReason.UserAction }
        : { type: ActionType.ChatToolCallConfirmed, turnId, toolCallId, approved: false, reason: ToolCallCancellationReason.Denied })
    } catch (error) { setError(errorText(error)) }
  }
  async function logout() {
    try { await api('/logout', user, {}); onLogout() }
    catch (error) { setError(errorText(error)) }
  }
  function newConversation() {
    firstMessage.current = undefined
    setError(''); setBusy(false); openConversation(); setDraft(''); setAttachments([]); setPermissionMode('manual'); setPanel(undefined)
  }
  async function deleteConversation() {
    if (!deleteTarget || deleting) return
    setDeleting(true); setError('')
    try {
      await api(`/conversations/${deleteTarget.id}`, user, undefined, 'DELETE')
      const remaining = conversations.filter(item => item.id !== deleteTarget.id)
      setConversations(remaining)
      setError('')
      if (current?.id === deleteTarget.id) {
        openConversation(remaining[0]); setDraft(''); setAttachments([])
      }
      setDeleteTarget(undefined)
    } catch (error) { setError(errorText(error)); setDeleteTarget(undefined) }
    finally { setDeleting(false) }
  }
  return <div className="studio">
    <header className="chat-header">
      <button className="chat-title" aria-label="会话列表" onClick={() => { setPanel('sessions'); void load() }}>聊天<Icon name="chevron" /></button>
      <div className="header-actions">
        <button className="icon" aria-label="新对话" title="新对话" disabled={busy} onClick={newConversation}><Icon name="new-chat" /></button>
        <button className="icon" aria-label="历史对话" title="历史对话" onClick={() => { setPanel('sessions'); void load() }}><Icon name="history" /></button>
        <button className="icon" aria-label="设置" title="设置" onClick={() => setPanel('settings')}><Icon name="settings" /></button>
      </div>
    </header>
    {current && <div className="session-heading"><span>{current.title}</span><span className={`connection-dot ${status}`} role="status" aria-label={status === 'connected' ? '已连接' : status === 'connecting' ? '正在连接' : '连接中断，正在重连'} /></div>}
    {settings && !settings.model.configured && <div className="error banner" role="alert">未配置对话模型</div>}
    {error && <div className="error banner" role="alert"><span>{error}</span><button aria-label="关闭提示" onClick={() => setError('')}>×</button></div>}
    <div className="conversation" ref={scroll} onScroll={() => {
      const element = scroll.current
      if (!element) return
      const movedUp = element.scrollTop < lastScrollTop.current
      follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 40
      setFollowing(follow.current)
      lastScrollTop.current = element.scrollTop
      if (movedUp && element.scrollTop < 80) void loadHistory()
    }}>
      <div ref={content}>
      {current && !state && <p className="muted small" role="status">正在加载会话…</p>}
      {visibleTurns.length >= historyPageSize && hasMore && <button className="load-history" disabled={loadingHistory} onClick={() => { void loadHistory() }}>{loadingHistory ? '正在加载…' : '加载更早的对话'}</button>}
      {!current && <section className="welcome">
        <div className="copilot-mark"><Icon name="sparkle" /></div><h1>Copilot</h1>
        <div className="shortcuts">{shortcuts.map(shortcut => <button key={shortcut.label} className="shortcut"
          disabled={Boolean(shortcut.skill && !settings?.skills[shortcut.skill])}
          onClick={() => chooseShortcut(shortcut)}><Icon name={shortcut.skill === 'image-production' ? 'image' : shortcut.skill === 'video-production' ? 'video' : 'sparkle'} /><span>{shortcut.label}</span><span className="shortcut-arrow" aria-hidden="true">→</span></button>)}</div>
      </section>}
      {visibleTurns.map(turn => <TurnView key={turn.id} turn={turn} username={user.username} approve={approve} onError={setError} />)}
      {state?.activeTurn && <TurnView turn={state.activeTurn} username={user.username} approve={approve} onError={setError} active />}
      {state?.activity && <p className="muted small" role="status">{state.activity}</p>}
      </div>
    </div>
    {!following && current && <button className="jump-latest" onClick={scrollToLatest}>回到最新消息</button>}
    <form className="composer" onSubmit={send}>
      <div className="composer-box">
        <ImageAttachments user={user} value={attachments} onChange={setAttachments} inputRef={attachmentInput}
          disabled={busy || active || savingPermissions || switchingModel} onBusyChange={setUploading} onError={setError} />
        <textarea ref={input} aria-label="消息" placeholder="描述你想完成的任务…" rows={3} maxLength={12000} value={draft} onChange={event => setDraft(event.target.value)} />
        <div className="composer-toolbar">
          <button type="button" className="icon context-button" aria-label="添加图片" title="添加图片" disabled={busy || active || uploading || attachments.length >= imageLimits.maxAttachments}
            onClick={() => attachmentInput.current?.click()}><Icon name="attach" /></button>
          <span className="agent-mode" aria-label="当前模式：Agent">Agent</span>
          <button type="button" className="model-trigger" aria-label={`选择模型：${selectedModel || '尚未连接'}`} aria-haspopup="dialog"
            disabled={busy || active || switchingModel} onClick={() => setPanel('models')}>
            <span>{loadingModels ? '加载模型…' : selectedModel || '选择模型'}</span><Icon name="chevron" />
          </button>
          <button type="button" className={`permission-trigger${permissionMode !== 'manual' ? ' allow-all' : ''}`} aria-label={`权限：${permissionLabels[permissionMode]}`} title={permissionLabels[permissionMode]} aria-haspopup="dialog"
            disabled={busy || active || savingPermissions || switchingModel} onClick={() => setPanel('permissions')}><Icon name="shield" /><span className="permission-label">{permissionLabels[permissionMode]}</span><Icon name="chevron" /></button>
          {active ? <button type="button" className="primary send" onClick={stop} aria-label="停止" title="停止"><Icon name="stop" /></button>
            : <button className="primary send" disabled={busy || uploading || savingPermissions || switchingModel || loadingModels || unavailableModel || Boolean(modelError) || !selectedModel || (!draft.trim() && !attachments.length) || Boolean(current && status !== 'connected')} aria-label="发送" title="发送">{busy ? <span className="send-pending">…</span> : <Icon name="send" />}</button>}
        </div>
      </div>
      {modelError && <p className="model-error" role="alert">{modelError}</p>}
      {unavailableModel && <p className="model-error" role="alert">当前会话的模型已不可用，请选择另一个模型后发送；不会自动切换。</p>}
    </form>
    {panel && <div className={`overlay${panel === 'models' || panel === 'permissions' ? ' model-overlay' : ''}`} onClick={() => setPanel(undefined)}>
      <section className={`sheet${panel === 'permissions' ? ' permission-menu' : ''}`} role="dialog" aria-modal="true" aria-label={panel === 'settings' ? '设置' : panel === 'password' ? '修改密码' : panel === 'models' ? '选择模型' : panel === 'image-models' ? '图片模型' : panel === 'permissions' ? '权限' : '会话列表'} onClick={event => event.stopPropagation()}>
        {panel !== 'permissions' && <div className="sheet-heading"><h2>{panel === 'settings' ? '工作室设置' : panel === 'password' ? '修改密码' : panel === 'models' ? '选择模型' : panel === 'image-models' ? 'image_generation' : '我的对话'}</h2><button className="icon" aria-label="关闭" onClick={() => setPanel(undefined)}><Icon name="close" /></button></div>}
        {panel === 'permissions' ? <div className="permission-options">
          {permissionModes.map(mode => <button key={mode} aria-pressed={permissionMode === mode} disabled={busy || active || savingPermissions}
            onClick={() => { void choosePermission(mode) }}><span className="permission-check">{permissionMode === mode && <Icon name="check" />}</span><span>{permissionLabels[mode]}</span></button>)}
        </div> : panel === 'image-models' ? <>
          <div className="model-source"><span className="muted small">Azure Foundry</span><button disabled={loadingImageModels || savingImageModel} onClick={() => { void loadImageModels(true) }}>{loadingImageModels ? '刷新中…' : '刷新列表'}</button></div>
          {imageModelError && <p className="error" role="alert">{imageModelError}</p>}
          {!loadingImageModels && !imageModelError && !imageCatalog?.models.length && <p className="muted small">无可用图片模型</p>}
          <div className="model-list">{imageCatalog?.models.map(model => <button key={model.id} aria-pressed={imageCatalog.selectedModel === model.id}
            disabled={loadingImageModels || savingImageModel || active || busy} onClick={() => { void chooseImageModel(model.id) }}>
            <span><strong>{model.id}</strong><span className="muted small">{model.version}{model.id === imageCatalog.defaultModel ? ' · 默认' : ''}</span></span>{imageCatalog.selectedModel === model.id && <Icon name="check" />}
          </button>)}</div>
        </> : panel === 'models' ? <>
          <div className="model-source"><span className="muted small">Azure Foundry · {settings?.model.authMode === 'azure-cli' ? 'az login' : '托管身份'}</span>
            <button disabled={loadingModels || switchingModel} onClick={() => { void loadModels(true) }}>{loadingModels ? '刷新中…' : '刷新列表'}</button></div>
          {modelError && <p className="error" role="alert">{modelError}</p>}
          {!loadingModels && !modelError && !models.length && <p className="muted small">无可用模型</p>}
          <div className="model-list">{models.map(model => <button key={model.id} aria-pressed={model.id === selectedModel}
            disabled={busy || active || switchingModel || loadingModels} onClick={() => { void chooseModel(model.id) }}>
            <span><strong>{model.id}</strong><span className="muted small">{model.provider} · {model.name}{model.version && ` · ${model.version}`}</span></span>
            {model.id === selectedModel && <Icon name="check" />}
          </button>)}</div>
        </> : panel === 'password' ? <PasswordForm user={user} onChanged={() => onLogout('密码已修改，请重新登录')} /> : panel === 'sessions' ? <>
          <button className="primary" disabled={busy} onClick={newConversation}>＋ 新对话</button>
          <div className="session-list">{conversations.map(item => <div className="session-row" key={item.id}>
            <button disabled={busy || deleting} aria-current={current?.id === item.id ? 'true' : undefined} onClick={() => {
              setError(''); openConversation(item); setDraft(''); setAttachments([]); setPanel(undefined)
            }}><strong>{item.title}</strong><span className="muted small">{new Date(item.updatedAt).toLocaleString()}</span></button>
            <button aria-label={`删除会话：${item.title}`} disabled={busy || deleting || (current?.id === item.id && active)} onClick={() => setDeleteTarget(item)}>删除</button>
          </div>)}</div>
        </> : <>
          <h3>对话</h3>
          <button className="setting-row" aria-label="配置对话模型" disabled={busy || active || switchingModel} onClick={() => setPanel('models')}>
            <span>对话模型</span><span className="setting-value">{selectedModel || '选择模型'}<Icon name="chevron" /></span>
          </button>
          <button className="setting-row" aria-label="配置权限" disabled={busy || active || savingPermissions || switchingModel} onClick={() => setPanel('permissions')}>
            <span>权限</span><span className="setting-value">{permissionLabels[permissionMode]}<Icon name="chevron" /></span>
          </button>
          <h3>工具</h3>
          <button className="setting-row" aria-label="配置 image_generation" disabled={!settings || busy || active || savingImageModel} onClick={() => { setPanel('image-models'); void loadImageModels() }}>
            <span>图片模型</span><span className="setting-value">{settings?.image.model || '选择模型'}<Icon name="chevron" /></span>
          </button>
          <h3>Skills</h3>
          {skillCatalog.map(skill => <label className="skill" key={skill.id}><strong>{skill.name}</strong>
            <input aria-label={skill.name} type="checkbox" role="switch" checked={settings?.skills[skill.id] ?? false} disabled={!settings || saving} onChange={() => { void toggle(skill.id) }} /></label>)}
          <div className="account"><span>{user.username}</span><button onClick={() => setPanel('password')}>修改密码</button><button onClick={() => { void logout() }}>退出登录</button></div>
        </>}
      </section>
    </div>}
    {deleteTarget && <div className="overlay delete-warning">
      <section className="sheet" role="alertdialog" aria-modal="true" aria-labelledby="delete-title">
        <h2 id="delete-title">删除会话？</h2><p>将永久删除「{deleteTarget.title}」的聊天记录，无法撤销。</p>
        <div className="actions"><button disabled={deleting} onClick={() => setDeleteTarget(undefined)}>取消</button>
          <button className="primary" disabled={deleting} onClick={() => { void deleteConversation() }}>{deleting ? '正在删除…' : '确认删除'}</button></div>
      </section>
    </div>}
    {permissionWarning && <div className="overlay permission-warning">
      <section className="sheet" role="alertdialog" aria-modal="true" aria-labelledby="permission-warning-title">
        <h2 id="permission-warning-title">启用 {permissionLabels[permissionWarning]}？</h2>
        <p>{permissionWarning === 'assisted' ? '模型将评估工具调用并自动批准通过评估的操作，判断可能出错；其余操作仍需确认。' : '已启用的工具将不再逐次确认，联网搜索、图片和视频调用可能产生费用。'}</p>
        <div className="actions"><button onClick={() => setPermissionWarning(undefined)}>取消</button><button className="primary" onClick={() => {
          const mode = permissionWarning
          acknowledgedPermissions.current.add(mode); setPermissionWarning(undefined); void choosePermission(mode, true)
        }}>启用</button></div>
      </section>
    </div>}
  </div>
}

function PasswordForm({ user, onChanged }: { user: UserInfo; onChanged: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    if (form.get('newPassword') !== form.get('confirmPassword')) { setError('两次输入的新密码不一致'); return }
    setBusy(true); setError('')
    try {
      await api('/password', user, { currentPassword: form.get('currentPassword'), newPassword: form.get('newPassword') })
      onChanged()
    } catch (error) { setError(errorText(error)) }
    finally { setBusy(false) }
  }
  return <form className="password-form" onSubmit={submit}>
    <label>当前密码<input name="currentPassword" type="password" autoComplete="current-password" maxLength={256} required disabled={busy} /></label>
    <label>新密码<input name="newPassword" type="password" autoComplete="new-password" minLength={6} maxLength={256} required disabled={busy} /></label>
    <label>确认新密码<input name="confirmPassword" type="password" autoComplete="new-password" minLength={6} maxLength={256} required disabled={busy} /></label>
    {error && <p className="error" role="alert">{error}</p>}
    <button className="primary" disabled={busy}>{busy ? '保存中…' : '保存并重新登录'}</button>
  </form>
}

function CopyButton({ text, onError }: { text: string; onError: (message: string) => void }) {
  const [copied, setCopied] = useState(false)
  return <button className="icon copy-button" aria-label={copied ? '已复制' : '复制消息'} title={copied ? '已复制' : '复制消息'} onBlur={() => setCopied(false)} onClick={() => {
    if (!navigator.clipboard) { onError('当前浏览器不支持复制，请使用 HTTPS 或本机地址。'); return }
    void navigator.clipboard.writeText(text).then(() => setCopied(true)).catch(error => onError(errorText(error)))
  }}><Icon name={copied ? 'check' : 'copy'} /></button>
}
function TurnView({ turn, active, username, approve, onError }: { turn: Turn | ActiveTurn; active?: boolean; username: string; approve: (turn: string, tool: string, approved: boolean) => void; onError: (message: string) => void }) {
  const text = turn.responseParts.filter(part => part.kind === ResponsePartKind.Markdown).map(part => part.content).join('\n\n')
  return <section className="turn" data-turn-id={turn.id}><div className="user-message">
    <div className="message-heading"><span className="user-avatar" aria-hidden="true">{username.slice(0, 1).toUpperCase()}</span><strong>{username}</strong><CopyButton text={turn.message.text} onError={onError} /></div>
    <div className="user-content">{turn.message.text}</div>
    {turn.message.attachments?.length ? <div className="message-images">{turn.message.attachments.map((image, index) => {
      const id = 'uri' in image ? /^studio-attachment:\/([0-9a-f-]{36})$/.exec(image.uri)?.[1] : undefined
      return id ? <ChatImage key={id} src={`/api/attachments/${id}`} alt={image.label || `图片 ${index + 1}`} thumbnail /> : null
    })}</div> : null}
  </div><div className="assistant-message">
    <div className="message-heading assistant-label"><span className="assistant-avatar"><Icon name="sparkle" /></span><strong>Copilot</strong></div>
    {turn.responseParts.map((part, index) => <Part key={index} part={part} approve={approved => {
      if (part.kind === ResponsePartKind.ToolCall) approve(turn.id, part.toolCall.toolCallId, approved)
    }} />)}
    {active && !turn.responseParts.length && <span className="thinking" role="status">正在思考…</span>}
    {'state' in turn && turn.state === 'cancelled' && <p className="muted small">已停止。已提交的外部任务仍可能计费。</p>}
    {!active && text && <div className="response-actions"><CopyButton text={text} onError={onError} /></div>}
  </div></section>
}
function Part({ part, approve }: { part: ResponsePart; approve: (approved: boolean) => void }) {
  if (part.kind === ResponsePartKind.Markdown) return <div className="markdown"><Markdown skipHtml components={markdownComponents}>{part.content}</Markdown></div>
  if (part.kind === ResponsePartKind.Error) return <p className="error">{part.error.message}</p>
  if (part.kind === ResponsePartKind.ToolCall) {
    const tool = part.toolCall
    return <details className="tool-call" open={tool.status === 'pending-confirmation'}>
      <summary>{tool.displayName} · {tool.status === 'pending-confirmation' ? '等待确认' : tool.status === 'running' ? '执行中' : tool.status === 'completed' ? tool.success ? '完成' : '失败' : tool.status === 'cancelled' ? '已拒绝' : '准备中'}</summary>
      <p className="tool-input">{typeof tool.invocationMessage === 'string' ? tool.invocationMessage : tool.invocationMessage?.markdown}</p>
      {tool.status === 'pending-confirmation' && <div className="actions"><button onClick={() => approve(false)}>不执行</button><button className="primary" onClick={() => approve(true)}>确认执行</button></div>}
    </details>
  }
  return null
}

const markdownComponents: Components = {
  img: ({ src, alt }) => typeof src === 'string' && /^\/api\/attachments\/[0-9a-f-]{36}$/.test(src)
    ? <ChatImage src={src} alt={alt || '图片'} /> : null,
  a: ({ href, children }) => <a href={href && /^https?:\/\//i.test(href) ? href : undefined} target="_blank" rel="noreferrer noopener">{children}</a>,
}

function ChatImage({ src, alt, thumbnail = false }: { src: string; alt: string; thumbnail?: boolean }) {
  const [status, setStatus] = useState<'loading' | 'loaded' | 'error'>('loading')
  const [attempt, setAttempt] = useState(0)
  return <span className={`chat-image${thumbnail ? ' thumbnail' : ''}`} aria-busy={status === 'loading'}>
    <a href={src} target="_blank" rel="noreferrer noopener" aria-label={`查看原图：${alt}`}>
      <img key={attempt} src={src} alt={alt} loading="lazy" decoding="async" onLoad={() => setStatus('loaded')} onError={() => setStatus('error')} />
    </a>
    {status === 'loading' && <span className="image-status" role="status">图片加载中…</span>}
    {status === 'error' && <span className="image-status" role="alert">图片加载失败<button type="button" onClick={() => { setStatus('loading'); setAttempt(value => value + 1) }}>重试</button></span>}
  </span>
}
