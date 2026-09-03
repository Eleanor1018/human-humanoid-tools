import {
  LatestAsyncAttemptOwner,
  type AsyncAttemptIdentityValidator,
  type LatestAsyncAttempt,
} from "./latest-async-attempt-owner";

/** Exact immutable receipt for one committed async domain result. */
export interface CommittedAsyncResult<Identity, Value> {
  readonly attempt: LatestAsyncAttempt<Identity>;
  readonly value: Value;
}

/**
 * Owns a latest-only async request and its not-yet-consumed presentation.
 *
 * Domain commit and shared-surface presentation deliberately have different
 * lifetimes: a request may safely commit hidden feature-local data while a
 * different workflow owns the Stage. The resulting exact receipt remains
 * pending until that same result is presented, superseded, or invalidated.
 *
 * Identities and values are caller-created immutable snapshots. This owner is
 * callback-free apart from the identity validator inherited from
 * `LatestAsyncAttemptOwner`; it never knows about DOM, Three.js, React, or the
 * transport that produced the result.
 */
export class LatestAsyncResultOwner<Identity, Value> {
  readonly #attempts: LatestAsyncAttemptOwner<Identity>;
  #pendingPresentation: CommittedAsyncResult<Identity, Value> | null = null;

  constructor(isIdentityCurrent: AsyncAttemptIdentityValidator<Identity>) {
    this.#attempts = new LatestAsyncAttemptOwner(isIdentityCurrent);
  }

  get pendingPresentation(): CommittedAsyncResult<Identity, Value> | null {
    return this.#pendingPresentation;
  }

  /** A newer request revokes both the old continuation and its pending result. */
  begin(identity: Identity): LatestAsyncAttempt<Identity> {
    const attempt = this.#attempts.begin(identity);
    this.#pendingPresentation = null;
    return attempt;
  }

  isCurrent(attempt: LatestAsyncAttempt<Identity>): boolean {
    return this.#attempts.isCurrent(attempt);
  }

  /**
   * Atomically retire the current request and publish its presentation receipt.
   * A stale attempt cannot replace a newer request or result.
   */
  commit(
    attempt: LatestAsyncAttempt<Identity>,
    value: Value,
  ): CommittedAsyncResult<Identity, Value> | null {
    if (!this.#attempts.finish(attempt)) return null;
    const committed = Object.freeze({ attempt, value });
    this.#pendingPresentation = committed;
    return committed;
  }

  /** Retire a current failed/cancelled request without publishing a result. */
  finish(attempt: LatestAsyncAttempt<Identity>): boolean {
    return this.#attempts.finish(attempt);
  }

  /** Revoke the current request and any hidden result waiting for presentation. */
  invalidate(): void {
    this.#attempts.invalidate();
    this.#pendingPresentation = null;
  }

  isCommitted(commit: CommittedAsyncResult<Identity, Value>): boolean {
    return this.#pendingPresentation === commit;
  }

  /** Consume only the exact result that was successfully projected. */
  markPresented(commit: CommittedAsyncResult<Identity, Value>): boolean {
    if (this.#pendingPresentation !== commit) return false;
    this.#pendingPresentation = null;
    return true;
  }
}
