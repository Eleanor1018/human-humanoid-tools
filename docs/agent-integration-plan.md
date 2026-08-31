# HHTools 面向 AI Agent 的接入与优化方案 v0.2

> 状态：仓库实施基线（v0.2）
> 日期：2026-08-31
> 来源：由《HHTools_Agent_接入与优化需求》v0.1 结合当前仓库实现收敛而成
> 适用对象：HHTools 维护者、Web/Electron/MCP 开发者、机器人动作重定向研究者

## 1. 结论

HHTools 应增加面向 AI Agent 的正式调用能力，但实现顺序不能是“把现有 CLI 命令直接包成 MCP”。

正确顺序是：

1. 冻结稳定、可版本化的数据契约；
2. 将 WebUI、CLI 里需要复用的编排逻辑收敛到统一应用服务层；
3. 完成资产引用、预检、任务状态、产物和错误语义；
4. 提供严格 JSON CLI 和 `/api/agent/v1`；
5. 使用 MCP Python SDK v2 的 `MCPServer` 增加薄适配层；
6. 先交付本机 stdio MCP，再建设带认证的远程 Streamable HTTP；
7. 最后用 HHTools Skill 固化 Agent 的默认工作流。

目标结构如下：

```text
Electron / WebUI              JSON CLI / REST               AI Agent
       │                            │                            │
       │                            │                      MCP / Skill
       └────────────────────────────┼────────────────────────────┘
                                    ▼
                         Unified Application Services
                    ┌───────────────┼────────────────┐
                    │               │                │
              AssetRegistry   PreflightService   JobManager
                    │               │                │
                    └────────► RetargetService ◄─────┘
                                    │
                          EvaluationService
                                    │
                              ArtifactStore
                                    │
                  Newton / Interaction-Mesh / R2R
```

GUI、REST、CLI 和 MCP 都只能是同一服务层的客户端。MCP 层不得复制求解器逻辑、拼接 shell 命令或解析 CLI 文本。

### 1.1 当前执行进度（2026-08-31）

第一轮可审阅基线已经落地：

- `hhtools/contracts/` 已包含 Error、Asset、Capabilities、Preflight、JobSpec v2、AgentJobView 与 Artifact 的严格 Pydantic 契约；
- 已生成 `docs/schemas/agent/v1/` 下 10 份受测试保护的 JSON Schema；
- 已加入 plain motion、object interaction、terrain scene 和已标定 G1/SMPL 预检 golden fixture；
- `CapabilitiesService` 已以只读方式报告后端、设备、机器人、格式及实时调度状态；
- `GET /api/agent/v1/capabilities` 已接入现有 FastAPI，但不创建 Motion token、不加载求解器，也不占用任务队列；
- JobSpec v1 仍由原模块读取，现有 Web API 和算法未迁移、未删除、未改数值行为。

尚未开始的是 AssetRegistry、真实 content inspect、PreflightService、JobManager/ArtifactStore、JSON CLI、MCP 和远程认证。接口的 `features` 字段会明确把这些能力报告为不可用，不能把契约存在误解为功能已经完成。

## 2. 不可突破的实施边界

### 2.1 不改现有算法

本计划只改调用契约、应用编排、任务生命周期、资产管理和结果表达，不修改：

- Newton IK 数学过程与默认求解参数；
- Interaction-Mesh 算法和 MPC 过程；
- R2R/H2R 关节映射与轨迹生成逻辑；
- 机器人标定业务逻辑、标定结果或坐标约定；
- 当前导出数据的数值含义。

重构时应先用现有行为建立回归测试，再让 service 调用原实现。不得以“方便 Agent”为理由顺便调整算法输出。

### 2.2 不把 CLI 直接包装为 MCP

禁止实现以下形式：

```text
run_command(command: string)
run_hhtools_cli(args: string)
```

原因包括命令注入、跨平台 quoting 差异、文本输出不稳定、路径越界、错误不可恢复，以及无法表达长任务和产物所有权。

### 2.3 MCP 是控制面，不是大文件传输通道

视频、FBX、NPZ、BVH、GLB、机器人 mesh、数据集目录和结果 ZIP 不以 Base64 放进 MCP tool 参数或响应。MCP 只传 `asset_id`、`job_id`、`artifact_id` 或受控 URI；大文件继续由本地文件、共享存储、REST 上传或 SSH/SFTP 负责。

### 2.4 WebUI 继续承担人工工作

视觉检查和机器人标定仍由 WebUI 完成。Agent 遇到缺少标定或需要人工判断时必须返回结构化 `human_action_required`，而不是猜测标定参数。

### 2.5 当前并发默认值不改变

当前产品选择继续保留：

- `max_running_jobs = 0` 表示运行并发不设上限；
- `max_queued_jobs = 0` 表示等待队列不设上限；
- 默认值均为 `0`；
- 专业用户或管理员可在设置、CLI 或部署配置中主动设置上限。

Agent 接口必须返回当前调度模式并在预检中给出资源提醒，但不得悄悄把默认值改成 1、8 或其他固定数字。并发配置属于 admission policy，不等同于单个任务内部的 GPU batch size。

## 3. 当前仓库能力盘点

### 3.1 已实现

| 能力 | 当前实现 | v0.2 中的处理 |
|---|---|---|
| H2R、R2R 与 Batch 工作流 | WebUI 和 FastAPI 已能启动任务 | 保持兼容，逐步改由 service 编排 |
| Newton 与 Interaction-Mesh | 已有可工作的求解后端 | 只调用，不修改算法 |
| 磁盘任务历史 | `JobHistoryStore` 原子保存紧凑任务记录 | 作为 JobManager 迁移输入 |
| JobSpec v1 | 保存可跨 session 的路径与有效参数 | 保留读取能力，新增 v2，不原地改变 v1 |
| 任务重放 | source-backed Retarget/Batch 可重放，Batch 支持失败项重试 | 通过 v2 的父子关系和幂等语义标准化 |
| 产物持久化 | Batch ZIP 等部分产物已进入任务历史目录 | 扩展为统一 Artifact/Manifest |
| 任务调度 | FIFO admission、运行/等待上限可配置 | 保持默认 `0 = unlimited`，补充 Agent 视图 |
| 结果诊断 | 有跟踪误差、接触和足滑等快速诊断 | 作为 Evaluation 的输入，不夸大为仿真真值 |
| Web/Electron 设置 | 并发与等待队列可持久化配置 | Agent 读取同一服务端配置 |

### 3.2 部分实现

| 能力 | 当前局限 | v0.2 目标 |
|---|---|---|
| 任务持久化 | 服务重启会把遗留 running/pending 标成中断失败，不能续跑 | 状态可追踪；独立 worker 阶段再实现真正续跑/恢复 |
| JobSpec 可复现性 | v1 是按路径和参数重放，没有输入哈希、代码、标定、依赖和设备快照 | JobSpec v2 记录完整执行身份 |
| API 参数 | 多个路由仍接收裸 `dict` | Agent API 全部使用 Pydantic 模型 |
| 产物 | 下载文件和诊断分散在任务响应及不同目录 | 所有大结果统一登记为 Artifact |
| 诊断 | 基于降采样预览轨迹和启发式接触，不是 Isaac/MuJoCo 接触真值 | 明确证据等级，形成 quality verdict |
| 上传安全 | 已有路径和格式检查，但扩展名可识别不等于文件可解析 | Asset inspect/preflight 做完整、可操作的检查 |
| 调度 | 主要在 Web 进程内工作，缺少持久 worker 所有权 | JobManager/worker 与客户端生命周期解耦 |

### 3.3 尚未实现

- 稳定的 `asset_id` 和跨平台 AssetBundle；
- 不可变的 `plan_id` 与独立 PreflightService；
- JobSpec v2 及 v1 到 v2 的明确兼容策略；
- 面向轮询的紧凑 AgentJobView；
- 统一 Artifact/Manifest 资源模型；
- 统一错误码、可重试性和人工接管语义；
- 提交幂等键和可靠的单任务取消；
- 核心 CLI 的严格 `--json` 模式；
- `/api/agent/v1`；
- MCP Server 和 MCP resources；
- HHTools Agent Skill；
- 远程 MCP 的认证、授权、TLS 和审计。

## 4. Agent-first 应用架构

### 4.1 Contracts

已新增 `hhtools/contracts/`，只放版本化 Pydantic 模型、枚举和序列化规则：

```text
hhtools/contracts/
├── common.py
├── assets.py
├── capabilities.py
├── preflight.py
├── job_spec.py
├── jobs.py
└── __init__.py
```

`common.py` 统一 Error/ID/version 原语，`jobs.py` 同时承载紧凑 Job 与 Artifact 描述。Contracts 不导入 FastAPI、Typer、MCP 或 Vue，也不运行求解器。

### 4.2 Services

建议新增 `hhtools/services/`：

```text
hhtools/services/
├── capabilities.py
├── assets.py
├── preflight.py
├── retarget.py
├── jobs.py
├── evaluation.py
└── artifacts.py
```

服务方法接收 contract，返回 contract；不得直接输出 Rich 文本。现有 server/CLI 逐路由迁移，避免一次性重写。

### 4.3 Adapters

```text
WebUI / Electron  ─► FastAPI adapter ─┐
JSON CLI         ─► Typer adapter   ──┼─► services
MCP              ─► MCP adapter     ──┘
```

适配器只负责身份、协议、序列化和错误映射，不决定后端、不解析动作、不生成标定。

## 5. 六套核心数据契约

所有 Agent-facing JSON 均包含 `schema_version`。ID 应稳定、不可由显示名称替代；时间使用带时区 ISO 8601；文件哈希默认 SHA-256。

### 5.1 AssetBundle

单个动作或机器人通常不是一个孤立文件。AssetBundle 把相关文件注册为一个可检查、可引用的整体。

```json
{
  "schema_version": "1.0",
  "asset_id": "asset:sha256:2d4f...",
  "kind": "motion_bundle",
  "category": "object_interaction",
  "display_name": "omomo-sub10-largebox",
  "primary_file": "sub10/sub10.pkl",
  "files": [
    {
      "role": "motion",
      "relative_path": "sub10/sub10.pkl",
      "size_bytes": 1048576,
      "sha256": "..."
    },
    {
      "role": "object_mesh",
      "relative_path": "sub10/largebox.obj",
      "size_bytes": 524288,
      "sha256": "..."
    }
  ],
  "source": {
    "scheme": "managed_file",
    "root_id": "motion-library",
    "registered_at": "2026-08-31T12:00:00+08:00"
  },
  "detected": {
    "dataset": "omomo",
    "reference": "smplx",
    "recommended_backend": "interaction_mesh"
  }
}
```

`category` 首版至少支持：

- `plain_motion`：mimic，只有人体动作；
- `object_interaction`：intermimic，动作 + 物体 mesh/轨迹；
- `terrain_scene`：meshmimic，动作 + terrain/scene；
- `robot_model`：URDF/MJCF、visual mesh、collision mesh、preset；
- `calibration`：机器人、参考骨架和版本绑定的标定结果。

约束：

- 对外不暴露任意宿主机绝对路径；
- `relative_path` 不允许 `..`、绝对路径或越过登记根目录的 symlink；
- Bundle ID 必须与清单内容和文件哈希绑定；
- Windows 客户端路径不能被假定为 Linux 服务器路径；
- 机器人 URDF 引用的 visual/collision meshes 必须进入同一 bundle 或受控依赖 bundle；
- 可变目录标签不能充当不可变资产身份。

### 5.2 JobSpec v2

JobSpec v2 是经过预检后可执行且可审计的规范，不是 session 表单快照。

```json
{
  "schema_version": 2,
  "kind": "retarget",
  "plan_id": "plan:sha256:91ab...",
  "inputs": [
    {"asset_id": "asset:sha256:2d4f...", "sha256": "2d4f..."}
  ],
  "robot": {
    "robot_id": "g1_29dof",
    "asset_id": "asset:sha256:8a1c...",
    "config_sha256": "..."
  },
  "calibration": {
    "calibration_id": "cal:sha256:771e...",
    "sha256": "..."
  },
  "backend": "newton",
  "effective_parameters": {
    "reference": "smpl",
    "output_format": "csv",
    "start_time": 0.0,
    "end_time": null
  },
  "output_policy": "create_new",
  "provenance": {
    "hhtools_git_commit": "...",
    "hhtools_dirty": false,
    "python": "...",
    "pytorch": "...",
    "cuda": "...",
    "newton": "...",
    "device": "..."
  },
  "created_at": "2026-08-31T12:05:00+08:00"
}
```

兼容规则：

- JobSpec v1 保持可读，不改写已有历史；
- v1 只能继续声明为 path-and-parameter replay；
- v1 升级 v2 时必须重新登记资产和预检，不能伪造缺失哈希；
- `plan_id` 由所有有效执行输入规范化后计算，任一资产、标定或参数变化都生成新 plan；
- 服务端保存完整 v2，Agent 默认只获取摘要或 artifact 引用。

### 5.3 PreflightResult

预检必须在正式 GPU 任务入队前完成，且成功后产生不可变 `plan_id`。

```json
{
  "schema_version": "1.0",
  "status": "ready",
  "plan_id": "plan:sha256:91ab...",
  "checks": [
    {"code": "INPUT_PARSEABLE", "level": "pass", "message": "Motion parsed"},
    {"code": "CALIBRATION_MATCH", "level": "pass", "message": "Calibration hash matches"},
    {"code": "GPU_ADMISSION", "level": "warning", "message": "Concurrency is unlimited"}
  ],
  "resolved": {
    "backend": "newton",
    "robot_id": "g1_29dof",
    "calibration_id": "cal:sha256:771e..."
  },
  "recommendation": {
    "backend": "newton",
    "reason_code": "PLAIN_MOTION"
  },
  "job_spec_artifact_id": "artifact:jobspec:...",
  "required_actions": []
}
```

预检至少验证：

- AssetBundle 完整性、哈希、格式、可读性和解析结果；
- 帧数、帧率、时间范围、NaN/Inf 与参考骨架；
- 机器人 bundle、preset、mesh 引用和关节配置；
- 后端依赖与输入类别的兼容性；
- 标定存在、机器人/参考/版本/哈希匹配；
- 参数范围、输出目录策略和命名；
- 当前设备、调度模式和预计资源类型。

状态只允许：`ready | rejected | human_action_required`。缺少标定时返回 WebUI 操作入口，不进入队列。

### 5.4 AgentJobView

当前完整任务结果可能包含 trajectory 和 preview 数组，不适合高频轮询。AgentJobView 默认保持紧凑：

```json
{
  "schema_version": "1.0",
  "job_id": "job:01K...",
  "state": "running",
  "outcome": null,
  "progress": {
    "phase": "ik_solve",
    "fraction": 0.62,
    "revision": 17,
    "message": "Solving frame 620/1000"
  },
  "summary": {
    "input_count": 1,
    "robot_id": "g1_29dof",
    "backend": "newton",
    "run_mode": "smoke"
  },
  "queue": {
    "position": null,
    "max_running_jobs": 0,
    "max_queued_jobs": 0,
    "mode": "unlimited"
  },
  "artifacts": [],
  "error": null,
  "poll_after_ms": 1500
}
```

必须严格区分：

- `state`：`queued | running | completed | failed | cancelled`；
- `outcome`：`success | partial | review_required | rejected`，任务未完成时为 `null`。

程序运行完不等于动作质量通过。Batch 部分失败应是 `state=completed, outcome=partial`，不能只用一个模糊的 `done`。

`get_job` 支持 `after_revision`；无变化时返回紧凑响应和下一次建议轮询间隔，默认不返回完整日志或轨迹。

### 5.5 Artifact 与 Manifest

每个可下载或较大的结果都登记为 Artifact：

```json
{
  "schema_version": "1.0",
  "artifact_id": "artifact:preview:4d2a...",
  "job_id": "job:01K...",
  "kind": "preview",
  "media_type": "video/mp4",
  "size_bytes": 8923120,
  "sha256": "...",
  "created_at": "2026-08-31T12:12:00+08:00",
  "resource_uri": "hhtools://jobs/job:01K.../artifacts/artifact:preview:4d2a..."
}
```

首版 artifact kind 至少包括：

- `retargeted_motion`；
- `batch_archive`；
- `preview`；
- `evaluation_report`；
- `failure_report`；
- `job_spec`；
- `manifest`；
- `log_tail`。

每个终态任务都生成 manifest，记录资产哈希、机器人/标定哈希、有效参数、Git 状态、环境、设备、父任务、时间、最终 outcome、错误和所有产物哈希。失败任务也必须有 manifest。

### 5.6 Error

错误不能只有 HTTP 400/500 或自然语言字符串：

```json
{
  "schema_version": "1.0",
  "code": "CALIBRATION_REQUIRED",
  "message": "The selected robot has no matching SMPL-X calibration.",
  "retryable": false,
  "stage": "preflight",
  "details": {
    "robot_id": "g1_29dof",
    "reference": "smplx"
  },
  "next_action": {
    "actor": "human",
    "action": "open_calibration_ui",
    "url": "http://127.0.0.1:8009/?panel=h2r&calibrate=smplx"
  }
}
```

首版稳定错误码至少覆盖：

- `ASSET_NOT_FOUND`、`ASSET_OUTSIDE_ALLOWED_ROOT`、`ASSET_HASH_MISMATCH`；
- `UNSUPPORTED_FORMAT`、`BUNDLE_INCOMPLETE`、`MOTION_PARSE_FAILED`；
- `ROBOT_NOT_FOUND`、`ROBOT_BUNDLE_INVALID`；
- `BACKEND_UNAVAILABLE`、`BACKEND_INCOMPATIBLE`；
- `CALIBRATION_REQUIRED`、`CALIBRATION_MISMATCH`；
- `INVALID_PARAMETER`、`PLAN_STALE`；
- `QUEUE_FULL`、`JOB_CONFLICT`、`JOB_NOT_FOUND`；
- `JOB_CANCEL_UNSUPPORTED`、`JOB_CANCELLED`；
- `CUDA_OUT_OF_MEMORY`、`SOLVER_FAILED`、`OUTPUT_WRITE_FAILED`；
- `INTERNAL_ERROR`。

HTTP、CLI exit code 和 MCP error 都映射到同一个 Error；可预期业务失败不得伪装为内部异常，真正内部异常也不得全部泛化为 400。

## 6. Agent 默认工作流

```text
get_capabilities
        │
register/search asset ─► inspect bundle
        │
list/select robot
        │
preflight_retarget
   ├─ human_action_required ─► WebUI 标定 ─► 重新 preflight
   ├─ rejected ──────────────► 停止并解释
   └─ ready
        │
start_retarget(run_mode=smoke)
        │
get_job(after_revision=...)
        │
quality verdict
   ├─ rejected ──────────────► 停止
   ├─ review_required ───────► 请求用户确认
   └─ success
        │
start_retarget(run_mode=full)
        │
交付 motion + preview + evaluation + manifest
```

默认先运行 30 帧或等效短片段冒烟任务。是否在 smoke 通过后自动继续完整任务应作为调用策略显式给出，不埋在求解器内部。

Agent 不得：

- 绕过 preflight；
- 在标定缺失时猜参数；
- 把 `completed` 自动解释成质量合格；
- 自动覆盖旧结果；
- 把离线轨迹直接下发真机；
- 高频无间隔轮询；
- 根据绝对路径猜测远程资产。

## 7. MCP v2 设计

### 7.1 实现约束

- 使用当前 MCP Python SDK v2 的 `MCPServer`；
- 不依据旧教程新建 v1 `FastMCP` 实现；
- MCP adapter 仅调用 `hhtools.services`；
- tool 输入/结构化输出由 Pydantic contract 生成；
- 长任务立即返回 `job_id`，不让 tool call 阻塞整个 GPU 运行；
- 不提供任意 shell、任意路径读取或大文件 Base64 工具。

### 7.2 首版本地工具

首版保持小而稳定：

| Tool | 作用 |
|---|---|
| `get_capabilities` | 返回版本、后端、依赖、格式、设备和调度策略 |
| `register_asset_bundle` | 从允许根目录或已上传对象登记 bundle |
| `search_assets` | 按类别、名称、dataset、reference 搜索资产 |
| `inspect_asset_bundle` | 解析 bundle 元数据和完整性，不启动正式任务 |
| `list_robots` | 查询机器人、bundle、reference 与标定状态 |
| `preflight_retarget` | 验证输入并返回不可变 `plan_id` 或下一步行动 |
| `start_retarget` | 用 `plan_id` 启动 smoke/full，支持 idempotency key |
| `get_job` | 紧凑查询状态，支持 revision 增量轮询 |
| `cancel_job` | 请求取消 queued/running job，并返回是否生效 |
| `retry_job` | 由原 job 创建显式子任务，可只重试 Batch 失败项 |

独立 `evaluate_job` 可在 EvaluationService 稳定后增加；MVP 中默认在 Retarget 完成后生成评估产物。

### 7.3 MCP resources

大内容通过只读 resource 按需读取：

```text
hhtools://capabilities
hhtools://schemas/asset-bundle/1.0
hhtools://schemas/job-spec/2
hhtools://robots/{robot_id}
hhtools://assets/{asset_id}/manifest
hhtools://plans/{plan_id}
hhtools://jobs/{job_id}/status
hhtools://jobs/{job_id}/manifest
hhtools://jobs/{job_id}/evaluation
hhtools://jobs/{job_id}/failures
hhtools://jobs/{job_id}/artifacts/{artifact_id}
```

默认 tool 响应只给摘要和 URI；Agent 确有需要时再读取报告。二进制 artifact 的 resource 可返回下载描述/受控链接，不强制把整个文件注入模型上下文。

### 7.4 传输顺序

第一阶段：本机 stdio。

```text
Codex ── stdio ──► hhtools-mcp ──► local services
```

优点是无需先解决公网认证，可直接用固定样例验证 schema、错误和 Agent 工作流。

第二阶段：远程 Streamable HTTP。

```text
Agent ─► SSH tunnel / TLS gateway ─► MCP Streamable HTTP
                                      │
                                      ▼
                               HHTools services
                                      │
                               Job worker / GPU
```

正式暴露远程端口前必须具备身份认证、细粒度授权、TLS、审计、资源所有权和速率限制。认证未完成时，只允许通过 SSH loopback tunnel 访问服务器本地监听地址。

## 8. JSON CLI 与 REST

MCP 之前先完成可独立验证的协议入口：

```bash
hhtools agent capabilities --json
hhtools asset register PATH --json
hhtools asset inspect ASSET_ID --json
hhtools retarget preflight --asset ASSET_ID --robot g1_29dof --json
hhtools job start --plan PLAN_ID --mode smoke --idempotency-key KEY --json
hhtools job get JOB_ID --after-revision 17 --json
```

规则：

- JSON 只写 stdout，日志与进度写 stderr；
- 成功与失败都输出版本化 contract；
- exit code 区分参数、预检、任务和内部错误；
- CLI 不自行实现业务逻辑。

REST 新增版本化命名空间 `/api/agent/v1`，保留现有 WebUI API：

```text
GET    /api/agent/v1/capabilities
POST   /api/agent/v1/assets
GET    /api/agent/v1/assets/{asset_id}
POST   /api/agent/v1/preflight/retarget
POST   /api/agent/v1/jobs
GET    /api/agent/v1/jobs/{job_id}
POST   /api/agent/v1/jobs/{job_id}/cancel
POST   /api/agent/v1/jobs/{job_id}/retry
GET    /api/agent/v1/artifacts/{artifact_id}
```

旧 WebUI 路由不一次性删除；先写 adapter parity tests，确认相同 service 调用产生相同有效参数。

## 9. 实施阶段与 PR 切片

每个切片都应可独立 review、测试和回退，不把 UI、算法、契约和 MCP 混入一个超大 PR。

### 阶段 0：冻结契约和回归样例

交付：

- 六套 Pydantic contract、JSON Schema 和稳定错误码；
- 一个 plain motion、一个 object interaction、一个 terrain scene 固定样例；
- 一台已有标定机器人的 golden request/result；
- JobSpec v1 兼容测试；
- 现有 solver 输出回归摘要。

验收：schema 可 round-trip；未知字段策略明确；没有算法文件变化。

### 阶段 1：AssetRegistry

交付：

- 允许根目录和受控 URI；
- AssetBundle 登记、哈希、搜索、inspect；
- Windows/Linux 路径隔离；
- URDF mesh 依赖检查；
- SQLite 元数据和本地 ArtifactStore 根目录。

验收：同一 bundle 重复登记得到稳定身份；路径穿越、损坏和缺文件返回稳定错误。

### 阶段 2：Application Services 与 Preflight

交付：

- CapabilitiesService、PreflightService、RetargetService facade；
- 不可变 plan 与 JobSpec v2；
- 标定缺失的人工接管响应；
- 现有 Web 路由逐项调用 service，输出保持一致。

验收：预检不占用正式 GPU 队列；改变资产/标定/参数一定改变 `plan_id`；现有 H2R/R2R/Batch 回归通过。

### 阶段 3：Agent Job/Artifact 语义

交付：

- 紧凑 AgentJobView；
- state/outcome 分离和 revision 轮询；
- idempotency key、取消、父子重试；
- 统一 manifest、evaluation 和失败报告；
- 调度策略读取同一 JobAdmissionSettings，默认保持 `0 = unlimited`。

验收：重复提交不产生重复任务；部分失败可被 Agent 正确识别；响应不包含巨大 trajectory/preview 数组。

### 阶段 4：JSON CLI 与 Agent REST

交付：

- 核心 `--json` 命令；
- `/api/agent/v1` 中除只读 `capabilities` 外的资产、预检、任务和产物接口；
- CLI/REST/service contract parity tests；
- OpenAPI 示例和端到端 smoke fixture。

验收：Agent 无需解析 Rich 文本即可完成预检、提交、轮询和取得产物。

### 阶段 5：MCP stdio 与 Skill

交付：

- 基于 `MCPServer` 的本机 stdio server；
- 最小工具集和 resources；
- MCP contract/integration tests；
- HHTools Skill：capabilities → preflight → smoke → evaluate → full → manifest。

验收：Codex 能在不调用 shell、不读取 WebUI session token 的情况下完成固定样例；需要标定时正确暂停并给出 WebUI 入口。

### 阶段 6：持久 worker 与远程 GPU

交付：

- 与 Web/MCP 客户端解耦的 worker；
- 服务重启后的任务所有权和恢复策略；
- Streamable HTTP、认证、授权、TLS、审计；
- 跨机器 asset upload/registration；
- 多用户 job/artifact 隔离。

验收：客户端断开不影响任务；只能读取有权限的资产、任务和产物；网络重试不会重复运行。

## 10. 总体验收标准

### MVP（阶段 0—5）

- [ ] `get_capabilities` 准确报告后端、依赖、GPU 和 `0 = unlimited` 调度模式；
- [ ] 三类动作和机器人文件可登记为 AssetBundle；
- [ ] Agent 不使用远程宿主机任意绝对路径；
- [ ] 损坏输入、缺少 mesh、后端不兼容和标定缺失在入队前被发现；
- [ ] 成功预检返回不可变 `plan_id` 与 JobSpec v2；
- [ ] 任务提交支持 idempotency key；
- [ ] AgentJobView 不携带完整 trajectory/preview；
- [ ] Batch 部分失败返回 `outcome=partial`；
- [ ] 每个终态任务都有 manifest 和 artifact 哈希；
- [ ] CLI、REST、MCP 使用同一 service 和 Error contract；
- [ ] MCP 使用 `MCPServer`，stdio 模式可完成端到端 smoke；
- [ ] 缺少标定时 Agent 停止并交给 WebUI；
- [ ] 现有算法、数值默认值和导出语义没有被改变。

### 正式远程版本（阶段 6）

- [ ] Agent 或 Electron 断开后 GPU 任务继续；
- [ ] 服务重启后任务记录不丢失，恢复策略明确且可审计；
- [ ] 远程 MCP 具有认证、授权、TLS 和审计；
- [ ] 多用户资产、任务和产物隔离；
- [ ] queued/running 任务可可靠取消；
- [ ] 每个结果可由 manifest 追溯输入、代码、标定、依赖和设备；
- [ ] 相同业务语义在本地 stdio 与远程 Streamable HTTP 中一致。

## 11. 第一轮实际开发范围

第一轮应停在“契约可以 review、服务可以复用、现有行为不变”的位置：

1. 建立 `hhtools/contracts/`；
2. 固定 Error、AssetBundle、PreflightResult、JobSpec v2、AgentJobView、Artifact；
3. 为 v1 JobSpec 保留兼容读取；
4. 增加 golden schema 和序列化测试；
5. 只读实现 capabilities 和现有机器人/后端映射；
6. 不在同一轮引入 MCP、不移动求解器、不改变 WebUI 业务行为。

完成这一步后再做 AssetRegistry 和 Preflight。这样即使后续 MCP SDK 或传输方式变化，HHTools 的核心业务契约仍然稳定。

## 12. 一句话原则

**先把 HHTools 建成具有稳定资产身份、不可变预检计划、紧凑任务状态、可追溯产物和可操作错误的应用服务，再让 MCP 与 Skill 成为 Agent 的薄入口；绝不让 MCP 复制 CLI，更不借 Agent 适配修改已经能工作的机器人算法。**
