import {
  LatestAsyncAttemptOwner,
  type AsyncAttemptIdentityValidator,
  type LatestAsyncAttempt,
} from "./latest-async-attempt-owner";

/**
 * Owns one latest-only async attempt and a lease retained after exact finish.
 *
 * A successful caller often needs to publish through fallible synchronous
 * observers after its request token has retired. The completion lease remains
 * valid until a successor begins or explicit invalidation occurs; it never
 * revives the attempt or grants cleanup rights over a successor.
 */
export class LatestAsyncCompletionLeaseOwner<Identity> {
  readonly #attempts: LatestAsyncAttemptOwner<Identity>;
  readonly #isIdentityCurrent: AsyncAttemptIdentityValidator<Identity>;
  #pending: LatestAsyncAttempt<Identity> | null = null;
  #latestCompletion: LatestAsyncAttempt<Identity> | null = null;

  constructor(isIdentityCurrent: AsyncAttemptIdentityValidator<Identity>) {
    this.#isIdentityCurrent = isIdentityCurrent;
    this.#attempts = new LatestAsyncAttemptOwner(isIdentityCurrent);
  }

  begin(identity: Identity): LatestAsyncAttempt<Identity> {
    this.#latestCompletion = null;
    const attempt = this.#attempts.begin(identity);
    this.#pending = attempt;
    return attempt;
  }

  isCurrent(attempt: LatestAsyncAttempt<Identity>): boolean {
    return this.#attempts.isCurrent(attempt);
  }

  owns(attempt: LatestAsyncAttempt<Identity>): boolean {
    return this.#attempts.owns(attempt);
  }

  get isPending(): boolean {
    const observed = this.#pending;
    if (!observed) return false;
    const observedIsCurrent = this.#attempts.isCurrent(observed);
    if (this.#pending === observed) return observedIsCurrent;
    // Validation may synchronously begin a successor. Report that raw token as
    // conservatively pending without recursively invoking a re-entrant
    // validator; its own operation will terminalize or supersede it later.
    const successor = this.#pending;
    return successor !== null && this.#attempts.owns(successor);
  }

  /** Retire exactly the current attempt and preserve its publication lease. */
  finish(attempt: LatestAsyncAttempt<Identity>): boolean {
    if (!this.#attempts.finish(attempt)) return false;
    if (this.#pending === attempt) this.#pending = null;
    this.#latestCompletion = attempt;
    return true;
  }

  /** Retire an exact active attempt after an external capability disappears. */
  abandon(attempt: LatestAsyncAttempt<Identity>): boolean {
    if (!this.#attempts.abandon(attempt)) return false;
    if (this.#pending === attempt) this.#pending = null;
    return true;
  }

  /** Revoke the active attempt and any retained completion publication. */
  invalidate(): void {
    this.#attempts.invalidate();
    this.#pending = null;
    this.#latestCompletion = null;
  }

  /**
   * Accept the active attempt or its exact, most recently finished lease.
   * Mutable capabilities may disappear after finish, so both forms validate
   * identity and re-check raw ownership after the foreign callback returns.
   */
  leaseIsLatest(attempt: LatestAsyncAttempt<Identity>): boolean {
    if (this.#attempts.isCurrent(attempt)) return true;
    if (this.#latestCompletion !== attempt || this.#pending !== null) {
      return false;
    }
    let identityIsCurrent = false;
    try {
      identityIsCurrent = this.#isIdentityCurrent(attempt.identity);
    } catch {
      return false;
    }
    return (
      identityIsCurrent
      && this.#latestCompletion === attempt
      && this.#pending === null
    );
  }
}
