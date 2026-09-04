import { useState } from "react";

import { Inspector } from "./components/Inspector";
import { Navbar } from "./components/Navbar";
import { Sidebar } from "./components/Sidebar";
import { MotionView } from "./features/motion/MotionView";
import { cn } from "./lib/utils";
import type { ViewId } from "./navigation";
import { Stage } from "./stage/Stage";

export function App() {
  const [activeView, setActiveView] = useState<ViewId>("motion");
  const hasInspector = activeView === "motion";

  return (
    <div
      id="app"
      className={cn(
        "grid h-dvh min-h-0 min-w-0 grid-rows-[40px_minmax(0,1fr)]",
        hasInspector
          ? "grid-cols-[208px_minmax(0,1fr)_360px]"
          : "grid-cols-[208px_minmax(0,1fr)]",
      )}
      data-hhtools-ready="true"
      data-active-view={activeView}
    >
      <Navbar />
      <Sidebar activeView={activeView} onSelect={setActiveView} />
      <Stage />
      {hasInspector && (
        <Inspector>
          <MotionView />
        </Inspector>
      )}
    </div>
  );
}
