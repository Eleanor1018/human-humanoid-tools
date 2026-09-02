import { useEffect, useState } from "react";

import { useLocaleText } from "@/hooks/use-locale-text";
import type {
  MotionCategory,
  WorkspaceLocale,
  WorkspacePanelId,
} from "@/runtime/types";
import { MotionPickerDialog } from "./motion-picker-dialog";
import { SearchField } from "./search-field";
import type { VideoBatchModel, VideoBatchStatus } from "../use-video-batch";

export type BatchMode = "v2m" | "h2r" | "r2r";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

function videoStatusLabel(
  status: VideoBatchStatus,
  locale: WorkspaceLocale,
): string {
  const labels: Record<VideoBatchStatus, [string, string]> = {
    queued: ["Queued", "等待处理"],
    uploading: ["Uploading", "正在上传"],
    running: ["Generating motion", "正在生成动作"],
    done: ["Motion ready", "动作已生成"],
    error: ["Failed", "处理失败"],
  };
  return labels[status][locale === "zh-CN" ? 1 : 0];
}

export function BatchStage({
  active,
  mode,
  locale,
  videoBatch,
}: {
  active: boolean;
  mode: BatchMode;
  locale: WorkspaceLocale;
  videoBatch: VideoBatchModel;
}) {
  return (
    <>
      <div style={{ display: active && mode === "v2m" ? undefined : "none" }}>
        <VideoBatchStage locale={locale} model={videoBatch} />
      </div>
      <div style={{ display: active && mode === "h2r" ? undefined : "none" }}>
        <HumanBatchStage locale={locale} />
      </div>
      <div style={{ display: active && mode === "r2r" ? undefined : "none" }}>
        <RobotBatchStage locale={locale} />
      </div>
    </>
  );
}

function RobotBatchStage({ locale }: { locale: WorkspaceLocale }) {
  const text = useLocaleText(locale);
  return (
    <section
      className="batch-stage-workspace r2r-batch-stage-workspace"
      aria-label={text("R2R batch inputs", "R2R 批量输入")}
    >
      <header className="batch-stage-header">
        <div>
          <h1>{text("Robot trajectory inputs", "机器人轨迹输入")}</h1>
          <p>
            {text(
              "Build a trajectory set for one source and target robot pair.",
              "为同一组源机器人和目标机器人整理待转换轨迹。",
            )}
          </p>
        </div>
        <div className="batch-stage-count">
          <strong id="r2r-basket-count">0</strong>
          <span>{text("trajectories", "条轨迹")}</span>
        </div>
      </header>
      <div className="batch-stage-toolbar r2r-batch-stage-toolbar">
        <button
          id="r2r-batch-pick-file"
          type="button"
          className="btn secondary"
        >
          {text("Import file", "导入文件")}
        </button>
        <button
          id="r2r-batch-pick-folder"
          type="button"
          className="btn secondary"
        >
          {text("Import folder", "导入文件夹")}
        </button>
      </div>
      <div
        id="r2r-basket-drop"
        className="batch-basket-frame r2r-batch-basket-frame"
      >
        <div
          className="batch-basket-columns r2r-batch-basket-columns"
          aria-hidden="true"
        >
          <span>{text("Trajectory", "轨迹")}</span>
          <span>{text("Profile", "类型")}</span>
          <span>{text("Actions", "操作")}</span>
        </div>
        <div
          id="r2r-basket-list"
          className="batch-basket-list"
          aria-live="polite"
        />
      </div>
      <footer className="batch-stage-footer">
        <span id="r2r-batch-stage-summary" className="batch-selected-count">
          {text("No robot trajectories selected", "尚未选择机器人轨迹")}
        </span>
        <span className="spacer" />
        <button
          id="r2r-basket-clear"
          type="button"
          className="btn secondary small"
          disabled
        >
          {text("Clear all", "清空全部")}
        </button>
      </footer>
    </section>
  );
}

function HumanBatchStage({ locale }: { locale: WorkspaceLocale }) {
  const text = useLocaleText(locale);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<"all" | MotionCategory>("all");
  useEffect(() => {
    window.dispatchEvent(
      new CustomEvent("hhtools:batch-filter", { detail: { query, category } }),
    );
  }, [category, query]);
  return (
    <section
      className="batch-stage-workspace"
      aria-label={text("Batch inputs", "批量输入")}
    >
      <header className="batch-stage-header">
        <div>
          <h1>{text("Batch inputs", "批量输入")}</h1>
          <p>
            {text(
              "Build and validate the clip set before submitting a task.",
              "先整理并检查动作清单，再提交批量任务。",
            )}
          </p>
        </div>
        <div className="batch-stage-count">
          <strong id="basket-count">0</strong>
          <span>{text("clips", "条动作")}</span>
        </div>
      </header>
      <div className="batch-stage-toolbar">
        <button
          id="batch-library-open"
          type="button"
          className="btn"
          onClick={() =>
            window.dispatchEvent(new Event("hhtools:batch-library-request"))
          }
        >
          {text("Add from Library", "从资源库添加")}
        </button>
        <button id="batch-pick-file" type="button" className="btn secondary">
          {text("Import file", "导入文件")}
        </button>
        <button id="batch-pick-folder" type="button" className="btn secondary">
          {text("Import folder", "导入文件夹")}
        </button>
        <SearchField
          id="batch-basket-search"
          value={query}
          onValueChange={setQuery}
          label={text("Search batch inputs", "搜索批量动作")}
          placeholder={text("Search clips…", "搜索动作……")}
        />
        <select
          id="batch-basket-filter"
          value={category}
          className="search batch-basket-filter"
          onChange={(event) =>
            setCategory(event.currentTarget.value as "all" | MotionCategory)
          }
        >
          <option value="all">{text("All types", "全部类型")}</option>
          <option value="motion">{text("Motion", "纯动作")}</option>
          <option value="object">{text("Object", "物体交互")}</option>
          <option value="terrain">{text("Terrain", "地形场景")}</option>
        </select>
      </div>
      <div id="basket-drop" className="batch-basket-frame">
        <div className="batch-basket-columns" aria-hidden="true">
          <span className="batch-basket-check-column" />
          <span>{text("Clip", "动作")}</span>
          <span>{text("Type", "类型")}</span>
          <span>{text("Reference", "参考骨架")}</span>
          <span>{text("Actions", "操作")}</span>
        </div>
        <div
          id="basket-list"
          className="batch-basket-list"
          aria-live="polite"
        />
      </div>
      <footer className="batch-stage-footer">
        <label className="batch-select-all">
          <input id="batch-select-all" type="checkbox" />
          <span>{text("Select all visible", "全选当前结果")}</span>
        </label>
        <span id="batch-selected-count" className="batch-selected-count">
          {text("0 selected", "已选择 0 条")}
        </span>
        <span className="spacer" />
        <button
          id="batch-remove-selected"
          type="button"
          className="btn secondary small"
          disabled
        >
          {text("Remove selected", "移除所选")}
        </button>
        <button
          id="basket-clear"
          type="button"
          className="btn secondary small"
          disabled
        >
          {text("Clear all", "清空全部")}
        </button>
      </footer>
    </section>
  );
}

function VideoBatchStage({
  locale,
  model,
}: {
  locale: WorkspaceLocale;
  model: VideoBatchModel;
}) {
  const text = useLocaleText(locale);
  return (
    <section className="batch-stage-workspace v2m-batch-stage-workspace">
      <header className="batch-stage-header">
        <div>
          <h1>{text("Video inputs", "视频输入")}</h1>
          <p>
            {text(
              "Each video becomes an independent GVHMR task.",
              "每个视频会作为一项独立的 GVHMR 任务处理。",
            )}
          </p>
        </div>
        <div className="batch-stage-count">
          <strong id="v2m-batch-count">{model.videos.length}</strong>
          <span>{text("videos", "个视频")}</span>
        </div>
      </header>
      <div className="batch-stage-toolbar">
        <button
          id="v2m-batch-pick-files"
          type="button"
          className="btn"
          disabled={model.busy}
          onClick={() => void model.pickVideos(false)}
        >
          {text("Import videos", "导入视频")}
        </button>
        <button
          id="v2m-batch-pick-folder"
          type="button"
          className="btn secondary"
          disabled={model.busy}
          onClick={() => void model.pickVideos(true)}
        >
          {text("Import folder", "导入文件夹")}
        </button>
      </div>
      <div
        id="v2m-batch-drop"
        className="batch-basket-frame v2m-batch-frame"
        onDragEnter={(event) => event.preventDefault()}
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          void model.dropVideos(event.dataTransfer);
        }}
      >
        <div id="v2m-batch-list" className="batch-basket-list">
          {model.videos.length === 0 && (
            <div className="batch-basket-empty">
              <strong>{text("Add videos to begin", "添加视频以开始")}</strong>
            </div>
          )}
          {model.videos.map((item) => (
            <div key={item.id} className="v2m-batch-row">
              <div className="batch-basket-main">
                <strong className="batch-basket-name">{item.file.name}</strong>
                <small className="batch-basket-meta">
                  {item.file._relpath ||
                    item.file.webkitRelativePath ||
                    item.file.name}
                </small>
              </div>
              <span className="batch-basket-reference">
                {formatBytes(item.file.size)}
              </span>
              <div className="v2m-batch-status">
                <span className={`v2m-batch-state is-${item.status}`}>
                  {videoStatusLabel(item.status, locale)}
                </span>
                {item.message && <small>{item.message}</small>}
                {item.progress > 0 && item.progress < 1 && (
                  <div className="progress">
                    <div
                      className="bar"
                      style={{ width: `${Math.round(item.progress * 100)}%` }}
                    />
                  </div>
                )}
              </div>
              <div className="batch-basket-actions">
                <button
                  type="button"
                  className="batch-basket-remove"
                  aria-label={text(
                    `Remove ${item.file.name}`,
                    `移除 ${item.file.name}`,
                  )}
                  disabled={model.busy}
                  onClick={() => model.removeVideo(item.id)}
                >
                  ×
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
      <footer className="batch-stage-footer">
        <span className="batch-selected-count">
          {text(
            `${model.completedCount} ready · ${model.errorCount} failed`,
            `已完成 ${model.completedCount} 个 · 失败 ${model.errorCount} 个`,
          )}
        </span>
        <span className="spacer" />
        <button
          type="button"
          className="btn secondary small"
          disabled={model.busy || model.videos.length === 0}
          onClick={model.clearVideos}
        >
          {text("Clear all", "清空全部")}
        </button>
      </footer>
    </section>
  );
}

export function BatchWorkflow({
  mode,
  onModeChange,
  locale,
  onRequestPanel,
  videoBatch,
}: {
  mode: BatchMode;
  onModeChange(mode: BatchMode): void;
  locale: WorkspaceLocale;
  onRequestPanel(panel: WorkspacePanelId): void;
  videoBatch: VideoBatchModel;
}) {
  const text = useLocaleText(locale);
  const [pickerOpen, setPickerOpen] = useState(false);
  useEffect(() => {
    const openPicker = () => setPickerOpen(true);
    window.addEventListener("hhtools:batch-library-request", openPicker);
    return () =>
      window.removeEventListener("hhtools:batch-library-request", openPicker);
  }, []);
  return (
    <div className="panel-stack batch-workflow-stack">
      <h2>{text("Batch", "批量处理")}</h2>
      <div
        className="motion-profile-switcher batch-mode-switcher"
        role="radiogroup"
        aria-label={text("Batch workflow", "批量工作流")}
      >
        {(["v2m", "h2r", "r2r"] as const).map((item) => (
          <label key={item} className="motion-profile-selector">
            <input
              className="sr-only"
              type="radio"
              name="batch-workflow-mode"
              value={item}
              checked={mode === item}
              onChange={() => onModeChange(item)}
            />
            <span className="motion-profile-selector-content">
              {item.toUpperCase()}
            </span>
          </label>
        ))}
      </div>
      <div style={{ display: mode === "v2m" ? undefined : "none" }}>
        <VideoBatchInspector locale={locale} model={videoBatch} />
      </div>
      <div style={{ display: mode === "h2r" ? undefined : "none" }}>
        <HumanBatchInspector locale={locale} onRequestPanel={onRequestPanel} />
      </div>
      <div style={{ display: mode === "r2r" ? undefined : "none" }}>
        <RobotBatchInspector locale={locale} onRequestPanel={onRequestPanel} />
      </div>
      <MotionPickerDialog
        open={pickerOpen}
        locale={locale}
        mode="basket"
        onClose={() => setPickerOpen(false)}
        onImport={() => {
          setPickerOpen(false);
          onRequestPanel("motion");
        }}
      />
    </div>
  );
}

function HumanBatchInspector({
  locale,
  onRequestPanel,
}: {
  locale: WorkspaceLocale;
  onRequestPanel(panel: WorkspacePanelId): void;
}) {
  const text = useLocaleText(locale);
  return (
    <div className="batch-mode-content">
      <div className="batch-step-summary">
        <span>{text("1. Inputs", "1. 输入动作")}</span>
        <strong>
          <span id="batch-inspector-count">0</span> {text("clips", "条")}
        </strong>
      </div>
      <details className="video-workflow-step" open>
        <summary className="video-workflow-step-summary">
          <span>
            {text("2. Target robot & compatibility", "2. 目标机器人与兼容性")}
          </span>
        </summary>
        <div className="video-workflow-step-body workflow-compact-controls">
          <div className="workflow-picker-row">
            <select id="batch-robot-select" className="search" />
            <button
              type="button"
              className="btn secondary small"
              onClick={() => onRequestPanel("robot-assets")}
            >
              {text("Import robot", "导入机器人")}
            </button>
          </div>
          <button
            id="batch-robot-load"
            type="button"
            className="btn workflow-load-button"
            disabled
          >
            {text("Load target robot", "加载目标机器人")}
          </button>
          <p id="batch-robot" className="workflow-status-line">
            {text("Not loaded", "未加载")}
          </p>
          <div id="batch-ref-hint" className="batch-compatibility-list" />
        </div>
      </details>
      <BatchSettings locale={locale} prefix="batch" />
      <BatchRun locale={locale} prefix="batch" />
    </div>
  );
}

function RobotBatchInspector({
  locale,
  onRequestPanel,
}: {
  locale: WorkspaceLocale;
  onRequestPanel(panel: WorkspacePanelId): void;
}) {
  const text = useLocaleText(locale);
  const robot = (kind: "source" | "target") => (
    <details className="video-workflow-step" open>
      <summary className="video-workflow-step-summary">
        <span>
          {text(
            kind === "source" ? "2. Source robot" : "3. Target robot",
            kind === "source" ? "2. 源机器人" : "3. 目标机器人",
          )}
        </span>
      </summary>
      <div className="video-workflow-step-body workflow-compact-controls">
        <div className="workflow-picker-row">
          <select id={`r2r-batch-${kind}-select`} className="search" />
          <button
            type="button"
            className="btn secondary small"
            onClick={() => onRequestPanel("robot-assets")}
          >
            {text("Import robot", "导入机器人")}
          </button>
        </div>
        <button
          id={`r2r-batch-${kind}-load`}
          type="button"
          className="btn workflow-load-button"
        >
          {text(
            `Load ${kind} robot`,
            `加载${kind === "source" ? "源" : "目标"}机器人`,
          )}
        </button>
        <p id={`r2r-batch-${kind}-status`} className="workflow-status-line">
          {text("Not loaded", "未加载")}
        </p>
        {kind === "target" && (
          <p
            id="r2r-batch-calibration-status"
            className="workflow-status-line"
          />
        )}
      </div>
    </details>
  );
  return (
    <div className="batch-mode-content">
      <div className="batch-step-summary">
        <span>{text("1. Source trajectories", "1. 源轨迹")}</span>
        <strong>
          <span id="r2r-batch-inspector-count">0</span>{" "}
          {text("trajectories", "条")}
        </strong>
      </div>
      {robot("source")}
      {robot("target")}
      <BatchSettings locale={locale} prefix="r2r-batch" />
      <BatchRun locale={locale} prefix="r2r-batch" />
    </div>
  );
}

function BatchSettings({
  locale,
  prefix,
}: {
  locale: WorkspaceLocale;
  prefix: "batch" | "r2r-batch";
}) {
  const text = useLocaleText(locale);
  const r2r = prefix === "r2r-batch";
  return (
    <details className="video-workflow-step" open>
      <summary className="video-workflow-step-summary">
        <span>
          {text(
            r2r ? "4. Run settings" : "3. Run settings",
            r2r ? "4. 运行设置" : "3. 运行设置",
          )}
        </span>
      </summary>
      <div className="video-workflow-step-body workflow-compact-controls">
        <div className="workflow-field-grid">
          <label className="video-workflow-field">
            <span className="k">{text("Solver", "求解器")}</span>
            <select id={`${prefix}-backend`} className="search">
              <option value="newton">Newton IK</option>
              <option value="interaction_mesh">Interaction-Mesh</option>
            </select>
          </label>
          <label className="video-workflow-field">
            <span className="k">{text("Output format", "输出格式")}</span>
            <select id={`${prefix}-format`} className="search">
              <option value="pkl">PKL</option>
              <option value="csv">CSV</option>
            </select>
          </label>
        </div>
        {!r2r && <p id="batch-settings-note" className="batch-settings-note" />}
        <details className="batch-advanced-settings">
          <summary>{text("Advanced settings", "高级设置")}</summary>
          <div className="batch-advanced-settings-body">
            {!r2r && (
              <label className="video-workflow-field" id="batch-size-field">
                <span className="k">
                  {text("GPU batch size", "GPU 批大小")}
                </span>
                <input
                  id="batch-size"
                  className="search"
                  type="number"
                  min="1"
                  max="256"
                />
              </label>
            )}
            <div className="workflow-field-grid">
              {r2r && (
                <label className="video-workflow-field">
                  <span className="k">Source FPS</span>
                  <input
                    id="r2r-batch-source-fps"
                    className="search"
                    type="number"
                    min="1"
                    defaultValue="50"
                  />
                </label>
              )}
              <label className="video-workflow-field">
                <span className="k">Retarget FPS</span>
                <input
                  id={`${prefix}-retarget-fps`}
                  className="search"
                  type="number"
                  min="1"
                />
              </label>
            </div>
            <label className="video-workflow-field">
              <span className="k">Export FPS</span>
              <input
                id={`${prefix}-export-fps`}
                className="search"
                type="number"
                min="1"
              />
            </label>
            <div className="workflow-field-grid">
              <label className="video-workflow-field">
                <span className="k">{text("Start (s)", "起始 (s)")}</span>
                <input
                  id={r2r ? "r2r-batch-t-start" : "batch-export-t-start"}
                  className="search"
                  type="number"
                  min="0"
                  defaultValue="0"
                />
              </label>
              <label className="video-workflow-field">
                <span className="k">{text("End (s)", "截止 (s)")}</span>
                <input
                  id={r2r ? "r2r-batch-t-end" : "batch-export-t-end"}
                  className="search"
                  type="number"
                  min="0"
                />
              </label>
            </div>
            <label
              id={r2r ? undefined : "batch-csv-header-row"}
              className="workflow-checkbox-row"
            >
              <input
                id={`${prefix}-csv-header`}
                type="checkbox"
                defaultChecked
              />
              <span>{text("Include CSV header", "CSV 含表头")}</span>
            </label>
            <label className="video-workflow-field">
              <span className="k">{text("Result name", "结果名称")}</span>
              <input
                id={`${prefix}-out`}
                className="search"
                defaultValue={r2r ? "r2r_batch_export" : "batch_export"}
              />
            </label>
          </div>
        </details>
      </div>
    </details>
  );
}

function BatchRun({
  locale,
  prefix,
}: {
  locale: WorkspaceLocale;
  prefix: "batch" | "r2r-batch";
}) {
  const text = useLocaleText(locale);
  const r2r = prefix === "r2r-batch";
  if (r2r)
    return (
      <section className="batch-run-panel">
        <p id="r2r-batch-run-summary" className="batch-run-summary">
          {text("No source trajectories selected.", "尚未选择源轨迹。")}
        </p>
        <button id="r2r-batch-run" type="button" className="btn" disabled>
          {text("Start R2R batch task", "开始 R2R 批量任务")}
        </button>
        <p id="r2r-batch-disabled-reason" className="disabled-action-reason">
          {text(
            "Add trajectories and load both robots first.",
            "请先添加轨迹并加载源机器人和目标机器人。",
          )}
        </p>
        <div
          id="r2r-batch-progress"
          className="progress"
          style={{ display: "none" }}
        >
          <div className="bar" />
        </div>
        <p id="r2r-batch-status" className="workflow-status-line" />
      </section>
    );
  return (
    <section className="batch-run-panel">
      <p id="batch-run-summary" className="batch-run-summary">
        {text("No inputs selected.", "尚未选择输入动作。")}
      </p>
      <button id="batch-run" type="button" className="btn" disabled>
        {text("Start batch task", "开始批量任务")}
      </button>
      <p id="batch-disabled-reason" className="disabled-action-reason">
        {text(
          "Add motions and select a target robot first.",
          "请先添加动作并选择目标机器人。",
        )}
      </p>
      <div id="batch-progress-stack" className="batch-progress-stack hidden">
        <div id="batch-progress-total" className="progress">
          <div className="bar" />
        </div>
        <div id="batch-progress-clip" className="progress">
          <div className="bar" />
        </div>
      </div>
      <p id="batch-status" className="workflow-status-line" />
      <div id="batch-result-card" className="batch-result-card hidden">
        <strong id="batch-result-title">
          {text("Batch complete", "批量任务完成")}
        </strong>
        <p id="batch-result-summary" />
        <button
          id="batch-result-download"
          type="button"
          className="btn secondary small"
        >
          {text("Download ZIP", "下载 ZIP")}
        </button>
        <button id="batch-result-retry" type="button" hidden>
          {text("Retry failed only", "仅重试失败项")}
        </button>
        <button id="batch-result-tasks" type="button">
          {text("Open Tasks", "打开任务面板")}
        </button>
      </div>
      <div id="batch-failures" className="batch-failures hidden" />
    </section>
  );
}

function VideoBatchInspector({
  locale,
  model,
}: {
  locale: WorkspaceLocale;
  model: VideoBatchModel;
}) {
  const text = useLocaleText(locale);
  return (
    <div className="batch-mode-content v2m-batch-mode-content">
      <div className="batch-step-summary">
        <span>{text("1. Videos", "1. 视频")}</span>
        <strong>
          <span id="v2m-batch-inspector-count">{model.videos.length}</span>{" "}
          {text("videos", "个")}
        </strong>
      </div>
      <details className="video-workflow-step" open>
        <summary className="video-workflow-step-summary">
          {text("2. Environment", "2. 运行环境")}
        </summary>
        <div className="video-workflow-step-body">
          <select id="v2m-batch-runtime" className="search" disabled>
            <option>GVHMR Official</option>
          </select>
          <button
            id="v2m-batch-confirm"
            type="button"
            className="btn workflow-load-button"
            disabled={
              model.runtimeChecking ||
              model.runtime?.ready !== true ||
              model.environmentConfirmed
            }
            onClick={model.confirmEnvironment}
          >
            {model.environmentConfirmed
              ? text("Confirmed", "已确认")
              : text("Confirm environment", "确认运行环境")}
          </button>
          <p id="v2m-batch-runtime-status" className="workflow-status-line">
            {model.runtimeChecking
              ? text("Checking GVHMR…", "正在检查 GVHMR……")
              : model.runtime?.ready
                ? text(
                    "GVHMR official runtime is ready.",
                    "GVHMR 官方运行环境已就绪。",
                  )
                : model.runtime?.missing?.[0] ||
                  model.runtimeError ||
                  text(
                    "GVHMR runtime is unavailable.",
                    "GVHMR 运行环境不可用。",
                  )}
          </p>
          <button
            type="button"
            className="btn secondary small"
            disabled={model.runtimeChecking || model.busy}
            onClick={() => void model.refreshRuntime()}
          >
            {text("Check again", "重新检查")}
          </button>
        </div>
      </details>
      <details className="video-workflow-step" open>
        <summary className="video-workflow-step-summary">
          {text("3. Generate motions", "3. 生成动作")}
        </summary>
        <div className="video-workflow-step-body">
          <label className="workflow-checkbox-row">
            <input
              id="v2m-batch-static-camera"
              type="checkbox"
              checked={model.staticCamera}
              onChange={(event) =>
                model.setStaticCamera(event.currentTarget.checked)
              }
            />
            <span>{text("Static camera", "静态相机")}</span>
          </label>
          <input
            id="v2m-batch-focal-length"
            className="search"
            placeholder="Auto"
            value={model.focalLength}
            onChange={(event) =>
              model.setFocalLength(event.currentTarget.value)
            }
          />
          <button
            id="v2m-batch-run"
            type="button"
            className="btn"
            disabled={!model.canRun}
            onClick={() => void model.runBatch()}
          >
            {model.busy
              ? text("Generating…", "生成中……")
              : text("Start V2M batch", "开始 V2M 批量任务")}
          </button>
          <div
            id="v2m-batch-progress"
            className="progress"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(model.aggregateProgress * 100)}
          >
            <div
              className="bar"
              style={{ width: `${Math.round(model.aggregateProgress * 100)}%` }}
            />
          </div>
          <p id="v2m-batch-status" className="workflow-status-line">
            {model.statusMessage ||
              text(
                "Generated motions are added to H2R batch automatically.",
                "生成的动作会自动加入 H2R 批量清单。",
              )}
          </p>
        </div>
      </details>
    </div>
  );
}
