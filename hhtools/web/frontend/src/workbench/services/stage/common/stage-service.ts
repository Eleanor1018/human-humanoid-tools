import type { IDisposable } from "@/base/common/disposable";
import type { Event } from "@/base/common/event";

/**
 * Stable identities are enough for panels to describe Stage content.
 *
 * The full motion payload, robot trajectory, and Three.js objects deliberately
 * stay out of this contract: they belong to application services or the
 * renderer that owns the corresponding heavy resources.
 */
export interface StageContentIdentity {
  readonly id: string;
  readonly label: string;
}

/** Semantic layers shared by the current human-to-robot Stage HUD. */
export const STAGE_LAYER_IDS = [
  "sourceSkeleton",
  "sourceBody",
  "sourceEnvironment",
  "scaledSkeleton",
  "scaledEnvironment",
  "resultRobot",
] as const;

export type StageLayerId = (typeof STAGE_LAYER_IDS)[number];

export interface StageLayerState {
  readonly available: boolean;
  readonly visible: boolean;
}

export type StageLayerStates = Readonly<
  Record<StageLayerId, StageLayerState>
>;

/**
 * Renderer-independent playback state.
 *
 * `sourceDuration` may be longer than `duration` when the loaded result is a
 * preview. Human-readable labels are intentionally derived by the View so the
 * model remains independent of React and localization.
 */
export interface StagePlaybackState {
  readonly controlsVisible: boolean;
  readonly active: boolean;
  readonly playing: boolean;
  readonly loop: boolean;
  readonly currentTime: number;
  readonly duration: number;
  readonly sourceDuration: number | null;
  readonly speed: number;
}

export interface StageDisplayState {
  readonly empty: boolean;
  readonly canResetView: boolean;
  readonly layers: StageLayerStates;
}

/** Complete immutable semantic snapshot consumed by Stage-related Views. */
export interface StageState {
  readonly motionIdentity: StageContentIdentity | null;
  readonly robotIdentity: StageContentIdentity | null;
  readonly playback: StagePlaybackState;
  readonly display: StageDisplayState;
}

/**
 * Read side of the pure semantic Stage owner.
 *
 * Views and features receive this narrow interface, so they can render state
 * but cannot forge renderer availability or playback transitions. Mutation is
 * reserved for the concrete owner and, later, its command/renderer adapters.
 */
export interface IStageModelService extends IDisposable {
  readonly state: StageState;
  readonly onDidChangeState: Event<StageState>;
}

/** Playback progress is derived rather than stored as a second source of truth. */
export function getStagePlaybackProgress(
  playback: StagePlaybackState,
): number {
  return playback.duration > 0
    ? Math.min(1, Math.max(0, playback.currentTime / playback.duration))
    : 0;
}
