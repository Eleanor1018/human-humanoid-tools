import { requestJson, type Fetcher } from "@/lib/api";

export interface JobAdmissionSnapshot {
  readonly mode: "unlimited" | "queued" | string;
  readonly max_running_jobs: number;
  readonly max_queued_jobs: number;
  readonly running_jobs: number;
  readonly queued_jobs: number;
  readonly reserved_jobs: number;
  readonly cancelling_jobs: number;
  readonly closed: boolean;
  readonly editable: boolean;
}

export interface JobAdmissionLimits {
  readonly max_running_jobs: number;
  readonly max_queued_jobs: number;
}

export function getJobAdmissionSettings(
  options: { readonly signal?: AbortSignal; readonly fetcher?: Fetcher } = {},
): Promise<JobAdmissionSnapshot> {
  return requestJson<JobAdmissionSnapshot>(
    "/api/settings/job-admission",
    { signal: options.signal },
    options.fetcher,
  );
}

export function updateJobAdmissionSettings(
  limits: JobAdmissionLimits,
  options: { readonly signal?: AbortSignal; readonly fetcher?: Fetcher } = {},
): Promise<JobAdmissionSnapshot> {
  return requestJson<JobAdmissionSnapshot>(
    "/api/settings/job-admission",
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(limits),
      signal: options.signal,
    },
    options.fetcher,
  );
}
