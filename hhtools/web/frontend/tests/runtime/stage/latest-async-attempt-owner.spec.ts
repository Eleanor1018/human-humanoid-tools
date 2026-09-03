import { describe, expect, it, vi } from "vitest";

import {
  LatestAsyncAttemptOwner,
} from "../../../src/runtime/stage/latest-async-attempt-owner";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

interface Identity {
  readonly name: string;
}

function attemptHarness() {
  let activeName = "A";
  const owner = new LatestAsyncAttemptOwner<Identity>(
    (identity) => identity.name === activeName,
  );
  const commits: string[] = [];
  const rollbacks: string[] = [];

  async function run(
    name: string,
    request: Promise<string>,
  ): Promise<void> {
    const attempt = owner.begin({ name });
    try {
      const result = await request;
      if (!owner.isCurrent(attempt)) return;
      commits.push(result);
      owner.finish(attempt);
    } catch {
      if (!owner.isCurrent(attempt)) return;
      rollbacks.push(name);
      owner.finish(attempt);
    }
  }

  return {
    owner,
    commits,
    rollbacks,
    run,
    setActiveName(name: string): void {
      activeName = name;
    },
  };
}

describe("LatestAsyncAttemptOwner", () => {
  it("grants publication rights only to the latest attempt", () => {
    const owner = new LatestAsyncAttemptOwner<Identity>(() => true);
    const first = owner.begin({ name: "A" });
    const second = owner.begin({ name: "B" });

    expect(owner.isCurrent(first)).toBe(false);
    expect(owner.isCurrent(second)).toBe(true);
    expect(second.generation).toBeGreaterThan(first.generation);
  });

  it("prevents a stale rejection from rolling back its successor", async () => {
    const harness = attemptHarness();
    const first = deferred<string>();
    const second = deferred<string>();
    const firstRun = harness.run("A", first.promise);
    harness.setActiveName("B");
    const secondRun = harness.run("B", second.promise);

    first.reject(new Error("late A failure"));
    second.resolve("B committed");
    await Promise.all([firstRun, secondRun]);

    expect(harness.rollbacks).toEqual([]);
    expect(harness.commits).toEqual(["B committed"]);
  });

  it("allows only a current rejection to claim rollback", async () => {
    const harness = attemptHarness();

    await harness.run("A", Promise.reject(new Error("current failure")));

    expect(harness.rollbacks).toEqual(["A"]);
    expect(harness.commits).toEqual([]);
  });

  it("prevents a completion from resurrecting an invalidated attempt", async () => {
    const harness = attemptHarness();
    const pending = deferred<string>();
    const run = harness.run("A", pending.promise);

    harness.owner.invalidate();
    pending.resolve("late commit");
    await run;

    expect(harness.commits).toEqual([]);
    expect(harness.rollbacks).toEqual([]);
  });

  it("fails closed when the captured identity changes", async () => {
    const harness = attemptHarness();
    const pending = deferred<string>();
    const run = harness.run("A", pending.promise);

    harness.setActiveName("B");
    pending.resolve("wrong identity");
    await run;

    expect(harness.commits).toEqual([]);
    expect(harness.rollbacks).toEqual([]);
  });

  it("invalidates a status attempt when only its captured motion changes", () => {
    const robot = {};
    const motionA = {};
    const motionB = {};
    let currentMotion = motionA;
    const owner = new LatestAsyncAttemptOwner<{
      readonly robot: object;
      readonly motion: object;
      readonly reference: string;
    }>((identity) => (
      identity.robot === robot
      && identity.motion === currentMotion
      && identity.reference === "ref"
    ));
    const attempt = owner.begin({ robot, motion: motionA, reference: "ref" });

    currentMotion = motionB;

    expect(owner.isCurrent(attempt)).toBe(false);
  });

  it("does not let identity validation reentrancy preserve an old token", () => {
    let owner!: LatestAsyncAttemptOwner<Identity>;
    const validate = vi.fn(() => {
      owner.invalidate();
      return true;
    });
    owner = new LatestAsyncAttemptOwner(validate);
    const attempt = owner.begin({ name: "A" });

    expect(owner.isCurrent(attempt)).toBe(false);
    expect(validate).toHaveBeenCalledOnce();
  });

  it("finishes only the supplied current attempt", () => {
    const owner = new LatestAsyncAttemptOwner<Identity>(() => true);
    const first = owner.begin({ name: "A" });
    const second = owner.begin({ name: "B" });

    expect(owner.finish(first)).toBe(false);
    expect(owner.isCurrent(second)).toBe(true);
    expect(owner.finish(second)).toBe(true);
    expect(owner.isCurrent(second)).toBe(false);
  });

  it("reports rollback as incomplete when cleanup starts a same-identity successor", () => {
    const owner = new LatestAsyncAttemptOwner<Identity>(() => true);
    const first = owner.begin({ name: "same" });
    let successor: ReturnType<typeof owner.begin> | null = null;

    const rollbackCompleted = (() => {
      if (!owner.isCurrent(first)) return false;
      successor = owner.begin({ name: "same" });
      return owner.finish(first);
    })();
    const result = rollbackCompleted ? "failed" : "stale";

    expect(result).toBe("stale");
    expect(successor).not.toBeNull();
    expect(owner.isCurrent(successor!)).toBe(true);
  });

  it("keeps the original session snapshots when reentry supersedes rollback", () => {
    const owner = new LatestAsyncAttemptOwner<Identity>(() => true);
    const originalVisibility = { source: true };
    const originalOrbit = { minDistance: 0.5, maxDistance: 8 };
    const session = {
      calibrationMode: true,
      visibility: originalVisibility as { source: boolean } | null,
      orbit: originalOrbit as { minDistance: number; maxDistance: number } | null,
    };
    const first = owner.begin({ name: "same" });
    let successor: ReturnType<typeof owner.begin> | null = null;

    session.calibrationMode = false;
    const cleanupIsStillOwned = (() => {
      if (!owner.isCurrent(first)) return false;
      // Reentry happens before A restores visibility. Since A has not released
      // the shared snapshots, B must not capture the partially rolled-back view.
      const enteringFresh = (
        !session.calibrationMode
        && session.visibility === null
        && session.orbit === null
      );
      successor = owner.begin({ name: "same" });
      session.calibrationMode = true;
      if (enteringFresh) {
        session.visibility = { source: false };
        session.orbit = { minDistance: 1, maxDistance: 2 };
      }
      return owner.isCurrent(first);
    })();

    expect(cleanupIsStillOwned).toBe(false);
    expect(session.visibility).toBe(originalVisibility);
    expect(session.orbit).toBe(originalOrbit);
    expect(owner.isCurrent(successor!)).toBe(true);
  });
});
