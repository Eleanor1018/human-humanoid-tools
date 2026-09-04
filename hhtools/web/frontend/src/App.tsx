import { useState, type ComponentType } from "react";

import { Inspector } from "./components/Inspector";
import { Navbar } from "./components/Navbar";
import { Sidebar } from "./components/Sidebar";
import { MotionView } from "./features/motion/MotionView";
import { BatchView } from "./features/batch/BatchView";
import { AnalysisView } from "./features/analysis/AnalysisView";
import { RobotView } from "./features/robot/RobotView";
import { HumanToRobotView } from "./features/h2r/HumanToRobotView";
import { RobotToRobotView } from "./features/r2r/RobotToRobotView";
import { VideoToMotionView } from "./features/video-to-motion/VideoToMotionView";
import type { ViewId } from "./navigation";
import { Stage } from "./stage/Stage";
import type { StageMotionPayload, StageRobotPayload } from "./stage/types";

const inspectorViews: Record<ViewId, ComponentType> = {
  motion: MotionView,
  "robot-assets": RobotView,
  "video-to-motion": VideoToMotionView,
  h2r: HumanToRobotView,
  r2r: RobotToRobotView,
  batch: BatchView,
  "dataset-viz": AnalysisView,
};

export function App() {
  const [activeView, setActiveView] = useState<ViewId>("motion");
  const [stageMotion, setStageMotion] = useState<StageMotionPayload | null>(null);
  const [stageRobot, setStageRobot] = useState<StageRobotPayload | null>(null);
  const ActiveInspector = inspectorViews[activeView];

  // Feature panels own transport; App owns the two payloads shared by the
  // inspector and the single R3F stage. This keeps views independent while
  // making a successful load immediately visible from any navigation tab.
  const inspector =
    activeView === "motion" ? (
      <MotionView onMotionLoaded={setStageMotion} />
    ) : activeView === "robot-assets" ? (
      <RobotView onRobotLoaded={setStageRobot} />
    ) : activeView === "video-to-motion" ? (
      <VideoToMotionView onMotionLoaded={setStageMotion} />
    ) : (
      <ActiveInspector />
    );

  return (
    <div
      id="app"
      className="grid h-dvh min-h-0 min-w-0 grid-cols-[208px_minmax(0,1fr)_360px] grid-rows-[40px_minmax(0,1fr)] max-[900px]:grid-cols-[64px_minmax(0,1fr)_360px] max-[780px]:grid-cols-[64px_minmax(0,1fr)]"
      data-hhtools-ready="true"
      data-active-view={activeView}
    >
      <Navbar />
      <Sidebar activeView={activeView} onSelect={setActiveView} />
      <Stage motion={stageMotion} robot={stageRobot} />
      <Inspector>{inspector}</Inspector>
    </div>
  );
}
