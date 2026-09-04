import { describe, expect, it } from "vitest";

import {
  cleanupReplacedPointerGestureOrRollback,
  inheritedPointerGestureOrbitBaseline,
  LatestPointerGestureOwner,
  matchesOwnedPointerCaptureLoss,
  projectPointerGestureSharedState,
  samePointerCaptureIdentity,
  type OwnedPointerGesture,
  type PointerGestureTransition,
} from "../../../src/runtime/stage/latest-pointer-gesture-owner";
import {
  installReentrantSessionResource,
  ReentrantHostMutationGate,
  type SessionLateCleanupCause,
} from "../../../src/runtime/stage/reentrant-session-install";

interface GestureValue {
  readonly name: string;
  readonly pointerId: number;
  readonly target: FakePointerCaptureTarget;
}

class FakePointerCaptureTarget {
  readonly sets: number[] = [];
  readonly releases: number[] = [];
  readonly ownerDocument = {};
  isConnected = true;
  onSet: (() => void) | null = null;
  onRelease: (() => void) | null = null;
  readonly #captured = new Set<number>();

  setPointerCapture(pointerId: number): void {
    this.sets.push(pointerId);
    this.onSet?.();
    this.#captured.add(pointerId);
  }

  hasPointerCapture(pointerId: number): boolean {
    return this.#captured.has(pointerId);
  }

  releasePointerCapture(pointerId: number): void {
    this.releases.push(pointerId);
    this.#captured.delete(pointerId);
    this.onRelease?.();
  }
}

type HarnessGestureKind = "card" | "track" | "canvas";

interface HarnessGesture {
  readonly name: string;
  readonly pointerId: number;
  readonly target: FakePointerCaptureTarget;
  readonly kind: HarnessGestureKind;
  activated: boolean;
  orbitEnabledBefore: boolean;
  onExactCleanup: (() => void) | null;
}

class PointerGestureProjectionHarness {
  readonly owner = new LatestPointerGestureOwner<HarnessGesture>();
  orbitEnabled = true;
  stageDragging = false;

  begin(
    gesture: HarnessGesture,
    { capture = true }: { capture?: boolean } = {},
  ): OwnedPointerGesture<HarnessGesture> | null {
    const replacement = this.owner.begin(gesture);
    gesture.orbitEnabledBefore = inheritedPointerGestureOrbitBaseline(
      replacement.previous?.value ?? null,
      this.orbitEnabled,
    );
    cleanupReplacedPointerGestureOrRollback(
      this.owner,
      replacement,
      (retired, handoff) => this.cleanup(retired, handoff),
    );
    if (!this.owner.isCurrent(replacement.current)) return null;

    gesture.activated = true;
    this.stageDragging = gesture.kind !== "card";
    this.orbitEnabled = false;
    if (capture && !this.owner.reserveCapture(replacement.current)) {
      this.finish(replacement.current);
      return null;
    }
    return replacement.current;
  }

  finish(gesture: OwnedPointerGesture<HarnessGesture>): void {
    const handoff = this.owner.finish(gesture);
    if (handoff) this.cleanup(gesture, handoff);
  }

  private cleanup(
    owned: OwnedPointerGesture<HarnessGesture>,
    handoff: PointerGestureTransition<HarnessGesture>,
  ): void {
    const cleanupErrors: unknown[] = [];
    const gesture = owned.value;
    const wasActivated = gesture.activated;
    gesture.activated = false;
    if (wasActivated && this.owner.isTransitionCurrent(handoff)) {
      const cleanup = gesture.onExactCleanup;
      gesture.onExactCleanup = null;
      try {
        cleanup?.();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (this.owner.isTransitionCurrent(handoff)) {
      const current = handoff.current?.value ?? null;
      const projection = projectPointerGestureSharedState(
        current
          ? {
              activated: current.activated,
              stageDragging: current.kind !== "card",
            }
          : null,
        gesture.orbitEnabledBefore,
      );
      this.stageDragging = projection.stageDragging;
      this.orbitEnabled = projection.orbitEnabled;
    }
    try {
      releaseOwnedCapture(this.owner, owned);
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length === 1) throw cleanupErrors[0];
    if (cleanupErrors.length > 1) {
      throw new AggregateError(cleanupErrors, "Harness gesture cleanup failed");
    }
  }
}

function harnessGesture(
  name: string,
  pointerId: number,
  target: FakePointerCaptureTarget,
  kind: HarnessGestureKind,
): HarnessGesture {
  return {
    name,
    pointerId,
    target,
    kind,
    activated: false,
    orbitEnabledBefore: false,
    onExactCleanup: null,
  };
}

function runOwnedEffects<Value>(
  owner: LatestPointerGestureOwner<Value>,
  gesture: OwnedPointerGesture<Value>,
  effects: ReadonlyArray<() => void>,
): void {
  for (const effect of effects) {
    if (!owner.isCurrent(gesture)) return;
    effect();
    if (!owner.isCurrent(gesture)) return;
  }
}

function releaseOwnedCapture<Value extends {
  readonly pointerId: number;
  readonly target: FakePointerCaptureTarget;
}>(
  owner: LatestPointerGestureOwner<Value>,
  gesture: OwnedPointerGesture<Value>,
): void {
  if (!owner.takeCapture(gesture)) return;
  gesture.value.target.releasePointerCapture(gesture.value.pointerId);
}

/** Executable model of the runtime's generation-less pointer-capture adapter. */
class PointerCaptureTransactionHarness {
  readonly owner = new LatestPointerGestureOwner<GestureValue>();
  readonly gate = new ReentrantHostMutationGate();
  readonly target = new FakePointerCaptureTarget();

  publish(name: string, pointerId: number): OwnedPointerGesture<GestureValue> {
    const replacement = this.owner.begin({ name, pointerId, target: this.target });
    if (replacement.previous) {
      const phase = this.owner.takeCapturePhase(replacement.previous);
      if (phase === "installed") {
        this.gate.run(
          () => this.target.releasePointerCapture(replacement.previous!.value.pointerId),
          () => this.flush(),
        );
      }
    }
    if (!this.owner.reserveCapture(replacement.current)) {
      throw new Error(`Could not reserve capture for ${name}`);
    }
    return replacement.current;
  }

  request(owned: OwnedPointerGesture<GestureValue>): void {
    if (this.owner.capturePhaseOf(owned) === "installed") return;
    if (this.gate.isInsideHostMutation) {
      this.gate.deferUntilIdle();
      return;
    }
    if (!this.owner.beginCaptureInstall(owned)) return;
    try {
      this.gate.run(
        () => installReentrantSessionResource({
          authority: { isCurrent: () => this.owner.isCurrent(owned) },
          mark: () => {},
          install: () => {
            this.target.setPointerCapture(owned.value.pointerId);
            this.owner.markCaptureInstalled(owned);
          },
          cleanupLate: (cause) => this.cleanupLate(owned, cause),
        }),
        () => this.flush(),
      );
    } catch (error) {
      if (!this.owner.isCurrent(owned)) throw error;
      this.owner.markCaptureInstalled(owned);
      this.owner.takeCapturePhase(owned);
      try {
        this.gate.run(
          () => this.target.releasePointerCapture(owned.value.pointerId),
          () => this.flush(),
        );
      } catch (releaseError) {
        let retryOwned = false;
        if (this.owner.isCurrent(owned) && !this.owner.capture) {
          retryOwned = (
            this.owner.reserveCapture(owned)
            && this.owner.markCaptureInstalled(owned)
          );
        }
        if (!retryOwned) {
          throw new AggregateError([error, releaseError]);
        }
      }
    }
  }

  private cleanupLate(
    retired: OwnedPointerGesture<GestureValue>,
    cause: SessionLateCleanupCause,
  ): void {
    const successor = this.owner.capture;
    if (
      cause === "returned"
      && successor
      && successor !== retired
      && this.owner.isCurrent(successor)
      && samePointerCaptureIdentity(
        {
          pointerId: retired.value.pointerId,
          captureTarget: retired.value.target,
        },
        {
          pointerId: successor.value.pointerId,
          captureTarget: successor.value.target,
        },
      )
    ) {
      this.owner.markCaptureInstalled(successor);
      return;
    }
    this.gate.run(
      () => this.target.releasePointerCapture(retired.value.pointerId),
      () => this.flush(),
    );
  }

  private flush(): void {
    const current = this.owner.capture;
    if (current && this.owner.isCurrent(current)) this.request(current);
  }
}

describe("LatestPointerGestureOwner", () => {
  it("tracks reserved, installing, and installed capture obligations exactly", () => {
    const owner = new LatestPointerGestureOwner<{ readonly name: string }>();
    const first = owner.begin({ name: "A" }).current;

    expect(owner.reserveCapture(first)).toBe(true);
    expect(owner.capturePhaseOf(first)).toBe("reserved");
    expect(owner.beginCaptureInstall(first)).toBe(true);
    expect(owner.capturePhaseOf(first)).toBe("installing");
    expect(owner.markCaptureInstalled(first)).toBe(true);
    expect(owner.capturePhaseOf(first)).toBe("installed");
    expect(owner.takeCapturePhase(first)).toBe("installed");
    expect(owner.capture).toBeNull();
    expect(owner.takeCapturePhase(first)).toBeNull();
  });

  it("keeps predecessor errors first and flattens candidate rollback failures", () => {
    const owner = new LatestPointerGestureOwner<{ readonly name: string }>();
    owner.begin({ name: "A" });
    const replacement = owner.begin({ name: "B" });
    let thrown: unknown;

    try {
      cleanupReplacedPointerGestureOrRollback(
        owner,
        replacement,
        (owned) => {
          if (owned.value.name === "A") {
            throw new AggregateError([new Error("A-1"), new Error("A-2")]);
          }
          throw new Error("B-rollback");
        },
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).errors.map((error) => (error as Error).message))
      .toEqual(["A-1", "A-2", "B-rollback"]);
    expect(owner.current).toBeNull();
  });

  it("does not release a reserved deferred capture stopped before host install", () => {
    const owner = new LatestPointerGestureOwner<{ readonly name: string }>();
    const gate = new ReentrantHostMutationGate();
    let hostSets = 0;
    let hostReleases = 0;

    gate.run(
      () => {
        const successor = owner.begin({ name: "C" }).current;
        expect(owner.reserveCapture(successor)).toBe(true);
        expect(gate.isInsideHostMutation).toBe(true);
        gate.deferUntilIdle();

        expect(owner.finish(successor)).not.toBeNull();
        const phase = owner.takeCapturePhase(successor);
        if (phase === "installed") hostReleases += 1;
      },
      () => {
        const current = owner.capture;
        if (current && owner.beginCaptureInstall(current)) hostSets += 1;
      },
    );

    expect(hostSets).toBe(0);
    expect(hostReleases).toBe(0);
    expect(owner.current).toBeNull();
    expect(owner.capture).toBeNull();
  });

  it("releases exactly once when an installing capture returns after stop", () => {
    const owner = new LatestPointerGestureOwner<{ readonly name: string }>();
    const first = owner.begin({ name: "A" }).current;
    expect(owner.reserveCapture(first)).toBe(true);
    expect(owner.beginCaptureInstall(first)).toBe(true);
    let attached = false;
    let releases = 0;

    expect(installReentrantSessionResource({
      authority: { isCurrent: () => owner.isCurrent(first) },
      mark: () => {},
      install: () => {
        expect(owner.finish(first)).not.toBeNull();
        // Exact stop sees an in-flight transaction and leaves compensation to
        // the transaction's returned-late path.
        expect(owner.takeCapturePhase(first)).toBe("installing");
        attached = true;
        owner.markCaptureInstalled(first);
      },
      cleanupLate: () => {
        if (attached) {
          attached = false;
          releases += 1;
        }
      },
    })).toBe("superseded");

    expect(attached).toBe(false);
    expect(releases).toBe(1);
    expect(owner.capture).toBeNull();
  });

  it("adopts a same-identity successor only after a returned-late install", () => {
    const harness = new PointerCaptureTransactionHarness();
    const first = harness.publish("A", 7);
    let successor: OwnedPointerGesture<GestureValue> | null = null;
    harness.target.onSet = () => {
      harness.target.onSet = null;
      successor = harness.publish("C", 7);
      harness.request(successor);
    };

    harness.request(first);

    expect(successor).not.toBeNull();
    expect(harness.owner.current).toBe(successor);
    expect(harness.owner.capturePhaseOf(successor!)).toBe("installed");
    expect(harness.target.sets).toEqual([7]);
    expect(harness.target.hasPointerCapture(7)).toBe(true);
  });

  it("does not adopt a same-identity successor after a threw-late install", () => {
    const harness = new PointerCaptureTransactionHarness();
    const first = harness.publish("A", 7);
    const installError = new Error("A set before commit");
    let successor: OwnedPointerGesture<GestureValue> | null = null;
    harness.target.onSet = () => {
      harness.target.onSet = null;
      successor = harness.publish("C", 7);
      harness.request(successor);
      throw installError;
    };

    expect(() => harness.request(first)).toThrow(installError);

    expect(successor).not.toBeNull();
    expect(harness.owner.current).toBe(successor);
    expect(harness.owner.capturePhaseOf(successor!)).toBe("installed");
    // A's throwing host call never committed; C therefore receives its own set.
    expect(harness.target.sets).toEqual([7, 7]);
    expect(harness.target.releases).toEqual([7]);
    expect(harness.target.hasPointerCapture(7)).toBe(true);
  });

  it("ignores A's lost event while same-identity C is only deferred", () => {
    const harness = new PointerCaptureTransactionHarness();
    const first = harness.publish("A", 7);
    harness.request(first);
    const replacement = harness.owner.begin({
      name: "B",
      pointerId: 7,
      target: harness.target,
    });
    expect(harness.owner.takeCapturePhase(first)).toBe("installed");
    let successor: OwnedPointerGesture<GestureValue> | null = null;

    harness.target.onRelease = () => {
      harness.target.onRelease = null;
      successor = harness.publish("C", 7);
      harness.request(successor);
      const capture = harness.owner.capture;
      // This is the runtime lostpointercapture gate: an old loss may resolve
      // only a current physical capture, never a reserved/deferred request.
      if (
        capture
        && harness.owner.capturePhaseOf(capture) === "installed"
        && !harness.target.hasPointerCapture(capture.value.pointerId)
      ) harness.owner.finish(capture);
    };
    harness.gate.run(
      () => harness.target.releasePointerCapture(first.value.pointerId),
      () => {
        const capture = harness.owner.capture;
        if (capture && harness.owner.isCurrent(capture)) harness.request(capture);
      },
    );

    expect(replacement.current.value.name).toBe("B");
    expect(successor).not.toBeNull();
    expect(harness.owner.current).toBe(successor);
    expect(harness.owner.capturePhaseOf(successor!)).toBe("installed");
    expect(harness.target.sets).toEqual([7, 7]);
    expect(harness.target.hasPointerCapture(7)).toBe(true);
  });

  it("takes a failed current set before compensation release re-enters C", () => {
    const harness = new PointerCaptureTransactionHarness();
    const first = harness.publish("A", 7);
    const setError = new Error("unsupported after partial set");
    let successor: OwnedPointerGesture<GestureValue> | null = null;
    harness.target.onSet = () => {
      harness.target.onSet = null;
      throw setError;
    };
    harness.target.onRelease = () => {
      harness.target.onRelease = null;
      successor = harness.publish("C", 7);
      harness.request(successor);
    };

    harness.request(first);

    expect(successor).not.toBeNull();
    expect(harness.owner.current).toBe(successor);
    expect(harness.owner.capturePhaseOf(successor!)).toBe("installed");
    expect(harness.target.sets).toEqual([7, 7]);
    expect(harness.target.releases).toEqual([7]);
    expect(harness.target.hasPointerCapture(7)).toBe(true);
  });

  it("reports set then stale release errors while preserving reentrant C", () => {
    const harness = new PointerCaptureTransactionHarness();
    const first = harness.publish("A", 7);
    const setError = new Error("A set");
    const releaseError = new Error("A release before commit");
    let successor: OwnedPointerGesture<GestureValue> | null = null;
    harness.target.onSet = () => {
      harness.target.onSet = null;
      throw setError;
    };
    harness.target.onRelease = () => {
      harness.target.onRelease = null;
      successor = harness.publish("C", 8);
      harness.request(successor);
      throw releaseError;
    };

    let thrown: unknown;
    try {
      harness.request(first);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).errors).toEqual([setError, releaseError]);
    expect(successor).not.toBeNull();
    expect(harness.owner.current).toBe(successor);
    expect(harness.owner.capturePhaseOf(successor!)).toBe("installed");
    expect(harness.target.sets).toEqual([7, 8]);
    expect(harness.target.releases).toEqual([7]);
    expect(harness.target.hasPointerCapture(8)).toBe(true);
  });

  it("recognizes the physical capture identity a successor can adopt", () => {
    const target = new FakePointerCaptureTarget();
    const otherTarget = new FakePointerCaptureTarget();

    expect(samePointerCaptureIdentity(
      { pointerId: 7, captureTarget: target },
      { pointerId: 7, captureTarget: target },
    )).toBe(true);
    expect(samePointerCaptureIdentity(
      { pointerId: 7, captureTarget: target },
      { pointerId: 8, captureTarget: target },
    )).toBe(false);
    expect(samePointerCaptureIdentity(
      { pointerId: 7, captureTarget: target },
      { pointerId: 7, captureTarget: otherTarget },
    )).toBe(false);
  });

  it("matches direct and disconnected owner-document capture loss targets", () => {
    const target = new FakePointerCaptureTarget();
    const capture = { pointerId: 4, captureTarget: target };

    expect(matchesOwnedPointerCaptureLoss(capture, {
      pointerId: 4,
      target,
    })).toBe(true);
    expect(matchesOwnedPointerCaptureLoss(capture, {
      pointerId: 4,
      target: target.ownerDocument,
    })).toBe(false);

    target.isConnected = false;
    expect(matchesOwnedPointerCaptureLoss(capture, {
      pointerId: 4,
      target: target.ownerDocument,
    })).toBe(true);
    expect(matchesOwnedPointerCaptureLoss(capture, {
      pointerId: 5,
      target: target.ownerDocument,
    })).toBe(false);
    expect(matchesOwnedPointerCaptureLoss(capture, {
      pointerId: 4,
      target: {},
    })).toBe(false);
  });

  it("publishes a successor before releasing the predecessor capture", () => {
    const owner = new LatestPointerGestureOwner<GestureValue>();
    const target = new FakePointerCaptureTarget();
    const first = owner.begin({ name: "first", pointerId: 1, target }).current;
    expect(owner.reserveCapture(first)).toBe(true);
    const replacement = owner.begin({ name: "second", pointerId: 2, target });
    const observed: string[] = [];
    target.onRelease = () => {
      observed.push(owner.current?.value.name ?? "none");
    };

    releaseOwnedCapture(owner, first);

    expect(observed).toEqual(["second"]);
    expect(owner.current).toBe(replacement.current);
    expect(owner.capture).toBeNull();
  });

  it("does not let an old lost-capture event resolve a successor", () => {
    const owner = new LatestPointerGestureOwner<GestureValue>();
    const target = new FakePointerCaptureTarget();
    const first = owner.begin({ name: "first", pointerId: 7, target }).current;
    expect(owner.reserveCapture(first)).toBe(true);
    const second = owner.begin({ name: "second", pointerId: 7, target }).current;
    const lostGestures: string[] = [];
    target.onRelease = () => {
      const captured = owner.capture;
      if (
        captured
        && matchesOwnedPointerCaptureLoss(
          {
            pointerId: captured.value.pointerId,
            captureTarget: captured.value.target,
          },
          { pointerId: 7, target },
        )
      ) {
        lostGestures.push(captured.value.name);
        owner.finish(captured);
      }
    };

    // B cannot steal A's capture. Cleanup first takes the exact owner, so the
    // synchronous loss callback in this adversarial test has no record to
    // resolve even though B reuses the same pointer id and target.
    expect(owner.reserveCapture(second)).toBe(false);
    releaseOwnedCapture(owner, first);
    expect(owner.capture).toBeNull();
    expect(lostGestures).toEqual([]);
    expect(owner.current).toBe(second);
    expect(owner.finish(first)).toBeNull();
    expect(owner.current).toBe(second);
    expect(owner.reserveCapture(second)).toBe(true);
    expect(owner.capture).toBe(second);
  });

  it("invalidates old shared cleanup when a foreign effect starts a third gesture", () => {
    const owner = new LatestPointerGestureOwner<GestureValue>();
    const target = new FakePointerCaptureTarget();
    const first = owner.begin({ name: "first", pointerId: 1, target }).current;
    expect(owner.reserveCapture(first)).toBe(true);
    const second = owner.begin({ name: "second", pointerId: 2, target });
    const sharedEffects: string[] = [];
    const runIfCurrent = (
      handoff: PointerGestureTransition<GestureValue>,
      effect: () => void,
    ): void => {
      if (!owner.isTransitionCurrent(handoff)) return;
      effect();
    };
    runIfCurrent(second.handoff, () => {
      sharedEffects.push("old-tag-css");
      owner.begin({ name: "third", pointerId: 3, target });
    });
    runIfCurrent(second.handoff, () => sharedEffects.push("old-stage-css"));
    runIfCurrent(second.handoff, () => sharedEffects.push("old-orbit"));
    releaseOwnedCapture(owner, first);

    expect(sharedEffects).toEqual(["old-tag-css"]);
    expect(owner.current?.value.name).toBe("third");
    expect(target.releases).toEqual([1]);
  });

  it("takes a finished gesture before its release callback creates a successor", () => {
    const owner = new LatestPointerGestureOwner<GestureValue>();
    const target = new FakePointerCaptureTarget();
    const first = owner.begin({ name: "first", pointerId: 1, target }).current;
    expect(owner.reserveCapture(first)).toBe(true);
    const terminal = owner.finish(first);
    target.onRelease = () => {
      owner.begin({ name: "successor", pointerId: 2, target });
    };

    releaseOwnedCapture(owner, first);

    expect(terminal).not.toBeNull();
    expect(owner.isTransitionCurrent(terminal!)).toBe(false);
    expect(owner.current?.value.name).toBe("successor");
    expect(target.releases).toEqual([1]);
    releaseOwnedCapture(owner, first);
    expect(target.releases).toEqual([1]);
  });

  it("restores the root projection when nested C cancels during A cleanup", () => {
    const harness = new PointerGestureProjectionHarness();
    const target = new FakePointerCaptureTarget();
    const first = harness.begin(harnessGesture("A", 1, target, "track"))!;
    let nested: OwnedPointerGesture<HarnessGesture> | null | undefined;
    first.value.onExactCleanup = () => {
      nested = harness.begin(harnessGesture("C", 3, target, "card"));
    };

    const replacement = harness.begin(harnessGesture("B", 2, target, "track"));

    expect(replacement).toBeNull();
    expect(nested).toBeNull();
    expect(harness.owner.current).toBeNull();
    expect(harness.owner.capture).toBeNull();
    expect(harness.stageDragging).toBe(false);
    expect(harness.orbitEnabled).toBe(true);
    expect(target.releases).toEqual([1]);
  });

  it("keeps a successful nested C projection until C terminates", () => {
    const harness = new PointerGestureProjectionHarness();
    const target = new FakePointerCaptureTarget();
    // A's platform capture request failed, so the window-listener fallback is
    // active and nested C can acquire the otherwise identical capture target.
    const first = harness.begin(
      harnessGesture("A", 1, target, "track"),
      { capture: false },
    )!;
    let nested: OwnedPointerGesture<HarnessGesture> | null = null;
    first.value.onExactCleanup = () => {
      nested = harness.begin(harnessGesture("C", 3, target, "track"));
    };

    expect(harness.begin(harnessGesture("B", 2, target, "card"))).toBeNull();
    expect(nested).not.toBeNull();
    expect(harness.owner.current).toBe(nested);
    expect(harness.stageDragging).toBe(true);
    expect(harness.orbitEnabled).toBe(false);

    harness.finish(nested!);

    expect(harness.owner.current).toBeNull();
    expect(harness.stageDragging).toBe(false);
    expect(harness.orbitEnabled).toBe(true);
    expect(target.releases).toEqual([3]);
  });

  it("rolls back B when A cleanup throws after B is published", () => {
    const harness = new PointerGestureProjectionHarness();
    const target = new FakePointerCaptureTarget();
    const first = harness.begin(harnessGesture("A", 1, target, "track"))!;
    const cleanupError = new Error("A cleanup");
    first.value.onExactCleanup = () => { throw cleanupError; };

    expect(() => harness.begin(
      harnessGesture("B", 2, target, "card"),
    )).toThrow(cleanupError);
    expect(harness.owner.current).toBeNull();
    expect(harness.owner.capture).toBeNull();
    expect(harness.stageDragging).toBe(false);
    expect(harness.orbitEnabled).toBe(true);
    expect(target.releases).toEqual([1]);
  });

  it("does not roll B back over D when A cleanup re-enters D and then throws", () => {
    const harness = new PointerGestureProjectionHarness();
    const target = new FakePointerCaptureTarget();
    const first = harness.begin(harnessGesture("A", 1, target, "track"))!;
    const cleanupError = new Error("A cleanup after D");
    let nested: OwnedPointerGesture<HarnessGesture> | null = null;
    target.onRelease = () => {
      target.onRelease = null;
      nested = harness.begin(harnessGesture("D", 4, target, "track"));
      throw cleanupError;
    };

    expect(() => harness.begin(
      harnessGesture("B", 2, target, "card"),
    )).toThrow(cleanupError);
    expect(nested).not.toBeNull();
    expect(harness.owner.current).toBe(nested);
    expect(harness.owner.capture).toBe(nested);
    expect(harness.stageDragging).toBe(true);
    expect(harness.orbitEnabled).toBe(false);

    harness.finish(nested!);
    expect(harness.owner.current).toBeNull();
    expect(harness.owner.capture).toBeNull();
    expect(harness.orbitEnabled).toBe(true);
  });

  it("stops tag-position writes after the first DOM effect replaces A", () => {
    const owner = new LatestPointerGestureOwner<{ readonly name: string }>();
    const first = owner.begin({ name: "A" }).current;
    const effects: string[] = [];

    runOwnedEffects(owner, first, [
      () => {
        effects.push("remove-A-class");
        owner.begin({ name: "B" });
      },
      () => effects.push("write-B-position-from-A"),
    ]);

    expect(effects).toEqual(["remove-A-class"]);
    expect(owner.current?.value.name).toBe("B");
  });
});
