import type {
  IStageLayerCommands,
  StageLayerId,
} from "@/workbench/services/stage/common/stage-service";

export interface LegacyStageLayerRuntime {
  toggleH2rStageLayer(layerId: StageLayerId): Promise<void>;
}

/**
 * Temporary command adapter around H2R layers still owned by the legacy
 * renderer. It keeps readiness asynchronous at the browser facade while the
 * React command contract remains synchronous and renderer-independent.
 */
export class BrowserLegacyStageLayerCommands implements IStageLayerCommands {
  readonly #runtime: LegacyStageLayerRuntime;
  readonly #reportError: (error: unknown) => void;

  constructor(
    runtime: LegacyStageLayerRuntime,
    reportError: (error: unknown) => void,
  ) {
    this.#runtime = runtime;
    this.#reportError = reportError;
  }

  toggleLayer(layerId: StageLayerId): void {
    try {
      void this.#runtime
        .toggleH2rStageLayer(layerId)
        .catch((error) => this.#reportSafely(error));
    } catch (error) {
      // Structural test doubles can throw before returning their promise.
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
