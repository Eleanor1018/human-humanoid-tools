import {
  isNearCalibrationLimit,
  resolveCalibrationJointLimits,
  type CalibrationJointLimit,
} from "./calibrationEditorState.ts";
import type { ValidationItem } from "./ValidationSummary";
import { referenceTargetLink } from "../stage/referenceSkeleton.ts";
import type { StageMotionPayload, StageRobotPayload } from "../stage/types.ts";

function finitePositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function motionValidationFacts(
  motion: StageMotionPayload | null,
): readonly ValidationItem[] {
  if (!motion) return [];
  const frames = motion.positions.length || motion.playback_frames || 0;
  const fps = finitePositive(motion.framerate)
    ? motion.framerate
    : finitePositive(motion.sample_rate)
      ? motion.sample_rate
      : null;
  const joints = motion.parent_indices.length;
  const frameJoints = motion.positions[0]?.length ?? 0;
  const sceneParts = [
    motion.terrain ? "terrain" : "",
    motion.objects?.length
      ? `${motion.objects.length} interaction object${motion.objects.length === 1 ? "" : "s"}`
      : "",
  ].filter(Boolean);
  return [
    {
      tone: frames > 0 ? "ok" : "error",
      label: frames > 0 ? `Playable trajectory: ${frames} frames` : "No playable frames",
    },
    {
      tone: fps ? "ok" : "warning",
      label: fps ? `Timeline: ${fps.toFixed(1)} FPS` : "Frame rate was not detected",
    },
    {
      tone: joints > 0 && frameJoints >= joints ? "ok" : "error",
      label:
        joints > 0 && frameJoints >= joints
          ? `Skeleton: ${joints} joints`
          : "Skeleton hierarchy and positions do not match",
    },
    {
      tone: motion.body_mesh?.available ? "ok" : "neutral",
      label: motion.body_mesh?.available
        ? "Body surface is available"
        : `Body uses the compact fallback${motion.body_mesh?.reason ? `: ${motion.body_mesh.reason}` : ""}`,
    },
    {
      tone: sceneParts.length ? "ok" : "neutral",
      label: sceneParts.length ? `Scene: ${sceneParts.join(" + ")}` : "No interaction scene",
    },
  ];
}

export function robotValidationFacts(
  robot: StageRobotPayload | null,
): readonly ValidationItem[] {
  if (!robot) return [];
  const mappings = Object.entries(robot.ik_map ?? {});
  const links = new Set(robot.links);
  const unresolved = mappings.flatMap(([, target]) => {
    const link = referenceTargetLink(target);
    return link && !links.has(link) ? [link] : [];
  });
  const dof = robot.num_dof ?? robot.actuated_joints?.length ?? 0;
  return [
    {
      tone: dof > 0 ? "ok" : "error",
      label: `${dof} controllable DoF`,
    },
    {
      tone: mappings.length ? "ok" : "warning",
      label: `Semantic map: ${mappings.length}/17 slots`,
    },
    {
      tone: unresolved.length ? "error" : "ok",
      label: unresolved.length
        ? `${unresolved.length} mapped links are unresolved`
        : "All mapped links resolve",
    },
    {
      tone: robot.glb_base64 ? "ok" : "warning",
      label: robot.glb_base64
        ? `Renderable model: ${robot.links.length} links`
        : "Robot mesh is unavailable; link fallback will be shown",
    },
  ];
}

export function calibrationValidationFacts(
  robot: StageRobotPayload | null,
  limits: readonly CalibrationJointLimit[],
  values: Readonly<Record<string, number>>,
): readonly ValidationItem[] {
  if (!robot) return [];
  const base = robotValidationFacts(robot).slice(1, 3);
  const resolved = resolveCalibrationJointLimits(limits, values);
  const changed = resolved.filter((limit) => Math.abs(values[limit.name] ?? 0) > 1e-4);
  const near = resolved.filter((limit) =>
    isNearCalibrationLimit(values[limit.name] ?? 0, limit),
  );
  return [
    ...base,
    {
      tone: changed.length ? "ok" : "neutral",
      label: `${changed.length}/${resolved.length} joints differ from URDF zero`,
    },
    {
      tone: near.length ? "warning" : "ok",
      label: near.length
        ? `${near.length} joints are near their limits`
        : "No joints are near their limits",
    },
  ];
}
