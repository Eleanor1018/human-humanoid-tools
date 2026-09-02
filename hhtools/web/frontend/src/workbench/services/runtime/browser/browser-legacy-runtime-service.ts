import type { MotionPayload } from "@/domain/motion/common/motion";
import type {
  IMotionResultPresentationService,
} from "@/workbench/services/motion/common/motion-result-presentation-service";
import type { ILegacyRuntimeService } from "../common/legacy-runtime-service";

interface LoadedLegacyRuntime extends IMotionResultPresentationService {
  resetStageView(): void;
}

/**
 * Temporary strangler boundary around the existing Three.js/workflow runtime.
 *
 * React owns the shell markup and migrated feature state. The legacy modules
 * are loaded only after React commits their compatibility DOM contract. New
 * code must depend on workbench services/events and add no document queries here.
 */
export class BrowserLegacyRuntimeService
  implements ILegacyRuntimeService, IMotionResultPresentationService
{
  #startPromise: Promise<void> | null = null;
  #runtime: LoadedLegacyRuntime | null = null;

  start(): Promise<void> {
    // Return the same promise to every caller. A boolean "started" flag would
    // let a second caller continue while the dynamic imports were still loading.
    if (!this.#startPromise) this.#startPromise = this.#load();
    return this.#startPromise;
  }

  async presentHumanMotion(payload: MotionPayload): Promise<void> {
    // Presentation can race the Restored contribution. Joining start() makes
    // readiness explicit instead of relying on registration order or timing.
    await this.start();
    if (!this.#runtime) {
      throw new Error("Legacy runtime did not finish initialization");
    }
    await this.#runtime.presentHumanMotion(payload);
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
}
