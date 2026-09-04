import { useState } from "react";

import { StageViewMenu, type StageLayerId } from "./StageViewMenu";
import { StageCanvas } from "./StageCanvas";
import { StageEmpty } from "./StageEmpty";

export function Stage() {
  // Match the original idle HUD until renderer-owned visibility state is wired in.
  const [visibleLayers, setVisibleLayers] = useState<StageLayerId[]>(["body"]);

  return (
    <main
      className="app-content @container relative col-start-2 row-start-2 min-h-0 min-w-0 overflow-hidden bg-stage-canvas max-[780px]:hidden"
      aria-label="Workspace content"
    >
      <StageCanvas />
      <StageEmpty />
      <StageViewMenu
        value={visibleLayers}
        onValueChange={setVisibleLayers}
      />
    </main>
  );
}
