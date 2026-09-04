import { toDisposable, type IDisposable } from "@/base/common/disposable";
import { Emitter, type Event } from "@/base/common/event";
import type { MotionPayload } from "@/domain/motion/common/motion";
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
import type {
  IHumanMotionPresentationReservation,
  IMotionResultPresentationService,
} from "@/workbench/services/motion/common/motion-result-presentation-service";

const VIDEO_SUFFIXES = new Set(["mp4", "mov", "mkv", "avi", "webm", "m4v"]);
const UPLOAD_PROGRESS_WEIGHT = 0.08;

export type VideoToMotionRuntimePhase =
  | "idle"
  | "checking"
  | "ready"
  | "unavailable";

export type VideoToMotionOperation = "generate" | "import";

export type VideoToMotionInputErrorCode =
  | "unsupported-video"
  | "not-ready"
  | "invalid-focal-length"
  | "operation-in-progress"
  | "invalid-result"
  | "input-locked";

/** A user-correctable preflight failure that has not started an operation. */
export class VideoToMotionInputError extends Error {
  constructor(
    readonly code: VideoToMotionInputErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "VideoToMotionInputError";
  }
}

/** Minimal status projection consumed by this feature from the GVHMR endpoint. */
export interface VideoToMotionRuntimeStatus {
  readonly ready: boolean;
  readonly missing: readonly string[];
  readonly checks?: Readonly<Record<string, boolean>>;
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
  /** Identifies the request whose progress/result is currently projected. */
  readonly operation: VideoToMotionOperation | null;
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
export type VideoToMotionPresentationPort = Pick<
  IMotionResultPresentationService,
  "reserveHumanMotionPresentation"
>;

export interface VideoPreviewUrlPort {
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
}

export interface VideoToMotionControllerDependencies {
  readonly requestService: VideoToMotionRequestPort;
  readonly jobService: VideoToMotionJobPort;
  readonly presentationService: VideoToMotionPresentationPort;
  readonly previewUrls?: VideoPreviewUrlPort;
  /** Report observer failures without coupling the controller to a UI service. */
  readonly reportError: (error: unknown) => void;
}

interface MotionUploadOperation {
  readonly kind: VideoToMotionOperation;
  readonly presentationLabel: string;
  readonly uploadUrl: string;
  readonly parts: readonly UploadPart[];
  readonly expectedJobKind: string;
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
  payload: MotionPayload,
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
    operation: null,
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
export class VideoToMotionController implements IDisposable {
  readonly #requestService: VideoToMotionRequestPort;
  readonly #jobService: VideoToMotionJobPort;
  readonly #presentationService: VideoToMotionPresentationPort;
  readonly #previewUrls: VideoPreviewUrlPort;
  readonly #reportError: (error: unknown) => void;
  readonly #stateEmitter = new Emitter<VideoToMotionControllerState>();
  #state = initialState();
  #videoFile: File | null = null;
  #checkpointFile: File | null = null;
  #runtimeRequest: AbortController | null = null;
  #operation: AbortController | null = null;
  #presentationReservationLifetime: IDisposable | null = null;
  #disposed = false;

  readonly onDidChangeState: Event<VideoToMotionControllerState> =
    this.#stateEmitter.event;

  constructor(dependencies: VideoToMotionControllerDependencies) {
    this.#requestService = dependencies.requestService;
    this.#jobService = dependencies.jobService;
    this.#presentationService = dependencies.presentationService;
    this.#previewUrls = dependencies.previewUrls ?? browserPreviewUrls;
    this.#reportError = dependencies.reportError;
  }

  get state(): VideoToMotionControllerState {
    return this.#state;
  }

  get busy(): boolean {
    // The operation token is reserved before presentation acquisition crosses
    // its first host boundary, so inputs are immutable during that short gap too.
    return this.#operation !== null
      || this.#state.stage === "reserving"
      || this.#state.stage === "uploading"
      || this.#state.stage === "running";
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
      throw new VideoToMotionInputError(
        "unsupported-video",
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

  /** Run upload, polling, and result presentation as one operation. */
  async run(): Promise<MotionPayload> {
    this.#assertNotDisposed();
    if (!this.canRun || !this.#videoFile) {
      throw new VideoToMotionInputError(
        "not-ready",
        "Video-to-motion is not ready to run",
      );
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
      throw new VideoToMotionInputError(
        "invalid-focal-length",
        "Focal length must be a positive integer",
      );
    }

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

    return this.#executeMotionUpload({
      kind: "generate",
      presentationLabel: video.name,
      uploadUrl: `/api/video-to-motion/upload?${query.toString()}`,
      parts,
      expectedJobKind: "video_to_motion",
    });
  }

  /** Import one existing GVHMR result through the managed Motion Library. */
  async importResult(file: File): Promise<MotionPayload> {
    this.#assertNotDisposed();
    if (this.busy) {
      throw new VideoToMotionInputError(
        "operation-in-progress",
        "Video-to-motion is already running",
      );
    }
    if (videoSuffix(file.name) !== "pt") {
      throw new VideoToMotionInputError(
        "invalid-result",
        "A GVHMR result must be a .pt file",
      );
    }

    return this.#executeMotionUpload({
      kind: "import",
      presentationLabel: file.name,
      uploadUrl: "/api/motion/upload?profile=mimic",
      parts: [
        {
          fieldName: "files",
          data: file,
          filename: file.name,
        },
      ],
      expectedJobKind: "motion_link",
    });
  }

  /**
   * Execute the protocol shared by inference and importing an existing result.
   * The caller describes endpoint-specific input; this method owns lifecycle,
   * progress composition, result presentation, and terminal state exactly once.
   */
  async #executeMotionUpload(
    operation: MotionUploadOperation,
  ): Promise<MotionPayload> {
    const request = new AbortController();
    this.#operation = request;
    let reservationPromise: Promise<IHumanMotionPresentationReservation>;
    try {
      reservationPromise =
        this.#presentationService.reserveHumanMotionPresentation(
          { label: operation.presentationLabel },
          { signal: request.signal },
        );
    } catch (error) {
      // Ports are typed as async, but a faulty implementation can still throw
      // before returning its promise. Normalize it into the owned failure path.
      reservationPromise = Promise.reject(error);
    }
    // Reserve the shared motion intent before notifying observers. An observer
    // may select a Library motion synchronously; publishing first ensures that
    // later intent wins instead of this operation reclaiming it afterwards.
    this.#update({
      operation: operation.kind,
      stage: "reserving",
      progress: 0,
      progressDetail: null,
      error: null,
      result: null,
    });
    let payload: MotionPayload;
    let summary: VideoToMotionResultSummary;
    let reservation: IHumanMotionPresentationReservation | null = null;
    let reservationLifetime: IDisposable | null = null;
    try {
      // Always observe acquisition, even if reservation callbacks disposed the
      // controller. A late capability is then wrapped and released exactly once.
      reservation = await reservationPromise;
      // Keep cleanup exact even when dispose() wins and the async method later
      // reaches its finally block. A late reservation is still released once.
      const ownedReservation = reservation;
      reservationLifetime = toDisposable(() => ownedReservation.dispose());
      this.#assertCurrentOperation(request);
      this.#presentationReservationLifetime = reservationLifetime;
      this.#assertCurrentOperation(request);
      this.#update({
        stage: "uploading",
      });
      this.#assertCurrentOperation(request);
      const started = await this.#requestService.upload<{ job_id: string }>(
        operation.uploadUrl,
        operation.parts,
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

      payload = await this.#jobService.waitForResult<MotionPayload>(
        started.job_id,
        {
          expectedKind: operation.expectedJobKind,
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
      // Derive renderer state before committing side effects. Even if a future
      // projection becomes stricter, a malformed result remains a failed run
      // while this request still owns the workflow.
      summary = resultSummary(payload);
      // Presentation is part of the use case, not a responsibility left to the
      // React view. A Stage/library failure therefore remains retryable state.
      const presentationResult = await reservation.commit(payload);
      this.#assertCurrentOperation(request);
      if (presentationResult === "superseded") {
        // A different motion won the shared Stage while its async View loaded.
        // Treat that ownership loss as cancellation: it is neither a failed
        // backend run nor a completed result this controller may publish.
        request.abort(abortError());
        if (this.#operation === request) this.#operation = null;
        this.#update(this.#resetOperationState());
        throw abortReason(request.signal);
      }
    } catch (error) {
      if (!this.#isCurrentOperation(request) || request.signal.aborted) {
        if (this.#operation === request) this.#operation = null;
        throw abortReason(request.signal);
      }
      this.#operation = null;
      this.#update({
        operation: operation.kind,
        stage: "failed",
        progressDetail: null,
        error: errorMessage(error),
        result: null,
      });
      throw error;
    } finally {
      if (this.#presentationReservationLifetime === reservationLifetime) {
        this.#presentationReservationLifetime = null;
      }
      this.#runCleanupSafely(() => reservationLifetime?.dispose());
    }

    // Keep terminal event delivery outside the transport catch. A faulty view
    // listener must not be misreported as a backend or cancellation failure.
    this.#operation = null;
    this.#update({
      stage: "completed",
      progress: 1,
      progressDetail: null,
      error: null,
      result: summary,
    });
    return payload;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    const runtimeRequest = this.#runtimeRequest;
    const operation = this.#operation;
    const presentationReservationLifetime =
      this.#presentationReservationLifetime;
    this.#runtimeRequest = null;
    this.#operation = null;
    this.#presentationReservationLifetime = null;
    this.#runCleanupSafely(() => runtimeRequest?.abort(abortError()));
    this.#runCleanupSafely(() => operation?.abort(abortError()));
    this.#runCleanupSafely(() => presentationReservationLifetime?.dispose());
    const previewUrl = this.#state.video?.previewUrl;
    this.#videoFile = null;
    this.#checkpointFile = null;
    if (previewUrl) {
      this.#runCleanupSafely(() => this.#previewUrls.revokeObjectURL(previewUrl));
    }
    this.#runCleanupSafely(() => this.#stateEmitter.dispose());
  }

  /** Cleanup is observational and must not replace the workflow's terminal result. */
  #runCleanupSafely(cleanup: () => void): void {
    try {
      cleanup();
    } catch (error) {
      try {
        this.#reportError(error);
      } catch {
        // Error reporting is cleanup too; it cannot strand the primary owner.
      }
    }
  }

  #hasSelectedWeights(): boolean {
    return (
      this.#state.weightSource === "official" || this.#checkpointFile !== null
    );
  }

  #resetOperationState(): Pick<
    VideoToMotionControllerState,
    | "operation"
    | "stage"
    | "progress"
    | "progressDetail"
    | "error"
    | "result"
  > {
    return {
      operation: null,
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
      throw new VideoToMotionInputError(
        "input-locked",
        "Video-to-motion inputs cannot change while running",
      );
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
