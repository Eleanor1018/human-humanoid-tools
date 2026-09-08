# HHTools CLI 与 Agent 能力扩展计划

## 目标

在保持现有 H2R Agent 安全边界和兼容性的前提下，逐步让 CLI、REST 与 MCP
覆盖 HHTools 的核心工作流。首轮范围包括：

- revision-aware 作业等待；
- H2R Interaction-Mesh 正式验收；
- Robot-to-Robot（R2R）；
- H2R / R2R Batch；
- 标定状态检查与候选建议。

Video-to-Motion 和 Analysis 暂不进入本轮实现。

## 实施状态

- [x] 阶段 1：revision-aware `wait_job`（service、REST、MCP、JSON CLI、Agent skill）
- [ ] 阶段 2：H2R Interaction-Mesh 正式验收
- [ ] 阶段 3：R2R
- [ ] 阶段 4：H2R / R2R Batch
- [ ] 阶段 5：标定辅助

## 设计原则

1. **一个作业生命周期**：不同工作流拥有各自的 preflight，但共用
   `start / wait / get / cancel / retry / artifacts`。
2. **先计划后执行**：任何求解或批处理都必须由不可变 plan 启动，并使用调用方提供的
   idempotency key。
3. **人机边界明确**：Agent 可以检查标定、生成候选并验证候选；正式保存或用于 full run
   仍需人类确认。
4. **接口兼容**：现有 `preflight_retarget`、`start_retarget`、REST 路径和 JSON CLI
   在 v1 生命周期内保留。
5. **结果可移植**：默认响应保持紧凑，不嵌入轨迹、视频、网格或宿主机绝对路径；大内容
   继续通过受校验 artifact 暴露。
6. **共享实现**：MCP、REST、JSON CLI 和未来的人类 CLI 只做适配，不复制求解、标定、
   调度或产物逻辑。

## 当前能力基线

| 能力 | 当前状态 | 本轮目标 |
| --- | --- | --- |
| H2R / Newton | 已支持 | 保持兼容 |
| H2R / Interaction-Mesh | 底层部分接通，缺少正式 E2E 与文档 | 正式验收 |
| R2R | Web 支持，Agent 未暴露 | 增加 Agent preflight 与执行 |
| H2R / R2R Batch | Web 支持，Agent 未暴露 | 增加有界批处理计划与聚合结果 |
| Video-to-Motion | 仅 Web / 独立 GVHMR 环境 | 暂缓 |
| Analysis | Web 支持 | 暂缓 |
| 自动标定 | 仅人工 GUI 标定 | 增加状态检查、候选与验证；保留人工保存 |

## 目标接口

### 共享作业接口

```text
start_job(plan_id, idempotency_key)
wait_job(job_id, after_revision, timeout)
get_job(job_id, after_revision?)
lookup_job(plan_id, idempotency_key, after_revision?)
cancel_job(job_id)
retry_job(job_id, idempotency_key)
list_job_artifacts(job_id, limit, offset)
export_artifact(job_id, artifact_id)
```

现有 `start_retarget` 作为兼容别名保留。新增工作流不再复制一套作业查询、取消和产物接口。

### 工作流 preflight

```text
preflight_h2r(request)
preflight_r2r(request)
preflight_batch(request)
```

现有 `preflight_retarget` 作为 `preflight_h2r` 的兼容名称保留。

### 标定辅助

```text
get_calibration_status(request)
propose_calibration(request)
validate_calibration(request)
```

`propose_calibration` 只生成可审查候选，不写入正式 calibration。候选必须包含输入资产
identity、算法版本、约束、警告和验证结果。正式保存继续通过 GUI 或未来带明确人类确认的接口完成。

## 阶段 1：`wait_job`

### 契约

```text
wait_job(
    job_id: str,
    after_revision: int,
    timeout: float = 30,
) -> AgentJobView
```

- `timeout` 必须有限且有上限，首版范围为 `0..60` 秒；
- 作业已 terminal 时立即返回；
- 当前 revision 大于 `after_revision` 时立即返回；
- revision 未变化时等待，超时后返回当前快照；调用方通过 revision 是否变化判断超时；
- `after_revision` 不能大于当前 revision；
- 取消一次等待不得取消作业；
- 作业状态变化应通过条件变量或事件唤醒，不使用高频 sleep 轮询；
- MCP、REST 与 JSON CLI 必须共享同一 service 方法和错误契约。

REST 兼容路径：

```text
GET /api/agent/v1/jobs/{job_id}/wait?after_revision=N&timeout=30
```

JSON CLI：

```text
hhtools agent job wait JOB_ID --after-revision N --wait-timeout 20
```

JSON CLI 的既有 `--timeout` 表示整个 HTTP 请求超时，因此等待时要求它大于
`--wait-timeout`；MCP 与 REST 参数仍使用 `timeout`。

### 验收

- revision 已更新、超时、terminal、未知 job、非法 revision 和非法 timeout 均有测试；
- 多个等待者能被同一次进度更新唤醒；
- 等待者取消或超时后不遗留线程和锁；
- MCP live schema、REST OpenAPI 与 JSON CLI help 都声明相同边界；
- 原有 `get_job` 行为不变。

## 阶段 2：H2R Interaction-Mesh 正式验收

- 补齐 object-interaction 与 terrain-scene 的 Agent E2E fixtures；
- 验证 backend 自动路由、manual calibration、输出格式和场景 artifact；
- 验证取消、失败报告、execution provenance 和 portable export；
- 更新 capability、Agent 文档和示例；
- 完成之前继续标记为 experimental，不对外承诺正式支持。

## 阶段 3：R2R

- 定义 source trajectory、source robot、target robot 与 pair calibration 的不可变 identity；
- 增加 R2R asset inspection 与 `preflight_r2r`；
- 复用共享 JobManager，新增 R2R executor adapter；
- 对 source/target 不匹配、缺少 pair calibration、过期计划和场景输入进行前置拒绝；
- 产物沿用现有 CSV / scene bundle / diagnostics，并补齐 provenance；
- CLI 增加 `hhtools retarget r2r`，交互首页与 GUI 使用相同术语。

## 阶段 4：Batch

- 首版只覆盖 H2R 与 R2R Batch；
- preflight 冻结有序输入列表、每项 hash、机器人、标定、backend、输出策略和资源上限；
- 明确 `success / partial / review_required / rejected` 聚合语义；
- JobProgress 提供 `completed_items / total_items`，默认响应不包含无界逐项数组；
- 完整逐项结果写入 manifest / failure report artifact；
- 取消必须停止未启动条目，并在安全边界协作取消当前条目；
- retry 创建新子 attempt，不修改原批任务；
- CLI 增加 `hhtools batch h2r` 与 `hhtools batch r2r`。

## 阶段 5：标定辅助

- `get_calibration_status`：只读返回 reference、来源、hash、约束与缺失项；
- `propose_calibration`：通过拓扑推断与参考姿态生成候选；
- `validate_calibration`：计算关节限制、关键点映射、足底、对称性和可达性检查；
- 候选不得静默保存，不得直接触发 full run；
- preflight 继续在缺少已确认标定时返回 `human_action_required`；
- GUI 能读取候选、显示差异并由人类确认保存。

## CLI 首页目标

```text
Workflows
  Human -> Robot
  Robot -> Robot
  Batch

Tools
  Convert Motion
  Robots
  System Check

Open
  WebUI
  Desktop GUI
```

完整参数调用保持非交互；真实 TTY 中缺少参数时可以进入简洁向导。Agent 和 CI 使用
`--json` 或 MCP，永不收到交互提示、ANSI 进度或非结构化第二份输出。

## 提交与发布顺序

1. `feat(agent): add revision-aware job waiting`
2. `test(agent): verify interaction-mesh execution`
3. `feat(agent): add robot-to-robot workflow`
4. `feat(agent): add bounded batch workflows`
5. `feat(agent): add calibration proposals`
6. `feat(cli): expose r2r and batch workflows`

每个阶段必须独立通过 Python 回归、MCP live schema 测试、REST 测试、JSON CLI 测试、
Ruff 和 wheel 内容检查；不得通过扩大 legacy baseline 或跳过关键测试来换取绿灯。
