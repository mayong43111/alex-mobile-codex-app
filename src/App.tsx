import { useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import Markdown from 'react-markdown'
import {
  ActionType, ResponsePartKind, ToolCallCancellationReason, ToolCallConfirmationReason,
} from '@microsoft/agent-host-protocol'
import type { ActiveTurn, ChatState, ResponsePart, Turn } from '@microsoft/agent-host-protocol'
import { api, ApiError } from './api'
import { ChatConnection } from './connection'
import { ImageAttachments } from './Attachments'
import { imageLimits, permissionLabels, permissionModes, shortcuts, skillCatalog } from './shared'
import type { AttachmentInfo, ChatModel, ConversationSummary, ImageModelCatalogResponse, ModelCatalogResponse, PermissionMode, Settings, UserInfo } from './shared'

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
  useEffect(() => {
    let active = true
    void api<UserInfo>('/me').then(value => { if (active) setUser(value) }).catch(error => {
      if (active && (!(error instanceof ApiError) || error.status !== 401)) setError(errorText(error))
    }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [])
  if (loading) return <main className="login"><p role="status">正在打开工作室…</p></main>
  return user ? <Studio key={user.id} user={user} onLogout={() => setUser(undefined)} />
    : <Login onLogin={setUser} initialError={error} />
}

function Login({ onLogin, initialError }: { onLogin: (user: UserInfo) => void; initialError: string }) {
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
      {error && <p className="error" role="alert">{error}</p>}
      <button className="primary" disabled={busy}>{busy ? '正在登录…' : '进入工作室'}</button>
    </form>
  </main>
}

function Studio({ user, onLogout }: { user: UserInfo; onLogout: () => void }) {
  const [settings, setSettings] = useState<Settings>()
  const [conversations, setConversations] = useState<ConversationSummary[]>([])
  const [current, setCurrent] = useState<ConversationSummary>()
  const [state, setState] = useState<ChatState>()
  const [status, setStatus] = useState<'connecting' | 'connected' | 'offline'>('connecting')
  const [panel, setPanel] = useState<'sessions' | 'settings' | 'models' | 'permissions' | 'image-models'>()
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
  const follow = useRef(true)
  const expire = useCallback(() => onLogout(), [onLogout])
  const load = useCallback(async () => {
    try {
      const [settings, list] = await Promise.all([api<Settings>('/settings'), api<ConversationSummary[]>('/conversations')])
      setSettings(settings); setConversations(list)
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) onLogout()
      else setError(errorText(error))
    }
  }, [onLogout])
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
    const next = new ChatConnection(current.chat, setState, status => {
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
  useEffect(() => {
    if (follow.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight
  }, [state])
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
        setConversations(list => [created, ...list]); setCurrent(created)
        return
      }
      if (!connection.current) throw new Error('请等待对话连接')
      const text = draft.trim()
      const sent = [...attachments]
      await connection.current.send(text, sent)
      acknowledge(text, sent)
      follow.current = true
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
    setBusy(false); setCurrent(undefined); setDraft(''); setAttachments([]); setPermissionMode('manual'); setPanel(undefined); setError('')
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
      if (scroll.current) follow.current = scroll.current.scrollHeight - scroll.current.scrollTop - scroll.current.clientHeight < 100
    }}>
      {!state?.turns.length && !state?.activeTurn && <section className="welcome">
        <div className="copilot-mark"><Icon name="sparkle" /></div><h1>Copilot</h1>
        <div className="shortcuts">{shortcuts.map(shortcut => <button key={shortcut.label} className="shortcut"
          disabled={Boolean(shortcut.skill && !settings?.skills[shortcut.skill])}
          onClick={() => chooseShortcut(shortcut)}><Icon name={shortcut.skill === 'image-production' ? 'image' : shortcut.skill === 'video-production' ? 'video' : 'sparkle'} /><span>{shortcut.label}</span><span className="shortcut-arrow" aria-hidden="true">→</span></button>)}</div>
      </section>}
      {state?.turns.map(turn => <TurnView key={turn.id} turn={turn} username={user.username} approve={approve} onError={setError} />)}
      {state?.activeTurn && <TurnView turn={state.activeTurn} username={user.username} approve={approve} onError={setError} active />}
      {state?.activity && <p className="muted small" role="status">{state.activity}</p>}
    </div>
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
      <section className={`sheet${panel === 'permissions' ? ' permission-menu' : ''}`} role="dialog" aria-modal="true" aria-label={panel === 'settings' ? '设置' : panel === 'models' ? '选择模型' : panel === 'image-models' ? '图片模型' : panel === 'permissions' ? '权限' : '会话列表'} onClick={event => event.stopPropagation()}>
        {panel !== 'permissions' && <div className="sheet-heading"><h2>{panel === 'settings' ? '工作室设置' : panel === 'models' ? '选择模型' : panel === 'image-models' ? 'image_generation' : '我的对话'}</h2><button className="icon" aria-label="关闭" onClick={() => setPanel(undefined)}><Icon name="close" /></button></div>}
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
        </> : panel === 'sessions' ? <>
          <button className="primary" disabled={busy} onClick={newConversation}>＋ 新对话</button>
          <div className="session-list">{conversations.map(item => <button key={item.id} onClick={() => {
            setCurrent(item); setDraft(''); setAttachments([]); setError(''); setPanel(undefined)
          }}><strong>{item.title}</strong><span className="muted small">{new Date(item.updatedAt).toLocaleString()}</span></button>)}</div>
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
          <div className="account"><span>{user.username}</span><button onClick={() => { void logout() }}>退出登录</button></div>
        </>}
      </section>
    </div>}
    {permissionWarning && <div className="overlay permission-warning">
      <section className="sheet" role="alertdialog" aria-modal="true" aria-labelledby="permission-warning-title">
        <h2 id="permission-warning-title">启用 {permissionLabels[permissionWarning]}？</h2>
        <p>{permissionWarning === 'assisted' ? '模型将评估工具调用并自动批准通过评估的操作，判断可能出错；其余操作仍需确认。' : '已启用的工具将不再逐次确认，图片和视频调用可能产生费用。'}</p>
        <div className="actions"><button onClick={() => setPermissionWarning(undefined)}>取消</button><button className="primary" onClick={() => {
          const mode = permissionWarning
          acknowledgedPermissions.current.add(mode); setPermissionWarning(undefined); void choosePermission(mode, true)
        }}>启用</button></div>
      </section>
    </div>}
  </div>
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
  return <section className="turn"><div className="user-message">
    <div className="message-heading"><span className="user-avatar" aria-hidden="true">{username.slice(0, 1).toUpperCase()}</span><strong>{username}</strong><CopyButton text={turn.message.text} onError={onError} /></div>
    <div className="user-content">{turn.message.text}</div>
    {turn.message.attachments?.length ? <div className="message-images">{turn.message.attachments.map((image, index) => {
      const id = 'uri' in image ? /^studio-attachment:\/([0-9a-f-]{36})$/.exec(image.uri)?.[1] : undefined
      return id ? <a key={id} href={`/api/attachments/${id}`} target="_blank" rel="noreferrer noopener"><img src={`/api/attachments/${id}`} alt={image.label || `图片 ${index + 1}`} loading="lazy" /></a> : null
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
  if (part.kind === ResponsePartKind.Markdown) return <div className="markdown"><Markdown skipHtml components={{
    img: ({ src, alt }) => typeof src === 'string' && /^\/api\/attachments\/[0-9a-f-]{36}$/.test(src)
      ? <a href={src} target="_blank" rel="noreferrer noopener"><img src={src} alt={alt || '图片'} loading="lazy" /></a> : null,
    a: ({ href, children }) => <a href={href && /^https?:\/\//i.test(href) ? href : undefined} target="_blank" rel="noreferrer noopener">{children}</a>,
  }}>{part.content}</Markdown></div>
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
