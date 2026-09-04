import { describe, expect, it } from "vitest";

import {
  projectR2rStageSurface,
  type R2rStageSurfaceFacts,
} from "../../src/runtime/r2r-stage-surface";

function facts(
  overrides: Partial<R2rStageSurfaceFacts> = {},
): R2rStageSurfaceFacts {
  return {
    calibrating: false,
    sourceRobotAvailable: false,
    targetRobotAvailable: false,
    sourceSkeletonAvailable: false,
    targetSkeletonAvailable: false,
    sourceEnvironmentAvailable: false,
    targetEnvironmentAvailable: false,
    referenceAvailable: false,
    ...overrides,
  };
}

describe("projectR2rStageSurface", () => {
  it("keeps a resource-free comparison surface empty", () => {
    const surface = projectR2rStageSurface(facts());

    expect(surface).toEqual({ empty: true, canResetView: false });
    expect(Object.isFrozen(surface)).toBe(true);
  });

  it.each([
    "sourceRobotAvailable",
    "targetRobotAvailable",
    "sourceSkeletonAvailable",
    "targetSkeletonAvailable",
    "sourceEnvironmentAvailable",
    "targetEnvironmentAvailable",
  ] as const)("treats %s as resettable Stage content", (key) => {
    expect(projectR2rStageSurface(facts({ [key]: true }))).toEqual({
      empty: false,
      canResetView: true,
    });
  });

  it("uses only the isolated target robot and reference during calibration", () => {
    expect(projectR2rStageSurface(facts({
      calibrating: true,
      sourceRobotAvailable: true,
      sourceSkeletonAvailable: true,
      sourceEnvironmentAvailable: true,
    }))).toEqual({ empty: true, canResetView: false });

    expect(projectR2rStageSurface(facts({
      calibrating: true,
      targetRobotAvailable: true,
    }))).toEqual({ empty: false, canResetView: true });

    expect(projectR2rStageSurface(facts({
      calibrating: true,
      referenceAvailable: true,
    }))).toEqual({ empty: false, canResetView: true });
  });
});
