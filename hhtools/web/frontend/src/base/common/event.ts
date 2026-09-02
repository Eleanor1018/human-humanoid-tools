import { toDisposable, type IDisposable } from "./disposable";

export type Event<T> = (listener: (event: T) => void) => IDisposable;

interface ListenerSubscription<T> {
  readonly listener: (event: T) => void;
}

/**
 * Small synchronous event source for long-lived services.
 *
 * Each delivery walks a snapshot so listeners may subscribe or dispose while
 * an event is firing without corrupting that delivery. Those lifecycle changes
 * take effect on the next call to `fire`.
 */
export class Emitter<T> implements IDisposable {
  readonly #listeners = new Set<ListenerSubscription<T>>();
  #disposed = false;

  readonly event: Event<T> = (listener) => {
    if (this.#disposed) return toDisposable(() => undefined);

    // Store subscriptions rather than bare callbacks so registering the same
    // function twice still creates two independently disposable listeners.
    const subscription: ListenerSubscription<T> = { listener };
    this.#listeners.add(subscription);
    return toDisposable(() => this.#listeners.delete(subscription));
  };

  fire(event: T): void {
    if (this.#disposed) return;
    for (const subscription of [...this.#listeners]) {
      subscription.listener(event);
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#listeners.clear();
  }
}
