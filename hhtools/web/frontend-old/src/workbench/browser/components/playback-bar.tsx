import { cn } from "@/lib/utils";
import type { WorkspaceLocale } from "@/workbench/common/workspace";
import { useStageModelState } from "@/workbench/services/stage/browser/use-stage-model-state";
import {
  getStagePlaybackProgress,
  type IStageModelService,
  type IStagePlaybackCommands,
  type StagePlaybackState,
} from "@/workbench/services/stage/common/stage-service";

function formatPlaybackLabel(
  playback: StagePlaybackState,
  locale: WorkspaceLocale,
): string {
  let label = `${playback.currentTime.toFixed(2)} / ${playback.duration.toFixed(2)} s`;
  if (playback.previewSourceDuration !== null) {
    const source = playback.previewSourceDuration.toFixed(1);
    label +=
      locale === "zh-CN"
        ? `（预览，原片 ${source} s）`
        : ` (preview; source ${source} s)`;
  }
  return label;
}

export function PlaybackBar({
  locale,
  stageModelService,
  stagePlaybackCommands,
}: {
  readonly locale: WorkspaceLocale;
  readonly stageModelService: IStageModelService;
  readonly stagePlaybackCommands: IStagePlaybackCommands;
}) {
  const state = useStageModelState(stageModelService).playback;
  const progress = getStagePlaybackProgress(state);
  const label = formatPlaybackLabel(state, locale);

  return (
    <div id="playbar" className="playbar" hidden={!state.controlsVisible}>
      <button
        id="play-btn"
        type="button"
        className="icon-btn"
        aria-label={state.playing ? "暂停" : "播放"}
        onClick={() => stagePlaybackCommands.togglePlayback()}
      >
        {state.playing ? "❚❚" : "▶"}
      </button>
      <input
        id="scrubber"
        className="scrubber"
        type="range"
        min="0"
        max="100"
        value={progress * 100}
        aria-label="播放进度"
        onChange={(event) =>
          stagePlaybackCommands.seekToFraction(
            Number(event.currentTarget.value) / 100,
          )
        }
      />
      <span id="time-label" className="time-label" title={label}>
        {label}
      </span>
      <span
        className="speed-ctrl"
        title="播放速度（拖动调节，双击复位 1×）"
        onDoubleClick={() => stagePlaybackCommands.setPlaybackSpeed(1)}
      >
        <span className="speed-icon" aria-hidden="true">
          🐢
        </span>
        <input
          id="speed-slider"
          className="speed-slider"
          type="range"
          min="0.1"
          max="4"
          step="0.1"
          value={state.speed}
          aria-label="播放速度"
          onChange={(event) =>
            stagePlaybackCommands.setPlaybackSpeed(
              Number(event.currentTarget.value),
            )
          }
        />
        <span id="speed-label" className="speed-label">
          {state.speed.toFixed(1)}×
        </span>
      </span>
      <button
        id="loop-btn"
        type="button"
        className={cn("icon-btn ghost", !state.loop && "off")}
        title="循环"
        aria-label="切换循环播放"
        onClick={() => stagePlaybackCommands.togglePlaybackLoop()}
      >
        🔁
      </button>
    </div>
  );
}
