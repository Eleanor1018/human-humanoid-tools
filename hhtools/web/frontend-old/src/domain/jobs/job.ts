/**
 * Stable background-job contracts shared by every renderer-side client.
 *
 * These shapes mirror the FastAPI JSON schema, so their snake_case fields are
 * intentional. They live below Workbench services because a JobSpec or saved
 * job record remains meaningful without React, browser APIs, or a transport
 * implementation.
 */

export type JobStatus = "pending" | "running" | "done" | "error";

export type JobParameterValue = string | number | boolean;

export interface JobHistoryRecord {
  id: string;
  kind: string;
  status: JobStatus;
  progress: number;
  clip_progress: number;
  message: string;
  error: string | null;
  created_at: number;
  finished_at: number | null;
  duration_seconds: number;
  parameters: Record<string, JobParameterValue>;
  result_summary: Record<string, JobParameterValue>;
  can_download: boolean;
  can_copy_cli: boolean;
  can_retry: boolean;
  retry_reason: string | null;
  can_retry_failed: boolean;
  failed_item_count: number;
  parent_job_id: string | null;
  scope: "current_session" | "persistent";
}

export interface JobListResponse {
  jobs: JobHistoryRecord[];
  session_only: boolean;
  persistence: "disk";
}

export interface JobCliResponse {
  available: boolean;
  command: string | null;
  reason: string | null;
}

export interface JobReplayCapability {
  available: boolean;
  reason: string | null;
  source_count: number;
}

/** Portable, versioned description accepted by every job entry point. */
export interface JobSpec {
  schema_version: number;
  kind: string;
  request: Record<string, unknown>;
}

export interface JobSpecValidationResponse {
  spec: JobSpec;
  replay: JobReplayCapability;
}

export interface JobReplayResponse {
  job_id: string;
  parent_job_id: string | null;
  spec: JobSpec;
}

export interface JobConfigResponse {
  schema_version: number;
  job_id: string;
  kind: string;
  status: JobStatus;
  created_at: number;
  finished_at: number | null;
  scope: "current_session" | "persistent";
  request: Record<string, unknown>;
  cli: JobCliResponse;
  spec: JobSpec;
  replay: JobReplayCapability;
  parent_job_id: string | null;
}
