# Copilot Mobile Studio

独立重建的手机创作工作室。采用 Copilot SDK、Azure 身份、AHP 1.1 和自建 React
界面，不依赖旧 App 代码、数据库或部署配置。

## 当前能力

- 管理员创建账号、密码登录、Cookie 会话、CSRF 和用户隔离。
- 快捷指令填入可编辑草稿；用户发送后创建会话并开始对话。
- 官方 AHP 客户端 + 自建最小 Host，流式消息、历史持久化、断线快照恢复。
- 图片、视频两个真正注册到 Copilot 的 Skill；用户只能选择启用或停用。
- 管理员通过 JSON 配置远程 MCP 工具；工具白名单、Skill 过滤和逐次执行确认。
- 每用户独立 Copilot 子进程、运行目录及会话状态。
- 停止、重复操作去重、服务重启后的显式中断，不自动重发付费任务。

**本版本先完成对话基础。没有内置图片/视频生成后端、上传或 GPU 部署。**
Skill 负责业务指导，不是模型本身。未来将图片模型包装为 MCP 工具即可接入，
不假定 SDK 提供了当前开发环境里的同名图片工具。

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
$securePassword = Read-Host "New account password (12+ characters)" -AsSecureString
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
服务默认只监听本机；不允许无 HTTPS 的公网 Origin。

## Azure 对话模型

在 `.env.rebuild` 中配置：

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

本地开发可以显式使用：

```dotenv
AZURE_AUTH_MODE=azure-cli
```

然后在本机执行 `az login`。生产模式禁止 CLI 身份；任何模式都不自动回退到 API
Key、其他账号或其他模型。网页登录账号和 Azure 模型身份是两个独立概念。

SDK 使用原生 runtime，安装时需要允许 npm 可选平台依赖。
`@microsoft/copilot-sdk` 固定为 `2.0.0`，AHP 固定为 `1.1.0`。
BYOK、Skill provider 等部分上游接口仍标为 experimental，升级前必须验证。

## 工具配置

复制 [工具配置示例](tools.example.json) 为被 Git 忽略的 `tools.json`，替换为实际
**HTTPS MCP 服务**地址，并通过环境变量提供 `tokenEnv` 指定的凭据。修改后重启服务。
不要直接填写 Azure 图片 REST 端点：它需要先被一个 MCP 服务封装。

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
- 调用允许的 MCP 工具仍需要页面逐次确认；批准一次不等于永久批准。
- `X-Studio-User-Id` 由服务端发送；MCP 服务必须验证其服务凭据并实施用户/素材权限。
- MCP 服务自己负责付费任务幂等、持久队列、停止与结果对账。不能把 AHP 的重连视为
  对生成任务的 exactly-once 保证。
- 本版仅展示对话和工具执行状态，不自动加载外部图片、不展示媒体生成成功的假结果。

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

测试包括真实 Copilot runtime 连接本机 Responses API 夹具、流式输出和恢复会话。
夹具只存在于测试，不是产品在配置失败时的备用回复。
这验证 SDK/协议接线，不代表 Azure 实际身份或真实图片/视频服务已验收。

## 生产运行与数据

先构建，在 `.env.rebuild` 中设置 `NODE_ENV=production`、HTTPS `APP_ORIGIN`、
匹配的监听地址、模型配置，以及独立持久目录 `DATA_DIR`，再执行 `npm start`。
在 HTTPS 反向代理后运行，同源转发 HTTP 和 `/api/ahp` WebSocket。
目前不信任代理身份头；登录限速按直接连接 IP 计算，反向代理后为保守共享限速。

持久目录包括 SQLite 和每用户 runtime 会话，两者都要备份。当前仅支持单实例和
本地持久磁盘。进程隔离不是安全沙箱，生产仍需最小文件/网络权限及容器隔离。

## 分支说明

本分支从空历史开始。原分支没有改写。切换分支后可能看到 Git 忽略的旧目录，
它们没有被新应用导入，也不属于新应用发布内容；不应删除其中的本地数据。
