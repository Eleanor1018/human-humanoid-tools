import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
} from "react";
import { ChevronDown, ChevronUp, RefreshCw } from "lucide-react";

import { useLocaleText } from "@/workbench/services/localization/browser/use-locale-text";
import { useWindowEvent } from "@/platform/events/browser/use-window-event";
import { cn } from "@/lib/utils";
import { windowEventBus } from "@/platform/events/browser/window-event-bus";
import type {
  JobHistoryRecord,
  JobParameterValue,
  JobStatus,
} from "@/domain/jobs/job";
import type { JobHistoryCommandDetail } from "@/runtime/types";
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

/** Bottom task history panel with result export, modelled after VS Code's docked panel. */
export function JobDrawer({ locale }: { locale: WorkspaceLocale }) {
  const text = useLocaleText(locale);
  const [open, setOpen] = useState(false);
  const [height, setHeight] = useState(() =>
    Math.max(MIN_HEIGHT, Number(localStorage.getItem(HEIGHT_KEY)) || 300),
  );
  const [jobs, setJobs] = useState<JobHistoryRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stopResizeRef = useRef<(() => void) | null>(null);

  // Job history has one runtime-owned poller. This view consumes immutable
  // snapshots and emits commands, avoiding a second polling/download layer.
  const dispatch = (detail: JobHistoryCommandDetail) =>
    windowEventBus.emit("hhtools:job-history-command", detail);
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
    window.addEventListener("keydown", keydown);
    dispatch({ command: "refresh" });
    return () => {
      window.removeEventListener("keydown", keydown);
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
                    {job.can_download && (
                      <div className="job-row-actions">
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
                          {text("Export Result", "导出结果")}
                        </button>
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          </div>
        )}
    </section>
  );
}
