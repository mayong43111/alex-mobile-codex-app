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

2026-09-22 本地真实生成后编辑已验证蓝杯变红杯、同一 thread、1024×1024、原图字节不变。生成阶段曾因新增检查点字段不兼容而在出图后失败，修复并离线恢复原图后仅执行一次编辑；无重复生成，详细记录见部署文档。手动 `EDIT_TEST=1 node runtime/smoke.mjs`（仓库根目录）会收费生成及编辑各一张，不进入自动测试；`PROJECT_ID` 与 `GENERATION_RUN_ID` 可指定已完成且已导入的原图，只执行编辑。云端托管身份编辑未验收。

- 用户消息旁可重新发送：确认后清理其后的对话与任务，保留所选消息、之前的历史及素材库图片；新 Codex thread 仅使用保留历史，运行尚未结束时禁止清理。重发幂等并检测确认期间的对话变化；可能再次计费，旧运行时检查点不物理擦除。
- 项目创建、搜索、切换、重命名；SQLite 持久化需求、任务及素材元数据。
- 参考图片上传、缩略图、全图缩放、下载和再次引用。单次一张，PNG/JPEG/WebP，最多 12 MiB、4000 万像素，拒绝多帧图片；每条需求最多 10 张参考图。
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

当前只支持文字提交及上述上一张生成图编辑；上传参考图可保存和预览，但带附件的 AI 提交会明确拒绝，不会静默忽略附件。尚未实现上传参考图编辑、多图/蒙版、ComfyUI/Qwen Worker、完整视频流水线/审批/预算治理、完整素材版本管理、新建或重置 thread 的 UI、用户配额及大规模分页。生产 Entra/HTTPS/PWA 仅适用于云端入口。

进行中的调用在后端/容器重启或连接结果不明时标为“结果待核实”，不会自动重发。当前没有中断结果自动对账导入功能；远端可能已完成并计费，需要人工检查运行记录和检查点后再决定下一步。已完成会话的重启恢复通过，不代表执行中断能无损恢复。

GPU 事项见 [临时交接文档](../docs/TEMP-azure-handoff.md)。当前阶段不安装 GPU 软件、不恢复云端重试。模型研究许可限制继续适用，不能把“非收费”自动视为允许的使用。

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
docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges -v "$PWD/runtime:/opt/studio/runtime:ro" --entrypoint node qwen-studio-runtime --test runtime/decision.test.mjs
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
