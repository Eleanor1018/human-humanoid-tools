import { useState } from "react";

import { StageViewMenu, type StageLayerId } from "./StageViewMenu";

export function Stage() {
  // Match the original idle HUD until renderer-owned visibility state is wired in.
  const [visibleLayers, setVisibleLayers] = useState<StageLayerId[]>(["body"]);

  return (
    <main className="app-content" aria-label="Workspace content">
      <StageViewMenu
        value={visibleLayers}
        onValueChange={setVisibleLayers}
      />
    </main>
  );
}
