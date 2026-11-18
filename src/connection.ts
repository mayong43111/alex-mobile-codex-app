import { ActionType, MessageAttachmentKind, MessageKind, PROTOCOL_VERSION, chatReducer } from '@microsoft/agent-host-protocol'
import type { ChatAction, ChatState, ClientChatAction, StateAction } from '@microsoft/agent-host-protocol'
import { AhpClient } from '@microsoft/agent-host-protocol/client'
import { WebSocketTransport } from '@microsoft/agent-host-protocol/ws'
import type { AttachmentInfo } from './shared'

function isChatAction(action: StateAction): action is ChatAction { return action.type.startsWith('chat/') }

export class ChatConnection {
  private client?: AhpClient
  private stopped = false
  private controller = new AbortController()
  private pending?: { turnId: string; resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
  constructor(
    private channel: string,
    private onState: (state: ChatState) => void,
    private onStatus: (status: 'connecting' | 'connected' | 'offline') => void,
    private onError: (message: string) => void,
    private onExpired: () => void,
  ) {}
  async run() {
    let delay = 500
    while (!this.stopped) {
      let client: AhpClient | undefined
      let heartbeat: ReturnType<typeof setInterval> | undefined
      try {
        this.onStatus('connecting')
        const url = new URL('/api/ahp', window.location.href)
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
        const socket = new WebSocket(url)
        const cancelSocket = () => socket.close()
        this.controller.signal.addEventListener('abort', cancelSocket, { once: true })
        socket.addEventListener('close', () => this.controller.signal.removeEventListener('abort', cancelSocket), { once: true })
        await new Promise<void>((resolve, reject) => {
          socket.addEventListener('open', () => resolve(), { once: true })
          socket.addEventListener('error', () => reject(new Error('无法连接对话服务')), { once: true })
          socket.addEventListener('close', () => reject(new Error('对话连接已关闭')), { once: true })
        })
        if (this.stopped) { socket.close(); return }
        socket.addEventListener('message', event => {
          try {
            const message: unknown = JSON.parse(String(event.data))
            if (message && typeof message === 'object' && 'method' in message && message.method === 'x-studio/error' && 'params' in message) {
              const params = message.params
              if (params && typeof params === 'object' && 'message' in params && typeof params.message === 'string') {
                this.rejectPending(params.message)
                this.onError(params.message)
              }
            }
          } catch { this.onError('服务返回了无法识别的消息，请重新连接') }
        })
        const transport = WebSocketTransport.fromSocket(socket)
        client = new AhpClient(transport)
        const subscription = client.attachSubscription(this.channel)
        client.connect()
        const initialized = await client.initialize({
          clientId: crypto.randomUUID(), protocolVersions: [PROTOCOL_VERSION],
          initialSubscriptions: [this.channel],
        })
        const snapshot = initialized.snapshots.find(item => item.resource === this.channel)
        if (!snapshot || !('turns' in snapshot.state)) throw new Error('未收到有效的对话状态')
        let state = snapshot.state as ChatState
        let sequence = snapshot.fromSeq
        this.onState(state)
        this.client = client
        this.onStatus('connected')
        delay = 500
        const currentClient = client
        heartbeat = setInterval(() => { void currentClient.ping().catch(() => currentClient.shutdown()) }, 20_000)
        for await (const event of subscription) {
          if (this.stopped) break
          if (event.type !== 'action' || event.params.serverSeq <= sequence) continue
          sequence = event.params.serverSeq
          if (!isChatAction(event.params.action)) continue
          state = chatReducer(state, event.params.action)
          this.onState(state)
          if (event.params.action.type === ActionType.ChatTurnStarted && this.pending?.turnId === event.params.action.turnId) {
            clearTimeout(this.pending.timer)
            this.pending.resolve()
            this.pending = undefined
          }
        }
        if (transport.lastClose?.code === 4001) { this.onExpired(); return }
      } catch (error) {
        if (!this.stopped) this.onError(error instanceof Error ? error.message : '对话连接失败')
      } finally {
        this.client = undefined
        if (heartbeat) clearInterval(heartbeat)
        if (client) await client.shutdown()
        this.rejectPending('连接已中断，消息接收状态不确定。重连后请先核对会话，未自动重发。')
      }
      if (this.stopped) return
      this.onStatus('offline')
      await new Promise<void>(resolve => {
        const done = () => { clearTimeout(timer); this.controller.signal.removeEventListener('abort', done); resolve() }
        const timer = setTimeout(done, delay)
        this.controller.signal.addEventListener('abort', done, { once: true })
      })
      delay = Math.min(delay * 2, 10_000)
    }
  }
  async send(text: string, attachments: AttachmentInfo[] = []) {
    if (!this.client) throw new Error('尚未连接，请稍后再发送')
    if (this.pending) throw new Error('上一条消息仍在确认中')
    const turnId = crypto.randomUUID()
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => this.rejectPending('消息接收尚未确认，请先核对会话，避免重复提交。'), 20_000)
      this.pending = { turnId, resolve, reject, timer }
      try {
        this.client!.dispatch(this.channel, {
          type: ActionType.ChatTurnStarted, turnId, startedAt: new Date().toISOString(),
          message: { text, origin: { kind: MessageKind.User }, ...(attachments.length ? {
            attachments: attachments.map(image => ({
              type: MessageAttachmentKind.Resource, uri: `studio-attachment:/${image.id}`, label: image.name, displayKind: 'image',
            })),
          } : {}) },
        })
      } catch (error) { this.rejectPending(error instanceof Error ? error.message : '发送失败') }
    })
  }
  dispatch(action: ClientChatAction) {
    if (!this.client) throw new Error('对话未连接')
    this.client.dispatch(this.channel, action)
  }
  private rejectPending(message: string) {
    if (!this.pending) return
    clearTimeout(this.pending.timer)
    this.pending.reject(new Error(message))
    this.pending = undefined
  }
  close() {
    this.stopped = true
    this.controller.abort()
    this.rejectPending('会话已切换，请先核对消息是否已发送')
    if (this.client) void this.client.shutdown().catch(() => this.onError('关闭连接失败'))
  }
}
