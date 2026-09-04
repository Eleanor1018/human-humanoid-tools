import {
  toDisposable,
  type IDisposable,
} from "@/base/common/disposable";

type StoredCommandHandler = (
  ...args: unknown[]
) => unknown | PromiseLike<unknown>;

/** Raised when a command caller runs before or after its view is registered. */
export class CommandNotFoundError extends Error {
  constructor(readonly commandId: string) {
    super(`Command is not registered: ${commandId}`);
    this.name = "CommandNotFoundError";
  }
}

/**
 * Small process-local command registry shared by Browser and Electron renderers.
 *
 * Command callers depend only on a stable id; the feature that owns the action
 * registers its handler. This removes the need for the Workbench shell to know
 * a contributed panel's DOM structure or to manufacture element clicks.
 */
export interface ICommandService extends IDisposable {
  registerCommand<Args extends unknown[], Result>(
    id: string,
    handler: (...args: Args) => Result | PromiseLike<Result>,
  ): IDisposable;

  executeCommand<Result = unknown>(
    id: string,
    ...args: unknown[]
  ): Promise<Result>;
}

/** Renderer-scoped command service with explicit registration ownership. */
export class CommandService implements ICommandService {
  readonly #handlers = new Map<string, StoredCommandHandler>();
  #disposed = false;

  registerCommand<Args extends unknown[], Result>(
    id: string,
    handler: (...args: Args) => Result | PromiseLike<Result>,
  ): IDisposable {
    this.#assertActive();
    if (!id.trim()) throw new Error("Command id must not be empty");
    if (this.#handlers.has(id)) {
      throw new Error(`Command is already registered: ${id}`);
    }

    // Preserve the handler's local parameter types at registration and erase
    // them only inside this id-based registry. If commands later need static
    // cross-call-site typing, introduce typed descriptors without changing the
    // ownership and execution semantics established here.
    const stored: StoredCommandHandler = (...args) =>
      handler(...(args as Args));
    this.#handlers.set(id, stored);

    return toDisposable(() => {
      // An old registration must never remove a newer handler with the same id.
      if (this.#handlers.get(id) === stored) this.#handlers.delete(id);
    });
  }

  async executeCommand<Result = unknown>(
    id: string,
    ...args: unknown[]
  ): Promise<Result> {
    this.#assertActive();
    const handler = this.#handlers.get(id);
    if (!handler) throw new CommandNotFoundError(id);
    return (await handler(...args)) as Result;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#handlers.clear();
  }

  #assertActive(): void {
    if (this.#disposed) throw new Error("Command service is disposed");
  }
}
