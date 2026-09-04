import type { PlaybackPayload } from "../types";

/**
 * Return the duration represented by a browser playback payload.
 *
 * Preview payloads may contain only a sparse subset of frames, so their keys
 * must still span the original clip duration instead of playing at the sampled
 * frame count's shorter duration.
 */
export function effectivePlaybackDuration(
  payload: PlaybackPayload | null | undefined,
): number {
  if (payload == null) return 1;
  if (
    payload.playback_duration != null
    && Number.isFinite(payload.playback_duration)
  ) {
    return Math.max(0.1, payload.playback_duration);
  }
  const playbackFrames = payload.playback_frames
    ?? payload.positions?.length
    ?? payload.frames?.length
    ?? payload.num_frames_total;
  const totalFrames = payload.num_frames_total ?? playbackFrames ?? 1;
  const framesPerSecond = payload.framerate || payload.sample_rate || 30;
  if (payload.duration != null && payload.duration > 0) {
    return Math.max(0.1, payload.duration);
  }
  return Math.max(0.1, (totalFrames - 1) / framesPerSecond);
}

/**
 * Resolve a fractional browser frame to source keys.
 *
 * Adjacent preview keys may represent distant source frames. Interpolating
 * across such a gap creates visible sliding, so choose the nearest sparse key
 * and reserve interpolation for genuinely consecutive frames.
 */
export function resolvePlaybackFrame(
  frameIndices: readonly number[] | null | undefined,
  frame: number,
  maximumFrame: number,
): { ia: number; ib: number; t: number } {
  const firstFrame = Math.min(maximumFrame, Math.floor(frame));
  const blend = frame - firstFrame;
  if (blend <= 1e-5 || firstFrame >= maximumFrame) {
    return { ia: firstFrame, ib: firstFrame, t: 0 };
  }

  const secondFrame = firstFrame + 1;
  const sourceGap = frameIndices && frameIndices.length > secondFrame
    ? frameIndices[secondFrame] - frameIndices[firstFrame]
    : 1;
  if (sourceGap > 1) {
    const nearestFrame = blend >= 0.5 ? secondFrame : firstFrame;
    return { ia: nearestFrame, ib: nearestFrame, t: 0 };
  }
  return { ia: firstFrame, ib: secondFrame, t: blend };
}
