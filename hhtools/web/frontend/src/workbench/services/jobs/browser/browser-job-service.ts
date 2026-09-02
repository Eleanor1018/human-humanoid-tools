import { Emitter } from "@/base/common/event";
import { toDisposable, type IDisposable } from "@/base/common/disposable";
import type {
  JobCliResponse,
  JobConfigResponse,
  JobListResponse,
  JobReplayResponse,
  JobSpec,
  JobSpecValidationResponse,
} from "@/domain/jobs/job";
import type { IRequestService } from "@/platform/request/common/request-service";
import {
  JobFailedError,
  type IJobService,
  type JobHistorySnapshot,
  type JobStatusResponse,
  type WaitForJobOptions,
  type WatchJobHistoryOptions,
} from "../common/job-service";

const DEFAULT_HISTORY_LIMIT = 50;
const DEFAULT_HISTORY_INTERVAL_MS = 2_500;
const DEFAULT_JOB_POLL_INTERVAL_MS = 500;

function abortError(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError");
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason instanceof Error ? signal.reason : abortError();
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function boundedHistoryLimit(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_HISTORY_LIMIT;
  return Math.max(1, Math.min(100, Math.trunc(value!)));
}

function positiveInterval(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || value! <= 0) return fallback;
  return Math.max(1, Math.trunc(value!));
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      window.clearTimeout(timer);
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Combine caller cancellation with service disposal without relying on the
 * newer `AbortSignal.any`, which is not available in every Electron runtime.
 */
function linkedAbortSignal(
  signals: readonly (AbortSignal | undefined)[],
): { readonly signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const listeners: Array<readonly [AbortSignal, () => void]> = [];
  for (const source of signals) {
    if (!source) continue;
    if (source.aborted) {
      controller.abort(abortReason(source));
      break;
    }
    const listener = () => controller.abort(abortReason(source));
    source.addEventListener("abort", listener, { once: true });
    listeners.push([source, listener]);
  }
  return {
    signal: controller.signal,
    dispose: () => {
      for (const [source, listener] of listeners) {
        source.removeEventListener("abort", listener);
      }
    },
  };
}

/** Browser implementation of the shared WebUI job protocol. */
export class BrowserJobService implements IJobService {
  readonly #requestService: IRequestService;
  readonly #historyEmitter = new Emitter<JobHistorySnapshot>();
  readonly #disposeController = new AbortController();
  readonly #historyTimers = new Set<number>();
  #disposed = false;
  #history: JobHistorySnapshot = {
    jobs: [],
    loading: false,
    error: null,
  };
  #historyRefresh: Promise<JobHistorySnapshot> | null = null;

  readonly onDidChangeHistory = this.#historyEmitter.event;

  constructor(requestService: IRequestService) {
    this.#requestService = requestService;
  }

  get history(): JobHistorySnapshot {
    return this.#history;
  }

  refreshHistory(limit = DEFAULT_HISTORY_LIMIT): Promise<JobHistorySnapshot> {
    if (this.#disposed) return Promise.reject(abortError());
    // One in-flight list request owns the shared snapshot. A concurrent caller
    // joins it even if it requested another limit, avoiding racing list views.
    if (this.#historyRefresh) return this.#historyRefresh;

    this.#setHistory({ ...this.#history, loading: true, error: null });
    const boundedLimit = boundedHistoryLimit(limit);
    this.#historyRefresh = (async () => {
      try {
        const response = await this.#requestService.get<JobListResponse>(
          `/api/jobs?limit=${boundedLimit}`,
          { signal: this.#disposeController.signal },
        );
        if (!this.#disposed) {
          this.#setHistory({
            jobs: [...response.jobs],
            loading: false,
            error: null,
          });
        }
      } catch (error) {
        if (!this.#disposed) {
          this.#setHistory({
            ...this.#history,
            loading: false,
            error: errorMessage(error),
          });
        }
      } finally {
        this.#historyRefresh = null;
      }
      return this.#history;
    })();
    return this.#historyRefresh;
  }

  watchHistory(options: WatchJobHistoryOptions = {}): IDisposable {
    if (this.#disposed) return toDisposable(() => undefined);
    const intervalMs = positiveInterval(
      options.intervalMs,
      DEFAULT_HISTORY_INTERVAL_MS,
    );
    const limit = boundedHistoryLimit(options.limit);
    void this.refreshHistory(limit);
    const timer = window.setInterval(() => {
      void this.refreshHistory(limit);
    }, intervalMs);
    this.#historyTimers.add(timer);
    return toDisposable(() => {
      if (!this.#historyTimers.delete(timer)) return;
      window.clearInterval(timer);
    });
  }

  async getJob<Result = unknown>(
    jobId: string,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<JobStatusResponse<Result>> {
    if (this.#disposed) throw abortError();
    const linked = linkedAbortSignal([
      this.#disposeController.signal,
      options.signal,
    ]);
    try {
      return await this.#requestService.get<JobStatusResponse<Result>>(
        `/api/job/${encodeURIComponent(jobId)}`,
        { signal: linked.signal },
      );
    } finally {
      linked.dispose();
    }
  }

  async waitForResult<Result = unknown>(
    jobId: string,
    options: WaitForJobOptions<Result> = {},
  ): Promise<Result> {
    if (this.#disposed) throw abortError();
    const linked = linkedAbortSignal([
      this.#disposeController.signal,
      options.signal,
    ]);
    const intervalMs = positiveInterval(
      options.pollIntervalMs,
      DEFAULT_JOB_POLL_INTERVAL_MS,
    );

    try {
      for (;;) {
        throwIfAborted(linked.signal);
        const job = await this.getJob<Result>(jobId, {
          signal: linked.signal,
        });
        throwIfAborted(linked.signal);
        if (options.expectedKind && job.kind !== options.expectedKind) {
          throw new Error(
            `Job ${job.id} has kind ${job.kind}; expected ${options.expectedKind}`,
          );
        }

        if (job.status === "done") {
          // Reject before invoking the generic progress callback. Persisted
          // jobs contain only artifact metadata, not the workflow's `Result`.
          if (job.scope === "persistent") {
            throw new Error(
              `Job ${job.id} no longer has an in-memory result; use its saved artifact instead`,
            );
          }
          options.onProgress?.(job);
          if (job.result == null) {
            throw new Error(`Job ${job.id} completed without a result`);
          }
          return job.result;
        }
        options.onProgress?.(job);
        if (job.status === "error") throw new JobFailedError(job);
        if (job.status !== "pending" && job.status !== "running") {
          throw new Error(`Job ${job.id} returned unknown status ${job.status}`);
        }
        await delay(intervalMs, linked.signal);
      }
    } finally {
      linked.dispose();
    }
  }

  getConfig(jobId: string): Promise<JobConfigResponse> {
    return this.#getForJob<JobConfigResponse>(jobId, "config");
  }

  getCli(jobId: string): Promise<JobCliResponse> {
    return this.#getForJob<JobCliResponse>(jobId, "cli");
  }

  validateSpec(input: unknown): Promise<JobSpecValidationResponse> {
    return this.#post<JobSpecValidationResponse>(
      "/api/jobs/spec/validate",
      input,
    );
  }

  replayJob(
    jobId: string,
    options: { readonly failedOnly?: boolean } = {},
  ): Promise<JobReplayResponse> {
    return this.#post<JobReplayResponse>("/api/jobs/replay", {
      job_id: jobId,
      ...(options.failedOnly ? { failed_only: true } : {}),
    });
  }

  runSpec(spec: JobSpec): Promise<JobReplayResponse> {
    return this.#post<JobReplayResponse>("/api/jobs/replay", { spec });
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    // Aborting these waits only releases browser resources. The Web API has no
    // cancellation endpoint, so already-admitted backend jobs continue running.
    this.#disposeController.abort(abortError());
    for (const timer of this.#historyTimers) window.clearInterval(timer);
    this.#historyTimers.clear();
    this.#historyEmitter.dispose();
  }

  #setHistory(snapshot: JobHistorySnapshot): void {
    this.#history = snapshot;
    this.#historyEmitter.fire(snapshot);
  }

  #getForJob<Result>(jobId: string, suffix: "config" | "cli"): Promise<Result> {
    if (this.#disposed) return Promise.reject(abortError());
    return this.#requestService.get<Result>(
      `/api/job/${encodeURIComponent(jobId)}/${suffix}`,
      { signal: this.#disposeController.signal },
    );
  }

  #post<Result>(url: string, body: unknown): Promise<Result> {
    if (this.#disposed) return Promise.reject(abortError());
    return this.#requestService.post<Result>(url, body, {
      signal: this.#disposeController.signal,
    });
  }
}
