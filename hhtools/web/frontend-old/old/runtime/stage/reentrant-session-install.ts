export type SessionInstallDisposition = "installed" | "superseded";
export type SessionLateCleanupCause = "returned" | "threw";

export interface SessionInstallAuthority {
  /** Exact lease authority; callers must not substitute mutable state flags. */
  isCurrent(): boolean;
}

function appendInstallError(errors: unknown[], error: unknown): void {
  if (error instanceof AggregateError) {
    for (const nested of error.errors) appendInstallError(errors, nested);
  }
  else errors.push(error);
}

/**
 * Defers a successor mutation until the outer host call has fully returned.
 *
 * Some host resources have only a physical identity and no generation. A
 * retired release that late-commits after reentrant successor installation
 * would therefore undo the successor. The gate lets that successor reserve
 * ownership immediately while postponing its host mutation until the old
 * frame (including exact compensation) is finished.
 */
export class ReentrantHostMutationGate {
  #depth = 0;
  #deferred = false;

  get isInsideHostMutation(): boolean {
    return this.#depth > 0;
  }

  deferUntilIdle(): void {
    if (!this.isInsideHostMutation) {
      throw new Error("A host mutation can only be deferred from a reentrant host frame");
    }
    this.#deferred = true;
  }

  run<Result>(
    mutation: () => Result,
    drainDeferred: () => void,
  ): Result {
    let result!: Result;
    let mutationError: unknown;
    let mutationFailed = false;
    this.#depth += 1;
    try {
      result = mutation();
    } catch (error) {
      mutationError = error;
      mutationFailed = true;
    } finally {
      this.#depth -= 1;
    }

    let drainError: unknown;
    let drainFailed = false;
    if (this.#depth === 0 && this.#deferred) {
      this.#deferred = false;
      try {
        drainDeferred();
      } catch (error) {
        drainError = error;
        drainFailed = true;
      }
    }

    if (mutationFailed && drainFailed) {
      const errors: unknown[] = [];
      appendInstallError(errors, mutationError);
      appendInstallError(errors, drainError);
      throw new AggregateError(
        errors,
        "Host mutation failed and deferred successor installation was incomplete",
      );
    }
    if (mutationFailed) throw mutationError;
    if (drainFailed) throw drainError;
    return result;
  }
}

/**
 * Install one host resource whose API may synchronously re-enter its owner.
 *
 * `mark` runs before the host call so ordinary stop can see the obligation.
 * A hostile host can nevertheless stop the session, install the resource only
 * afterwards, and then either return or throw. In both cases this primitive
 * invokes the exact late cleanup after the host frame returns. It deliberately
 * knows nothing about DOM, events, Three.js, or pointer capture.
 */
export function installReentrantSessionResource({
  authority,
  mark,
  install,
  cleanupLate,
}: {
  readonly authority: SessionInstallAuthority;
  readonly mark: () => void;
  readonly install: () => void;
  readonly cleanupLate: (cause: SessionLateCleanupCause) => void;
}): SessionInstallDisposition {
  if (!authority.isCurrent()) return "superseded";
  mark();
  // `mark` is normally a local record write, but keeping this primitive safe
  // under an instrumented or reentrant callback avoids entering the host after
  // the exact lease has already been stopped.
  if (!authority.isCurrent()) return "superseded";
  try {
    install();
  } catch (installError) {
    if (!authority.isCurrent()) {
      const errors: unknown[] = [];
      appendInstallError(errors, installError);
      const installErrorCount = errors.length;
      try {
        cleanupLate("threw");
      } catch (cleanupError) {
        appendInstallError(errors, cleanupError);
      }
      if (errors.length > installErrorCount) {
        throw new AggregateError(
          errors,
          "Session resource install failed and late cleanup was incomplete",
        );
      }
    }
    throw installError;
  }
  if (authority.isCurrent()) return "installed";
  cleanupLate("returned");
  return "superseded";
}
