import { useMemo, useState } from "react";

import { useLocaleText } from "@/hooks/use-locale-text";
import { useWindowEvent } from "@/hooks/use-window-event";
import { windowEventBus } from "@/platform/events/browser/window-event-bus";
import type {
  ComparisonPreset,
  ResultDiagnostics,
  WorkspaceLocale,
  WorkflowId,
} from "@/runtime/types";
import { loadWorkspacePreferences } from "@/runtime/workspace-preferences";
import { cn } from "@/lib/utils";

interface ResultEvaluationPanelProps {
  workflow: WorkflowId;
  locale: WorkspaceLocale;
}

function formatCm(value: number | null | undefined): string {
  return value == null ? "—" : `${(value * 100).toFixed(1)} cm`;
}

function formatPercent(value: number | null | undefined): string {
  return value == null ? "—" : `${(value * 100).toFixed(0)}%`;
}

/** React-owned diagnostics view; the solver publishes immutable snapshots. */
export function ResultEvaluationPanel({
  workflow,
  locale,
}: ResultEvaluationPanelProps) {
  const text = useLocaleText(locale);
  const [diagnostics, setDiagnostics] = useState<ResultDiagnostics | null>(
    null,
  );
  const [comparisonPreset, setComparisonPreset] = useState<ComparisonPreset>(
    () => loadWorkspacePreferences().comparisonPresets[workflow],
  );

  useWindowEvent("hhtools:result-diagnostics", (event) => {
    if (event.detail.workflow !== workflow) return;
    setDiagnostics(event.detail.diagnostics);
    setComparisonPreset(event.detail.comparisonPreset);
  });
  useWindowEvent("hhtools:comparison-state", (event) => {
    if (event.detail.workflow === workflow)
      setComparisonPreset(event.detail.preset);
  });

  const presets = useMemo<Array<{ id: ComparisonPreset; label: string }>>(
    () => [
      { id: "source", label: text("Source data", "源数据") },
      { id: "target", label: text("Scaled target", "缩放目标") },
      { id: "result", label: text("Robot result", "机器人结果") },
      { id: "overlay", label: text("Overlay", "叠加对比") },
    ],
    [text],
  );

  if (!diagnostics) return null;

  const tracking = diagnostics.tracking;
  const p95 = tracking?.p95_error_m;
  const quality =
    !diagnostics.available || p95 === undefined
      ? {
          label: text("Diagnostics unavailable", "诊断不可用"),
          tone: "neutral",
        }
      : p95 <= 0.05
        ? { label: text("Stable tracking", "跟踪稳定"), tone: "good" }
        : p95 <= 0.1
          ? { label: text("Review recommended", "建议复核"), tone: "warning" }
          : { label: text("Large deviation", "偏差较大"), tone: "danger" };

  const series = tracking?.series ?? [];
  const chart =
    series.length < 2
      ? null
      : (() => {
          const width = 320;
          const height = 72;
          const maxError = Math.max(
            ...series.map((point) => point.max_error_m),
            0.001,
          );
          const points = (key: "mean_error_m" | "max_error_m") =>
            series
              .map((point, index) => {
                const x = (index * width) / Math.max(1, series.length - 1);
                const y = height - (point[key] / maxError) * (height - 8) - 4;
                return `${x.toFixed(1)},${y.toFixed(1)}`;
              })
              .join(" ");
          return {
            width,
            height,
            maxError,
            mean: points("mean_error_m"),
            max: points("max_error_m"),
          };
        })();

  return (
    <section
      className="card result-evaluation"
      aria-label={text("Result evaluation", "结果评估")}
    >
      <header className="result-evaluation-head">
        <div>
          <h3>{text("Result evaluation", "结果评估")}</h3>
          <p>
            {text(
              "Quick diagnostics for the scaled target and robot result",
              "缩放目标与机器人结果的快速诊断",
            )}
          </p>
        </div>
        <span className={cn("result-quality", `tone-${quality.tone}`)}>
          {quality.label}
        </span>
      </header>

      <div
        className="comparison-presets"
        role="group"
        aria-label={text("Result comparison view", "结果对比视图")}
      >
        {presets.map((preset) => (
          <button
            key={preset.id}
            type="button"
            data-preset={preset.id}
            className={cn(comparisonPreset === preset.id && "active")}
            aria-pressed={comparisonPreset === preset.id}
            onClick={() =>
              windowEventBus.emit("hhtools:comparison-command", {
                workflow,
                preset: preset.id,
              })
            }
          >
            {preset.label}
          </button>
        ))}
      </div>

      {!diagnostics.available && (
        <p className="result-diagnostics-empty" role="status">
          {diagnostics.reason ||
            text(
              "The current result does not contain enough mapped data for diagnostics.",
              "当前结果没有足够的映射数据可供诊断。",
            )}
        </p>
      )}

      {diagnostics.available && tracking && (
        <>
          <div className="result-metrics">
            <div className="result-metric">
              <span>{text("Mean error", "平均误差")}</span>
              <strong>{formatCm(tracking.mean_error_m)}</strong>
            </div>
            <div className="result-metric">
              <span>{text("P95 error", "P95 误差")}</span>
              <strong>{formatCm(tracking.p95_error_m)}</strong>
            </div>
            <div className="result-metric">
              <span>{text("Contact agreement", "接触一致率")}</span>
              <strong>
                {diagnostics.contact?.available
                  ? formatPercent(diagnostics.contact.agreement_ratio)
                  : "—"}
              </strong>
            </div>
            <div className="result-metric">
              <span>{text("Foot slide during contact", "接触期足部滑移")}</span>
              <strong>
                {diagnostics.contact?.available
                  ? `${formatCm(diagnostics.contact.target_slide_mean_mps)}/s`
                  : "—"}
              </strong>
            </div>
          </div>
          {chart && (
            <div className="tracking-chart-wrap">
              <div className="tracking-chart-head">
                <span>{text("Per-frame position error", "逐帧位置误差")}</span>
                <span>
                  {text("Peak", "峰值")} {formatCm(chart.maxError)}
                </span>
              </div>
              <svg
                className="tracking-chart"
                viewBox={`0 0 ${chart.width} ${chart.height}`}
                preserveAspectRatio="none"
                role="img"
                aria-label={text(
                  "Per-frame mean and maximum position error chart",
                  "逐帧平均与最大位置误差曲线",
                )}
              >
                <line
                  x1="0"
                  y1={chart.height - 1}
                  x2={chart.width}
                  y2={chart.height - 1}
                />
                <polyline className="tracking-chart-max" points={chart.max} />
                <polyline className="tracking-chart-mean" points={chart.mean} />
              </svg>
              <div className="tracking-chart-legend">
                <span>
                  <i className="mean" />
                  {text("Mean error", "平均误差")}
                </span>
                <span>
                  <i className="max" />
                  {text("Maximum error", "最大误差")}
                </span>
              </div>
            </div>
          )}
          {tracking.effectors.length > 0 && (
            <div className="effector-diagnostics">
              <div className="effector-diagnostics-head">
                <span>
                  {text("Largest mapped-point deviations", "偏差最大的映射点")}
                </span>
                <span>
                  {text(
                    `${diagnostics.mapped_effectors}/${diagnostics.requested_effectors} mapped`,
                    `${diagnostics.mapped_effectors}/${diagnostics.requested_effectors} 已匹配`,
                  )}
                </span>
              </div>
              {tracking.effectors.slice(0, 5).map((effector) => (
                <div
                  key={`${effector.canonical}:${effector.target_link}`}
                  className="effector-row"
                >
                  <span title={effector.target_link}>{effector.canonical}</span>
                  <strong>{formatCm(effector.p95_error_m)}</strong>
                </div>
              ))}
            </div>
          )}
          <p className="result-evaluation-note">
            {text(
              "These diagnostics use Web preview frames to flag tracking and contact anomalies; they do not replace simulation-stability or hardware evaluation.",
              "该诊断基于网页预览帧，用于快速发现跟踪与接触异常，不替代仿真稳定性或真机评测。",
            )}
          </p>
        </>
      )}
    </section>
  );
}
