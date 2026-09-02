import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";

import { useLocaleText } from "@/workbench/services/localization/browser/use-locale-text";
import type { WorkspaceLocale } from "@/workbench/common/workspace";
import type {
  IStageDisplayCommands,
  IStageLayerCommands,
  IStageModelService,
  IStagePlaybackCommands,
} from "@/workbench/services/stage/common/stage-service";
import { H2rStageLayerControls } from "./h2r-stage-layer-controls";
import { PlaybackBar } from "./playback-bar";
import { StageLayerToggle } from "./stage-layer-toggle";

/** Stable DOM contract consumed by the Three.js stage compatibility service. */
export function ThreeStage({
  locale,
  stageDisplayCommands,
  stageLayerCommands,
  stageModelService,
  stagePlaybackCommands,
  batchWorkspace,
}: {
  locale: WorkspaceLocale;
  stageDisplayCommands: IStageDisplayCommands;
  stageLayerCommands: IStageLayerCommands;
  stageModelService: IStageModelService;
  stagePlaybackCommands: IStagePlaybackCommands;
  batchWorkspace?: ReactNode;
}) {
  const text = useLocaleText(locale);
  const legacyToggle = (
    id: string,
    en: string,
    zh: string,
    disabled = false,
    active = false,
  ) => (
    <StageLayerToggle
      id={id}
      active={active}
      disabled={disabled}
      title={text(en, zh)}
      label={text(en.split(" ")[0] || en, zh.split(" ")[0] || zh)}
    />
  );
  return (
    <main id="stage">
      <canvas id="three-canvas" />
      <svg
        id="calib-mapping-overlay"
        className="calib-mapping-overlay"
        aria-hidden="true"
      />
      <div
        id="calib-landmark-labels"
        className="calib-landmark-labels"
        aria-hidden="true"
      />
      <div id="calib-hud" className="calib-hud hidden" aria-hidden="true" />
      <div
        id="calib-hover-hint"
        className="calib-hover-hint"
        aria-hidden="true"
      />
      <div className="stage-top-tools">
        <H2rStageLayerControls
          locale={locale}
          stageLayerCommands={stageLayerCommands}
          stageModelService={stageModelService}
        />
        <div className="view-hud hidden" id="view-hud-r2r">
          <div className="view-hud-row" data-row="r2r-src">
            <span className="view-hud-tag">{text("Source", "源")}</span>
            {legacyToggle("r2r-tg-src-robot", "Robot", "机器人", false, true)}
            {legacyToggle("r2r-tg-src-skel", "Skeleton", "骨架", true)}
            {legacyToggle("r2r-tg-src-env", "Objects/Terrain", "物体/地形", true)}
          </div>
          <div className="view-hud-row" data-row="r2r-tgt">
            <span className="view-hud-tag">{text("Target", "目标")}</span>
            {legacyToggle("r2r-tg-tgt-robot", "Robot", "机器人", true)}
            {legacyToggle("r2r-tg-tgt-skel", "Skeleton", "骨架", true)}
            {legacyToggle("r2r-tg-tgt-env", "Objects/Terrain", "物体/地形", true)}
          </div>
        </div>
      </div>
      <div className="stage-empty" id="stage-empty">
        <div>
          <div className="glyph">🎞</div>
          <div className="big">
            {text("Drop a motion here to preview", "把动作拖到这里预览")}
          </div>
          <div className="sub">
            {text(
              "Supports BVH / GLB / NPZ and common motion datasets.",
              "支持 BVH / GLB / NPZ 与常见动作数据集。",
            )}
          </div>
        </div>
      </div>
      {batchWorkspace}
      <div className="stage-overlay">
        <button
          type="button"
          className="view-reset-btn hidden"
          id="view-reset-btn"
          title={text("Reset view", "回到默认视角")}
          aria-label={text("Reset view", "回到默认视角")}
          onClick={() => stageDisplayCommands.resetView()}
        >
          <svg
            className="view-reset-icon"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="3.25" />
            <path d="M12 3v3.5M12 17.5V21M3 12h3.5M17.5 12H21" />
          </svg>
        </button>
        <PlaybackBar
          locale={locale}
          stageModelService={stageModelService}
          stagePlaybackCommands={stagePlaybackCommands}
        />
      </div>
    </main>
  );
}

export type StageResizerPointerEvent = ReactPointerEvent<HTMLElement>;
