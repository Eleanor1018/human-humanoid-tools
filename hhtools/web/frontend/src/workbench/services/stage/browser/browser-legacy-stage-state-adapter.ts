import type { IDisposable } from "@/base/common/disposable";
import type { StagePlaybackState } from "@/workbench/services/stage/common/stage-service";
import { StageModel } from "@/workbench/services/stage/common/stage-model";

type Mutable<T> = { -readonly [Key in keyof T]: T[Key] };
type PlaybackPatch = Partial<Mutable<StagePlaybackState>>;

/**
 * Temporary, one-way projection from the compatibility player into StageModel.
 *
 * The legacy runtime remains the live playback owner in this step. Keeping the
 * global event inside this browser adapter lets the common Stage contract and
 * future React Views stay unaware of that migration seam.
 */
export class BrowserLegacyStageStateAdapter implements IDisposable {
  readonly #stageOwner: StageModel;
  readonly #eventTarget: Window;
  #disposed = false;

  readonly #onPlaybackState = (
    event: WindowEventMap["hhtools:playback-state"],
  ): void => {
    const detail = event.detail;
    const playback: PlaybackPatch = {};

    // Preserve omitted fields: several legacy call sites publish a partial
    // overlay, while StageModel needs one complete immutable snapshot.
    if (detail.visible !== undefined) {
      playback.controlsVisible = detail.visible;
    }
    if (detail.active !== undefined) playback.active = detail.active;
    if (detail.playing !== undefined) playback.playing = detail.playing;
    if (detail.loop !== undefined) playback.loop = detail.loop;
    if (detail.currentTime !== undefined) {
      playback.currentTime = detail.currentTime;
    }
    if (detail.duration !== undefined) playback.duration = detail.duration;
    if (detail.sourceDuration !== undefined) {
      playback.sourceDuration = detail.sourceDuration;
    }
    if (detail.speed !== undefined) playback.speed = detail.speed;

    this.#stageOwner.updateState({ playback });
  };

  constructor(stageOwner: StageModel, eventTarget: Window = window) {
    this.#stageOwner = stageOwner;
    this.#eventTarget = eventTarget;
    this.#eventTarget.addEventListener(
      "hhtools:playback-state",
      this.#onPlaybackState,
    );
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#eventTarget.removeEventListener(
      "hhtools:playback-state",
      this.#onPlaybackState,
    );
  }
}
