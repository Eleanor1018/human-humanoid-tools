import type { ReactNode } from "react";

import { useLocaleText } from "@/hooks/use-locale-text";
import type { WorkspaceLocale } from "@/runtime/types";
import { DataAnalysisPipeline } from "./data-analysis-pipeline";

/** Dataset analysis workbench contribution with stable canvas/runtime mounts. */
export function DataAnalysisPanel({ locale }: { locale: WorkspaceLocale }) {
  const text = useLocaleText(locale);
  return (
    <div className="panel-stack data-analysis-stack">
      <h2>{text("Data Analysis", "数据分析")}</h2>
      <DataAnalysisPipeline locale={locale} />
      <details id="dv-step-source" className="video-workflow-step" open>
        <summary className="video-workflow-step-summary">
          <span>{text("1. Select data", "1. 选择数据")}</span>
          <span className="dv-card-badge" id="dv-kind-badge" hidden />
        </summary>
        <div className="video-workflow-step-body">
          <div className="data-analysis-upload-grid">
            <UploadZone
              id="dv-dropzone"
              iconId="dv-drop-icon"
              labelId="dv-drop-label"
              buttonId="dv-pick-folder"
              title="Motion"
              hint={text(
                "Drop a motion dataset folder here",
                "拖入动作数据集文件夹",
              )}
              button={text("Choose folder", "选择文件夹")}
            />
            <UploadZone
              id="dv-dropzone-robot"
              iconId="dv-drop-icon-robot"
              labelId="dv-drop-label-robot"
              buttonId="dv-pick-robot-folder"
              title="Robot"
              hint={text(
                "Drop a robot trajectory folder here",
                "拖入机器人轨迹文件夹",
              )}
              button={text("Choose folder", "选择文件夹")}
            />
          </div>
          <p className="hint dv-drop-hint" id="dv-drop-hint">
            {text(
              "You can append folders of the same type to the current batch.",
              "可向当前批次继续追加同一类型的文件夹。",
            )}
          </p>
          <div className="dv-upload-basket" id="dv-upload-basket" hidden>
            <div className="dv-basket-head">
              <span className="dv-basket-title" id="dv-basket-summary">
                —
              </span>
              <button type="button" className="btn-link" id="dv-clear-upload">
                {text("Clear batch", "清空批次")}
              </button>
            </div>
            <ul className="dv-basket-list" id="dv-basket-list" />
          </div>
          <div className="dv-source-display" id="dv-source-display">
            {text("No folder selected", "未指定目录")}
          </div>
          <label
            className="dv-field dv-user-root"
            id="dv-user-root-wrap"
            hidden
          >
            <span>
              {text("Local data directory", "本地数据目录")} <b>*</b>
            </span>
            <input
              type="text"
              id="dv-user-source-root"
              className="dv-input"
              placeholder="/home/motions"
            />
            <span className="hint">
              {text(
                "Map an uploaded manifest to its real local directory.",
                "将上传的 manifest 映射到真实本地目录。",
              )}
            </span>
          </label>
          <details className="dv-support-compact">
            <summary>{text("Supported formats", "支持格式")}</summary>
            <div className="dv-format-grid" id="dv-format-grid" />
          </details>
          <input type="hidden" id="dv-source" defaultValue="" />
        </div>
      </details>
      <details id="dv-step-configure" className="video-workflow-step">
        <summary className="video-workflow-step-summary">
          <span>{text("2. Configure", "2. 分析配置")}</span>
        </summary>
        <div className="video-workflow-step-body">
          <div className="dv-toolbar data-analysis-config">
            <label className="dv-field">
              <span>Embedding</span>
              <select id="dv-embedding">
                <option value="handcrafted">
                  {text(
                    "Handcrafted features (recommended)",
                    "档A · 手工特征（推荐）",
                  )}
                </option>
                <option value="pae" disabled>
                  {text("PAE (coming soon)", "档B · PAE（暂不可用）")}
                </option>
              </select>
            </label>
            <label className="dv-check">
              <input type="checkbox" id="dv-force" />{" "}
              {text("Ignore cache", "忽略缓存")}
            </label>
          </div>
        </div>
      </details>
      <details id="dv-step-analyze" className="video-workflow-step">
        <summary className="video-workflow-step-summary">
          <span>{text("3. Analyze", "3. 运行分析")}</span>
        </summary>
        <div className="video-workflow-step-body">
          <button className="btn" id="dv-analyze">
            {text("Start analysis", "开始分析")}
          </button>
          <div
            className="progress dv-progress"
            style={{ display: "none" }}
            id="dv-progress"
          >
            <div className="bar" />
          </div>
          <div className="dv-status" id="dv-status" role="status" />
        </div>
      </details>
      <details id="dv-step-results" className="video-workflow-step">
        <summary className="video-workflow-step-summary">
          <span>{text("4. Results", "4. 分析结果")}</span>
        </summary>
        <div className="video-workflow-step-body data-analysis-results-body">
          <p id="dv-results-empty" className="hint data-analysis-results-empty">
            {text(
              "Run an analysis to view metrics, clusters, and recommended subsets.",
              "运行分析后可查看指标、聚类与推荐子集。",
            )}
          </p>
          <div className="dv-robot-preview" id="dv-robot-preview" hidden>
            <label className="dv-field">
              <span>{text("Preview robot", "预览机器人")}</span>
              <select id="dv-robot-select" />
            </label>
            <span className="hint" id="dv-robot-hint">
              {text(
                "Select a point or row to preview the trajectory.",
                "点击散点或列表中的条目以预览轨迹。",
              )}
            </span>
          </div>
          <div id="dv-results" hidden>
            <div className="dv-overview" id="dv-overview" />
            <AnalysisCard title="Stage I · Tags">
              <div className="dv-tagmode">
                <label>
                  <input
                    type="radio"
                    name="dv-tagmode"
                    value="or"
                    defaultChecked
                  />{" "}
                  OR
                </label>
                <label>
                  <input type="radio" name="dv-tagmode" value="and" /> AND
                </label>
                <button type="button" className="btn-link" id="dv-clear-tags">
                  {text("Clear", "清除")}
                </button>
              </div>
              <div className="dv-chips" id="dv-chips" />
              <div className="dv-info-panel" id="dv-tag-info" hidden />
            </AnalysisCard>
            <AnalysisCard
              title={text("Explore · metric distribution", "探索 · 指标分布")}
              action={
                <button type="button" className="btn-link" id="dv-clear-brush">
                  {text("Clear brush", "清除刷选")}
                </button>
              }
            >
              <div className="dv-row dv-row-tight">
                <select id="dv-view-dim" className="dv-select dv-select-grow" />
              </div>
              <div
                className="dv-info-panel dv-info-compact"
                id="dv-metric-info"
              />
              <div className="dv-chart-wrap">
                <canvas
                  id="dv-hist-canvas"
                  className="dv-canvas"
                  width="640"
                  height="240"
                />
              </div>
              <div className="dv-chart-footer">
                <span className="dv-chart-stats" id="dv-hist-stats" />
                <span className="hint" id="dv-hist-axis-hint" />
              </div>
            </AnalysisCard>
            <AnalysisCard
              title="Stage II · Semantic scatter"
              action={
                <button
                  type="button"
                  className="btn secondary small"
                  id="dv-scatter-reset"
                >
                  {text("Reset view", "默认视角")}
                </button>
              }
            >
              <div className="dv-scatter-wrap">
                <canvas
                  id="dv-scatter-canvas"
                  className="dv-canvas dv-scatter"
                  width="640"
                  height="400"
                />
                <div className="dv-scatter-tip" id="dv-scatter-tip" hidden />
              </div>
              <div className="dv-scatter-toolbar">
                <span className="hint">
                  {text(
                    "Wheel to zoom · drag to pan · click to preview",
                    "滚轮缩放 · 拖拽平移 · 点击预览",
                  )}
                </span>
                <div className="dv-legend" id="dv-legend" />
              </div>
              <div className="dv-clip-list-wrap">
                <div className="dv-list-head">
                  <span>{text("Brushed results", "刷选结果")}</span>
                  <span className="hint" id="dv-list-count" />
                </div>
                <div className="dv-clip-list" id="dv-clip-list" />
              </div>
            </AnalysisCard>
            <AnalysisCard title="Stage III · Subset">
              <div className="dv-slider-block">
                <div className="dv-slider-row">
                  <label className="dv-slider-label">
                    {text("Subset size", "导出子集大小")}
                  </label>
                  <span className="dv-slider-val" id="dv-subset-pct">
                    10%
                  </span>
                </div>
                <input
                  type="range"
                  id="dv-subset-ratio"
                  className="dv-range"
                  min="1"
                  max="100"
                  defaultValue="10"
                />
              </div>
              <div className="dv-slider-block">
                <div className="dv-slider-row">
                  <label className="dv-slider-label">Diversity α</label>
                  <span className="dv-slider-val" id="dv-subset-alpha-val">
                    0.99
                  </span>
                </div>
                <input
                  type="range"
                  id="dv-subset-alpha"
                  className="dv-range"
                  min="50"
                  max="100"
                  defaultValue="99"
                />
                <p className="hint dv-alpha-hint" id="dv-alpha-hint" />
              </div>
              <div className="dv-selbar" id="dv-selbar" />
              <div
                className="dv-robot-export-opts"
                id="dv-robot-export-opts"
                hidden
              >
                <label className="dv-check">
                  <input
                    type="checkbox"
                    id="dv-robot-export-files"
                    defaultChecked
                  />
                  {text(
                    "Package trajectory folders (ZIP)",
                    "打包轨迹文件夹 (ZIP)",
                  )}
                </label>
              </div>
              <div className="dv-actions-grid">
                <button
                  type="button"
                  className="btn"
                  id="dv-human-basket"
                  disabled
                >
                  {text("Human data → Batch", "人体数据 → 批量篮子")}
                </button>
                <button
                  type="button"
                  className="btn"
                  id="dv-export-robot"
                  disabled
                >
                  {text("Export robot data", "导出机器人数据")}
                </button>
                <button
                  type="button"
                  className="btn secondary"
                  id="dv-export-json"
                >
                  {text("Export manifest (JSON)", "导出 manifest (JSON)")}
                </button>
                <button
                  type="button"
                  className="btn secondary"
                  id="dv-clear-sel"
                >
                  {text("Clear selection", "清除手动选中")}
                </button>
              </div>
              <div className="hint dv-clip-detail" id="dv-clip-detail" />
            </AnalysisCard>
          </div>
        </div>
      </details>
    </div>
  );
}

function UploadZone({
  id,
  iconId,
  labelId,
  buttonId,
  title,
  hint,
  button,
}: {
  id: string;
  iconId: string;
  labelId: string;
  buttonId: string;
  title: string;
  hint: string;
  button: string;
}) {
  return (
    <div
      id={id}
      className="dropzone motion-upload-shared data-analysis-upload"
      role="group"
    >
      <div className="dz-glyph" id={iconId}>
        {title[0]}
      </div>
      <div className="dz-title">{title}</div>
      <div className="dz-sub" id={labelId}>
        {hint}
      </div>
      <button type="button" className="btn secondary small" id={buttonId}>
        {button}
      </button>
    </div>
  );
}

function AnalysisCard({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="dv-card">
      <div className="dv-card-head">
        <span className="dv-card-title">{title}</span>
        {action}
      </div>
      {children}
    </div>
  );
}
