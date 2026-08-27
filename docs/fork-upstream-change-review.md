# hhtools Fork 与 Roboparty Upstream 变更审计清单

> 审计日期：2026-08-27  
> 我方审计对象：`origin/style/inspector1` / `213a3b8`  
> 上游基线：`upstream/main` / `ee493e3`  
> 历史分叉点：`320bf1f`  
> 统计口径：只统计已提交的 Git 树；不包含工作区中的并发未提交改动。
> Review 跟进：RP0 删除、B03 队列化和 B04 上传预检是本轮尚未提交的修订，故不计入上面的历史提交/文件统计。

## 1. 必须优先 Review：我方非 UI/UX 后台业务改动

这一节必须先于界面改动 review。我们的 18 个独有内容提交中，有 **9 个提交会影响生产后台行为**；按可独立评审的业务边界拆成下面 **11 组生产改动（6 组 Bugfix/安全可靠性修复、4 组后台能力、1 组机器人资产）**。其中上传安全、资源回收、任务重放、文件物化和导出 schema 都不只是界面配套代码。

先划清算法边界：我方相对当前 `upstream/main` **没有净修改** `hhtools/core/**`、`hhtools/retarget/**`、`hhtools/robot/**` 或 `hhtools/io/**`，所以没有额外改变 IK、scaler、grounding 或 solver 算法。当前分支里的 100STYLE/Xsens 和 R2R ground 算法变化来自已同步的 Roboparty 提交，见第 2 节。

### Review 前必须知道的四项高优先级发现

1. **[已处理] RP0 URDF 是未完成的孤立资产。** 它没有被 preset、registry 或生产代码引用；其 24 个唯一 STL 引用在当前仓库中全部缺失，因此不能独立加载。人工 review 已决定删除，工作区中现已删除该文件。
2. **[中高] JobSpec 目前不是严格“实验复现”。** v1 没有记录输入哈希、代码 commit、robot preset/标定内容版本、依赖和设备信息；同一路径文件被替换后会静默重跑新内容。准确称呼应是“按路径与参数重放”。
3. **[中] 多文件上传不是请求级事务。** 全部文件先通过尺寸校验，然后每个 destination 分别原子 `replace`；如果发布循环中发生 I/O 故障，仍可能留下已发布的子集。
4. **[中] Motion Library 目录 fallback 会先删除同名旧目录再复制。** 复制中断可能丢失旧 library；hard link 还会和源文件共享同一份内容。

### B01. Electron 本地 sidecar 与安全边界

- [ ] Review 启动、鉴权、健康检查和退出流程。
- 性质：新增后台运行模式 / 安全边界。
- 业务变化：Electron 分配随机 loopback 端口和会话 secret，启动 Python FastAPI sidecar，健康检查成功后才展示工作区；退出时终止 Python 进程树。
- 关键代码：
  - [`hhtools/cli/desktop_sidecar.py`](../hhtools/cli/desktop_sidecar.py)
  - [`desktop/src/main/sidecar-supervisor.ts`](../desktop/src/main/sidecar-supervisor.ts)
  - [`desktop/src/main/security/configure-session.ts`](../desktop/src/main/security/configure-session.ts)
  - [`desktop/src/main/ipc/validate-ipc-sender.ts`](../desktop/src/main/ipc/validate-ipc-sender.ts)
  - [`hhtools/web/server.py`](../hhtools/web/server.py#L5449)
- 测试：`tests/web/test_desktop_sidecar_security.py`、`desktop/tests/sidecar-supervisor.test.ts`、`desktop/tests/app-lifecycle.test.ts`。
- Review 重点：secret 不应进入命令行或 Renderer；仅允许可信 origin；关闭窗口时必须等待子进程退出。
- 当前限制：安装包只包含 Electron 壳，仍依赖本机 Python/hhtools checkout；Remote GPU 模式目前只有方案，没有实现。

### B02. 上传路径与目录穿越防护

- [ ] Review 所有上传入口是否统一经过同一套路径校验。
- 性质：**安全 Bugfix**。
- 原实现：六个上传路由直接执行 `rel = Path(upload.filename)`、`dst = drop / rel`，随后创建父目录并写文件。没有检查 absolute path、drive 或 `..`；绝对路径会绕开 `drop`，父目录段则可能写到它的上级。Robot 的 `name` 也直接参与 `state.robot_root / name`。
- 当前限制分两层：
  - 语法层：将 `\` 统一为 `/`；拒绝空/NUL、POSIX/Windows 绝对路径、Windows drive 和任意 `..` 段。
  - 解析层：对最终 destination 执行 `resolve(strict=False)`，再用 `relative_to(resolved_root)` 确认它仍位于上传根目录下。
  - Robot 名称必须恰好一个 path segment；Motion Library label 会把 `/`、`\` 等非法字符替换为 `_`，不能再形成子目录。
- 可移植性：语法层同时使用与宿主系统无关的 `PurePosixPath` 和 `PureWindowsPath`，因此 Linux/macOS 服务也会拒绝 Windows drive、UNC 路径和反斜杠形式的 traversal；解析层再使用当前宿主的 `Path.resolve()` 做 containment。它不是“只适用于 Windows”的规则。
- 尚未覆盖的是跨平台**文件名等价性**，例如 Windows 保留名/ADS、macOS Unicode normalization、大小写碰撞和本机恶意进程制造的 symlink TOCTOU；这些不影响当前目录穿越判断，但若以后支持不可信的多租户 remote 服务，应继续硬化。
- 覆盖端点：`/api/dataset/upload`、`/api/basket/upload`、`/api/motion/upload`、`/api/robot/upload`、`/api/r2r/source/upload`、`/api/r2r/basket/upload`。
- 拒绝时返回 HTTP 400，并给出 `detail`，例如 `upload filename must be relative`、`upload filename contains a parent-directory segment`、`upload path escapes its destination` 或 `upload directory name must contain one path segment`。
- 关键代码：[`hhtools/web/server.py`](../hhtools/web/server.py#L120)、[`hhtools/web/motion_library_links.py`](../hhtools/web/motion_library_links.py)
- 测试：[`tests/web/test_upload_security.py`](../tests/web/test_upload_security.py)
- Review 重点：`motion_library_links` 内部函数仍依赖调用方先完成安全校验；今后增加 CLI/remote 调用入口时不能绕过 server 边界。

### B03. 上传、并发任务与结果保留上限

- [ ] Review 默认限制是否适合实际服务器和公开部署。
- 性质：**稳定性 / 资源耗尽 Bugfix**。
- 默认值：4096 文件、2 GiB/文件、8 GiB/请求、**运行并发不限（0）**、**等待队列不限（0）**、64 条终态保留任务、1 小时内存任务 TTL。
- 业务变化：上传改为分块写临时文件，整批通过尺寸校验后再逐文件原子发布；增加可选 FIFO 调度；过期/溢出的终态任务和受管 artifact 会被清理。
- 默认不替专业用户猜测 GPU 能力：`max_running_jobs=0` 保持旧版“每个任务立即启动”的行为，并且此时 queue 配置不生效。只有显式设置 `max_running_jobs>0` 才启用并发闸门和 `pending` 等待状态。
- `max_queued_jobs=0` 表示等待队列不限长度；正数 N 表示 waiting 容量为 N。有限模式按 `running + pending + reserved <= max_running + max_queued` 做 admission，因此上传前 reservation 也会暂时占一个槽位。队列满时新任务返回 HTTP 429，而不是丢弃旧任务。
- FIFO 以 reservation 最终 `submit()`/入队的先后为准，不以 HTTP 到达或取得 reservation 的时刻为准；两个并行上传完成写盘的顺序不同时，后到的请求可能先入队。
- 上传型后台任务会在应用把 `UploadFile` 写入 hhtools 受管 upload drop、或发布到 Motion Library 前预留 admission；如果有限队列已经满，服务器会先拒绝，不会留下孤立 upload drop，也不会先覆盖 Motion Library。Starlette multipart parser 在路由执行前产生的临时 spool 不属于这层保证。
- 关键代码：[`hhtools/web/server.py`](../hhtools/web/server.py#L55)、[`hhtools/web/server.py`](../hhtools/web/server.py#L401)、[`hhtools/web/server.py`](../hhtools/web/server.py#L480)、[`hhtools/web/server.py`](../hhtools/web/server.py#L678)
- 测试：[`tests/web/test_resource_limits.py`](../tests/web/test_resource_limits.py)
- Review 重点：8 GiB 请求虽然有界但仍很大；默认不限并发是明确的产品选择，不等于自动显存保护；公网或共享服务应显式配置上限；multipart parser 可能在应用层限制前已产生 spool 消耗；反向代理还应设置独立限制；只能删除 `export_root` 下的受管 artifact，不能碰用户源数据。调度上限只覆盖 Web Job，不覆盖独立的 Warp/Newton robot prewarm 线程。

具体触发行为：

| 限制 | 检查方式 | 超限响应/清理 |
|---|---|---|
| 4096 文件/请求 | FastAPI 形成 `files` 列表后检查 `len(files)` | HTTP 413：`too many upload files (limit: 4096)`；不发布文件 |
| 2 GiB/单文件 | 以 1 MiB chunk 流式计数 | HTTP 413，detail 包含上限和相对文件名；删除 `.upload` 临时文件 |
| 8 GiB/整个请求 | 有合法 `Content-Length` 时由 middleware 提前拒绝；无/不可信 header 时仍在 chunk 流中累计 | HTTP 413：`upload request exceeds 8589934592 bytes`；非法 Content-Length 返回 400 |
| running job（默认 0） | 0 时每个任务立即启动；正数时统一 `JobScheduler` 只启动指定数量 | 超额任务进入 FIFO，并以 `pending` 暴露给 API/UI |
| waiting job（默认 0） | 仅 running 为正数时生效；0 为不限，正数为等待容量；reservation 计入 admission | 有限队列满时 HTTP 429：`job queue is full (waiting limit: N)`；受管 upload 目录写盘前检查，不包含 multipart spool |
| 64 个 retained job | 只裁剪 terminal job；内存按终态时刻、持久历史按创建时刻从旧到新，pending/running 不计入上限 | active 记录允许临时超过 64，确保重启时能恢复为 interrupted error；终态溢出时删除最旧记录及受管 artifact |
| 3600 秒 TTL | 仅针对 terminal job；按 `max(terminal_since, last_accessed_at)` 计算 | 下次 list/get/register 触发 prune；pending/running job 不因 TTL 删除 |

配置入口：

- Web CLI：`--max-running-jobs N`、`--max-queued-jobs N`。
- Web/Electron 环境变量：`HHTOOLS_MAX_RUNNING_JOBS`、`HHTOOLS_MAX_QUEUED_JOBS`；显式 CLI 参数优先。
- Electron 只精确放行这两个非敏感变量，不放行任意 `HHTOOLS_*`，避免未来 token/secret 意外进入 sidecar。
- `/api/health` 和 `/api/jobs` 会返回调度模式、配置以及 running/queued/reserved/cancelling/closed 状态。

单卡 4090 的部署建议是从 `1/32` 开始，轻作业混跑可实测 `2/32`；H200、多 GPU 或充足 CPU-only 工作负载可以自行配置 8、16 或更高。它们只是建议值，项目默认仍为 `0/0`，不强制限制专业用户。

这里的 cap 不是整个 Python 进程的 GPU semaphore：选择机器人时触发的可选 Warp/Newton prewarm 仍在独立 daemon thread 中，可能和受调度 Job 并行。若将来要求严格的进程级显存隔离，需要再增加共享 GPU gate；不能直接把 prewarm 放进当前单槽队列，否则 retarget 等待 queued prewarm 时可能自锁。

FastAPI lifespan 退出时先关闭 admission：未形成 Job 的 reservation 失效，pending 从队列移出并由独立 daemon cancellation thread 异步标为 error；同一个 5 秒预算同时等待 running worker 和 cancellation callback。全部退出后立即清理本进程的 upload/export 临时目录和 motion cache；超时时暂留其输入并启动 daemon 延迟清理。正常解释器退出还会通过 `atexit` 对这些 session-owned 根做一次 best-effort 清理，但强制终止、`os._exit` 或进程崩溃不会运行回调，仍可能留下系统临时目录；启动时清扫属于后续硬化项。robot prewarm 不在 scheduler 的 shutdown 等待范围内。上述清理不会删除 robot preset、save directory 或持久化任务历史。

### B04. 不支持的动作文件返回 HTTP 400

- [ ] Review API 错误映射是否覆盖所有 loader 的“用户输入错误”。
- 性质：**API 正确性 Bugfix**。
- 原行为：同一个 `enumerate_upload_clips(...)` 判断连续出现两次；第一个分支抛出未处理的 `FileNotFoundError`，导致后面的 HTTP 400 分支永远不可达，生产服务通常表现为 500。
- 当前行为：删除不可达的 `FileNotFoundError` 分支，并在临时 upload drop 上先枚举可支持文件，成功后才发布到 Motion Library。不支持的 motion 文件不会创建新 library、不会替换同名旧 library，并会清理 rejected drop。排队任务始终从各自不可变的 request drop 解析，解析完成后才在进程内串行发布；后来的同名上传不会偷换前一个任务正在读取的字节。它被视为客户端输入错误，并返回带信息的 JSON，不是“纯 400”：

  ```json
  {
    "detail": "未找到可识别的动作文件（.npz / .bvh / .glb / .pkl …）"
  }
  ```

- 空文件列表是另一条 400：`{"detail":"empty upload"}`。
- 关键代码：[`hhtools/web/server.py`](../hhtools/web/server.py)
- 测试：[`tests/web/test_upload_security.py`](../tests/web/test_upload_security.py)
- Review 重点：该预检确认的是可识别扩展名，不等于完整解析事务；伪造或损坏的 `.bvh/.npz` 仍可能在后台解析阶段失败。不要把真正的内部异常也泛化为 400，否则会掩盖后台缺陷。

### B05. Motion Library 的 Windows symlink 回退

- [ ] Review symlink、hard link、copy 三种物化结果是否符合数据管理预期。
- 性质：**Windows 兼容 Bugfix**。
- 业务变化：单文件优先 symlink；Windows 无权限时回退到同盘 hard link，再回退为 copy。目录 symlink 失败时，如已有浏览器上传树则复制该树。
- 关键代码：[`hhtools/web/motion_library_links.py`](../hhtools/web/motion_library_links.py#L468)、[`hhtools/web/motion_library_links.py`](../hhtools/web/motion_library_links.py#L611)
- 测试：[`tests/web/test_motion_library_links.py`](../tests/web/test_motion_library_links.py)
- Review 重点：hard link 与原文件共享内容；copy 会增加磁盘占用；目录 symlink 没有 hard-link 等价物；同名目录替换并非事务，复制失败时旧目录已经删除。进程内同名发布由 lock 串行化并采用 last-writer-wins，但没有跨进程文件锁；旧 job/basket 的 `source_path` 仍可能指向这个可变 label，后续覆盖会改变它实际读取的内容。

### B06. 持久化任务历史、JobSpec 与按路径重放

- [ ] Review任务记录、重启恢复、重放和 artifact 所有权边界。
- 性质：后台业务功能 / 可重放任务能力。
- 业务变化：
  - 任务记录按文件原子写入用户数据目录；服务重启后将遗留的 running/pending 任务恢复为可操作失败状态。
  - `JobSpec v1` 移除 session token，只保存可跨进程使用的有效参数。
  - 支持配置校验、任务重跑、失败项重跑、复制配置、下载配置、生成等价 CLI。
  - 完成后的下载 artifact 从临时目录迁入持久化任务目录。
- 关键代码：
  - [`hhtools/web/job_history.py`](../hhtools/web/job_history.py#L25)
  - [`hhtools/web/job_specs.py`](../hhtools/web/job_specs.py#L45)
  - [`hhtools/utils/paths.py`](../hhtools/utils/paths.py#L47)
  - [`hhtools/web/server.py`](../hhtools/web/server.py#L2356)
- 测试：`tests/web/test_job_history.py`、`tests/web/test_job_history_store.py`、`tests/web/test_job_specs.py`。
- Review 重点：当前 JobSpec 仍保存服务器绝对路径，且不保存输入哈希、代码 revision、配置内容版本或依赖环境，不能宣称 bitwise/严格复现；`shlex.join` 是 POSIX quoting，尚未真实验证复杂命令在 cmd/PowerShell 的执行；store 只有线程锁而没有多进程锁。Remote GPU 模式必须改成 allowlisted asset ID/逻辑路径，不能把任意宿主机路径暴露给客户端。

### B07. 标定参考骨架序列化

- [ ] Review heading 四元数的乘法方向及前端坐标轴是否一致。
- 性质：后台数据契约增强。
- 业务变化：参考骨架 payload 新增 `canonical_names` 和 `quaternions`；heading 编辑同时旋转位置和朝向，避免骨架已转向但 arcball/关节轴仍留在旧方向。
- 关键代码：[`hhtools/web/calibration_session.py`](../hhtools/web/calibration_session.py#L134)
- 测试：[`tests/web/test_calibration_session.py`](../tests/web/test_calibration_session.py)
- Review 重点：确认 `heading_q * joint_q` 与 hhtools 的 world/local 四元数约定一致。

### B08. H2R/R2R 结果诊断计算

- [ ] Review 指标含义、阈值和产品文案，避免被误当成仿真指标。
- 性质：后台分析功能。
- 业务变化：基于网页实际渲染的降采样轨迹计算 mapped-effector mean/P95/max error、逐帧曲线、脚接触一致率和接触期滑移。
- 关键代码：[`hhtools/web/result_diagnostics.py`](../hhtools/web/result_diagnostics.py#L235)、[`hhtools/web/server.py`](../hhtools/web/server.py)
- 测试：[`tests/web/test_result_diagnostics.py`](../tests/web/test_result_diagnostics.py)
- Review 重点：接触使用“第 5 百分位高度 + XY 速度”启发式（默认 0.05 m、0.35 m/s），不是碰撞、接触力或 Isaac/MuJoCo 真值；只能用于快速筛查。

### B09. Interaction object CSV 增加尺寸字段

- [ ] Review下游 CSV 消费者的 schema 兼容性。
- 性质：**导出数据完整性 Bugfix**。
- 业务变化：`OBJECT_CSV_HEADER` 和每一帧新增 `ext_x/ext_y/ext_z`，即使 OBJ sidecar 或文件头元数据丢失，截取后的 CSV 仍携带物体尺寸。
- 关键代码：[`hhtools/web/export_bundle.py`](../hhtools/web/export_bundle.py#L67)、[`hhtools/web/export_bundle.py`](../hhtools/web/export_bundle.py#L289)
- Review 重点：严格按旧 8 列读取的外部脚本需要升级；尺寸是 clip 内常量，但为 CSV 自描述而逐行重复。

### B10. Windows CLI UTF-8 输出

- [ ] Review嵌入式 host、重定向和关闭 stream 的兼容性。
- 性质：**CLI 兼容 Bugfix**。
- 业务变化：CLI 启动时尽力将 stdout/stderr 配为 UTF-8 + replacement error handling；不支持 `reconfigure` 的 StringIO/host stream 安全跳过。
- 关键代码：[`hhtools/cli/_stdio.py`](../hhtools/cli/_stdio.py#L24)、[`hhtools/cli/main.py`](../hhtools/cli/main.py)
- 测试：[`tests/test_cli_stdio.py`](../tests/test_cli_stdio.py)

### B11. 已删除 RP0.1.2 孤立机器人资产

- [x] 已选择删除该未完成资产。
- 性质：非 UI 数据资产。
- 历史变化：提交 `d3fb7e8` 曾新增 `hhtools/meshes/01_RP0.1.2_20260814.7.urdf`，约 1237 行。
- 删除原因：没有 preset/registry/代码引用；24 个唯一 `../meshes/*.STL` 引用全部缺失；没有加载测试，也不能对外声明为“已支持机器人”。
- 当前状态：文件已从工作区删除，待 review 后随本文和注释一起提交。

### B12. 纯测试修正：terrain overlay scale

- [ ] Review 测试是否还保留独立 oracle。
- 性质：测试修正，不改变生产行为。
- 变化：[`tests/web/test_scaled_overlay_terrain.py`](../tests/web/test_scaled_overlay_terrain.py) 不再硬编码 `ratio=0.8`，改用生产 `uniform_overlay_scale_for_motion(...)`。
- Review 重点：fixture 与生产配置更一致，但测试与实现共用 helper 时，helper 自身回归可能被两边同时继承；最好另留已知输入→已知 ratio 的独立测试。

## 2. 已同步、但属于 Roboparty 上游的后台改动

下面两项已经通过 merge `213a3b8` 进入我方分支，但作者归属仍是 Roboparty；将来向原作者提 PR 时不能把它们重复写成我方贡献。

### U01. 100STYLE / Xsens bind pose 修复与数据集支持

- 上游提交：`619c112 ADD：100style`，9 个文件，`+176/-35`。
- 实际内容不只是 ADD：新增 100STYLE/Xsens 扫描映射，同时修复 Xsens 校准/rest pose 使用 clip 第 0 帧的问题。
- 核心行为：使用格式 bind T-pose；去除 clip 首帧可能约 15° 的 root pitch，避免把动作姿态写入标定偏移。
- 关键代码：[`hhtools/retarget/newton_basic/rest_pose.py`](../hhtools/retarget/newton_basic/rest_pose.py)、[`hhtools/retarget/calibration/calibration.py`](../hhtools/retarget/calibration/calibration.py)、[`hhtools/viewer/library.py`](../hhtools/viewer/library.py)
- 测试：[`tests/retarget/test_xsens_bind_rest.py`](../tests/retarget/test_xsens_bind_rest.py)

### U02. Robot-to-Robot ground / ankle / sole 修复

- 上游提交：`ee493e3 FIX：robot2robot flow ground bug`，10 个文件，`+488/-91`。
- 核心行为：源机器人通过 FK 测量真实 mesh sole plane，并写入 `source_floor_z_world`；R2R 使用 ankle-to-ankle 语义对齐，H2R 继续使用 sole 对齐。
- 修复范围：预览、retarget root Z、播放序列化和导出，尤其是跪姿、趴姿和腾空片段的漂浮/陷地。
- 关键代码：[`hhtools/core/grounding.py`](../hhtools/core/grounding.py)、[`hhtools/retarget/robot_to_robot.py`](../hhtools/retarget/robot_to_robot.py)、[`hhtools/web/serialize.py`](../hhtools/web/serialize.py)
- 测试：`tests/retarget/test_robot_to_robot_grounding.py`、`tests/web/test_r2r_scaled_preview_ground.py`。

## 3. 精确数量与统计口径

### 3.1 提交数量

| 来源 | 内容提交 | Merge 提交 | 说明 |
|---|---:|---:|---|
| 我方独有 | 18 | 1 | 18 个内容提交 + `213a3b8` 同步 merge |
| Roboparty 分叉后新增 | 2 | 0 | 已经被我方 merge |
| 分叉后内容合计 | 20 | 1 | 若只看 Git commit graph 共 21 个；功能不能把 merge 再算一次 |

我方 18 个内容提交按 Conventional Commit 前缀统计：

| 类型 | 数量 |
|---|---:|
| `fix` | 10 |
| `feat` | 4 |
| `refactor` | 1 |
| `test` | 1 |
| `docs` | 1 |
| `chore` | 1 |

需要特别纠正：`9339b7b fix: change symlink or hard link to fix WinError 1314` 的实际 diff **只删除旧的 `docs/electron-migration-plan.md`，没有修生产代码**。真正实现 symlink → hard link → copy 回退的是 `0317f5c`。因此：

- Git 标题为 `fix`：10 个。
- 有实际代码/样式修复内容的提交：9 个。
- 明确触及生产后台的提交：9 个；其余修复是 UI 或历史标题异常。

### 3.2 净文件与行数

| 比较范围 | 文件 | 新增 | 删除 | 文件状态 |
|---|---:|---:|---:|---|
| 我方 `HEAD` 相对当前上游 | 105 | 37,619 | 961 | 93 新增、12 修改 |
| Roboparty 的两个新提交 | 19 | 664 | 126 | 2 新增、17 修改 |
| 分叉点到当前 `HEAD` 合计 | 120 | 38,283 | 1,087 | 95 新增、25 修改 |

双方都修改过 `README.md`、`README_cn.md`、`hhtools/web/export_bundle.py`、`hhtools/web/server.py`，所以 105 与 19 不能直接相加得到总文件数。

`+37,619` 不能理解为等量的手写业务逻辑。主要体积来自 Electron/Vue 首次引入、两个 `package-lock.json`、编译后的 Web static bundle/source map、前端 legacy runtime 和新增 URDF。

## 4. UI/UX 与前端功能清单

- [ ] **Vue 3 + TypeScript WebUI**：新增 `hhtools/web/frontend`，保留现有 FastAPI API 和 Three.js runtime，通过 Vue 组件建立应用外壳。
- [ ] **工作区导航重构**：H2R、R2R、Dataset、Robots 分区；增加 workflow pipeline 和明确的步骤状态。
- [ ] **标定编辑器**：增加 reset/undo/redo、heading、映射显示、透明度等控制，并与后台参考骨架 payload 联动。
- [ ] **任务抽屉**：显示运行/完成/失败状态、进度、参数摘要、结果下载、重试、仅重试失败项、复制编辑和 CLI/JSON 配置。
- [ ] **结果评估工作区**：显示跟踪误差、P95、接触一致率、足部滑移、逐帧曲线和最差 effector；强调只做快速诊断。
- [ ] **桌面菜单栏与命令面板**：统一文件导入、工作区跳转、播放、视图和设置命令；提供键盘搜索入口。
- [ ] **工作区偏好**：语言、主题、导航密度/布局等偏好本地持久化。
- [ ] **播放控制条**：播放/暂停、逐帧、循环、速度和时间轴事件桥接。
- [ ] **图层颜色语义**：Human Body 保持蓝色，Scaled Preview 使用青色，所有 Robot 图层统一紫色；Source/Target 用文字角色区分，不再让同一实体因处于目标侧而变色。
- [ ] **视觉 Bugfix**：修复组件遮挡、分隔线宽度/hover、inactive toast 残留。
- [ ] **品牌资源**：新增 hhtools robot SVG favicon。
- [ ] **测试目录整理**：Vue 测试集中到 `frontend/tests/components` 与 `frontend/tests/runtime`，生产组件目录不再散落 `.spec.ts`。

主要入口：[`hhtools/web/frontend/src/App.vue`](../hhtools/web/frontend/src/App.vue)、[`hhtools/web/frontend/src/components`](../hhtools/web/frontend/src/components)、[`hhtools/web/frontend/src/runtime`](../hhtools/web/frontend/src/runtime)、[`hhtools/web/frontend/src/webui.css`](../hhtools/web/frontend/src/webui.css)。

前端相关净规模（仍以已提交 `213a3b8` 为准）：

| 范围 | 文件 | 净变化 | 说明 |
|---|---:|---:|---|
| Vue frontend | 40 | `+20,008/-0` | 含 21 个产品源文件、11 个集中测试及 lock/config |
| Python 包内编译 static | 10 | `+4,158/-811` | bundle、CSS、source map 与入口清单 |
| Electron | 27 | `+7,900/-0` | 其中 `package-lock.json` 约 6,175 行 |
| Remote 方案 | 1 | `+460/-0` | 仅设计文档 |

前端 Review 风险：

- [ ] Vue 当前是“组件外壳 + imperative legacy runtime”的混合架构，不是完整组件化重写。`webui-runtime.ts` 仍大量通过 DOM id、`.onclick` 和 `window.CustomEvent` 协作；修改 `App.vue` 的 id/结构可能在 Vue 单测通过时破坏真实工作流。
- [ ] `vite.config.ts` 使用 `emptyOutDir: false`，源码与编译 static/source map 同时提交，存在 stale asset、PR 体积和源码暴露风险；CI 应执行 clean build 并检查 Git diff。
- [ ] 国际化目前只覆盖菜单、导航和部分 HUD；`locale="en"` 不代表完整英文界面。
- [ ] 结果质量等级使用固定绝对厘米阈值，没有按机器人尺度或任务类型归一，不能作为论文验收阈值。
- [ ] `pinia` 已列为 dependency，但当前已提交源码没有使用；可在依赖清理时移除。

## 5. Electron、Remote 与工程化状态

- [ ] Electron main/preload/shared 分层、窗口状态、日志、单实例和 crash recovery。
- [ ] Electron sidecar 生命周期与 session security（同时属于 B01 后台改动）。
- [ ] `electron-vite` 开发/构建、Vitest、Playwright E2E、`electron-builder` NSIS 配置。
- [ ] Web static 构建产物纳入 Python 包发布路径。
- [ ] Vue 与 Electron 均提交精确版本的 `package-lock.json`。
- [ ] Remote GPU 轻客户端方案文档：[`docs/electron-remote-gpu-plan.md`](electron-remote-gpu-plan.md)。

当前状态必须说清楚：

- Local Electron 已实现，但 Alpha 安装包没有打包 Python/CUDA/Torch/Newton 运行时。
- `npm run dist:win` 有 NSIS 配置，不等于已经完成可独立安装交付、签名和自动更新验证。
- Remote SSH tunnel、remote token、Gateway proxy、协议协商和服务器 `remote serve` **尚未实现**；当前只是 Phase 0–4 方案。
- 当前 CSP 仍允许 `script-src/style-src 'unsafe-inline'`；本地 secret、sandbox 和 loopback 降低了风险，但 Remote 上线前应收紧并补 threat model。
- `architecture.html` 没有仓库引用，而且仍把 Electron 描述为候选方案，已经落后于现有 Local Alpha；应更新或删除，避免误导。

## 6. 我方 18 个独有内容提交逐项清单

| # | Commit | 分类 | 实际内容 |
|---:|---|---|---|
| 1 | `9aca45f` | UI Bugfix | 完全隐藏 inactive toast，同时保留进出动画 |
| 2 | `d3fb7e8` | 前后台混合 Feature | Electron、Vue/TS WebUI、安全 sidecar、桌面测试和 RP0.1.2 URDF |
| 3 | `252f396` | UI Bugfix | 修复组件遮挡 |
| 4 | `a1ea9f0` | UI Bugfix | 修复分隔线宽度和 hover |
| 5 | `9aa4ee3` | UI Asset | 更新 favicon |
| 6 | `9339b7b` | **历史异常** | 标题称 WinError 修复，实际只删除旧方案文档 |
| 7 | `488f875` | Chore | 忽略本地开发笔记 |
| 8 | `8d2ac54` | 后台安全 Bugfix | 拒绝危险上传路径 |
| 9 | `ce0dbc2` | 后台 API Bugfix | 不支持 motion 返回 400 |
| 10 | `0317f5c` | 后台兼容 Bugfix | symlink 失败时 hard link/copy 回退 |
| 11 | `683cc46` | 后台导出 Bugfix | object CSV 增加 extents |
| 12 | `59d1963` | Test | 地形缩放测试改用生产配置 helper |
| 13 | `cc5c0c7` | CLI Bugfix | Windows UTF-8 stdout/stderr |
| 14 | `4d9ed9c` | 后台稳定性 Bugfix | 限制上传、后台任务和保留资源 |
| 15 | `c4e41a2` | 前后台混合 Feature | workflow、JobSpec、历史、重放、标定控制 |
| 16 | `41f039a` | 前后台混合 Feature | 结果诊断、评估区、菜单和命令面板 |
| 17 | `bd22a99` | 前端 Refactor | 集中测试目录并统一 layer 颜色 |
| 18 | `fb64e1a` | Docs | Remote GPU 轻客户端方案 |

## 7. 测试与验证记录

本次审计时执行了以下 smoke check：

| 验证 | 结果 |
|---|---|
| Python `uv run pytest -q` | `112 passed, 4 skipped` |
| Scheduler stress repeat | 9 项测试连续运行 10 次通过 |
| Vue `npm test` | `11 files / 29 tests passed` |
| Vue `npm run typecheck` | 通过 |
| Vue `npm run build` | 通过；FastAPI/Electron 实际入口已引用新 hash，旧 stale bundle 已移除 |
| Electron `npm test` | `4 files / 11 tests passed` |
| Electron `npm run typecheck` | 通过 |

需要保留证据边界：以上结果覆盖当前未提交 review 工作树，包括新的调度器、CLI/Electron 配置透传、motion 预检、测试与解释性注释；它们证明当前组合可通过，**不能替代提交后的 CI 证据**。

新增调度器、CLI 和测试文件的 Ruff 检查通过。`server.py` 全文件仍有 9 项既存 lint 债务（包括未使用 import/local、一个未定义 annotation、复杂度和格式项）；应另开整理 PR，避免把历史静态检查修复混入本轮业务 review。

## 8. 本次 Review 跟进代码与解释性注释

本轮根据人工 review 继续做了以下行为修改：

- 新增 [`hhtools/web/job_scheduler.py`](../hhtools/web/job_scheduler.py)：默认不限；可选 running cap、FIFO waiting queue、上传前 reservation、pending 取消与运行快照；thread-start failure 的终态回写同样计入 shutdown 等待。
- Web CLI、Electron sidecar 和 Electron 环境白名单增加两个精确配置项；未放宽任意 `HHTOOLS_*`。
- motion upload 在发布 Motion Library 前先验证临时 drop，保持原 HTTP 400 JSON，同时保护同名旧 library。
- 排队 motion 从各自独立 drop 解析；实际 label/mode 在发布后、grounding/serialization 前立即持久化。
- Motion Library 的进程内 scan/link/unlink/upload 共用读写锁；手工 link 路由改为 sync endpoint，锁等待和文件 I/O 不阻塞 FastAPI event loop。
- session 临时根采用 cleanup-once，并在正常 lifespan、延迟回收和解释器 `atexit` 三条路径复用；强杀仍不保证回调执行。
- Vue production bundle 已重建，实际 FastAPI/Electron 入口引用包含 `pending`、hard-link 提示的新 hash，旧 stale assets 已移除。

同时保留以下设计注释便于 review：

- [`hhtools/web/server.py`](../hhtools/web/server.py#L55)：说明上传/保留边界默认启用，而任务并发控制由专业部署选择是否启用。
- [`hhtools/web/server.py`](../hhtools/web/server.py#L401)：明确多文件上传是 per-file atomic publish，不是整个请求的文件系统事务。
- [`hhtools/web/calibration_session.py`](../hhtools/web/calibration_session.py#L163)：说明 heading 必须同时旋转位置与四元数。
- [`hhtools/web/export_bundle.py`](../hhtools/web/export_bundle.py#L325)：说明为什么常量 extents 需要在 CSV 每一行重复。
- [`hhtools/web/result_diagnostics.py`](../hhtools/web/result_diagnostics.py#L98)：明确接触判定只是降采样 viewer payload 上的启发式，不是物理接触真值。
- [`hhtools/web/job_specs.py`](../hhtools/web/job_specs.py#L1)：将能力准确限定为 path-and-parameter replay，并列出尚未记录的严格复现信息。
- [`hhtools/web/motion_library_links.py`](../hhtools/web/motion_library_links.py#L468)：说明 hard link 共享内容，以及目录替换失败时旧内容不能自动恢复。

## 9. 建议 Review 顺序

1. [x] B11 已删除孤立 RP0 URDF。
2. [ ] B02 上传路径安全。
3. [ ] B03 资源限制、任务清理、per-file 发布与 artifact 删除边界。
4. [ ] B06 JobSpec、持久化历史和重放的路径/所有权/版本模型。
5. [ ] B01 Electron sidecar secret、origin、IPC 与进程生命周期。
6. [ ] B05 symlink/hard link/copy 的数据语义和失败恢复。
7. [ ] B07 标定 quaternion/heading 数学。
8. [ ] B08 结果诊断指标与阈值。
9. [ ] B09 导出 CSV schema 兼容性。
10. [ ] UI/UX、Electron 壳和测试目录结构。
11. [ ] 最后决定哪些 commit 适合整理后提交给 Roboparty；不要把 U01/U02 再作为我方 PR 内容。

## 10. 审计边界与未提交工作区

- `upstream/main` 在 2026-08-27 13:39:31 +08:00 成功 fetch 到 `ee493e3`；本次审计期间再次联网复核遇到 GitHub 连接 reset，因此基线是该次已成功获取的远端状态。
- 根据本次 review 决定，孤立 RP0 URDF 已在工作区删除；历史统计仍以 `213a3b8` 为基线，因此提交/文件统计暂未重算。
- 本文、第 8 节的代码、RP0 删除与相关测试均保留为未提交状态，等待人工 review；没有推送到 `origin` 或 `upstream`。
