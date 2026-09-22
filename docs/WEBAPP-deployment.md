# Azure Web App 部署

公开脱敏记录：以下资源名、域名、地址、零值 UUID 及 REDACTED 标记均为示例或占位符，不能作为当前环境的操作参数。

## 配置参数

`deploy/configure-webapp.mjs` 没有真实账户或镜像默认值。运行前必须在终端提供以下环境变量；缺失时在调用 Azure 前退出：

- 站点：`AZURE_HOSTING_SUBSCRIPTION`、`AZURE_RESOURCE_GROUP`、`AZURE_WEBAPP_NAME`、`AZURE_CONTAINER_IMAGE`（完整 registry/image:tag）。
- Entra：`ENTRA_TENANT_ID`、`ENTRA_APPLICATION_OBJECT_ID`、`ENTRA_CLIENT_ID`、`ENTRA_SERVICE_PRINCIPAL_ID`、`ENTRA_ALLOWED_USER_IDS`（逗号分隔对象 ID）。
- 模型：`AZURE_MODEL_SUBSCRIPTION`、`AZURE_GPT_ENDPOINT`、`AZURE_GPT_DEPLOYMENT`、`AZURE_IMAGE_ENDPOINT`、`AZURE_IMAGE_DEPLOYMENT`。
- 存储：`AZURE_STORAGE_BLOB_ENDPOINT`、`AZURE_STORAGE_CONTAINER`。
- 可选：`AZURE_CLI_PATH`，默认使用 PATH 中的 `az`。

这些值不是自动读取的 `.env` 文件。真实配置应留在忽略目录或安全环境设置中，不提交密钥。执行脚本会修改身份分配、认证、应用设置和容器镜像，必须先确认目标和授权；提交代码本身不会执行它。

`deploy/blob-network.json` 要求提供 `storageAccountName` 参数，指向同一部署资源组内的既有存储账户。网络名称和 `10.30.0.0/24` 仅是示例，使用前检查名称、地址段、区域冲突及私网费用，不可直接套用于既有部署。

2026-09-22 部署，网址：<https://example-studio-web.azurewebsites.net/>。

## 最新发布

### 东南亚重建

2026-09-22 按用户要求在 Southeast Asia 全新创建 Web App、Linux B2 单实例计划、Basic ACR、Standard LRS Blob 私有容器及专用终结点，不迁移旧数据库、素材或运行历史。应用仍使用 `20260922-assets-96762a2`，镜像摘要与下方已验收版本一致。新数据库 `PRAGMA integrity_check` 为 `ok`，项目数为 0。

Web App 集成到 GPU 所在 VNet 的独立委派子网，Blob 专用终结点使用另一独立子网；私有 DNS 链接到该 VNet。NSG 仅允许新 Web App 子网访问 GPU 的 TCP 8188，保留开发机规则，不增加公网或 SSH 入口。已配置 `VM_CONFIG=/home/studio/vm-config.json` 和 `COMFYUI_SERVER_URL`，VM 配置使用 `auth: "managed-identity"`。

新系统托管身份已分配并回读六项最小授权：ACR 拉取、容器范围 Blob 读写、两个模型账户的 OpenAI User、目标 VM 电源操作与异步操作读取。沿用既有 Entra 应用、用户分配及白名单，登录回调已更新为新站点。健康检查 200、匿名 API 401、登录入口 302；11:26:55 UTC 应用日志确认 Blob 写入/读取/删除成功、迁移 0 文件。GPU 保持已解除分配，未发起模型调用；实际用户登录、云端模型调用及 GPU 启停/生成仍未端到端验收。

旧 East Asia 专用资源组已删除并回读确认不存在，包含旧 Web App、B2、ACR、Blob 数据及配套网络。旧身份六项授权、旧登录回调、旧 Web App 的跨区域 peering 和 NSG 规则均已清理。GPU、系统盘、模型盘、模型账户及开发网络保留。下方旧环境发布、数据迁移及镜像保留说明均为历史记录，旧 ACR 的历史标签不再可用。

### 重建前的应用发布

2026-09-22 新版应用提交 `96762a2` 已推送并部署，镜像标签 `20260922-assets-96762a2`，摘要 `sha256:39b352546249668134b0c5272d7b2247962f49e570a0ba9222fe3e5a295d1675`。包含通用文件上传入库、按需只读 MCP、Codex 决定生成/编辑及选择来源图片、模型选择、项目删除和 VM 控制界面。22 项后端、26 项手机浏览器、11 项 Node 运行时、12 项 Python 测试共 71 项通过，构建、lint、敏感信息扫描及生产镜像离线认证检查通过。

本轮仅更新 `linuxFxVersion`，两次只读核对云端无排队/运行任务；认证配置与应用设置前后完全一致。10:44:45 UTC 新版 Blob 读写删除探针成功、无需迁移，10:44:46 启动探针成功，10:44:54 站点启动。健康/PWA 资源正常，匿名 API 401，登录入口重定向 Entra。旧镜像标签保留，不自动回滚或恢复历史失败任务。

切换期间旧容器的 SSE 查询出现一次 `database disk image is malformed` 并退出，新容器随后启动成功。只读下载数据库执行 `PRAGMA integrity_check` 返回 `ok`，项目记录仍在，待处理任务为 0；未修复或重写数据库。根因尚未完全确定，新旧容器短暂重叠访问共享 SQLite 是风险，不能宣称支持滚动并发运行。后续发布应在确认空闲后停站切换，或先迁移到适合多实例的数据库。

云端 `VM_CONFIG` 和 `COMFYUI_SERVER_URL` 仍未配置，GPU 私网连接未扩展，因此 VM 控制/GPU 生成功能代码虽已发布，云端功能尚未启用。未实际启停 GPU，未新增收费模型调用；新附件读取及上传图编辑的云端托管身份端到端验收仍待登录后验证，本地真实测试已通过。

### 上一版本

2026-09-22 用户批准签入并发布。应用提交 `dc11780` 已推送，线上镜像为 `20260922-web-search-dc11780`；旧版 `20260922-resend` 保留，早期候选 `20260922-message-ux` 未上线。发布前两次确认没有排队或运行任务，仅 PATCH Web App 的 `linuxFxVersion`，未执行通用配置脚本、变更认证/存储/网络或恢复 GPU。

07:30 UTC 平台日志确认拉取新标签、启动探针成功和站点启动；应用日志确认 `Blob read/write/delete verified; migrated 0 files` 后 API 启动。健康与 PWA 资源可访问，匿名 API 受保护。本轮不额外调用付费模型，云端托管身份下搜索、编辑及真实登录交互仍需端到端验收。

- 对话按轮次排列，用户重发和助手复制均在消息右下角，时间在左；图片生成或修改在文字回复后继续显示加载状态。
- 新增 Codex 内置实时 Web Search，记录实际搜索事件；shell、写文件、自动安装 Skill/工具和其他权限未开放。本地 Azure GPT 搜索官方 PWA 文档已返回三条完成事件及来源链接，无出图。无需额外搜索服务或凭据；本地使用既有模型认证，云端托管身份搜索仍待验证。
- Codex 新增 `edit` 决策，使用当前保留对话中最近一张已完成生成图，通过 Azure `/openai/v1/images/edits` 上传原始 PNG；不使用已清理分支、未来消息或其他项目的素材，不自动回退生成。保留原图并记录来源 ID 与 SHA-256，尺寸沿用原图。暂不支持上传附件编辑、多图或蒙版。
- 云端失败任务 `00000000-0000-0000-0000-000000000000` 已含图片，错误是运行 JSON 固定 `.tmp` 文件 rename 的 ENOENT。改为每次写入独立临时文件；40 次并发写入回归通过。修复已随新版发布，云端旧失败记录未自动恢复；这不是跨进程写入顺序或多实例支持。
- 本地真实验收项目 `00000000-0000-0000-0000-000000000000`：蓝杯原图 `00000000-0000-0000-0000-000000000000`，红杯编辑图 `00000000-0000-0000-0000-000000000000`。原图 SHA-256 为 `REDACTED_SHA256`。已验证同一 thread、1024×1024、来源一致、原图字节不变，目视确认杯子变红且柠檬位置、背景与构图基本保持。
- 首次生成已出图，但新增来源字段违反 OpenMontage 严格素材 schema，检查点保存失败；现将字段移到 manifest 元数据，完整检查点离线测试通过。仅本地人工恢复该测试原图后继续编辑，没有重复生成或自动恢复云端数据。总计一次真实生成和一次真实编辑，费用未知；不能将本次验收描述为未经恢复的完整首次成功流程。
- 10 项后端、16 项手机端、3 项决策、1 项并发保存、5 项图片工具测试以及构建、lint 通过。真实编辑使用本地 CLI 图片认证；云端托管身份下编辑、真实手机键盘和 PWA 安装尚未验收。

## VM 控制授权

2026-09-22 用户要求允许所有已获应用登录授权的用户控制 GPU VM。代码已在本地移除独立 VM 管理员白名单，仍保留原有 Easy Auth、租户和用户白名单校验，不允许匿名或仅持有其他租户账号的用户操作。

已为当前 Web App 系统托管身份创建、分配并回读以下最小角色，未授予个人 Azure 账号：

| 角色 | 分配范围 | 允许动作 |
| --- | --- | --- |
| Qwen Studio VM Power Operator | 目标 GPU VM | Microsoft.Compute/virtualMachines/read、instanceView/read、start/action、restart/action、deallocate/action |
| Qwen Studio VM Operation Reader | GPU 所在资源组 | Microsoft.Compute/locations/operations/read |

异步状态查询需要资源组级读取权限，参见 [Azure 异步操作权限要求](https://learn.microsoft.com/en-us/azure/azure-resource-manager/management/async-operations#permission-for-tracking-async-status)。电源操作仍仅限目标 VM，不授予删除、改配、执行脚本或 RBAC 管理权限。

东南亚重建后，新身份已重新取得上述授权，`VM_CONFIG`、`COMFYUI_SERVER_URL` 和同 VNet 私网连接均已配置。GPU 未实际启停；角色分配回读不等于云端端到端操作已验收。

## 资源

- 订阅 2：`00000000-0000-0000-0000-000000000000`。
- 独立资源组：`rg-example-studio`，Southeast Asia。
- Linux App Service Plan：`asp-example-studio`，B2，单实例。
- Web App：`example-studio-web`，仅 HTTPS，Always On。
- ACR：`examplestudioregistry`，Basic，管理员密码禁用。
- 镜像：`examplestudioregistry.azurecr.io/qwen-studio:20260922-assets-96762a2`。
- 镜像摘要：`sha256:REDACTED_SHA256`。
- Blob 账户：`examplestudiostorage`，Standard LRS，私有容器 `assets`。
- 私网：复用 GPU 所在 VNet，独立的 Web App 集成子网及 Blob 专用终结点子网，私有 DNS 区 `privatelink.blob.core.windows.net`；无需 Web App 到 GPU 的跨区域 peering。

B2 与 ACR 持续收费，停止 Web App 不停止计划收费；Blob 容量和读写请求、模型调用另按 Azure 账单计费。用户已确认增加私网接入，专用终结点与 DNS 预计新增约 US$8–10/月基础费用，另计流量和查询，以账单为准。没有改动其他项目资源或恢复 GPU 申请。

## 用户登录

租户：`00000000-0000-0000-0000-000000000000`。App Service Easy Auth 强制单租户 Entra 登录，企业应用要求用户分配，并配置用户白名单；后端再次校验平台提供的租户和用户声明。该声明仅可信于 App Service 认证代理后方，不能将容器端口另行公开。匿名例外仅为 `/healthz` 和 PWA 安装资源：`/manifest.webmanifest`、`/sw.js`、`/icons/icon-180.png`、`/icons/icon-192.png`、`/icons/icon-512.png`。首页、API 和素材仍需登录。

- 登录应用 client ID：`00000000-0000-0000-0000-000000000000`。
- 应用对象 ID：`00000000-0000-0000-0000-000000000000`。
- 企业应用对象 ID：`00000000-0000-0000-0000-000000000000`。
- 已授权部署账号对象 ID：`00000000-0000-0000-0000-000000000000`。
- 已授权 `user@example.com` 来宾对象 ID：`00000000-0000-0000-0000-000000000000`。
- 登录客户端凭据保存在 App Service 设置 `ENTRA_LOGIN_SECRET`，到期时间为 **2027-03-21 03:56 UTC**，到期前须轮换。这不是 GPT 或图片模型的 Key。

**最新状态**：用户提供的来宾对象已核实属于 `user@example.com`，账号启用，企业应用分配、Easy Auth 白名单和后端白名单均已添加并回读验证。2026-09-22 Graph 回读状态为 `Accepted`，邀请已接受，实际登录仍待验证。此前自动邀请被租户策略拒绝；本次未修改租户级策略，也未重新发送邀请。

2026-09-22 用户报告在 `/.auth/login/aad/callback` 下载文件。检查发现 Easy Auth 请求 `response_type=code id_token`，但应用注册的 `enableIdTokenIssuance` 为 false；现已开启并回读确认，`enableAccessTokenIssuance` 仍为 false，回调地址和单租户限制保持不变。配置脚本已同步修正，无需重建镜像。新增测试确认授权后的 `/`、`/index.html` 和带查询参数首页均返回 `text/html` 且不含附件标记。该配置缺陷已修复，但实际登录和下载现象是否消失仍待用户重新走登录流程验证，不能通过直接刷新旧 callback 验收。

当前另有管理员同意阻塞：实际登录请求仅包含 `openid profile email`，应用 `requiredResourceAccess` 为空，企业应用没有 `oauth2PermissionGrants` 记录。当前部署账号的目录角色为 Global Reader 和 User Administrator，不能代为授予应用管理员同意。需要目标 目标 租户的 Cloud Application Administrator、Application Administrator 或 Global Administrator 对此应用批准上述基本身份范围；不需要开放租户用户同意策略，也不需要授予 Graph 目录、邮件或文件读取权限。来宾已接受邀请和企业应用分配并不等于完成管理员同意。

管理员可使用 [仅请求基本身份范围的同意入口](https://login.microsoftonline.com/00000000-0000-0000-0000-000000000000/v2.0/adminconsent?client_id=00000000-0000-0000-0000-000000000000&scope=openid%20profile%20email&redirect_uri=https%3A%2F%2Fexample-studio-web.azurewebsites.net%2F.auth%2Flogin%2Faad%2Fcallback)。管理员同意不是普通用户登录，完成后的 callback 不一定建立应用会话；应回读企业应用同意记录，然后从 `/.auth/login/aad?post_login_redirect_uri=%2F` 重新发起用户登录。管理员同意不改变现有用户分配要求或白名单。


重新同步当前两个用户的授权，从仓库根目录执行 `node deploy/configure-webapp.mjs`。

脚本会为名单中的用户添加企业应用分配，并同步 Easy Auth 与应用白名单。它不会删除旧的企业应用分配，但白名单中不再包含的用户会被两层授权拒绝。现阶段为受邀用户共享工作区，**没有按用户隔离项目和素材**。

## 模型认证

两个模型均使用 Web App 系统托管身份，principal ID：`00000000-0000-0000-0000-000000000000`。模型保留在订阅 1，同一 Entra 租户，未复制或新建模型部署。

| 应用设置 | 值 |
| --- | --- |
| `AZURE_GPT_ENDPOINT` | `https://example-gpt-account.cognitiveservices.azure.com` |
| `AZURE_GPT_DEPLOYMENT` | `gpt-5.4` |
| `AZURE_IMAGE_ENDPOINT` | `https://example-image-account.cognitiveservices.azure.com` |
| `AZURE_IMAGE_DEPLOYMENT` | `gpt-image-2` |
| `AZURE_MODEL_SUBSCRIPTION` | `00000000-0000-0000-0000-000000000000` |

该身份有独立 ACR 上的 `AcrPull`、上述两个模型账户各自范围的 `Cognitive Services OpenAI User`，以及 `assets` Blob 容器范围的 `Storage Blob Data Contributor`。没有订阅级 Contributor、模型账户管理或读取 Key 权限。图片账户继续禁用 Key；GPT 账户现有 Key 设置未修改，但此 Web App 不使用 Key。

后端每次运行从 App Service 身份端点请求 Cognitive Services 短期令牌，在内部请求中交给 Codex 和图片工具；不写入消息、运行记录或检查点。Codex 使用 Bearer 认证，图片工具也使用 Bearer；Codex 子进程不继承托管身份端点、登录客户端凭据或其他应用环境变量。模型令牌不参与请求幂等哈希。没有令牌时失败，不降级到 Key，也不自动重试付费调用。

## 镜像与数据

同一镜像包含 React 构建产物、Fastify、Codex CLI/SDK 0.155.1 和固定版本 OpenMontage。网页后端监听 8080，运行时网关只监听容器本机 3199。启动器监控两个子进程，任一退出都会停止容器。

`WEBSITES_ENABLE_APP_SERVICE_STORAGE=true`。聊天、项目和素材索引仍位于 `/home/studio/data/studio.sqlite`；Codex thread、运行结果及 OpenMontage 检查点位于 `/home/studio/runtime`，通过 `/state` 符号链接访问。内部网关凭据启动时随机生成，仅保存在 `/tmp` 的 0600 文件。没有将本机历史数据或 `.local/services.json` 上传云端。

应用原图、上传参考图和缩略图改由私有 Azure Blob 保存：`https://examplestudiostorage.blob.core.windows.net/assets/<asset-id>.png` 与 `.webp`。环境设置 `AZURE_STORAGE_BLOB_ENDPOINT=https://examplestudiostorage.blob.core.windows.net/`、`AZURE_STORAGE_CONTAINER=assets`；官方 SDK 使用 Web App 系统托管身份，禁用存储账户 Key 和匿名 Blob 访问，不签发公开 SAS。浏览器继续走受 Entra 保护的 `/api/assets/:id/content`，响应 `Cache-Control: no-store`。

组织策略 `StorageAccount_PublicNetwork_Modify` 强制存储公网关闭。初次发布在 Blob 探针遇到 403 后已回退，未修改或豁免策略。获用户确认后，通过 `deploy/blob-network.json` 部署独立 VNet、专用终结点和私有 DNS，并执行 Web App VNet 集成；专用连接回读为 Approved，账户 `publicNetworkAccess=Disabled`。2026-09-22 06:19 UTC 新版日志确认 `Blob read/write/delete verified; migrated 2 files`，随后 API 启动成功。

发布前确认旧路径 `/home/studio/data/images` 有一张 PNG（647527 bytes）及一张 WebP（2514 bytes）。启动先完成真实 Blob 写入/读取/删除探针，再按 SQLite 索引迁移缺失的原图与缩略图，并逐字节回读校验；失败时不启动任务处理，也不降级回本地。旧文件不删除，保留作为回退副本。OpenMontage 执行目录和运行结果 JSON 仍可能包含图片副本，不属于本次素材存储迁移的删除范围；当前不是 Blob-only 数据系统。

## PWA 安装

应用提供 standalone 安装清单、192/512px PNG 图标和 iOS 180px 图标。Android Chrome/桌面 Edge 或 Chrome 使用浏览器安装菜单；iOS Safari 使用“添加到主屏幕”。实际安装提示取决于浏览器，登录仍由 Entra 控制。

Service Worker 仅对同源首页导航执行网络请求，失败时返回不含业务数据的离线提示；不使用 Cache Storage、不缓存首页、聊天、图片或登录回调，不拦截 `/.auth` 或 API。没有离线 AI 功能。应用更新随线上版本加载，安装不绕过管理员同意、用户白名单或 MFA。真机安装与独立窗口登录尚需实机验收。

数据库采用 DELETE journal，避免在网络挂载上使用 WAL。只允许一个实例、一个应用进程；这不是高可用数据库方案，挂载锁和故障恢复仍需长期验证。扩容、部署槽并行运行或多实例之前，先迁移到托管数据库。备份需停站后同时保存两个持久目录及 Blob 素材；持久化不等于已有备份。执行中断仍标记结果待核实，不自动重发付费调用。旧镜像不支持 Blob，新版新增素材不能直接通过旧镜像读取，回退前需规划素材导出。

## 消息重发与目录修复

运行时在启动时创建 `/state/codex`，修复云端 `/state` 链接到全新持久挂载后目录缺失造成的 `Codex Exec exited with code 1`。空 `/state` 无网络启动检查通过，云端 SCM 已确认 `/home/studio/runtime/codex` 存在。

用户消息旁的重发图标会打开确认弹窗。确认后，在同一数据库事务内保留所选消息及之前的消息，删除其后消息及相关任务、替换所选消息的原运行，然后重新排队。重发请求幂等，确认后若对话已有变化则拒绝；运行中、排队中或尚未结束的停止请求需先处理，不允许旧任务回写到新对话。草稿不清空，生成图片保留在素材库。

重发清除当前项目 thread 关联，开启新 Codex thread，并仅传入保留的历史文字（最多 200 条、200000 字符），不继续使用包含已删除内容的旧线程。旧 Codex 会话、运行结果和检查点不物理擦除，重发不是数据销毁功能。只有当前消息会重新执行，历史作为上下文传入；实际模型判断仍可能有误，调用可能再次计费。

## 更新

```bash
docker build --target webapp -f runtime/Dockerfile -t examplestudioregistry.azurecr.io/qwen-studio:<new-tag> .
az acr login --subscription 00000000-0000-0000-0000-000000000000 --name examplestudioregistry
docker push examplestudioregistry.azurecr.io/qwen-studio:<new-tag>
```

使用新标签更新 Web App 容器配置；避免执行中的任务期间重启。`deploy/configure-webapp.mjs` 使用显式配置参数，更新时应设置 `AZURE_CONTAINER_IMAGE`。它通过临时 0600 文件传输登录凭据，不输出应用设置或 secret。日志、CLI 输出也不要打印令牌。默认 FTP/SCM 基本密码发布禁用，管理员操作使用 Entra 身份。

本地 Compose 显式使用 `runtime` 镜像目标，保持原有本机开发方式，不受云端入口认证影响。

## 验证状态

- 9 项后端测试、14 项手机测试、构建、lint 通过；生产 npm 依赖审计为 0 漏洞。
- 无网络、无真实凭据的镜像验收通过：健康端点 200，匿名 API 401，模拟已授权身份可读取前端。
- 云端 `/healthz`、PWA 清单、Service Worker、512px 图标均为 200，安装资源为 `no-store`；匿名 API 为 401。此前真实浏览器首页已验证跳转到指定租户微软登录页。
- 系统身份经过专用终结点完成真实 Blob 写/读/删探针，旧原图及缩略图共两份完成逐字节迁移校验；本地运行时也已重建。
- ARM 回读确认 Easy Auth 强制认证、用户白名单、系统身份镜像拉取及模型 RBAC 配置。
- **尚未验证**：此次发布后用户登录的真实重发、托管身份下 GPT 的真实回复与图片生成、PWA 真机安装。没有额外触发付费模型调用。离线测试、目录确认及健康检查不能替代这些端到端验收。