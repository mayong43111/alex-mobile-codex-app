import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash, randomUUID } from 'node:crypto'
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
    if (response.status === 404) throw new HttpError(503, `VM ${this.config.name} 不存在，请检查订阅、资源组和实例名称。`)
    if (response.status === 403) throw new HttpError(503, `没有读取 VM ${this.config.name} 的 Azure 权限。`)
    if (!response.ok) throw new HttpError(503, `无法读取 VM ${this.config.name} 状态，请检查 Azure 连接。`)
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
      try { gpuReady = (await this.gpuFetch(`${this.config.comfyUrl.replace(/\/$/, '')}/system_stats`, { signal: AbortSignal.timeout(3000), redirect: 'error' })).ok } catch { gpuReady = false }
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
          const response = await this.gpuFetch(`${this.config.comfyUrl.replace(/\/$/, '')}/queue`, { signal: AbortSignal.timeout(5000), redirect: 'error' })
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
  return createVmController(config, stateFile)
}

async function createVmController(config: z.infer<typeof configSchema>, stateFile: string): Promise<VmController> {
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

export const vmProfileInputSchema = configSchema.pick({ subscription: true, resourceGroup: true, name: true, comfyUrl: true }).extend({
  label: z.string().trim().min(1).max(80),
  comfyUrl: z.url().refine(value => {
    let url: URL
    try { url = new URL(value) } catch { return false }
    const parts = url.hostname.split('.').map(Number)
    const privateAddress = parts.length === 4 && parts.every(part => Number.isInteger(part) && part >= 0 && part <= 255) && (parts[0] === 10 || parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31 || parts[0] === 192 && parts[1] === 168)
    return ['http:', 'https:'].includes(url.protocol) && privateAddress && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/'
  }, 'ComfyUI 地址必须是私网 IPv4 HTTP(S) 地址，不含路径、凭据或查询参数。'),
}).strict()
export type VmProfileInput = z.infer<typeof vmProfileInputSchema>
export type VmProfile = VmProfileInput & { id: string }
const savedProfileSchema = configSchema.extend({ id: z.string().uuid(), label: z.string().trim().min(1).max(80) }).strict()
const catalogSchema = z.object({ version: z.literal(1), revision: z.string().uuid(), profiles: z.array(savedProfileSchema).max(20) }).strict()
type Catalog = z.infer<typeof catalogSchema>
type ControllerFactory = (config: z.infer<typeof configSchema>, stateFile: string) => Promise<VmControl>
export type VmProfiles = { revision: string; profiles: VmProfile[]; canManage: boolean }

export class VmRegistry implements VmControl {
  private catalog: Catalog = { version: 1, revision: randomUUID(), profiles: [] }
  private controllers = new Map<string, VmControl>()
  private mutating = false
  private file: string
  private stateFile: string
  private auth: 'cli' | 'managed-identity'
  private factory: ControllerFactory

  constructor(file: string, stateFile: string, auth: 'cli' | 'managed-identity', factory: ControllerFactory = createVmController) {
    this.file = file
    this.stateFile = stateFile
    this.auth = auth
    this.factory = factory
  }

  private identity(profile: Pick<VmProfileInput, 'subscription' | 'resourceGroup' | 'name'>) {
    return `${profile.subscription}/${profile.resourceGroup}/${profile.name}`.toLowerCase()
  }

  private operationFile(profile: z.infer<typeof configSchema>) {
    return `${this.stateFile}.${createHash('sha256').update(this.identity(profile)).digest('hex')}.json`
  }

  async initialize() {
    let source: unknown
    try { source = JSON.parse(await readFile(this.file, 'utf8')) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw new Error('Invalid VM configuration') }
    const legacy = configSchema.safeParse(source)
    if (legacy.success) {
      const profile = { ...legacy.data, id: randomUUID(), label: legacy.data.name }
      this.catalog.profiles = [profile]
      try {
        const state = await readFile(this.stateFile, 'utf8')
        await writeFile(this.operationFile(profile), state, { mode: 0o600, flag: 'wx' })
      } catch (error) { if (!['ENOENT', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error }
    } else this.catalog = catalogSchema.parse(source)
    const identities = this.catalog.profiles.map(profile => this.identity(profile))
    if (new Set(identities).size !== identities.length || new Set(this.catalog.profiles.map(profile => profile.id)).size !== identities.length) throw new Error('Duplicate VM configuration')
    for (const profile of this.catalog.profiles) this.controllers.set(profile.id, await this.factory(configSchema.strip().parse(profile), this.operationFile(profile)))
    if (legacy.success) await this.persist(this.catalog)
  }

  get busy() { return this.mutating || [...this.controllers.values()].some(controller => controller.busy) }

  profiles(): Omit<VmProfiles, 'canManage'> {
    return { revision: this.catalog.revision, profiles: this.catalog.profiles.map(({ id, label, subscription, resourceGroup, name, comfyUrl }) => ({ id, label, subscription, resourceGroup, name, comfyUrl })) }
  }

  private controller(id?: string) {
    if (this.mutating) throw new HttpError(409, 'VM 配置正在保存，请稍后重试。')
    const controller = this.controllers.get(id ?? this.catalog.profiles[0]?.id)
    if (!controller) throw new HttpError(404, 'VM 配置不存在。')
    return controller
  }

  async status(id?: string): Promise<VmStatus> {
    if (!id && !this.catalog.profiles.length) return { configured: false }
    return this.controller(id).status()
  }

  async refreshPending() {
    await Promise.allSettled([...this.controllers.values()].filter(controller => controller.busy).map(controller => controller.status()))
  }

  async act(action: VmAction, id: string, confirmedName: string, force: boolean, profileId?: string, revision?: string) {
    if (!profileId || revision !== this.catalog.revision) throw new HttpError(409, 'VM 配置已更新，请刷新后重新确认。')
    return this.controller(profileId).act(action, id, confirmedName, force)
  }

  private async persist(catalog: Catalog) {
    await mkdir(dirname(this.file), { recursive: true })
    const temporary = `${this.file}.${randomUUID()}.tmp`
    await writeFile(temporary, JSON.stringify(catalog, null, 2), { mode: 0o600, flag: 'wx' })
    await rename(temporary, this.file)
  }

  async saveProfile(input: VmProfileInput, revision: string, id?: string) {
    const parsed = vmProfileInputSchema.parse(input)
    if (this.busy) throw new HttpError(409, 'VM 操作尚未结束，不能修改配置。')
    if (revision !== this.catalog.revision) throw new HttpError(409, 'VM 配置已更新，请刷新后重试。')
    const existing = id ? this.catalog.profiles.find(profile => profile.id === id) : undefined
    if (id && !existing) throw new HttpError(404, 'VM 配置不存在。')
    if (!existing && this.catalog.profiles.length >= 20) throw new HttpError(400, '最多保存 20 台 VM 配置。')
    if (this.catalog.profiles.some(profile => profile.id !== id && this.identity(profile) === this.identity(parsed))) throw new HttpError(409, '此 VM 已有配置。')
    this.mutating = true
    try {
      const profile = { ...parsed, id: id ?? randomUUID(), auth: existing?.auth ?? this.auth, ...(existing?.cliPath ? { cliPath: existing.cliPath } : {}) }
      const controller = await this.factory(configSchema.strip().parse(profile), this.operationFile(profile))
      const catalog: Catalog = { version: 1, revision: randomUUID(), profiles: existing ? this.catalog.profiles.map(item => item.id === id ? profile : item) : [...this.catalog.profiles, profile] }
      await this.persist(catalog)
      this.catalog = catalog
      this.controllers.set(profile.id, controller)
      return this.profiles()
    } finally { this.mutating = false }
  }
}