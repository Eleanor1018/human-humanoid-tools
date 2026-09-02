/** Minimal VS Code-style lifecycle contract for long-lived workbench services. */
export interface IDisposable {
  dispose(): void;
}

export class DisposableStore implements IDisposable {
  readonly #items = new Set<IDisposable>();

  add<T extends IDisposable>(item: T): T {
    this.#items.add(item);
    return item;
  }

  dispose(): void {
    for (const item of [...this.#items].reverse()) item.dispose();
    this.#items.clear();
  }
}

export function toDisposable(dispose: () => void): IDisposable {
  return { dispose };
}
