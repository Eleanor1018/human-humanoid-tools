import { describe, expect, it } from "vitest";

import {
  calibrationMotionLoadDisposition,
} from "../../../src/runtime/stage/calibration-motion-load-disposition";

describe("calibrationMotionLoadDisposition", () => {
  it("publishes a completed current calibration restart", () => {
    expect(calibrationMotionLoadDisposition("entered", true, true))
      .toBe("calibration");
  });

  it("continues normal rendering when exit runs after bootstrap finishes", () => {
    expect(calibrationMotionLoadDisposition("entered", true, false))
      .toBe("motion");
  });

  it("does not publish when the captured motion identity was superseded", () => {
    expect(calibrationMotionLoadDisposition("entered", false, true))
      .toBe("stale");
  });

  it("does not let a stale rollback continuation clobber a newer active bootstrap", () => {
    expect(calibrationMotionLoadDisposition("stale", true, true))
      .toBe("stale");
  });

  it("continues the current motion renderer path after pending calibration is cancelled", () => {
    expect(calibrationMotionLoadDisposition("stale", true, false))
      .toBe("motion");
  });

  it("continues the current motion renderer path after a completed rollback", () => {
    expect(calibrationMotionLoadDisposition("failed", true, false))
      .toBe("motion");
  });

  it("does not let a failed continuation clobber a calibration owner that reentered", () => {
    expect(calibrationMotionLoadDisposition("failed", true, true))
      .toBe("stale");
  });
});
