import type { IRequestService } from "@/platform/request/common/request-service";
import type {
  GvhmrRuntimeStatus,
  JobAdmissionSettings,
  JobAdmissionSnapshot,
  MotionLibrarySettingsSnapshot,
} from "@/runtime/types";
import type { ISettingsService } from "../common/settings-service";

/**
 * Product-specific settings gateway.
 *
 * The service knows which HHTools routes represent settings, while the injected
 * request service owns JSON encoding, cancellation, and FastAPI error parsing.
 * Keeping those responsibilities separate prevents every feature from growing
 * a slightly different copy of the same transport code.
 */
export class BrowserSettingsService implements ISettingsService {
  constructor(private readonly requestService: IRequestService) {}

  getJobAdmission(): Promise<JobAdmissionSnapshot> {
    return this.requestService.get("/api/settings/job-admission");
  }

  saveJobAdmission(
    settings: JobAdmissionSettings,
  ): Promise<JobAdmissionSnapshot> {
    return this.requestService.patch(
      "/api/settings/job-admission",
      settings,
    );
  }

  getMotionLibrary(): Promise<MotionLibrarySettingsSnapshot> {
    return this.requestService.get("/api/settings/motion-library");
  }

  saveMotionLibrary(root: string): Promise<MotionLibrarySettingsSnapshot> {
    return this.requestService.patch(
      "/api/settings/motion-library",
      { root },
    );
  }

  getGvhmrRuntime(): Promise<GvhmrRuntimeStatus> {
    return this.requestService.get("/api/video-to-motion/status");
  }
}
