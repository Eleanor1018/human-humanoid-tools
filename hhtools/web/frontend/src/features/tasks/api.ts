import { requestJson, type Fetcher } from "@/lib/api";
import { createRequestCache } from "@/lib/requestCache";

export type TaskStatus = "pending" | "running" | "done" | "error" | "cancelled";

export interface TaskRecord {
  readonly id: string;
  readonly kind: string;
  readonly status: TaskStatus;
  readonly outcome?: "success" | "partial" | "review_required" | "rejected" | null;
  readonly progress: number;
  readonly message?: string | null;
  readonly error?: string | null;
  readonly created_at: number;
  readonly duration_seconds: number;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly result_summary: Readonly<Record<string, unknown>>;
  readonly can_download: boolean;
  readonly can_cancel?: boolean;
  readonly can_retry?: boolean;
  readonly can_open?: boolean;
}

interface TaskListResponse {
  readonly jobs: readonly TaskRecord[];
}

const taskListCache = createRequestCache<readonly TaskRecord[]>(250);

const RESULT_TASK_KINDS: ReadonlySet<string> = new Set([
  "retarget_export",
  "analysis_export",
  "preview_render",
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
  const load = async (signal?: AbortSignal, fetcher?: Fetcher) => {
    const response = await requestJson<TaskListResponse>(
      "/api/jobs?limit=50",
      { signal },
      fetcher,
    );
    return response.jobs;
  };
  if (options.fetcher) return load(options.signal, options.fetcher);
  return taskListCache.read(() => load(), options.signal);
}

export function taskDownloadUrl(taskId: string): string {
  return `/api/job/${encodeURIComponent(taskId)}/download`;
}
