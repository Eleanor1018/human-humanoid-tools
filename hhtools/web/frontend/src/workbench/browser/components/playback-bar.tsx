import { useState } from "react";

import { useWindowEvent } from "@/platform/events/browser/use-window-event";
import { windowEventBus } from "@/platform/events/browser/window-event-bus";
import type { PlaybackAction, PlaybackUiState } from "@/runtime/types";
import { cn } from "@/lib/utils";

const initialState: PlaybackUiState = {
  visible: false,
  active: false,
  playing: false,
  loop: true,
  currentTime: 0,
  duration: 0,
  sourceDuration: null,
  progress: 0,
  speed: 1,
  label: "0.00 / 0.00 s",
};

export function PlaybackBar() {
  const [state, setState] = useState(initialState);
  useWindowEvent("hhtools:playback-state", (event) => {
    setState((current) => ({ ...current, ...event.detail }));
  });

  const send = (action: PlaybackAction, value?: number): void => {
    windowEventBus.emit("hhtools:playback-command", { action, value });
  };

  return (
    <div id="playbar" className="playbar" hidden={!state.visible}>
      <button
        id="play-btn"
        type="button"
        className="icon-btn"
        aria-label={state.playing ? "暂停" : "播放"}
        onClick={() => send("toggle")}
      >
        {state.playing ? "❚❚" : "▶"}
      </button>
      <input
        id="scrubber"
        className="scrubber"
        type="range"
        min="0"
        max="100"
        value={state.progress * 100}
        aria-label="播放进度"
        onChange={(event) =>
          send("seek", Number(event.currentTarget.value) / 100)
        }
      />
      <span id="time-label" className="time-label" title={state.label}>
        {state.label}
      </span>
      <span
        className="speed-ctrl"
        title="播放速度（拖动调节，双击复位 1×）"
        onDoubleClick={() => send("speed", 1)}
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
          onChange={(event) => send("speed", Number(event.currentTarget.value))}
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
        onClick={() => send("loop")}
      >
        🔁
      </button>
    </div>
  );
}
