import { useLocaleText } from "@/hooks/use-locale-text";
import { windowEventBus } from "@/platform/events/browser/window-event-bus";
import type { WorkspaceLocale } from "@/workbench/common/workspace";
import { VideoToMotionPipeline } from "./video-to-motion-pipeline";

/** Declarative workflow shell; upload/inference transport remains in the runtime service. */
export function VideoToMotionPanel({ locale }: { locale: WorkspaceLocale }) {
  const text = useLocaleText(locale);
  return (
    <div className="panel-stack video-to-motion-stack">
      <h2>{text("Video → Motion", "视频 → 动作")}</h2>
      <VideoToMotionPipeline locale={locale} />
      <details id="gvhmr-step-video" className="video-workflow-step" open>
        <summary className="video-workflow-step-summary">
          <span>{text("1. Select video", "1. 选择视频")}</span>
        </summary>
        <div className="video-workflow-step-body">
          <div className="motion-import-control">
            <div
              className="dropzone motion-upload-shared video-upload-shared"
              id="video-drop-shared"
              role="group"
              aria-label={text("Video import area", "视频上传区")}
            >
              <div className="dz-glyph">🎥</div>
              <div className="dz-title">
                {text("Drop a video file here", "拖入一个视频文件")}
              </div>
              <div className="dz-sub">MP4, MOV, MKV, AVI, WebM, M4V</div>
              <div className="row" style={{ marginTop: 10 }}>
                <button
                  id="video-pick-file"
                  type="button"
                  className="btn secondary small"
                >
                  {text("Choose video", "选择视频")}
                </button>
              </div>
            </div>
          </div>
          <section
            id="gvhmr-video-selection"
            className="video-selection"
            style={{ display: "none" }}
          >
            <video id="gvhmr-video-preview" controls preload="metadata" />
            <div className="video-selection-row">
              <div className="video-selection-copy">
                <strong id="gvhmr-video-name">—</strong>
                <span id="gvhmr-video-meta" className="hint" />
              </div>
              <button
                type="button"
                className="btn secondary small"
                onClick={() =>
                  windowEventBus.emit("hhtools:import-command", {
                    target: "video-file",
                  })
                }
              >
                {text("Replace video", "替换视频")}
              </button>
            </div>
          </section>
        </div>
      </details>
      <details id="gvhmr-step-environment" className="video-workflow-step">
        <summary className="video-workflow-step-summary">
          <span>{text("2. Select environment", "2. 选择环境")}</span>
        </summary>
        <div className="video-workflow-step-body">
          <p
            id="gvhmr-runtime-status"
            className="workflow-status-line"
            role="status"
          />
          <div className="video-environment-control">
            <label className="video-workflow-field">
              <span className="k">
                {text("Runtime environment", "运行环境")}
              </span>
              <select id="gvhmr-weight-source" className="search">
                <option value="official">
                  {text("Official GVHMR", "GVHMR 官方环境")}
                </option>
                <option value="custom">
                  {text(
                    "Custom checkpoint (best effort)",
                    "自定义 checkpoint（不保证兼容）",
                  )}
                </option>
              </select>
            </label>
            <button
              id="gvhmr-confirm-environment"
              type="button"
              className="btn secondary small"
            >
              {text("Confirm", "确认环境")}
            </button>
          </div>
          <div
            id="gvhmr-custom-checkpoint"
            className="video-custom-checkpoint"
            style={{ display: "none" }}
          >
            <div className="video-checkpoint-control">
              <button
                id="gvhmr-pick-checkpoint"
                type="button"
                className="btn secondary small"
              >
                {text("Choose checkpoint", "选择 checkpoint")}
              </button>
              <span
                id="gvhmr-checkpoint-name"
                className="video-checkpoint-name"
              >
                {text("No checkpoint selected", "尚未选择 checkpoint")}
              </span>
            </div>
            <p className="hint video-checkpoint-hint">
              {text(
                "Custom checkpoints are passed through as selected. Compatibility is not guaranteed.",
                "自定义 checkpoint 会按所选文件直接传入，不保证兼容性。",
              )}
            </p>
          </div>
          <span id="gvhmr-workflow-video" hidden />
          <span id="gvhmr-workflow-runtime" hidden />
          <span id="gvhmr-workflow-checkpoint" hidden />
        </div>
      </details>
      <details id="gvhmr-step-generate" className="video-workflow-step">
        <summary className="video-workflow-step-summary">
          <span>{text("3. Generate", "3. 生成动作")}</span>
        </summary>
        <div className="video-workflow-step-body">
          <label className="workflow-checkbox-row">
            <input id="gvhmr-static-cam" type="checkbox" defaultChecked />
            <span>{text("Static camera", "静态相机")}</span>
          </label>
          <label className="video-workflow-field">
            <span className="k">
              {text("Focal length (optional, mm)", "焦距（可选，mm）")}
            </span>
            <input
              id="gvhmr-f-mm"
              className="search"
              inputMode="numeric"
              placeholder="Auto"
            />
          </label>
          <button id="gvhmr-run" type="button" className="btn" disabled>
            {text("Start GVHMR", "开始 GVHMR 推理")}
          </button>
          <p
            id="gvhmr-disabled-reason"
            className="disabled-action-reason"
            role="status"
          />
          <div
            id="gvhmr-progress"
            className="progress video-workflow-progress"
            style={{ display: "none" }}
          >
            <div className="bar" />
          </div>
          <p id="gvhmr-status" className="hint" role="status" />
        </div>
      </details>
      <details id="gvhmr-step-result" className="video-workflow-step">
        <summary className="video-workflow-step-summary">
          <span>{text("4. Motion result", "4. 动作结果")}</span>
        </summary>
        <div className="video-workflow-step-body">
          <button
            id="gvhmr-import-result"
            type="button"
            className="btn secondary small"
          >
            {text(
              "Import existing GVHMR result (.pt)",
              "导入已有 GVHMR 结果 (.pt)",
            )}
          </button>
          <p id="gvhmr-result-empty" className="hint">
            {text("No motion result yet.", "尚未生成动作结果。")}
          </p>
          <div id="gvhmr-result-card" style={{ display: "none" }}>
            <div className="meta-row">
              <span className="k">{text("Motion", "动作")}</span>
              <span className="v" id="gvhmr-result-name">
                —
              </span>
            </div>
            <div className="meta-row">
              <span className="k">{text("Frames", "帧数")}</span>
              <span className="v" id="gvhmr-result-frames">
                —
              </span>
            </div>
            <div className="meta-row">
              <span className="k">{text("Duration", "时长")}</span>
              <span className="v" id="gvhmr-result-duration">
                —
              </span>
            </div>
            <button
              type="button"
              className="btn secondary"
              onClick={() =>
                windowEventBus.emit("hhtools:panel-request", "motion")
              }
            >
              {text("Open Motion Library", "打开动作资源库")}
            </button>
          </div>
        </div>
      </details>
    </div>
  );
}
