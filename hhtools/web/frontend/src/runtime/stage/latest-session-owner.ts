export interface OwnedSession<Value> {
  readonly generation: number;
  readonly value: Value;
}

export interface SessionHandoff<Value> {
  readonly generation: number;
  readonly current: OwnedSession<Value> | null;
}

export interface SessionReplacement<Value> {
  readonly current: OwnedSession<Value>;
  readonly previous: OwnedSession<Value> | null;
  readonly handoff: SessionHandoff<Value>;
}

/**
 * Grants publication rights to exactly one latest outer session.
 *
 * This owner deliberately invokes no cleanup callback. `begin` first publishes
 * the successor and returns the predecessor to its caller; the caller can then
 * release exact predecessor resources while `isHandoffCurrent` prevents that
 * cleanup from projecting shared state over a reentrant third session.
 */
export class LatestSessionOwner<Value> {
  #generation = 0;
  #current: OwnedSession<Value> | null = null;

  get current(): OwnedSession<Value> | null {
    return this.#current;
  }

  begin(value: Value): SessionReplacement<Value> {
    const previous = this.#current;
    const current: OwnedSession<Value> = Object.freeze({
      generation: ++this.#generation,
      value,
    });
    this.#current = current;
    return Object.freeze({
      current,
      previous,
      handoff: Object.freeze({
        generation: current.generation,
        current,
      }),
    });
  }

  /** Take the exact current session before its caller begins foreign cleanup. */
  finish(session: OwnedSession<Value>): SessionHandoff<Value> | null {
    if (!this.isCurrent(session)) return null;
    const generation = ++this.#generation;
    this.#current = null;
    return Object.freeze({ generation, current: null });
  }

  isCurrent(session: OwnedSession<Value>): boolean {
    return (
      this.#current === session
      && this.#generation === session.generation
    );
  }

  isHandoffCurrent(handoff: SessionHandoff<Value>): boolean {
    return (
      this.#generation === handoff.generation
      && this.#current === handoff.current
    );
  }
}
