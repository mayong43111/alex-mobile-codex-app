import { AzureCliCredential, ManagedIdentityCredential } from '@azure/identity'
import { z } from 'zod'
import type { ChatModel, ModelCatalogResponse } from '../src/shared.js'
import type { Config } from './config.js'
import { AppError } from './errors.js'

export type AzureCredential = Pick<AzureCliCredential, 'getToken'>
export function createAzureCredential(config: Config): AzureCredential {
  return config.authMode === 'azure-cli' ? new AzureCliCredential({ processTimeoutInMs: 15_000 })
    : new ManagedIdentityCredential(config.clientId ? { clientId: config.clientId } : {})
}

const modelSchema = z.object({ name: z.string(), version: z.string(), format: z.string() })
const deploymentSchema = z.object({
  name: z.string(),
  properties: z.object({ provisioningState: z.string(), model: modelSchema }),
})
const capabilitySchema = modelSchema.extend({ capabilities: z.record(z.string(), z.string()).default({}) })
const pageSchema = z.object({ value: z.array(z.unknown()), nextLink: z.string().optional() })

export class ModelCatalog {
  private cached?: { models: ChatModel[]; expiresAt: number }
  private pending?: Promise<ChatModel[]>
  constructor(
    private config: Config,
    private credential: AzureCredential = createAzureCredential(config),
    private request: typeof fetch = fetch,
    private kind: 'chat' | 'image' = 'chat',
  ) {}
  private get endpoint() { return this.kind === 'image' ? this.config.imageEndpoint : this.config.endpoint }
  private get resourceId() { return this.kind === 'image' ? this.config.imageFoundryResourceId : this.config.foundryResourceId }
  private get deployment() { return this.kind === 'image' ? this.config.imageDeployment : this.config.deployment }
  get configured() { return Boolean(this.endpoint && (this.resourceId || this.deployment)) }
  async list(refresh = false): Promise<ModelCatalogResponse> {
    if (refresh) this.cached = undefined
    const models = await this.models()
    const preferred = this.deployment
    if (preferred && models.length && !models.some(model => model.id === preferred)) {
      throw new AppError(503, this.kind === 'image' ? '默认图片部署不可用，请检查 AZURE_IMAGE_DEPLOYMENT。' : '配置的默认部署不在可用对话模型中，请检查 AZURE_MODEL_DEPLOYMENT。')
    }
    return { models, defaultModel: preferred || models[0]?.id, authMode: this.config.authMode }
  }
  async select(id?: string): Promise<ChatModel | undefined> {
    const catalog = await this.list()
    const selected = id ?? catalog.defaultModel
    if (!selected) {
      if (this.configured) throw new AppError(503, this.kind === 'image' ? 'Foundry 中没有可用的图片部署。' : 'Foundry 中没有可用的 Responses 对话部署。')
      return undefined
    }
    const model = catalog.models.find(model => model.id === selected)
    if (!model) throw new AppError(400, '所选模型不可用，请刷新模型列表后重新选择。')
    return model
  }
  private async models(): Promise<ChatModel[]> {
    if (!this.configured) return []
    if (!this.resourceId) {
      return [{ id: this.deployment, name: this.deployment, version: '', provider: 'Azure Foundry' }]
    }
    if (this.cached && this.cached.expiresAt > Date.now()) return this.cached.models
    if (this.pending) return this.pending
    const pending = this.discover()
    this.pending = pending
    try {
      const models = await pending
      this.cached = { models, expiresAt: Date.now() + 300_000 }
      return models
    } finally { this.pending = undefined }
  }
  private async discover(): Promise<ChatModel[]> {
    let token: Awaited<ReturnType<AzureCredential['getToken']>>
    try { token = await this.credential.getToken('https://management.azure.com/.default') }
    catch {
      throw new AppError(503, this.config.authMode === 'azure-cli'
        ? '无法使用 Azure CLI 登录态。请在运行服务的本机终端执行 az login，然后刷新模型列表。'
        : '无法获取托管身份凭据，请检查服务身份配置。')
    }
    if (!token?.token) throw new AppError(503, 'Azure 身份未返回模型目录访问令牌。')
    const base = `https://management.azure.com${this.resourceId}`
    const read = async (collection: string): Promise<unknown[]> => {
      const items: unknown[] = []
      let next: string | undefined = `${base}/${collection}?api-version=2025-06-01`
      for (let page = 0; next; page++) {
        const url = new URL(next)
        if (page >= 100 || url.origin !== 'https://management.azure.com'
          || url.pathname.toLowerCase() !== `${this.resourceId}/${collection}`.toLowerCase()) {
          throw new AppError(502, 'Foundry 模型目录返回了无效的分页地址。')
        }
        let response: Response
        try {
          response = await this.request(url, {
            headers: { Authorization: `Bearer ${token.token}` }, signal: AbortSignal.timeout(20_000),
            redirect: 'error',
          })
        } catch { throw new AppError(502, '无法连接 Foundry 模型目录，请检查网络后重试。') }
        if (!response.ok) {
          throw new AppError(503, response.status === 403
            ? '当前 Azure 身份没有读取 Foundry 部署和模型目录的权限，请联系资源管理员。'
            : `Foundry 模型目录请求失败（HTTP ${response.status}），请检查 Azure 登录态和资源配置。`)
        }
        const parsed = pageSchema.safeParse(await response.json())
        if (!parsed.success) throw new AppError(502, 'Foundry 模型目录响应格式无效。')
        items.push(...parsed.data.value)
        next = parsed.data.nextLink
      }
      return items
    }
    const [rawDeployments, rawCapabilities] = await Promise.all([read('deployments'), read('models')])
    const deployments = z.array(deploymentSchema).safeParse(rawDeployments)
    const capabilities = z.array(capabilitySchema).safeParse(rawCapabilities)
    if (!deployments.success || !capabilities.success) throw new AppError(502, 'Foundry 部署或模型能力数据格式无效。')
    return deployments.data.filter(deployment => {
      const model = deployment.properties.model
      return deployment.properties.provisioningState === 'Succeeded' && model.format === 'OpenAI'
        && capabilities.data.some(candidate => candidate.name === model.name && candidate.version === model.version
          && candidate.format === model.format && (this.kind === 'image'
            ? candidate.capabilities.imageGenerations === 'true' && candidate.capabilities.imageEdits === 'true'
            : candidate.capabilities.responses === 'true' && candidate.capabilities.chatCompletion === 'true'))
    }).map(deployment => ({
      id: deployment.name, name: deployment.properties.model.name,
      version: deployment.properties.model.version, provider: 'Azure Foundry',
    })).sort((a, b) => a.id.localeCompare(b.id))
  }
}
