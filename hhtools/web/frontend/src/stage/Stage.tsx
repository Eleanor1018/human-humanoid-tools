import { useCallback, useEffect, useMemo, useState } from "react";

import {
  timelineDuration,
  type StagePlaybackRef,
  type StagePlaybackState,
} from "./playback";
import { StageViewMenu, type StageLayerId } from "./StageViewMenu";
import { StageCanvas } from "./StageCanvas";
import { StageEmpty } from "./StageEmpty";
import { StagePlaybackBar } from "./StagePlaybackBar";
import type {
  StageMotionPayload,
  StageRobotPayload,
  StageRobotTrajectoryPayload,
  StageTimelinePayload,
} from "./types";

export function Stage({
  motion = null,
  scaledMotion = null,
  robot = null,
  robotTrajectory = null,
}: {
  motion?: StageMotionPayload | null;
  scaledMotion?: StageMotionPayload | null;
  robot?: StageRobotPayload | null;
  robotTrajectory?: StageRobotTrajectoryPayload | null;
}) {
  // Match the original idle HUD until renderer-owned visibility state is wired in.
  const [visibleLayers, setVisibleLayers] = useState<StageLayerId[]>(["body"]);
  const timeline: StageTimelinePayload | null =
    robotTrajectory && robotTrajectory.frames.length > 0
      ? robotTrajectory
      : motion;
  const playback = useMemo<StagePlaybackRef>(() => {
    const duration = timelineDuration(timeline);
    return {
      current: {
        elapsed: 0,
        frame: 0,
        duration,
        playing: Boolean(timeline && duration > 0),
      },
    };
  }, [timeline]);
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
  const hasScaledEnvironment = Boolean(
    scaledMotion?.terrain ||
      (scaledMotion?.objects && scaledMotion.objects.length > 0),
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

  useEffect(() => {
    setVisibleLayers((current) => {
      if (scaledMotion?.positions.length) {
        return current.includes("scaled-skeleton")
          ? current
          : [...current, "scaled-skeleton"];
      }
      return current.filter((layer) => layer !== "scaled-skeleton");
    });
  }, [scaledMotion]);

  useEffect(() => {
    setVisibleLayers((current) => {
      if (hasScaledEnvironment) {
        return current.includes("scaled-scene")
          ? current
          : [...current, "scaled-scene"];
      }
      return current.filter((layer) => layer !== "scaled-scene");
    });
  }, [hasScaledEnvironment]);

  return (
    <main
      className="app-content @container relative col-start-2 row-start-2 min-h-0 min-w-0 overflow-hidden bg-stage-canvas max-[780px]:hidden"
      aria-label="Workspace content"
    >
      {canvasVisible && (
        <StageCanvas
          motion={motion}
          scaledMotion={scaledMotion}
          robot={robot}
          robotTrajectory={robotTrajectory}
          playback={playback}
          onPlaybackChange={publishPlayback}
          visibleLayers={visibleLayers}
        />
      )}
      <StageEmpty
        visible={motion === null && scaledMotion === null && robot === null}
      />
      <StageViewMenu
        value={visibleLayers}
        onValueChange={setVisibleLayers}
        robotAvailable={robot !== null}
        environmentAvailable={hasEnvironment}
        scaledMotionAvailable={Boolean(scaledMotion?.positions.length)}
        scaledEnvironmentAvailable={hasScaledEnvironment}
      />
      <StagePlaybackBar
        timeline={timeline}
        playback={playback}
        snapshot={playbackSnapshot}
        onChange={publishPlayback}
      />
    </main>
  );
}
