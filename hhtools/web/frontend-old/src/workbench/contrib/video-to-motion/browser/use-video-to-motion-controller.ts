import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type { MotionPayload } from "@/domain/motion/common/motion";
import type { GvhmrWeightSource } from "@/workbench/contrib/video-to-motion/common/video-to-motion-state";
import {
  VideoToMotionController,
  type VideoToMotionControllerDependencies,
  type VideoToMotionControllerState,
} from "./video-to-motion-controller";

export type UseVideoToMotionControllerOptions =
  VideoToMotionControllerDependencies;

export interface VideoToMotionControllerModel {
  /** Null only until React installs the effect-owned controller. */
  readonly state: VideoToMotionControllerState | null;
  readonly busy: boolean;
  readonly canRun: boolean;
  readonly canConfirmEnvironment: boolean;
  readonly selectVideo: (file: File) => void;
  readonly selectCheckpoint: (file: File) => void;
  readonly setWeightSource: (source: GvhmrWeightSource) => void;
  readonly setStaticCamera: (value: boolean) => void;
  readonly setFocalLength: (value: string) => void;
  readonly setPreviewDuration: (
    previewUrl: string,
    duration: number | null,
  ) => void;
  readonly confirmEnvironment: () => boolean;
  readonly refreshRuntime: () => Promise<void>;
  readonly run: () => Promise<MotionPayload>;
  readonly importResult: (file: File) => Promise<MotionPayload>;
}

function inactiveControllerError(): DOMException {
  return new DOMException(
    "The video-to-motion view is not active.",
    "AbortError",
  );
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/**
 * Bind one VideoToMotionController lifetime to one mounted React effect.
 *
 * Creating the controller inside the effect is intentional. React 19 may run
 * setup -> cleanup -> setup in StrictMode; constructing it during render (or
 * memoizing it) would let the second setup reuse the instance disposed by the
 * first cleanup. Stable actions therefore dereference the current owner only
 * when the renderer invokes them.
 */
export function useVideoToMotionController(
  options: UseVideoToMotionControllerOptions,
): VideoToMotionControllerModel {
  const {
    requestService,
    jobService,
    presentationService,
    previewUrls,
    reportError,
  } = options;
  const controllerRef = useRef<VideoToMotionController | null>(null);
  const reportErrorRef = useRef(reportError);
  reportErrorRef.current = reportError;
  const [state, setState] =
    useState<VideoToMotionControllerState | null>(null);

  // Reporting is observational. A faulty reporter must not turn an automatic
  // refresh into an unhandled promise rejection in the React host.
  const reportSafely = useCallback((error: unknown) => {
    try {
      reportErrorRef.current(error);
    } catch {
      // The controller follows the same isolation rule for state observers.
    }
  }, []);

  useEffect(() => {
    const controller = new VideoToMotionController({
      requestService,
      jobService,
      presentationService,
      ...(previewUrls ? { previewUrls } : {}),
      reportError: reportSafely,
    });
    controllerRef.current = controller;

    const subscription = controller.onDidChangeState((nextState) => {
      // A late callback from a superseded effect must never project its state
      // into the renderer now owned by a newer controller.
      if (controllerRef.current === controller) setState(nextState);
    });
    setState(controller.state);

    // Runtime discovery belongs to the mounted feature lifetime. Normal
    // transport failures are already represented by controller state; this
    // catch is the final guard for unexpected lifecycle/programmer failures.
    void controller.refreshRuntime().catch((error: unknown) => {
      if (
        controllerRef.current === controller &&
        !isAbortError(error)
      ) {
        reportSafely(error);
      }
    });

    return () => {
      // Remove renderer observation before cancellation can dispose resources.
      // Clearing the ref also makes every stable action reject this old owner.
      if (controllerRef.current === controller) controllerRef.current = null;
      subscription.dispose();
      controller.dispose();
    };
  }, [
    jobService,
    presentationService,
    previewUrls,
    reportSafely,
    requestService,
  ]);

  const requireController = useCallback((): VideoToMotionController => {
    const controller = controllerRef.current;
    if (!controller) throw inactiveControllerError();
    return controller;
  }, []);

  // These callbacks intentionally depend only on the ref accessor. Their
  // identity is stable across state renders and a StrictMode owner replacement.
  const selectVideo = useCallback(
    (file: File) => requireController().selectVideo(file),
    [requireController],
  );
  const selectCheckpoint = useCallback(
    (file: File) => requireController().selectCheckpoint(file),
    [requireController],
  );
  const setWeightSource = useCallback(
    (source: GvhmrWeightSource) =>
      requireController().setWeightSource(source),
    [requireController],
  );
  const setStaticCamera = useCallback(
    (value: boolean) => requireController().setStaticCamera(value),
    [requireController],
  );
  const setFocalLength = useCallback(
    (value: string) => requireController().setFocalLength(value),
    [requireController],
  );
  const setPreviewDuration = useCallback(
    (previewUrl: string, duration: number | null) =>
      requireController().setPreviewDuration(previewUrl, duration),
    [requireController],
  );
  const confirmEnvironment = useCallback(
    () => requireController().confirmEnvironment(),
    [requireController],
  );
  const refreshRuntime = useCallback(
    () => requireController().refreshRuntime(),
    [requireController],
  );
  const run = useCallback(
    () => requireController().run(),
    [requireController],
  );
  const importResult = useCallback(
    (file: File) => requireController().importResult(file),
    [requireController],
  );

  return useMemo(
    () => ({
      state,
      busy:
        state?.stage === "reserving"
        || state?.stage === "uploading"
        || state?.stage === "running",
      canRun: state !== null && requireController().canRun,
      canConfirmEnvironment:
        state !== null && requireController().canConfirmEnvironment,
      selectVideo,
      selectCheckpoint,
      setWeightSource,
      setStaticCamera,
      setFocalLength,
      setPreviewDuration,
      confirmEnvironment,
      refreshRuntime,
      run,
      importResult,
    }),
    [
      confirmEnvironment,
      importResult,
      refreshRuntime,
      requireController,
      run,
      selectCheckpoint,
      selectVideo,
      setFocalLength,
      setPreviewDuration,
      setStaticCamera,
      setWeightSource,
      state,
    ],
  );
}
