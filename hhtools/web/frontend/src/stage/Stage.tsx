import { useEffect, useState } from "react";

import { StageViewMenu, type StageLayerId } from "./StageViewMenu";
import { StageCanvas } from "./StageCanvas";
import { StageEmpty } from "./StageEmpty";
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

  return (
    <main
      className="app-content @container relative col-start-2 row-start-2 min-h-0 min-w-0 overflow-hidden bg-stage-canvas max-[780px]:hidden"
      aria-label="Workspace content"
    >
      <StageCanvas
        motion={motion}
        robot={robot}
        visibleLayers={visibleLayers}
      />
      <StageEmpty visible={motion === null && robot === null} />
      <StageViewMenu
        value={visibleLayers}
        onValueChange={setVisibleLayers}
        robotAvailable={robot !== null}
      />
    </main>
  );
}
