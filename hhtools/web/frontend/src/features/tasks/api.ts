import { requestJson, type Fetcher } from "@/lib/api";

export type TaskStatus = "pending" | "running" | "done" | "error";

export interface TaskRecord {
  readonly id: string;
  readonly kind: string;
  readonly status: TaskStatus;
  readonly progress: number;
  readonly message?: string | null;
  readonly error?: string | null;
  readonly created_at: number;
  readonly duration_seconds: number;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly result_summary: Readonly<Record<string, unknown>>;
  readonly can_download: boolean;
}

interface TaskListResponse {
  readonly jobs: readonly TaskRecord[];
}

const RESULT_TASK_KINDS: ReadonlySet<string> = new Set([
  "video_to_motion",
  "retarget",
  "r2r_retarget",
  "batch",
  "r2r_batch",
]);

export function isWorkflowResultTask(
  task: Pick<TaskRecord, "kind">,
): boolean {
  return RESULT_TASK_KINDS.has(task.kind);
}

export function canExportTaskResult(
  task: Pick<TaskRecord, "kind" | "can_download">,
): boolean {
  return task.can_download && isWorkflowResultTask(task);
}

export async function listTasks(options: {
  readonly signal?: AbortSignal;
  readonly fetcher?: Fetcher;
} = {}): Promise<readonly TaskRecord[]> {
  const response = await requestJson<TaskListResponse>(
    "/api/jobs?limit=50",
    { signal: options.signal },
    options.fetcher,
  );
  return response.jobs;
}

export function taskDownloadUrl(taskId: string): string {
  return `/api/job/${encodeURIComponent(taskId)}/download`;
}
