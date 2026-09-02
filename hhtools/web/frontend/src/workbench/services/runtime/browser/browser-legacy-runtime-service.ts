import type { ILegacyRuntimeService } from "../common/legacy-runtime-service";

/**
 * Temporary strangler boundary around the existing Three.js/workflow runtime.
 *
 * React owns the shell markup and migrated feature state. The legacy modules
 * are loaded only after React commits their compatibility DOM contract. New
 * code must depend on workbench services/events and add no document queries here.
 */
export class BrowserLegacyRuntimeService implements ILegacyRuntimeService {
  #startPromise: Promise<void> | null = null;

  start(): Promise<void> {
    // Return the same promise to every caller. A boolean "started" flag would
    // let a second caller continue while the dynamic imports were still loading.
    if (!this.#startPromise) this.#startPromise = this.#load();
    return this.#startPromise;
  }

  dispose(): void {
    // The imported runtime is currently a module singleton. Its lifecycle will
    // move into StageService and contribution disposables in the next slices.
  }

  async #load(): Promise<void> {
    try {
      await import("@/runtime/webui-runtime");
      await import("@/runtime/dataset-viz");
    } catch (error) {
      this.#startPromise = null;
      throw error;
    }
  }
}
