/** Lifecycle phases for one video-to-motion request. */
export type VideoToMotionStage =
  | "idle"
  | "reserving"
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
