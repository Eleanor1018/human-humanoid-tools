import type { IDisposable } from "@/base/common/disposable";
import type { StageModel } from "@/workbench/services/stage/common/stage-model";

import type {
  ILegacyStageDisplayStateSource,
  LegacyH2rStageDisplaySnapshot,
} from "./legacy-stage-display-state-source";

/**
 * One-way adapter from the compatibility renderer's confirmed display state
 * into the semantic Stage owner. It never sends commands back to the renderer.
 *
 * Subscription startup is asynchronous because the legacy module is loaded on
 * the Restored lifecycle phase. Disposal still wins if Workbench unmounts
 * before that startup finishes.
 */
export class BrowserLegacyStageDisplayStateAdapter implements IDisposable {
  readonly #stageOwner: StageModel;
  readonly #reportError: (error: unknown) => void;
  #subscription: IDisposable | null = null;
  #disposed = false;

  constructor(
    stageOwner: StageModel,
    source: ILegacyStageDisplayStateSource,
    reportError: (error: unknown) => void,
  ) {
    this.#stageOwner = stageOwner;
    this.#reportError = reportError;

    try {
      void source.subscribeH2rStageDisplayState(this.#acceptSnapshot).then(
        (subscription) => {
          if (this.#disposed) {
            this.#disposeSafely(subscription);
            return;
          }
          this.#subscription = subscription;
        },
        (error) => {
          // A boot failure that arrives after teardown is no longer actionable.
          if (!this.#disposed) this.#reportSafely(error);
        },
      );
    } catch (error) {
      // Structural test doubles can still throw before returning their promise.
      this.#reportSafely(error);
    }
  }

  readonly #acceptSnapshot = (
    snapshot: LegacyH2rStageDisplaySnapshot,
  ): void => {
    if (this.#disposed || !snapshot.ownsStage) return;

    // Copy only semantic state. `ownsStage` belongs to this migration adapter,
    // and the model performs the final normalization/freezing atomically.
    try {
      this.#stageOwner.updateState({
        display: {
          empty: snapshot.empty,
          canResetView: snapshot.canResetView,
          layers: snapshot.layers,
        },
      });
    } catch (error) {
      // A malformed legacy snapshot or broken disposal order cannot escape
      // through the renderer's listener delivery path.
      this.#reportSafely(error);
    }
  };

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    const subscription = this.#subscription;
    this.#subscription = null;
    if (subscription) this.#disposeSafely(subscription);
  }

  #disposeSafely(subscription: IDisposable): void {
    try {
      subscription.dispose();
    } catch (error) {
      this.#reportSafely(error);
    }
  }

  #reportSafely(error: unknown): void {
    try {
      this.#reportError(error);
    } catch {
      // Reporting is observational and cannot break Stage ownership cleanup.
    }
  }
}
