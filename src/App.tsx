import { useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import Markdown from 'react-markdown'
import {
  ActionType, ResponsePartKind, ToolCallCancellationReason, ToolCallConfirmationReason,
} from '@microsoft/agent-host-protocol'
import type { ActiveTurn, ChatState, ResponsePart, Turn } from '@microsoft/agent-host-protocol'
import { api, ApiError } from './api'
import { ChatConnection } from './connection'
import { shortcuts, skillCatalog } from './shared'
import type { ConversationSummary, Settings, UserInfo } from './shared'

const errorText = (error: unknown) => error instanceof Error ? error.message : '操作失败'

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
  return <main className="login"><div className="brand-mark">✦</div><h1>你的创作，从对话开始</h1>
    <p className="muted">Copilot Studio · 手机创作工作室</p>
    <form onSubmit={submit}>
      <label>账号<input name="username" autoComplete="username" required autoCapitalize="none" /></label>
      <label>密码<input name="password" type="password" autoComplete="current-password" minLength={12} maxLength={256} required /></label>
      {error && <p className="error" role="alert">{error}</p>}
      <button className="primary" disabled={busy}>{busy ? '正在登录…' : '进入工作室'}</button>
    </form><p className="muted small">仅限管理员创建的账号，无公开注册。</p>
  </main>
}

function Studio({ user, onLogout }: { user: UserInfo; onLogout: () => void }) {
  const [settings, setSettings] = useState<Settings>()
  const [conversations, setConversations] = useState<ConversationSummary[]>([])
  const [current, setCurrent] = useState<ConversationSummary>()
  const [state, setState] = useState<ChatState>()
  const [status, setStatus] = useState<'connecting' | 'connected' | 'offline'>('connecting')
  const [panel, setPanel] = useState<'sessions' | 'settings'>()
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const connection = useRef<ChatConnection | undefined>(undefined)
  const firstMessage = useRef<{ id: string; text: string } | undefined>(undefined)
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
  useEffect(() => {
    setState(undefined)
    if (!current) return
    follow.current = true
    const next = new ChatConnection(current.chat, setState, status => {
      setStatus(status)
      const queued = firstMessage.current
      if (status === 'connected' && queued?.id === current.id) {
        firstMessage.current = undefined
        void next.send(queued.text).then(() => setDraft(value => value === queued.text ? '' : value))
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
  async function send(event: FormEvent) {
    event.preventDefault()
    if (!draft.trim() || busy || active) return
    setBusy(true); setError('')
    try {
      if (!current) {
        const created = await api<ConversationSummary>('/conversations', user, { title: draft.trim().slice(0, 40) })
        firstMessage.current = { id: created.id, text: draft.trim() }
        setConversations(list => [created, ...list]); setCurrent(created)
        return
      }
      if (!connection.current) throw new Error('请等待对话连接')
      await connection.current.send(draft.trim())
      setDraft('')
      follow.current = true
    } catch (error) { setError(errorText(error)) }
    finally { if (!firstMessage.current) setBusy(false) }
  }
  function chooseShortcut(shortcut: typeof shortcuts[number]) {
    setDraft(shortcut.prompt)
    setPanel(undefined)
    input.current?.focus()
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
  return <div className="studio">
    <header>
      <button className="icon" aria-label="会话列表" onClick={() => { setPanel('sessions'); void load() }}>☰</button>
      <div className="heading"><strong>{current?.title ?? 'Copilot Studio'}</strong>
        <span className="muted small">{current ? status === 'connected' ? '已连接 · Copilot / Azure' : status === 'connecting' ? '正在连接…' : '连接中断，正在重连…' : '灵感在这里发生'}</span>
      </div>
      <button className="icon" aria-label="设置" onClick={() => setPanel('settings')}>⚙</button>
    </header>
    {settings && !settings.model.configured && <div className="notice" role="status">Azure 对话模型尚未配置。可先查看界面与 Skill 设置；发送不会调用替代模型。</div>}
    {error && <div className="error banner" role="alert"><span>{error}</span><button aria-label="关闭提示" onClick={() => setError('')}>×</button></div>}
    <div className="conversation" ref={scroll} onScroll={() => {
      if (scroll.current) follow.current = scroll.current.scrollHeight - scroll.current.scrollTop - scroll.current.clientHeight < 100
    }}>
      {!state?.turns.length && !state?.activeTurn && <section className="welcome">
        <div className="brand-mark">✦</div><h1>今天，想创作什么？</h1><p className="muted">从一个想法开始，让 Copilot 帮你展开。</p>
        <div className="shortcuts">{shortcuts.map(shortcut => <button key={shortcut.label} className="shortcut"
          disabled={Boolean(shortcut.skill && !settings?.skills[shortcut.skill])}
          onClick={() => chooseShortcut(shortcut)}><span>{shortcut.icon}</span>{shortcut.label}</button>)}</div>
        <p className="muted small">快捷指令只填入草稿，确认后发送。工具执行前还会征求你的同意。</p>
      </section>}
      {state?.turns.map(turn => <TurnView key={turn.id} turn={turn} approve={approve} />)}
      {state?.activeTurn && <TurnView turn={state.activeTurn} approve={approve} active />}
      {state?.activity && <p className="muted small" role="status">{state.activity}</p>}
    </div>
    <form className="composer" onSubmit={send}>
      <div className="quick-row">{shortcuts.filter(item => item.skill && settings?.skills[item.skill]).map(shortcut =>
        <button type="button" key={shortcut.label} onClick={() => chooseShortcut(shortcut)}>{shortcut.label}</button>)}</div>
      <div className="input-row"><textarea ref={input} aria-label="消息" placeholder="描述你的想法…" rows={2} maxLength={12000} value={draft} onChange={event => setDraft(event.target.value)} />
        {active ? <button type="button" className="primary send" onClick={stop} aria-label="停止">■</button>
          : <button className="primary send" disabled={busy || !draft.trim() || Boolean(current && status !== 'connected')} aria-label="发送">{busy ? '…' : '↑'}</button>}
      </div><span className="muted small">AI 可能出错，重要结果请核实。</span>
    </form>
    {panel && <div className="overlay" onClick={() => setPanel(undefined)}>
      <section className="sheet" role="dialog" aria-modal="true" aria-label={panel === 'settings' ? '设置' : '会话列表'} onClick={event => event.stopPropagation()}>
        <div className="sheet-heading"><h2>{panel === 'settings' ? '工作室设置' : '我的对话'}</h2><button className="icon" aria-label="关闭" onClick={() => setPanel(undefined)}>×</button></div>
        {panel === 'sessions' ? <>
          <button className="primary" onClick={() => { firstMessage.current = undefined; setBusy(false); setCurrent(undefined); setDraft(''); setPanel(undefined) }}>＋ 新对话</button>
          <div className="session-list">{conversations.map(item => <button key={item.id} onClick={() => {
            setCurrent(item); setDraft(''); setError(''); setPanel(undefined)
          }}><strong>{item.title}</strong><span className="muted small">{new Date(item.updatedAt).toLocaleString()}</span></button>)}</div>
        </> : <>
          <h3>我的 Skills</h3><p className="muted small">只允许启用或停用。修改从下一条消息开始生效，不删除历史对话。</p>
          {skillCatalog.map(skill => <label className="skill" key={skill.id}><div><strong>{skill.name}</strong><p className="muted small">{skill.description}</p></div>
            <input aria-label={skill.name} type="checkbox" role="switch" checked={settings?.skills[skill.id] ?? false} disabled={!settings || saving} onChange={() => { void toggle(skill.id) }} /></label>)}
          <h3>工具连接</h3><p className="muted small">由管理员配置 MCP 服务和工具白名单。Skill 不包含图片或视频模型。</p>
          {settings?.tools.length ? settings.tools.map(tool => <div className="tool-config" key={tool.id}><strong>{tool.label}</strong><span className="muted small">{tool.configured ? '已配置' : '缺少服务凭据'} · {settings.skills[tool.skill] ? 'Skill 已启用' : 'Skill 已停用'}</span><code>{tool.tools.join(', ')}</code></div>)
            : <div className="empty-config">尚未接入媒体工具。仍可对话、写提示词和规划分镜。</div>}
          <h3>对话引擎</h3><p className="muted small">Copilot SDK + AHP<br />{settings?.model.deployment || '待配置 Azure 部署'} · {settings?.model.authMode}</p>
          <div className="account"><span>{user.username}</span><button onClick={() => { void logout() }}>退出登录</button></div>
        </>}
      </section>
    </div>}
  </div>
}

function TurnView({ turn, active, approve }: { turn: Turn | ActiveTurn; active?: boolean; approve: (turn: string, tool: string, approved: boolean) => void }) {
  return <section className="turn"><div className="user-message">{turn.message.text}</div><div className="assistant-message">
    <span className="assistant-label">✦ Copilot</span>
    {turn.responseParts.map((part, index) => <Part key={index} part={part} approve={approved => {
      if (part.kind === ResponsePartKind.ToolCall) approve(turn.id, part.toolCall.toolCallId, approved)
    }} />)}
    {active && !turn.responseParts.length && <span className="thinking" role="status">正在思考…</span>}
    {'state' in turn && turn.state === 'cancelled' && <p className="muted small">已停止。已提交的外部任务仍可能计费。</p>}
  </div></section>
}
function Part({ part, approve }: { part: ResponsePart; approve: (approved: boolean) => void }) {
  if (part.kind === ResponsePartKind.Markdown) return <div className="markdown"><Markdown skipHtml components={{
    img: () => <span>[图片由工具提供；当前版本不自动加载外部图片]</span>,
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
