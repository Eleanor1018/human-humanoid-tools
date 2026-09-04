import { DisposableStore, toDisposable } from "@/base/common/disposable";
import {
  WorkbenchLifecyclePhase,
  type IWorkbenchContribution,
} from "@/workbench/common/contribution";
import type { ILegacyRuntimeService } from "@/workbench/services/runtime/common/legacy-runtime-service";
import { BrowserLegacyStageDisplayStateAdapter } from "@/workbench/services/stage/browser/browser-legacy-stage-display-state-adapter";
import type { ILegacyStageDisplayStateSource } from "@/workbench/services/stage/browser/legacy-stage-display-state-source";
import type { StageModel } from "@/workbench/services/stage/common/stage-model";
import type {
  IStageView,
  IStageViewAttachment,
} from "@/workbench/services/stage/common/stage-view";

const READINESS_TIMEOUT_MS = 4_000;

export interface LegacyRuntimeContributionDependencies {
  readonly runtimeService: ILegacyRuntimeService;
  readonly displayStateSource: ILegacyStageDisplayStateSource;
  readonly stageOwner: StageModel;
  readonly stageView: IStageView;
  readonly stageViewAttachment: IStageViewAttachment;
}

/**
 * Starts the temporary imperative runtime only after React has committed every
 * compatibility element. This contribution owns startup observation, while the
 * service graph remains the sole owner of the legacy service itself.
 */
export function createLegacyRuntimeContribution(
  dependencies: LegacyRuntimeContributionDependencies,
): IWorkbenchContribution {
  return {
    id: "workbench.contrib.legacy-runtime",
    phase: WorkbenchLifecyclePhase.Restored,
    activate: (context) => {
      const owned = new DisposableStore();
      let disposed = false;
      const startup = dependencies.runtimeService.start();
      const watchdog = window.setTimeout(() => {
        if (!window.__hhtoolsReady) {
          context.reportError(
            new Error("React workbench runtime did not finish initialization"),
          );
        }
      }, READINESS_TIMEOUT_MS);
      owned.add(toDisposable(() => window.clearTimeout(watchdog)));
      void startup.then(
        () => {
          // Runtime readiness and React's Restored phase are both prerequisites
          // for touching the compatibility publisher. Teardown wins this race.
          if (disposed) return;
          const restored = new DisposableStore();
          try {
            // Attach before subscribing: a synchronous first state snapshot can
            // make Reset available, so its command target must already exist.
            restored.add(
              dependencies.stageViewAttachment.attachView(
                dependencies.stageView,
              ),
            );
            restored.add(
              new BrowserLegacyStageDisplayStateAdapter(
                dependencies.stageOwner,
                dependencies.displayStateSource,
                context.reportError,
              ),
            );
            owned.add(restored);
          } catch (error) {
            // Roll back any lease acquired before synchronous Restored
            // bookkeeping fails. Subscription failures are observed inside the
            // display adapter and do not imply that the renderer View vanished.
            let reportable = error;
            try {
              restored.dispose();
            } catch (cleanupError) {
              reportable = new AggregateError(
                [error, cleanupError],
                "Failed to initialize and roll back the legacy Stage View",
              );
            }
            context.reportError(reportable);
          }
        },
        (error) => {
          if (disposed) return;
          // Preserve the specific module-load error; otherwise the later generic
          // readiness timeout would report a second failure and obscure its cause.
          window.clearTimeout(watchdog);
          context.reportError(error);
        },
      );

      // BrowserLegacyRuntimeService is still a module singleton with a no-op
      // dispose. This contribution now owns its temporary View attachment; the
      // next renderer slices will move listeners, RAF and GPU resources behind
      // the same View-owned lifecycle.
      return toDisposable(() => {
        disposed = true;
        // The nested Restored store releases display state before the View
        // attachment. A pending subscription handle is reclaimed by the
        // disposed adapter when it eventually arrives; the outer lifecycle
        // still disposes the underlying service graph last.
        owned.dispose();
      });
    },
  };
}
