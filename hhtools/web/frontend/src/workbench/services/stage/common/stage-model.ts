import { Emitter } from "@/base/common/event";

import {
  STAGE_LAYER_IDS,
  type IStageModelService,
  type StageContentIdentity,
  type StageDisplayState,
  type StageLayerId,
  type StageLayerState,
  type StageLayerStates,
  type StagePlaybackState,
  type StageState,
} from "./stage-service";

export type StageModelErrorReporter = (error: unknown) => void;

type StageLayerPatch = Readonly<
  Partial<Record<StageLayerId, Readonly<Partial<StageLayerState>>>>
>;

/**
 * One owner-side Stage transition. Nested patches commit atomically so Views
 * never observe half of a preset or content-load transition.
 */
export interface StageStateUpdate {
  readonly motionIdentity?: StageContentIdentity | null;
  readonly robotIdentity?: StageContentIdentity | null;
  readonly playback?: Readonly<Partial<StagePlaybackState>>;
  readonly display?: Readonly<{
    empty?: boolean;
    canResetView?: boolean;
    layers?: StageLayerPatch;
  }>;
}

const MIN_PLAYBACK_SPEED = 0.1;
const MAX_PLAYBACK_SPEED = 4;

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function freezeIdentity(
  identity: StageContentIdentity | null,
): StageContentIdentity | null {
  if (identity === null) return null;
  return Object.freeze({ id: identity.id, label: identity.label });
}

function freezeLayer(state: StageLayerState): StageLayerState {
  const available = Boolean(state.available);
  return Object.freeze({
    available,
    // An unavailable renderer layer cannot truthfully be visible.
    visible: available && Boolean(state.visible),
  });
}

function createInitialLayers(): StageLayerStates {
  const layers = Object.fromEntries(
    STAGE_LAYER_IDS.map((id) => [
      id,
      freezeLayer({ available: false, visible: false }),
    ]),
  ) as Record<StageLayerId, StageLayerState>;
  return Object.freeze(layers);
}

function updateLayers(
  current: StageLayerStates,
  patch: StageLayerPatch | undefined,
): StageLayerStates {
  if (!patch) return current;

  let changed = false;
  const next = {} as Record<StageLayerId, StageLayerState>;
  for (const id of STAGE_LAYER_IDS) {
    const previous = current[id];
    const layerPatch = patch[id];
    if (!layerPatch) {
      next[id] = previous;
      continue;
    }

    const candidate = freezeLayer({ ...previous, ...layerPatch });
    if (
      candidate.available === previous.available &&
      candidate.visible === previous.visible
    ) {
      next[id] = previous;
    } else {
      next[id] = candidate;
      changed = true;
    }
  }
  return changed ? Object.freeze(next) : current;
}

function updatePlayback(
  current: StagePlaybackState,
  patch: Readonly<Partial<StagePlaybackState>> | undefined,
): StagePlaybackState {
  if (!patch) return current;

  const active = patch.active ?? current.active;
  const duration = Math.max(
    0,
    finiteOr(patch.duration ?? current.duration, current.duration),
  );
  const currentTime = Math.min(
    duration,
    Math.max(
      0,
      finiteOr(patch.currentTime ?? current.currentTime, current.currentTime),
    ),
  );
  // Unlike the numeric fields, `null` is a meaningful update here: it clears
  // preview metadata after a full-length result replaces a preview.
  const rawSourceDuration =
    Object.hasOwn(patch, "sourceDuration") &&
    patch.sourceDuration !== undefined
    ? patch.sourceDuration
    : current.sourceDuration;
  const sourceDuration =
    rawSourceDuration === null
      ? null
      : Math.max(0, finiteOr(rawSourceDuration, duration));
  const speed = Math.min(
    MAX_PLAYBACK_SPEED,
    Math.max(
      MIN_PLAYBACK_SPEED,
      finiteOr(patch.speed ?? current.speed, current.speed),
    ),
  );

  const next: StagePlaybackState = {
    controlsVisible: patch.controlsVisible ?? current.controlsVisible,
    active,
    // Pausing an inactive timeline is an invariant, not a View concern.
    playing: active && (patch.playing ?? current.playing),
    loop: patch.loop ?? current.loop,
    currentTime,
    duration,
    sourceDuration,
    speed,
  };
  return playbackEquals(current, next) ? current : Object.freeze(next);
}

function playbackEquals(
  left: StagePlaybackState,
  right: StagePlaybackState,
): boolean {
  return (
    left.controlsVisible === right.controlsVisible &&
    left.active === right.active &&
    left.playing === right.playing &&
    left.loop === right.loop &&
    left.currentTime === right.currentTime &&
    left.duration === right.duration &&
    left.sourceDuration === right.sourceDuration &&
    left.speed === right.speed
  );
}

function identityEquals(
  left: StageContentIdentity | null,
  right: StageContentIdentity | null,
): boolean {
  return left === right || (left?.id === right?.id && left?.label === right?.label);
}

function stateEquals(left: StageState, right: StageState): boolean {
  return (
    identityEquals(left.motionIdentity, right.motionIdentity) &&
    identityEquals(left.robotIdentity, right.robotIdentity) &&
    left.playback === right.playback &&
    left.display.empty === right.display.empty &&
    left.display.canResetView === right.display.canResetView &&
    left.display.layers === right.display.layers
  );
}

function createInitialState(): StageState {
  const playback: StagePlaybackState = Object.freeze({
    controlsVisible: false,
    active: false,
    playing: false,
    loop: true,
    currentTime: 0,
    duration: 0,
    sourceDuration: null,
    speed: 1,
  });
  const display: StageDisplayState = Object.freeze({
    empty: true,
    canResetView: false,
    layers: createInitialLayers(),
  });
  return Object.freeze({
    motionIdentity: null,
    robotIdentity: null,
    playback,
    display,
  });
}

/**
 * Immutable state model for the shared Stage.
 *
 * This class intentionally does not drive the legacy renderer yet. The next
 * migration step can project legacy state into it without coupling this common
 * contract to window events, DOM ids, or Three.js resource ownership.
 */
export class StageModel implements IStageModelService {
  readonly #stateEmitter = new Emitter<StageState>();
  readonly #reportError: StageModelErrorReporter;
  #state = createInitialState();
  #disposed = false;

  readonly onDidChangeState = this.#stateEmitter.event;

  constructor(reportError: StageModelErrorReporter) {
    this.#reportError = reportError;
  }

  get state(): StageState {
    return this.#state;
  }

  updateState(update: StageStateUpdate): void {
    this.#assertMutable();

    const motionIdentity =
      Object.hasOwn(update, "motionIdentity") &&
      update.motionIdentity !== undefined
      ? freezeIdentity(update.motionIdentity)
      : this.#state.motionIdentity;
    const robotIdentity =
      Object.hasOwn(update, "robotIdentity") &&
      update.robotIdentity !== undefined
      ? freezeIdentity(update.robotIdentity)
      : this.#state.robotIdentity;
    const playback = updatePlayback(this.#state.playback, update.playback);
    const layers = updateLayers(this.#state.display.layers, update.display?.layers);
    const empty = update.display?.empty ?? this.#state.display.empty;
    const requestedCanResetView =
      update.display?.canResetView ?? this.#state.display.canResetView;
    const display: StageDisplayState =
      empty === this.#state.display.empty &&
      (!empty && requestedCanResetView) === this.#state.display.canResetView &&
      layers === this.#state.display.layers
        ? this.#state.display
        : Object.freeze({
            empty,
            // Resetting an empty scene has no user-visible meaning.
            canResetView: !empty && requestedCanResetView,
            layers,
          });
    const next: StageState = Object.freeze({
      motionIdentity,
      robotIdentity,
      playback,
      display,
    });

    if (stateEquals(this.#state, next)) return;
    this.#state = next;
    this.#publish(next);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#stateEmitter.dispose();
  }

  #publish(state: StageState): void {
    try {
      this.#stateEmitter.fire(state);
    } catch (error) {
      // Observers do not participate in the transition. Deliver to every
      // sibling first, then report without rolling back the committed state.
      try {
        this.#reportError(error);
      } catch {
        // Error reporting is observational as well; it cannot corrupt state.
      }
    }
  }

  #assertMutable(): void {
    if (this.#disposed) {
      throw new Error("StageModel has been disposed");
    }
  }
}
