import {
  act,
  cleanup,
  renderHook,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { MotionPayload } from "../../src/domain/motion/common/motion";
import type {
  JsonRequestOptions,
  UploadPart,
  UploadRequestOptions,
} from "../../src/platform/request/common/request-service";
import type {
  VideoPreviewUrlPort,
  VideoToMotionJobPort,
  VideoToMotionPresentationPort,
  VideoToMotionRequestPort,
  VideoToMotionRuntimeStatus,
} from "../../src/workbench/contrib/video-to-motion/browser/video-to-motion-controller";
import { useVideoToMotionController } from "../../src/workbench/contrib/video-to-motion/browser/use-video-to-motion-controller";
import type { WaitForJobOptions } from "../../src/workbench/services/jobs/common/job-service";

interface GetCall {
  readonly url: string;
  readonly options?: JsonRequestOptions;
}

interface UploadCall {
  readonly url: string;
  readonly parts: readonly UploadPart[];
  readonly options?: UploadRequestOptions;
}

class FakeRequestService implements VideoToMotionRequestPort {
  readonly getCalls: GetCall[] = [];
  readonly uploadCalls: UploadCall[] = [];
  getHandler: (call: GetCall) => Promise<unknown> = async () =>
    readyRuntime;
  uploadHandler: (call: UploadCall) => Promise<unknown> = async () => ({
    job_id: "job-1",
  });

  get<T>(url: string, options?: JsonRequestOptions): Promise<T> {
    const call = { url, options };
    this.getCalls.push(call);
    return this.getHandler(call) as Promise<T>;
  }

  upload<T>(
    url: string,
    parts: Iterable<UploadPart>,
    options?: UploadRequestOptions,
  ): Promise<T> {
    const call = { url, parts: [...parts], options };
    this.uploadCalls.push(call);
    return this.uploadHandler(call) as Promise<T>;
  }
}

interface JobCall {
  readonly jobId: string;
  readonly options?: WaitForJobOptions<MotionPayload>;
}

class FakeJobService implements VideoToMotionJobPort {
  readonly calls: JobCall[] = [];
  waitHandler: (call: JobCall) => Promise<MotionPayload> = async () =>
    motion("generated");

  waitForResult<Result>(
    jobId: string,
    options?: WaitForJobOptions<Result>,
  ): Promise<Result> {
    const call = {
      jobId,
      options: options as WaitForJobOptions<MotionPayload> | undefined,
    };
    this.calls.push(call);
    return this.waitHandler(call) as Promise<Result>;
  }
}

class FakePresentationService implements VideoToMotionPresentationPort {
  readonly calls: MotionPayload[] = [];

  async presentHumanMotion(payload: MotionPayload): Promise<void> {
    this.calls.push(payload);
  }
}

const readyRuntime: VideoToMotionRuntimeStatus = {
  ready: true,
  missing: [],
  checks: { python: true },
};

function motion(name: string): MotionPayload {
  return {
    name,
    token: `${name}-token`,
    positions: [],
    parent_indices: [],
  };
}

function video(name: string): File {
  return new File([name], name, { type: "video/mp4" });
}

function createHarness() {
  const requestService = new FakeRequestService();
  const jobService = new FakeJobService();
  const presentationService = new FakePresentationService();
  let nextPreview = 1;
  const previewUrls: VideoPreviewUrlPort = {
    createObjectURL: vi.fn(() => `blob:preview-${nextPreview++}`),
    revokeObjectURL: vi.fn(),
  };
  const reportError = vi.fn();
  const options = {
    requestService,
    jobService,
    presentationService,
    previewUrls,
    reportError,
  };
  return {
    jobService,
    options,
    presentationService,
    previewUrls,
    reportError,
    requestService,
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("useVideoToMotionController", () => {
  it("subscribes renderer state and exposes stable ref-backed workflow actions", async () => {
    const harness = createHarness();
    harness.jobService.waitHandler = async (call) =>
      motion(call.options?.expectedKind === "motion_link" ? "imported" : "generated");
    const hook = renderHook(
      () => useVideoToMotionController(harness.options),
    );

    await waitFor(() =>
      expect(hook.result.current.state?.runtimePhase).toBe("ready"),
    );
    const actions = {
      selectVideo: hook.result.current.selectVideo,
      selectCheckpoint: hook.result.current.selectCheckpoint,
      setWeightSource: hook.result.current.setWeightSource,
      setStaticCamera: hook.result.current.setStaticCamera,
      setFocalLength: hook.result.current.setFocalLength,
      setPreviewDuration: hook.result.current.setPreviewDuration,
      confirmEnvironment: hook.result.current.confirmEnvironment,
      refreshRuntime: hook.result.current.refreshRuntime,
      run: hook.result.current.run,
      importResult: hook.result.current.importResult,
    };

    await act(async () => hook.result.current.refreshRuntime());
    expect(harness.requestService.getCalls).toHaveLength(2);

    act(() => hook.result.current.selectVideo(video("walk.mp4")));
    expect(hook.result.current.canConfirmEnvironment).toBe(true);
    act(() => hook.result.current.setWeightSource("custom"));
    expect(hook.result.current.canConfirmEnvironment).toBe(false);
    act(() => {
      hook.result.current.selectCheckpoint(
        new File(["weights"], "model.ckpt"),
      );
      hook.result.current.setStaticCamera(false);
      hook.result.current.setFocalLength("35");
      hook.result.current.setPreviewDuration("blob:preview-1", 2.5);
    });
    expect(hook.result.current.state?.video?.duration).toBe(2.5);
    expect(hook.result.current.canConfirmEnvironment).toBe(true);
    act(() => {
      expect(hook.result.current.confirmEnvironment()).toBe(true);
    });
    expect(hook.result.current.canRun).toBe(true);

    let generated!: MotionPayload;
    await act(async () => {
      generated = await hook.result.current.run();
    });
    expect(generated.name).toBe("generated");
    expect(harness.requestService.uploadCalls[0]).toMatchObject({
      url: "/api/video-to-motion/upload?static_cam=false&f_mm=35",
      parts: [
        { fieldName: "files", filename: "walk.mp4" },
        { fieldName: "checkpoint", filename: "model.ckpt" },
      ],
    });
    expect(harness.jobService.calls[0]?.options?.expectedKind).toBe(
      "video_to_motion",
    );

    let imported!: MotionPayload;
    await act(async () => {
      imported = await hook.result.current.importResult(
        new File(["motion"], "existing.pt"),
      );
    });
    expect(imported.name).toBe("imported");
    expect(harness.requestService.uploadCalls[1]).toMatchObject({
      url: "/api/motion/upload?profile=mimic",
      parts: [{ fieldName: "files", filename: "existing.pt" }],
    });
    expect(harness.jobService.calls[1]?.options?.expectedKind).toBe(
      "motion_link",
    );
    expect(harness.presentationService.calls.map(({ name }) => name)).toEqual([
      "generated",
      "imported",
    ]);
    expect(hook.result.current.state).toMatchObject({
      operation: "import",
      stage: "completed",
      result: { name: "imported" },
    });

    // State changes replace the model projection, but never its actions.
    for (const [name, action] of Object.entries(actions)) {
      expect(hook.result.current[name as keyof typeof actions]).toBe(action);
    }
  });

  it("creates a fresh owner after the React 19 StrictMode cleanup cycle", async () => {
    const harness = createHarness();
    harness.requestService.getHandler = (call) => {
      if (harness.requestService.getCalls.length === 1) {
        return new Promise((_resolve, reject) => {
          call.options?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        });
      }
      return Promise.resolve(readyRuntime);
    };

    const hook = renderHook(
      () => useVideoToMotionController(harness.options),
      { reactStrictMode: true },
    );

    await waitFor(() =>
      expect(harness.requestService.getCalls).toHaveLength(2),
    );
    expect(
      harness.requestService.getCalls[0]?.options?.signal?.aborted,
    ).toBe(true);
    await waitFor(() =>
      expect(hook.result.current.state?.runtimePhase).toBe("ready"),
    );

    // This would throw AbortError if the second setup reused the controller
    // disposed by StrictMode's first cleanup.
    act(() => hook.result.current.selectVideo(video("strict.mp4")));
    expect(hook.result.current.state?.video?.name).toBe("strict.mp4");
    expect(harness.previewUrls.createObjectURL).toHaveBeenCalledOnce();
    expect(harness.reportError).not.toHaveBeenCalled();
  });

  it("aborts active work and revokes exactly the currently owned preview on unmount", async () => {
    const harness = createHarness();
    harness.requestService.uploadHandler = (call) =>
      new Promise((_resolve, reject) => {
        call.options?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      });
    const hook = renderHook(
      () => useVideoToMotionController(harness.options),
    );
    await waitFor(() =>
      expect(hook.result.current.state?.runtime?.ready).toBe(true),
    );

    act(() => {
      hook.result.current.selectVideo(video("first.mp4"));
      hook.result.current.selectVideo(video("second.mp4"));
      hook.result.current.confirmEnvironment();
    });
    expect(harness.previewUrls.revokeObjectURL).toHaveBeenCalledWith(
      "blob:preview-1",
    );
    expect(hook.result.current.canRun).toBe(true);

    let runPromise!: Promise<MotionPayload>;
    act(() => {
      runPromise = hook.result.current.run();
    });
    expect(hook.result.current.busy).toBe(true);
    expect(hook.result.current.canRun).toBe(false);
    await waitFor(() =>
      expect(harness.requestService.uploadCalls).toHaveLength(1),
    );
    const uploadSignal =
      harness.requestService.uploadCalls[0]?.options?.signal;
    const staleSelect = hook.result.current.selectVideo;

    hook.unmount();

    await expect(runPromise).rejects.toMatchObject({ name: "AbortError" });
    expect(uploadSignal?.aborted).toBe(true);
    expect(harness.previewUrls.revokeObjectURL).toHaveBeenLastCalledWith(
      "blob:preview-2",
    );
    expect(harness.previewUrls.revokeObjectURL).toHaveBeenCalledTimes(2);
    expect(() => staleSelect(video("late.mp4"))).toThrowError(
      expect.objectContaining({ name: "AbortError" }),
    );
    expect(harness.previewUrls.createObjectURL).toHaveBeenCalledTimes(2);
  });

  it("projects automatic runtime failures without leaking an unhandled rejection", async () => {
    const harness = createHarness();
    harness.requestService.getHandler = async () => {
      throw new Error("runtime offline");
    };
    const unhandled = vi.fn();
    window.addEventListener("unhandledrejection", unhandled);

    try {
      const hook = renderHook(
        () => useVideoToMotionController(harness.options),
      );

      await waitFor(() =>
        expect(hook.result.current.state).toMatchObject({
          runtimePhase: "unavailable",
          runtime: null,
          runtimeError: "runtime offline",
        }),
      );
      await act(async () => Promise.resolve());

      expect(unhandled).not.toHaveBeenCalled();
      expect(harness.reportError).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("unhandledrejection", unhandled);
    }
  });
});
