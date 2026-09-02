import { DisposableStore } from "@/base/common/disposable";
import { BrowserHostService } from "@/platform/host/browser/browser-host-service";
import { BrowserRequestService } from "@/platform/request/browser/browser-request-service";
import type { IWorkbenchServices } from "@/workbench/services/common/workbench-services";
import { BrowserGvhmrComponentService } from "@/workbench/services/gvhmr/browser/browser-gvhmr-component-service";
import { BrowserJobService } from "@/workbench/services/jobs/browser/browser-job-service";
import { BrowserLegacyRuntimeService } from "@/workbench/services/runtime/browser/browser-legacy-runtime-service";
import { BrowserSettingsService } from "@/workbench/services/settings/browser/browser-settings-service";

/**
 * Instantiate browser/Electron-renderer implementations and wire dependencies.
 *
 * This is intentionally a small composition root rather than a reflection-based
 * dependency-injection container. The graph is visible in constructor calls and
 * can grow into a richer registry only if the application actually needs one.
 */
export function createBrowserWorkbenchServices(): IWorkbenchServices {
  const ownedServices = new DisposableStore();
  const requestService = new BrowserRequestService();
  const jobService = ownedServices.add(new BrowserJobService(requestService));
  const legacyRuntimeService = ownedServices.add(
    new BrowserLegacyRuntimeService(),
  );

  return {
    hostService: new BrowserHostService(),
    requestService,
    gvhmrComponentService: new BrowserGvhmrComponentService(),
    jobService,
    // One adapter exposes two narrow contracts but remains owned exactly once.
    motionResultPresentationService: legacyRuntimeService,
    settingsService: new BrowserSettingsService(requestService),
    legacyRuntimeService,
    dispose: () => ownedServices.dispose(),
  };
}
