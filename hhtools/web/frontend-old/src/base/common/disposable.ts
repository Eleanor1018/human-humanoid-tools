/** Minimal VS Code-style lifecycle contract for long-lived workbench services. */
export interface IDisposable {
  dispose(): void;
}

/** Collects related subscriptions and releases them in reverse registration order. */
export class DisposableStore implements IDisposable {
  readonly #items = new Set<IDisposable>();
  #disposed = false;

  add<T extends IDisposable>(item: T): T {
    // A late registration must not outlive its owner. Disposing it immediately
    // also makes asynchronous setup safe when teardown wins the race.
    if (this.#disposed) {
      item.dispose();
      return item;
    }
    this.#items.add(item);
    return item;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;

    // One faulty participant must not prevent the remaining graph from being
    // released. Preserve reverse ownership order and report every failure only
    // after all disposables have had their cleanup opportunity.
    const errors: unknown[] = [];
    for (const item of [...this.#items].reverse()) {
      try {
        item.dispose();
      } catch (error) {
        errors.push(error);
      }
    }
    this.#items.clear();
    if (errors.length > 0) {
      throw new AggregateError(errors, "Failed to dispose every owned resource");
    }
  }
}

export function toDisposable(dispose: () => void): IDisposable {
  let disposed = false;
  return {
    dispose: () => {
      if (disposed) return;
      disposed = true;
      dispose();
    },
  };
}
