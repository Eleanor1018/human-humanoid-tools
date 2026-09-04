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
  // The same target robot renders a static/calibration pose before it owns a
  // retargeted trajectory, so naming it as only a result would be misleading.
  "targetRobot",
] as const;

export type StageLayerId = (typeof STAGE_LAYER_IDS)[number];

export const MIN_STAGE_PLAYBACK_SPEED = 0.1;
export const MAX_STAGE_PLAYBACK_SPEED = 4;

export interface StageLayerState {
  /** Whether the renderer currently has content for this semantic layer. */
  readonly available: boolean;
  /** Whether that content is currently rendered. */
  readonly visible: boolean;
  /**
   * Whether the current Stage mode lets the user change visibility.
   *
   * This is deliberately separate from availability: calibration can keep a
   * loaded layer available and visible while temporarily locking its control.
   */
  readonly canToggle: boolean;
}

export type StageLayerStates = Readonly<
  Record<StageLayerId, StageLayerState>
>;

/**
 * Renderer-independent playback state.
 *
 * `previewSourceDuration` is non-null only when the content owner knows the
 * loaded result is a downsampled preview. Human-readable labels are derived by
 * the View so the model remains independent of React and localization.
 */
export interface StagePlaybackState {
  readonly controlsVisible: boolean;
  readonly active: boolean;
  readonly playing: boolean;
  readonly loop: boolean;
  readonly currentTime: number;
  readonly duration: number;
  readonly previewSourceDuration: number | null;
  readonly speed: number;
}

/** Workflow that currently owns the shared canvas and playback surface. */
export type StageRendererOwner = "h2r" | "r2r";

export interface StageDisplayState {
  readonly owner: StageRendererOwner;
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

/**
 * Narrow playback intents available to Views and other features.
 *
 * These methods do not expose the owner-side state patch API. The current
 * browser implementation adapts them to the compatibility player; a future
 * renderer can implement the same contract directly.
 */
export interface IStagePlaybackCommands {
  togglePlayback(): void;
  /** Seek to a normalized position; values are clamped to `[0, 1]`. */
  seekToFraction(fraction: number): void;
  /** Set playback rate; values are clamped to `[0.1, 4]`. */
  setPlaybackSpeed(multiplier: number): void;
  togglePlaybackLoop(): void;
}

/** Semantic visibility intents available to Stage layer controls. */
export interface IStageLayerCommands {
  /** Toggle from authoritative Stage state, never from a stale View snapshot. */
  toggleLayer(layerId: StageLayerId): void;
}

/** View-level Stage intents whose concrete rendering remains host-owned. */
export interface IStageDisplayCommands {
  resetView(): void;
}

/** Playback progress is derived rather than stored as a second source of truth. */
export function getStagePlaybackProgress(
  playback: StagePlaybackState,
): number {
  return playback.duration > 0
    ? Math.min(1, Math.max(0, playback.currentTime / playback.duration))
    : 0;
}
