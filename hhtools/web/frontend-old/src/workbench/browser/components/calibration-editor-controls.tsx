import { useMemo, useState } from "react";

import { useLocaleText } from "@/workbench/services/localization/browser/use-locale-text";
import { useWindowEvent } from "@/platform/events/browser/use-window-event";
import { windowEventBus } from "@/platform/events/browser/window-event-bus";
import type {
  CalibrationEditorCommand,
  CalibrationEditorStateDetail,
  CalibrationJointRegion,
  WorkflowId,
} from "@/runtime/types";
import type { WorkspaceLocale } from "@/workbench/common/workspace";
import { cn } from "@/lib/utils";

function initialState(workflow: WorkflowId): CalibrationEditorStateDetail {
  return {
    workflow,
    active: false,
    totalJoints: 0,
    visibleJoints: 0,
    mappedLandmarks: 0,
    canUseSaved: false,
    query: "",
    region: "all",
    unit: "rad",
    comparison: "current",
    mappedOnly: true,
    labels: true,
    mappingLines: true,
    sourceOpacity: 0.82,
    robotOpacity: 0.72,
  };
}

/**
 * Event-driven projection of the calibration domain state.
 *
 * The solver remains the source of truth: it publishes immutable snapshots and
 * this component emits typed intents. That prevents a second calibration model
 * from growing inside React during the staged runtime migration.
 */
export function CalibrationEditorControls({
  workflow,
  locale,
}: {
  workflow: WorkflowId;
  locale: WorkspaceLocale;
}) {
  const text = useLocaleText(locale);
  const [state, setState] = useState(() => initialState(workflow));
  useWindowEvent("hhtools:calibration-editor-state", (event) => {
    if (event.detail.workflow === workflow) setState(event.detail);
  });
  const send = (
    command: CalibrationEditorCommand,
    value?: string | number | boolean,
  ): void => {
    windowEventBus.emit("hhtools:calibration-editor-command", {
      workflow,
      command,
      value,
    });
  };
  const regions = useMemo<
    Array<{ value: CalibrationJointRegion | "all"; label: string }>
  >(
    () => [
      { value: "all", label: text("All", "全部") },
      { value: "torso", label: text("Torso", "躯干") },
      { value: "left-arm", label: text("Left arm", "左臂") },
      { value: "right-arm", label: text("Right arm", "右臂") },
      { value: "left-leg", label: text("Left leg", "左腿") },
      { value: "right-leg", label: text("Right leg", "右腿") },
      { value: "head", label: text("Head", "头部") },
      { value: "hands", label: text("Hands", "手部") },
    ],
    [text],
  );

  return (
    <section
      className="calibration-editor-tools"
      aria-label={text(
        `${workflow.toUpperCase()} calibration controls`,
        `${workflow.toUpperCase()} 标定控件`,
      )}
    >
      <div className="calibration-tool-row calibration-search-row">
        <label className="calibration-search-field">
          <span className="sr-only">{text("Search joints", "搜索关节")}</span>
          <input
            type="search"
            value={state.query}
            placeholder={text("Search joints", "搜索关节")}
            autoComplete="off"
            onChange={(event) => send("search", event.currentTarget.value)}
          />
        </label>
        <span className="calibration-result-count">
          {state.visibleJoints} / {state.totalJoints}
        </span>
        <div
          className="calibration-segmented"
          aria-label={text("Angle unit", "角度单位")}
        >
          <button
            type="button"
            className={cn(state.unit === "rad" && "active")}
            onClick={() => send("unit", "rad")}
          >
            rad
          </button>
          <button
            type="button"
            className={cn(state.unit === "deg" && "active")}
            onClick={() => send("unit", "deg")}
          >
            deg
          </button>
        </div>
      </div>
      <div
        className="calibration-region-tabs"
        aria-label={text("Joint regions", "关节分组")}
      >
        {regions.map((region) => (
          <button
            key={region.value}
            type="button"
            className={cn(state.region === region.value && "active")}
            aria-pressed={state.region === region.value}
            onClick={() => send("region", region.value)}
          >
            {region.label}
          </button>
        ))}
      </div>
      <div className="calibration-tool-row calibration-comparison-row">
        <span className="calibration-tool-label">
          {text("Pose comparison", "姿态对照")}
        </span>
        <div className="calibration-segmented calibration-comparison">
          <button
            type="button"
            className={cn(state.comparison === "current" && "active")}
            onClick={() => send("comparison", "current")}
          >
            {text("Current edit", "当前编辑")}
          </button>
          <button
            type="button"
            disabled={!state.canUseSaved}
            className={cn(state.comparison === "saved" && "active")}
            onClick={() => send("comparison", "saved")}
          >
            {text("Saved", "已保存")}
          </button>
          <button
            type="button"
            className={cn(state.comparison === "zero" && "active")}
            onClick={() => send("comparison", "zero")}
          >
            {text("URDF zero", "URDF 零位")}
          </button>
        </div>
        <button
          type="button"
          className="calibration-reset-region"
          onClick={() => send("reset-region")}
        >
          {text("Zero current region", "当前分组归零")}
        </button>
      </div>
      <div className="calibration-tool-row calibration-visibility-row">
        <span className="calibration-tool-label">
          {text("Stage display", "舞台显示")}
        </span>
        <label>
          <input
            type="checkbox"
            checked={state.mappedOnly}
            onChange={(event) =>
              send("mapped-only", event.currentTarget.checked)
            }
          />
          {text("Mapped only", "仅映射点")}
        </label>
        <label>
          <input
            type="checkbox"
            checked={state.labels}
            onChange={(event) => send("labels", event.currentTarget.checked)}
          />
          {text("Semantic labels", "语义标签")}
        </label>
        <label>
          <input
            type="checkbox"
            checked={state.mappingLines}
            onChange={(event) =>
              send("mapping-lines", event.currentTarget.checked)
            }
          />
          {text("Mapping lines", "映射线")}
        </label>
        <span className="calibration-landmark-count">
          {text(
            `${state.mappedLandmarks} mapped`,
            `${state.mappedLandmarks} 个映射`,
          )}
        </span>
      </div>
      <div className="calibration-opacity-grid">
        <label>
          <span>{text("Reference skeleton", "参考骨架")}</span>
          <input
            type="range"
            min="0.15"
            max="1"
            step="0.05"
            value={state.sourceOpacity}
            onChange={(event) =>
              send("source-opacity", Number(event.currentTarget.value))
            }
          />
        </label>
        <label>
          <span>{text("Target robot", "目标机器人")}</span>
          <input
            type="range"
            min="0.2"
            max="1"
            step="0.05"
            value={state.robotOpacity}
            onChange={(event) =>
              send("robot-opacity", Number(event.currentTarget.value))
            }
          />
        </label>
      </div>
    </section>
  );
}
