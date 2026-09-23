import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { ManagedIdentityCredential } from '@azure/identity'
import { z } from 'zod'
import { HttpError } from './store.ts'

const configSchema = z.object({
  subscription: z.string().uuid(), resourceGroup: z.string().regex(/^[\w.-]{1,90}$/), name: z.string().regex(/^[\w.-]{1,64}$/),
  comfyUrl: z.url(), cliPath: z.string().min(1).optional(), auth: z.enum(['cli', 'managed-identity']).default('cli'),
}).strict()
const operationSchema = z.object({ id: z.string().uuid(), action: z.enum(['start', 'deallocate', 'restart']), status: z.enum(['pending', 'succeeded', 'failed', 'unknown']), createdAt: z.string(), url: z.string().optional(), error: z.string().optional() })
type Operation = z.infer<typeof operationSchema>
export type VmAction = Operation['action']
export type VmStatus = { configured: boolean; name?: string; powerState?: string; gpuReady?: boolean; operation?: Omit<Operation, 'url'> }
export interface VmControl {
  readonly busy: boolean
  status(): Promise<VmStatus>
  act(action: VmAction, id: string, confirmedName: string, force: boolean): Promise<VmStatus>
}
type ArmRequest = (url: string, method?: string) => Promise<Response>

export class VmController implements VmControl {
  private operation?: Operation
  private requests: Record<string, VmAction> = {}
  private polling: Promise<VmStatus> | null = null
  private writing: Promise<void> = Promise.resolve()
  private lock = false
  private base: string
  private config: z.infer<typeof configSchema>
  private stateFile: string
  private request: ArmRequest
  private gpuFetch: typeof fetch

  constructor(config: z.infer<typeof configSchema>, stateFile: string, request: ArmRequest, gpuFetch: typeof fetch = fetch) {
    this.config = configSchema.parse(config)
    this.stateFile = stateFile
    this.request = request
    this.gpuFetch = gpuFetch
    this.base = `https://management.azure.com/subscriptions/${config.subscription}/resourceGroups/${config.resourceGroup}/providers/Microsoft.Compute/virtualMachines/${config.name}`
  }

  async initialize() {
    try {
      const state = z.object({ operation: operationSchema, requests: z.record(z.string().uuid(), z.enum(['start', 'deallocate', 'restart'])) }).parse(JSON.parse(await readFile(this.stateFile, 'utf8')))
      this.operation = state.operation
      this.requests = state.requests
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Invalid VM operation state') }
  }

  get busy() { return this.lock || !!this.operation && ['pending', 'unknown'].includes(this.operation.status) }

  private async save() {
    if (this.operation) this.requests[this.operation.id] = this.operation.action
    const state = JSON.stringify({ operation: this.operation, requests: this.requests })
    this.writing = this.writing.catch(() => {}).then(async () => {
      await mkdir(dirname(this.stateFile), { recursive: true })
      const temporary = `${this.stateFile}.${randomUUID()}.tmp`
      await writeFile(temporary, state, { mode: 0o600, flag: 'wx' })
      await rename(temporary, this.stateFile)
    })
    await this.writing
  }

  private async instanceView() {
    const response = await this.request(`${this.base}/instanceView?api-version=2024-07-01`)
    if (!response.ok) throw new HttpError(503, '无法读取 VM 状态，请检查 Azure 权限或连接。')
    const data = await response.json() as { statuses?: { code?: string; time?: string; message?: string }[] }
    return { powerState: data.statuses?.find(entry => entry.code?.startsWith('PowerState/'))?.code?.slice(11) ?? 'unknown', provisioning: data.statuses?.find(entry => entry.code?.startsWith('ProvisioningState/')) }
  }

  async status(): Promise<VmStatus> {
    if (!this.polling) this.polling = this.inspect().finally(() => { this.polling = null })
    return this.polling
  }

  private async inspect(): Promise<VmStatus> {
    if (!this.lock && this.operation && ['pending', 'unknown'].includes(this.operation.status) && this.operation.url) {
      const current = this.operation
      const response = await this.request(current.url!)
      if (response.ok) {
        const data = await response.json() as { status?: string; error?: { code?: string; message?: string } }
        if (this.operation === current && ['Succeeded', 'Failed', 'Canceled'].includes(data.status ?? '')) {
          current.status = data.status === 'Succeeded' ? 'succeeded' : 'failed'
          current.error = current.status === 'failed' ? [data.error?.code, data.error?.message].filter(Boolean).join(': ').slice(0, 600) || 'Azure 操作失败或已取消。' : undefined
          await this.save()
        }
      }
    }
    const { powerState, provisioning } = await this.instanceView()
    if (!this.lock && this.operation && ['pending', 'unknown'].includes(this.operation.status)) {
      if (!this.operation.url && ((this.operation.action === 'start' && powerState === 'running') || (this.operation.action === 'deallocate' && powerState === 'deallocated'))) {
        this.operation.status = 'succeeded'
        this.operation.error = undefined
        await this.save()
      } else if (provisioning?.code === 'ProvisioningState/failed' && Date.parse(provisioning.time ?? '') >= Date.parse(this.operation.createdAt)) {
        this.operation.status = 'failed'
        this.operation.error = provisioning.message?.slice(0, 600) || 'Azure 已确认此次 VM 操作失败。'
        await this.save()
      }
    }
    let gpuReady = false
    if (powerState === 'running') {
      try { gpuReady = (await this.gpuFetch(`${this.config.comfyUrl.replace(/\/$/, '')}/system_stats`, { signal: AbortSignal.timeout(3000) })).ok } catch { gpuReady = false }
    }
    const operation = this.operation ? { id: this.operation.id, action: this.operation.action, status: this.operation.status, createdAt: this.operation.createdAt, error: this.operation.error } : undefined
    return { configured: true, name: this.config.name, powerState, gpuReady, operation }
  }

  async act(action: VmAction, id: string, confirmedName: string, force: boolean): Promise<VmStatus> {
    z.enum(['start', 'deallocate', 'restart']).parse(action)
    z.string().uuid().parse(id)
    if (confirmedName !== this.config.name) throw new HttpError(400, 'VM 确认名称不匹配。')
    if (this.requests[id]) {
      if (this.requests[id] !== action) throw new HttpError(409, '操作 ID 已用于其他动作。')
      return this.status()
    }
    if (this.busy) throw new HttpError(409, 'VM 操作尚未结束或结果待核实，禁止重复提交。')
    this.lock = true
    try {
      const { powerState: power } = await this.instanceView()
      if (action === 'start' ? !['deallocated', 'stopped'].includes(power) : power !== 'running') throw new HttpError(409, '当前 VM 状态不允许此操作，请刷新。')
      if (action !== 'start') {
        let queue: { queue_running?: unknown[]; queue_pending?: unknown[] } | undefined
        try {
          const response = await this.gpuFetch(`${this.config.comfyUrl.replace(/\/$/, '')}/queue`, { signal: AbortSignal.timeout(5000) })
          if (response.ok) queue = await response.json()
        } catch { queue = undefined }
        if (queue?.queue_running?.length || queue?.queue_pending?.length) throw new HttpError(409, 'GPU 有运行或排队任务，不能关闭或重启。')
        if ((!Array.isArray(queue?.queue_running) || !Array.isArray(queue?.queue_pending)) && !force) throw new HttpError(409, '无法确认 GPU 队列；请先核实，或明确确认中断风险。')
      }
      this.operation = { id, action, status: 'pending', createdAt: new Date().toISOString() }
      await this.save()
      try {
        const response = await this.request(`${this.base}/${action}?api-version=2024-07-01`, 'POST')
        if (!response.ok) {
          const detail = await response.json().catch(() => null) as { error?: { code?: string; message?: string } } | null
          const rejected = ['AllocationFailed', 'ZonalAllocationFailed', 'OverconstrainedAllocationRequest', 'OverconstrainedZonalAllocationRequest', 'SkuNotAvailable', 'OperationNotAllowed', 'QuotaExceeded'].includes(detail?.error?.code ?? '')
          this.operation.status = response.status >= 500 && !rejected ? 'unknown' : 'failed'
          this.operation.error = [detail?.error?.code, detail?.error?.message].filter(Boolean).join(': ').slice(0, 600) || 'Azure 未确认操作成功。'
          await this.save()
          throw new HttpError(503, `${this.operation.error} ${this.operation.status === 'failed' ? '本次操作失败，可重新确认后重试。' : '结果待核实，未自动重试。'}`)
        }
        const operationUrl = response.headers.get('azure-asyncoperation')
        if (operationUrl) {
          const url = new URL(operationUrl)
          if (url.origin !== 'https://management.azure.com' || url.username || url.password) throw new Error('Invalid operation URL')
          this.operation.url = url.href
        } else if (response.status !== 202) this.operation.status = 'succeeded'
        else if (action === 'restart') this.operation.status = 'unknown'
        await this.save()
      } catch (error) {
        if (this.operation.status === 'pending') { this.operation.status = 'unknown'; await this.save() }
        if (error instanceof HttpError) throw error
        throw new HttpError(503, 'VM 操作结果待核实，未自动重试。')
      }
    } finally { this.lock = false }
    return this.status()
  }
}

export async function loadVmController(file: string, stateFile: string): Promise<VmController | undefined> {
  let config: z.infer<typeof configSchema>
  try { config = configSchema.parse(JSON.parse(await readFile(file, 'utf8'))) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new Error('Invalid VM configuration')
  }
  let cached: { token: string; expires: number } | undefined
  const credential = config.auth === 'managed-identity' ? new ManagedIdentityCredential() : undefined
  const controller = new VmController(config, stateFile, async (url, method = 'GET') => {
    if (!cached || cached.expires < Date.now() + 60000) {
      if (credential) {
        const token = await credential.getToken('https://management.azure.com/.default')
        cached = { token: token.token, expires: token.expiresOnTimestamp }
      } else {
        const { stdout } = await promisify(execFile)(config.cliPath ?? 'az', ['account', 'get-access-token', '--subscription', config.subscription, '--resource', 'https://management.azure.com/', '-o', 'json'], { timeout: 30000, maxBuffer: 256 * 1024 })
        const data = z.object({ accessToken: z.string().min(1), expires_on: z.coerce.number() }).parse(JSON.parse(stdout))
        cached = { token: data.accessToken, expires: data.expires_on * 1000 }
      }
    }
    return fetch(url, { method, headers: { Authorization: `Bearer ${cached.token}` }, signal: AbortSignal.timeout(20000), redirect: 'error' })
  })
  await controller.initialize()
  return controller
}