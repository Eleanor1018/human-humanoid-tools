import type { StageLayerId } from "./StageViewMenu";
import type {
  StageMotionPayload,
  StageRobotPayload,
  StageRobotTrajectoryPayload,
} from "./types";

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
