import { toDisposable } from "@/base/common/disposable";
import {
  WorkbenchLifecyclePhase,
  type IWorkbenchContribution,
} from "@/workbench/common/contribution";
import type { ILegacyRuntimeService } from "@/workbench/services/runtime/common/legacy-runtime-service";

const READINESS_TIMEOUT_MS = 4_000;

/**
 * Starts the temporary imperative runtime only after React has committed every
 * compatibility element. This contribution owns startup observation, while the
 * service graph remains the sole owner of the legacy service itself.
 */
export function createLegacyRuntimeContribution(
  runtimeService: ILegacyRuntimeService,
): IWorkbenchContribution {
  return {
    id: "workbench.contrib.legacy-runtime",
    phase: WorkbenchLifecyclePhase.Restored,
    activate: (context) => {
      const startup = runtimeService.start();
      const watchdog = window.setTimeout(() => {
        if (!window.__hhtoolsReady) {
          context.reportError(
            new Error("React workbench runtime did not finish initialization"),
          );
        }
      }, READINESS_TIMEOUT_MS);
      void startup.catch((error) => {
        // Preserve the specific module-load error; otherwise the later generic
        // readiness timeout would report a second failure and obscure its cause.
        window.clearTimeout(watchdog);
        context.reportError(error);
      });

      // BrowserLegacyRuntimeService is still a module singleton with a no-op
      // dispose. The Stage/V2M migrations will transfer its listeners, RAF and
      // GPU resources into real view-owned disposables.
      return toDisposable(() => window.clearTimeout(watchdog));
    },
  };
}
