import type { IDisposable } from "@/base/common/disposable";
import { Emitter, type Event } from "@/base/common/event";
import type {
  IRequestService,
  UploadPart,
} from "@/platform/request/common/request-service";
import type {
  GvhmrWeightSource,
  VideoToMotionResultSummary,
  VideoToMotionStage,
} from "@/workbench/contrib/video-to-motion/common/video-to-motion-state";
import type { IJobService } from "@/workbench/services/jobs/common/job-service";

const VIDEO_SUFFIXES = new Set(["mp4", "mov", "mkv", "avi", "webm", "m4v"]);
const UPLOAD_PROGRESS_WEIGHT = 0.08;

export type VideoToMotionRuntimePhase =
  | "idle"
  | "checking"
  | "ready"
  | "unavailable";

/** Minimal status projection consumed by this feature from the GVHMR endpoint. */
export interface VideoToMotionRuntimeStatus {
  readonly ready: boolean;
  readonly missing: readonly string[];
  readonly checks?: Readonly<Record<string, boolean>>;
}

/**
 * Fields used by the controller to summarize a result. The generic controller
 * preserves any richer payload returned by the server for the later Stage port.
 */
export interface VideoToMotionJobResult {
  readonly name: string;
  readonly positions?: readonly unknown[];
  readonly playback_frames?: number;
  readonly num_frames_total?: number;
  readonly playback_duration?: number;
  readonly duration?: number;
  readonly framerate?: number;
  readonly sample_rate?: number;
}

export interface VideoToMotionVideoSelection {
  readonly name: string;
  readonly size: number;
  readonly mediaType: string;
  readonly previewUrl: string;
  readonly duration: number | null;
}

export type VideoToMotionProgressDetail =
  | {
      readonly kind: "upload";
      readonly loadedBytes: number;
      readonly totalBytes: number;
    }
  | {
      readonly kind: "job";
      readonly message: string;
    };

/** Immutable renderer projection; File objects remain private to the controller. */
export interface VideoToMotionControllerState {
  readonly video: VideoToMotionVideoSelection | null;
  readonly weightSource: GvhmrWeightSource;
  readonly checkpointName: string | null;
  readonly runtimePhase: VideoToMotionRuntimePhase;
  readonly runtime: VideoToMotionRuntimeStatus | null;
  readonly runtimeError: string | null;
  readonly environmentConfirmed: boolean;
  readonly staticCamera: boolean;
  readonly focalLength: string;
  readonly stage: VideoToMotionStage;
  readonly progress: number;
  readonly progressDetail: VideoToMotionProgressDetail | null;
  readonly error: string | null;
  readonly result: VideoToMotionResultSummary | null;
}

export type VideoToMotionRequestPort = Pick<
  IRequestService,
  "get" | "upload"
>;

export type VideoToMotionJobPort = Pick<IJobService, "waitForResult">;

export interface VideoPreviewUrlPort {
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
}

export interface VideoToMotionControllerDependencies {
  readonly requestService: VideoToMotionRequestPort;
  readonly jobService: VideoToMotionJobPort;
  readonly previewUrls?: VideoPreviewUrlPort;
  /** Report observer failures without coupling the controller to a UI service. */
  readonly reportError: (error: unknown) => void;
}

const browserPreviewUrls: VideoPreviewUrlPort = {
  // Resolve URL lazily so importing the controller stays safe in test runtimes.
  createObjectURL: (blob) => URL.createObjectURL(blob),
  revokeObjectURL: (url) => URL.revokeObjectURL(url),
};

function abortError(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError");
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason instanceof Error ? signal.reason : abortError();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function boundedProgress(value: number | null | undefined): number {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

function videoSuffix(name: string): string {
  const separator = name.lastIndexOf(".");
  return separator < 0 ? "" : name.slice(separator + 1).toLowerCase();
}

function resultSummary(
  payload: VideoToMotionJobResult,
): VideoToMotionResultSummary {
  return {
    name: payload.name,
    frames:
      payload.playback_frames ??
      payload.num_frames_total ??
      payload.positions?.length ??
      null,
    duration: payload.playback_duration ?? payload.duration ?? null,
    framerate: payload.framerate ?? payload.sample_rate ?? null,
  };
}

function initialState(): VideoToMotionControllerState {
  return {
    video: null,
    weightSource: "official",
    checkpointName: null,
    runtimePhase: "idle",
    runtime: null,
    runtimeError: null,
    environmentConfirmed: false,
    staticCamera: true,
    focalLength: "",
    stage: "idle",
    progress: 0,
    progressDetail: null,
    error: null,
    result: null,
  };
}

/**
 * State owner for the single-video GVHMR workflow.
 *
 * The controller owns cancellation and File lifetimes. It deliberately knows
 * nothing about React, DOM nodes, notifications, or the temporary legacy bridge.
 */
export class VideoToMotionController<
  Result extends VideoToMotionJobResult = VideoToMotionJobResult,
> implements IDisposable {
  readonly #requestService: VideoToMotionRequestPort;
  readonly #jobService: VideoToMotionJobPort;
  readonly #previewUrls: VideoPreviewUrlPort;
  readonly #reportError: (error: unknown) => void;
  readonly #stateEmitter = new Emitter<VideoToMotionControllerState>();
  #state = initialState();
  #videoFile: File | null = null;
  #checkpointFile: File | null = null;
  #runtimeRequest: AbortController | null = null;
  #operation: AbortController | null = null;
  #disposed = false;

  readonly onDidChangeState: Event<VideoToMotionControllerState> =
    this.#stateEmitter.event;

  constructor(dependencies: VideoToMotionControllerDependencies) {
    this.#requestService = dependencies.requestService;
    this.#jobService = dependencies.jobService;
    this.#previewUrls = dependencies.previewUrls ?? browserPreviewUrls;
    this.#reportError = dependencies.reportError;
  }

  get state(): VideoToMotionControllerState {
    return this.#state;
  }

  get busy(): boolean {
    return this.#state.stage === "uploading" || this.#state.stage === "running";
  }

  get canConfirmEnvironment(): boolean {
    return (
      !this.busy &&
      !this.#state.environmentConfirmed &&
      this.#videoFile !== null &&
      this.#state.runtime?.ready === true &&
      this.#hasSelectedWeights()
    );
  }

  get canRun(): boolean {
    return (
      !this.busy &&
      this.#state.environmentConfirmed &&
      this.#videoFile !== null &&
      this.#state.runtime?.ready === true &&
      this.#hasSelectedWeights()
    );
  }

  selectVideo(file: File): void {
    this.#assertMutable();
    if (!VIDEO_SUFFIXES.has(videoSuffix(file.name))) {
      throw new Error(
        "Supported formats: MP4, MOV, MKV, AVI, WebM, and M4V",
      );
    }

    const previewUrl = this.#previewUrls.createObjectURL(file);
    const previousUrl = this.#state.video?.previewUrl;
    this.#videoFile = file;
    try {
      this.#update({
        ...this.#resetOperationState(),
        video: {
          name: file.name,
          size: file.size,
          mediaType: file.type,
          previewUrl,
          duration: null,
        },
      });
    } finally {
      if (previousUrl) this.#previewUrls.revokeObjectURL(previousUrl);
    }
  }

  selectCheckpoint(file: File): void {
    this.#assertMutable();
    this.#checkpointFile = file;
    this.#update({
      ...this.#resetOperationState(),
      weightSource: "custom",
      checkpointName: file.name,
      environmentConfirmed: false,
    });
  }

  setWeightSource(source: GvhmrWeightSource): void {
    this.#assertMutable();
    if (source === this.#state.weightSource) return;
    this.#update({
      ...this.#resetOperationState(),
      weightSource: source,
      environmentConfirmed: false,
    });
  }

  setStaticCamera(value: boolean): void {
    this.#assertMutable();
    if (value !== this.#state.staticCamera) this.#update({ staticCamera: value });
  }

  setFocalLength(value: string): void {
    this.#assertMutable();
    if (value !== this.#state.focalLength) this.#update({ focalLength: value });
  }

  /** Ignore metadata emitted by a preview that has already been replaced. */
  setPreviewDuration(previewUrl: string, duration: number | null): void {
    // Metadata may arrive after the user has already started generation. It is
    // display-only, so it must neither mutate request inputs nor throw mid-run.
    if (this.#disposed) return;
    const video = this.#state.video;
    if (!video || video.previewUrl !== previewUrl) return;
    const normalized =
      duration !== null && Number.isFinite(duration) ? duration : null;
    this.#update({ video: { ...video, duration: normalized } });
  }

  confirmEnvironment(): boolean {
    this.#assertMutable();
    if (!this.canConfirmEnvironment) return false;
    this.#update({ environmentConfirmed: true });
    return true;
  }

  async refreshRuntime(): Promise<void> {
    this.#assertMutable();
    this.#runtimeRequest?.abort(abortError());
    const request = new AbortController();
    this.#runtimeRequest = request;
    this.#update({
      runtimePhase: "checking",
      runtime: null,
      runtimeError: null,
      environmentConfirmed: false,
    });
    // State delivery is synchronous and an owner may dispose the controller
    // from a listener. Do not invoke the transport after that re-entrant stop.
    if (!this.#isCurrentRuntimeRequest(request)) return;

    try {
      const runtime =
        await this.#requestService.get<VideoToMotionRuntimeStatus>(
          "/api/video-to-motion/status",
          { signal: request.signal },
        );
      if (!this.#isCurrentRuntimeRequest(request)) return;
      const snapshot: VideoToMotionRuntimeStatus = {
        ready: runtime.ready,
        missing: [...(runtime.missing ?? [])],
        ...(runtime.checks ? { checks: { ...runtime.checks } } : {}),
      };
      this.#update({
        runtimePhase: snapshot.ready ? "ready" : "unavailable",
        runtime: snapshot,
        runtimeError: null,
      });
    } catch (error) {
      if (!this.#isCurrentRuntimeRequest(request) || request.signal.aborted) {
        return;
      }
      this.#update({
        runtimePhase: "unavailable",
        runtime: null,
        runtimeError: errorMessage(error),
      });
    } finally {
      if (this.#runtimeRequest === request) this.#runtimeRequest = null;
    }
  }

  /** Run transport and polling only; presentation is injected in a later step. */
  async run(): Promise<Result> {
    this.#assertNotDisposed();
    if (!this.canRun || !this.#videoFile) {
      throw new Error("Video-to-motion is not ready to run");
    }

    const video = this.#videoFile;
    const checkpoint =
      this.#state.weightSource === "custom" ? this.#checkpointFile : null;
    const staticCamera = this.#state.staticCamera;
    const rawFocalLength = this.#state.focalLength.trim();
    const focalLength = rawFocalLength
      ? Number(rawFocalLength)
      : undefined;
    if (
      focalLength !== undefined &&
      (!Number.isSafeInteger(focalLength) || focalLength <= 0)
    ) {
      throw new Error("Focal length must be a positive integer");
    }

    const request = new AbortController();
    this.#operation = request;
    this.#update({
      stage: "uploading",
      progress: 0,
      progressDetail: null,
      error: null,
      result: null,
    });
    // A synchronous observer may dispose its owning view during notification.
    // Re-check ownership before starting a request with an aborted signal.
    this.#assertCurrentOperation(request);

    const query = new URLSearchParams({
      static_cam: String(staticCamera),
    });
    if (focalLength !== undefined) query.set("f_mm", String(focalLength));
    const parts: UploadPart[] = [
      {
        fieldName: "files",
        data: video,
        filename: video.name,
      },
    ];
    if (checkpoint) {
      parts.push({
        fieldName: "checkpoint",
        data: checkpoint,
        filename: checkpoint.name,
      });
    }

    let payload: Result;
    try {
      const started = await this.#requestService.upload<{ job_id: string }>(
        `/api/video-to-motion/upload?${query.toString()}`,
        parts,
        {
          signal: request.signal,
          onProgress: ({ loaded, total, fraction }) => {
            if (
              !this.#isCurrentOperation(request) ||
              this.#state.stage !== "uploading"
            ) {
              return;
            }
            this.#update({
              stage: "uploading",
              progress:
                boundedProgress(fraction) * UPLOAD_PROGRESS_WEIGHT,
              progressDetail: {
                kind: "upload",
                loadedBytes: loaded,
                totalBytes: total,
              },
            });
          },
        },
      );
      this.#assertCurrentOperation(request);
      this.#update({ stage: "running" });
      this.#assertCurrentOperation(request);

      payload = await this.#jobService.waitForResult<Result>(
        started.job_id,
        {
          expectedKind: "video_to_motion",
          signal: request.signal,
          onProgress: (job) => {
            if (
              !this.#isCurrentOperation(request) ||
              this.#state.stage !== "running"
            ) {
              return;
            }
            this.#update({
              stage: "running",
              progress:
                UPLOAD_PROGRESS_WEIGHT +
                boundedProgress(job.progress) *
                  (1 - UPLOAD_PROGRESS_WEIGHT),
              progressDetail: {
                kind: "job",
                message: job.message?.trim() ?? "",
              },
            });
          },
        },
      );
      this.#assertCurrentOperation(request);
    } catch (error) {
      if (!this.#isCurrentOperation(request) || request.signal.aborted) {
        if (this.#operation === request) this.#operation = null;
        throw abortReason(request.signal);
      }
      this.#operation = null;
      this.#update({
        stage: "failed",
        progressDetail: null,
        error: errorMessage(error),
        result: null,
      });
      throw error;
    }

    // Keep terminal event delivery outside the transport catch. A faulty view
    // listener must not be misreported as a backend or cancellation failure.
    this.#operation = null;
    this.#update({
      stage: "completed",
      progress: 1,
      progressDetail: null,
      error: null,
      result: resultSummary(payload),
    });
    return payload;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    const runtimeRequest = this.#runtimeRequest;
    const operation = this.#operation;
    this.#runtimeRequest = null;
    this.#operation = null;
    runtimeRequest?.abort(abortError());
    operation?.abort(abortError());
    const previewUrl = this.#state.video?.previewUrl;
    this.#videoFile = null;
    this.#checkpointFile = null;
    if (previewUrl) this.#previewUrls.revokeObjectURL(previewUrl);
    this.#stateEmitter.dispose();
  }

  #hasSelectedWeights(): boolean {
    return (
      this.#state.weightSource === "official" || this.#checkpointFile !== null
    );
  }

  #resetOperationState(): Pick<
    VideoToMotionControllerState,
    "stage" | "progress" | "progressDetail" | "error" | "result"
  > {
    return {
      stage: "idle",
      progress: 0,
      progressDetail: null,
      error: null,
      result: null,
    };
  }

  #update(patch: Partial<VideoToMotionControllerState>): void {
    if (this.#disposed) return;
    this.#state = { ...this.#state, ...patch };
    try {
      this.#stateEmitter.fire(this.#state);
    } catch (error) {
      // State listeners are observers, not participants in the transition.
      // Their failures must not strand request ownership or roll back state.
      try {
        this.#reportError(error);
      } catch {
        // Error reporting is observational too. A broken reporter cannot be
        // allowed to corrupt the workflow it was intended to diagnose.
      }
    }
  }

  #assertNotDisposed(): void {
    if (this.#disposed) throw abortError();
  }

  #assertMutable(): void {
    this.#assertNotDisposed();
    if (this.busy) {
      throw new Error("Video-to-motion inputs cannot change while running");
    }
  }

  #isCurrentRuntimeRequest(request: AbortController): boolean {
    return (
      !this.#disposed &&
      this.#runtimeRequest === request &&
      !request.signal.aborted
    );
  }

  #isCurrentOperation(request: AbortController): boolean {
    return (
      !this.#disposed &&
      this.#operation === request &&
      !request.signal.aborted
    );
  }

  #assertCurrentOperation(request: AbortController): void {
    if (!this.#isCurrentOperation(request)) throw abortReason(request.signal);
  }
}
