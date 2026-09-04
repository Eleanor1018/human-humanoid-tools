import { toDisposable, type IDisposable } from "@/base/common/disposable";
import type { MotionPayload } from "@/domain/motion/common/motion";
import type {
  HumanMotionPresentationIntent,
  IHumanMotionPresentationReservation,
  IMotionResultPresentationService,
  MotionPresentationReservationOptions,
  MotionPresentationResult,
} from "@/workbench/services/motion/common/motion-result-presentation-service";
import type {
  ILegacyStageDisplayStateSource,
  LegacyH2rStageDisplaySnapshot,
} from "@/workbench/services/stage/browser/legacy-stage-display-state-source";
import type { StageLayerId } from "@/workbench/services/stage/common/stage-service";
import type { ILegacyRuntimeService } from "../common/legacy-runtime-service";

interface LoadedLegacyRuntime {
  reserveHumanMotionPresentation(
    label?: string,
  ): IHumanMotionPresentationReservation;
  resetStageView(): void;
  toggleH2rStageLayer(layerId: StageLayerId): void;
  subscribeH2rStageDisplayState(
    listener: (snapshot: LegacyH2rStageDisplaySnapshot) => void,
  ): () => void;
}

function abortError(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError");
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason instanceof Error ? signal.reason : abortError();
}

function waitWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/** Transfer a synchronously reserved capability only if acquisition still owns it. */
function deliverWithAbort<T extends IDisposable>(
  value: T,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return Promise.resolve(value);
  const release = () => {
    try {
      value.dispose();
    } catch (error) {
      console.warn("Aborted runtime reservation cleanup failed", error);
    }
  };
  if (signal.aborted) {
    release();
    return Promise.reject(abortReason(signal));
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      release();
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void Promise.resolve().then(() => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve(value);
    });
  });
}

/**
 * Temporary strangler boundary around the existing Three.js/workflow runtime.
 *
 * React owns the shell markup and migrated feature state. The legacy modules
 * are loaded only after React commits their compatibility DOM contract. New
 * code must depend on workbench services/events and add no document queries here.
 */
export class BrowserLegacyRuntimeService
  implements
    ILegacyRuntimeService,
    IMotionResultPresentationService,
    ILegacyStageDisplayStateSource
{
  #startPromise: Promise<void> | null = null;
  #runtime: LoadedLegacyRuntime | null = null;

  start(): Promise<void> {
    // Return the same promise to every caller. A boolean "started" flag would
    // let a second caller continue while the dynamic imports were still loading.
    if (!this.#startPromise) this.#startPromise = this.#load();
    return this.#startPromise;
  }

  reserveHumanMotionPresentation(
    intent: HumanMotionPresentationIntent,
    options: MotionPresentationReservationOptions = {},
  ): Promise<IHumanMotionPresentationReservation> {
    const { signal } = options;
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    if (this.#runtime) {
      // Reserve synchronously on the hot path. This keeps a state observer or
      // same-turn Library action from slipping ahead of the user's V2M intent.
      return this.#reserveLoadedRuntime(intent, signal);
    }
    return this.#reserveAfterStart(intent, signal);
  }

  /** Compatibility aggregate for callers not yet migrated to reservations. */
  async presentHumanMotion(
    payload: MotionPayload,
  ): Promise<MotionPresentationResult> {
    const reservation = await this.reserveHumanMotionPresentation({
      label: payload.name || "generated motion",
    });
    try {
      return await reservation.commit(payload);
    } finally {
      reservation.dispose();
    }
  }

  /** Browser-only migration capability; intentionally absent from the common
   * ILegacyRuntimeService lifecycle contract.
   */
  async resetStageView(): Promise<void> {
    await this.start();
    if (!this.#runtime) {
      throw new Error("Legacy runtime did not finish initialization");
    }
    this.#runtime.resetStageView();
  }

  /** Browser-only command capability kept off the common lifecycle service. */
  async toggleH2rStageLayer(layerId: StageLayerId): Promise<void> {
    await this.start();
    if (!this.#runtime) {
      throw new Error("Legacy runtime did not finish initialization");
    }
    this.#runtime.toggleH2rStageLayer(layerId);
  }

  /**
   * Browser-only passive display source. Joining the shared startup promise
   * keeps this method safe when a Restored contribution races another caller.
   */
  async subscribeH2rStageDisplayState(
    listener: (snapshot: LegacyH2rStageDisplaySnapshot) => void,
  ): Promise<IDisposable> {
    await this.start();
    if (!this.#runtime) {
      throw new Error("Legacy runtime did not finish initialization");
    }
    // The loaded module is structurally checked against this browser port;
    // semantic normalization remains the Stage adapter's single responsibility.
    const unsubscribe = this.#runtime.subscribeH2rStageDisplayState(listener);
    return toDisposable(unsubscribe);
  }

  dispose(): void {
    // The imported runtime is currently a module singleton. Its lifecycle will
    // move into StageService and contribution disposables in the next slices.
  }

  async #load(): Promise<void> {
    try {
      const runtime = await import("@/runtime/webui-runtime");
      await import("@/runtime/dataset-viz");
      this.#runtime = runtime;
    } catch (error) {
      this.#runtime = null;
      this.#startPromise = null;
      throw error;
    }
  }

  #reserveLoadedRuntime(
    intent: HumanMotionPresentationIntent,
    signal?: AbortSignal,
  ): Promise<IHumanMotionPresentationReservation> {
    try {
      const runtime = this.#runtime;
      if (!runtime) {
        return Promise.reject(
          new Error("Legacy runtime did not finish initialization"),
        );
      }
      const reservation = runtime.reserveHumanMotionPresentation(intent.label);
      return deliverWithAbort(reservation, signal);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  async #reserveAfterStart(
    intent: HumanMotionPresentationIntent,
    signal?: AbortSignal,
  ): Promise<IHumanMotionPresentationReservation> {
    await waitWithAbort(this.start(), signal);
    if (signal?.aborted) throw abortReason(signal);
    const reservation = await this.#reserveLoadedRuntime(intent, signal);
    if (signal?.aborted) {
      reservation.dispose();
      throw abortReason(signal);
    }
    return reservation;
  }
}
