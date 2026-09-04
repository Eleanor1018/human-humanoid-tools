import type { IStageView } from "@/workbench/services/stage/common/stage-view";

export interface LegacyStageDisplayRuntime {
  resetStageView(): Promise<void>;
}

/**
 * Temporary Stage View around camera behavior still owned by the legacy
 * Three.js module. Promise failures intentionally flow to BrowserStageViewService,
 * which is the single error owner for every attached View implementation.
 */
export class BrowserLegacyStageView implements IStageView {
  readonly #runtime: LegacyStageDisplayRuntime;

  constructor(runtime: LegacyStageDisplayRuntime) {
    this.#runtime = runtime;
  }

  resetView(): Promise<void> {
    return this.#runtime.resetStageView();
  }
}
