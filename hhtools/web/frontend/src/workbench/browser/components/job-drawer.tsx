import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
} from "react";
import { createPortal } from "react-dom";
import { ChevronDown, ChevronUp, RefreshCw, X } from "lucide-react";

import { useLocaleText } from "@/hooks/use-locale-text";
import { useWindowEvent } from "@/hooks/use-window-event";
import { cn } from "@/lib/utils";
import { windowEventBus } from "@/platform/events/browser/window-event-bus";
import type {
  JobConfigResponse,
  JobHistoryCommandDetail,
  JobHistoryRecord,
  JobParameterValue,
  JobReplayCapability,
  JobSpecValidationResponse,
  JobStatus,
} from "@/runtime/types";
import type { WorkspaceLocale } from "@/workbench/common/workspace";

const HEIGHT_KEY = "hhtools-desktop-job-panel-height-v1";
const MIN_HEIGHT = 180;

const KIND_LABELS: Record<string, [string, string]> = {
  dataset_analyze: ["Dataset Analysis", "数据集分析"],
  dataset_robot_preview: ["Robot Trajectory Preview", "机器人轨迹预览"],
  motion_load: ["Load Motion", "加载动作"],
  motion_link: ["Link Motion", "导入动作"],
  basket_upload: ["Import Batch Motions", "导入批量动作"],
  retarget: ["H2R Retarget", "H2R Retarget"],
  batch: ["H2R Batch", "H2R 批量任务"],
  r2r_source_upload: ["Load Source Robot Trajectory", "加载源机器人轨迹"],
  r2r_retarget: ["R2R Retarget", "R2R Retarget"],
  r2r_basket_upload: ["Import R2R Batch Trajectories", "导入 R2R 批量轨迹"],
  r2r_batch: ["R2R Batch", "R2R 批量任务"],
};

const STATUS_LABELS: Record<JobStatus, [string, string]> = {
  pending: ["Pending", "等待中"],
  running: ["Running", "运行中"],
  done: ["Completed", "已完成"],
  error: ["Failed", "失败"],
};

const PARAMETER_LABELS: Record<string, [string, string]> = {
  robot: ["Robot", "机器人"],
  target: ["Target Robot", "目标机器人"],
  target_robot: ["Target Robot", "目标机器人"],
  source_robot: ["Source Robot", "源机器人"],
  source: ["Source", "数据源"],
  profile: ["Profile", "配置"],
  reference: ["Reference Skeleton", "参考骨架"],
  backend: ["Solver", "求解器"],
  embedding: ["Feature Space", "特征空间"],
  format: ["Format", "格式"],
  retarget_fps: ["Retarget FPS", "Retarget FPS"],
  export_fps: ["Export FPS", "Export FPS"],
  source_fps: ["Source FPS", "Source FPS"],
  batch_size: ["Batch Size", "Batch Size"],
  out_dir: ["Output Directory", "输出目录"],
  folder_label: ["Folder", "目录"],
  library_folder_label: ["Library Folder", "资源目录"],
  entry_count: ["Entries", "条目"],
  file_count: ["Files", "文件"],
};

/** Bottom task panel and JobSpec editor, modelled after VS Code's docked panel. */
export function JobDrawer({ locale }: { locale: WorkspaceLocale }) {
  const text = useLocaleText(locale);
  const [open, setOpen] = useState(false);
  const [height, setHeight] = useState(() =>
    Math.max(MIN_HEIGHT, Number(localStorage.getItem(HEIGHT_KEY)) || 300),
  );
  const [jobs, setJobs] = useState<JobHistoryRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorTitle, setEditorTitle] = useState("");
  const [editorText, setEditorText] = useState("");
  const [editorBusy, setEditorBusy] = useState(false);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [editorValidation, setEditorValidation] =
    useState<JobReplayCapability | null>(null);
  const importInput = useRef<HTMLInputElement>(null);
  const stopResizeRef = useRef<(() => void) | null>(null);

  // Job history has one runtime-owned poller. This view consumes immutable
  // snapshots and emits commands, avoiding a second polling/download layer.
  const dispatch = (detail: JobHistoryCommandDetail) =>
    windowEventBus.emit("hhtools:job-history-command", detail);
  const bridge = () => {
    if (!window.__hhApp)
      throw new Error(
        text(
          "The WebUI is not ready yet. Try again shortly.",
          "WebUI 尚未准备完成，请稍后重试",
        ),
      );
    return window.__hhApp;
  };
  const messageOf = (value: unknown) =>
    value instanceof Error ? value.message : String(value);
  const localized = (labels: [string, string] | undefined, fallback: string) =>
    labels ? text(labels[0], labels[1]) : fallback;

  useWindowEvent("hhtools:job-history-state", (event) => {
    setJobs(event.detail.jobs);
    setLoading(event.detail.loading);
    setError(event.detail.error);
  });
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "j") {
        event.preventDefault();
        setOpen((current) => !current);
      }
    };
    const importRequest = () => importInput.current?.click();
    window.addEventListener("keydown", keydown);
    window.addEventListener("hhtools:job-spec-import-request", importRequest);
    dispatch({ command: "refresh" });
    return () => {
      window.removeEventListener("keydown", keydown);
      window.removeEventListener(
        "hhtools:job-spec-import-request",
        importRequest,
      );
      stopResizeRef.current?.();
    };
  }, []);

  const startResize = (event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const startY = event.clientY;
    const startHeight = height;
    let nextHeight = startHeight;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
    const move = (moveEvent: globalThis.PointerEvent) => {
      nextHeight = Math.max(
        MIN_HEIGHT,
        Math.min(
          window.innerHeight - 160,
          startHeight + startY - moveEvent.clientY,
        ),
      );
      setHeight(nextHeight);
    };
    const stop = () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      localStorage.setItem(HEIGHT_KEY, String(Math.round(nextHeight)));
      stopResizeRef.current = null;
    };
    stopResizeRef.current?.();
    stopResizeRef.current = stop;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
    window.addEventListener("pointercancel", stop, { once: true });
  };

  const resetEditorValidation = () => {
    setEditorError(null);
    setEditorValidation(null);
  };
  const openEditor = (title: string, value: unknown) => {
    // Imported full configs and duplicated jobs converge on one JobSpec editor;
    // server validation normalizes both before replay is allowed.
    setEditorTitle(title);
    setEditorText(JSON.stringify(value, null, 2));
    resetEditorValidation();
    setEditorOpen(true);
  };
  const closeEditor = () => {
    if (!editorBusy) setEditorOpen(false);
  };
  const importConfig = async (file: File | undefined) => {
    if (!file) return;
    try {
      openEditor(
        `${text("Import configuration", "导入配置")} · ${file.name}`,
        JSON.parse(await file.text()) as unknown,
      );
    } catch (cause) {
      bridge().toast(
        `${text("Unable to read configuration", "读取配置失败")}：${messageOf(cause)}`,
        true,
      );
    }
  };
  const duplicateForEdit = async (job: JobHistoryRecord) => {
    try {
      const config: JobConfigResponse = await bridge().API.get(
        `/api/job/${job.id}/config`,
      );
      openEditor(
        `${text("Duplicate and edit", "复制编辑")} · ${localized(KIND_LABELS[job.kind], job.kind)}`,
        config.spec,
      );
    } catch (cause) {
      bridge().toast(
        `${text("Unable to read task configuration", "读取任务配置失败")}：${messageOf(cause)}`,
        true,
      );
    }
  };
  const validateEditor =
    async (): Promise<JobSpecValidationResponse | null> => {
      setEditorBusy(true);
      resetEditorValidation();
      try {
        let parsed: unknown;
        try {
          parsed = JSON.parse(editorText) as unknown;
        } catch (cause) {
          throw new Error(
            `${text("Invalid JSON", "JSON 格式错误")}：${messageOf(cause)}`,
          );
        }
        // The server, not the client, decides whether referenced source files are
        // still replayable. React only presents that capability result.
        const result = await bridge().API.post(
          "/api/jobs/spec/validate",
          parsed,
        );
        setEditorValidation(result.replay);
        setEditorText(JSON.stringify(result.spec, null, 2));
        return result;
      } catch (cause) {
        setEditorError(messageOf(cause));
        return null;
      } finally {
        setEditorBusy(false);
      }
    };
  const runEditor = async () => {
    const validated = await validateEditor();
    if (!validated?.replay.available) return;
    setEditorBusy(true);
    try {
      const started = await bridge().API.post("/api/jobs/replay", {
        spec: validated.spec,
      });
      bridge().toast(`${text("Created task", "已创建任务")} ${started.job_id}`);
      setEditorOpen(false);
      dispatch({ command: "refresh" });
    } catch (cause) {
      setEditorError(messageOf(cause));
    } finally {
      setEditorBusy(false);
    }
  };
  const retry = async (job: JobHistoryRecord, failedOnly = false) => {
    if (failedOnly ? !job.can_retry_failed : !job.can_retry) return;
    try {
      const started = await bridge().API.post("/api/jobs/replay", {
        job_id: job.id,
        failed_only: failedOnly,
      });
      bridge().toast(
        `${text(failedOnly ? "Created failed-item retry task" : "Created retry task", failedOnly ? "已创建失败项重试任务" : "已创建重试任务")} ${started.job_id}`,
      );
      dispatch({ command: "refresh" });
    } catch (cause) {
      bridge().toast(
        `${text("Retry failed", "重试失败")}：${messageOf(cause)}`,
        true,
      );
    }
  };
  const formatTime = (timestamp: number) =>
    !Number.isFinite(timestamp) || timestamp <= 0
      ? text("Unknown time", "时间未知")
      : new Intl.DateTimeFormat(locale === "en" ? "en-US" : "zh-CN", {
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hour12: false,
        }).format(new Date(timestamp * 1000));
  const formatDuration = (seconds: number) => {
    if (!Number.isFinite(seconds) || seconds < 0) return "";
    if (seconds < 60)
      return `${Math.max(1, Math.round(seconds))} ${text("sec", "秒")}`;
    return `${Math.floor(seconds / 60)} ${text("min", "分")} ${Math.round(seconds % 60)} ${text("sec", "秒")}`;
  };
  const resultText = (job: JobHistoryRecord) => {
    const parts: string[] = [];
    if (typeof job.result_summary.success_count === "number")
      parts.push(
        `${job.result_summary.success_count} ${text("succeeded", "成功")}`,
      );
    if (
      typeof job.result_summary.failure_count === "number" &&
      job.result_summary.failure_count > 0
    )
      parts.push(
        `${job.result_summary.failure_count} ${text("failed", "失败")}`,
      );
    if (typeof job.result_summary.num_frames === "number")
      parts.push(`${job.result_summary.num_frames} ${text("frames", "帧")}`);
    return parts.join(" · ");
  };
  const parameterEntries = (job: JobHistoryRecord) =>
    Object.entries(job.parameters).slice(0, 6) as Array<
      [string, JobParameterValue]
    >;
  const style = open
    ? ({ "--job-panel-height": `${height}px` } as CSSProperties)
    : undefined;

  return (
    <>
      <section
        className={cn("job-drawer docked-job-panel", open && "open")}
        style={style}
        aria-label={text("Task history", "任务历史")}
      >
        {open && (
          <div
            className="job-panel-resizer"
            title={text(
              "Drag to resize the task panel",
              "拖动调整任务面板高度",
            )}
            aria-hidden="true"
            onPointerDown={startResize}
          />
        )}
        {!open ? (
          <button
            type="button"
            className="job-drawer-summary"
            aria-expanded="false"
            aria-controls="job-drawer-panel"
            title={text("Toggle Tasks (Ctrl+J)", "切换任务面板 (Ctrl+J)")}
            onClick={() => setOpen(true)}
          >
            <span className="job-summary-title">{text("Tasks", "任务")}</span>
            <ChevronUp
              className="job-summary-chevron job-chevron-icon"
              aria-hidden="true"
            />
          </button>
        ) : (
          <div id="job-drawer-panel" className="job-drawer-panel">
            <header className="job-drawer-head">
              <div>
                <strong>{text("Task History", "任务历史")}</strong>
                <span>
                  {text("Stored locally", "本机持久化")} · {jobs.length}
                </span>
              </div>
              <div className="job-drawer-head-actions">
                <input
                  ref={importInput}
                  className="sr-only"
                  type="file"
                  accept="application/json,.json"
                  onChange={(event) => {
                    const file = event.currentTarget.files?.[0];
                    event.currentTarget.value = "";
                    void importConfig(file);
                  }}
                />
                <button
                  type="button"
                  className="job-icon-btn"
                  title={text("Refresh tasks", "刷新任务")}
                  aria-label={text("Refresh tasks", "刷新任务")}
                  onClick={() => dispatch({ command: "refresh" })}
                >
                  <RefreshCw aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="job-icon-btn"
                  title={text("Collapse tasks", "收起任务")}
                  aria-label={text("Collapse tasks", "收起任务")}
                  aria-expanded="true"
                  aria-controls="job-drawer-panel"
                  onClick={() => setOpen(false)}
                >
                  <ChevronDown
                    className="job-chevron-icon"
                    aria-hidden="true"
                  />
                </button>
              </div>
            </header>
            {error && (
              <p className="job-drawer-error" role="alert">
                {error}
              </p>
            )}
            {loading && jobs.length === 0 && (
              <p className="job-drawer-empty" role="status">
                {text("Loading tasks…", "正在读取任务…")}
              </p>
            )}
            {!loading && !error && jobs.length === 0 && (
              <p className="job-drawer-empty">
                {text(
                  "Retarget, Batch, and dataset analysis runs will appear here.",
                  "运行 Retarget、Batch 或数据集分析后，记录会保存在这里。",
                )}
              </p>
            )}
            <div className="job-list" aria-live="polite">
              {jobs.map((job) => {
                const summary = resultText(job);
                const parameters = parameterEntries(job);
                return (
                  <article
                    key={job.id}
                    className={cn("job-row", `state-${job.status}`)}
                  >
                    <span className="job-status-dot" aria-hidden="true" />
                    <div className="job-row-main">
                      <div className="job-row-title">
                        <strong>
                          {localized(KIND_LABELS[job.kind], job.kind)}
                        </strong>
                        <span className="job-status-label">
                          {localized(STATUS_LABELS[job.status], job.status)}
                        </span>
                        <time
                          dateTime={new Date(
                            job.created_at * 1000,
                          ).toISOString()}
                        >
                          {formatTime(job.created_at)}
                        </time>
                        <span>{formatDuration(job.duration_seconds)}</span>
                      </div>
                      <p
                        className={cn("job-row-message", job.error && "error")}
                        title={job.error || job.message}
                      >
                        {job.error ||
                          job.message ||
                          localized(STATUS_LABELS[job.status], job.status)}
                      </p>
                      {job.status === "running" && (
                        <div
                          className="job-progress"
                          role="progressbar"
                          aria-valuenow={Math.round(job.progress * 100)}
                          aria-valuemin={0}
                          aria-valuemax={100}
                        >
                          <span
                            style={{
                              width: `${Math.round(job.progress * 100)}%`,
                            }}
                          />
                        </div>
                      )}
                      {(parameters.length > 0 || summary) && (
                        <div className="job-row-meta">
                          {parameters.map(([key, value]) => (
                            <span key={key}>
                              {localized(PARAMETER_LABELS[key], key)}: {value}
                            </span>
                          ))}
                          {summary && (
                            <span className="job-result-summary">
                              {summary}
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                    <div className="job-row-actions">
                      <button
                        type="button"
                        className="job-action-btn primary"
                        disabled={!job.can_retry}
                        title={
                          job.can_retry
                            ? text(
                                "Create a new task from saved sources and effective parameters",
                                "使用保存的源文件和有效参数创建新任务",
                              )
                            : job.retry_reason || undefined
                        }
                        onClick={() => void retry(job)}
                      >
                        {text("Retry", "重试")}
                      </button>
                      {job.can_retry_failed && (
                        <button
                          type="button"
                          className="job-action-btn"
                          onClick={() => void retry(job, true)}
                        >
                          {text("Retry failed only", "仅重试失败项")} (
                          {job.failed_item_count})
                        </button>
                      )}
                      <button
                        type="button"
                        className="job-action-btn"
                        onClick={() => void duplicateForEdit(job)}
                      >
                        {text("Duplicate & Edit", "复制编辑")}
                      </button>
                      {job.can_copy_cli && (
                        <button
                          type="button"
                          className="job-action-btn"
                          onClick={() =>
                            dispatch({ command: "copy-cli", jobId: job.id })
                          }
                        >
                          {text("Copy CLI", "复制 CLI")}
                        </button>
                      )}
                      <button
                        type="button"
                        className="job-action-btn"
                        onClick={() =>
                          dispatch({ command: "copy-config", jobId: job.id })
                        }
                      >
                        {text("Copy Config", "复制配置")}
                      </button>
                      <button
                        type="button"
                        className="job-action-btn"
                        onClick={() =>
                          dispatch({
                            command: "download-config",
                            jobId: job.id,
                          })
                        }
                      >
                        {text("Save Config", "保存配置")}
                      </button>
                      {job.can_download && (
                        <button
                          type="button"
                          className="job-action-btn primary"
                          onClick={() =>
                            dispatch({
                              command: "download",
                              jobId: job.id,
                              filename:
                                typeof job.result_summary.download_name ===
                                "string"
                                  ? job.result_summary.download_name
                                  : undefined,
                            })
                          }
                        >
                          {text("Download Result", "下载结果")}
                        </button>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
          </div>
        )}
      </section>
      {editorOpen &&
        createPortal(
          <div
            className="job-spec-backdrop"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) closeEditor();
            }}
          >
            <section
              className="job-spec-dialog"
              role="dialog"
              aria-modal="true"
              aria-label={editorTitle}
            >
              <header className="job-spec-dialog-head">
                <div>
                  <strong>{editorTitle}</strong>
                  <span>
                    JobSpec v1 ·{" "}
                    {text(
                      "Validate changes before running a new task",
                      "修改后先验证，再作为新任务运行",
                    )}
                  </span>
                </div>
                <button
                  type="button"
                  className="job-icon-btn"
                  title={text("Close", "关闭")}
                  aria-label={text("Close", "关闭")}
                  disabled={editorBusy}
                  onClick={closeEditor}
                >
                  <X aria-hidden="true" />
                </button>
              </header>
              <textarea
                className="job-spec-editor"
                spellCheck="false"
                aria-label="JobSpec JSON"
                value={editorText}
                onChange={(event) => {
                  setEditorText(event.currentTarget.value);
                  resetEditorValidation();
                }}
              />
              <div className="job-spec-feedback" aria-live="polite">
                {editorError ? (
                  <p className="error">{editorError}</p>
                ) : editorValidation?.available ? (
                  <p className="ok">
                    {text(
                      "Configuration is valid and can rerun from",
                      "配置有效，可从",
                    )}{" "}
                    {editorValidation.source_count}{" "}
                    {text("local source files.", "个本地源文件重新运行。")}
                  </p>
                ) : editorValidation ? (
                  <p className="warning">
                    {text(
                      "The configuration is valid but cannot run directly",
                      "配置格式有效，但不能直接运行",
                    )}
                    ：{editorValidation.reason}
                  </p>
                ) : (
                  <p>
                    {text(
                      "Import a full configuration downloaded from task history or a standalone JobSpec JSON.",
                      "支持导入从任务历史下载的完整配置，或独立 JobSpec JSON。",
                    )}
                  </p>
                )}
              </div>
              <footer className="job-spec-dialog-actions">
                <button
                  type="button"
                  className="job-action-btn"
                  disabled={editorBusy}
                  onClick={closeEditor}
                >
                  {text("Cancel", "取消")}
                </button>
                <button
                  type="button"
                  className="job-action-btn"
                  disabled={editorBusy}
                  onClick={() => void validateEditor()}
                >
                  {editorBusy
                    ? text("Validating…", "验证中…")
                    : text("Validate Config", "验证配置")}
                </button>
                <button
                  type="button"
                  className="job-action-btn primary"
                  disabled={editorBusy || editorValidation?.available === false}
                  onClick={() => void runEditor()}
                >
                  {text("Run as New Task", "作为新任务运行")}
                </button>
              </footer>
            </section>
          </div>,
          document.body,
        )}
    </>
  );
}
