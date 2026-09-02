/** Lifecycle phases for one video-to-motion request. */
export type VideoToMotionStage =
  | "idle"
  | "uploading"
  | "running"
  | "completed"
  | "failed";

/** Custom checkpoints are forwarded as selected and remain best-effort. */
export type GvhmrWeightSource = "official" | "custom";

/** Small result projection used by the panel instead of the full motion data. */
export interface VideoToMotionResultSummary {
  name: string;
  frames: number | null;
  duration: number | null;
  framerate: number | null;
}

/**
 * Renderer-safe state shared during the legacy-to-React migration.
 * Selected File objects remain private to whichever controller owns the flow.
 */
export interface VideoToMotionStateDetail {
  videoName: string | null;
  weightSource: GvhmrWeightSource;
  checkpointName: string | null;
  runtimeState: "checking" | "ready" | "unavailable";
  runtimeMessage: string;
  environmentConfirmed: boolean;
  stage: VideoToMotionStage;
  progress: number;
  message: string;
  result: VideoToMotionResultSummary | null;
}
