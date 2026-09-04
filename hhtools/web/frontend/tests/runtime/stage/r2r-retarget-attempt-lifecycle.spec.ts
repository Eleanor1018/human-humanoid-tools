import { describe, expect, it } from "vitest";

import {
  LatestAsyncAttemptOwner,
  type LatestAsyncAttempt,
} from "../../../src/runtime/stage/latest-async-attempt-owner";
import {
  LatestAsyncResultOwner,
  type CommittedAsyncResult,
} from "../../../src/runtime/stage/latest-async-result-owner";
import {
  createR2rPlaybackPresentation,
  type R2rPlaybackPresentation,
} from "../../../src/runtime/stage/panel-presentation-intent";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

interface RobotPayload {
  readonly name: string;
}

interface TargetLoadIdentity {
  readonly name: string;
}

interface TrajectoryIdentity {
  readonly token: string;
}

interface RetargetIdentity {
  readonly sourcePayload: RobotPayload;
  readonly sourceToken: string;
  readonly targetName: string;
  readonly targetPayload: RobotPayload;
  readonly targetViewGeneration: number;
  readonly calibrationRevision: number;
}

interface RetargetResult {
  readonly exportToken: string;
  readonly duration: number;
}

type ComparisonPreset = "source" | "target" | "result" | "overlay";

interface ProgressUpdate {
  readonly indeterminate: boolean;
  readonly width: string;
  readonly status: string;
}

type TrajectoryCommit = CommittedAsyncResult<
  TrajectoryIdentity,
  R2rPlaybackPresentation
>;
type RetargetCommit = CommittedAsyncResult<
  RetargetIdentity,
  R2rPlaybackPresentation
>;

/**
 * Small contract harness for the ownership rules used by the compatibility
 * runtime. It intentionally has no DOM, Three.js, transport, or runtime module
 * import: deferred promises and callbacks stand in for those hostile borders.
 */
function r2rAttemptHarness() {
  const sourcePayload: RobotPayload = { name: "source" };
  const initialTargetPayload: RobotPayload = { name: "target-0" };
  const state: {
    sourcePayload: RobotPayload;
    sourceToken: string;
    targetName: string | null;
    targetPayload: RobotPayload | null;
    targetViewGeneration: number;
    calibrationRevision: number;
    calibrated: boolean;
    comparisonPreset: ComparisonPreset;
    exportToken: string | null;
    stagedTarget: string | null;
  } = {
    sourcePayload,
    sourceToken: "source-token",
    targetName: initialTargetPayload.name,
    targetPayload: initialTargetPayload,
    targetViewGeneration: 1,
    calibrationRevision: 4,
    calibrated: true,
    comparisonPreset: "overlay",
    exportToken: null,
    stagedTarget: null,
  };
  const transientUi = {
    progressVisible: false,
    indeterminate: false,
    width: "0%",
    status: "",
  };
  const events: string[] = [];

  const targetLoads = new LatestAsyncAttemptOwner<TargetLoadIdentity>(
    () => true,
  );
  let pendingTargetLoad: LatestAsyncAttempt<TargetLoadIdentity> | null = null;

  const trajectoryResults = new LatestAsyncResultOwner<
    TrajectoryIdentity,
    R2rPlaybackPresentation
  >(() => true);
  let insideRetargetCommit = false;
  let nextRetargetCommitValidation: (() => void) | null = null;
  const retargetResults = new LatestAsyncResultOwner<
    RetargetIdentity,
    R2rPlaybackPresentation
  >((identity) => {
    if (insideRetargetCommit && nextRetargetCommitValidation) {
      const reenter = nextRetargetCommitValidation;
      nextRetargetCommitValidation = null;
      reenter();
    }
    return (
      pendingTargetLoad === null
      && state.sourcePayload === identity.sourcePayload
      && state.sourceToken === identity.sourceToken
      && state.targetName === identity.targetName
      && state.targetPayload === identity.targetPayload
      && state.targetViewGeneration === identity.targetViewGeneration
      && state.calibrationRevision === identity.calibrationRevision
    );
  });
  let pendingRetarget: LatestAsyncAttempt<RetargetIdentity> | null = null;

  const calibrationStatusAttempts = new LatestAsyncAttemptOwner<
    RetargetIdentity
  >((identity) => (
    state.sourcePayload === identity.sourcePayload
    && state.sourceToken === identity.sourceToken
    && state.targetName === identity.targetName
    && state.targetPayload === identity.targetPayload
    && state.targetViewGeneration === identity.targetViewGeneration
    && state.calibrationRevision === identity.calibrationRevision
  ));

  const invalidateRetarget = (): void => {
    retargetResults.invalidate();
  };

  const finishTargetLoad = (
    attempt: LatestAsyncAttempt<TargetLoadIdentity>,
  ): boolean => {
    if (!targetLoads.finish(attempt)) return false;
    if (pendingTargetLoad === attempt) pendingTargetLoad = null;
    return true;
  };

  const loadTarget = async (
    name: string,
    request: Promise<RobotPayload>,
  ): Promise<"committed" | "failed" | "stale"> => {
    // Selection wins synchronously, before the transport can resolve.
    const attempt = targetLoads.begin(Object.freeze({ name }));
    pendingTargetLoad = attempt;
    invalidateRetarget();
    state.targetName = null;
    state.targetPayload = null;
    try {
      const payload = await request;
      if (!targetLoads.isCurrent(attempt)) return "stale";
      state.targetName = name;
      state.targetPayload = payload;
      events.push(`target:${name}`);
      return finishTargetLoad(attempt) ? "committed" : "stale";
    } catch {
      if (!targetLoads.isCurrent(attempt)) return "stale";
      events.push(`target-error:${name}`);
      return finishTargetLoad(attempt) ? "failed" : "stale";
    }
  };

  const captureRetargetIdentity = (): RetargetIdentity => {
    if (!state.targetName || !state.targetPayload) {
      throw new Error("A target is required before retargeting");
    }
    return Object.freeze({
      sourcePayload: state.sourcePayload,
      sourceToken: state.sourceToken,
      targetName: state.targetName,
      targetPayload: state.targetPayload,
      targetViewGeneration: state.targetViewGeneration,
      calibrationRevision: state.calibrationRevision,
    });
  };

  const commitRetarget = (
    attempt: LatestAsyncAttempt<RetargetIdentity>,
    presentation: R2rPlaybackPresentation,
  ): RetargetCommit | null => {
    // Capture the exact source receipt, but withdraw it only after the target
    // result has proved that it still owns publication.
    const sourcePresentation = trajectoryResults.pendingPresentation;
    let committed: RetargetCommit | null;
    insideRetargetCommit = true;
    try {
      committed = retargetResults.commit(attempt, presentation);
    } finally {
      insideRetargetCommit = false;
    }
    if (!committed) return null;
    if (pendingRetarget === attempt) pendingRetarget = null;
    if (sourcePresentation) {
      trajectoryResults.withdrawPresentation(sourcePresentation);
    }
    return committed;
  };

  const clearTransientUi = (
    isCurrent: () => boolean,
  ): boolean => {
    if (!isCurrent()) return false;
    transientUi.indeterminate = false;
    if (!isCurrent()) return false;
    transientUi.progressVisible = false;
    if (!isCurrent()) return false;
    transientUi.width = "0%";
    if (!isCurrent()) return false;
    transientUi.status = "";
    return isCurrent();
  };

  interface RetargetRun {
    readonly attempt: LatestAsyncAttempt<RetargetIdentity>;
    readonly completion: Promise<"committed" | "failed" | "stale">;
    readonly reportProgress: (
      update: ProgressUpdate,
      afterFirstMutation?: () => void,
    ) => void;
  }

  const runRetarget = (request: Promise<RetargetResult>): RetargetRun => {
    const attempt = retargetResults.begin(captureRetargetIdentity());
    pendingRetarget = attempt;
    const isCurrent = (): boolean => retargetResults.isCurrent(attempt);
    // Reserving B retires both A's transient display and any renderer candidate
    // that A staged before it could publish an exact domain commit.
    state.stagedTarget = null;
    clearTransientUi(isCurrent);
    const completion = (async (): Promise<
      "committed" | "failed" | "stale"
    > => {
      try {
        const result = await request;
        if (!isCurrent()) return "stale";
        state.stagedTarget = result.exportToken;
        const committed = commitRetarget(
          attempt,
          createR2rPlaybackPresentation({ duration: result.duration }),
        );
        if (!committed) return "stale";
        state.exportToken = result.exportToken;
        events.push(`retarget:${result.exportToken}`);
        return "committed";
      } catch {
        if (!isCurrent()) return "stale";
        events.push(`retarget-error:${attempt.generation}`);
        if (!retargetResults.finish(attempt)) return "stale";
        if (pendingRetarget === attempt) pendingRetarget = null;
        return "failed";
      }
    })();

    return {
      attempt,
      completion,
      reportProgress: (update, afterFirstMutation) => {
        if (!isCurrent()) return;
        transientUi.progressVisible = true;
        if (!isCurrent()) return;
        transientUi.indeterminate = update.indeterminate;
        afterFirstMutation?.();
        // A host callback may synchronously reserve a successor. The second
        // progress mutation must re-check the exact attempt, not a state flag.
        if (!isCurrent()) return;
        transientUi.width = update.width;
        if (!isCurrent()) return;
        transientUi.status = update.status;
      },
    };
  };

  const retargetIsPending = (): boolean => (
    pendingRetarget !== null && retargetResults.isCurrent(pendingRetarget)
  );

  const beginCalibrationStatus = (): LatestAsyncAttempt<RetargetIdentity> => (
    calibrationStatusAttempts.begin(captureRetargetIdentity())
  );

  const refreshCalibrationStatus = async (
    request: Promise<boolean>,
  ): Promise<"current" | "stale"> => {
    // A generic refresh has no authority to replace the status owner while an
    // exact retarget preflight/result continuation owns the same robot pair.
    if (retargetIsPending()) return "stale";
    const attempt = beginCalibrationStatus();
    const calibrated = await request;
    if (retargetIsPending() || !calibrationStatusAttempts.isCurrent(attempt)) {
      return "stale";
    }
    state.calibrated = calibrated;
    return "current";
  };

  const seedTrajectory = (token = "trajectory"): TrajectoryCommit => {
    const attempt = trajectoryResults.begin(Object.freeze({ token }));
    const committed = trajectoryResults.commit(
      attempt,
      createR2rPlaybackPresentation({ duration: 2 }),
    );
    if (!committed) throw new Error("Failed to seed trajectory result");
    return committed;
  };

  return {
    beginCalibrationStatus,
    calibrationStatusAttempts,
    events,
    loadTarget,
    onNextRetargetCommitValidation(callback: () => void): void {
      nextRetargetCommitValidation = callback;
    },
    refreshCalibrationStatus,
    retargetResults,
    runRetarget,
    seedTrajectory,
    state,
    transientUi,
    trajectoryResults,
  };
}

describe("R2R retarget attempt lifecycle", () => {
  it("lets only target B publish aliases when target requests finish B then A", async () => {
    const harness = r2rAttemptHarness();
    const first = deferred<RobotPayload>();
    const second = deferred<RobotPayload>();
    const firstRun = harness.loadTarget("target-A", first.promise);
    const secondRun = harness.loadTarget("target-B", second.promise);

    second.resolve({ name: "payload-B" });
    await expect(secondRun).resolves.toBe("committed");
    first.reject(new Error("late target A failure"));

    await expect(firstRun).resolves.toBe("stale");
    expect(harness.state.targetName).toBe("target-B");
    expect(harness.state.targetPayload).toEqual({ name: "payload-B" });
    expect(harness.events).toEqual(["target:target-B"]);
  });

  it("lets only retarget B commit when retarget requests finish B then A", async () => {
    const harness = r2rAttemptHarness();
    const first = deferred<RetargetResult>();
    const second = deferred<RetargetResult>();
    const firstRun = harness.runRetarget(first.promise);
    const secondRun = harness.runRetarget(second.promise);

    second.resolve({ exportToken: "B", duration: 5 });
    await expect(secondRun.completion).resolves.toBe("committed");
    first.resolve({ exportToken: "A", duration: 3 });

    await expect(firstRun.completion).resolves.toBe("stale");
    expect(harness.state.exportToken).toBe("B");
    expect(harness.events).toEqual(["retarget:B"]);
    expect(harness.retargetResults.pendingPresentation?.value.duration).toBe(5);
  });

  it.each(["resolve", "reject"] as const)(
    "keeps A status/result/error neutral when progress reenters B, then A %s",
    async (settlement) => {
      const harness = r2rAttemptHarness();
      const first = deferred<RetargetResult>();
      const second = deferred<RetargetResult>();
      const firstRun = harness.runRetarget(first.promise);
      let secondRun: ReturnType<typeof harness.runRetarget> | null = null;

      firstRun.reportProgress(
        {
          indeterminate: true,
          width: "45%",
          status: "A still running",
        },
        () => {
          harness.events.push("progress:A");
          secondRun = harness.runRetarget(second.promise);
        },
      );
      if (settlement === "resolve") {
        first.resolve({ exportToken: "A", duration: 3 });
      } else {
        first.reject(new Error("late A failure"));
      }
      second.resolve({ exportToken: "B", duration: 6 });

      await expect(firstRun.completion).resolves.toBe("stale");
      expect(secondRun).not.toBeNull();
      await expect(secondRun!.completion).resolves.toBe("committed");
      expect(harness.events).toEqual(["progress:A", "retarget:B"]);
      expect(harness.state.exportToken).toBe("B");
      expect(harness.transientUi).toEqual({
        progressVisible: false,
        indeterminate: false,
        width: "0%",
        status: "",
      });
    },
  );

  it("does not publish A metadata when commit validation reenters B", async () => {
    const harness = r2rAttemptHarness();
    const first = deferred<RetargetResult>();
    const second = deferred<RetargetResult>();
    const firstRun = harness.runRetarget(first.promise);
    let secondRun: ReturnType<typeof harness.runRetarget> | null = null;

    harness.onNextRetargetCommitValidation(() => {
      secondRun = harness.runRetarget(second.promise);
    });
    first.resolve({ exportToken: "stale-A", duration: 3 });

    await expect(firstRun.completion).resolves.toBe("stale");
    expect(secondRun).not.toBeNull();
    expect(harness.state.exportToken).toBeNull();
    expect(harness.state.stagedTarget).toBeNull();
    expect(harness.events).toEqual([]);

    second.reject(new Error("B stopped before staging a result"));
    await expect(secondRun!.completion).resolves.toBe("failed");
    expect(harness.state.exportToken).toBeNull();
    expect(harness.state.stagedTarget).toBeNull();
    expect(harness.events).toEqual(["retarget-error:2"]);
  });

  it("clears A progress and status when successor B reserves ownership", async () => {
    const harness = r2rAttemptHarness();
    const first = deferred<RetargetResult>();
    const second = deferred<RetargetResult>();
    const firstRun = harness.runRetarget(first.promise);

    firstRun.reportProgress({
      indeterminate: true,
      width: "37%",
      status: "A owns this status",
    });
    expect(harness.transientUi).toEqual({
      progressVisible: true,
      indeterminate: true,
      width: "37%",
      status: "A owns this status",
    });

    const secondRun = harness.runRetarget(second.promise);
    expect(harness.transientUi).toEqual({
      progressVisible: false,
      indeterminate: false,
      width: "0%",
      status: "",
    });

    first.resolve({ exportToken: "stale-A", duration: 3 });
    second.reject(new Error("B stopped"));
    await expect(firstRun.completion).resolves.toBe("stale");
    await expect(secondRun.completion).resolves.toBe("failed");
  });

  it("does not let a generic calibration refresh steal a pending retarget", async () => {
    const harness = r2rAttemptHarness();
    const existingStatus = harness.beginCalibrationStatus();
    const result = deferred<RetargetResult>();
    const run = harness.runRetarget(result.promise);

    await expect(harness.refreshCalibrationStatus(Promise.resolve(false)))
      .resolves.toBe("stale");
    expect(harness.state.calibrated).toBe(true);
    expect(harness.calibrationStatusAttempts.isCurrent(existingStatus))
      .toBe(true);

    result.reject(new Error("retarget stopped"));
    await expect(run.completion).resolves.toBe("failed");
  });

  it("does not withdraw source playback when a stale retarget settles", async () => {
    const harness = r2rAttemptHarness();
    const sourceCommit = harness.seedTrajectory("source");
    const first = deferred<RetargetResult>();
    const second = deferred<RetargetResult>();
    const firstRun = harness.runRetarget(first.promise);
    const secondRun = harness.runRetarget(second.promise);

    first.resolve({ exportToken: "stale-A", duration: 3 });
    await expect(firstRun.completion).resolves.toBe("stale");
    expect(harness.trajectoryResults.pendingPresentation).toBe(sourceCommit);

    second.reject(new Error("current B failed"));
    await expect(secondRun.completion).resolves.toBe("failed");
    expect(harness.trajectoryResults.pendingPresentation).toBe(sourceCommit);
    expect(harness.trajectoryResults.isLatestResult(sourceCommit)).toBe(true);
  });

  it("replaces only source presentation after an exact retarget success", async () => {
    const harness = r2rAttemptHarness();
    const sourceCommit = harness.seedTrajectory("source");
    const result = deferred<RetargetResult>();
    const run = harness.runRetarget(result.promise);

    result.resolve({ exportToken: "target-result", duration: 7 });
    await expect(run.completion).resolves.toBe("committed");

    const targetCommit = harness.retargetResults.pendingPresentation;
    expect(targetCommit?.value.duration).toBe(7);
    expect(harness.trajectoryResults.pendingPresentation).toBeNull();
    expect(harness.trajectoryResults.isCommitted(sourceCommit)).toBe(false);
    // Retarget consumes only the source's shared-surface capability. The
    // selected source trajectory remains the valid feature-local domain input.
    expect(harness.trajectoryResults.isLatestResult(sourceCommit)).toBe(true);
    expect(targetCommit && harness.retargetResults.isCommitted(targetCommit))
      .toBe(true);
  });

  it("preserves the current comparison preset after retarget success", async () => {
    const harness = r2rAttemptHarness();
    const result = deferred<RetargetResult>();
    harness.state.comparisonPreset = "source";
    const run = harness.runRetarget(result.promise);

    // A command issued while the job is pending remains authoritative;
    // completion publishes result capability but must not force `result`.
    harness.state.comparisonPreset = "target";
    result.resolve({ exportToken: "target-result", duration: 7 });
    await expect(run.completion).resolves.toBe("committed");

    expect(harness.state.comparisonPreset).toBe("target");
    expect(harness.state.comparisonPreset).not.toBe("result");
  });
});
