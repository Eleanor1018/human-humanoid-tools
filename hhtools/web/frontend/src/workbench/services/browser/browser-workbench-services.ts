import { DisposableStore } from "@/base/common/disposable";
import { CommandService } from "@/platform/commands/common/command-service";
import { BrowserHostService } from "@/platform/host/browser/browser-host-service";
import { BrowserRequestService } from "@/platform/request/browser/browser-request-service";
import type { IWorkbenchServices } from "@/workbench/services/common/workbench-services";
import { BrowserGvhmrComponentService } from "@/workbench/services/gvhmr/browser/browser-gvhmr-component-service";
import { BrowserJobService } from "@/workbench/services/jobs/browser/browser-job-service";
import { BrowserLegacyRuntimeService } from "@/workbench/services/runtime/browser/browser-legacy-runtime-service";
import { BrowserSettingsService } from "@/workbench/services/settings/browser/browser-settings-service";
import { BrowserLegacyStageDisplayCommands } from "@/workbench/services/stage/browser/browser-legacy-stage-display-commands";
import { BrowserLegacyStagePlaybackCommands } from "@/workbench/services/stage/browser/browser-legacy-stage-playback-commands";
import { BrowserLegacyStageStateAdapter } from "@/workbench/services/stage/browser/browser-legacy-stage-state-adapter";
import { StageModel } from "@/workbench/services/stage/common/stage-model";

/** Concrete browser-only handles needed by the composition root. */
export interface BrowserWorkbenchServices extends IWorkbenchServices {
  readonly stageModelService: StageModel;
  readonly legacyRuntimeService: BrowserLegacyRuntimeService;
}

/**
 * Instantiate browser/Electron-renderer implementations and wire dependencies.
 *
 * This is intentionally a small composition root rather than a reflection-based
 * dependency-injection container. The graph is visible in constructor calls and
 * can grow into a richer registry only if the application actually needs one.
 */
export function createBrowserWorkbenchServices(
  reportError: (error: unknown) => void,
): BrowserWorkbenchServices {
  const ownedServices = new DisposableStore();
  const commandService = ownedServices.add(new CommandService());
  const requestService = new BrowserRequestService();
  // Register the model before any future renderer/legacy adapters so reverse
  // disposal releases producers first and the state owner last.
  const stageModelService = ownedServices.add(new StageModel(reportError));
  const jobService = ownedServices.add(new BrowserJobService(requestService));
  const legacyRuntimeService = ownedServices.add(
    new BrowserLegacyRuntimeService(),
  );
  // This migration adapter is deliberately registered after both endpoints.
  // Reverse disposal removes its window listener before either endpoint dies.
  ownedServices.add(new BrowserLegacyStageStateAdapter(stageModelService));
  const stagePlaybackCommands = new BrowserLegacyStagePlaybackCommands();
  const stageDisplayCommands = new BrowserLegacyStageDisplayCommands(
    legacyRuntimeService,
    reportError,
  );

  return {
    commandService,
    hostService: new BrowserHostService(),
    requestService,
    gvhmrComponentService: new BrowserGvhmrComponentService(),
    jobService,
    // One adapter exposes two narrow contracts but remains owned exactly once.
    motionResultPresentationService: legacyRuntimeService,
    settingsService: new BrowserSettingsService(requestService),
    stageDisplayCommands,
    stageModelService,
    stagePlaybackCommands,
    legacyRuntimeService,
    dispose: () => ownedServices.dispose(),
  };
}
