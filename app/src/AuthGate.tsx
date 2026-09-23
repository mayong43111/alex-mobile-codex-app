import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { Aperture, LogIn, LoaderCircle, RefreshCw } from 'lucide-react'
import { authenticatedFetch, setCsrf } from './auth-client'
import type { SignedInUser } from './auth-client'
import App from './App'

type Session = { enabled: boolean; entra?: boolean; user: SignedInUser | null; csrf?: string | null }
export default function AuthGate() {
  const [session, setSession] = useState<Session | null>(null)
  const [error, setError] = useState(location.search.includes('login=failed') ? '登录未完成，请重试或联系管理员确认访问权限。' : '')
  const [busy, setBusy] = useState(false)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const revision = useRef(0)
  function applySession(value: Session) {
    const identity = value.user?.id ?? ''
    if (value.enabled && sessionStorage.getItem('studio-identity') !== identity) {
      localStorage.removeItem('qwen-project')
      sessionStorage.setItem('studio-identity', identity)
    }
    setCsrf(value.csrf ?? null)
    setSession(value)
  }
  async function refresh() {
    const current = ++revision.current
    try {
      const response = await fetch('/api/auth/session', { cache: 'no-store' })
      if (!response.ok) throw new Error('Session unavailable')
      const value = await response.json()
      if (current === revision.current) applySession(value)
    } catch { if (current === revision.current) { setError('无法连接登录服务，请重试。'); setCsrf(null); setSession(null) } }
  }
  useEffect(() => {
    void Promise.resolve().then(refresh)
    const expired = () => { revision.current++; setCsrf(null); setSession(previous => previous ? { ...previous, user: null } : null); setError('会话已结束，请重新登录。') }
    const changed = (event: StorageEvent) => { if (event.key === 'studio-auth-change') { expired(); void refresh() } }
    const visible = () => { if (document.visibilityState === 'visible') void refresh() }
    window.addEventListener('studio-session-expired', expired)
    window.addEventListener('storage', changed)
    document.addEventListener('visibilitychange', visible)
    const timer = setInterval(() => { void refresh() }, 60000)
    return () => { clearInterval(timer); window.removeEventListener('studio-session-expired', expired); window.removeEventListener('storage', changed); document.removeEventListener('visibilitychange', visible) }
  }, [])
  async function login(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('')
    try {
      const response = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) })
      if (!response.ok) throw new Error(response.status === 429 ? '登录尝试过多，请稍后再试。' : '账号或密码不正确。')
      setPassword('')
      await refresh()
      localStorage.setItem('studio-auth-change', crypto.randomUUID())
    } catch (failure) { setPassword(''); setError(failure instanceof Error ? failure.message : '登录失败') }
    finally { setBusy(false) }
  }
  async function logout() {
    const response = await authenticatedFetch('/api/auth/logout', { method: 'POST' })
    if (!response.ok) throw new Error('退出失败，请重试')
    revision.current++
    applySession({ ...session!, user: null, csrf: null })
    localStorage.removeItem('qwen-project')
    localStorage.setItem('studio-auth-change', crypto.randomUUID())
  }
  if (session && (!session.enabled || session.user)) return <App key={session.user?.id ?? 'local'} user={session.user} onLogout={session.enabled ? logout : undefined} />
  return <main className="login-page"><header className="login-header"><img src="/reference-interior.jpg" alt="" /><div><Aperture size={24} /><h1>Qwen Studio</h1></div></header><section className="login-content"><h2>登录</h2>{!session ? <div className="login-loading">{error ? <><p role="alert">{error}</p><button onClick={() => void refresh()}><RefreshCw size={18} />重试</button></> : <LoaderCircle className="spin" aria-label="正在检查登录" />}</div> : <>{session.entra && <><a className="entra-login" href="/api/auth/entra"><LogIn size={19} />使用 Microsoft Entra ID 登录</a><div className="login-divider">或</div></>}<form onSubmit={event => void login(event)}><label htmlFor="login-username">账号</label><input id="login-username" name="username" autoComplete="username" autoCapitalize="none" spellCheck={false} required maxLength={64} value={username} onChange={event => setUsername(event.target.value)} /><label htmlFor="login-password">密码</label><input id="login-password" name="password" type="password" autoComplete="current-password" required maxLength={256} value={password} onChange={event => setPassword(event.target.value)} /><button className="primary" disabled={busy} type="submit">{busy ? <LoaderCircle size={18} className="spin" /> : <LogIn size={18} />}登录</button>{error && <p role="alert" className="form-error">{error}</p>}</form></>}</section></main>
}