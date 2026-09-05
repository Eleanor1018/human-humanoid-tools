import type { StageMotionPayload } from "./types";

/** Mutable cursor shared by all animated R3F layers in one Stage. */
export interface StagePlaybackState {
  elapsed: number;
  frame: number;
  duration: number;
  playing: boolean;
}

export interface StagePlaybackRef {
  readonly current: StagePlaybackState;
}

/** Return the timeline length used by every animated Stage layer. */
export function motionDuration(motion: StageMotionPayload | null): number {
  if (!motion) return 0;
  for (const declared of [motion.playback_duration, motion.duration]) {
    if (typeof declared === "number" && Number.isFinite(declared) && declared > 0) {
      return declared;
    }
  }
  const framerate = motion.framerate;
  if (typeof framerate === "number" && Number.isFinite(framerate) && framerate > 0) {
    const frameCount =
      motion.num_frames_total ?? motion.playback_frames ?? motion.positions.length;
    return Math.max(0, (frameCount - 1) / framerate);
  }
  return motion.positions.length > 1 ? (motion.positions.length - 1) / 30 : 0;
}

/** Convert elapsed seconds into a looping serialized-frame coordinate. */
export function frameAtTime(
  motion: StageMotionPayload | null,
  elapsedSeconds: number,
): number {
  const frameCount = motion?.positions.length ?? 0;
  if (frameCount < 2) return 0;
  const duration = motionDuration(motion);
  if (duration <= 0) return 0;
  const normalized = ((elapsedSeconds % duration) + duration) % duration;
  return (normalized / duration) * (frameCount - 1);
}
