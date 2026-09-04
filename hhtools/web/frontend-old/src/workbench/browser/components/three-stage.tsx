import {
  useEffect,
  useRef,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

import { useLocaleText } from "@/workbench/services/localization/browser/use-locale-text";
import type { WorkspaceLocale } from "@/workbench/common/workspace";
import type {
  IStageDisplayCommands,
  IStageLayerCommands,
  IStageModelService,
  IStagePlaybackCommands,
} from "@/workbench/services/stage/common/stage-service";
import { useStageSurfaceState } from "@/workbench/services/stage/browser/use-stage-model-state";
import type {
  ThreeStageRendererMount,
} from "@/workbench/browser/stage/three-stage-renderer-mount";
import { cn } from "@/lib/utils";
import { H2rStageLayerControls } from "./h2r-stage-layer-controls";
import { PlaybackBar } from "./playback-bar";
import { StageLayerToggle } from "./stage-layer-toggle";

function reportMountErrorSafely(
  stageRendererMount: ThreeStageRendererMount,
  error: unknown,
): void {
  try {
    stageRendererMount.reportError(error);
  } catch {
    // Reporting is observational. It cannot escape a React effect and obscure
    // the renderer setup or cleanup failure that was already handed off.
  }
}

/** React-owned Stage surface shared with exactly one renderer through a mount. */
export function ThreeStage({
  locale,
  stageDisplayCommands,
  stageLayerCommands,
  stageModelService,
  stagePlaybackCommands,
  stageRendererMount,
  batchActive = false,
  batchWorkspace,
}: {
  locale: WorkspaceLocale;
  stageDisplayCommands: IStageDisplayCommands;
  stageLayerCommands: IStageLayerCommands;
  stageModelService: IStageModelService;
  stagePlaybackCommands: IStagePlaybackCommands;
  /** Null while the legacy runtime remains the sole Stage renderer owner. */
  stageRendererMount: ThreeStageRendererMount | null;
  /** Batch replaces the visible Stage surface while preserving WebGL state. */
  batchActive?: boolean;
  batchWorkspace?: ReactNode;
}) {
  const stageRef = useRef<HTMLElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const text = useLocaleText(locale);
  const stageSurface = useStageSurfaceState(stageModelService);

  useEffect(() => {
    if (!stageRendererMount) return;

    const stage = stageRef.current;
    const canvas = canvasRef.current;
    if (!stage || !canvas || canvas.parentElement !== stage) {
      reportMountErrorSafely(
        stageRendererMount,
        new Error("React did not commit the expected Stage renderer DOM"),
      );
      return;
    }

    let lease: ReturnType<ThreeStageRendererMount["mount"]>;
    try {
      lease = stageRendererMount.mount({ stage, canvas });
    } catch (error) {
      reportMountErrorSafely(stageRendererMount, error);
      return;
    }

    return () => {
      try {
        lease.dispose();
      } catch (error) {
        reportMountErrorSafely(stageRendererMount, error);
      }
    };
  }, [stageRendererMount]);

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
    <main
      ref={stageRef}
      id="stage"
      data-batch-active={batchActive ? "true" : undefined}
    >
      <canvas ref={canvasRef} id="three-canvas" />
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
        <div
          className={cn(
            "view-hud",
            stageSurface.owner !== "r2r" && "hidden",
          )}
          id="view-hud-r2r"
          aria-hidden={stageSurface.owner !== "r2r"}
        >
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
      <div
        className={cn("stage-empty", !stageSurface.empty && "hidden")}
        id="stage-empty"
        aria-hidden={!stageSurface.empty}
      >
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
          className={cn(
            "view-reset-btn",
            !stageSurface.canResetView && "hidden",
          )}
          id="view-reset-btn"
          title={text("Reset view", "回到默认视角")}
          aria-label={text("Reset view", "回到默认视角")}
          aria-hidden={!stageSurface.canResetView}
          disabled={!stageSurface.canResetView}
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
