export type CalibrationBootstrapResult = "entered" | "stale" | "failed";

export type CalibrationMotionLoadDisposition =
  | "calibration"
  | "motion"
  | "stale";

/**
 * Decide who owns publication after a calibration restart awaited by motion load.
 * A user exit is not supersession: the still-current motion must continue through
 * its normal renderer path. A newer active bootstrap owns the same identity and
 * must keep the older continuation from replacing its calibration scene.
 */
export function calibrationMotionLoadDisposition(
  bootstrapResult: CalibrationBootstrapResult,
  identityIsCurrent: boolean,
  calibrationModeIsActive: boolean,
): CalibrationMotionLoadDisposition {
  if (!identityIsCurrent) return "stale";
  if (bootstrapResult === "entered") {
    return calibrationModeIsActive ? "calibration" : "motion";
  }
  return calibrationModeIsActive ? "stale" : "motion";
}
