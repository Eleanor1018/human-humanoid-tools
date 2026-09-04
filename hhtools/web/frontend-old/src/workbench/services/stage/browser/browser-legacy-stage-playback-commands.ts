import {
  MAX_STAGE_PLAYBACK_SPEED,
  MIN_STAGE_PLAYBACK_SPEED,
  type IStagePlaybackCommands,
} from "@/workbench/services/stage/common/stage-service";

type PlaybackCommand =
  WindowEventMap["hhtools:playback-command"]["detail"];

interface LegacyPlaybackCommandTarget {
  dispatchEvent(event: Event): boolean;
}

function clampFinite(
  value: number,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  return Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, value))
    : fallback;
}

/**
 * Temporary command-side adapter for the compatibility player.
 *
 * React calls the stable Stage contract; only this browser-boundary object
 * knows that the current executor still listens for a window CustomEvent.
 */
export class BrowserLegacyStagePlaybackCommands
  implements IStagePlaybackCommands
{
  readonly #eventTarget: LegacyPlaybackCommandTarget;

  constructor(eventTarget: LegacyPlaybackCommandTarget = window) {
    this.#eventTarget = eventTarget;
  }

  togglePlayback(): void {
    this.#emit("toggle");
  }

  seekToFraction(fraction: number): void {
    this.#emit("seek", clampFinite(fraction, 0, 1, 0));
  }

  setPlaybackSpeed(multiplier: number): void {
    this.#emit(
      "speed",
      clampFinite(
        multiplier,
        MIN_STAGE_PLAYBACK_SPEED,
        MAX_STAGE_PLAYBACK_SPEED,
        1,
      ),
    );
  }

  togglePlaybackLoop(): void {
    this.#emit("loop");
  }

  #emit(action: PlaybackCommand["action"], value?: number): void {
    this.#eventTarget.dispatchEvent(
      new CustomEvent("hhtools:playback-command", {
        detail: { action, value } satisfies PlaybackCommand,
      }),
    );
  }
}
