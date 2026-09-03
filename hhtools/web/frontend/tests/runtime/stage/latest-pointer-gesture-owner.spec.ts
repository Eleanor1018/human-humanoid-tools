import { describe, expect, it } from "vitest";

import {
  inheritedPointerGestureOrbitBaseline,
  LatestPointerGestureOwner,
  matchesOwnedPointerCaptureLoss,
  projectPointerGestureSharedState,
  type OwnedPointerGesture,
  type PointerGestureTransition,
} from "../../../src/runtime/stage/latest-pointer-gesture-owner";

interface GestureValue {
  readonly name: string;
  readonly pointerId: number;
  readonly target: FakePointerCaptureTarget;
}

class FakePointerCaptureTarget {
  readonly releases: number[] = [];
  readonly ownerDocument = {};
  isConnected = true;
  onRelease: (() => void) | null = null;

  releasePointerCapture(pointerId: number): void {
    this.releases.push(pointerId);
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
    if (replacement.previous) {
      this.cleanup(replacement.previous, replacement.handoff);
    }
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
    const gesture = owned.value;
    const wasActivated = gesture.activated;
    gesture.activated = false;
    if (wasActivated && this.owner.isTransitionCurrent(handoff)) {
      const cleanup = gesture.onExactCleanup;
      gesture.onExactCleanup = null;
      cleanup?.();
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
    releaseOwnedCapture(this.owner, owned);
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

describe("LatestPointerGestureOwner", () => {
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

  it("invalidates gesture cleanup when foreign code only replaces the session", () => {
    const owner = new LatestPointerGestureOwner<GestureValue>();
    const target = new FakePointerCaptureTarget();
    owner.beginSession();
    const gesture = owner.begin({ name: "first", pointerId: 1, target }).current;
    const handoff = owner.finish(gesture)!;
    const sharedEffects: string[] = [];

    if (owner.isTransitionCurrent(handoff)) {
      sharedEffects.push("old-card-css");
      owner.beginSession();
    }
    if (owner.isTransitionCurrent(handoff)) sharedEffects.push("old-orbit");

    expect(sharedEffects).toEqual(["old-card-css"]);
  });

  it("rejects a stale same-context event owner before it can replace B", () => {
    const owner = new LatestPointerGestureOwner<{ readonly name: string }>();
    const sharedContext = {};
    const firstSession = owner.beginSession();
    const capturedListener = {
      context: sharedContext,
      session: owner.currentSession,
    };
    expect(capturedListener.session).toBe(firstSession);

    const secondSession = owner.beginSession();
    const second = owner.begin({ name: "B" }).current;
    const currentContext = sharedContext;
    const active = true;
    const listenerIsCurrent = (): boolean => (
      active
      && currentContext === capturedListener.context
      && capturedListener.session !== null
      && owner.isSessionCurrent(capturedListener.session)
    );

    // Context identity alone is intentionally unchanged. The exact session is
    // what prevents the detached A listener from publishing over B.
    let stalePublished = false;
    if (listenerIsCurrent()) {
      owner.begin({ name: "stale-A" });
      stalePublished = true;
    }

    expect(secondSession).not.toBe(firstSession);
    expect(stalePublished).toBe(false);
    expect(owner.current).toBe(second);
    expect(owner.currentSession).toBe(secondSession);
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

  it("invalidates a stop session when capture release starts a successor", () => {
    const owner = new LatestPointerGestureOwner<GestureValue>();
    const target = new FakePointerCaptureTarget();
    owner.beginSession();
    const gesture = owner.begin({ name: "first", pointerId: 1, target }).current;
    expect(owner.reserveCapture(gesture)).toBe(true);
    const stopping = owner.beginSession();
    expect(owner.finish(gesture)).not.toBeNull();
    target.onRelease = () => {
      owner.beginSession();
      owner.begin({ name: "successor", pointerId: 2, target });
    };

    releaseOwnedCapture(owner, gesture);

    let oldStopClearedSuccessor = false;
    if (owner.isSessionCurrent(stopping)) oldStopClearedSuccessor = true;
    expect(oldStopClearedSuccessor).toBe(false);
    expect(owner.current?.value.name).toBe("successor");
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

  it("stops selected-row effects when the captured context starts B", () => {
    const owner = new LatestPointerGestureOwner<{ readonly name: string }>();
    owner.beginSession();
    const first = owner.begin({ name: "A" }).current;
    const effects: string[] = [];

    runOwnedEffects(owner, first, [
      () => {
        effects.push("read-A-context");
        owner.beginSession();
        owner.begin({ name: "B" });
      },
      () => effects.push("write-B-row-from-A"),
    ]);

    expect(effects).toEqual(["read-A-context"]);
    expect(owner.current?.value.name).toBe("B");
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
