import {
  LatestSessionOwner,
  type OwnedSession,
  type SessionHandoff,
  type SessionReplacement,
} from "./latest-session-owner";

export type OwnedPresentationOperation<Value> = OwnedSession<Value>;
export type PresentationPublication<Value> = SessionReplacement<Value>;

export type PresentationReconcileDisposition =
  | "applied"
  | "deferred"
  | "unchanged";

export interface PresentationProjectionAuthority {
  /** False as soon as a newer presentation or the neutral target is published. */
  isCurrent(): boolean;
}

/**
 * Applies one complete shared-surface target.
 *
 * `target.current === null` is an explicit neutral projection after withdrawal,
 * not the absence of work. Projectors should cover the whole shared ownership
 * domain so a successor can repair every late Stage, Orbit, and Robot write.
 */
export type PresentationProjector<Value> = (
  target: SessionHandoff<Value>,
  authority: PresentationProjectionAuthority,
) => undefined;

function appendPresentationError(errors: unknown[], error: unknown): void {
  if (error instanceof AggregateError && error.errors.length > 0) {
    for (const nested of error.errors) {
      appendPresentationError(errors, nested);
    }
    return;
  }
  errors.push(error);
}

/**
 * Serializes latest-wins projection onto one physical shared surface.
 *
 * Publication is callback-free: callers can first publish their exact alias
 * and only then cross a reentrant DOM/Three.js boundary through `reconcile`.
 * If projection A synchronously publishes C, C is not projected inside A's
 * host frame. The outer drain waits for A (including any late host commit) to
 * return, then replays the complete latest target C from the beginning.
 *
 * This owner is intentionally synchronous. A projector must not start
 * fire-and-forget work; asynchronous completion needs its own exact owner.
 */
export class LatestPresentationOperationCoordinator<Value> {
  static readonly MAX_RECONCILE_PASSES = 64;

  readonly #owner = new LatestSessionOwner<Value>();
  readonly #project: PresentationProjector<Value>;

  #desired: SessionHandoff<Value> | null = null;
  #appliedGeneration = 0;
  #reconciling = false;

  constructor({
    project,
  }: {
    readonly project: PresentationProjector<Value>;
  }) {
    this.#project = project;
  }

  get current(): OwnedPresentationOperation<Value> | null {
    return this.#owner.current;
  }

  /**
   * Publish a new complete intent without invoking the projector.
   *
   * `value` must be an immutable, complete snapshot. The coordinator preserves
   * its identity rather than reading mutable globals or freezing an arbitrary
   * caller object, because either would make publication observably impure.
   */
  publish(value: Value): PresentationPublication<Value> {
    const publication = this.#owner.begin(value);
    this.#desired = publication.handoff;
    return publication;
  }

  /**
   * Publish the neutral target only when `operation` is still the exact owner.
   * Stale and repeated withdrawals are callback-free no-ops.
   */
  withdraw(
    operation: OwnedPresentationOperation<Value>,
  ): SessionHandoff<Value> | null {
    const handoff = this.#owner.finish(operation);
    if (handoff) this.#desired = handoff;
    return handoff;
  }

  isCurrent(operation: OwnedPresentationOperation<Value>): boolean {
    return this.#owner.isCurrent(operation);
  }

  /**
   * Project until the latest published target is stable.
   *
   * A reentrant call only reports `deferred`; the outermost call observes the
   * new generation and drains it after the current host frame returns. A
   * failure of a stale target never prevents its successor from being applied.
   * A failure of the still-current target is left pending for an explicit
   * retry, avoiding an unbounded immediate retry loop.
   */
  reconcile(): PresentationReconcileDisposition {
    if (this.#reconciling) return "deferred";
    if (
      !this.#desired
      || this.#desired.generation === this.#appliedGeneration
    ) return "unchanged";

    const errors: unknown[] = [];
    let applied = false;
    let passes = 0;
    this.#reconciling = true;
    try {
      while (
        this.#desired
        && this.#desired.generation !== this.#appliedGeneration
      ) {
        if (passes >= LatestPresentationOperationCoordinator.MAX_RECONCILE_PASSES) {
          errors.push(new Error(
            "Presentation projection did not reach a stable operation",
          ));
          break;
        }
        passes += 1;

        const target = this.#desired;
        const isCurrent = (): boolean => (
          this.#desired === target
          && this.#owner.isHandoffCurrent(target)
        );
        let failed = false;
        try {
          this.#project(target, { isCurrent });
        } catch (error) {
          failed = true;
          appendPresentationError(errors, error);
        }

        if (!isCurrent()) {
          // A successor was published while this host frame was active. Even
          // when A failed, drain that successor before reporting A's error.
          continue;
        }
        if (failed) {
          // Keep the current generation pending so a later explicit reconcile
          // can retry after its host dependency has recovered.
          break;
        }

        this.#appliedGeneration = target.generation;
        applied = true;
      }
    } finally {
      this.#reconciling = false;
    }

    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(
        errors,
        "Presentation projection failed before reaching the latest target",
      );
    }
    return applied ? "applied" : "unchanged";
  }
}
