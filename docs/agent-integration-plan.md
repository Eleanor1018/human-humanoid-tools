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

阶段 0 的 Agent 契约基线已经完成：

- `hhtools/contracts/` 已定义 Error、Asset、Capabilities、Preflight、JobSpec v2、AgentJobView、Artifact、EvaluationReport、FailureReport、JobManifest、任务操作请求与 v1 升级回执的严格、版本化、transport-neutral 契约；
- `docs/schemas/agent/v1/` 当前共有 **21 份**受测试保护的 JSON Schema，覆盖 Phase 4 新增的 job start/retry、artifact page 和 legacy upgrade request/response，以及 Phase 5 的稳定机器人列表 envelope；
- 已加入 plain motion、object interaction、terrain scene 三类 AssetBundle fixture，以及 G1/SMPL 的 Preflight **契约 fixture**；
- `CapabilitiesService` 以只读方式报告后端依赖、设备、机器人、标定与 scaler 状态、格式、允许的资产根标识和实时调度策略；
- JobSpec v1 仍由原模块读取；阶段 3 另提供严格、只读的单条 H2R v1→v2 升级服务，旧文档本身以及现有求解器和数值默认值都不会被改写。

阶段 1 的 AssetRegistry、inspect 与 Asset REST 已经完成：

- SQLite WAL 持久化 content-addressed motion/robot manifest；
- 只接受部署端配置的 `root_id + relative_path`，并在登记和读取时重复检查根目录、bundle 边界与 symlink containment；
- motion inspect 支持三类动作的哈希、sidecar、路由和有限内容检查；
- robot inspect 支持 URDF、visual/collision mesh、robot YAML 和声明的 scaler 配置检查；
- `.pkl/.pickle/.pt/.pth` 只做不执行反序列化的结构检查，`CONTENT_REQUIRES_ISOLATED_VALIDATION` 不等于可执行内容已经解析。

阶段 2 的核心预检链路已在当前分支落地：

- `PlanStore` 以 canonical payload 生成稳定 `plan_id`，用 SQLite WAL 保存不可变、无宿主机路径的计划；
- `PreflightService` 交叉验证 motion asset、robot asset、preset、URDF、DOF、IK map、backend、人工 calibration/bundled scaler、参数和调度快照；
- `RetargetService` 会在不启动求解器的前提下重新核验 plan 与两个 bundle 的哈希，并由 `plan_id` 投影稳定、完整的 JobSpec v2；
- 缺少人工标定时返回 `human_action_required + open_calibration_ui`；
- 预检不创建 Motion token、不导入求解 pipeline、不初始化 GPU、不编译 MuJoCo，也不调用 scheduler `reserve()`；
- `POST /api/agent/v1/preflight/retarget` 已接入现有 FastAPI。

阶段 3 的 Agent Job/Artifact 应用服务、薄 H2R 执行接线和真实 Newton solver smoke 已经完成：

- `JobStore` 使用 SQLite WAL 持久化完整、不可变的 JobSpec v2，以及 `state/outcome/revision`、取消请求、父子 retry lineage 和 artifact descriptor；同一 idempotency key 只能绑定同一请求与 parent，状态与 artifact 的可变更新在事务中使用 expected-revision CAS；
- `ArtifactStore` 将 JSON、bytes 或 executor 产生的稳定文件复制到受管 content-addressed object root，以 SQLite WAL 保存完整 descriptor，并支持 SHA-256/大小复核和按 job 稳定列举 raw candidates；canonical job membership 由 JobStore 维护；`put_file` 的源路径只是进程内复制输入，不会进入 descriptor、artifact JSON 或 metadata；
- `AdmissionScheduler`/reservation 协议已由现有 `JobScheduler` 实现；`server.py` 将同一个 scheduler instance 注入 JobManager，因此 Agent 控制面与既有 Web 任务共享 FIFO admission、精确排队取消和 `0 = unlimited` 语义，没有第二套 Agent 并发计数器；
- `JobManager` 已实现注入式 `JobExecutor` 控制面：幂等提交、队列快照、revision 进度、精确 queued 取消、cooperative running 取消、父子 retry、结构化失败、partial outcome，以及正常持久化路径中的 evaluation/failure report 和终态 manifest；
- `get_job(after_revision=...)`、紧凑 AgentJobView、最多 32 个内联 artifact descriptor、真实 `artifact_count`、`cancellation_requested/cancellable` 和 retry lineage 均已有服务层实现与并发测试；
- 进程重启时，遗留 queued/running job 不会被伪装成继续执行：当前恢复策略会将其审计为 `failed + JOB_INTERRUPTED`，在 artifact store 可写时生成 failure report/manifest，并给出 `retry_job` next action；它不会自动重新提交原 job。真正续跑仍属于阶段 6 的独立 worker。

阶段 3 的 Web composition root 已注入薄的 `H2RJobExecutor`，因此该装配下的 capabilities 会报告 `job_execution/job_cancellation/job_retry` 可用。adapter 只复用原有 motion loader、grounding、`_retarget_single`、preview、diagnostics 和 export 入口，不复制或修改 IK、标定、数值默认值与导出数值逻辑。JobSpec 会在执行开始和进入求解器前做两次 exact validation；motion 严格按已登记 manifest 的 dataset 路由，robot 必须匹配确切 RobotBundle/preset。Agent RobotBundle 的 `urdf`、`mesh_search_paths` 与 `scaler_config` 等 metadata 执行路径必须是 bundle-relative；URDF 内的 mesh 引用只允许 bundle-relative 或 `package://`，MuJoCo compiler 资产目录也必须保持在 bundle 内。即使绝对路径仍落在原 bundle 内也会 fail closed，防止快照中的 URDF/metadata 反向引用登记源目录。执行前会把 RobotBundle manifest 中的每个文件复制到按任务创建的可写隔离 workspace，并再次核对 SHA-256/大小；既有 loader 与 Interaction-Mesh fallback 的 URDF/MJCF/mesh 兼容修复全部局限在该快照内，执行结束后释放，登记资产本身保持不变。Agent asset content identity 同时进入 robot-side cache key，避免同名但不同内容的机器人复用缓存。

单条 H2R JobSpec v1 的安全升级服务也已进入同一 composition root，并在 Phase 4 通过 `POST /api/agent/v1/legacy/jobspec-v1/upgrade` 提供薄 REST 入口。升级器把旧绝对路径仅视作一次性的本机定位提示：motion 与 robot 必须反查到用途隔离的 allowlisted dynamic root，随后由同一个 AssetRegistry 重新登记、inspect、preflight，再由 RetargetService 投影 JobSpec v2；它不直接构造 v2、不启动 solver、不占 scheduler，也不把宿主机路径写入 receipt。tracked root provider、路径/文件 snapshot 与逐文件 manifest 复核用于拒绝升级期间的 root remap 或内容变化；旧下载 wrapper 冲突、批任务、R2R、未知字段和不安全 metadata 均 fail closed。若正常 preflight 返回 `human_action_required/rejected`，升级器原样保留该结果，不伪造可运行 JobSpec。

该执行接线仍有明确边界：preview 最多选取 600 个 representative frames，最终 motion export 始终使用完整求解结果；当前 Agent v2 只支持 `output_policy=create_new`。object-interaction PKL 的旧 exporter 会嵌入宿主机 mesh path，因此该组合当前 fail closed，不发布伪 portable 产物。现有诊断只是预览轨迹上的启发式证据，所有完成结果一律标为 `review_required`；`stable/review/high_error/unavailable` 只是 quality band，不是自动通过或拒绝结论。running cancel 仍是 cooperative：Warp、MuJoCo、OSQP 等 native call 运行期间不能被 Python 强制打断，只能在 native call 返回后的安全点响应。本次 smoke 的运行日志独立确认 Warp 选用了 RTX 5060，但旧 solver 尚未把可信的 actual GPU device provenance 写入 JobExecutionResult/manifest；外部设备观察不能替代可持久审计的 provenance。

真实 dependency-enabled solver smoke 已完成：在 Windows/RTX 5060、Warp 1.12.1、Newton 1.1.0、MuJoCo 3.7.0 环境中，使用 Xsens `walk.bvh` + G1 29DoF 人工标定，按 `smoke/30 frames/24 IK iterations/Newton/CSV` 走完 `JobSpec → H2RJobExecutor → JobManager → preview/retargeted_motion/evaluation_report/manifest`。五个 canonical artifact 均通过 SHA-256 复核；CSV 包含 30×37 个有限数值，preview 包含 30 帧，manifest 不含宿主机路径。再以原 Web H2R 入口运行同参数对照，导出数值 `max_abs_error = mean_abs_error = 0.0`，且源 URDF 未被修改。该短 smoke 的启发式质量带为 `high_error`，因而正确保持 `outcome=review_required`：这证明该 Newton/G1/Xsens 矩阵的真实 IK 和产物链路可执行且与旧入口数值一致，不代表该 30 帧结果已通过效果验收，也不扩大为所有机器人/reference 或 Interaction-Mesh 的覆盖证明。客户端断开/服务重启后继续 GPU 求解仍属于阶段 6。

阶段 4 的 Agent REST 与严格 JSON CLI 已经完成：

- `/api/agent/v1` 已公开 jobs 的提交、revision-aware 查询、取消与 retry，以及 job-scoped artifact 列表、descriptor、content 下载和单条 H2R JobSpec v1 升级；所有任务与产物路由都调用同一 JobManager/LegacyJobUpgradeService，不读取 ArtifactStore raw candidates；
- `hhtools agent` 已提供 `capabilities`、`asset`、`preflight`、`job`、`artifact` 与 `legacy` 命名空间。它是 `hhtools web` 所提供常驻 REST 服务的严格客户端，不在 CLI 进程内复制 service 或 solver；成功和失败均只在 stdout 输出一个版本化 JSON 文档，产物 bytes 只在显式 `--output` 时流式写入并复核大小与 SHA-256；
- Job start 只接受预检冻结的 `plan_id` 与 idempotency key；`run_mode` 在 preflight request 中冻结并进入不可变 plan，不能在提交任务时再次覆盖；当前 retry 只重跑整个 H2R plan，不声称支持 Batch 失败项子集；
- Phase 4 测试已覆盖 REST 生命周期/idempotency/cooperative cancel/retry、canonical artifact membership 与下载、legacy upgrade、OpenAPI 路由和示例、REST strict JSON/loopback Host 与 Origin/body cap、CLI strict JSON/稳定 exit code/原子校验下载，以及 CLI→REST→service contract parity。

阶段 5 的本机 stdio MCP 与 HHTools Agent Skill 已经完成：

- `hhtools-mcp` 使用 MCP Python SDK v2 的 `MCPServer`，通过 stdio 在同一进程内装配既有应用服务；它不启动 HTTP listener、不包装 CLI/REST、不拼接 shell，也不复制 loader、IK、标定、预览、导出或任务状态逻辑；
- 首版只公开 11 个有界 tool、1 个具体 resource 与 9 个 resource template；Pydantic success schema、结构化 `ApiError`、job-scoped artifact membership、报告哈希复核、revision-aware polling 和 portable JSON 约束均有协议测试；
- standalone MCP 的能力声明为 `mcp=true, agent_rest=false, json_cli=false`。它不读取或请求 WebUI session token，不提供任意命令、任意路径读取、二进制 Base64 或真机下发接口；
- `.agents/skills/hhtools-agent/` 固化 capabilities → asset → preflight → smoke → evaluate → human review → approved full → manifest 流程；遇到 `human_action_required` 必须停止，绝不猜测标定；
- Web、Electron sidecar 与 MCP 对同一 `.hhtools-agent` 数据目录采用跨进程 OS lease。第二个 runtime 会在 JobManager recovery 和 GPU 调度启动前以 `RUNTIME_ALREADY_ACTIVE` fail closed；Windows 使用 `msvcrt`，Linux/macOS 使用 `flock`，进程崩溃由 OS 自动释放。标定需要同一 `save_dir` 时，先断开 MCP，再启动 WebUI；WebUI 关闭后重连 MCP 并重新 preflight，二者不能同时拥有该目录。

当前尚未实现远程 MCP 的认证/授权/TLS、多用户资源隔离和独立 worker。CLI 与 REST 的安全边界仍是本机 loopback；完整 `hhtools web` composition root 会强制 literal loopback client、唯一 loopback Host，以及浏览器请求的 loopback Origin，并只接受有界、未压缩的请求体。不得把该无认证接口直接绑定公网；跨机器只能让 SSH local forwarding 在服务器 loopback 终止，且这只是当前部署边界，不是已完成的远程集成验收。CLI 调用前必须先启动 `hhtools web`；stdio MCP 不需要另起 Web 服务。active job 在 Web/MCP owner 退出后仍会明确终结为 `JOB_INTERRUPTED`，不会自动续跑；running cancel 在 native solver call 内仍只能等待安全点；旧 solver 仍未把可信 actual GPU device provenance 持久化到 manifest。Interaction-Mesh/OSQP 的真实 solver smoke 也尚未完成，不能从协议测试推断其数值覆盖。

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
| JobSpec v1 | 保存可跨 session 的路径与有效参数；单条 H2R 已有严格 allowlist 重登记升级服务 | 保留读取能力，升级时另存 v2，绝不原地改变 v1 |
| 任务重放 | source-backed Retarget/Batch 可重放，Batch 支持失败项重试 | 通过 v2 的父子关系和幂等语义标准化 |
| 产物持久化 | Batch ZIP 等部分产物已进入任务历史目录 | 扩展为统一 Artifact/Manifest |
| 任务调度 | FIFO admission、运行/等待上限可配置 | 保持默认 `0 = unlimited`，补充 Agent 视图 |
| 结果诊断 | 有跟踪误差、接触和足滑等快速诊断 | 作为 Evaluation 的输入，不夸大为仿真真值 |
| Web/Electron 设置 | 并发与等待队列可持久化配置 | Agent 读取同一服务端配置 |
| Agent 任务控制面 | `JobStore`、`JobManager`、shared admission 与薄 `H2RJobExecutor` 已在 Web composition root 组装；jobs/cancel/retry REST 和严格 JSON CLI 已公开同一服务 | 保持 adapter 薄层，不复制执行逻辑 |
| 统一产物存储 | `ArtifactStore`、Evaluation/Failure/Manifest contract 与终态发布流程已实现；job-scoped list/descriptor/content 只通过 JobManager 的 canonical membership 授权 | MCP resource 继续复用相同 canonical 查询 |
| v1 安全升级 | 单条 H2R JobSpec v1 可经 allowlist 重登记、inspect、preflight 后另存 v2；REST/CLI 薄入口已完成 | 不扩展为 Batch/R2R 或任意路径升级 |
| Agent 协议适配 | `/api/agent/v1`、OpenAPI 示例、resident REST JSON CLI 与本机 stdio MCP 已完成，并有 CLI/REST/service/MCP 协议测试 | Phase 6 增加带认证的远程 Streamable HTTP，不改变业务契约 |

### 3.2 部分实现

| 能力 | 当前局限 | v0.2 目标 |
|---|---|---|
| 任务持久化 | JobStore 已持久化状态；重启将遗留 active job 明确终结为 `JOB_INTERRUPTED`，不会自动续跑 | 独立 worker 阶段再实现真正续跑和所有权恢复 |
| JobSpec 可复现性 | v2 已保存输入、robot、calibration、参数和代码/依赖 provenance；单条 H2R v1 可重新登记并通过薄协议升级；旧 solver 暂不报告可信的 actual GPU device provenance | 在 solver 可提供可靠信息时补 actual device provenance |
| API 参数 | `/api/agent/v1` 已使用版本化 Pydantic request/response；部分非 Agent 的旧 WebUI 路由仍接收裸 `dict` | 旧 WebUI 路由按兼容策略逐步迁移，不影响 Agent 契约 |
| 产物 | 统一 ArtifactStore/descriptor/manifest 已实现，薄 H2R executor 已登记 motion/preview，但旧 Web 路由仍有分散下载与历史目录 | 旧路由逐步统一登记 Artifact；object-interaction PKL 在 portable exporter 完成前保持 fail closed |
| 诊断 | EvaluationReport 及 outcome 已进入 JobManager；现有指标仍是降采样预览轨迹和启发式接触，不是 Isaac/MuJoCo 接触真值 | 当前一律 `review_required`，quality band 只表达启发式区间；以后再用经验证的证据定义通过/拒绝 |
| 上传安全 | 已有路径和格式检查，但扩展名可识别不等于文件可解析 | Asset inspect/preflight 做完整、可操作的检查 |
| 调度 | shared admission 已统一接口、实例和队列语义；当前 JobManager/H2RJobExecutor 仍在 Web 进程内，native solver call 期间取消只能等待其返回 | 阶段 6 将 worker 所有权与客户端/Web 生命周期解耦 |

### 3.3 尚未实现或尚未完成验证/协议接入

- calibration/dataset/video bundle 的实际登记（首版运行时只登记 motion 与 robot bundle）；
- Interaction-Mesh/OSQP 的 object-interaction/terrain-scene 真实 solver smoke，以及更广泛的 robot/reference 覆盖；
- 旧 solver 的可信 actual GPU device provenance；
- 独立 worker 所有权、进程重启后真正续跑，以及多进程/多用户隔离；
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
├── artifacts.py
├── migration.py
└── __init__.py
```

`common.py` 统一 Error/ID/version 原语，`jobs.py` 承载紧凑 Job、progress、queue、ArtifactDescriptor 与 job 操作 request，`artifacts.py` 承载 EvaluationReport、FailureReport 与 JobManifest，`migration.py` 承载公开的 legacy upgrade request/response/receipt。Contracts 不导入 FastAPI、Typer、MCP 或 Vue，也不运行求解器。

### 4.2 Services

当前已落地的核心 `hhtools/services/` 边界包括：

```text
hhtools/services/
├── capabilities.py
├── assets.py
├── asset_service.py
├── plans.py
├── preflight.py
├── retarget.py
├── admission.py
├── job_store.py
├── jobs.py
├── artifacts.py
└── legacy_job_upgrade.py
```

服务方法接收 contract，返回 contract；不得直接输出 Rich 文本。`jobs.py` 只编排注入式 JobExecutor，不包含 IK 数学；Web 层的薄 `H2RJobExecutor` adapter 只绑定原有 H2R loader/grounding/solver/preview/diagnostics/export 入口。`admission.py` 只定义 transport-neutral reservation/handle 协议，现有 Web `JobScheduler` 实现该协议。Phase 4 REST 直接调用这些 service；严格 JSON CLI 则作为常驻 REST 服务的客户端调用同一 `/api/agent/v1`，不在 CLI 中另行组装 service。

### 4.3 Adapters

```text
WebUI / Electron ─────────────► FastAPI / existing Web routes ─┐
JSON CLI ─► resident REST service ─► /api/agent/v1 adapter ────┼─► services
MCP（Phase 5）──────────────────────► MCP adapter ──────────────┘
```

适配器只负责身份、协议、序列化和错误映射，不决定后端、不解析动作、不生成标定。

## 5. 核心数据契约

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
  "request_id": "req_01",
  "status": "ready",
  "plan": {
    "schema_version": "1.0",
    "plan_id": "plan:sha256:91ab...",
    "created_at": "2026-08-31T12:05:00Z",
    "expires_at": null,
    "motion_asset_id": "asset:sha256:2d4f...",
    "robot_id": "g1_29dof",
    "robot_asset_id": "asset:sha256:8a1c...",
    "backend": "newton",
    "calibration_id": "cal:sha256:771e...",
    "output_format": "csv",
    "output_policy": "create_new",
    "parameters": {
      "run_mode": "smoke",
      "limit_frames": 30,
      "reference": "smpl"
    },
    "input_digest": "2d4f...",
    "robot_digest": "8a1c...",
    "calibration_digest": "771e..."
  },
  "checks": [
    {"code": "INPUT_PARSEABLE", "level": "pass", "message": "Motion parsed"},
    {"code": "CALIBRATION_MATCH", "level": "pass", "message": "Calibration hash matches"},
    {"code": "JOB_ADMISSION", "level": "warning", "message": "Concurrency is unlimited"}
  ],
  "recommended_backend": "newton",
  "required_actions": [],
  "error": null
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
  "parent_job_id": null,
  "root_job_id": null,
  "attempt": 1,
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
  "artifact_count": 0,
  "error": null,
  "cancellation_requested": false,
  "cancellable": true,
  "poll_after_ms": 1500
}
```

必须严格区分：

- `state`：`queued | running | completed | failed | cancelled`；
- `outcome`：`success | partial | review_required | rejected`，任务未完成时为 `null`。
- `parent_job_id/root_job_id/attempt`：显式 retry lineage；retry 创建新 job，绝不改写父任务；
- `cancellation_requested`：已经持久化的取消意图；`cancellable`：当前状态是否仍接受取消操作；
- `artifacts`：默认最多返回前 32 个 descriptor；`artifact_count`：完整产物总数。

程序运行完不等于动作质量通过。Batch 部分失败应是 `state=completed, outcome=partial`，不能只用一个模糊的 `done`。

服务层 `JobManager.get_job` 已支持 `after_revision`；无变化时返回同一紧凑 revision，并调整下一次建议轮询间隔，默认不返回完整日志或轨迹。Phase 4 已通过 `GET /api/agent/v1/jobs/{job_id}` 和 `hhtools agent job get` 暴露该能力；Phase 5 的 MCP `get_job` 复用同一参数和响应契约。

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

当前 `ArtifactStore` 已实现上述 descriptor 的受管存储语义：artifact bytes 以 SHA-256 content object 保存，descriptor 以 SQLite WAL 索引；`get(..., verify=true)` 可重新检查大小和哈希。进程内 executor 可以用 `put_file` 将稳定输出复制进受管存储，但源路径不会成为公开 resource URI，也不会写入 portable metadata。

必须区分两层 artifact 视图：`ArtifactStore.list_candidates_for_job()` 返回的是 executor 已写入 object store 的 raw candidates，CAS 冲突或终态竞争后其中可能存在尚未附加到任务的 orphan candidate；`JobStore.artifacts_json` 才是某个 job 的 canonical artifact membership。所有 public list/get adapter 必须调用 `JobManager.list_artifacts/get_artifact`，由 JobStore 成员关系授权并核对 descriptor；不得把 raw candidates 直接暴露为任务产物。raw candidate 查询只用于内部诊断和未来 GC。

首版 artifact kind 至少包括：

- `retargeted_motion`；
- `batch_archive`；
- `preview`；
- `evaluation_report`；
- `failure_report`；
- `job_spec`；
- `manifest`；
- `log_tail`。

JobManager 的正常持久化路径按以下顺序生成审计产物：提交时保存 exact JobSpec v2；完成时生成 EvaluationReport，partial/失败项生成 FailureReport；`completed/failed/cancelled` 三种终态生成 JobManifest。Manifest 记录完整 JobSpec、父子 lineage、时间、最终 state/outcome/error、执行期 provenance、紧凑 summary 和此前所有 canonical 产物 descriptor。Manifest 自身不递归列入自己的 `artifacts`，但其 descriptor 会附加到终态 AgentJobView。若 artifact store 本身故障，fallback 会优先保存真实终态，不能把“状态已终结”误报为“完整 manifest 已发布”。薄 H2R executor 已接入 retargeted motion、最多 600 帧的 representative preview 和启发式 evaluation 数据；完整 export 不因 preview 降采样。真实 dependency-enabled Newton smoke 已验证实际 IK、五种 canonical artifact 与原 Web 入口的逐数值一致性；质量结论仍严格保持为需人工 review 的启发式证据。

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
- `QUEUE_FULL`、`SCHEDULER_UNAVAILABLE`、`JOB_CONFLICT`、`JOB_NOT_FOUND`；
- `JOB_CANCEL_UNSUPPORTED`、`INVALID_JOB_TRANSITION`、`JOB_INTERRUPTED`（正常取消以 `state=cancelled` 表达，不伪装为错误）；
- `ARTIFACT_NOT_FOUND`、`ARTIFACT_HASH_MISMATCH`、`OUTPUT_WRITE_FAILED`；
- `CUDA_OUT_OF_MEMORY`、`SOLVER_FAILED`；
- `INTERNAL_ERROR`。

HTTP、CLI exit code 与 MCP tool/resource failure 已映射到同一个 Error；可预期业务失败不得伪装为内部异常，真正内部异常也不得全部泛化为 400。

## 6. Agent 默认工作流

```text
get_capabilities
        │
register/search asset ─► inspect bundle
        │
list/select robot
        │
preflight_retarget(run_mode=smoke)
   ├─ human_action_required ─► WebUI 标定 ─► 重新 preflight
   ├─ rejected ──────────────► 停止并解释
   └─ ready ────────────────► 得到冻结 smoke 参数的 plan_id
        │
start_retarget(plan_id, idempotency_key)
        │
get_job(after_revision=...)
        │
quality verdict
   ├─ rejected ──────────────► 停止
   ├─ review_required ───────► 请求用户确认
   └─ success
        │
preflight_retarget(run_mode=full) ─► 得到新的 full plan_id
        │
start_retarget(plan_id, idempotency_key)
        │
交付 motion + preview + evaluation + manifest
```

默认先在 preflight 中选择 `run_mode=smoke`，生成绑定 30 帧或等效短片段参数的不可变计划。Job start 只提交 `plan_id + idempotency_key`，不得在任务提交时覆盖 `run_mode`。smoke 经人工/策略判断后，完整任务必须重新以 `run_mode=full` 预检并获得另一个 plan；是否继续属于调用策略，不埋在求解器内部。

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
| `start_retarget` | 提交一个已在 preflight 中冻结为 smoke 或 full 的 `plan_id`，支持 idempotency key；start 不再接收 `run_mode` |
| `get_job` | 紧凑查询状态，支持 revision 增量轮询 |
| `cancel_job` | 请求取消 queued/running job，并返回是否生效 |
| `retry_job` | 由终态 H2R job 创建同一整个 plan 的显式子任务；当前不支持只重试 Batch 失败项 |
| `list_job_artifacts` | 按 job 读取有界、分页的 canonical artifact descriptor，不返回文件 bytes 或宿主机路径 |

独立 `evaluate_job` 可在 EvaluationService 稳定后增加；MVP 中默认在 Retarget 完成后生成评估产物。

### 7.3 MCP resources

大内容通过只读 resource 按需读取：

```text
hhtools://capabilities
hhtools://schemas/agent/v1/{schema_name}
hhtools://robots/{robot_id}
hhtools://assets/{asset_id}/manifest
hhtools://plans/{plan_id}
hhtools://jobs/{job_id}/status
hhtools://jobs/{job_id}/manifest
hhtools://jobs/{job_id}/evaluation
hhtools://jobs/{job_id}/failures
hhtools://jobs/{job_id}/artifacts/{artifact_id}
```

默认 tool 响应只给摘要和 URI；Agent 确有需要时再读取报告。artifact resource 只返回经过 canonical job membership 和 SHA-256/大小复核的 `ArtifactDescriptor`，不把二进制文件、Base64 或宿主机路径注入模型上下文。manifest、evaluation 与 failure resource 会从同一受管文件句柄读取、限制为 2 MiB、复核 hash，并重新按公开 contract 验证。

### 7.4 传输顺序

第一阶段：本机 stdio。

```text
Codex ── stdio ──► hhtools-mcp ──► local services
```

优点是无需先解决公网认证，可直接用固定样例验证 schema、错误和 Agent 工作流。

当前安装与 Codex 配置示例：

```bash
uv sync --extra web --extra retarget --extra mcp
codex mcp add hhtools -- uv run --project /path/to/human-humanoid-tools hhtools-mcp \
  --source /path/to/motions \
  --save-dir /path/to/results
```

也可把等价配置写入项目级 `.codex/config.toml`：

```toml
[mcp_servers.hhtools]
command = "uv"
args = [
  "run",
  "--project", "/path/to/human-humanoid-tools",
  "hhtools-mcp",
  "--source", "/path/to/motions",
  "--save-dir", "/path/to/results",
]
```

`--source`、`--save-dir`、可选 `--cache` 和调度配置都是本机 host 配置，不会作为 tool 参数暴露给 Agent。stdio owner 自己持有 scheduler 和任务生命周期，因此不要同时启动指向同一 `save-dir` 的 Web/Electron/MCP；竞争方会收到可重试、无绝对路径的 `RUNTIME_ALREADY_ACTIVE`。若 preflight 返回 `open_calibration_ui`，正确 handoff 是：断开 stdio MCP → 用同一 source/save 配置启动 `hhtools web` → 人工完成并检查标定 → 关闭 Web → 重连 MCP → 重新 preflight。Skill 和 MCP instructions 都明确禁止读取 WebUI session token。

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

> 当前状态：Phase 4 已完成。`hhtools agent` 是 `hhtools web` 所提供常驻 REST 服务的严格 JSON 客户端；它默认连接 `http://127.0.0.1:8009/api/agent/v1`，可用 `--base-url` 或 `HHTOOLS_AGENT_BASE_URL` 覆盖本机端口或 SSH local-forward endpoint。当前没有内嵌 service/solver 的离线 CLI 模式，也没有远程身份认证，不支持直接连接远程 HTTP 地址。

本机默认先启动常驻服务：

```bash
hhtools web --host 127.0.0.1 --port 8009
```

实际命令命名空间和代表性调用如下。`--request` 接收一个 UTF-8 JSON 文件，也可用 `-` 从 stdin 读取；asset registration request 必须提供部署端允许的 `root_id + relative_path`，不是任意宿主机 `PATH`：

```bash
hhtools agent capabilities --json
hhtools agent asset register --request asset-registration.json --json
hhtools agent asset inspect ASSET_ID --json
hhtools agent asset search --category plain_motion --limit 20 --json
hhtools agent preflight retarget --request retarget-preflight.json --json
hhtools agent job start --plan PLAN_ID --idempotency-key KEY --json
hhtools agent job get JOB_ID --after-revision 17 --json
hhtools agent job cancel JOB_ID --json
hhtools agent job retry JOB_ID --idempotency-key RETRY_KEY --json
hhtools agent artifact list JOB_ID --json
hhtools agent artifact get JOB_ID ARTIFACT_ID --verify --json
hhtools agent artifact get JOB_ID ARTIFACT_ID --verify --output result.bin --json
hhtools agent legacy upgrade --request legacy-jobspec-v1.json --json
```

例如 `asset-registration.json` 的身份输入是服务端根标识与相对路径：

```json
{
  "schema_version": "1.0",
  "root_id": "source",
  "relative_path": "xsens/walk.bvh",
  "recursive": false
}
```

`run_mode`、帧限制、IK 参数和输出策略全部在 `retarget-preflight.json` 中校验并冻结到 `plan_id`；`job start` 没有 `--mode`。当前 `job retry` 创建同一整个 H2R plan 的子任务，不提供 Batch 失败项筛选。

规则：

- JSON 只写 stdout，日志与进度写 stderr；
- 成功与失败都输出版本化 contract；
- exit code 区分参数、预检、任务和内部错误；
- CLI 不自行实现业务逻辑，且调用前必须有正在运行的 `hhtools web`；
- CLI 与 REST 都拒绝重复 key、NaN/Infinity 和额外 JSON 文档；CLI 的 request file/stdin 上限为 8 MiB，REST 普通请求体上限为 1 MiB，legacy upgrade 请求体上限为 64 KiB；
- 完整 `hhtools web` 的 Agent middleware 要求 literal loopback client 与唯一 loopback Host；浏览器携带 Origin 时也必须是 loopback，并且 `Content-Encoding` 只允许缺省或 `identity`；
- artifact descriptor 和 bytes 都必须同时带 `job_id + artifact_id`，下载 bytes 不进入 JSON/Base64，只有显式 `--output` 才经临时文件、大小/SHA-256 复核和原子发布写入目标。

REST 新增版本化命名空间 `/api/agent/v1`，保留现有 WebUI API：

```text
GET    /api/agent/v1/capabilities
POST   /api/agent/v1/assets
GET    /api/agent/v1/assets
GET    /api/agent/v1/assets/{asset_id}
GET    /api/agent/v1/assets/{asset_id}/inspect
POST   /api/agent/v1/preflight/retarget
POST   /api/agent/v1/jobs
GET    /api/agent/v1/jobs/{job_id}
POST   /api/agent/v1/jobs/{job_id}/cancel
POST   /api/agent/v1/jobs/{job_id}/retry
GET    /api/agent/v1/jobs/{job_id}/artifacts
GET    /api/agent/v1/jobs/{job_id}/artifacts/{artifact_id}
GET    /api/agent/v1/jobs/{job_id}/artifacts/{artifact_id}/content
POST   /api/agent/v1/legacy/jobspec-v1/upgrade
```

上述路由均已实现。旧 WebUI 路由没有被一次性删除；REST 调用同一 JobManager/LegacyJobUpgradeService，CLI 再通过 REST 使用相同 contract。artifact list、descriptor 与 content 必须先由 `JobManager.list_artifacts/get_artifact` 验证 job-scoped canonical membership，不能在 adapter 中直接暴露 ArtifactStore raw candidates。任务提交、retry 和 legacy upgrade 在 OpenAPI 中带版本化 request schema 与示例；生命周期、幂等、cooperative cancel、artifact membership/哈希、升级和 CLI/REST/service parity 均有测试覆盖。

## 9. 实施阶段与 PR 切片

每个切片都应可独立 review、测试和回退，不把 UI、算法、契约和 MCP 混入一个超大 PR。

### 阶段 0：冻结契约和回归样例

交付：

- 核心 Pydantic contract families、JSON Schema 和稳定错误码；
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
- SQLite WAL PlanStore、不可变 plan 与 JobSpec v2；
- motion asset、robot asset、preset、URDF、mesh、IK map、DOF、backend 和 calibration/scaler 的交叉绑定；
- 标定缺失的人工接管响应；
- 现有 Web 路由逐项调用 service，输出保持一致。

约束：

- runnable plan 必须同时绑定 `motion_asset_id` 与 `robot_asset_id`；
- plain motion 只路由 Newton；object interaction 与 terrain scene 只路由 Interaction-Mesh；
- Newton 可接受匹配的人工 calibration 或 robot bundle 内受控 scaler；Interaction-Mesh 必须有人工 calibration；
- `.pkl/.pickle/.pt/.pth` 在隔离验证器完成前不得仅凭结构检查进入执行；
- 参数只接受 `run_mode`、`limit_frames`、`ik_iterations`、`human_height`、`retarget_fps` 与 `foot_clamp_anti_penetration`；未知参数、NaN/Inf、bool 冒充整数和 reference 覆盖一律拒绝；
- 默认 `human_height` 沿用 Web 语义：优先使用内容绑定 scaler 的假设值，已知 reference 否则为 `1.65 m`；`ik_iterations <= 200`、`human_height <= 10 m`、实际重采样目标 `<= 1000 Hz`，预测重采样帧数 `<= 100000`；
- 省略 `retarget_fps` 与显式给出源 FPS 统一规范化为源 FPS，使用和运行时相同的 `abs(target-source) < 1e-6` 判定；
- 人工 calibration 与声明的 scaler 都必须属于 robot bundle 的 metadata 清单；保存或修改标定后必须重新登记 robot bundle，再执行 preflight；
- `request_id`、时间戳、宿主机路径、scheduler occupancy 和设备瞬时状态不得进入 `plan_id`。

验收：预检不导入求解 pipeline、不初始化 GPU、不编译 MuJoCo、不反序列化不可信 pickle/checkpoint、不占用正式 GPU 队列；改变资产/标定/有效参数一定改变 `plan_id`；重复相同预检返回同一个计划；现有 H2R/R2R/Batch 回归通过。

### 阶段 3：Agent Job/Artifact 语义（已完成）

已交付：

- SQLite WAL JobStore：不可变 JobSpec v2、请求 fingerprint、idempotency key、state/outcome/revision、取消意图、active 查询和父子 lineage；
- SQLite WAL ArtifactStore：受管 content-addressed bytes、完整 descriptor、哈希复核、稳定 URI 和按 job 列举；
- 紧凑 AgentJobView：revision、queue、lineage、cancellation、最多 32 个 descriptor 和完整 artifact count；
- transport-neutral shared admission 协议，复用现有 JobScheduler 的 FIFO、queue full、精确 queued cancel 与 `0 = unlimited` 语义；
- 注入式 JobManager：幂等提交、`after_revision`、queued/running 取消、父子 retry、partial outcome、结构化失败，以及 JobSpec/Evaluation/Failure/Manifest artifact；
- Web composition root 注入薄 `H2RJobExecutor`：复用原 loader、grounding、`_retarget_single`、preview、diagnostics 和 export，不移动或重写 IK、标定、数值逻辑；
- 单条 H2R JobSpec v1 安全升级：严格解析 raw v1/既有下载 wrapper，将 motion/robot 反查到用途隔离的 allowlisted dynamic root，使用同一个 tracked-provider AssetRegistry 重新登记和 inspect，再调用 PreflightService/RetargetService 生成并另存 v2；不启动 solver、不占 scheduler、不回传 host path；
- 执行身份：JobSpec 在运行开始和求解前 exact double-validation；manifest dataset 决定 loader 路由；robot 使用确切 bundle/preset，manifest 文件经 SHA-256/大小复核后进入按任务隔离的可写快照，loader/Interaction-Mesh fallback 的修复不能回写 registered bundle；Agent asset content identity 参与 cache key；
- 产物语义：preview 最多 600 representative frames，export 使用完整结果；当前只接受 `output_policy=create_new`；object-interaction PKL 因旧 exporter 嵌入 host mesh path 而 fail closed；
- 质量语义：启发式结果一律 `review_required`，`stable/review/high_error/unavailable` 只作为 quality band，不自动通过或拒绝；
- 取消语义：queued job 可以从共享 scheduler 精确移除且 executor 不会运行；running job 只持久化取消意图并发出 cooperative event，直到 executor 在安全点确认前仍保持真实 running 状态，已经完成的结果也可在迟到的取消请求后胜出；Warp、MuJoCo、OSQP 等 native call 只能在返回后响应取消；
- retry 语义：只允许以终态、同 plan/kind 的 job 为 parent，用新 job id 建立 `parent_job_id/root_job_id/attempt` lineage；原任务和原 JobSpec 不会被改写；
- 明确的重启恢复：active job 终结为 `JOB_INTERRUPTED` 并生成失败审计记录，不自动重复调度原 job。
- AgentJobView、ArtifactDescriptor、EvaluationReport、FailureReport 与 JobManifest 均已有同步的 JSON Schema snapshot；Phase 4 加入公开操作与升级契约、Phase 5 加入 RobotListResponse 后，`docs/schemas/agent/v1/` 总数为 21。

已由服务层和 adapter 测试验证：48 路并发重复提交只产生一个 job/一次 executor 调度；artifact attach 和状态更新使用 revision CAS，冲突不会静默覆盖；queued 取消不运行 executor，running 取消等待 cooperative acknowledgement；partial completion 表达为 `state=completed, outcome=partial`；正常终态持久化路径生成 manifest，artifact store 故障时 fallback 仍保存真实终态；响应不包含巨大 trajectory/preview 数组；dataset、RobotBundle identity、输出 containment、output policy 与保守 quality verdict 均 fail closed。

真实 solver 验收使用 Xsens `walk.bvh` 与 G1 29DoF 人工标定，在 RTX 5060 上运行 Newton `30 frames × 24 IK iterations`。实际 `job_spec → retargeted_motion/preview → evaluation_report → manifest` 链路完成，5 个 artifact 通过哈希复核，CSV 为 30×37 有限数值，preview 为 30 帧，manifest 无 host path。与原 Web H2R 入口同参数导出的 `max_abs_error` 和 `mean_abs_error` 均为 `0.0`，源 URDF 保持不变。该 smoke 的启发式 quality band 为 `high_error`，因此终态如设计所要为 `completed/review_required`，不将链路通过误写为效果通过。旧 solver 仍不提供可信的 actual GPU device provenance；Phase 4 只公开已验证的服务语义，不把协议覆盖扩大解释为新的 solver 覆盖。

### 阶段 4：JSON CLI 与 Agent REST（已完成）

已交付：

- `hhtools agent capabilities/asset/preflight/job/artifact/legacy` 严格 JSON 命名空间；CLI 是常驻 REST 服务的客户端，stdout 恰好一个 contract，失败有稳定 exit code；
- `/api/agent/v1` 的 jobs/cancel/retry、job-scoped artifact list/descriptor/content 和 `/legacy/jobspec-v1/upgrade`，并保持已完成 capabilities/assets/preflight 接口兼容；
- JobStartRequest、JobRetryRequest、ArtifactListResponse 与 legacy upgrade request/response/receipt 等公开 contract；Phase 4 完成时 JSON Schema snapshot 总数为 20；
- CLI/REST/service contract parity、REST 生命周期/idempotency/cooperative cancel/whole-plan retry、artifact canonical membership/同一文件句柄哈希下载、legacy migration、strict request JSON、literal-loopback Host/Origin/body-cap 与 CLI 原子校验下载测试；
- OpenAPI Phase 4 路由、versioned request schema 和示例测试。

Phase 4 没有修改 IK、标定、求解参数或导出数值。`run_mode` 在 preflight 冻结，job start 只使用不可变 plan；retry 当前只重跑整个 H2R plan。artifact 路由必须同时提供 job 与 artifact 身份，CLI 大文件下载不经 JSON/Base64。MCP 已在 Phase 5 作为独立薄适配切片交付。

验收已完成：在本机 loopback 的 `hhtools web` 服务上，Agent 无需解析 Rich 文本即可完成预检、提交、轮询和取得产物。SSH tunnel 只是当前跨机部署边界建议，不属于 Phase 4 的远程集成验收。

### 阶段 5：MCP stdio 与 Skill（已完成）

已交付：

- 基于 MCP Python SDK v2 `MCPServer` 的 `hhtools-mcp` 本机 stdio server，以及 `pyproject.toml` 的 `mcp` extra/console entry；
- 11 个有界工具、1 个具体 resource 与 9 个 resource template；输入/成功输出由公共 Pydantic contract 生成，预期失败保留同一 `ApiError`；
- Web/desktop/MCP 共用的跨进程 runtime lease，阻止第二个 JobManager 对 live job 执行 interrupted recovery 或另建 GPU scheduler；
- MCP contract/integration tests：精确 surface、禁止 shell/path/Base64、human-action stop、revision polling、job-scoped artifacts、结构化错误，以及真实 stdio 子进程 framing/negotiation/tool round-trip；
- HHTools Skill：capabilities → preflight → smoke → evaluate → human review → approved full → manifest，并包含标定 handoff、错误恢复和结果审核参考。

验收结果：MCP 客户端已能在不调用 shell、不读取 WebUI session token 的情况下通过真实 stdio 连接完成固定、可重复的协议样例；需要标定时 `human_action_required` 不会触发 `start_retarget`，而是暂停并给出 WebUI handoff。Phase 3 已单独证明同一 service/executor 的真实 Newton/G1 solver 数值 parity；Phase 5 没有重复声称 MCP 协议 fixture 又扩大了机器人、reference 或 Interaction-Mesh 的数值覆盖。

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

- [x] `CapabilitiesService`、REST 与 MCP `get_capabilities` 准确报告后端依赖、特性、transport 可用性与 `0 = unlimited` 调度模式；
- [ ] execution-backend device reporting 同时覆盖 Torch 与 Warp/Newton；当前 Windows 环境的 CPU-only Torch probe 会漏报 Warp 实际使用的 RTX 5060；
- [x] 三类动作和机器人文件可登记为 AssetBundle；
- [x] Agent 契约、计划、任务和产物不持久化远程宿主机任意绝对路径；
- [x] 损坏输入、缺少 mesh、后端不兼容和标定缺失在入队前被发现；
- [x] 成功预检返回不可变 `plan_id` 与 JobSpec v2；
- [x] JobManager 服务层任务提交支持 idempotency key；
- [x] Web composition root 注入复用原 H2R 入口的薄 JobExecutor adapter；
- [x] 单条 H2R JobSpec v1 可经 allowlist 重登记、inspect、preflight 安全升级并另存 v2；
- [x] AgentJobView 不携带完整 trajectory/preview；
- [x] JobManager 可将部分失败表达为 `outcome=partial`；
- [x] JobManager 正常终态路径生成 manifest 和完整 artifact 哈希；
- [x] 在真实 solver 依赖环境完成 H2R smoke 并验证实际 IK 输出及原 Web 入口数值 parity；
- [x] CLI 与 REST 使用同一版本化 contract；REST 调用 service，严格 JSON CLI 作为 resident REST client 与 service 行为通过 parity 测试；
- [x] MCP 使用 `MCPServer`，真实 stdio 子进程可完成协商、发现、结构化 tool/resource round-trip 与固定协议 smoke；
- [x] 缺少标定时 Agent 停止并交给 WebUI；
- [x] 阶段 0—5 未修改现有算法、数值默认值和导出语义。

以上已勾选项包括应用服务、shared scheduler、薄 H2R executor、真实 dependency-enabled Newton IK smoke、jobs/artifacts/v1-upgrade REST、严格 JSON CLI、本机 stdio MCP 与 Agent Skill。smoke 的 `review_required` 表明质量尚需人工判断，不会因为链路或协议成功而被伪装为效果通过。阶段 0—5 的本机 MVP 已完成；actual GPU provenance 仍是已知缺口，不把该未勾选项伪装为已经验收。

### 正式远程版本（阶段 6）

- [ ] Agent 或 Electron 断开后 GPU 任务继续；
- [x] JobStore 记录在服务重启后不丢失，当前 `JOB_INTERRUPTED + retry_job` 恢复策略明确且可审计（不代表续跑）；
- [ ] 远程 MCP 具有认证、授权、TLS 和审计；
- [ ] 多用户资产、任务和产物隔离；
- [ ] 独立 worker 场景下 queued/running 任务可可靠取消；当前 queued 可精确取消，running 仅能在 native call 返回后的 cooperative 安全点确认；
- [ ] 每个结果可由 manifest 追溯输入、代码、标定、依赖和设备；
- [ ] 相同业务语义在本地 stdio 与远程 Streamable HTTP 中一致。

## 11. 下一轮实际开发范围

契约、AssetRegistry、Preflight、持久任务/产物语义、真实 solver parity、REST/严格 JSON CLI、本机 stdio MCP 与 HHTools Skill 均完成后，下一轮进入 Phase 6 的持久 worker 与远程 GPU：

1. 将 job ownership 与 GPU executor 从 Web/MCP 客户端进程中分离，让客户端断开或升级不会中断 active job，同时定义可靠的 worker heartbeat、claim/lease、恢复和取消安全点；
2. 在不改变当前 21 份 public schema 业务语义的前提下增加带认证、细粒度授权、TLS、审计和限流的 Streamable HTTP MCP，并实现跨机器 asset upload/registration；
3. 为资产、计划、任务和产物增加多用户 owner/tenant 隔离；把可信的实际 Torch/Warp/Newton device provenance 写入 terminal manifest；再补 Interaction-Mesh/OSQP 的真实 solver smoke。

Phase 5 仍以本机 stdio 和 localhost 服务为边界；如需跨机器访问现有 REST，只能经 SSH loopback tunnel，CLI 仍要求 `hhtools web` 正在运行。stdio MCP 独立持有本机 runtime，不需要 Web 常驻，但不能和指向同一 `save-dir` 的 Web/Electron 同时运行。阶段 6 之前继续采用“owner 退出后将 active job 审计为 `JOB_INTERRUPTED` 并显式 whole-plan retry”的恢复策略，不承诺跨进程续跑，也不承诺远程认证/授权或多用户隔离。这样即使后续 worker、MCP SDK 或传输方式变化，HHTools 的资产、计划、任务和产物身份仍然稳定。

## 12. 一句话原则

**先把 HHTools 建成具有稳定资产身份、不可变预检计划、紧凑任务状态、可追溯产物和可操作错误的应用服务，再让 MCP 与 Skill 成为 Agent 的薄入口；绝不让 MCP 复制 CLI，更不借 Agent 适配修改已经能工作的机器人算法。**
