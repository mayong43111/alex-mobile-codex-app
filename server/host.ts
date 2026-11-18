import {
  ActionType, MessageKind, PROTOCOL_VERSION, ResponsePartKind,
  ToolCallCancellationReason, ToolCallConfirmationReason,
} from '@microsoft/agent-host-protocol'
import type { ActionEnvelope, ChatAction, InitializeResult } from '@microsoft/agent-host-protocol'
import type { WebSocket } from 'ws'
import { z } from 'zod'
import type { Agent, AgentOutput } from './agent.js'
import { AppError } from './errors.js'
import { Store, hash } from './store.js'
import type { Login } from './store.js'

const startSchema = z.object({
  type: z.literal('chat/turnStarted'), turnId: z.uuid(), startedAt: z.iso.datetime(),
  message: z.object({ text: z.string().trim().min(1).max(12000), origin: z.object({ kind: z.literal('user') }).strict() }).strict(),
}).strict()
const cancelSchema = z.object({
  type: z.literal('chat/turnCancelled'), turnId: z.uuid(), duration: z.number().nonnegative(),
}).strict()
const approvalSchema = z.object({
  type: z.literal('chat/toolCallConfirmed'), turnId: z.uuid(), toolCallId: z.string().min(1).max(200),
  approved: z.boolean(), confirmed: z.literal('user-action').optional(), reason: z.literal('denied').optional(),
}).strict()
const dispatchSchema = z.object({
  channel: z.string().max(200), clientSeq: z.number().int().positive(),
  action: z.union([startSchema, cancelSchema, approvalSchema]),
}).strict()
const rpcSchema = z.object({
  jsonrpc: z.literal('2.0'), id: z.union([z.number(), z.string()]).optional(),
  method: z.string().max(100), params: z.record(z.string(), z.unknown()).default({}),
}).strict()
interface Peer {
  socket: WebSocket; login: Login; clientId?: string; subscriptions: Set<string>
}
interface Running {
  turnId: string; userId: string; controller: AbortController; work: Promise<void>
  approvals: Map<string, (approved: boolean) => void>
}
class ProtocolError extends AppError {
  constructor(public code: number, message: string, public data?: unknown) { super(400, message) }
}

export class AgentHost {
  private peers = new Set<Peer>()
  private running = new Map<string, Running>()
  constructor(private store: Store, private agent: Agent, private report: (message: string) => void) {
    store.interruptActiveTurns()
  }
  attach(socket: WebSocket, login: Login) {
    const peer: Peer = { socket, login, subscriptions: new Set() }
    this.peers.add(peer)
    const expiry = setTimeout(() => socket.close(4001, 'Login expired'), Math.max(1, login.expiresAt - Date.now()))
    socket.on('message', data => this.receive(peer, data.toString()))
    socket.on('error', () => this.report('AHP socket error'))
    socket.on('close', () => { clearTimeout(expiry); this.peers.delete(peer) })
  }
  revoke(tokenHash: string) {
    for (const peer of this.peers) if (peer.login.tokenHash === tokenHash) peer.socket.close(4001, 'Logged out')
  }
  private send(peer: Peer, message: unknown) {
    if (peer.socket.readyState !== 1) return
    if (peer.socket.bufferedAmount > 2 * 1024 * 1024) { peer.socket.close(1013, 'Reconnect for latest snapshot'); return }
    peer.socket.send(JSON.stringify(message))
  }
  private notification(peer: Peer, method: string, params: unknown) {
    this.send(peer, { jsonrpc: '2.0', method, params })
  }
  private publish(userId: string, id: string, envelope: ActionEnvelope) {
    const conversation = this.store.conversation(userId, id)
    const summary = this.store.sessionSummary(conversation)
    const sessionUpdate = this.store.sessionUpdate(userId, id)
    for (const peer of this.peers) {
      if (peer.login.userId !== userId) continue
      if (peer.subscriptions.has(envelope.channel)) this.notification(peer, 'action', envelope)
      if (peer.subscriptions.has(summary.resource)) this.notification(peer, 'action', sessionUpdate)
      if (peer.subscriptions.has('ahp-root://')) this.notification(peer, 'root/sessionSummaryChanged', {
        channel: 'ahp-root://', session: summary.resource,
        changes: { title: summary.title, status: summary.status, modifiedAt: summary.modifiedAt },
      })
    }
  }
  private apply(userId: string, id: string, action: ChatAction, command?: { clientId: string; clientSeq: number; fingerprint: string }) {
    const envelope = this.store.apply(userId, id, action, command)
    this.publish(userId, id, envelope)
    return envelope
  }
  private receive(peer: Peer, text: string) {
    let id: string | number | undefined
    let clientSeq: unknown
    try {
      const request = rpcSchema.parse(JSON.parse(text))
      id = request.id
      clientSeq = request.params.clientSeq
      const result = this.handle(peer, request.method, request.params)
      if (id !== undefined) this.send(peer, { jsonrpc: '2.0', id, result })
    } catch (error) {
      const status = error instanceof AppError ? error.status : error instanceof z.ZodError || error instanceof SyntaxError ? 400 : 500
      const message = error instanceof AppError ? error.message : status === 400 ? '无效的 AHP 请求' : '服务内部错误，请刷新状态后重试；未自动重发。'
      if (status === 500) this.report('AHP request failed')
      if (error instanceof SyntaxError) this.send(peer, { jsonrpc: '2.0', id: null, error: { code: -32700, message } })
      else if (id !== undefined) this.send(peer, { jsonrpc: '2.0', id, error: { code: error instanceof ProtocolError ? error.code : status === 404 ? -32001 : status === 400 ? -32602 : -32000, message, ...(error instanceof ProtocolError && error.data ? { data: error.data } : {}) } })
      else this.notification(peer, 'x-studio/error', { channel: 'ahp-root://', clientSeq, message })
    }
  }
  private handle(peer: Peer, method: string, params: Record<string, unknown>): unknown {
    const userId = peer.login.userId
    if (method === 'ping') return {}
    if (method === 'initialize') {
      if (peer.clientId) throw new AppError(409, '连接已初始化')
      const input = z.object({
        clientId: z.string().min(1).max(100), protocolVersions: z.array(z.string()).max(20),
        initialSubscriptions: z.array(z.string()).max(50).default([]),
      }).parse(params)
      if (!input.protocolVersions.includes(PROTOCOL_VERSION)) {
        throw new ProtocolError(-32005, `不支持此协议版本，需要 ${PROTOCOL_VERSION}`, { supportedVersions: [PROTOCOL_VERSION] })
      }
      const snapshots = input.initialSubscriptions.map(channel => this.store.snapshot(userId, channel))
      peer.clientId = input.clientId
      input.initialSubscriptions.forEach(channel => peer.subscriptions.add(channel))
      return { protocolVersion: PROTOCOL_VERSION, serverSeq: this.store.sequence, snapshots, serverInfo: { name: 'mobile-studio', version: '0.1.0' } } satisfies InitializeResult
    }
    if (method === 'reconnect') {
      const input = z.object({
        clientId: z.string().min(1).max(100),
        lastSeenServerSeq: z.number().int().nonnegative(),
        subscriptions: z.array(z.string()).max(50),
      }).parse(params)
      if (peer.clientId && peer.clientId !== input.clientId) throw new AppError(409, '重连客户端标识不一致')
      const snapshots = input.subscriptions.map(channel => this.store.snapshot(userId, channel))
      peer.clientId = input.clientId
      peer.subscriptions = new Set(input.subscriptions)
      return { type: 'snapshot', snapshots }
    }
    if (!peer.clientId) throw new AppError(400, '请先初始化 AHP 连接')
    if (method === 'subscribe') {
      if (peer.subscriptions.size >= 50) throw new AppError(429, '订阅数量达到上限')
      const channel = z.string().parse(params.channel)
      const snapshot = this.store.snapshot(userId, channel)
      peer.subscriptions.add(channel)
      return { snapshot }
    }
    if (method === 'unsubscribe') { peer.subscriptions.delete(z.string().parse(params.channel)); return {} }
    if (method === 'listSessions') return { items: this.store.conversations(userId).map(conversation => this.store.sessionSummary(conversation)) }
    if (method === 'dispatchAction') { this.dispatch(peer, params); return {} }
    throw new ProtocolError(-32601, `当前 Host 不支持方法 ${method}`)
  }
  private dispatch(peer: Peer, params: Record<string, unknown>) {
    const input = dispatchSchema.parse(params)
    const match = /^ahp-chat:\/([0-9a-f-]{36})$/.exec(input.channel)
    if (!match) throw new AppError(404, '聊天通道不存在')
    const id = match[1]
    const userId = peer.login.userId
    const conversation = this.store.conversation(userId, id)
    const command = { clientId: peer.clientId!, clientSeq: input.clientSeq, fingerprint: hash(JSON.stringify(input)) }
    const accepted = this.store.accepted(userId, command.clientId, command.clientSeq, command.fingerprint)
    if (accepted) {
      this.notification(peer, 'action', accepted)
      return
    }
    if (input.action.type === 'chat/turnStarted') {
      this.agent.assertConfigured()
      if (conversation.state.activeTurn || this.running.has(id)) throw new AppError(409, '当前会话仍在处理，请等待或停止')
      if (conversation.state.turns.some(turn => turn.id === input.action.turnId)) throw new AppError(409, '这条消息已经处理，未重复提交')
      if (this.running.size >= 8 || [...this.running.values()].filter(run => run.userId === userId).length >= 2) throw new AppError(429, '运行中的会话过多，请稍后重试')
      const action: ChatAction = { type: ActionType.ChatTurnStarted, turnId: input.action.turnId, startedAt: new Date().toISOString(), message: { text: input.action.message.text, origin: { kind: MessageKind.User } } }
      this.apply(userId, id, action, command)
      const running: Running = { turnId: action.turnId, userId, controller: new AbortController(), approvals: new Map(), work: Promise.resolve() }
      this.running.set(id, running)
      running.work = this.execute(id, running, input.action.message.text)
      return
    }
    const running = this.running.get(id)
    if (!running || running.turnId !== input.action.turnId) throw new AppError(409, '该任务已结束或不存在')
    if (input.action.type === 'chat/turnCancelled') {
      this.apply(userId, id, { type: ActionType.ChatActivityChanged, activity: '正在请求停止；外部任务可能仍会计费。' }, command)
      running.controller.abort()
      for (const approve of running.approvals.values()) approve(false)
      return
    }
    const approve = running.approvals.get(input.action.toolCallId)
    if (!approve) throw new AppError(409, '该工具确认已失效')
    const action: ChatAction = input.action.approved
      ? { type: ActionType.ChatToolCallConfirmed, turnId: running.turnId, toolCallId: input.action.toolCallId, approved: true, confirmed: ToolCallConfirmationReason.UserAction }
      : { type: ActionType.ChatToolCallConfirmed, turnId: running.turnId, toolCallId: input.action.toolCallId, approved: false, reason: ToolCallCancellationReason.Denied }
    this.apply(userId, id, action, command)
    approve(input.action.approved)
  }
  private async execute(id: string, run: Running, prompt: string) {
    const started = Date.now()
    const textParts = new Set<string>()
    const tools = new Set<string>()
    const emit = (event: AgentOutput) => {
      if (event.type === 'text') {
        if (!textParts.has(event.id)) {
          textParts.add(event.id)
          this.apply(run.userId, id, { type: ActionType.ChatResponsePart, turnId: run.turnId, part: { kind: ResponsePartKind.Markdown, id: event.id, content: '' } })
        }
        this.apply(run.userId, id, { type: ActionType.ChatDelta, turnId: run.turnId, partId: event.id, content: event.delta })
      } else if (event.type === 'tool-start') {
        if (tools.has(event.id)) return
        tools.add(event.id)
        this.apply(run.userId, id, { type: ActionType.ChatToolCallStart, turnId: run.turnId, toolCallId: event.id, toolName: event.name, displayName: event.name })
        this.apply(run.userId, id, { type: ActionType.ChatToolCallReady, turnId: run.turnId, toolCallId: event.id, invocationMessage: '执行工具', confirmed: ToolCallConfirmationReason.NotNeeded })
      } else if (event.type === 'tool-complete' && tools.has(event.id)) {
        this.apply(run.userId, id, { type: ActionType.ChatToolCallComplete, turnId: run.turnId, toolCallId: event.id, result: { success: event.success, pastTenseMessage: event.success ? '工具已返回结果' : '工具执行失败' } })
      }
    }
    try {
      await this.agent.run({
        conversation: this.store.conversation(run.userId, id), skills: this.store.skills(run.userId),
        prompt, signal: run.controller.signal, emit,
        saveRuntimeId: runtimeId => {
          const current = this.store.conversation(run.userId, id)
          current.runtimeId = runtimeId
          this.store.save(current)
        },
        approve: (toolId, name, input) => new Promise<boolean>(resolve => {
          if (run.controller.signal.aborted) { resolve(false); return }
          tools.add(toolId)
          this.apply(run.userId, id, { type: ActionType.ChatToolCallStart, turnId: run.turnId, toolCallId: toolId, toolName: name, displayName: name })
          this.apply(run.userId, id, { type: ActionType.ChatToolCallReady, turnId: run.turnId, toolCallId: toolId, invocationMessage: `确认执行 ${name}？这可能产生费用。\n${input.slice(0, 8000)}` })
          const finish = (approved: boolean) => {
            clearTimeout(timer)
            run.approvals.delete(toolId)
            resolve(approved)
          }
          const timer = setTimeout(() => {
            this.apply(run.userId, id, { type: ActionType.ChatToolCallConfirmed, turnId: run.turnId, toolCallId: toolId, approved: false, reason: ToolCallCancellationReason.Skipped })
            finish(false)
          }, 120_000)
          run.approvals.set(toolId, finish)
        }),
      })
      this.apply(run.userId, id, { type: run.controller.signal.aborted ? ActionType.ChatTurnCancelled : ActionType.ChatTurnComplete, turnId: run.turnId, duration: Date.now() - started })
    } catch {
      this.report('Copilot turn failed; inspect model/tool configuration without exposing credentials')
      this.apply(run.userId, id, {
        type: ActionType.ChatError, turnId: run.turnId, duration: Date.now() - started,
        part: { kind: ResponsePartKind.Error, error: {
          errorType: run.controller.signal.aborted ? 'stopped' : 'agent_failure',
          message: run.controller.signal.aborted
            ? '已请求停止。外部工具的执行或计费结果可能不确定，请先核对，不要直接重复提交。'
            : '对话执行失败，请检查 Azure 身份、模型部署或工具配置。可能已有外部费用，未自动重试。',
        } },
      })
    } finally {
      for (const approve of [...run.approvals.values()]) approve(false)
      this.running.delete(id)
    }
  }
  async close() {
    for (const peer of this.peers) peer.socket.close(1001, 'Server shutting down')
    for (const run of this.running.values()) {
      run.controller.abort()
      for (const approve of [...run.approvals.values()]) approve(false)
    }
    await Promise.all([...this.running.values()].map(run => run.work))
    await this.agent.close()
  }
}
