# 云端运行补充

本文资源名、域名、UUID、路径与网络地址已替换为示例或占位符，不是可直接使用的现网配置。

新增 PWA 安装清单、PNG 图标及不保存响应的 Service Worker。云端素材改用系统托管身份访问私有 Blob；聊天数据库和运行时检查点仍保存在 Web App 持久目录。启动时迁移已有素材并保留旧文件回退，详见部署记录。以下本地磁盘存储说明仅适用于本地开发模式。

订阅 2 Web App 已启用 Entra 登录，GPT/image 均配置为系统托管身份。详见 [云端部署记录](../docs/WEBAPP-deployment.md)。以下“本机访问、CLI 图片认证、未配置生产认证”描述仅适用于本地开发入口；云端为授权用户共享工作区，指定来宾已授权并接受邀请，实际登录待验证。


# Qwen Studio 本地工作台

React 19 + TypeScript + Vite，Fastify + SQLite。面向单用户的纯手机开发界面；已接入真实 Codex 对话及 Azure image2 单图生成，启动本身不创建或启动云资源。

## 启动

使用 Node.js 22.23.2。当前开发机的隔离安装路径如下；其他机器使用自己的 Node 22 环境即可。

```bash
export PATH="$HOME/.local/share/node-v22.23.2-linux-x64/bin:$PATH"
cd /path/to/alex-mobile-codex-app/app
npm ci
WEB_PORT=5188 API_PORT=3188 APP_ORIGINS=http://127.0.0.1:5188,http://localhost:5188 npm run dev
```

打开 <http://localhost:5188>。当前开发机的默认 5173 端口已占用，因此使用 5188；不要停止不属于本项目的服务。若 5188 也被占用，选择其他空闲端口，并同步修改 `WEB_PORT`、`API_PORT` 和 `APP_ORIGINS`。

默认 `npm run dev` 使用网页 5173 / API 3001。前端通过 `/api` 代理到后端。两个进程仅监听 `127.0.0.1`；Ctrl+C 同时停止它们。

远程 VS Code 中，在“端口”面板将远端 **5188** 私有转发到本机，再打开对应的本机 URL。不需要转发 API 端口，不要配置公开端口或放开 NSG。如果本机映射端口改变，需要把新的精确 Origin 加入 `APP_ORIGINS` 并重启。手机布局已在浏览器模拟器验证，真实手机远程访问仍需后续的认证和 HTTPS 部署。

## Codex 与 OpenMontage

### 文件上传与附件通知

输入区回形针和素材库的“上传文件”支持多选图片、视频、文本及其他文件，单个文件最多 64 MiB，每批/每条消息最多 10 个。上传完成即写入项目素材库；从待发送附件移除只取消本次附加，不删除资料。可只发送附件，不要求额外文字；上传本身不触发模型调用。素材库可将已有资料重新附加到对话。

PNG/JPEG/WebP 做真实解码、方向修正、去除元数据并归一化为 PNG，生成 WebP 缩略图，最多 4000 万像素、拒绝多帧；其他格式保留原始字节。视频使用文件签名识别 MP4/WebM/MOV/Ogg，浏览器支持对应编解码器时可以播放，支持 Range 下载；不额外转码或抽帧，上传视频使用类型图标。文本、PDF 和其他文件使用文件图标与下载，不内联执行或渲染 HTML/SVG/脚本，没有文件执行功能或恶意软件扫描。

聊天请求只提交本轮选中的附件 ID。后端验证项目归属，初始 Codex 提示词只包含文件名、类型、大小及 `/api/assets/<id>/content` 位置，不包含正文或像素，也不把整个素材库附加到消息。位置是应用内受登录保护的相对下载地址，不是公开链接、SAS 或 Codex 容器路径。附件名称和内容视为不可信数据，不作为指令，不发给 Web Search。带本轮附件时不会静默将上一张生成图替代为编辑来源。

Codex 的 shell、直接文件系统和写文件能力仍关闭，改用官方 MCP 协议接入只读 `studio_attachments` 工具：列出允许的附件、分页读取 UTF-8 文本、查看最长边 1024 像素的图片预览、查看视频前 600 秒内指定时刻的单帧。文本每次最多 16000 个 UTF-16 代码单元，每轮最多 32 次附件工具调用。不解析 PDF/Office/压缩包，不执行脚本，不分析视频音轨。查看附件与编辑决策分离：上传图片可以作为单图编辑来源，但不支持图生视频。

每轮读取范围为本次选中的附件；本次未附加时，使用当前保留对话中最近一条带附件的用户消息，不包括整个素材库或其他项目。后端提前把允许的文件通过内部令牌保护的接口复制到 `/state/attachment-runs/<run-id>`，验证大小和 SHA-256 并封存白名单；模型只在主动调用工具后收到内容。临时副本在任务结束后删除，异常遗留目录超过一小时由清理任务删除，资料库原件保留。工具返回的内容会发送给 Codex 模型服务，并可能保留在 Codex 会话记录中；删除临时副本不等于删除模型历史。处理过程仅记录工具名和附件 ID，不记录正文或 base64。

附件 ID 随消息和重发保留；重建历史时仅恢复保留消息的附件元信息。下载继续经过既有应用登录授权、Host/Origin 检查和 no-store，普通文件强制 attachment、application/octet-stream、nosniff 与 sandbox。文件按 UUID 保存，客户端文件名不参与存储路径。当前为获授权用户共享项目，不是按用户隔离的私有空间。

### 默认参数

设置中的“默认比例”和“默认质量”只在当前对话未指定参数时使用。Codex 的结构化决策返回本次比例/质量，当前明确要求优先于默认值；服务端校验支持范围，不偷偷换比例或模型。实际尺寸和质量显示在处理过程，Azure 检查点或 GPU 任务账本保留质量。原图编辑仍保留来源尺寸，要求改画幅时澄清而不是静默忽略。

Azure image2 支持低/中/高质量，当前适配器尺寸限 1:1、3:2、2:3；其他比例需选择 Qwen 或调整需求。Qwen/H3 支持 1:1、3:2、2:3、4:3、3:4、16:9、9:16 的精确比例。GPU 质量档位是采样预算：Qwen 25/35/50 步，H3 20/30/40 步，不保证更多步数一定更好；H3 仍为 124 帧，非长视频或 2K。新画幅/质量通过离线工作流测试，GPU 停机期间未逐档真实生成。

项目列表每行的删除图标会打开确认。删除项目、对话、任务和素材索引；清理原图/视频及缩略图，失败项写入 SQLite 待清理表，下次启动或删除时重试。活动/排队任务和过时确认会拒绝删除；其他打开页面收到 SSE 删除事件后切换项目。运行时检查点、Codex 会话和已有备份不在此次清理范围，不应将此操作视为全系统隐私擦除。

### VM 管理

右上角 CPU 图标打开“VM 管理”，与设置并列，不再占用项目菜单。面板分列电源、ComfyUI 和计算计费状态，支持刷新；主操作随状态切换为启动或关闭并解除分配，重启单独显示。全部动作要求确认；解除分配停止计算资源计费，但磁盘继续计费。执行中、结果待核实或状态读取失败时禁止新操作，刷新不清除操作错误。没有定时任务、空闲自动关机、随生成自动启动或 Spot 自动重试。

本地使用 Git 忽略的 `.local/vm.json`，可用 `VM_CONFIG` 指定其他路径。示例（全部值必须替换，勿将真实配置签入）：

```json
{
	"subscription": "00000000-0000-0000-0000-000000000000",
	"resourceGroup": "example-gpu-rg",
	"name": "example-gpu-vm",
	"comfyUrl": "http://gpu.internal:8188",
	"auth": "cli",
	"cliPath": "/path/to/az"
}
```

服务端仅操作该固定 VM，前端不能指定资源 ID。CLI/托管身份 token 不传给浏览器。应用存在活动或排队任务时拒绝管理操作；GPU 队列非空时禁止关闭/重启，队列读取失败时必须额外确认中断风险。已提交动作异步追踪、持久化并按请求 ID 去重；重启后继续查询，不重发 Azure 请求。网络结果不明时标记“待核实”并阻止后续动作；需管理员核查 Azure 活动日志后，在停止后端的情况下人工处理操作账本，不能盲目重试。

仅支持单后端实例。配置了 `DATA_DIR` 的测试环境默认不启用 VM，除非显式设置 `VM_CONFIG`。云端需配置 `/home/` 下 `VM_CONFIG`、`auth: "managed-identity"`。所有通过应用现有 Entra 租户和用户授权校验的登录用户都可控制 VM，不再使用独立 `VM_ADMIN_USER_IDS`；匿名及未授权用户仍被拒绝。

2026-09-22 已按用户授权，为当前部署 Web App 的系统托管身份分配并回读两个自定义角色：目标 VM 范围的 `Qwen Studio VM Power Operator`（virtualMachines/read、instanceView/read、start/action、restart/action、deallocate/action），以及 GPU 资源组范围的 `Qwen Studio VM Operation Reader`（仅 Microsoft.Compute/locations/operations/read）。后者用于 Azure 异步完成状态查询，不授予资源组其他 VM 的电源操作、资源写入或权限管理能力。

本轮只变更上述 Azure RBAC，没有发布新镜像、启用云端 VM 配置或扩展 Web App 至 GPU 的私网连接。私网仍是云端 ComfyUI 就绪/队列查询和 GPU 生成的前置条件。真实状态读取已在本地验证，启停仅通过 mock/API/浏览器测试，没有为验收启动收费 VM；云端托管身份实际操作仍待发布后验证。

### 本地 GPU 接入

新增模型选择及 GPU 工具已在本地验收，尚未发布到云端。右上角设置分别选择图片模型（默认 Azure image2，可选 Qwen Image 2.1）和视频模型（默认不启用，可选 MiniMax H3）。Codex 继续根据对话决定是否调用工具，不能自行改选模型；模型不可用时失败，不回退到其他服务。选择随请求持久化，重新发送保留该条请求的模型。

在仓库根目录将 `COMFYUI_SERVER_URL` 设置为已授权的私网 ComfyUI URL，再运行 `docker compose up -d --build runtime`。不要将 ComfyUI 暴露到公网。容器重建时需要再次提供该变量，普通容器重启会保留配置。云端启动器支持同名可选环境变量，但现有 Web App 尚未配置 GPU 私网路径，本轮未修改云资源。

ComfyUI 原生节点需支持 Qwen Image 2.1 与 MiniMax H3。固定文件名见 [GPU 工具](../runtime/comfy_media.py)，所有权重位于 GPU 持久数据盘。健康接口检查节点与文件名，不代表实时生成一定成功；Spot 驱逐、GPU 忙或缺文件均可能导致任务失败。

- Qwen Image 2.1：BF16 权重，单张生成；1:1 / 3:2 / 2:3 对应 1024×1024 / 1536×1024 / 1024×1536。Codex 可从候选中选择上传图或保留生成图编辑，沿用原尺寸、校验来源哈希，另存新图。动态图片输入使用 ComfyUI v3 的 `images.image_1`。新选图协议已本地验证；GPU 路径未在本轮实际生成。
- MiniMax H3：BF16 推理权重，默认 20 步，124 帧，24fps，约 5.17 秒双声道 MP4。当前精确画幅：1:1 为 640×640、3:2 为 768×512、4:3 为 768×576、16:9 为 1024×576，竖向交换宽高；此前验收视频 832×480 属于旧预设。不是完整托管版 2K 流水线，不支持上传参考视频、长视频或视频编辑。
- OpenMontage 保存原生检查点；提交前写入任务账本，记录 ComfyUI prompt ID，结果校验后入库。GPU 忙时不提交，不自动重试。停止仅中止等待，已提交的 GPU 任务可能继续运行，重试前必须核查。没有中断结果自动导入功能。
- 视频可在对话和素材库播放、下载；后端支持 MP4 MIME、单段 HTTP Range 与缩略图，云端存储实现也支持 MP4，但云端端到端未验收。
- Qwen 仅用于研究评估；H3 本轮限已确认符合社区许可的非商业测试，存在地域限制。向第三方开放前须另行核查许可、访问控制和使用条款。GPU 运行时间、磁盘和 Codex 调用可能计费。

真实本地验收已完成 Qwen 生图、原图编辑（修正动态输入键名后一次重试）、H3 生视频、真实检查点与素材回收。H3 已验证非空画面、运动、非静音双声道、浏览器播放及拖动。手动验收脚本支持 `IMAGE_MODEL=qwen-image-2.1`、`VIDEO_MODEL=minimax-h3`、`EXPECT_MODEL` 和 `RATIO`，会真实调用服务，不加入自动测试。以下旧版本验收记录中“视频未接入”等描述仅指旧 Azure-only 版本。

验收后 GPU 连接断开，Azure 回读电源状态为 deallocated；未确认具体回收事件，也未自动重启。已有素材保存在应用与运行时存储中，不依赖 GPU 在线即可播放下载。最终 43 项自动测试（11 后端、18 手机浏览器、5 Node 运行时、9 Python 工具）、构建及 lint 均通过。

本机已配置并启动独立 `qwen-studio-runtime-1` 容器，网关仅映射 `127.0.0.1:3199`。Codex CLI/SDK 固定 0.155.1，OpenMontage 固定提交 `08e2151fa02de28a5d6a312b3d575692bf147ad7`。运行时以非 root、只读根文件系统运行，不挂载 Docker socket，不使用机器上其他项目的容器或凭证。

首次配置时，先在终端设置 `AZURE_MODEL_SUBSCRIPTION`、`AZURE_MODEL_RESOURCE_GROUP`、`AZURE_GPT_ACCOUNT`、`AZURE_GPT_ENDPOINT`、`AZURE_GPT_DEPLOYMENT`、`AZURE_IMAGE_ENDPOINT`、`AZURE_IMAGE_DEPLOYMENT`。可用 `AZURE_CLI_PATH` 指定 CLI 路径，默认在 PATH 中查找 `az`。脚本只读取已授权模型账户的凭据，不创建云资源；缺变量时拒绝执行。已有配置时跳过 `configure.mjs`，它会拒绝覆盖。

```bash
node runtime/configure.mjs
docker compose up -d --build runtime
```

配置脚本通过本机 Azure CLI 获取 GPT 服务密钥，保存到被 Git/构建上下文忽略的 `.local/services.json`（目录 0700、文件 0600），不打印密钥。容器以只读 secret 挂载。前端不接触凭证；后端启动时读取配置，改动后需重启后端和容器。缺少配置时应用仍可保存离线需求。设置 `DATA_DIR` 时默认禁用 Agent，除非显式设置 `RUNTIME_CONFIG`；测试因此不会意外调用付费服务。

当前使用订阅 1 的两个部署：

| 用途 | Foundry 账户 / 部署 | 区域与认证 |
| --- | --- | --- |
| Codex 决策 | `example-gpt-account` / `gpt-5.4` | southeastasia，服务端 API key |
| 图片工具 | `example-image-account` / `gpt-image-2` | eastus2，Entra token |

图片账户保持 `disableLocalAuth=true`，未开启密钥认证。自动识别和显式图片请求在提交前，后端通过 `$HOME/.local/share/qwen-azure-cli/bin/az` 获取短期 Cognitive Services token，只经内存传给工具，不写入会话或检查点。自动识别时获取 token 失败仍可对话，但图片动作会在调用图片 API 前报错。登录过期需在本机 Azure CLI 重新登录；不在聊天中输入密码或 token。Codex 不接收图片 token，没有 shell、写文件或自行安装工具的权限；仅新增下面的原生 Web Search。

Web Search 随固定版本 Codex CLI 一起安装，运行时设为 `webSearchMode: 'live'`，不是额外的浏览器或第三方搜索插件。保留 `shell_tool=false`、`apply_patch_freeform=false`、只读沙箱及 `approvalPolicy=never`，不新增 MCP、Skill 安装或系统网络执行权限。指令要求引用实际查阅的 HTTPS 来源、将网页视为不可信数据、不把凭证或私人历史作为搜索词；这是模型行为约束，不是独立的数据防泄露过滤器。

2026-09-22 本地真实搜索 Microsoft Edge PWA 文档成功，收到三条已完成的 SDK `web_search` 事件，回复包含 Microsoft 官方来源，未生成图片。事件在“处理过程”中显示；已随 `20260922-web-search-dc11780` 发布，云端托管身份下搜索未验收。仓库根目录可手动运行 `WEB_SEARCH_TEST=1 node runtime/smoke.mjs`：必须有搜索完成事件、来源链接且无图片才通过，禁止与出图验收开关混用。该测试调用真实模型/搜索，可能计费，不属于默认离线测试。

每个项目复用一个 Codex thread，SQLite 保存 thread ID、消息和运行状态；Codex 自身会话、运行结果及 OpenMontage 检查点保存在 Docker 命名卷 `qwen-studio_runtime-state`。图片工具继承上游 `BaseTool`，返回 `ToolResult` 并写入标准 `asset_manifest` 检查点，不是完整 OpenMontage 视频流水线。上游源码位于容器 `/opt/openmontage`，遵循其 AGPL-3.0 许可，分发或提供网络服务前需评估对应义务。

手机端统一提交 `auto`，由 Codex 结合会话输出结构化的对话、图片或视频意图，不再手动选择模式。指令要求只有明确要求现在出图才执行图片工具，讨论、编写提示词和否定出图应仅对话，意图不清时先询问；模型判断并非绝对可靠，也不替代审批。视频尚未接入，返回明确说明且不以图片替代。API 保留显式 `chat`（禁止图片工具）和 `image` 模式。图片固定 `n=1`、`quality=low`，1:1 / 3:2 / 2:3 分别输出 1024×1024 / 1536×1024 / 1024×1536。全局串行、最多 10 条待处理，不自动重试或更换服务。GPT 和图片均可能收费，金额未核算，不把未知费用显示为零，应以 Azure 账单为准。停止请求不保证撤回已送达 Azure 的调用。

已实际验证：文字回复、同项目上下文、1024×1024 PNG 回收及 OpenMontage 检查点、空闲容器重启后同一 thread 恢复，以及 `auto` 下构图讨论仅对话、视频请求明确拒绝且无图片。自动图片决策通过离线测试，未再次真实出图；另外两种尺寸尚未实际计费验证。`node runtime/smoke.mjs` 是手动付费验收脚本，不属于默认测试；`IMAGE_TEST=1` 会请求一张真实图片，`AUTO_TEST=1` 允许自动判断并可能出图，不要把它们加入自动测试。`NO_IMAGE=1` 仅事后断言，不能阻止调用或费用。

## 已实现

已随 `20260922-web-search-dc11780` 发布：Codex 可决定 `edit`，仅编辑保留对话中本轮之前最近一张已完成生成图。工具读取存储中的原始 PNG，通过 Azure multipart 编辑接口上传；输出另存为新素材，记录来源 ID/哈希并保留原尺寸。清理掉的重发分支图片即使仍在素材库也不会被选中。Codex 只接收来源元数据，原始像素只交给图片工具；无原图时澄清，不静默重新生成。对话按轮次排列，时间左置，重发/复制右置，出图和修改均显示持续加载状态。

后续改动已随 `20260922-assets-96762a2` 发布，移除“后端固定选上一张图”：Codex 同时决定 `action=image/edit/chat/video` 与 `sourceAssetId`。编辑必须指定候选素材 ID；生成新图必须为 null，不因有附件或已有图片而自动变成编辑。候选仅包含当前消息附件和保留对话中的上传图、已完成生成图，按首次出现顺序提供名称、尺寸及关联消息，不默认选任何一张。重发清理的分支、未来消息、未附加的资料库图片、其他项目及非图片不在候选中；库内图片需重新附加才能被引用。目标不明确时由 Codex 澄清，不静默替换原图或回退生成。

后端先发送候选元数据，Codex 选定后运行时通过 `needsSource/sourceAssetId` 请求对应原图；应用再次检查范围、大小、SHA-256，再通过内部令牌保护的 `/runs/:id/source` 传送原始 PNG。运行时复核 ID、哈希与尺寸后才调用现有编辑工具，保存来源链和新素材，保留原件。原图交付等待最多 60 秒并支持取消；没有自动付费重试。一次编辑只支持一张原图，原图最多 32 MiB；Azure 当前编辑输出仍限 1024×1024、1536×1024、1024×1536 且保留原尺寸，不会静默缩放。真实 Azure 双图上传测试已确认 Codex 选择第一张而非最后一张，按要求修改颜色，两份原件哈希不变。

2026-09-22 本地真实生成后编辑已验证蓝杯变红杯、同一 thread、1024×1024、原图字节不变。生成阶段曾因新增检查点字段不兼容而在出图后失败，修复并离线恢复原图后仅执行一次编辑；无重复生成，详细记录见部署文档。手动 `EDIT_TEST=1 node runtime/smoke.mjs`（仓库根目录）会收费生成及编辑各一张，不进入自动测试；`PROJECT_ID` 与 `GENERATION_RUN_ID` 可指定已完成且已导入的原图，只执行编辑。云端托管身份编辑未验收。

- 用户消息旁可重新发送：确认后清理其后的对话与任务，保留所选消息、之前的历史及素材库图片；新 Codex thread 仅使用保留历史，运行尚未结束时禁止清理。重发幂等并检测确认期间的对话变化；可能再次计费，旧运行时检查点不物理擦除。
- 项目创建、搜索、切换、重命名；SQLite 持久化需求、任务及素材元数据。
- 多文件上传、图片缩略图/缩放、视频播放、文件下载和再次引用。单文件最多 64 MiB，每批及每条消息最多 10 个附件；图片最多 4000 万像素，拒绝多帧 PNG/JPEG/WebP。
- 上传时实际解码图片、修正方向、去除元数据并归一化为 PNG，保留透明通道。因此下载文件不是原始上传文件的逐字节副本。
- Codex 用户/助手消息、会话标识、排队/执行/失败/停止状态、Azure 生成素材的预览及下载、任务页运行记录。SSE 同步状态和最终回复，不是逐 token 流式输出。
- 每次请求附带默认折叠的“处理过程”：保存并同步 Codex 会话/处理阶段、SDK 返回的公开推理摘要与计划（若有）、图片提示词和 OpenMontage 工具阶段。展开状态在当前视图更新中保留，刷新后默认收起。每次最多保留最近 200 条记录、单条详情最多 6000 字符；不显示原始工具参数、凭证或模型内部载荷。服务不一定返回摘要；旧会话未记录的过程不会补造。
- 未配置 Agent 时保存需求及画幅比例，任务进入 `waiting_service`；旧任务可取消、筛选和重新编辑，但不会因接通服务而自动执行。
- 同一次提交的网络重试使用幂等请求 ID；SSE 更新当前项目并在重连时恢复快照。
- 纯手机全屏界面，无 PC 布局或桌面预览框。顶部为项目菜单、项目名、同步圆点和右上角设置，不再切换页面；素材库、任务记录和服务状态从项目菜单打开弹层，主对话始终保留，关闭后继续编辑原草稿。素材库集中预览和下载。底部约 120px 输入区：上层两行文字（自动增高至 100px），下层附件、发送及停止，无模式选择。发送按钮可见色块 32px，点击范围 44px。图片比例、固定单张低质量和计费说明集中在设置里。错误和默认折叠的处理过程保留，主要触控区域至少 44px。使用 Visual Viewport 同步可视高度并适配安全区；真实 iOS/Android 键盘行为尚待实机验证。

没有模拟 AI 对话或假生成图。首页两张照片明确属于参考素材，点击后才会上传到项目。

## 数据与边界

默认数据目录为当前工作目录下的 `.data/`，可通过 `DATA_DIR` 改写。数据库是 `studio.sqlite`，图片在 `images/`，默认不进入版本控制。浏览器只缓存选中的项目 ID，业务数据位于后端。

备份时先停止应用和容器，再复制整个数据目录及 `qwen-studio_runtime-state` 命名卷，避免遗漏 SQLite WAL、图片及 Codex 会话；凭证单独安全保管。不要执行 `docker compose down -v`，它会删除运行时历史。删除应用数据目录会丢失全部项目。测试使用系统临时目录，截图和 trace 在 `test-results/`，不写入日常数据目录。

当前仅有本机 Host/Origin 检查，**没有用户认证，不是可公开部署的服务**。本机可访问 API 的进程可以读取全部项目；前端开发服务器和 `vite preview` 也不是生产部署方案。`npm run build` 只产出前端静态文件，不打包后端；`npm run preview` 不提供完整 API。

当前支持文字、附件元信息通知、按需只读附件工具及 Codex 自主选择原图编辑；上传文件可以入库、预览或下载，初始提示词只接收附件及候选元信息，内容经读取工具或执行编辑按需传输。尚未实现 PDF/Office 内容解析、多图合成/蒙版、完整视频剪辑流水线/审批/预算治理、完整素材版本管理、新建或重置 thread 的 UI、用户配额及大规模分页。生产 Entra/HTTPS/PWA 仅适用于云端入口。附件读取和上传图选择编辑已发布并本地真实验收，云端托管身份端到端验证仍待完成。

进行中的调用在后端/容器重启或连接结果不明时标为“结果待核实”，不会自动重发。当前没有中断结果自动对账导入功能；远端可能已完成并计费，需要人工检查运行记录和检查点后再决定下一步。已完成会话的重启恢复通过，不代表执行中断能无损恢复。

GPU 历史事项见 [临时交接文档](../docs/TEMP-azure-handoff.md)，最新状态以上面的本地 GPU 接入说明为准。模型许可限制继续适用，不能把“非收费”自动视为允许的使用。

## 验证

```bash
npm run build
npm run lint
npm test
npx playwright install chromium
npm run test:e2e
```

后端测试覆盖幂等提交、重启持久化、Agent 串行/thread 传递、图片导入、停止竞态、结果不明不重试、Origin/Host 校验和跨项目引用限制。浏览器测试使用独立的 5198/3198 端口及临时数据库，运行标准手机、小屏手机两套配置，覆盖 320px 长标题、上传/预览/下载、任务取消、SSE、服务断线状态、可视高度缩小时输入与导航互不遮挡，以及使用明确测试夹具的 Codex 回复/Azure 素材/运行记录。默认测试不调用 Azure。

运行时决策测试使用镜像中的依赖，从仓库根目录执行，不访问网络或凭证：

```bash
docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges -v "$PWD/runtime:/opt/studio/runtime:ro" --entrypoint node qwen-studio-runtime --test runtime/decision.test.mjs runtime/attachments.test.mjs
```

当前精简 Linux 主机的 Chromium 依赖已解包到用户目录，运行浏览器测试前另设：

```bash
export LD_LIBRARY_PATH="$HOME/.local/share/qwen-browser-libs/usr/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export FONTCONFIG_PATH="$HOME/.local/share/qwen-browser-libs/etc/fonts"
export FONTCONFIG_FILE="$FONTCONFIG_PATH/fonts.conf"
npm run test:e2e
```

其他主机需要自行准备 Playwright 系统依赖及中英文字体；以上用户目录路径不可直接移植。Node 22 的 `node:sqlite` 会输出实验性 API 警告，当前是已知的开发期依赖。

## 素材来源

内置照片来自 Unsplash，仅用作真实参考素材，不是 Qwen 的生成结果。使用遵循 [Unsplash License](https://unsplash.com/license)，不代表对照片中任何第三方权利的额外授权。

- 室内：<https://images.unsplash.com/photo-1600210492486-724fe5c67fb0>
- 静物：<https://images.unsplash.com/photo-1494438639946-1ebd1d20bf85>

照片已存放于 `public/`，无需运行时访问 Unsplash。字体使用 Google Fonts 的 DM Sans / Noto Sans SC，浏览器会向字体服务请求资源；无法访问时使用本地字体回退。
