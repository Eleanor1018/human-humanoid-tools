/** Data-only motion shape consumed by R3F layer components. */
export interface StageMotionPayload {
  readonly positions: readonly (readonly (readonly [number, number, number])[])[];
  readonly parent_indices: readonly number[];
  readonly exclude_joint_indices?: readonly number[];
  readonly frame_indices?: readonly number[];
  readonly playback_duration?: number;
  readonly duration?: number;
  readonly framerate?: number;
  readonly playback_frames?: number;
  readonly num_frames_total?: number;
}
