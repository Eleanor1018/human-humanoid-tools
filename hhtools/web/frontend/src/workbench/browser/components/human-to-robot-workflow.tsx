import { useState } from "react";

import { CalibrationEditorControls } from "./calibration-editor-controls";
import { MotionPickerDialog } from "./motion-picker-dialog";
import { ResultEvaluationPanel } from "./result-evaluation-panel";
import { WorkflowPipeline } from "./workflow-pipeline";
import type {
  WorkspaceLocale,
  WorkspacePanelId,
} from "@/workbench/common/workspace";
import { useLocaleText } from "@/hooks/use-locale-text";

/**
 * Declarative H2R inspector. React owns composition and local dialogs; stable
 * element ids are ports consumed by the temporary IK compatibility runtime.
 */
export function HumanToRobotWorkflow({
  locale,
  onRequestPanel,
}: {
  locale: WorkspaceLocale;
  onRequestPanel(panel: WorkspacePanelId): void;
}) {
  const text = useLocaleText(locale);
  const [pickerOpen, setPickerOpen] = useState(false);
  return (
    <div className="panel-stack workflow-panel-stack">
      <h2>{text("Human → Robot", "人体 → 机器人")}</h2>
      <WorkflowPipeline workflow="h2r" locale={locale} />
      <details id="h2r-step-motion" className="video-workflow-step" open>
        <summary className="video-workflow-step-summary">
          <span>{text("1. Motion", "1. 动作")}</span>
        </summary>
        <div className="video-workflow-step-body">
          <div className="workflow-selection-row">
            <span id="rt-motion" className="workflow-selection-value">
              {text("Not loaded", "未加载")}
            </span>
            <button
              type="button"
              className="btn secondary small"
              onClick={() => setPickerOpen(true)}
            >
              {text("Select motion", "选择动作")}
            </button>
          </div>
        </div>
      </details>
      <details id="h2r-step-robot" className="video-workflow-step">
        <summary className="video-workflow-step-summary">
          <span>{text("2. Target robot", "2. 目标机器人")}</span>
        </summary>
        <div className="video-workflow-step-body workflow-compact-controls">
          <div className="workflow-picker-row">
            <select
              id="h2r-robot-select"
              className="search"
              aria-label={text("Select target robot", "选择目标机器人")}
            />
            <button
              type="button"
              className="btn secondary small"
              onClick={() => onRequestPanel("robot-assets")}
            >
              {text("Import robot", "导入机器人")}
            </button>
          </div>
          <button
            id="h2r-robot-load"
            type="button"
            className="btn workflow-load-button"
            disabled
          >
            {text("Load robot", "加载机器人")}
          </button>
          <p id="rt-robot" className="hint workflow-status-line" role="status">
            {text("Not loaded", "未加载")}
          </p>
        </div>
      </details>
      <details id="h2r-step-calibration" className="video-workflow-step">
        <summary className="video-workflow-step-summary">
          <span>{text("3. Calibration", "3. 标定")}</span>
        </summary>
        <div
          id="tour-calibration"
          className="video-workflow-step-body workflow-compact-controls"
        >
          <label className="video-workflow-field">
            <span className="k">{text("Reference pose", "参考姿态")}</span>
            <select
              id="rt-ref-select"
              className="search"
              disabled
              title={text(
                "Human reference skeleton used for calibration",
                "标定用人体参考骨架；自动识别有误时可手动切换",
              )}
            >
              <option value="">—</option>
            </select>
          </label>
          <p
            id="rt-ref-hint"
            className="hint workflow-status-line"
            style={{ display: "none" }}
          />
          <div className="workflow-selection-row">
            <div className="workflow-selection-copy">
              <span className="k">{text("Calibration", "标定")}</span>
              <strong id="rt-cal">
                <span className="status-chip">
                  <span className="dot" />—
                </span>
              </strong>
            </div>
            <button
              id="recalib-btn"
              type="button"
              className="btn secondary small"
              disabled
            >
              {text("Calibrate", "开始标定")}
            </button>
          </div>
          <div
            id="calibration-save-summary"
            className="calibration-save-summary"
            aria-live="polite"
          />
          <div
            id="calib-card"
            className="workflow-calibration-editor"
            style={{ display: "none" }}
          >
            <p id="calibration-scope" className="hint">
              {text(
                "Target robot + source reference",
                "目标机器人 + 源参考格式",
              )}
            </p>
            <div
              id="calibration-validation-summary"
              className="validation-summary"
              aria-live="polite"
            />
            <CalibrationEditorControls workflow="h2r" locale={locale} />
            <div id="calib-sliders" className="calibration-joint-list" />
            <div className="workflow-button-row">
              <button
                id="calib-zero"
                type="button"
                className="btn secondary small"
              >
                {text("Zero", "归零")}
              </button>
              <button
                id="calib-restore"
                type="button"
                className="btn secondary small"
                disabled
              >
                {text("Reset", "重置")}
              </button>
              <button
                id="calib-cancel"
                type="button"
                className="btn secondary small"
              >
                {text("Cancel", "取消")}
              </button>
              <button id="calib-save" type="button" className="btn small">
                {text("Save", "保存标定")}
              </button>
            </div>
          </div>
        </div>
      </details>
      <details id="h2r-step-result" className="video-workflow-step">
        <summary className="video-workflow-step-summary">
          <span>{text("4. Result", "4. 结果")}</span>
        </summary>
        <div className="video-workflow-step-body workflow-compact-controls">
          <div id="tour-retarget" className="workflow-field-grid">
            <label className="video-workflow-field">
              <span className="k">{text("Solver", "求解器")}</span>
              <select id="rt-backend" className="search">
                <option value="newton">Newton IK</option>
                <option value="interaction_mesh">Interaction-Mesh</option>
              </select>
            </label>
            <label className="video-workflow-field">
              <span className="k">Retarget FPS</span>
              <input
                id="rt-retarget-fps"
                className="search"
                type="number"
                min="1"
                step="1"
                placeholder={text("Original FPS", "动作原始帧率")}
              />
            </label>
          </div>
          <button id="retarget-btn" type="button" className="btn" disabled>
            {text("Start Retarget", "开始 Retarget")}
          </button>
          <p
            id="retarget-disabled-reason"
            className="disabled-action-reason"
            role="status"
          >
            {text("Select a motion and robot first.", "请先加载动作与机器人。")}
          </p>
          <div
            id="rt-progress"
            className="progress video-workflow-progress"
            style={{ display: "none" }}
          >
            <div className="bar" />
          </div>
          <p
            id="rt-status"
            className="hint workflow-status-line"
            role="status"
          />
          <ResultEvaluationPanel workflow="h2r" locale={locale} />
          <div
            id="rt-export-card"
            className="workflow-export-section"
            style={{ display: "none" }}
          >
            <div className="workflow-field-grid">
              <label className="video-workflow-field">
                <span className="k">{text("Export FPS", "导出 FPS")}</span>
                <input
                  id="rt-export-fps"
                  className="search"
                  type="number"
                  min="1"
                  step="1"
                  placeholder={text("Result FPS", "结果帧率")}
                />
              </label>
              <label className="video-workflow-field">
                <span className="k">{text("Format", "格式")}</span>
                <select id="rt-export-format" className="search">
                  <option value="csv">CSV</option>
                  <option value="pkl">PKL</option>
                </select>
              </label>
            </div>
            <div className="workflow-field-grid">
              <label className="video-workflow-field">
                <span className="k">{text("Start (s)", "起始 (s)")}</span>
                <input
                  id="rt-export-t-start"
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
                  id="rt-export-t-end"
                  className="search"
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder={text("End", "结尾")}
                />
              </label>
            </div>
            <label className="workflow-checkbox-row">
              <input id="rt-csv-header" type="checkbox" defaultChecked />
              <span>{text("Include CSV header", "CSV 含注释与列名表头")}</span>
            </label>
            <p id="rt-export-srcfps" className="hint workflow-status-line" />
            <p
              id="rt-export-bundle-hint"
              className="hint workflow-status-line"
              style={{ display: "none" }}
            />
            <button id="rt-export-btn" type="button" className="btn secondary">
              {text("Download result", "下载导出文件")}
            </button>
          </div>
        </div>
      </details>
      <MotionPickerDialog
        open={pickerOpen}
        locale={locale}
        onClose={() => setPickerOpen(false)}
        onImport={() => {
          setPickerOpen(false);
          onRequestPanel("motion");
        }}
      />
    </div>
  );
}
