# hhtools Electron 远程 GPU 模式实施方案

## 1. 结论

推荐把桌面端做成“双运行模式”，而不是用远程模式替换现有本地模式：

- **Local**：保留当前行为，由 Electron 启动并监管本机 Python sidecar。
- **Remote GPU**：Electron 不启动本机 Python；本地打包的 Vue + Three.js GUI 通过 SSH 隧道连接 Linux GPU 服务器上的无界面 hhtools 计算服务。

两种模式共享同一套本地 GUI，只替换计算连接；服务器不负责提供 Electron 的 Renderer。

远程模式的首选网络方案是：

```text
Windows laptop
┌────────────────────────────────────────────────────────────┐
│ Electron                                                   │
│  ├─ BrowserWindow：本地 Vue + Three.js                     │
│  ├─ Local Gateway：静态资源 + /api 反向代理                │
│  ├─ Connection Profile / Credential Store                  │
│  └─ Local Sidecar 或 SSH Tunnel Supervisor                 │
└───────────────┬────────────────────────────────────────────┘
                │ 只有 API / SSE / 上传 / 下载经过隧道
                │ SSH local forwarding（加密）
                ▼
Linux GPU server
┌────────────────────────────────────────────────────────────┐
│ 127.0.0.1:8009（不暴露公网）                               │
│ Headless FastAPI + persistent jobs + artifact store        │
│            ↓                                               │
│ hhtools / Torch / Newton / MuJoCo / CUDA / GPU              │
└────────────────────────────────────────────────────────────┘
```

这样，新笔记本只需要安装 Electron 客户端和配置 SSH key，不需要安装 Python、CUDA、Torch、Newton 或 MuJoCo。BrowserWindow 只访问本机 Local Gateway；Gateway 提供打包好的 GUI，并把 `/api` 代理到选中的本地或远程 backend。因此 Vue 仍使用同源相对 API，不需要 CORS，也不会把 token 暴露给 Renderer。

## 2. 为什么不直接把 FastAPI 监听到公网

不建议把现有 `hhtools web` 改成 `0.0.0.0` 后直接开放端口，原因包括：

- 当前应用按单用户、本机优先的假设设计，文件上传、路径注册、任务状态和结果下载都不是公网服务边界。
- 直接开放会立即引入 TLS、账户登录、限流、CSRF、审计、权限隔离和漏洞响应等要求。
- Retarget 与批处理会消耗大量 GPU/CPU/磁盘资源，未授权请求的风险远高于普通网页。
- 服务器通常已经有成熟的 SSH 身份认证、密钥管理、堡垒机和访问日志。

第一版通过 SSH 只转发服务器的 loopback 端口。FastAPI 不对 LAN 或公网监听，SSH 负责链路加密与服务器身份认证，应用 token 负责防止本机其他网页或进程借用隧道调用 API。

## 3. 用户体验

### 3.1 首次连接

Electron 首次启动显示一个不依赖 Python 的本地连接页：

1. 选择 `Local` 或 `Remote GPU`。
2. Remote 模式填写：配置名称、SSH host、SSH port、用户名、远端 hhtools 端口。
3. 私钥优先交给系统 `ssh-agent`；不把私钥内容复制进应用配置。
4. 输入服务器签发的一次性配对 token。
5. 点击“测试连接”。
6. 测试依次展示 SSH、隧道、认证、hhtools 版本、CUDA/GPU 和可写目录状态。
7. 成功后进入正常工作区。

连接配置示例：

```json
{
  "id": "lab-4090",
  "name": "实验室 4090",
  "mode": "ssh",
  "sshHost": "4090-10",
  "sshPort": 22,
  "sshUser": "nora",
  "remoteHost": "127.0.0.1",
  "remotePort": 8009
}
```

这个 JSON 不保存 token、密码或私钥。token 使用 Electron `safeStorage` 加密后保存在用户数据目录；SSH 私钥由 OpenSSH/ssh-agent 管理。

### 3.2 日常启动

1. Electron 启动 Local Gateway，并立即加载安装包内的 Vue GUI。
2. Main 读取上次使用的 profile，并选择 Local 或 Remote backend adapter。
3. Remote 模式选择随机 tunnel 端口，启动 SSH 隧道并等待 `ExitOnForwardFailure` 成功。
4. Main 携带应用 token 请求 `/api/health` 和 `/api/desktop/bootstrap`。
5. 版本兼容且 GPU 服务可用后，Gateway 将 `/api` 指向该 backend，GUI 进入工作区。
6. 只有 API、SSE、上传和下载经过隧道；HTML、CSS、JavaScript 与 Three.js 均来自本机安装包。
7. 断线时本地 GUI 保持可用并显示重连层；重连成功后恢复任务状态。

建议的隧道命令形态如下，实际由 Electron Main 调用，不要求用户手输：

```powershell
ssh.exe -NT `
  -o ExitOnForwardFailure=yes `
  -o ServerAliveInterval=15 `
  -o ServerAliveCountMax=3 `
  -L 127.0.0.1:<local-port>:127.0.0.1:8009 `
  nora@4090-10
```

## 4. 客户端改造

### 4.1 抽象统一的 BackendConnection

把当前 `startDesktop()` 中“解析 Python、启动 sidecar、等待 health”的固定流程拆成接口：

```ts
interface BackendConnection {
  readonly mode: 'local' | 'remote-ssh'
  start(): Promise<BackendSession>
  stop(): Promise<void>
  restart(): Promise<BackendSession>
  snapshot(): BackendConnectionSnapshot
  onStateChange(listener: (state: BackendConnectionSnapshot) => void): () => void
}

interface BackendSession {
  upstreamOrigin: string
  requestSecret: string
  protocolVersion: number
  serverVersion: string
}
```

实现两个 adapter：

- `LocalSidecarConnection`：包装现有 `SidecarSupervisor`，行为不变。
- `SshRemoteConnection`：监管 `ssh.exe`、本地转发端口、health check、重连与退出清理。

建议目录：

```text
desktop/src/main/backend/
  backend-connection.ts
  local-sidecar-connection.ts
  ssh-remote-connection.ts
  local-gateway.ts
  connection-profile-store.ts
  credential-store.ts
  compatibility.ts
```

### 4.2 连接状态机

远程连接至少需要这些显式状态：

```text
idle -> connecting-ssh -> tunnel-ready -> authenticating -> ready
                      \-> failed
ready -> reconnecting -> ready
ready -> disconnected
* -> shutting-down -> stopped
```

不能把“SSH 子进程已经启动”当成服务可用；与当前 sidecar 一样，必须等认证后的 health check 成功才显示工作区。

重连策略：第一次 1 秒，之后 2、5、10、20 秒退避，最大 30 秒；用户可立即手动重试。关闭 Electron 时要终止 SSH 进程树，但不能终止服务器上的长期任务。

### 4.3 Local Gateway 与连接页

Electron 安装包应包含 Vite 构建的 Vue 静态资源。Main 启动一个只绑定 `127.0.0.1` 随机端口的 Local Gateway：

- `/`、`/assets/*`：读取安装包内的 Vue + Three.js 静态资源。
- `/api/*`：代理到当前 `BackendSession.upstreamOrigin`。
- SSE、Range 下载和 multipart 上传采用流式转发，避免把大文件完整缓存在 Electron 内存。
- Gateway 在转发层注入 backend token，过滤 hop-by-hop headers，并限制目标只能是当前已验证的 backend。

连接配置是本地 Vue GUI 的一个启动状态/设置页面，功能包括：

- Local / Remote 模式选择。
- profile 新建、编辑、删除和测试。
- 主机指纹首次确认。
- SSH 与 API 错误诊断。
- 打开日志目录。

BrowserWindow 始终 `loadURL(gateway.origin)`，切换 Local/Remote 时不更换 Renderer 来源，只更新代理目标与连接状态。服务器通过 `protocol_version` 声明 API 兼容性；GUI build 版本由 Electron 安装包和自动更新管理。

### 4.4 请求凭据仍留在 Main

沿用当前 `configureDesktopSession()` 的原则：

- Renderer 不读取 token。
- Renderer 只访问 Local Gateway；Main 只向当前 backend upstream 注入 header。
- 页面导航、弹窗、外链和权限继续采用当前 allowlist。
- 日志、错误弹窗、runtime state 和 IPC 返回值都不得包含 token。

建议远程请求使用独立 header，例如 `X-HHTools-Remote-Token`，避免把长期设备 token 与本地每次启动的 session secret 混为一谈。

## 5. 服务器改造

### 5.1 新增 remote server 入口

保留：

```text
hhtools web
hhtools.cli.desktop_sidecar
```

新增建议命令（这是待实现的接口，不是当前已有命令）：

```bash
uv run hhtools remote serve \
  --host 127.0.0.1 \
  --port 8009 \
  --source /data/hhtools/motions \
  --save-dir /data/hhtools/results \
  --cache /data/hhtools/cache
```

Remote server 与 desktop sidecar 的区别：

- 服务长期运行，不随 Electron 退出。
- 只提供 API、任务和 artifact，不承担 Electron GUI 静态资源发布。
- 支持多个可撤销的设备 token，而不是单个进程内 session secret。
- 活跃与历史任务持久化。
- 只接受服务器侧固定 loopback Host；客户端随机端口终止在 Local Gateway/SSH tunnel 一侧。
- 仍只绑定服务器 `127.0.0.1`。

### 5.2 设备配对与 token

新增建议命令：

```bash
uv run hhtools remote token create --name nora-laptop
uv run hhtools remote token list
uv run hhtools remote token revoke <token-id>
```

实现要求：

- 只在创建时显示一次完整 token。
- 服务端只保存 Argon2id/scrypt 哈希、token id、设备名、创建时间和最后使用时间。
- 每次请求使用 constant-time 比较。
- token 可单独撤销，不影响其他设备。
- token 不进入 URL、命令行、日志、任务配置或导出文件。
- 后续若支持多人，共享 token 必须升级为用户身份与项目权限，不能继续依赖“一个服务器一个 token”。

### 5.3 Host、Origin 与 CSP

当前桌面 guard 精确匹配 `127.0.0.1:<sidecar-port>`。Remote server 继续只监听服务器 loopback，remote guard 应单独实现：

- 只接受服务器配置的 `Host`，例如 `127.0.0.1:8009`，不接受任意域名。
- Local Gateway 不转发浏览器 `Origin`，并重建受控的 upstream headers。
- 每次请求必须同时有有效 remote token。
- Local Gateway 为 GUI 保持 CSP、`nosniff`、`DENY` frame policy 和 no-referrer。
- 不把 remote 模式的宽松 Host 规则复用到本地 sidecar；两种 guard 分开测试。

### 5.4 能力与版本握手

新增：

```http
GET /api/desktop/bootstrap
```

建议返回：

```json
{
  "protocol_version": 1,
  "server_version": "0.1.0",
  "ui_build_id": "2026-08-27",
  "mode": "remote",
  "capabilities": {
    "retarget": true,
    "r2r": true,
    "dataset_analysis": true,
    "resumable_upload": false,
    "persistent_jobs": true
  },
  "gpu": {
    "available": true,
    "name": "NVIDIA GeForce RTX 4090",
    "memory_total_mb": 24564
  }
}
```

Electron 壳声明自己支持的 `protocol_version` 范围。协议不兼容时停在连接页并给出升级哪一端的明确提示，不能带着未知 API 继续运行。

## 6. 文件与数据流

远程模式最容易被低估的部分不是计算，而是文件边界。建议分两条路径。

### 6.1 临时小文件

动作、URDF、mesh 和单条轨迹继续使用现有 multipart API，通过 SSH tunnel 上传。服务端必须：

- 在解析前限制单请求和会话总大小。
- 保留相对目录，同时拒绝 `..`、绝对路径、符号链接逃逸和压缩包路径穿越。
- 用内容 hash 去重，断线后避免重复上传相同文件。
- 所有临时文件写入当前 remote session/job 的隔离目录。

### 6.2 大型数据集

AMASS、Motion-X 等大型数据集不应每次从笔记本拖拽上传。增加服务器资源库注册：

```bash
uv run hhtools remote library add /data/datasets/AMASS --name AMASS
```

UI 只能浏览管理员预先允许的 roots，不能提供任意服务器文件系统浏览器。API 返回逻辑名称、相对路径、大小、mtime 和内容 hash，不暴露不必要的宿主机绝对路径。

第二阶段再增加分块/可恢复上传：

```text
POST /api/uploads                 创建上传
PUT  /api/uploads/{id}/parts/{n}  上传分块
POST /api/uploads/{id}/complete   校验 hash 并提交
DELETE /api/uploads/{id}          放弃上传
```

### 6.3 结果下载

- 小型 CSV/PKL 继续直接下载。
- ZIP、分析缓存和批量产物先保留在服务器 artifact store。
- Job 返回 artifact id、大小、hash、创建时间和过期时间。
- Electron 下载到临时文件，校验 hash 后再原子移动到用户选择的位置。
- 断线时支持 Range 请求续传，避免几 GB 的结果重新下载。

## 7. 任务持久化与断线恢复

Remote server 不能沿用“Electron 关掉，Python 也退出”的任务生命周期。最低要求：

- 使用 SQLite 持久化 JobSpec、effective config、状态、进度、输入引用、artifact 和错误摘要。
- 计算工作放到独立 worker 进程；Web server 重启不能伪装成任务成功。
- Electron 断开不取消任务。
- 重连后通过 `GET /api/jobs?since=<cursor>` 恢复任务抽屉。
- 提供显式取消、重试和仅重试失败项。
- 第一版声明“一台 GPU 服务器只允许一个交互用户”，避免现有全局 session state 在多客户端间串扰。

进度更新建议从高频 polling 逐步切换到同源 SSE：

```http
GET /api/jobs/events?cursor=<last-event-id>
```

SSH 隧道天然支持 SSE。连接断开后用 `Last-Event-ID` 补取事件；任务最终状态仍以普通 REST 查询为准。

## 8. GPU 服务部署

推荐先提供 Docker Compose，宿主机端口只发布到 loopback：

```yaml
services:
  hhtools-remote:
    image: ghcr.io/roboparty/hhtools-remote:<version>
    restart: unless-stopped
    gpus: all
    ports:
      - "127.0.0.1:8009:8009"
    volumes:
      - /data/hhtools/motions:/data/motions
      - /data/hhtools/results:/data/results
      - /data/hhtools/cache:/data/cache
      - /data/hhtools/config:/data/config
    command:
      - hhtools
      - remote
      - serve
      - --host
      - 0.0.0.0
      - --port
      - "8009"
```

容器内监听 `0.0.0.0` 是为了接受 Docker 端口转发；宿主机只发布 `127.0.0.1`，所以服务仍不暴露到外部网络。

部署前检查：

- NVIDIA Container Toolkit 与 `docker run --gpus all` 正常。
- hhtools 镜像固定依赖版本和镜像 digest。
- motions/results/cache/config 使用独立持久卷。
- `/api/health` 同时报告 Python、Torch、CUDA、Newton、MuJoCo 和磁盘状态。
- 日志轮转、磁盘水位和 artifact 清理策略明确。

第一版也可以先使用 systemd + 现有 `.venv`，但 Docker 更容易复制到不同 4090/H100/H200 服务器并锁定运行环境。

## 9. 分阶段实施

### Phase 0：冻结协议与测试基线

- 给现有 health、上传、任务、导出接口补 contract tests。
- 明确哪些状态仍在全局内存中。
- 定义 `protocol_version = 1` 和 bootstrap schema。

完成标准：浏览器、本地 Electron 的现有行为不变，API schema 有自动测试保护。

### Phase 1：最小远程闭环

- 实现 `BackendConnection` 抽象。
- 实现 connection profile 与本地连接页。
- 将 Vue + Three.js build 纳入 Electron resources，并实现 Local Gateway。
- 实现 `SshRemoteConnection` 和动态本地端口。
- 服务器增加 loopback remote serve、设备 token 和 bootstrap。
- 让本地 GUI 的 `/api` 经 Gateway 和隧道访问 remote service。

完成标准：一台没有 Python/CUDA 的 Windows 笔记本，仅凭 Electron、OpenSSH 和 SSH key，可以启动本地完整 GUI，并连接 GPU 服务器完成 health/capability 握手。

### Phase 2：一条真实工作流

- 先只验收 H2R 单条流程：上传 Motion、选择服务器 Robot、Retarget、预览、下载 CSV。
- 补断线、SSH 进程崩溃、token 无效、版本不兼容和服务器无 GPU 的错误界面。
- 验证关掉 Electron 后服务器任务继续执行。

完成标准：重新打开 Electron 后能找到原任务并下载结果。

### Phase 3：数据与长任务

- 服务器允许 roots 与大型数据集注册。
- artifact store、Range 下载和 hash 校验。
- SQLite job registry、worker 进程、取消/重试。
- SSE 进度与断线续接。

完成标准：批量任务和 Dataset Analysis 经网络中断后仍可恢复，不重复计算或重复上传。

### Phase 4：完整能力与发布

- R2R、Batch、Dataset Analysis 全量回归。
- Windows 安装包签名、自动更新和 profile 迁移。
- 远端 Docker 镜像发布、版本矩阵和回滚说明。
- 可选增加 Tailscale/WireGuard + HTTPS 模式，但不替代默认 SSH 模式。

完成标准：新机器安装 Electron 后不需要本地 Python；服务器部署和客户端配对有完整文档、诊断与自动化测试。

## 10. 验收用例

1. 干净 Windows 虚拟机没有 Python、CUDA、Node，安装 Electron 后能连接服务器。
2. SSH host key 不匹配时阻止连接并显示指纹变化，不自动忽略。
3. token 错误、撤销或过期后 API 返回 401，Renderer 看不到 token。
4. 服务器端口只监听 loopback；从另一台机器扫描不到 FastAPI 端口。
5. 通过远程模式完成 Motion -> Robot -> Calibration -> H2R -> Preview -> Export。
6. 任务运行中关闭 Electron，服务器任务继续；重新连接后恢复进度和结果。
7. SSH 中断后 UI 不丢失编辑状态，重连成功后不重复提交任务。
8. 上传目录中的 `..`、绝对路径、符号链接与恶意压缩包不能逃出 job 目录。
9. 下载中断后可以续传，最终文件 hash 与服务器一致。
10. 本地模式全部原有测试继续通过，Remote 改造不要求现有用户配置服务器。

## 11. 当前不做的事情

- 不在第一版支持匿名公网访问。
- 不把 SSH 密码、私钥或长期 token 暴露给 Vue Renderer。
- 不把全部 HTTP API 改写为 Electron IPC。
- 不把 Python/CUDA runtime 塞进 Windows Electron 安装包。
- 不在第一版实现多租户、计费或复杂调度。
- 不把服务器任意绝对路径暴露为网页文件浏览器。

## 12. 推荐的第一轮开发切片

第一轮只做最小但真实的闭环，顺序如下：

1. 增加 `BackendConnection`，先用 adapter 包住现有 local sidecar，确保行为不变。
2. 增加 remote profile store 和本地连接页。
3. 实现 SSH tunnel supervisor、health check 和安全退出。
4. 增加 remote token guard 与 `/api/desktop/bootstrap`。
5. 将本地 GUI 的 `/api` 通过 Local Gateway 和隧道代理到远程服务。
6. 用一个小动作跑通 H2R 和结果下载。
7. 再开始任务持久化、可恢复上传与完整工作流。

这条路线的关键不是“把 API 地址改成远程 IP”，而是把连接生命周期、凭据、文件边界、任务生命周期和版本兼容一起变成正式产品能力。
