import { useState, type ComponentType } from "react";

import { Inspector } from "./components/Inspector";
import { Navbar } from "./components/Navbar";
import { Sidebar } from "./components/Sidebar";
import { MotionView } from "./features/motion/MotionView";
import { RobotView } from "./features/robot/RobotView";
import { VideoToMotionView } from "./features/video-to-motion/VideoToMotionView";
import { cn } from "./lib/utils";
import type { ViewId } from "./navigation";
import { Stage } from "./stage/Stage";

const inspectorViews: Partial<Record<ViewId, ComponentType>> = {
  motion: MotionView,
  "robot-assets": RobotView,
  "video-to-motion": VideoToMotionView,
};

export function App() {
  const [activeView, setActiveView] = useState<ViewId>("motion");
  const ActiveInspector = inspectorViews[activeView];

  return (
    <div
      id="app"
      className={cn(
        "grid h-dvh min-h-0 min-w-0 grid-rows-[40px_minmax(0,1fr)]",
        ActiveInspector
          ? "grid-cols-[208px_minmax(0,1fr)_360px]"
          : "grid-cols-[208px_minmax(0,1fr)]",
      )}
      data-hhtools-ready="true"
      data-active-view={activeView}
    >
      <Navbar />
      <Sidebar activeView={activeView} onSelect={setActiveView} />
      <Stage />
      {ActiveInspector && (
        <Inspector>
          <ActiveInspector />
        </Inspector>
      )}
    </div>
  );
}
