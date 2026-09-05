import { useCallback, useEffect, useMemo, useState, type ComponentType } from "react";

import { Inspector } from "./components/Inspector";
import { Navbar } from "./components/Navbar";
import { Sidebar } from "./components/Sidebar";
import { MotionView } from "./features/motion/MotionView";
import { BatchView } from "./features/batch/BatchView";
import { AnalysisView } from "./features/analysis/AnalysisView";
import { RobotView } from "./features/robot/RobotView";
import { HumanToRobotView } from "./features/h2r/HumanToRobotView";
import type {
  CalibrationPose,
  RetargetResult as H2rResult,
} from "./features/h2r/api";
import { RobotToRobotView } from "./features/r2r/RobotToRobotView";
import type {
  R2rRetargetResult,
  R2rScenePayload,
  R2rSourceResult,
} from "./features/r2r/api";
import { VideoToMotionView } from "./features/video-to-motion/VideoToMotionView";
import type { ViewId } from "./navigation";
import { Stage } from "./stage/Stage";
import type { StagePresentation } from "./stage/presentation";
import type {
  StageMotionPayload,
  StageR2rPresentationPayload,
  StageRobotPayload,
  StageRobotTrajectoryPayload,
} from "./stage/types";

const inspectorViews: Record<ViewId, ComponentType> = {
  motion: MotionView,
  "robot-assets": RobotView,
  "video-to-motion": VideoToMotionView,
  h2r: HumanToRobotView,
  r2r: RobotToRobotView,
  batch: BatchView,
  "dataset-viz": AnalysisView,
};

function motionWithScene(
  motion: StageMotionPayload | null | undefined,
  scene: R2rScenePayload | H2rResult["scaled_scene"],
  meshSource?: StageMotionPayload["object_mesh_source"],
): StageMotionPayload | null {
  if (!motion && !scene) return null;
  return {
    ...motion,
    positions: motion?.positions ?? [],
    parent_indices: motion?.parent_indices ?? [],
    terrain: scene?.terrain ?? motion?.terrain,
    objects: scene?.objects ?? motion?.objects,
    object_mesh_source: meshSource,
  };
}

function calibrationTrajectory(
  pose: CalibrationPose,
  robot: StageRobotPayload | null,
): StageRobotTrajectoryPayload {
  return {
    frames: [
      {
        links: pose.link_transforms,
        mesh_z_lift: pose.ground_offset_z - (robot?.ground_offset_z ?? 0),
      },
    ],
  };
}

export function App() {
  const [activeView, setActiveView] = useState<ViewId>("motion");
  const [workspaceMotion, setWorkspaceMotion] =
    useState<StageMotionPayload | null>(null);
  const [workspaceRobot, setWorkspaceRobot] =
    useState<StageRobotPayload | null>(null);
  const [stageMotion, setStageMotion] = useState<StageMotionPayload | null>(null);
  const [stageRobot, setStageRobot] = useState<StageRobotPayload | null>(null);
  const [stageRobotTrajectory, setStageRobotTrajectory] =
    useState<StageRobotTrajectoryPayload | null>(null);
  const [stageScaledMotion, setStageScaledMotion] =
    useState<StageMotionPayload | null>(null);
  const [h2rResult, setH2rResult] = useState<H2rResult | null>(null);
  const [h2rCalibrationReference, setH2rCalibrationReference] =
    useState<StageMotionPayload | null>(null);
  const [h2rCalibrationPose, setH2rCalibrationPose] =
    useState<CalibrationPose | null>(null);
  const [r2rSourceRobot, setR2rSourceRobot] =
    useState<StageRobotPayload | null>(null);
  const [r2rTargetRobot, setR2rTargetRobot] =
    useState<StageRobotPayload | null>(null);
  const [r2rSourceResult, setR2rSourceResult] =
    useState<R2rSourceResult | null>(null);
  const [r2rResult, setR2rResult] =
    useState<R2rRetargetResult | null>(null);
  const [r2rCalibrationPose, setR2rCalibrationPose] =
    useState<CalibrationPose | null>(null);
  const [r2rCalibrationReference, setR2rCalibrationReference] =
    useState<StageMotionPayload | null>(null);
  const ActiveInspector = inspectorViews[activeView];
  const stagePresentation: StagePresentation =
    activeView === "robot-assets"
      ? "robot"
      : activeView === "dataset-viz"
        ? "analysis"
        : activeView === "batch"
          ? "empty"
          : activeView === "h2r"
            ? h2rCalibrationReference
              ? "h2r-calibration"
              : h2rResult
                ? "h2r-result"
                : "h2r"
            : activeView === "r2r"
              ? r2rCalibrationReference
                ? "r2r-calibration"
                : r2rResult
                  ? "r2r-result"
                  : "r2r"
              : activeView;
  const r2rStage = useMemo<StageR2rPresentationPayload | null>(() => {
    if (activeView !== "r2r") return null;
    const meshSource = r2rSourceResult
      ? { kind: "r2r" as const, token: r2rSourceResult.token }
      : undefined;
    return {
      phase: r2rCalibrationReference
        ? "calibration"
        : r2rResult
          ? "result"
          : "source",
      source: {
        robot: r2rSourceRobot,
        trajectory: r2rSourceResult?.trajectory ?? null,
        skeleton: r2rSourceResult?.skeleton_preview ?? null,
        environment: motionWithScene(
          null,
          r2rSourceResult?.scaled_scene,
          meshSource,
        ),
      },
      target: {
        robot: r2rTargetRobot,
        trajectory: r2rCalibrationPose
          ? calibrationTrajectory(r2rCalibrationPose, r2rTargetRobot)
          : r2rResult?.trajectory ?? null,
        skeleton: r2rResult?.scaled_preview ?? null,
        environment: motionWithScene(
          null,
          r2rResult?.scaled_scene,
          meshSource,
        ),
      },
      calibrationReference: r2rCalibrationReference,
      sourceToken: r2rSourceResult?.token ?? null,
      resultToken: r2rResult?.export_token ?? null,
    };
  }, [
    activeView,
    r2rCalibrationPose,
    r2rCalibrationReference,
    r2rResult,
    r2rSourceResult,
    r2rSourceRobot,
    r2rTargetRobot,
  ]);

  const publishMotion = useCallback((motion: StageMotionPayload | null) => {
    setWorkspaceMotion(motion);
    setH2rResult(null);
    setH2rCalibrationReference(null);
    setH2rCalibrationPose(null);
  }, []);
  const publishRobot = useCallback((robot: StageRobotPayload | null) => {
    setWorkspaceRobot(robot);
    setH2rResult(null);
    setH2rCalibrationReference(null);
    setH2rCalibrationPose(null);
  }, []);
  const publishR2rSourceRobot = useCallback((robot: StageRobotPayload | null) => {
    setR2rSourceRobot(robot);
    setR2rCalibrationReference(null);
    if (!robot) {
      setR2rSourceResult(null);
      setR2rResult(null);
    }
  }, []);
  const publishR2rTargetRobot = useCallback((robot: StageRobotPayload | null) => {
    setR2rTargetRobot(robot);
    setR2rCalibrationPose(null);
    setR2rCalibrationReference(null);
    setR2rResult(null);
  }, []);
  const publishR2rSource = useCallback((result: R2rSourceResult | null) => {
    setR2rSourceResult(result);
    setR2rResult(null);
  }, []);

  // Workflow state is durable; this effect is the only place that projects it
  // onto the shared Stage when a user enters H2R or R2R.
  useEffect(() => {
    if (activeView === "motion" || activeView === "video-to-motion") {
      setStageMotion(workspaceMotion);
      setStageRobot(null);
      setStageRobotTrajectory(null);
      setStageScaledMotion(null);
      return;
    }
    if (activeView === "robot-assets") {
      setStageMotion(null);
      setStageRobot(workspaceRobot);
      setStageRobotTrajectory(null);
      setStageScaledMotion(null);
      return;
    }
    if (activeView === "dataset-viz") {
      setStageMotion(workspaceMotion);
      setStageRobot(null);
      setStageRobotTrajectory(null);
      setStageScaledMotion(null);
      return;
    }
    if (activeView === "h2r") {
      setStageMotion(h2rCalibrationReference ?? workspaceMotion);
      setStageRobot(workspaceRobot);
      setStageRobotTrajectory(
        h2rCalibrationPose
          ? calibrationTrajectory(h2rCalibrationPose, workspaceRobot)
          : h2rResult?.trajectory ?? null,
      );
      setStageScaledMotion(
        h2rCalibrationReference
          ? null
          : motionWithScene(
              h2rResult?.scaled_preview,
              h2rResult?.scaled_scene,
              workspaceMotion?.token
                ? { kind: "motion", token: workspaceMotion.token }
                : undefined,
            ),
      );
      return;
    }
    if (activeView !== "r2r") {
      setStageMotion(null);
      setStageRobot(null);
      setStageRobotTrajectory(null);
      setStageScaledMotion(null);
      return;
    }

    // R2R is a symmetric two-actor presentation rendered through its own Stage
    // contract. Clear the single-actor slots so they cannot leak into it.
    setStageMotion(null);
    setStageRobot(null);
    setStageRobotTrajectory(null);
    setStageScaledMotion(null);
  }, [
    activeView,
    h2rCalibrationPose,
    h2rCalibrationReference,
    h2rResult,
    r2rCalibrationPose,
    r2rCalibrationReference,
    r2rResult,
    r2rSourceResult,
    r2rSourceRobot,
    r2rTargetRobot,
    workspaceMotion,
    workspaceRobot,
  ]);

  // Feature panels own transport. App keeps only the inputs and results needed
  // to project the active workflow onto the shared R3F Stage.
  const inspector =
    activeView === "video-to-motion" ? (
      <VideoToMotionView onMotionLoaded={publishMotion} />
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
      <Stage
        motion={stageMotion}
        scaledMotion={stageScaledMotion}
        robot={stageRobot}
        robotTrajectory={stageRobotTrajectory}
        presentation={stagePresentation}
        r2r={r2rStage}
      />
      <Inspector>
        <div className={activeView === "motion" ? "h-full" : "hidden"}>
          <MotionView
            currentMotion={workspaceMotion}
            onMotionLoaded={publishMotion}
          />
        </div>
        <div className={activeView === "robot-assets" ? "h-full" : "hidden"}>
          <RobotView
            currentRobot={workspaceRobot}
            onRobotLoaded={publishRobot}
          />
        </div>
        <div className={activeView === "h2r" ? "h-full" : "hidden"}>
          <HumanToRobotView
            currentMotion={workspaceMotion}
            currentRobot={workspaceRobot}
            currentResult={h2rResult}
            onMotionLoaded={publishMotion}
            onRobotLoaded={publishRobot}
            onRetargetResult={setH2rResult}
            onCalibrationReference={setH2rCalibrationReference}
            onRobotPose={setH2rCalibrationPose}
          />
        </div>
        <div className={activeView === "r2r" ? "h-full" : "hidden"}>
          <RobotToRobotView
            currentSourceRobot={r2rSourceRobot}
            currentTargetRobot={r2rTargetRobot}
            currentSourceResult={r2rSourceResult}
            currentResult={r2rResult}
            onSourceRobotLoaded={publishR2rSourceRobot}
            onTargetRobotLoaded={publishR2rTargetRobot}
            onSourceLoaded={publishR2rSource}
            onResultLoaded={setR2rResult}
            onCalibrationReference={setR2rCalibrationReference}
            onTargetPose={setR2rCalibrationPose}
          />
        </div>
        <div className={activeView === "dataset-viz" ? "h-full" : "hidden"}>
          <AnalysisView onMotionLoaded={publishMotion} />
        </div>
        {activeView !== "motion" &&
        activeView !== "robot-assets" &&
        activeView !== "h2r" &&
        activeView !== "r2r" &&
        activeView !== "dataset-viz"
          ? inspector
          : null}
      </Inspector>
    </div>
  );
}
