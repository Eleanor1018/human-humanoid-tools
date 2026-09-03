export interface OwnedPointerGesture<Value> {
  readonly generation: number;
  readonly value: Value;
}

export interface PointerGestureTransition<Value> {
  readonly generation: number;
  readonly current: OwnedPointerGesture<Value> | null;
  readonly session: PointerGestureSession | null;
}

export interface PointerGestureReplacement<Value> {
  readonly current: OwnedPointerGesture<Value>;
  readonly previous: OwnedPointerGesture<Value> | null;
  readonly handoff: PointerGestureTransition<Value>;
}

export interface PointerGestureSession {
  readonly generation: number;
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
  #capture: OwnedPointerGesture<Value> | null = null;
  #sessionGeneration = 0;
  #session: PointerGestureSession | null = null;

  get current(): OwnedPointerGesture<Value> | null {
    return this.#current;
  }

  get capture(): OwnedPointerGesture<Value> | null {
    return this.#capture;
  }

  /** Exact session token captured by newly installed event owners. */
  get currentSession(): PointerGestureSession | null {
    return this.#session;
  }

  /** Start an exact manipulator session/stop operation ownership boundary. */
  beginSession(): PointerGestureSession {
    const session = Object.freeze({ generation: ++this.#sessionGeneration });
    this.#session = session;
    return session;
  }

  isSessionCurrent(session: PointerGestureSession): boolean {
    return (
      this.#session === session
      && this.#sessionGeneration === session.generation
    );
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
        session: this.#session,
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
      session: this.#session,
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
      && this.#session === handoff.session
    );
  }

  reserveCapture(gesture: OwnedPointerGesture<Value>): boolean {
    if (
      !this.isCurrent(gesture)
      || (this.#capture !== null && this.#capture !== gesture)
    ) return false;
    this.#capture = gesture;
    return true;
  }

  takeCapture(gesture: OwnedPointerGesture<Value>): boolean {
    if (this.#capture !== gesture) return false;
    this.#capture = null;
    return true;
  }
}
