import type {
  GvhmrRuntimeStatus,
  JobAdmissionSettings,
  JobAdmissionSnapshot,
  MotionLibrarySettingsSnapshot,
} from "@/runtime/types";

/** Settings operations exposed to the workbench, independent of HTTP details. */
export interface ISettingsService {
  getJobAdmission(): Promise<JobAdmissionSnapshot>;
  saveJobAdmission(
    settings: JobAdmissionSettings,
  ): Promise<JobAdmissionSnapshot>;
  getMotionLibrary(): Promise<MotionLibrarySettingsSnapshot>;
  saveMotionLibrary(root: string): Promise<MotionLibrarySettingsSnapshot>;
  getGvhmrRuntime(): Promise<GvhmrRuntimeStatus>;
}
