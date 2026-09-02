import type { Event } from "@/base/common/event";
import type { IDisposable } from "@/base/common/disposable";
import type {
  JobCliResponse,
  JobConfigResponse,
  JobHistoryRecord,
  JobReplayResponse,
  JobSpec,
  JobSpecValidationResponse,
} from "@/runtime/types";

/** Read-only projection intended for task-history views. */
export interface JobHistorySnapshot {
  readonly jobs: readonly JobHistoryRecord[];
  readonly loading: boolean;
  readonly error: string | null;
}

/** Small result retained on disk after the live job leaves server memory. */
export interface PersistedJobArtifact {
  readonly artifact_path: string | null;
  readonly download_name: string | null;
}

/**
 * `/api/job/:id` has two deliberately different result shapes.
 *
 * A current-session job may contain the feature's full `Result`; a persisted
 * history record contains only enough metadata to download its artifact. The
 * discriminated union prevents feature code from treating the latter as, for
 * example, a motion payload merely because both arrive from the same route.
 */
export type JobStatusResponse<Result = unknown> = Omit<
  JobHistoryRecord,
  "scope"
> &
  (
    | {
        readonly scope: "current_session";
        readonly result: Result | null;
      }
    | {
        readonly scope: "persistent";
        readonly result: PersistedJobArtifact;
      }
  );

export interface WaitForJobOptions<Result = unknown> {
  /** Stops this browser-side wait only; it does not cancel backend work. */
  readonly signal?: AbortSignal;
  readonly pollIntervalMs?: number;
  readonly expectedKind?: string;
  /** Receives the unweighted backend snapshot, including terminal states. */
  readonly onProgress?: (job: JobStatusResponse<Result>) => void;
}

export interface WatchJobHistoryOptions {
  readonly intervalMs?: number;
  readonly limit?: number;
}

/** Terminal backend failure, retaining the final snapshot for diagnostics. */
export class JobFailedError extends Error {
  constructor(readonly job: JobStatusResponse<unknown>) {
    super(job.error || "Job failed");
    this.name = "JobFailedError";
  }
}

/**
 * Workbench boundary for the WebUI's durable background jobs.
 *
 * Feature code still owns job creation because request/result payloads are
 * domain-specific. This service owns the shared status, history and replay
 * protocol after a feature endpoint returns a `job_id`.
 */
export interface IJobService extends IDisposable {
  readonly history: JobHistorySnapshot;
  readonly onDidChangeHistory: Event<JobHistorySnapshot>;

  refreshHistory(limit?: number): Promise<JobHistorySnapshot>;
  watchHistory(options?: WatchJobHistoryOptions): IDisposable;

  getJob<Result = unknown>(
    jobId: string,
    options?: { readonly signal?: AbortSignal },
  ): Promise<JobStatusResponse<Result>>;
  waitForResult<Result = unknown>(
    jobId: string,
    options?: WaitForJobOptions<Result>,
  ): Promise<Result>;

  getConfig(jobId: string): Promise<JobConfigResponse>;
  getCli(jobId: string): Promise<JobCliResponse>;
  validateSpec(input: unknown): Promise<JobSpecValidationResponse>;
  replayJob(
    jobId: string,
    options?: { readonly failedOnly?: boolean },
  ): Promise<JobReplayResponse>;
  runSpec(spec: JobSpec): Promise<JobReplayResponse>;
}
