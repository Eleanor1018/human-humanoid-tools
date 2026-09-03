export interface OwnedPointerGesture<Value> {
  readonly generation: number;
  readonly value: Value;
}

export interface PointerGestureTransition<Value> {
  readonly generation: number;
  readonly current: OwnedPointerGesture<Value> | null;
}

export interface PointerGestureReplacement<Value> {
  readonly current: OwnedPointerGesture<Value>;
  readonly previous: OwnedPointerGesture<Value> | null;
  readonly handoff: PointerGestureTransition<Value>;
}

export type PointerCapturePhase = "reserved" | "installing" | "installed";

interface PointerCaptureOwnership<Value> {
  readonly gesture: OwnedPointerGesture<Value>;
  phase: PointerCapturePhase;
}

function appendPointerCleanupError(errors: unknown[], error: unknown): void {
  if (error instanceof AggregateError) {
    for (const nested of error.errors) appendPointerCleanupError(errors, nested);
    return;
  }
  errors.push(error);
}

/**
 * Retire the predecessor of a just-published gesture transactionally.
 *
 * A predecessor host cleanup may fail after the successor has already become
 * current. Roll that exact successor back so callers never observe a current
 * but half-initialized gesture. If cleanup re-entered and published generation
 * D, `finish(current)` is stale and deliberately leaves D untouched.
 */
export function cleanupReplacedPointerGestureOrRollback<Value>(
  owner: LatestPointerGestureOwner<Value>,
  replacement: PointerGestureReplacement<Value>,
  cleanup: (
    gesture: OwnedPointerGesture<Value>,
    handoff: PointerGestureTransition<Value>,
  ) => void,
): void {
  if (!replacement.previous) return;
  try {
    cleanup(replacement.previous, replacement.handoff);
  } catch (primaryError) {
    const rollback = owner.finish(replacement.current);
    if (!rollback) throw primaryError;
    try {
      cleanup(replacement.current, rollback);
    } catch (rollbackError) {
      const errors: unknown[] = [];
      appendPointerCleanupError(errors, primaryError);
      appendPointerCleanupError(errors, rollbackError);
      throw new AggregateError(
        errors,
        "Pointer gesture predecessor cleanup and successor rollback failed",
      );
    }
    throw primaryError;
  }
}

export interface PointerCaptureTargetIdentity {
  readonly isConnected: boolean;
  readonly ownerDocument: unknown;
}

export interface OwnedPointerCaptureIdentity {
  readonly pointerId: number;
  readonly captureTarget: PointerCaptureTargetIdentity;
}

export interface PointerCaptureLossIdentity {
  readonly pointerId: number;
  readonly target: unknown;
}

/** Browser pointer capture has no generation beyond this physical identity. */
export function samePointerCaptureIdentity(
  left: OwnedPointerCaptureIdentity,
  right: OwnedPointerCaptureIdentity,
): boolean {
  return (
    left.pointerId === right.pointerId
    && left.captureTarget === right.captureTarget
  );
}

export interface PointerGestureOrbitLineage {
  readonly orbitEnabledBefore: boolean;
}

export interface PointerGestureSharedProjectionInput {
  readonly activated: boolean;
  readonly stageDragging: boolean;
}

export interface PointerGestureSharedProjection {
  readonly orbitEnabled: boolean;
  readonly stageDragging: boolean;
}

/** Match the two Pointer Events targets allowed after capture target removal. */
export function matchesOwnedPointerCaptureLoss(
  capture: OwnedPointerCaptureIdentity,
  event: PointerCaptureLossIdentity,
): boolean {
  return (
    event.pointerId === capture.pointerId
    && (
      event.target === capture.captureTarget
      || (
        !capture.captureTarget.isConnected
        && event.target === capture.captureTarget.ownerDocument
      )
    )
  );
}

/** Carry the root orbit state across even not-yet-activated replacements. */
export function inheritedPointerGestureOrbitBaseline(
  previous: PointerGestureOrbitLineage | null,
  currentOrbitEnabled: boolean,
): boolean {
  return previous?.orbitEnabledBefore ?? currentOrbitEnabled;
}

/** Project shared drag state from the exact successor, or restore the lineage. */
export function projectPointerGestureSharedState(
  current: PointerGestureSharedProjectionInput | null,
  orbitEnabledBefore: boolean,
): PointerGestureSharedProjection {
  const activated = current?.activated === true;
  return Object.freeze({
    orbitEnabled: activated ? false : orbitEnabledBefore,
    stageDragging: Boolean(current?.activated && current.stageDragging),
  });
}

/**
 * Owns the exact current pointer gesture and its independently tracked capture.
 *
 * Replacement publishes the successor before callers release the predecessor.
 * A cleanup callback can therefore re-enter begin/finish safely: its handoff
 * stops being current, while the old capture can still be taken exactly once.
 */
export class LatestPointerGestureOwner<Value> {
  #generation = 0;
  #current: OwnedPointerGesture<Value> | null = null;
  #capture: PointerCaptureOwnership<Value> | null = null;

  get current(): OwnedPointerGesture<Value> | null {
    return this.#current;
  }

  get capture(): OwnedPointerGesture<Value> | null {
    return this.#capture?.gesture ?? null;
  }

  begin(value: Value): PointerGestureReplacement<Value> {
    const previous = this.#current;
    const current: OwnedPointerGesture<Value> = Object.freeze({
      generation: ++this.#generation,
      value,
    });
    this.#current = current;
    return {
      current,
      previous,
      handoff: Object.freeze({
        generation: current.generation,
        current,
      }),
    };
  }

  finish(
    gesture: OwnedPointerGesture<Value>,
  ): PointerGestureTransition<Value> | null {
    if (!this.isCurrent(gesture)) return null;
    const generation = ++this.#generation;
    this.#current = null;
    return Object.freeze({
      generation,
      current: null,
    });
  }

  isCurrent(gesture: OwnedPointerGesture<Value>): boolean {
    return (
      this.#current === gesture
      && this.#generation === gesture.generation
    );
  }

  isTransitionCurrent(handoff: PointerGestureTransition<Value>): boolean {
    return (
      this.#generation === handoff.generation
      && this.#current === handoff.current
    );
  }

  reserveCapture(gesture: OwnedPointerGesture<Value>): boolean {
    if (
      !this.isCurrent(gesture)
      || (this.#capture !== null && this.#capture.gesture !== gesture)
    ) return false;
    this.#capture ??= { gesture, phase: "reserved" };
    return true;
  }

  capturePhaseOf(gesture: OwnedPointerGesture<Value>): PointerCapturePhase | null {
    return this.#capture?.gesture === gesture ? this.#capture.phase : null;
  }

  /** Mark the exact slot before invoking the generation-less host API. */
  beginCaptureInstall(gesture: OwnedPointerGesture<Value>): boolean {
    if (this.#capture?.gesture !== gesture || this.#capture.phase !== "reserved") {
      return false;
    }
    this.#capture.phase = "installing";
    return true;
  }

  /** Commit a returned install, or let an identical successor adopt it. */
  markCaptureInstalled(gesture: OwnedPointerGesture<Value>): boolean {
    if (this.#capture?.gesture !== gesture) return false;
    this.#capture.phase = "installed";
    return true;
  }

  takeCapturePhase(gesture: OwnedPointerGesture<Value>): PointerCapturePhase | null {
    if (this.#capture?.gesture !== gesture) return null;
    const phase = this.#capture.phase;
    this.#capture = null;
    return phase;
  }

  takeCapture(gesture: OwnedPointerGesture<Value>): boolean {
    return this.takeCapturePhase(gesture) !== null;
  }
}
