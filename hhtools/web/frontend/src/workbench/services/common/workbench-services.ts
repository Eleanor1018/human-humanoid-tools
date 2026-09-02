import type { IDisposable } from "@/base/common/disposable";
import type { ICommandService } from "@/platform/commands/common/command-service";
import type { IHostService } from "@/platform/host/common/host-service";
import type { IRequestService } from "@/platform/request/common/request-service";
import type { IGvhmrComponentService } from "@/workbench/services/gvhmr/common/gvhmr-component-service";
import type { IJobService } from "@/workbench/services/jobs/common/job-service";
import type {
  IMotionResultPresentationService,
} from "@/workbench/services/motion/common/motion-result-presentation-service";
import type { ILegacyRuntimeService } from "@/workbench/services/runtime/common/legacy-runtime-service";
import type { ISettingsService } from "@/workbench/services/settings/common/settings-service";

/**
 * Stable services available to React workbench features.
 *
 * Views depend on this interface rather than importing browser singletons. The
 * browser composition root is therefore the only place that needs to know the
 * concrete implementations, which also makes each service replaceable in tests.
 */
export interface IWorkbenchServices extends IDisposable {
  readonly commandService: ICommandService;
  readonly hostService: IHostService;
  readonly requestService: IRequestService;
  readonly gvhmrComponentService: IGvhmrComponentService;
  readonly jobService: IJobService;
  readonly motionResultPresentationService: IMotionResultPresentationService;
  readonly settingsService: ISettingsService;
  readonly legacyRuntimeService: ILegacyRuntimeService;
}
