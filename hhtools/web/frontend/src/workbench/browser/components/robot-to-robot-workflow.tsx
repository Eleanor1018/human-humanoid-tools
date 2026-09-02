import { useState } from "react";

import { useLocaleText } from "@/hooks/use-locale-text";
import type {
  WorkspaceLocale,
  WorkspacePanelId,
} from "@/workbench/common/workspace";
import { CalibrationEditorControls } from "./calibration-editor-controls";
import { MotionPickerDialog } from "./motion-picker-dialog";
import { ResultEvaluationPanel } from "./result-evaluation-panel";
import { WorkflowPipeline } from "./workflow-pipeline";

/**
 * R2R workflow shell shared by browser and Electron. Hidden import controls at
 * the bottom intentionally preserve profile-specific ports used by the runtime.
 */
export function RobotToRobotWorkflow({
  locale,
  onRequestPanel,
}: {
  locale: WorkspaceLocale;
  onRequestPanel(panel: WorkspacePanelId): void;
}) {
  const text = useLocaleText(locale);
  const [pickerOpen, setPickerOpen] = useState(false);
  const importTrajectory = async (options?: { folder?: boolean }) =>
    window.__hhApp?.pickR2rTrajectory({ folder: options?.folder === true });
  return (
    <div className="panel-stack workflow-panel-stack">
      <h2>{text("Robot → Robot", "机器人 → 机器人")}</h2>
      <WorkflowPipeline workflow="r2r" locale={locale} />
      <details id="r2r-step-source" className="video-workflow-step" open>
        <summary className="video-workflow-step-summary">
          <span>{text("1. Source robot", "1. 源机器人")}</span>
        </summary>
        <div className="video-workflow-step-body workflow-compact-controls">
          <div className="workflow-picker-row">
            <select id="r2r-source-select" className="search" />
            <button
              type="button"
              className="btn secondary small"
              onClick={() => onRequestPanel("robot-assets")}
            >
              {text("Import robot", "导入机器人")}
            </button>
          </div>
          <button
            id="r2r-source-load"
            type="button"
            className="btn workflow-load-button"
          >
            {text("Load robot", "加载机器人")}
          </button>
          <p
            id="r2r-source-status"
            className="hint workflow-status-line"
            role="status"
          >
            {text("No source robot loaded.", "尚未加载源机器人。")}
          </p>
        </div>
      </details>
      <details id="r2r-step-trajectory" className="video-workflow-step">
        <summary className="video-workflow-step-summary">
          <span>{text("2. Source trajectory", "2. 源轨迹")}</span>
        </summary>
        <div className="video-workflow-step-body workflow-compact-controls">
          <div className="workflow-selection-row">
            <span
              id="r2r-trajectory-value"
              className="workflow-selection-value"
            >
              {text("Not loaded", "未加载")}
            </span>
            <button
              type="button"
              className="btn secondary small"
              onClick={() => setPickerOpen(true)}
            >
              {text("Select trajectory", "选择轨迹")}
            </button>
          </div>
          <label className="video-workflow-field workflow-inline-field">
            <span className="k">
              {text("Source trajectory FPS", "源轨迹 FPS")}
            </span>
            <input
              id="r2r-source-fps"
              className="search"
              type="number"
              min="1"
              step="1"
              defaultValue="50"
            />
          </label>
          <p
            id="r2r-traj-status"
            className="hint workflow-status-line"
            role="status"
          >
            {text(
              "Load the source robot, then select a trajectory.",
              "先加载源机器人，再选择轨迹。",
            )}
          </p>
          <div
            id="r2r-traj-progress"
            className="progress video-workflow-progress"
            style={{ display: "none" }}
          >
            <div className="bar" />
          </div>
        </div>
      </details>
      <details id="r2r-step-target" className="video-workflow-step">
        <summary className="video-workflow-step-summary">
          <span>{text("3. Target robot", "3. 目标机器人")}</span>
        </summary>
        <div className="video-workflow-step-body workflow-compact-controls">
          <div className="workflow-picker-row">
            <select id="r2r-target-select" className="search" />
            <button
              type="button"
              className="btn secondary small"
              onClick={() => onRequestPanel("robot-assets")}
            >
              {text("Import robot", "导入机器人")}
            </button>
          </div>
          <button
            id="r2r-target-load"
            type="button"
            className="btn workflow-load-button"
          >
            {text("Load robot", "加载机器人")}
          </button>
          <p
            id="r2r-target-status"
            className="hint workflow-status-line"
            role="status"
          >
            {text("No target robot loaded.", "尚未加载目标机器人。")}
          </p>
        </div>
      </details>
      <details id="r2r-step-calibration" className="video-workflow-step">
        <summary className="video-workflow-step-summary">
          <span>{text("4. Calibration", "4. 标定")}</span>
        </summary>
        <div className="video-workflow-step-body workflow-compact-controls">
          <div className="workflow-selection-row">
            <div className="workflow-selection-copy">
              <span className="k">{text("Calibration", "标定")}</span>
              <strong id="r2r-cal">
                <span className="status-chip">
                  <span className="dot" />—
                </span>
              </strong>
            </div>
            <button
              id="r2r-calib-btn"
              type="button"
              className="btn secondary small"
              disabled
            >
              {text("Calibrate", "开始标定")}
            </button>
          </div>
          <p id="r2r-calibration-scope" className="hint workflow-status-line">
            {text("Target robot + source robot", "目标机器人 + 源机器人")}
          </p>
          <div
            id="r2r-calibration-validation-summary"
            className="validation-summary"
            aria-live="polite"
          />
          <div
            id="r2r-calibration-save-summary"
            className="calibration-save-summary"
            aria-live="polite"
          />
          <div
            id="r2r-calib-edit"
            className="workflow-calibration-editor"
            style={{ display: "none" }}
          >
            <CalibrationEditorControls workflow="r2r" locale={locale} />
            <div id="r2r-calib-sliders" className="calibration-joint-list" />
            <div className="workflow-button-row">
              <button
                id="r2r-calib-zero"
                type="button"
                className="btn secondary small"
              >
                {text("Zero", "归零")}
              </button>
              <button
                id="r2r-calib-cancel"
                type="button"
                className="btn secondary small"
              >
                {text("Cancel", "取消")}
              </button>
              <button id="r2r-calib-save" type="button" className="btn small">
                {text("Save", "保存标定")}
              </button>
            </div>
          </div>
        </div>
      </details>
      <details id="r2r-step-result" className="video-workflow-step">
        <summary className="video-workflow-step-summary">
          <span>{text("5. Result", "5. 结果")}</span>
        </summary>
        <div className="video-workflow-step-body workflow-compact-controls">
          <div className="workflow-field-grid">
            <label className="video-workflow-field">
              <span className="k">{text("Solver", "求解器")}</span>
              <select id="r2r-backend" className="search">
                <option value="newton">Newton IK</option>
                <option value="interaction_mesh">Interaction-Mesh</option>
              </select>
            </label>
            <label className="video-workflow-field">
              <span className="k">Retarget FPS</span>
              <input
                id="r2r-retarget-fps"
                className="search"
                type="number"
                min="1"
                step="1"
                placeholder={text("Trajectory FPS", "轨迹原始帧率")}
              />
            </label>
          </div>
          <button id="r2r-retarget-btn" type="button" className="btn" disabled>
            {text("Start Retarget", "开始 Retarget")}
          </button>
          <p
            id="r2r-disabled-reason"
            className="disabled-action-reason"
            role="status"
          >
            {text(
              "Select the source robot, trajectory, and target robot first.",
              "请先加载源机器人、源轨迹与目标机器人。",
            )}
          </p>
          <div
            id="r2r-progress"
            className="progress video-workflow-progress"
            style={{ display: "none" }}
          >
            <div className="bar" />
          </div>
          <p
            id="r2r-status"
            className="hint workflow-status-line"
            role="status"
          />
          <ResultEvaluationPanel workflow="r2r" locale={locale} />
          <div
            id="r2r-export-card"
            className="workflow-export-section"
            style={{ display: "none" }}
          >
            <div className="workflow-field-grid">
              <label className="video-workflow-field">
                <span className="k">{text("Export FPS", "导出 FPS")}</span>
                <input
                  id="r2r-export-fps"
                  className="search"
                  type="number"
                  min="1"
                  step="1"
                  placeholder={text("Result FPS", "结果帧率")}
                />
              </label>
              <label className="video-workflow-field">
                <span className="k">{text("Format", "格式")}</span>
                <select id="r2r-export-format" className="search">
                  <option value="csv">CSV</option>
                  <option value="pkl">PKL</option>
                </select>
              </label>
            </div>
            <div className="workflow-field-grid">
              <label className="video-workflow-field">
                <span className="k">{text("Start (s)", "起始 (s)")}</span>
                <input
                  id="r2r-export-t-start"
                  className="search"
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder="0"
                />
              </label>
              <label className="video-workflow-field">
                <span className="k">{text("End (s)", "截止 (s)")}</span>
                <input
                  id="r2r-export-t-end"
                  className="search"
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder={text("End", "结尾")}
                />
              </label>
            </div>
            <label className="workflow-checkbox-row">
              <input id="r2r-csv-header" type="checkbox" defaultChecked />
              <span>{text("Include CSV header", "CSV 含注释与列名表头")}</span>
            </label>
            <p
              id="r2r-export-bundle-hint"
              className="hint workflow-status-line"
              style={{ display: "none" }}
            />
            <button id="r2r-export-btn" type="button" className="btn secondary">
              {text("Download result", "下载导出文件")}
            </button>
          </div>
        </div>
      </details>
      {/* These controls are runtime ports, not duplicate UI. Keeping them
          mounted lets command-palette imports reuse the tested upload path. */}
      <div className="workflow-hidden-runtime" hidden aria-hidden="true">
        <div id="r2r-drop-mimic" data-r2r-profile="mimic">
          <button type="button" data-r2r-pick="mimic" />
          <button type="button" data-r2r-pick="mimic" data-folder="1" />
        </div>
        <div id="r2r-drop-intermimic" data-r2r-profile="intermimic">
          <button type="button" data-r2r-pick="intermimic" data-folder="1" />
        </div>
        <div id="r2r-drop-meshmimic" data-r2r-profile="meshmimic">
          <button type="button" data-r2r-pick="meshmimic" data-folder="1" />
        </div>
      </div>
      <MotionPickerDialog
        open={pickerOpen}
        locale={locale}
        assetKind="robot_trajectory"
        onClose={() => setPickerOpen(false)}
        onImport={(options) => {
          setPickerOpen(false);
          void importTrajectory(options);
        }}
      />
    </div>
  );
}
