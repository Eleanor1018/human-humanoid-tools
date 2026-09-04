import { describe, expect, it } from "vitest";

import {
  LatestAsyncAttemptOwner,
  type LatestAsyncAttempt,
} from "../../../src/runtime/stage/latest-async-attempt-owner";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

interface PairIdentity {
  readonly sourcePayload: object;
  readonly targetPayload: object;
  readonly sourceGeneration: number;
  readonly targetGeneration: number | null;
  readonly targetWithdrawn: boolean;
}

function calibrationOwners() {
  const sourcePayload = {};
  const targetPayload = {};
  const state: {
    sourcePayload: object;
    targetPayload: object | null;
    sourceGeneration: number;
    targetGeneration: number;
  } = {
    sourcePayload,
    targetPayload,
    sourceGeneration: 3,
    targetGeneration: 7,
  };
  const identityIsCurrent = (identity: PairIdentity): boolean => (
    state.sourcePayload === identity.sourcePayload
    && state.sourceGeneration === identity.sourceGeneration
    && (
      state.targetPayload === identity.targetPayload
      || (identity.targetWithdrawn && state.targetPayload === null)
    )
    && (
      identity.targetGeneration === null
      || state.targetGeneration === identity.targetGeneration
    )
  );
  const bootstrap = new LatestAsyncAttemptOwner(identityIsCurrent);
  const status = new LatestAsyncAttemptOwner(identityIsCurrent);
  const capture = (): PairIdentity => ({
    sourcePayload: state.sourcePayload,
    targetPayload,
    sourceGeneration: state.sourceGeneration,
    targetGeneration: state.targetGeneration,
    targetWithdrawn: false,
  });
  return { bootstrap, capture, sourcePayload, state, status, targetPayload };
}

describe("R2R calibration attempt lifecycle", () => {
  it.each([
    "exit invalidation",
    "newer status",
    "pair replacement",
  ])("does not auto-start across the status receipt gap after %s", async (event) => {
    const harness = calibrationOwners();
    const receipt = harness.status.begin(harness.capture());
    let starts = 0;
    const consumeReceipt = async (): Promise<boolean> => {
      // Models the continuation queued by `await r2rUpdateRetargetBtn()`.
      await Promise.resolve();
      if (!harness.status.isCurrent(receipt)) return false;
      harness.status.invalidate();
      harness.bootstrap.begin(receipt.identity);
      starts += 1;
      return true;
    };

    const consumed = consumeReceipt();
    if (event === "exit invalidation") {
      harness.status.invalidate();
      harness.bootstrap.invalidate();
    } else if (event === "newer status") {
      harness.status.begin(harness.capture());
    } else {
      harness.state.targetPayload = {};
    }

    await expect(consumed).resolves.toBe(false);
    expect(starts).toBe(0);
  });

  it("hands a current status receipt directly to bootstrap ownership", () => {
    const harness = calibrationOwners();
    const receipt = harness.status.begin(harness.capture());

    expect(harness.status.isCurrent(receipt)).toBe(true);
    harness.status.invalidate();
    const bootstrap = harness.bootstrap.begin(receipt.identity);

    expect(harness.status.isCurrent(receipt)).toBe(false);
    expect(harness.bootstrap.isCurrent(bootstrap)).toBe(true);
  });

  it("does not expose saved calibration while bootstrap is pending", async () => {
    const harness = calibrationOwners();
    let pending: LatestAsyncAttempt<PairIdentity> | null = null;
    const beginBootstrap = (): LatestAsyncAttempt<PairIdentity> => {
      const attempt = harness.bootstrap.begin(harness.capture());
      pending = attempt;
      return attempt;
    };
    const isPending = (): boolean => (
      pending !== null && harness.bootstrap.isCurrent(pending)
    );
    const readSavedStatus = async (): Promise<boolean | null> => {
      if (isPending()) return null;
      return true;
    };
    const ensure = async (): Promise<"entered" | "ready"> => {
      const saved = await readSavedStatus();
      if (isPending() || saved === null) return "entered";
      return "ready";
    };

    beginBootstrap();

    await expect(ensure()).resolves.toBe("entered");
  });

  it("keeps a successor pending when stale A tries to finish", () => {
    const harness = calibrationOwners();
    let pending: LatestAsyncAttempt<PairIdentity> | null = null;
    const begin = (): LatestAsyncAttempt<PairIdentity> => {
      const attempt = harness.bootstrap.begin(harness.capture());
      pending = attempt;
      return attempt;
    };
    const finish = (attempt: LatestAsyncAttempt<PairIdentity>): boolean => {
      if (!harness.bootstrap.finish(attempt)) return false;
      if (pending === attempt) pending = null;
      return true;
    };
    const first = begin();
    const successor = begin();

    expect(finish(first)).toBe(false);
    expect(pending).toBe(successor);
    expect(harness.bootstrap.isCurrent(successor)).toBe(true);
    expect(finish(successor)).toBe(true);
    expect(pending).toBeNull();
  });

  it("rejects a saved receipt when bootstrap begins before its consumer resumes", async () => {
    const harness = calibrationOwners();
    const savedReceipt = harness.status.begin(harness.capture());
    let pending: LatestAsyncAttempt<PairIdentity> | null = null;
    const consume = async (): Promise<"entered" | "ready" | "stale"> => {
      await Promise.resolve();
      if (pending && harness.bootstrap.isCurrent(pending)) return "entered";
      if (!harness.status.isCurrent(savedReceipt)) return "stale";
      return harness.status.finish(savedReceipt) ? "ready" : "stale";
    };

    const result = consume();
    pending = harness.bootstrap.begin(harness.capture());
    harness.status.invalidate();

    await expect(result).resolves.toBe("entered");
  });

  it("keeps retarget closed when calibration enters before receipt consumption", async () => {
    const harness = calibrationOwners();
    const calibratedReceipt = harness.status.begin(harness.capture());
    let calibrating = false;
    let retargetReady = false;
    const consume = async (): Promise<"entered" | "ready" | "stale"> => {
      // The status producer has returned; its caller resumes in a later job.
      await Promise.resolve();
      if (calibrating) return "entered";
      if (!harness.status.isCurrent(calibratedReceipt)) return "stale";
      if (!harness.status.finish(calibratedReceipt)) return "stale";
      retargetReady = true;
      return "ready";
    };

    const result = consume();
    // A pending bootstrap transitions to active in the continuation gap.
    harness.status.invalidate();
    calibrating = true;

    await expect(result).resolves.toBe("entered");
    expect(retargetReady).toBe(false);
    expect(harness.status.isCurrent(calibratedReceipt)).toBe(false);
  });

  it("guards the initial generation and binds an owned target load before awaiting", async () => {
    const harness = calibrationOwners();
    const request = deferred<"committed">();
    let attempt = harness.bootstrap.begin(harness.capture());

    // Session and payload selection retain the exact pre-load generation.
    harness.state.targetGeneration += 1;
    expect(harness.bootstrap.isCurrent(attempt)).toBe(false);

    attempt = harness.bootstrap.begin(harness.capture());
    attempt = harness.bootstrap.begin({
      ...attempt.identity,
      targetGeneration: null,
    });
    const ownGeneration = ++harness.state.targetGeneration;
    expect(harness.bootstrap.isCurrent(attempt)).toBe(true);
    attempt = harness.bootstrap.begin({
      ...attempt.identity,
      targetGeneration: ownGeneration,
    });

    const completion = (async (): Promise<"committed" | "stale"> => {
      await request.promise;
      return harness.bootstrap.isCurrent(attempt) ? "committed" : "stale";
    })();
    // A foreign RobotView load after the exact rebind supersedes this attempt.
    harness.state.targetGeneration += 1;
    request.resolve("committed");

    await expect(completion).resolves.toBe("stale");
  });

  it("does not reclaim ownership after target-load start reenters a successor", () => {
    const harness = calibrationOwners();
    let attempt = harness.bootstrap.begin(harness.capture());
    attempt = harness.bootstrap.begin({
      ...attempt.identity,
      targetGeneration: null,
    });

    const ownGeneration = ++harness.state.targetGeneration;
    const successor = harness.bootstrap.begin({
      ...harness.capture(),
      targetGeneration: ownGeneration,
    });

    expect(harness.bootstrap.isCurrent(attempt)).toBe(false);
    expect(harness.bootstrap.isCurrent(successor)).toBe(true);
  });

  it("keeps target-withdrawal cleanup owned when missing-pair start reenters", () => {
    const harness = calibrationOwners();
    let attempt = harness.bootstrap.begin(harness.capture());
    const cleanupSteps: string[] = [];

    attempt = harness.bootstrap.begin({
      ...attempt.identity,
      targetWithdrawn: true,
    });
    harness.state.targetPayload = null;
    const missingPairStart = (): "failed" => {
      // Missing input reports failure but is not an ownership transfer. The
      // explicit exit/replacement paths are responsible for invalidation.
      expect(harness.state.targetPayload).toBeNull();
      return "failed";
    };
    const cleanup = (action: () => void): boolean => {
      if (!harness.bootstrap.isCurrent(attempt)) return false;
      action();
      return harness.bootstrap.isCurrent(attempt);
    };

    expect(cleanup(() => {
      expect(missingPairStart()).toBe("failed");
      cleanupSteps.push("publication");
    })).toBe(true);
    expect(cleanup(() => cleanupSteps.push("stage"))).toBe(true);
    expect(harness.bootstrap.finish(attempt)).toBe(true);
    expect(cleanupSteps).toEqual(["publication", "stage"]);
  });

  it("lets a same-pair successor inherit unfinished calibration resources", () => {
    const harness = calibrationOwners();
    const shared = {
      resourcesOwned: true,
      restoreGroundOffset: 0.42 as number | null,
    };
    const attempt = harness.bootstrap.begin(harness.capture());
    const cleanupSteps: string[] = [];

    // A has terminalized its public mode but deliberately retains the shared
    // baseline until cleanup fully finishes or a successor takes ownership.
    const cleanup = (action: () => void): boolean => {
      if (!harness.bootstrap.isCurrent(attempt)) return false;
      action();
      return harness.bootstrap.isCurrent(attempt);
    };
    const aStillCurrent = cleanup(() => {
      cleanupSteps.push("A started cleanup");
      const inheritedResources = shared.resourcesOwned;
      const inheritedGroundOffset = shared.restoreGroundOffset;
      const successor = harness.bootstrap.begin(harness.capture());

      // B fails before loading its own target View, so only the inherited
      // lifetime can finish the manipulator/reference/Stage compensation.
      expect(inheritedResources).toBe(true);
      expect(inheritedGroundOffset).toBe(0.42);
      cleanupSteps.push("B manipulator", "B reference", "B Stage", "B ground");
      expect(harness.bootstrap.finish(successor)).toBe(true);
      shared.resourcesOwned = false;
      shared.restoreGroundOffset = null;
    });

    expect(aStillCurrent).toBe(false);
    expect(cleanupSteps).toEqual([
      "A started cleanup",
      "B manipulator",
      "B reference",
      "B Stage",
      "B ground",
    ]);
    expect(shared).toEqual({ resourcesOwned: false, restoreGroundOffset: null });
  });

  it("stops target-withdrawal cleanup when replacement reentry takes ownership", () => {
    const harness = calibrationOwners();
    let attempt = harness.bootstrap.begin(harness.capture());
    let successor: LatestAsyncAttempt<PairIdentity> | null = null;
    const cleanupSteps: string[] = [];

    attempt = harness.bootstrap.begin({
      ...attempt.identity,
      targetWithdrawn: true,
    });
    harness.state.targetPayload = null;
    const cleanup = (action: () => void): boolean => {
      if (!harness.bootstrap.isCurrent(attempt)) return false;
      action();
      return harness.bootstrap.isCurrent(attempt);
    };

    const firstCompleted = cleanup(() => {
      cleanupSteps.push("first");
      harness.state.targetPayload = harness.targetPayload;
      successor = harness.bootstrap.begin(harness.capture());
    });
    if (firstCompleted) cleanup(() => cleanupSteps.push("must not run"));

    expect(firstCompleted).toBe(false);
    expect(cleanupSteps).toEqual(["first"]);
    expect(successor).not.toBeNull();
    expect(harness.bootstrap.isCurrent(successor!)).toBe(true);
  });
});
