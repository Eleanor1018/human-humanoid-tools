import type {
  StageMotionPayload,
  StageTimelinePayload,
} from "./types";

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

export function timelineFrameCount(timeline: StageTimelinePayload | null): number {
  if (!timeline) return 0;
  return "frames" in timeline ? timeline.frames.length : timeline.positions.length;
}

/** Return the full duration represented by a motion or robot trajectory. */
export function timelineDuration(timeline: StageTimelinePayload | null): number {
  if (!timeline) return 0;
  for (const declared of [timeline.playback_duration, timeline.duration]) {
    if (typeof declared === "number" && Number.isFinite(declared) && declared > 0) {
      return declared;
    }
  }
  const framerate = timeline.framerate ?? timeline.sample_rate;
  if (typeof framerate === "number" && Number.isFinite(framerate) && framerate > 0) {
    const frameCount =
      timeline.num_frames_total ??
      timeline.playback_frames ??
      timelineFrameCount(timeline);
    return Math.max(0, (frameCount - 1) / framerate);
  }
  const frameCount = timelineFrameCount(timeline);
  return frameCount > 1 ? (frameCount - 1) / 30 : 0;
}

/** Convert elapsed seconds into one payload's serialized-frame coordinate. */
export function timelineFrameAtTime(
  timeline: StageTimelinePayload | null,
  elapsedSeconds: number,
): number {
  const frameCount = timelineFrameCount(timeline);
  if (frameCount < 2) return 0;
  const duration = timelineDuration(timeline);
  if (duration <= 0) return 0;
  // The owner clock performs looping. Individual layers clamp so a shorter
  // secondary payload holds its last frame instead of wrapping out of sync.
  const normalized = Math.min(1, Math.max(0, elapsedSeconds / duration));
  return normalized * (frameCount - 1);
}

/** Compatibility names retained for motion-only layer tests and callers. */
export function motionDuration(motion: StageMotionPayload | null): number {
  return timelineDuration(motion);
}

export function frameAtTime(
  motion: StageMotionPayload | null,
  elapsedSeconds: number,
): number {
  return timelineFrameAtTime(motion, elapsedSeconds);
}
