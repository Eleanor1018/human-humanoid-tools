import { describe, expect, it, vi } from "vitest";

import type { MotionPayload } from "../../src/domain/motion/common/motion";
import type {
  JsonRequestOptions,
  UploadPart,
  UploadRequestOptions,
} from "../../src/platform/request/common/request-service";
import {
  VideoToMotionController,
  VideoToMotionInputError,
  type VideoPreviewUrlPort,
  type VideoToMotionJobPort,
  type VideoToMotionPresentationPort,
  type VideoToMotionRequestPort,
  type VideoToMotionRuntimeStatus,
} from "../../src/workbench/contrib/video-to-motion/browser/video-to-motion-controller";
import type {
  JobStatusResponse,
  WaitForJobOptions,
} from "../../src/workbench/services/jobs/common/job-service";
import type {
  HumanMotionPresentationIntent,
  IHumanMotionPresentationReservation,
  MotionPresentationReservationOptions,
  MotionPresentationResult,
} from "../../src/workbench/services/motion/common/motion-result-presentation-service";

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

class FakeRequestService implements VideoToMotionRequestPort {
  readonly getCalls: Array<{
    readonly url: string;
    readonly options?: JsonRequestOptions;
  }> = [];
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

interface JobWaitCall {
  readonly jobId: string;
  readonly options?: WaitForJobOptions<MotionPayload>;
}

class FakeJobService implements VideoToMotionJobPort {
  readonly calls: JobWaitCall[] = [];
  waitHandler: (call: JobWaitCall) => Promise<MotionPayload> =
    async () => {
      throw new Error("unexpected job wait");
    };

  waitForResult<Result>(
    jobId: string,
    options?: WaitForJobOptions<Result>,
  ): Promise<Result> {
    const call = {
      jobId,
      options: options as
        | WaitForJobOptions<MotionPayload>
        | undefined,
    };
    this.calls.push(call);
    return this.waitHandler(call) as unknown as Promise<Result>;
  }
}

interface PresentationReservationCall {
  readonly intent: HumanMotionPresentationIntent;
  readonly options?: MotionPresentationReservationOptions;
}

class FakePresentationReservation
  implements IHumanMotionPresentationReservation
{
  readonly dispose = vi.fn();

  constructor(readonly service: FakePresentationService) {}

  commit(payload: MotionPayload): Promise<MotionPresentationResult> {
    this.service.calls.push(payload);
    return this.service.presentHandler(payload);
  }
}

class FakePresentationService implements VideoToMotionPresentationPort {
  readonly calls: MotionPayload[] = [];
  readonly reservationCalls: PresentationReservationCall[] = [];
  readonly reservations: FakePresentationReservation[] = [];
  presentHandler: (
    payload: MotionPayload,
  ) => Promise<MotionPresentationResult> = async () => "presented";
  reserveHandler: (
    call: PresentationReservationCall,
  ) => Promise<IHumanMotionPresentationReservation> = async () => (
    this.createReservation()
  );

  reserveHumanMotionPresentation(
    intent: HumanMotionPresentationIntent,
    options?: MotionPresentationReservationOptions,
  ): Promise<IHumanMotionPresentationReservation> {
    const call = { intent, options };
    this.reservationCalls.push(call);
    return this.reserveHandler(call);
  }

  createReservation(): FakePresentationReservation {
    const reservation = new FakePresentationReservation(this);
    this.reservations.push(reservation);
    return reservation;
  }
}

/** Small executable model of the shared latest-intent presentation boundary. */
class LatestIntentPresentationService extends FakePresentationService {
  #generation = 0;
  currentLabel: string | null = null;
  committedPayload: MotionPayload | null = null;
  readonly latestReservations: IHumanMotionPresentationReservation[] = [];

  override reserveHumanMotionPresentation(
    intent: HumanMotionPresentationIntent,
    options?: MotionPresentationReservationOptions,
  ): Promise<IHumanMotionPresentationReservation> {
    this.reservationCalls.push({ intent, options });
    const generation = ++this.#generation;
    this.currentLabel = intent.label;
    let disposed = false;
    const reservation: IHumanMotionPresentationReservation = {
      commit: vi.fn(async (payload: MotionPayload) => {
        if (generation !== this.#generation) return "superseded";
        this.committedPayload = payload;
        return "presented";
      }),
      dispose: vi.fn(() => {
        if (disposed) return;
        disposed = true;
        if (generation === this.#generation) this.currentLabel = null;
      }),
    };
    this.latestReservations.push(reservation);
    return Promise.resolve(reservation);
  }

  selectLibrary(label: string): void {
    this.#generation += 1;
    this.currentLabel = label;
  }
}

const readyRuntime: VideoToMotionRuntimeStatus = {
  ready: true,
  missing: [],
  checks: { python: true },
};

function video(name = "clip.mp4"): File {
  return new File(["video"], name, { type: "video/mp4" });
}

function existingResult(name = "result.pt"): File {
  return new File(["motion"], name, {
    type: "application/octet-stream",
  });
}

function motionResult(name = "generated motion"): MotionPayload {
  return {
    name,
    token: "motion-token",
    positions: [],
    parent_indices: [],
  };
}

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

function createHarness(
  presentationService: FakePresentationService = new FakePresentationService(),
) {
  const requestService = new FakeRequestService();
  const jobService = new FakeJobService();
  let nextUrl = 1;
  const previewUrls: VideoPreviewUrlPort = {
    createObjectURL: vi.fn(() => `blob:test-${nextUrl++}`),
    revokeObjectURL: vi.fn(),
  };
  const reportError = vi.fn();
  const controller = new VideoToMotionController({
    requestService,
    jobService,
    presentationService,
    previewUrls,
    reportError,
  });
  return {
    controller,
    jobService,
    presentationService,
    previewUrls,
    reportError,
    requestService,
  };
}

async function prepareReadyController(
  harness: ReturnType<typeof createHarness>,
): Promise<void> {
  harness.requestService.getHandler = async () => readyRuntime;
  harness.controller.selectVideo(video());
  await harness.controller.refreshRuntime();
  expect(harness.controller.confirmEnvironment()).toBe(true);
  expect(harness.controller.canRun).toBe(true);
}

describe("VideoToMotionController", () => {
  it("loads runtime status through the request port and publishes checking then ready", async () => {
    const harness = createHarness();
    const runtime = deferred<VideoToMotionRuntimeStatus>();
    harness.requestService.getHandler = () => runtime.promise;
    const phases: string[] = [];
    harness.controller.onDidChangeState((state) =>
      phases.push(state.runtimePhase),
    );

    const refresh = harness.controller.refreshRuntime();

    expect(harness.controller.state.runtimePhase).toBe("checking");
    expect(harness.requestService.getCalls).toHaveLength(1);
    expect(harness.requestService.getCalls[0]).toMatchObject({
      url: "/api/video-to-motion/status",
    });
    expect(
      harness.requestService.getCalls[0]?.options?.signal,
    ).toBeInstanceOf(AbortSignal);

    runtime.resolve(readyRuntime);
    await refresh;

    expect(phases).toEqual(["checking", "ready"]);
    expect(harness.controller.state.runtime).toEqual(readyRuntime);
    expect(harness.controller.state.runtime).not.toBe(readyRuntime);
    expect(harness.controller.state.runtime?.missing).not.toBe(
      readyRuntime.missing,
    );
  });

  it("aborts an obsolete runtime refresh and ignores its late result", async () => {
    const harness = createHarness();
    const first = deferred<VideoToMotionRuntimeStatus>();
    const second = deferred<VideoToMotionRuntimeStatus>();
    const responses = [first.promise, second.promise];
    harness.requestService.getHandler = () => responses.shift()!;

    const firstRefresh = harness.controller.refreshRuntime();
    const firstSignal = harness.requestService.getCalls[0]?.options?.signal;
    const secondRefresh = harness.controller.refreshRuntime();

    expect(firstSignal?.aborted).toBe(true);
    second.resolve({ ready: false, missing: ["checkpoint"] });
    await secondRefresh;
    first.resolve(readyRuntime);
    await firstRefresh;

    expect(harness.controller.state.runtimePhase).toBe("unavailable");
    expect(harness.controller.state.runtime?.missing).toEqual(["checkpoint"]);
  });

  it("keeps normal runtime failures in state instead of leaking a rejection", async () => {
    const harness = createHarness();
    harness.requestService.getHandler = async () => {
      throw new Error("runtime offline");
    };

    await expect(harness.controller.refreshRuntime()).resolves.toBeUndefined();

    expect(harness.controller.state).toMatchObject({
      runtimePhase: "unavailable",
      runtime: null,
      runtimeError: "runtime offline",
    });
  });

  it("reports faulty runtime observers without stranding refresh ownership", async () => {
    const harness = createHarness();
    const failure = new Error("broken runtime view");
    const reportingFailure = new Error("broken error reporter");
    const phases: string[] = [];
    harness.requestService.getHandler = async () => readyRuntime;
    harness.reportError.mockImplementation(() => {
      throw reportingFailure;
    });
    harness.controller.onDidChangeState(() => {
      throw failure;
    });
    harness.controller.onDidChangeState((state) => {
      phases.push(state.runtimePhase);
    });

    await expect(harness.controller.refreshRuntime()).resolves.toBeUndefined();
    await expect(harness.controller.refreshRuntime()).resolves.toBeUndefined();

    expect(phases).toEqual(["checking", "ready", "checking", "ready"]);
    expect(harness.reportError).toHaveBeenCalledTimes(4);
    expect(harness.reportError).toHaveBeenCalledWith(failure);
    expect(harness.controller.state.runtimePhase).toBe("ready");
  });

  it("does not start a runtime request after an observer disposes its owner", async () => {
    const harness = createHarness();
    harness.controller.onDidChangeState((state) => {
      if (state.runtimePhase === "checking") harness.controller.dispose();
    });

    await expect(harness.controller.refreshRuntime()).resolves.toBeUndefined();

    expect(harness.requestService.getCalls).toHaveLength(0);
  });

  it("validates videos and owns every preview URL exactly once", () => {
    const harness = createHarness();
    harness.controller.selectVideo(video("first.MP4"));
    const firstUrl = harness.controller.state.video?.previewUrl;

    expect(() => harness.controller.selectVideo(video("notes.txt"))).toThrow(
      VideoToMotionInputError,
    );
    try {
      harness.controller.selectVideo(video("notes.txt"));
    } catch (error) {
      expect(error).toMatchObject({
        name: "VideoToMotionInputError",
        code: "unsupported-video",
        message: expect.stringContaining("Supported formats"),
      });
    }
    expect(harness.controller.state.video?.name).toBe("first.MP4");
    expect(harness.previewUrls.createObjectURL).toHaveBeenCalledOnce();

    harness.controller.selectVideo(video("second.webm"));
    const secondUrl = harness.controller.state.video?.previewUrl;
    expect(harness.previewUrls.revokeObjectURL).toHaveBeenCalledWith(firstUrl);

    harness.controller.setPreviewDuration(firstUrl!, 99);
    expect(harness.controller.state.video?.duration).toBeNull();
    harness.controller.setPreviewDuration(secondUrl!, 2.5);
    expect(harness.controller.state.video?.duration).toBe(2.5);

    harness.controller.dispose();
    harness.controller.dispose();
    expect(harness.previewUrls.revokeObjectURL).toHaveBeenCalledTimes(2);
    expect(harness.previewUrls.revokeObjectURL).toHaveBeenLastCalledWith(
      secondUrl,
    );
  });

  it("accepts an arbitrary custom checkpoint and requires reconfirmation", async () => {
    const harness = createHarness();
    await prepareReadyController(harness);

    harness.controller.selectCheckpoint(video("research-weights.anything"));

    expect(harness.controller.state).toMatchObject({
      weightSource: "custom",
      checkpointName: "research-weights.anything",
      environmentConfirmed: false,
      stage: "idle",
    });
    expect(harness.controller.canConfirmEnvironment).toBe(true);
    expect(harness.controller.canRun).toBe(false);
    expect(harness.controller.confirmEnvironment()).toBe(true);
  });

  it("imports one existing GVHMR result through the shared motion protocol", async () => {
    const harness = createHarness();
    const source = existingResult("recording.PT");
    const upload = deferred<{ job_id: string }>();
    const completed = deferred<MotionPayload>();
    harness.requestService.uploadHandler = () => upload.promise;
    harness.jobService.waitHandler = () => completed.promise;

    const imported = harness.controller.importResult(source);
    await vi.waitFor(() =>
      expect(harness.requestService.uploadCalls).toHaveLength(1),
    );
    expect(harness.presentationService.reservationCalls).toHaveLength(1);
    expect(harness.presentationService.reservationCalls[0]?.intent).toEqual({
      label: "recording.PT",
    });
    const uploadCall = harness.requestService.uploadCalls[0]!;
    expect(uploadCall).toMatchObject({
      url: "/api/motion/upload?profile=mimic",
      parts: [
        {
          fieldName: "files",
          data: source,
          filename: "recording.PT",
        },
      ],
    });
    uploadCall.options?.onProgress?.({
      loaded: 1,
      total: 4,
      fraction: 0.25,
    });
    expect(harness.controller.state).toMatchObject({
      operation: "import",
      stage: "uploading",
      progress: 0.02,
      progressDetail: {
        kind: "upload",
        loadedBytes: 1,
        totalBytes: 4,
      },
    });

    upload.resolve({ job_id: "import-job" });
    await vi.waitFor(() => expect(harness.jobService.calls).toHaveLength(1));
    expect(harness.jobService.calls[0]).toMatchObject({
      jobId: "import-job",
      options: {
        expectedKind: "motion_link",
        signal: uploadCall.options?.signal,
      },
    });

    const payload = {
      ...motionResult("imported motion"),
      playback_frames: 72,
    };
    completed.resolve(payload);
    await expect(imported).resolves.toBe(payload);

    expect(harness.presentationService.calls).toEqual([payload]);
    expect(
      harness.presentationService.reservations[0]?.dispose,
    ).toHaveBeenCalledOnce();
    expect(harness.controller.state).toMatchObject({
      operation: "import",
      stage: "completed",
      progress: 1,
      result: {
        name: "imported motion",
        frames: 72,
      },
    });
    expect(harness.requestService.getCalls).toHaveLength(0);

    harness.controller.selectVideo(video("next.mp4"));
    expect(harness.controller.state).toMatchObject({
      operation: null,
      stage: "idle",
      result: null,
    });
  });

  it("rejects a non-PT import before starting transport", async () => {
    const harness = createHarness();

    await expect(
      harness.controller.importResult(existingResult("motion.pkl")),
    ).rejects.toMatchObject({
      name: "VideoToMotionInputError",
      code: "invalid-result",
      message: expect.stringContaining("must be a .pt file"),
    });

    expect(harness.requestService.uploadCalls).toHaveLength(0);
    expect(harness.jobService.calls).toHaveLength(0);
    expect(harness.controller.state.stage).toBe("idle");
  });

  it("retains import intent when the shared workflow fails", async () => {
    const harness = createHarness();
    const failure = new Error("motion parser rejected result");
    harness.requestService.uploadHandler = async () => {
      throw failure;
    };

    await expect(
      harness.controller.importResult(existingResult()),
    ).rejects.toBe(failure);

    expect(harness.controller.state).toMatchObject({
      operation: "import",
      stage: "failed",
      error: "motion parser rejected result",
    });
    expect(
      harness.presentationService.reservations[0]?.dispose,
    ).toHaveBeenCalledOnce();
  });

  it("runs the exact multipart protocol and composes progress only once", async () => {
    const harness = createHarness();
    harness.requestService.getHandler = async () => readyRuntime;
    harness.controller.selectVideo(video("clip.mp4"));
    await harness.controller.refreshRuntime();
    const checkpoint = video("custom checkpoint.bin");
    harness.controller.selectCheckpoint(checkpoint);
    harness.controller.setStaticCamera(false);
    harness.controller.setFocalLength("35");
    harness.controller.confirmEnvironment();

    const upload = deferred<{ job_id: string }>();
    const completed = deferred<MotionPayload>();
    const presented = deferred<MotionPresentationResult>();
    harness.requestService.uploadHandler = () => upload.promise;
    harness.jobService.waitHandler = () => completed.promise;
    harness.presentationService.presentHandler = () => presented.promise;

    const run = harness.controller.run();
    await vi.waitFor(() =>
      expect(harness.requestService.uploadCalls).toHaveLength(1),
    );
    const uploadCall = harness.requestService.uploadCalls[0]!;
    expect(harness.presentationService.reservationCalls).toHaveLength(1);
    expect(harness.presentationService.reservationCalls[0]?.intent).toEqual({
      label: "clip.mp4",
    });
    expect(
      harness.presentationService.reservationCalls[0]?.options?.signal,
    ).toBe(uploadCall.options?.signal);
    expect(uploadCall.url).toBe(
      "/api/video-to-motion/upload?static_cam=false&f_mm=35",
    );
    expect(uploadCall.parts).toEqual([
      {
        fieldName: "files",
        data: expect.any(File),
        filename: "clip.mp4",
      },
      {
        fieldName: "checkpoint",
        data: checkpoint,
        filename: "custom checkpoint.bin",
      },
    ]);
    uploadCall.options?.onProgress?.({
      loaded: 5,
      total: 10,
      fraction: 0.5,
    });
    expect(harness.controller.state).toMatchObject({
      operation: "generate",
      stage: "uploading",
      progress: 0.04,
      progressDetail: {
        kind: "upload",
        loadedBytes: 5,
        totalBytes: 10,
      },
    });

    upload.resolve({ job_id: "job-42" });
    await vi.waitFor(() => expect(harness.jobService.calls).toHaveLength(1));
    const jobCall = harness.jobService.calls[0]!;
    expect(jobCall.jobId).toBe("job-42");
    expect(jobCall.options?.expectedKind).toBe("video_to_motion");
    expect(jobCall.options?.signal).toBe(uploadCall.options?.signal);
    const progressBeforeLateUpload = harness.controller.state.progress;
    uploadCall.options?.onProgress?.({ loaded: 10, total: 10, fraction: 1 });
    expect(harness.controller.state).toMatchObject({
      stage: "running",
      progress: progressBeforeLateUpload,
    });
    jobCall.options?.onProgress?.(runningJob(0.5, "halfway"));
    expect(harness.controller.state.progress).toBeCloseTo(0.54);
    expect(harness.controller.state.progressDetail).toEqual({
      kind: "job",
      message: "halfway",
    });

    const payload: MotionPayload = {
      ...motionResult("clip motion"),
      positions: [[], [], []],
      playback_frames: 42,
      playback_duration: 1.5,
      sample_rate: 30,
    };
    completed.resolve(payload);

    await vi.waitFor(() =>
      expect(harness.presentationService.calls).toHaveLength(1),
    );
    expect(harness.presentationService.calls[0]).toBe(payload);
    expect(harness.controller.state.stage).toBe("running");
    expect(harness.controller.busy).toBe(true);
    expect(harness.controller.canRun).toBe(false);
    expect(() => harness.controller.setFocalLength("50")).toThrow(
      "inputs cannot change while running",
    );
    await expect(harness.controller.run()).rejects.toThrow(
      "Video-to-motion is not ready to run",
    );
    expect(harness.requestService.uploadCalls).toHaveLength(1);
    presented.resolve("presented");

    await expect(run).resolves.toBe(payload);
    expect(harness.controller.state).toMatchObject({
      operation: "generate",
      stage: "completed",
      progress: 1,
      error: null,
      result: {
        name: "clip motion",
        frames: 42,
        duration: 1.5,
        framerate: 30,
      },
    });
    expect(harness.controller.busy).toBe(false);
    expect(harness.controller.canRun).toBe(true);
    expect(
      harness.presentationService.reservations[0]?.dispose,
    ).toHaveBeenCalledOnce();
  });

  it("does not upload until its presentation intent is reserved", async () => {
    const harness = createHarness();
    await prepareReadyController(harness);
    const reservationReady = deferred<IHumanMotionPresentationReservation>();
    const upload = deferred<{ job_id: string }>();
    harness.presentationService.reserveHandler = () => reservationReady.promise;
    harness.requestService.uploadHandler = () => upload.promise;

    const run = harness.controller.run();

    expect(harness.presentationService.reservationCalls).toHaveLength(1);
    expect(harness.requestService.uploadCalls).toHaveLength(0);
    expect(harness.controller.state).toMatchObject({
      operation: "generate",
      stage: "reserving",
    });
    expect(harness.controller.busy).toBe(true);
    const reservation = harness.presentationService.createReservation();
    reservationReady.resolve(reservation);
    await vi.waitFor(() =>
      expect(harness.requestService.uploadCalls).toHaveLength(1),
    );

    harness.controller.dispose();
    expect(reservation.dispose).toHaveBeenCalledOnce();
    upload.resolve({ job_id: "ignored" });
    await expect(run).rejects.toMatchObject({ name: "AbortError" });
    expect(reservation.dispose).toHaveBeenCalledOnce();
  });

  it("blocks a successor during reservation acquisition", async () => {
    const harness = createHarness();
    await prepareReadyController(harness);
    const upload = deferred<{ job_id: string }>();
    harness.requestService.uploadHandler = () => upload.promise;
    const imported = new File(["result"], "successor.pt");
    let successorError: unknown = null;
    let successorAttempt: Promise<MotionPayload> | null = null;
    harness.presentationService.reserveHandler = () => {
      const reservation = harness.presentationService.createReservation();
      successorAttempt = harness.controller.importResult(imported);
      void successorAttempt.catch((error: unknown) => {
        successorError = error;
      });
      return Promise.resolve(reservation);
    };

    const run = harness.controller.run();

    await vi.waitFor(() => {
      expect(harness.controller.state).toMatchObject({
        operation: "generate",
        stage: "uploading",
      });
    });
    await vi.waitFor(() => {
      expect(successorError).toMatchObject({ code: "operation-in-progress" });
    });
    await expect(successorAttempt).rejects.toMatchObject({
      code: "operation-in-progress",
    });
    expect(harness.presentationService.reservationCalls).toHaveLength(1);
    expect(harness.requestService.uploadCalls).toHaveLength(1);

    harness.controller.dispose();
    upload.resolve({ job_id: "ignored" });
    await expect(run).rejects.toMatchObject({ name: "AbortError" });
    expect(
      harness.presentationService.reservations[0]?.dispose,
    ).toHaveBeenCalledOnce();
  });

  it("releases a reservation that resolves after owner disposal", async () => {
    const harness = createHarness();
    await prepareReadyController(harness);
    const reservationReady = deferred<IHumanMotionPresentationReservation>();
    harness.presentationService.reserveHandler = () => reservationReady.promise;

    const run = harness.controller.run();
    expect(harness.presentationService.reservationCalls).toHaveLength(1);
    harness.controller.dispose();
    const reservation = harness.presentationService.createReservation();
    reservationReady.resolve(reservation);

    await expect(run).rejects.toMatchObject({ name: "AbortError" });
    expect(harness.requestService.uploadCalls).toHaveLength(0);
    expect(harness.jobService.calls).toHaveLength(0);
    expect(reservation.dispose).toHaveBeenCalledOnce();
  });

  it("releases a reservation returned by a synchronously disposing port", async () => {
    const harness = createHarness();
    await prepareReadyController(harness);
    const reservation = harness.presentationService.createReservation();
    harness.presentationService.reserveHandler = () => {
      harness.controller.dispose();
      return Promise.resolve(reservation);
    };

    await expect(harness.controller.run()).rejects.toMatchObject({
      name: "AbortError",
    });

    expect(harness.requestService.uploadCalls).toHaveLength(0);
    expect(harness.jobService.calls).toHaveLength(0);
    expect(reservation.dispose).toHaveBeenCalledOnce();
  });

  it("keeps a later Library intent when an older V2M result completes", async () => {
    const presentationService = new LatestIntentPresentationService();
    const harness = createHarness(presentationService);
    await prepareReadyController(harness);
    const payload = motionResult("late V2M motion");
    harness.requestService.uploadHandler = async () => ({ job_id: "job-42" });
    harness.jobService.waitHandler = async () => payload;
    let librarySelected = false;
    harness.controller.onDidChangeState((state) => {
      if (state.stage !== "uploading" || librarySelected) return;
      librarySelected = true;
      presentationService.selectLibrary("library motion B");
    });

    await expect(harness.controller.run()).rejects.toMatchObject({
      name: "AbortError",
    });

    expect(presentationService.reservationCalls[0]?.intent).toEqual({
      label: "clip.mp4",
    });
    expect(presentationService.currentLabel).toBe("library motion B");
    expect(presentationService.committedPayload).toBeNull();
    expect(
      presentationService.latestReservations[0]?.dispose,
    ).toHaveBeenCalledOnce();
    expect(harness.controller.state).toMatchObject({
      operation: null,
      stage: "idle",
      error: null,
      result: null,
    });
  });

  it("publishes reservation failures without starting transport", async () => {
    const harness = createHarness();
    await prepareReadyController(harness);
    const failure = new Error("presentation owner unavailable");
    harness.presentationService.reserveHandler = async () => {
      throw failure;
    };

    await expect(harness.controller.run()).rejects.toBe(failure);

    expect(harness.requestService.uploadCalls).toHaveLength(0);
    expect(harness.jobService.calls).toHaveLength(0);
    expect(harness.controller.state).toMatchObject({
      operation: "generate",
      stage: "failed",
      error: "presentation owner unavailable",
      result: null,
    });
  });

  it("does not upload after an observer disposes its owner", async () => {
    const harness = createHarness();
    await prepareReadyController(harness);
    harness.controller.onDidChangeState((state) => {
      if (state.stage === "uploading") harness.controller.dispose();
    });

    await expect(harness.controller.run()).rejects.toMatchObject({
      name: "AbortError",
    });

    expect(harness.requestService.uploadCalls).toHaveLength(0);
    expect(harness.jobService.calls).toHaveLength(0);
    expect(
      harness.presentationService.reservations[0]?.dispose,
    ).toHaveBeenCalledOnce();
  });

  it("does not start polling after an observer disposes the running view", async () => {
    const harness = createHarness();
    await prepareReadyController(harness);
    harness.requestService.uploadHandler = async () => ({ job_id: "job-42" });
    harness.controller.onDidChangeState((state) => {
      if (state.stage === "running") harness.controller.dispose();
    });

    await expect(harness.controller.run()).rejects.toMatchObject({
      name: "AbortError",
    });

    expect(harness.requestService.uploadCalls).toHaveLength(1);
    expect(harness.jobService.calls).toHaveLength(0);
  });

  it("normalizes non-finite transport progress before publishing state", async () => {
    const harness = createHarness();
    await prepareReadyController(harness);
    const upload = deferred<{ job_id: string }>();
    const completed = deferred<MotionPayload>();
    harness.requestService.uploadHandler = () => upload.promise;
    harness.jobService.waitHandler = () => completed.promise;

    const run = harness.controller.run();
    await vi.waitFor(() =>
      expect(harness.requestService.uploadCalls).toHaveLength(1),
    );
    const uploadCall = harness.requestService.uploadCalls[0]!;
    uploadCall.options?.onProgress?.({
      loaded: 0,
      total: 0,
      fraction: Number.POSITIVE_INFINITY,
    });
    expect(harness.controller.state.progress).toBe(0);

    upload.resolve({ job_id: "job-42" });
    await vi.waitFor(() => expect(harness.jobService.calls).toHaveLength(1));
    harness.jobService.calls[0]?.options?.onProgress?.(
      runningJob(Number.NaN),
    );
    expect(harness.controller.state.progress).toBe(0.08);

    completed.resolve(motionResult("finite motion"));
    await expect(run).resolves.toMatchObject({ name: "finite motion" });
    expect(harness.controller.state.progress).toBe(1);
  });

  it("reports faulty operation observers without changing the result", async () => {
    const harness = createHarness();
    await prepareReadyController(harness);
    const failure = new Error("broken progress view");
    const stages: string[] = [];
    harness.requestService.uploadHandler = async () => ({ job_id: "job-42" });
    harness.jobService.waitHandler = async (call) => {
      call.options?.onProgress?.(runningJob(0.5, "halfway"));
      return motionResult("observer-safe motion");
    };
    harness.controller.onDidChangeState(() => {
      throw failure;
    });
    harness.controller.onDidChangeState((state) => stages.push(state.stage));

    await expect(harness.controller.run()).resolves.toMatchObject({
      name: "observer-safe motion",
    });

    expect(stages).toEqual([
      "reserving",
      "uploading",
      "running",
      "running",
      "completed",
    ]);
    expect(harness.reportError).toHaveBeenCalledTimes(5);
    expect(harness.reportError).toHaveBeenCalledWith(failure);
    expect(harness.controller.state.stage).toBe("completed");
    expect(harness.controller.canRun).toBe(true);
  });

  it("publishes presentation failures as retryable workflow state", async () => {
    const harness = createHarness();
    await prepareReadyController(harness);
    const payload = motionResult("unpresentable motion");
    const failure = new Error("stage rejected motion");
    const cleanupFailure = new Error("reservation cleanup failed");
    const reservation = harness.presentationService.createReservation();
    reservation.dispose.mockImplementationOnce(() => {
      throw cleanupFailure;
    });
    harness.presentationService.reserveHandler = async () => reservation;
    harness.requestService.uploadHandler = async () => ({ job_id: "job-42" });
    harness.jobService.waitHandler = async () => payload;
    harness.presentationService.presentHandler = async () => {
      throw failure;
    };

    await expect(harness.controller.run()).rejects.toBe(failure);

    expect(harness.presentationService.calls).toEqual([payload]);
    expect(harness.controller.state).toMatchObject({
      stage: "failed",
      error: "stage rejected motion",
      result: null,
    });
    expect(harness.controller.canRun).toBe(true);
    expect(reservation.dispose).toHaveBeenCalledOnce();
    expect(harness.reportError).toHaveBeenCalledWith(cleanupFailure);
  });

  it("publishes completion when reservation cleanup reports a failure", async () => {
    const harness = createHarness();
    await prepareReadyController(harness);
    const payload = motionResult("cleanup-safe motion");
    const cleanupFailure = new Error("reservation cleanup failed");
    const reservation = harness.presentationService.createReservation();
    reservation.dispose.mockImplementationOnce(() => {
      throw cleanupFailure;
    });
    harness.presentationService.reserveHandler = async () => reservation;
    harness.requestService.uploadHandler = async () => ({ job_id: "job-42" });
    harness.jobService.waitHandler = async () => payload;

    await expect(harness.controller.run()).resolves.toBe(payload);

    expect(reservation.dispose).toHaveBeenCalledOnce();
    expect(harness.reportError).toHaveBeenCalledWith(cleanupFailure);
    expect(harness.controller.state).toMatchObject({
      operation: "generate",
      stage: "completed",
      error: null,
    });
    expect(harness.controller.canRun).toBe(true);
  });

  it("returns to idle without publishing a superseded presentation", async () => {
    const harness = createHarness();
    await prepareReadyController(harness);
    const payload = motionResult("superseded motion");
    harness.requestService.uploadHandler = async () => ({ job_id: "job-42" });
    harness.jobService.waitHandler = async () => payload;
    harness.presentationService.presentHandler = async () => "superseded";

    await expect(harness.controller.run()).rejects.toMatchObject({
      name: "AbortError",
    });

    expect(harness.presentationService.calls).toEqual([payload]);
    expect(harness.controller.state).toMatchObject({
      operation: null,
      stage: "idle",
      progress: 0,
      progressDetail: null,
      error: null,
      result: null,
    });
    expect(harness.controller.busy).toBe(false);
    expect(harness.controller.canRun).toBe(true);
    expect(
      harness.presentationService.reservations[0]?.dispose,
    ).toHaveBeenCalledOnce();
  });

  it("does not publish completion after disposal during presentation", async () => {
    const harness = createHarness();
    await prepareReadyController(harness);
    const presented = deferred<MotionPresentationResult>();
    harness.requestService.uploadHandler = async () => ({ job_id: "job-42" });
    harness.jobService.waitHandler = async () => motionResult();
    harness.presentationService.presentHandler = () => presented.promise;

    const run = harness.controller.run();
    await vi.waitFor(() =>
      expect(harness.presentationService.calls).toHaveLength(1),
    );
    const reservation = harness.presentationService.reservations[0]!;
    expect(reservation.dispose).not.toHaveBeenCalled();
    harness.controller.dispose();
    expect(reservation.dispose).toHaveBeenCalledOnce();
    presented.resolve("presented");

    await expect(run).rejects.toMatchObject({ name: "AbortError" });
    expect(harness.controller.state.stage).toBe("running");
  });

  it("finishes owner teardown when reservation cleanup throws", async () => {
    const harness = createHarness();
    await prepareReadyController(harness);
    const upload = deferred<{ job_id: string }>();
    const cleanupFailure = new Error("reservation cleanup failed");
    const reservation = harness.presentationService.createReservation();
    reservation.dispose.mockImplementationOnce(() => {
      throw cleanupFailure;
    });
    harness.presentationService.reserveHandler = async () => reservation;
    harness.requestService.uploadHandler = () => upload.promise;

    const run = harness.controller.run();
    await vi.waitFor(() =>
      expect(harness.requestService.uploadCalls).toHaveLength(1),
    );

    expect(() => harness.controller.dispose()).not.toThrow();
    expect(reservation.dispose).toHaveBeenCalledOnce();
    expect(harness.reportError).toHaveBeenCalledWith(cleanupFailure);
    expect(harness.previewUrls.revokeObjectURL).toHaveBeenCalledWith(
      "blob:test-1",
    );
    upload.resolve({ job_id: "ignored" });
    await expect(run).rejects.toMatchObject({ name: "AbortError" });
    expect(reservation.dispose).toHaveBeenCalledOnce();
  });

  it("rejects an invalid focal length before starting transport", async () => {
    const harness = createHarness();
    await prepareReadyController(harness);
    harness.controller.setFocalLength("12.5");

    await expect(harness.controller.run()).rejects.toMatchObject({
      name: "VideoToMotionInputError",
      code: "invalid-focal-length",
      message: "Focal length must be a positive integer",
    });

    expect(harness.requestService.uploadCalls).toHaveLength(0);
    expect(harness.jobService.calls).toHaveLength(0);
    expect(harness.controller.state.stage).toBe("idle");
    expect(harness.controller.canRun).toBe(true);
  });

  it("publishes a retryable failed state and rethrows backend errors", async () => {
    const harness = createHarness();
    await prepareReadyController(harness);
    const failure = new Error("GPU unavailable");
    harness.requestService.uploadHandler = async () => ({ job_id: "job-42" });
    harness.jobService.waitHandler = async () => {
      throw failure;
    };

    await expect(harness.controller.run()).rejects.toBe(failure);

    expect(harness.controller.state).toMatchObject({
      stage: "failed",
      error: "GPU unavailable",
      result: null,
    });
    expect(harness.presentationService.calls).toHaveLength(0);
    expect(harness.controller.busy).toBe(false);
    expect(harness.controller.canRun).toBe(true);
    expect(
      harness.presentationService.reservations[0]?.dispose,
    ).toHaveBeenCalledOnce();
  });

  it("blocks input changes while a request owns their immutable snapshot", async () => {
    const harness = createHarness();
    await prepareReadyController(harness);
    const upload = deferred<{ job_id: string }>();
    harness.requestService.uploadHandler = () => upload.promise;
    const run = harness.controller.run();

    expect(() => harness.controller.setFocalLength("50")).toThrow(
      "inputs cannot change while running",
    );
    expect(() => harness.controller.selectVideo(video("other.mp4"))).toThrow(
      "inputs cannot change while running",
    );

    harness.controller.dispose();
    upload.resolve({ job_id: "ignored" });
    await expect(run).rejects.toMatchObject({ name: "AbortError" });
  });

  it("aborts disposal, revokes the preview, and ignores late callbacks", async () => {
    const harness = createHarness();
    await prepareReadyController(harness);
    const upload = deferred<{ job_id: string }>();
    harness.requestService.uploadHandler = () => upload.promise;
    const snapshots: string[] = [];
    harness.controller.onDidChangeState((state) => snapshots.push(state.stage));
    const run = harness.controller.run();
    await vi.waitFor(() =>
      expect(harness.requestService.uploadCalls).toHaveLength(1),
    );
    const uploadCall = harness.requestService.uploadCalls[0]!;
    const snapshotCount = snapshots.length;

    harness.controller.dispose();
    expect(uploadCall.options?.signal?.aborted).toBe(true);
    uploadCall.options?.onProgress?.({ loaded: 10, total: 10, fraction: 1 });
    expect(snapshots).toHaveLength(snapshotCount);

    upload.resolve({ job_id: "ignored" });
    await expect(run).rejects.toMatchObject({ name: "AbortError" });
    expect(harness.jobService.calls).toHaveLength(0);
    expect(harness.previewUrls.revokeObjectURL).toHaveBeenCalledOnce();
  });
});
