import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  LibraryEntry,
  MotionPayload,
} from "../../src/domain/motion/common/motion";
import type {
  IRequestService,
  JsonRequestOptions,
  UploadPart,
  UploadRequestOptions,
} from "../../src/platform/request/common/request-service";
import type {
  GvhmrRuntimeStatus,
  HhAppBridge,
  JobStartResponse,
  UploadFile,
} from "../../src/runtime/types";
import { WorkbenchServicesProvider } from "../../src/workbench/browser/workbench-service-context";
import { useVideoBatch } from "../../src/workbench/browser/use-video-batch";
import {
  WorkbenchContributionLifecycle,
  WorkbenchLifecyclePhase,
} from "../../src/workbench/common/contribution";
import type { IWorkbenchServices } from "../../src/workbench/services/common/workbench-services";
import type {
  IJobService,
  JobStatusResponse,
  WaitForJobOptions,
} from "../../src/workbench/services/jobs/common/job-service";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

interface UploadCall {
  readonly url: string;
  readonly parts: UploadPart[];
  readonly options?: UploadRequestOptions;
}

class FakeRequestService implements IRequestService {
  readonly getCalls: Array<{ url: string; options?: JsonRequestOptions }> = [];
  readonly uploadCalls: UploadCall[] = [];
  getHandler: (
    url: string,
    options?: JsonRequestOptions,
  ) => Promise<unknown> = async () => ({});
  uploadHandler: (call: UploadCall) => Promise<unknown> = async () => {
    throw new Error("unexpected upload");
  };

  get<T>(url: string, options?: JsonRequestOptions): Promise<T> {
    this.getCalls.push({ url, options });
    return this.getHandler(url, options) as Promise<T>;
  }

  post<T>(): Promise<T> {
    throw new Error("not implemented");
  }

  patch<T>(): Promise<T> {
    throw new Error("not implemented");
  }

  delete<T>(): Promise<T> {
    throw new Error("not implemented");
  }

  upload<T>(
    url: string,
    parts: Iterable<UploadPart>,
    options?: UploadRequestOptions,
  ): Promise<T> {
    const call = { url, parts: Array.from(parts), options };
    this.uploadCalls.push(call);
    return this.uploadHandler(call) as Promise<T>;
  }
}

interface JobWaitCall {
  readonly jobId: string;
  readonly options?: WaitForJobOptions<MotionPayload>;
}

function fakeJobService(result?: Promise<MotionPayload>) {
  const calls: JobWaitCall[] = [];
  const service = {
    waitForResult<Result>(
      jobId: string,
      options?: WaitForJobOptions<Result>,
    ): Promise<Result> {
      calls.push({
        jobId,
        options: options as WaitForJobOptions<MotionPayload> | undefined,
      });
      if (!result) throw new Error("unexpected job wait");
      return result as Promise<Result>;
    },
  } as IJobService;
  return { calls, service };
}

function wrapperFor(
  requestService: IRequestService,
  jobService: IJobService,
) {
  const services = {
    requestService,
    jobService,
    hostService: {},
    settingsService: {},
    legacyRuntimeService: {
      start: vi.fn(async () => undefined),
      dispose: vi.fn(),
    },
    dispose: vi.fn(),
  } as unknown as IWorkbenchServices;
  const lifecycle = new WorkbenchContributionLifecycle(services, [], vi.fn());
  lifecycle.advanceTo(WorkbenchLifecyclePhase.Ready);

  return function Wrapper({ children }: PropsWithChildren) {
    return (
      <WorkbenchServicesProvider services={services} lifecycle={lifecycle}>
        {children}
      </WorkbenchServicesProvider>
    );
  };
}

const readyRuntime: GvhmrRuntimeStatus = {
  ready: true,
  missing: [],
  checks: {},
  root: "/opt/gvhmr",
  body_models_root: "/opt/body-models",
  image: "gvhmr:latest",
  uses_official_weights: true,
  supports_custom_weights: true,
  training_enabled: false,
};

function runningJob(
  progress: number,
  message = "",
): JobStatusResponse<MotionPayload> {
  return {
    id: "job-42",
    kind: "video_to_motion",
    status: "running",
    progress,
    clip_progress: progress,
    message,
    error: null,
    created_at: 1_700_000_000,
    finished_at: null,
    duration_seconds: 1,
    parameters: {},
    result_summary: {},
    can_download: false,
    can_copy_cli: false,
    can_retry: false,
    retry_reason: null,
    can_retry_failed: false,
    failed_item_count: 0,
    parent_job_id: null,
    scope: "current_session",
    result: null,
  };
}

afterEach(() => {
  cleanup();
  delete window.__hhApp;
  vi.restoreAllMocks();
});

describe("useVideoBatch service boundaries", () => {
  it("loads runtime status from the injected request service without a legacy bridge", async () => {
    delete window.__hhApp;
    const request = new FakeRequestService();
    request.getHandler = async () => readyRuntime;
    const jobs = fakeJobService();

    const { result } = renderHook(() => useVideoBatch("en"), {
      wrapper: wrapperFor(request, jobs.service),
    });

    await waitFor(() => expect(result.current.runtime).toEqual(readyRuntime));
    expect(request.getCalls).toHaveLength(1);
    expect(request.getCalls[0]?.url).toBe("/api/video-to-motion/status");
    expect(request.getCalls[0]?.options?.signal).toBeInstanceOf(AbortSignal);
    expect(jobs.calls).toHaveLength(0);
    expect(window.__hhApp).toBeUndefined();
  });

  it("cancels a manually refreshed runtime status when the hook unmounts", async () => {
    const request = new FakeRequestService();
    request.getHandler = async () => readyRuntime;
    const jobs = fakeJobService();
    const hook = renderHook(() => useVideoBatch("en"), {
      wrapper: wrapperFor(request, jobs.service),
    });
    await waitFor(() => expect(hook.result.current.runtime).toEqual(readyRuntime));

    request.getHandler = (_url, options) =>
      new Promise((_resolve, reject) => {
        options?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      });
    let refreshPromise!: Promise<void>;
    act(() => {
      refreshPromise = hook.result.current.refreshRuntime();
    });
    await waitFor(() => expect(request.getCalls).toHaveLength(2));
    const signal = request.getCalls[1]?.options?.signal;

    hook.unmount();
    await refreshPromise;

    expect(signal?.aborted).toBe(true);
  });

  it("does not await legacy startup before reading a cold drop event", async () => {
    delete window.__hhApp;
    const request = new FakeRequestService();
    request.getHandler = async () => readyRuntime;
    const jobs = fakeJobService();
    const { result } = renderHook(() => useVideoBatch("en"), {
      wrapper: wrapperFor(request, jobs.service),
    });
    await waitFor(() => expect(result.current.runtime).toEqual(readyRuntime));

    await act(async () => result.current.dropVideos(null));

    expect(result.current.videos).toEqual([]);
    expect(result.current.statusMessage).toBe(
      "The interface is still starting. Drop the files again shortly.",
    );
  });

  it("uploads and waits through services while composing upload and backend progress once", async () => {
    const upload = deferred<JobStartResponse>();
    const completedJob = deferred<MotionPayload>();
    const request = new FakeRequestService();
    request.getHandler = async () => readyRuntime;
    request.uploadHandler = () => upload.promise;
    const jobs = fakeJobService(completedJob.promise);
    const file = Object.assign(
      new File(["video"], "clip.mp4", { type: "video/mp4" }),
      { _relpath: "session/clip.mp4" },
    ) as UploadFile;
    const entry: LibraryEntry = {
      source_path: "/motions/session/clip.npz",
      name: "clip",
    };
    const bridge = {
      pickFiles: vi.fn(async () => [file]),
      collectDroppedFiles: vi.fn(async () => []),
      addToBasket: vi.fn(),
      refreshLibrary: vi.fn(async () => undefined),
      toast: vi.fn(),
    };
    // Deliberately omit transport and job APIs: only the narrow compatibility
    // capabilities should be observable from this hook after service injection.
    window.__hhApp = bridge as unknown as HhAppBridge;

    const { result } = renderHook(() => useVideoBatch("zh-CN"), {
      wrapper: wrapperFor(request, jobs.service),
    });
    await waitFor(() => expect(result.current.runtime?.ready).toBe(true));
    await act(async () => result.current.pickVideos());
    act(() => {
      result.current.setStaticCamera(false);
      result.current.setFocalLength("35");
      result.current.confirmEnvironment();
    });
    await waitFor(() => expect(result.current.canRun).toBe(true));

    let batchPromise!: Promise<void>;
    act(() => {
      batchPromise = result.current.runBatch();
    });
    await waitFor(() => expect(request.uploadCalls).toHaveLength(1));

    const uploadCall = request.uploadCalls[0]!;
    expect(uploadCall.url).toBe(
      "/api/video-to-motion/upload?static_cam=false&f_mm=35",
    );
    expect(uploadCall.parts).toEqual([
      { fieldName: "files", data: file, filename: "session/clip.mp4" },
    ]);
    expect(uploadCall.options?.signal).toBeInstanceOf(AbortSignal);
    act(() => {
      uploadCall.options?.onProgress?.({
        loaded: 5,
        total: 10,
        fraction: 0.5,
      });
    });
    await waitFor(() => {
      expect(result.current.videos[0]?.progress).toBeCloseTo(0.04);
      expect(result.current.videos[0]?.message).toBe("正在上传视频…… 50%");
    });

    await act(async () => {
      upload.resolve({ job_id: "job-42" });
      await Promise.resolve();
    });
    await waitFor(() => expect(jobs.calls).toHaveLength(1));
    expect(jobs.calls[0]?.jobId).toBe("job-42");
    expect(jobs.calls[0]?.options?.expectedKind).toBe("video_to_motion");
    expect(jobs.calls[0]?.options?.signal).toBe(
      uploadCall.options?.signal,
    );

    act(() => {
      jobs.calls[0]?.options?.onProgress?.(runningJob(0.5));
    });
    await waitFor(() => {
      expect(result.current.videos[0]?.progress).toBeCloseTo(0.54);
      expect(result.current.videos[0]?.message).toBe("正在生成动作…… 50%");
    });

    await act(async () => {
      completedJob.resolve({
        name: "clip motion",
        token: "motion-token",
        positions: [],
        parent_indices: [],
        library_entry: entry,
      });
      await batchPromise;
    });

    expect(result.current.videos[0]).toMatchObject({
      status: "done",
      progress: 1,
      message: "clip motion",
      result: entry,
    });
    expect(bridge.addToBasket).toHaveBeenCalledWith([entry], { silent: true });
    expect(bridge.refreshLibrary).toHaveBeenCalledOnce();
  });

  it("aborts the active upload on unmount instead of submitting later items", async () => {
    const request = new FakeRequestService();
    request.getHandler = async () => readyRuntime;
    request.uploadHandler = (call) =>
      new Promise((_resolve, reject) => {
        call.options?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      });
    const jobs = fakeJobService();
    const files = ["first.mp4", "second.mp4"].map(
      (name) => new File([name], name, { type: "video/mp4" }) as UploadFile,
    );
    window.__hhApp = {
      pickFiles: vi.fn(async () => files),
      collectDroppedFiles: vi.fn(async () => []),
      addToBasket: vi.fn(),
      refreshLibrary: vi.fn(async () => undefined),
      toast: vi.fn(),
    } as unknown as HhAppBridge;

    const hook = renderHook(() => useVideoBatch("en"), {
      wrapper: wrapperFor(request, jobs.service),
    });
    await waitFor(() => expect(hook.result.current.runtime?.ready).toBe(true));
    await act(async () => hook.result.current.pickVideos());
    act(() => hook.result.current.confirmEnvironment());
    await waitFor(() => expect(hook.result.current.canRun).toBe(true));

    let batchPromise!: Promise<void>;
    act(() => {
      batchPromise = hook.result.current.runBatch();
    });
    await waitFor(() => expect(request.uploadCalls).toHaveLength(1));
    const signal = request.uploadCalls[0]?.options?.signal;

    hook.unmount();
    await batchPromise;

    expect(signal?.aborted).toBe(true);
    expect(request.uploadCalls).toHaveLength(1);
    expect(jobs.calls).toHaveLength(0);
  });

  it("leaves the batch usable when legacy library publication fails", async () => {
    const request = new FakeRequestService();
    request.getHandler = async () => readyRuntime;
    request.uploadHandler = async () => ({ job_id: "job-42" });
    const entry: LibraryEntry = {
      source_path: "/motions/clip.npz",
      name: "clip",
    };
    const jobs = fakeJobService(
      Promise.resolve({
        name: "clip motion",
        token: "motion-token",
        positions: [],
        parent_indices: [],
        library_entry: entry,
      }),
    );
    const file = new File(["video"], "clip.mp4", {
      type: "video/mp4",
    }) as UploadFile;
    const bridge = {
      pickFiles: vi.fn(async () => [file]),
      collectDroppedFiles: vi.fn(async () => []),
      addToBasket: vi.fn(() => {
        throw new Error("basket unavailable");
      }),
      refreshLibrary: vi.fn(async () => undefined),
      toast: vi.fn(),
    };
    window.__hhApp = bridge as unknown as HhAppBridge;

    const { result } = renderHook(() => useVideoBatch("en"), {
      wrapper: wrapperFor(request, jobs.service),
    });
    await waitFor(() => expect(result.current.runtime?.ready).toBe(true));
    await act(async () => result.current.pickVideos());
    act(() => result.current.confirmEnvironment());
    await waitFor(() => expect(result.current.canRun).toBe(true));

    await act(async () => result.current.runBatch());

    expect(result.current.busy).toBe(false);
    expect(result.current.videos[0]?.status).toBe("done");
    expect(result.current.statusMessage).toContain("Library refresh failed");
    expect(result.current.statusMessage).toContain("basket unavailable");
    expect(bridge.toast).toHaveBeenLastCalledWith(
      expect.stringContaining("Library refresh failed"),
      true,
    );
  });
});
