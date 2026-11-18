# Copilot Mobile Studio

独立重建的手机创作工作室。采用 Copilot SDK、Azure 身份、AHP 1.1 和自建 React
界面，不依赖旧 App 代码、数据库或部署配置。

## 当前能力

- 管理员创建账号、密码登录、Cookie 会话、CSRF 和用户隔离。
- 快捷指令填入可编辑草稿；用户发送后创建会话并开始对话。
- 官方 AHP 客户端 + 自建最小 Host，流式消息、历史持久化、断线快照恢复。
- 图片、视频两个真正注册到 Copilot 的 Skill；用户只能选择启用或停用。
- App 自有 `image_generation` 工具，使用独立配置的 Azure 图片部署进行生成和编辑。
- 真实图片上传、手动调整分辨率和质量、私有附件及生成图片展示。
- VS Code 新版三档权限：Manual permissions、Assisted permissions、Allow all。
- 每用户独立 Copilot 子进程、运行目录及会话状态。
- 停止、重复操作去重、服务重启后的显式中断，不自动重发付费任务。

Skill 负责业务指导，不是模型本身。图片工具由本 App 实现并注册到 Copilot SDK，
不连接当前开发助手的同名工具。视频仍需管理员配置 MCP 服务；不包含 GPU 部署。

架构、数据边界与后续范围见 [设计文档](docs/architecture.md)。

## 本地启动（PowerShell，Node.js 24.11+）

```powershell
npm ci
Copy-Item .env.example .env.rebuild
```

配置使用新文件 `.env.rebuild`，**不会加载、修改旧项目的 `.env`**。
只运行登录和界面时可以暂不配置模型。未配置时发送会明确报错，不会返回模拟回复。
若 `.env.rebuild` 已存在，请编辑它，不要覆盖已有配置。

创建账号时，通过当前进程环境传入密码，不要将密码写进文件或命令历史：

```powershell
$securePassword = Read-Host "New account password (6+ characters)" -AsSecureString
$env:STUDIO_USER_PASSWORD = [System.Net.NetworkCredential]::new('', $securePassword).Password
try {
  npm run user:create -- yourname
} finally {
  Remove-Item Env:\STUDIO_USER_PASSWORD
}
npm run dev
```

打开 <http://127.0.0.1:4310>。没有默认账号，不开放注册。
账号名称使用 3–64 个小写字母、数字、点、横线或下划线。
所有环境的密码长度均为 6–256 个字符；生产环境建议使用长且唯一的密码。
服务默认只监听本机；不允许无 HTTPS 的公网 Origin。

`npm run dev` 持续运行开发服务：React 组件使用 Fast Refresh，CSS 使用 HMR，
修改界面无需手动刷新，未发送的草稿尽可能保留；服务端代码变更由 `tsx watch`
自动重启。服务端重启会将正在运行的对话明确标记为中断，不自动重发或重跑。
页面仍使用 4310 端口，Vite 热更新 WebSocket 单独使用 `HMR_PORT`（默认 4311），
避免与经过登录鉴权的 AHP WebSocket 混用。生产启动不启用监视器或 HMR。

聊天面板采用 VS Code 默认深色主题的密度与视觉结构，使用官方 Codicons 图标：
紧凑标题栏、用户消息卡片、Copilot 回复、Markdown/代码块、工具确认和模型选择栏。
消息复制、附件上传、权限选择和受控图片展示可用。

## Azure Foundry 对话模型

本地默认使用 Azure CLI 身份。在运行服务的同一用户终端执行：

```powershell
az login
az account set --subscription YOUR-SUBSCRIPTION
az cognitiveservices account list --query "[].{name:name,resourceId:id}" -o table
```

选择要连接的 Foundry 资源，在 `.env.rebuild` 中配置：

```dotenv
AZURE_AUTH_MODE=azure-cli
AZURE_MODEL_ENDPOINT=https://YOUR-RESOURCE.openai.azure.com/openai/v1/
AZURE_FOUNDRY_RESOURCE_ID=/subscriptions/YOUR-SUBSCRIPTION/resourceGroups/YOUR-GROUP/providers/Microsoft.CognitiveServices/accounts/YOUR-RESOURCE
# Optional default; must be an available deployed chat model.
AZURE_MODEL_DEPLOYMENT=YOUR-DEFAULT-DEPLOYMENT
```

重启后，输入框底部提供 VS Code 风格的 Agent / 模型选择栏。
模型列表通过 ARM 实时读取实际部署及模型能力，缓存五分钟，可手动刷新；
仅提供已成功部署、支持 Responses 的 OpenAI 对话模型，不混入嵌入或图片模型。
Azure 身份需要资源的部署/模型目录读取权限，以及模型推理的数据面权限。
模型选择按会话保存，切换后保留历史；回复运行中不可切换。
Azure CLI 凭据和 token 只由服务端读取，不进入浏览器或配置文件。
登录过期或权限不足会明确报错，不用静态模型列表掩盖发现失败。

云端改用托管身份：

```dotenv
AZURE_MODEL_ENDPOINT=https://YOUR-RESOURCE.openai.azure.com/openai/v1/
AZURE_MODEL_DEPLOYMENT=YOUR-DEPLOYMENT
AZURE_TOKEN_SCOPE=https://cognitiveservices.azure.com/.default
AZURE_AUTH_MODE=managed-identity
```

云端使用托管身份，并为该身份分配目标模型的数据面调用权限。
用户分配的托管身份可额外设置 `AZURE_CLIENT_ID`。
Scope 必须匹配实际 Azure 资源接受的 token audience，不要将不同 Foundry
端点的示例不加验证地混用。

不设置 `AZURE_FOUNDRY_RESOURCE_ID` 时仍支持单一固定部署，不做目录发现。
生产模式默认托管身份并禁止 CLI 身份；任何模式都不自动回退到 API
Key、其他账号或其他模型。网页登录账号和 Azure 模型身份是两个独立概念。

SDK 使用原生 runtime，安装时需要允许 npm 可选平台依赖。
`@microsoft/copilot-sdk` 固定为 `2.0.0`，AHP 固定为 `1.1.0`。
BYOK、Skill provider 等部分上游接口仍标为 experimental，升级前必须验证。

## 容器与生产发布

生产使用 App Service 自定义 Linux 容器，镜像存放在 ACR：

- Azure SQL 保存账号、会话、操作去重、图片任务和 Copilot 原生会话文件。
- 私有 Blob 保存图片与附件，通过服务端 SDK 访问，不挂载为数据库目录。
- `DATA_DIR` 仅保存容器临时工作目录；不把 SQLite 放到 App Service 网络盘。
- 配置 `SQL_SERVER`、`SQL_DATABASE`、`AZURE_BLOB_CONTAINER_URL`，三项必须同时设置。
- SQL 与 Blob 使用私有端点和 VNet；数据面仅使用托管身份，不使用连接密码或存储密钥。
- 本地仍使用原有 SQLite 和本地文件，不需要云数据库。

SDK 的 `sessionFs` 接口将原生 transcript/checkpoint 同步写入托管数据库，
容器本地目录清空后仍可继续多轮对话。该虚拟文件系统按用户与会话隔离，
支持二进制、原子追加和目录重命名；不提供 SDK SQLite 工具或 todo 功能。
数据库租约限制一个活动实例，失去租约后禁止继续写入或提交新的图片请求。
当前不支持横向扩容或多个生产槽同时运行。

发布工作流 `.github/workflows/webapp.yml` 构建并测试真实 Linux 镜像，
使用 `production` 环境现有的 OIDC 身份，按不可变 digest 更新原站。
从重建分支创建 `copilot-mobile-*` 标签即可发布，不需要改写 `main`。
模型及存储地址通过 `production` 环境的 `COPILOT_*` 变量配置。
发布前检查旧任务并备份旧库；新程序不读取或覆盖旧数据目录。
启动后检查前端哈希、版本、数据库租约和匿名访问边界，失败恢复旧镜像与配置。

首次部署由操作员临时授权站点身份初始化新 SQL，使用
`deploy/schema.sql` 创建表及仅有 DML 权限的 `copilot-mobile-runtime` 用户。
`STUDIO_BOOTSTRAP_USERS` 是仅迁移账号哈希的一次性受保护环境 Secret，
不包含登录 Cookie、会话或图片，也不能覆盖已有的不同凭据。
初始化执行真实 SQL/Blob/会话文件验证并清理验证数据。
发布脚本成功后清除站点初始化设置；操作员还须删除 GitHub 初始化 Secret，
恢复 SQL 管理员，并重启验证应用仅靠普通数据库权限运行。
后续正常发布不需要初始化 Secret 或 SQL 管理员权限。

## 图片工具与附件

在 `.env.rebuild` 中成对配置独立图片端点和实际部署名，修改后重启服务：

```dotenv
AZURE_IMAGE_ENDPOINT=https://YOUR-IMAGE-RESOURCE.openai.azure.com/openai/v1/
AZURE_IMAGE_DEPLOYMENT=gpt-image-2.5-flare
AZURE_IMAGE_FOUNDRY_RESOURCE_ID=/subscriptions/YOUR-SUBSCRIPTION/resourceGroups/YOUR-GROUP/providers/Microsoft.CognitiveServices/accounts/YOUR-IMAGE-RESOURCE
```

图片和对话可以使用不同 Foundry 资源，但使用同一服务端 Azure 身份；该身份需有
图片资源的数据面权限。本地使用 `az login`，生产使用托管身份，不使用 API Key。
图片部署不混入聊天模型选择器，也不自动替换用户指定的模型。
设置页直接提供对话模型、权限、图片模型和 Skill 开关，不展示引擎或协议说明。
在“设置 → 图片模型”选择图片模型，列表读取目标资源已成功部署且
同时支持图片生成和编辑的实际模型，可手动刷新。默认为 `gpt-image-2.5-flare`；
例如资源部署了 GPT Image 2、2.5 Flare、2.5 Sunburst，就可在三者之间选择。
选择按账号保存，重新登录后保留；当前有运行中对话时不能切换，其他账号不受影响。
不配置图片资源 ID 时仅提供 `AZURE_IMAGE_DEPLOYMENT` 指定的固定模型。
App 注册自定义 `image_generation`，调用 Azure v1 `images/generations`；
带参考图时调用 `images/edits`，传入所有选中的参考图。

加号选择 JPEG、PNG 或 WebP；原图最多 20MB、4000 万像素，每条最多 6 张。
浏览器先展示原图预览，可保持比例调整分辨率和质量；明确确认后压缩为 WebP。
上传最长边最多 2048px、单张最多 2MB，超限要求用户继续调整，不偷偷再缩小。
原始文件不上传、不修改；服务端再次验证静态图片、尺寸和大小并移除元数据。
附件作为真实图片输入传给 Copilot SDK，不是只传文件名。

权限按会话保存，默认 Manual permissions，运行中不可切换：

- **Manual permissions**：需要确认的媒体调用逐次批准。
- **Assisted permissions**：使用 SDK 原生模型评估；只有运行时明确评估通过且不要求
  人工审批时自动批准。评估未通过、不可用或该工具不适用时仍需手动确认。
- **Allow all**：自动批准当前会话的有效工具；强制人工审批策略仍优先。

首次启用 Assisted permissions 或 Allow all 会显示风险确认。三档均不扩大已配置、
对应 Skill 启用的工具集合，不开放 Shell、文件系统或安装权限。
图片请求使用持久操作编号去重；失败、断线或计费未知不自动重试。
停止不保证已经提交的 Azure 任务免费或撤回，需先核对结果和计费。

上传和生成结果按用户隔离并鉴权读取；只展示本站受控图片，不加载模型返回的任意
外部图片地址。上传和生成原图合计每用户最多 200MiB，生成结果单张最多 20MiB。
生成结果不套用上传压缩限制、不静默降低画质；当前配额清理由管理员处理。

## 其他工具配置

复制 [工具配置示例](tools.example.json) 为被 Git 忽略的 `tools.json`，替换为实际
**HTTPS MCP 服务**地址，并通过环境变量提供 `tokenEnv` 指定的凭据。修改后重启服务。
不要在 MCP 地址中填写 Azure REST 端点；内置图片工具使用上述独立配置。

```json
{
  "servers": [
    {
      "id": "studio-images",
      "label": "我的图片服务",
      "skill": "image-production",
      "url": "https://YOUR-SERVICE.example/mcp",
      "tokenEnv": "IMAGE_TOOL_TOKEN",
      "tools": ["generate_image", "edit_image"]
    }
  ]
}
```

- MCP 服务必须实现列举和调用相应工具，参数 schema 由服务发布。
- 网页用户不能修改 URL、工具列表、凭据或 Skill 内容。
- 停用 Skill 后，其工具从下一条消息的可用集合移除。
- MCP 工具遵循当前会话权限模式；不提供跨会话的全局自动批准。
- `X-Studio-User-Id` 由服务端发送；MCP 服务必须验证其服务凭据并实施用户/素材权限。
- MCP 服务自己负责付费任务幂等、持久队列、停止与结果对账。不能把 AHP 的重连视为
  对生成任务的 exactly-once 保证。
- 不自动加载外部图片、不展示媒体生成成功的假结果。

## Skills

- [图片创作](skills/image-production/SKILL.md)：分析与生成分离、多参考图、原图保护、
  显式尺寸/模型约束、结果真实性。
- [视频创作](skills/video-production/SKILL.md)：短片/分镜/口播分离、脚本确认、
  已完成产物保留、计费与能力边界。

它们是根据业务需求重新编写的能力说明，不导入旧运行时或旧模型适配代码。
用户的启停选项持久化在自己的账号下，下次登录仍然有效。

## 验证

```powershell
npm run check
npm test
npm run build
```

测试包括真实 Copilot runtime 连接本机 Responses API 夹具、流式输出、恢复会话、
实际视觉输入、自定义图片工具调用，以及上传隔离、权限和图片请求幂等。
夹具只存在于测试，不是产品在配置失败时的备用回复。
这验证 SDK/协议接线，不代表 Azure 实际身份或真实图片/视频服务已验收。

## 生产运行与数据

先构建，在 `.env.rebuild` 中设置 `NODE_ENV=production`、HTTPS `APP_ORIGIN`、
匹配的监听地址、模型配置，以及独立持久目录 `DATA_DIR`，再执行 `npm start`。
在 HTTPS 反向代理后运行，同源转发 HTTP 和 `/api/ahp` WebSocket。
目前不信任代理身份头；登录限速按直接连接 IP 计算，反向代理后为保守共享限速。

持久目录包括 SQLite、私有附件和每用户 runtime 会话，均需一致备份。当前仅支持单实例和
本地持久磁盘。进程隔离不是安全沙箱，生产仍需最小文件/网络权限及容器隔离。

## 分支说明

本分支从空历史开始。原分支没有改写。切换分支后可能看到 Git 忽略的旧目录，
它们没有被新应用导入，也不属于新应用发布内容；不应删除其中的本地数据。
