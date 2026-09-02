import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  IRequestService,
  JsonRequestOptions,
  UploadPart,
  UploadRequestOptions,
} from "../../src/platform/request/common/request-service";
import type {
  JobHistoryRecord,
  JobListResponse,
  JobSpec,
} from "../../src/runtime/types";
import { BrowserJobService } from "../../src/workbench/services/jobs/browser/browser-job-service";
import { JobFailedError } from "../../src/workbench/services/jobs/common/job-service";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class FakeRequestService implements IRequestService {
  readonly getCalls: Array<{ url: string; options?: JsonRequestOptions }> = [];
  readonly postCalls: Array<{
    url: string;
    body: unknown;
    options?: JsonRequestOptions;
  }> = [];
  getHandler: (
    url: string,
    options?: JsonRequestOptions,
  ) => Promise<unknown> = async () => ({});
  postHandler: (
    url: string,
    body: unknown,
    options?: JsonRequestOptions,
  ) => Promise<unknown> = async () => ({});

  get<T>(url: string, options?: JsonRequestOptions): Promise<T> {
    this.getCalls.push({ url, options });
    return this.getHandler(url, options) as Promise<T>;
  }

  post<T>(
    url: string,
    body?: unknown,
    options?: JsonRequestOptions,
  ): Promise<T> {
    this.postCalls.push({ url, body, options });
    return this.postHandler(url, body, options) as Promise<T>;
  }

  patch<T>(): Promise<T> {
    throw new Error("not implemented");
  }

  delete<T>(): Promise<T> {
    throw new Error("not implemented");
  }

  upload<T>(
    _url: string,
    _parts: Iterable<UploadPart>,
    _options?: UploadRequestOptions,
  ): Promise<T> {
    throw new Error("not implemented");
  }
}

function job(
  status: JobHistoryRecord["status"],
  overrides: Partial<JobHistoryRecord & { result: unknown }> = {},
) {
  return {
    id: "job-1",
    kind: "retarget",
    status,
    progress: status === "done" ? 1 : 0.25,
    clip_progress: 0,
    message: status,
    error: status === "error" ? "solver failed" : null,
    created_at: 1_700_000_000,
    finished_at: status === "pending" || status === "running" ? null : 1_700_000_001,
    duration_seconds: 1,
    parameters: {},
    result_summary: {},
    can_download: false,
    can_copy_cli: false,
    can_retry: status === "done" || status === "error",
    retry_reason: null,
    can_retry_failed: false,
    failed_item_count: 0,
    parent_job_id: null,
    scope: "current_session" as const,
    result: null,
    ...overrides,
  };
}

function historyResponse(jobs: JobHistoryRecord[] = []): JobListResponse {
  return { jobs, session_only: false, persistence: "disk" };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("BrowserJobService history", () => {
  it("publishes immutable-style snapshots and deduplicates an active refresh", async () => {
    const request = new FakeRequestService();
    const pending = deferred<JobListResponse>();
    request.getHandler = () => pending.promise;
    const service = new BrowserJobService(request);
    const snapshots: Array<{ loading: boolean; count: number }> = [];
    service.onDidChangeHistory((snapshot) =>
      snapshots.push({ loading: snapshot.loading, count: snapshot.jobs.length }),
    );

    const first = service.refreshHistory(25);
    const duplicate = service.refreshHistory(100);

    expect(duplicate).toBe(first);
    expect(request.getCalls).toHaveLength(1);
    expect(request.getCalls[0]?.url).toBe("/api/jobs?limit=25");
    pending.resolve(historyResponse([job("done") as JobHistoryRecord]));

    await expect(first).resolves.toMatchObject({ loading: false, error: null });
    expect(service.history.jobs).toHaveLength(1);
    expect(snapshots).toEqual([
      { loading: true, count: 0 },
      { loading: false, count: 1 },
    ]);
  });

  it("records list failures in the shared snapshot", async () => {
    const request = new FakeRequestService();
    request.getHandler = async () => {
      throw new Error("history unavailable");
    };
    const service = new BrowserJobService(request);

    await expect(service.refreshHistory()).resolves.toMatchObject({
      loading: false,
      error: "history unavailable",
    });
  });

  it("starts immediately and stops its periodic watcher when disposed", async () => {
    vi.useFakeTimers();
    const request = new FakeRequestService();
    request.getHandler = async () => historyResponse();
    const service = new BrowserJobService(request);

    const watcher = service.watchHistory({ intervalMs: 1_000, limit: 10 });
    await vi.advanceTimersByTimeAsync(0);
    expect(request.getCalls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(request.getCalls).toHaveLength(2);
    watcher.dispose();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(request.getCalls).toHaveLength(2);
  });
});

describe("BrowserJobService completion", () => {
  it("aborts a direct status request when the service is disposed", async () => {
    const request = new FakeRequestService();
    request.getHandler = (_url, options) =>
      new Promise((_resolve, reject) => {
        options?.signal?.addEventListener(
          "abort",
          () => reject(options.signal?.reason),
          { once: true },
        );
      });
    const service = new BrowserJobService(request);

    const result = service.getJob("job-1");
    service.dispose();

    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(request.getCalls[0]?.options?.signal?.aborted).toBe(true);
  });

  it("polls pending and running jobs, reports raw snapshots, then returns the result", async () => {
    vi.useFakeTimers();
    const request = new FakeRequestService();
    const replies = [
      job("pending", { progress: 0 }),
      job("running", { progress: 0.4 }),
      job("done", { progress: 1, result: { frames: 42 } }),
    ];
    request.getHandler = async () => replies.shift();
    const service = new BrowserJobService(request);
    const progress: Array<[string, number]> = [];

    const result = service.waitForResult<{ frames: number }>("job/with space", {
      expectedKind: "retarget",
      pollIntervalMs: 100,
      onProgress: (snapshot) =>
        progress.push([snapshot.status, snapshot.progress]),
    });
    await vi.advanceTimersByTimeAsync(200);

    await expect(result).resolves.toEqual({ frames: 42 });
    expect(request.getCalls.map((call) => call.url)).toEqual([
      "/api/job/job%2Fwith%20space",
      "/api/job/job%2Fwith%20space",
      "/api/job/job%2Fwith%20space",
    ]);
    expect(progress).toEqual([
      ["pending", 0],
      ["running", 0.4],
      ["done", 1],
    ]);
  });

  it("throws JobFailedError with the terminal snapshot", async () => {
    const request = new FakeRequestService();
    const failed = job("error", { error: "IK exploded" });
    request.getHandler = async () => failed;
    const service = new BrowserJobService(request);

    const error = await service.waitForResult("job-1").catch((cause) => cause);

    expect(error).toBeInstanceOf(JobFailedError);
    expect(error).toMatchObject({ message: "IK exploded", job: failed });
  });

  it("rejects a done job that omitted its result", async () => {
    const request = new FakeRequestService();
    request.getHandler = async () => job("done");
    const service = new BrowserJobService(request);

    await expect(service.waitForResult("job-1")).rejects.toThrow(
      "Job job-1 completed without a result",
    );
  });

  it("does not cast a compact persisted artifact to a live workflow result", async () => {
    const request = new FakeRequestService();
    request.getHandler = async () =>
      job("done", {
        scope: "persistent",
        result: {
          artifact_path: "/history/result.zip",
          download_name: "result.zip",
        },
      });
    const service = new BrowserJobService(request);
    const onProgress = vi.fn();

    await expect(
      service.waitForResult("job-1", { onProgress }),
    ).rejects.toThrow("no longer has an in-memory result");
    expect(onProgress).not.toHaveBeenCalled();
  });

  it("checks the expected job kind before accepting a result", async () => {
    const request = new FakeRequestService();
    request.getHandler = async () =>
      job("done", { kind: "batch", result: { written: [] } });
    const service = new BrowserJobService(request);

    await expect(
      service.waitForResult("job-1", { expectedKind: "retarget" }),
    ).rejects.toThrow("has kind batch; expected retarget");
  });

  it("honors caller cancellation without starting another poll", async () => {
    vi.useFakeTimers();
    const request = new FakeRequestService();
    request.getHandler = async () => job("pending");
    const service = new BrowserJobService(request);
    const controller = new AbortController();

    const result = service.waitForResult("job-1", {
      signal: controller.signal,
      pollIntervalMs: 1_000,
    });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();

    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(request.getCalls).toHaveLength(1);
  });

  it("dispose stops browser-side polling but does not expose backend cancellation", async () => {
    vi.useFakeTimers();
    const request = new FakeRequestService();
    request.getHandler = async () => job("running");
    const service = new BrowserJobService(request);

    const result = service.waitForResult("job-1", { pollIntervalMs: 1_000 });
    await vi.advanceTimersByTimeAsync(0);
    service.dispose();

    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(request.getCalls).toHaveLength(1);
  });
});

describe("BrowserJobService commands", () => {
  it("encodes IDs and maps config, CLI, validation and replay requests", async () => {
    const request = new FakeRequestService();
    request.getHandler = async (url) => ({ url });
    request.postHandler = async (url, body) => ({ url, body });
    const service = new BrowserJobService(request);
    const spec: JobSpec = {
      schema_version: 1,
      kind: "retarget",
      request: { robot: "g1" },
    };

    await service.getConfig("job/a b");
    await service.getCli("job/a b");
    await service.validateSpec({ spec });
    await service.replayJob("job/a b", { failedOnly: true });
    await service.runSpec(spec);

    expect(request.getCalls.map((call) => call.url)).toEqual([
      "/api/job/job%2Fa%20b/config",
      "/api/job/job%2Fa%20b/cli",
    ]);
    expect(request.postCalls.map(({ url, body }) => ({ url, body }))).toEqual([
      { url: "/api/jobs/spec/validate", body: { spec } },
      {
        url: "/api/jobs/replay",
        body: { job_id: "job/a b", failed_only: true },
      },
      { url: "/api/jobs/replay", body: { spec } },
    ]);
  });
});
