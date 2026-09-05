import { useCallback, useEffect, useMemo, useState } from "react";

import {
  motionDuration,
  type StagePlaybackRef,
  type StagePlaybackState,
} from "./playback";
import { StageViewMenu, type StageLayerId } from "./StageViewMenu";
import { StageCanvas } from "./StageCanvas";
import { StageEmpty } from "./StageEmpty";
import { StagePlaybackBar } from "./StagePlaybackBar";
import type { StageMotionPayload, StageRobotPayload } from "./types";

export function Stage({
  motion = null,
  robot = null,
}: {
  motion?: StageMotionPayload | null;
  robot?: StageRobotPayload | null;
}) {
  // Match the original idle HUD until renderer-owned visibility state is wired in.
  const [visibleLayers, setVisibleLayers] = useState<StageLayerId[]>(["body"]);
  const playback = useMemo<StagePlaybackRef>(() => {
    const duration = motionDuration(motion);
    return {
      current: {
        elapsed: 0,
        frame: 0,
        duration,
        playing: Boolean(motion && motion.positions.length > 1 && duration > 0),
      },
    };
  }, [motion]);
  const [playbackView, setPlaybackView] = useState<{
    owner: StagePlaybackRef;
    value: StagePlaybackState;
  }>(
    () => ({ owner: playback, value: { ...playback.current } }),
  );
  const playbackSnapshot = playbackView.owner === playback
    ? playbackView.value
    : playback.current;
  const [canvasVisible, setCanvasVisible] = useState(
    () =>
      typeof window === "undefined" ||
      !window.matchMedia("(max-width: 780px)").matches,
  );
  const hasEnvironment = Boolean(
    motion?.terrain || (motion?.objects && motion.objects.length > 0),
  );
  const publishPlayback = useCallback(() => {
    setPlaybackView({ owner: playback, value: { ...playback.current } });
  }, [playback]);

  useEffect(() => {
    const query = window.matchMedia("(max-width: 780px)");
    const update = () => setCanvasVisible(!query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  // A newly selected robot is immediately useful in the shared stage. Once the
  // user toggles it off, ordinary React state keeps that choice until another
  // payload is selected or the robot is cleared.
  useEffect(() => {
    setVisibleLayers((current) => {
      if (robot !== null) {
        return current.includes("robot") ? current : [...current, "robot"];
      }
      return current.filter((layer) => layer !== "robot");
    });
  }, [robot]);

  useEffect(() => {
    setVisibleLayers((current) => {
      if (hasEnvironment) {
        return current.includes("objects") ? current : [...current, "objects"];
      }
      return current.filter((layer) => layer !== "objects");
    });
  }, [hasEnvironment]);

  return (
    <main
      className="app-content @container relative col-start-2 row-start-2 min-h-0 min-w-0 overflow-hidden bg-stage-canvas max-[780px]:hidden"
      aria-label="Workspace content"
    >
      {canvasVisible && (
        <StageCanvas
          motion={motion}
          robot={robot}
          playback={playback}
          onPlaybackChange={publishPlayback}
          visibleLayers={visibleLayers}
        />
      )}
      <StageEmpty visible={motion === null && robot === null} />
      <StageViewMenu
        value={visibleLayers}
        onValueChange={setVisibleLayers}
        robotAvailable={robot !== null}
        environmentAvailable={hasEnvironment}
      />
      <StagePlaybackBar
        motion={motion}
        playback={playback}
        snapshot={playbackSnapshot}
        onChange={publishPlayback}
      />
    </main>
  );
}
