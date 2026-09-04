export interface LatestAsyncAttempt<Identity> {
  readonly generation: number;
  readonly identity: Identity;
}

export type AsyncAttemptIdentityValidator<Identity> = (
  identity: Identity,
) => boolean;

/**
 * Grants publication rights to only the latest asynchronous attempt.
 *
 * The identity validator keeps mutable application state outside this owner.
 * Callers re-check the opaque attempt after every await and before observable
 * effects; invalidation itself is synchronous and does not depend on abortable
 * transport support.
 */
export class LatestAsyncAttemptOwner<Identity> {
  readonly #isIdentityCurrent: AsyncAttemptIdentityValidator<Identity>;
  #generation = 0;
  #current: LatestAsyncAttempt<Identity> | null = null;

  constructor(isIdentityCurrent: AsyncAttemptIdentityValidator<Identity>) {
    this.#isIdentityCurrent = isIdentityCurrent;
  }

  begin(identity: Identity): LatestAsyncAttempt<Identity> {
    const attempt: LatestAsyncAttempt<Identity> = Object.freeze({
      generation: ++this.#generation,
      identity,
    });
    this.#current = attempt;
    return attempt;
  }

  invalidate(): void {
    this.#generation += 1;
    this.#current = null;
  }

  isCurrent(attempt: LatestAsyncAttempt<Identity>): boolean {
    if (!this.#owns(attempt)) return false;
    let identityIsCurrent = false;
    try {
      identityIsCurrent = this.#isIdentityCurrent(attempt.identity);
    } catch {
      return false;
    }
    // Identity validation is foreign code and may synchronously begin or
    // invalidate an attempt. Re-check token ownership after it returns.
    return identityIsCurrent && this.#owns(attempt);
  }

  /**
   * Whether this exact token is still active, without consulting its identity.
   *
   * Callers normally want `isCurrent`. `owns` is reserved for terminal
   * compensation after an external capability in the captured identity has
   * already disappeared: the losing task must still retire its own spinner,
   * but must never touch a newer task.
   */
  owns(attempt: LatestAsyncAttempt<Identity>): boolean {
    return this.#owns(attempt);
  }

  /** Retire one successful or rolled-back attempt without touching a successor. */
  finish(attempt: LatestAsyncAttempt<Identity>): boolean {
    if (!this.isCurrent(attempt)) return false;
    if (!this.#owns(attempt)) return false;
    this.#generation += 1;
    this.#current = null;
    return true;
  }

  /**
   * Retire an exact active token whose captured capability is no longer valid.
   * Unlike `finish`, this deliberately skips identity validation.
   */
  abandon(attempt: LatestAsyncAttempt<Identity>): boolean {
    if (!this.#owns(attempt)) return false;
    this.#generation += 1;
    this.#current = null;
    return true;
  }

  #owns(attempt: LatestAsyncAttempt<Identity>): boolean {
    return (
      this.#current === attempt
      && this.#generation === attempt.generation
    );
  }
}
