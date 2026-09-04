/** Renderer facts needed to describe the active R2R Stage surface. */
export interface R2rStageSurfaceFacts {
  readonly calibrating: boolean;
  readonly sourceRobotAvailable: boolean;
  readonly targetRobotAvailable: boolean;
  readonly sourceSkeletonAvailable: boolean;
  readonly targetSkeletonAvailable: boolean;
  readonly sourceEnvironmentAvailable: boolean;
  readonly targetEnvironmentAvailable: boolean;
  readonly referenceAvailable: boolean;
}

export interface R2rStageSurfaceSnapshot {
  readonly empty: boolean;
  readonly canResetView: boolean;
}

/**
 * Convert R2R resource facts into renderer-independent Stage presentation.
 *
 * Calibration deliberately isolates the target robot and its reference
 * skeleton, so resources from the regular comparison view do not keep an
 * otherwise empty calibration surface resettable. Outside calibration, any
 * renderable comparison layer counts.
 */
export function projectR2rStageSurface(
  facts: R2rStageSurfaceFacts,
): R2rStageSurfaceSnapshot {
  const hasContent = facts.calibrating
    ? facts.targetRobotAvailable || facts.referenceAvailable
    : facts.sourceRobotAvailable ||
      facts.targetRobotAvailable ||
      facts.sourceSkeletonAvailable ||
      facts.targetSkeletonAvailable ||
      facts.sourceEnvironmentAvailable ||
      facts.targetEnvironmentAvailable;

  return Object.freeze({
    empty: !hasContent,
    canResetView: hasContent,
  });
}
