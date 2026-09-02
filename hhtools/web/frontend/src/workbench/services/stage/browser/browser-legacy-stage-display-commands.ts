import type { IStageDisplayCommands } from "@/workbench/services/stage/common/stage-service";

export interface LegacyStageDisplayRuntime {
  resetStageView(): Promise<void>;
}

/**
 * Temporary command adapter around Stage behavior still owned by the legacy
 * Three.js module. It reports asynchronous failures at the composition
 * boundary so a React click never creates an unhandled rejection.
 */
export class BrowserLegacyStageDisplayCommands
  implements IStageDisplayCommands
{
  readonly #runtime: LegacyStageDisplayRuntime;
  readonly #reportError: (error: unknown) => void;

  constructor(
    runtime: LegacyStageDisplayRuntime,
    reportError: (error: unknown) => void,
  ) {
    this.#runtime = runtime;
    this.#reportError = reportError;
  }

  resetView(): void {
    try {
      void this.#runtime.resetStageView().catch((error) =>
        this.#reportSafely(error),
      );
    } catch (error) {
      // Also isolate a structurally compatible runtime that throws before it
      // returns its promised completion.
      this.#reportSafely(error);
    }
  }

  #reportSafely(error: unknown): void {
    try {
      this.#reportError(error);
    } catch {
      // Reporting is observational and cannot break a later Stage command.
    }
  }
}
