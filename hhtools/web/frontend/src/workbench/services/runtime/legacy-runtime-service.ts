import type { IDisposable } from "@/base/common/disposable";

/**
 * Temporary strangler boundary around the existing Three.js/workflow runtime.
 *
 * React owns markup and user-facing state. The legacy modules are loaded only
 * after React commits the compatibility DOM contract. New code must depend on
 * workbench services/events and must not add new document queries here.
 */
export class LegacyRuntimeService implements IDisposable {
  #started = false;

  async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;
    try {
      await import("@/runtime/webui-runtime");
      await import("@/runtime/dataset-viz");
    } catch (error) {
      this.#started = false;
      throw error;
    }
  }

  dispose(): void {
    // The imported runtime is currently a module singleton. Its lifecycle will
    // move into StageService and contribution disposables in the next slices.
  }
}
