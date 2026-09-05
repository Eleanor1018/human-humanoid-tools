import type {
  R2rLayerAvailability,
  R2rStageLayerId,
  StageLayerId,
  StageMotionPayload,
  StageR2rPresentationPayload,
  StageRobotPayload,
  StageRobotTrajectoryPayload,
  StageTimelinePayload,
} from "./types";
import { timelineDuration } from "./playback.ts";

export type StagePresentation =
  | "motion"
  | "robot"
  | "h2r"
  | "h2r-result"
  | "h2r-calibration"
  | "r2r"
  | "r2r-result"
  | "r2r-calibration"
  | "analysis"
  | "video-to-motion"
  | "empty";

interface PresentationInput {
  readonly mode: StagePresentation;
  readonly motion: StageMotionPayload | null;
  readonly scaledMotion: StageMotionPayload | null;
  readonly robot: StageRobotPayload | null;
  readonly robotTrajectory: StageRobotTrajectoryPayload | null;
}

function hasEnvironment(motion: StageMotionPayload | null): boolean {
  return Boolean(
    motion?.terrain || (motion?.objects && motion.objects.length > 0),
  );
}

export function r2rLayerAvailability(
  presentation: StageR2rPresentationPayload,
): R2rLayerAvailability {
  return {
    "r2r-source-robot": presentation.source.robot !== null,
    "r2r-source-skeleton": Boolean(presentation.source.skeleton?.positions.length),
    "r2r-source-scene": hasEnvironment(presentation.source.environment),
    "r2r-target-robot":
      presentation.target.robot !== null && presentation.phase !== "source",
    "r2r-target-skeleton": Boolean(presentation.target.skeleton?.positions.length),
    "r2r-target-scene": hasEnvironment(presentation.target.environment),
  };
}

/** Reproduce the old source and overlay presets for each new R2R payload. */
export function defaultR2rStageLayers(
  presentation: StageR2rPresentationPayload,
): StageLayerId[] {
  const available = r2rLayerAvailability(presentation);
  if (presentation.phase === "calibration") {
    return available["r2r-target-robot"] ? ["r2r-target-robot"] : [];
  }
  if (presentation.phase === "result") {
    const overlay: readonly R2rStageLayerId[] = [
      "r2r-source-robot",
      "r2r-target-robot",
      "r2r-target-skeleton",
      "r2r-target-scene",
    ];
    return overlay.filter((layer) => available[layer]);
  }
  const source: readonly R2rStageLayerId[] = [
    "r2r-source-robot",
    "r2r-source-scene",
  ];
  return source.filter((layer) => available[layer]);
}

export interface R2rStageVisibilityPlan {
  readonly sourceRobot: boolean;
  readonly sourceSkeleton: boolean;
  readonly sourceScene: boolean;
  readonly targetRobot: boolean;
  readonly targetSkeleton: boolean;
  readonly targetScene: boolean;
  readonly calibrationReference: boolean;
}

/** Calibration is a physical Stage mode; ordinary toggles cannot leak into it. */
export function projectR2rStageVisibility(
  presentation: StageR2rPresentationPayload,
  requested: readonly StageLayerId[],
): R2rStageVisibilityPlan {
  const available = r2rLayerAvailability(presentation);
  if (presentation.phase === "calibration") {
    return {
      sourceRobot: false,
      sourceSkeleton: false,
      sourceScene: false,
      targetRobot: available["r2r-target-robot"],
      targetSkeleton: false,
      targetScene: false,
      calibrationReference: presentation.calibrationReference !== null,
    };
  }
  return {
    sourceRobot:
      available["r2r-source-robot"] && requested.includes("r2r-source-robot"),
    sourceSkeleton:
      available["r2r-source-skeleton"] && requested.includes("r2r-source-skeleton"),
    sourceScene:
      available["r2r-source-scene"] && requested.includes("r2r-source-scene"),
    targetRobot:
      available["r2r-target-robot"] && requested.includes("r2r-target-robot"),
    targetSkeleton:
      available["r2r-target-skeleton"] && requested.includes("r2r-target-skeleton"),
    targetScene:
      available["r2r-target-scene"] && requested.includes("r2r-target-scene"),
    calibrationReference: false,
  };
}

/** Ignore navigation churn while resetting defaults for new workflow identities. */
export function r2rVisibilityIdentity(
  presentation: StageR2rPresentationPayload,
): string {
  return [
    presentation.phase,
    presentation.source.robot?.name ?? "",
    presentation.target.robot?.name ?? "",
    presentation.sourceToken ?? "",
    presentation.resultToken ?? "",
  ].join("|");
}

/** Pick one clock that spans every visible R2R actor on the shared canvas. */
export function r2rPlaybackTimeline(
  presentation: StageR2rPresentationPayload,
): StageTimelinePayload | null {
  if (presentation.phase === "calibration") return null;
  const timelines: readonly (StageTimelinePayload | null)[] = [
    presentation.target.trajectory,
    presentation.source.trajectory,
    presentation.target.skeleton,
    presentation.source.skeleton,
  ];
  let longest: StageTimelinePayload | null = null;
  for (const timeline of timelines) {
    if (timeline && timelineDuration(timeline) > timelineDuration(longest)) {
      longest = timeline;
    }
  }
  return longest;
}

function isParcMotion(motion: StageMotionPayload): boolean {
  return (
    motion.dataset === "parc_ms" ||
    motion.meta?.dataset === "parc_ms" ||
    motion.source_format === "parc_ms_pkl" ||
    motion.meta?.source_format === "parc_ms_pkl"
  );
}

/** Project legacy display defaults without coupling Three components to workflows. */
export function defaultStageLayers({
  mode,
  motion,
  scaledMotion,
  robot,
  robotTrajectory,
}: PresentationInput): StageLayerId[] {
  if (mode === "empty") return [];
  if (mode === "robot") return robot ? ["robot"] : [];

  if (mode === "h2r-calibration" || mode === "r2r-calibration") {
    return [
      ...(motion ? ["skeleton" as const] : []),
      ...(robot ? ["robot" as const] : []),
    ];
  }

  if (mode === "h2r-result" || mode === "r2r-result") {
    return [
      ...(motion ? ["skeleton" as const] : []),
      ...(scaledMotion?.positions.length ? ["scaled-skeleton" as const] : []),
      ...(hasEnvironment(scaledMotion) ? ["scaled-scene" as const] : []),
      ...(robot ? ["robot" as const] : []),
    ];
  }

  const layers: StageLayerId[] = [];
  if (motion) {
    const hasSkin = motion.body_mesh?.available === true;
    if (!hasSkin || isParcMotion(motion)) layers.push("skeleton");
    if (hasSkin) layers.push("body");
    if (hasEnvironment(motion)) layers.push("objects");
  }

  const comparison = mode === "h2r" || mode === "r2r";
  if (comparison && (scaledMotion || robotTrajectory)) {
    if (motion && !layers.includes("skeleton")) layers.push("skeleton");
    if (scaledMotion?.positions.length) layers.push("scaled-skeleton");
    if (hasEnvironment(scaledMotion)) layers.push("scaled-scene");
  }
  if (comparison && robot) layers.push("robot");
  return layers;
}
