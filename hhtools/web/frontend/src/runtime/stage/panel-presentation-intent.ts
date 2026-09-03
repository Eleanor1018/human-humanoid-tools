import type { OwnedPresentationOperation } from
  "./latest-presentation-operation";

export type PanelStageOwner = "h2r" | "r2r";

/** Shared player state captured before R2R temporarily takes the Stage. */
export interface SharedStagePlayerSnapshot {
  readonly t: number;
  readonly duration: number;
  readonly active: boolean;
  readonly playing: boolean;
  readonly playbarVisible: boolean;
}

/** Exact shared-player target owned by one committed R2R trajectory result. */
export interface R2rPlaybackPresentation extends SharedStagePlayerSnapshot {
  readonly active: true;
}

/**
 * Freeze a fresh playback target before it is published by an async result.
 *
 * The object identity is significant: panel successors carry this same value
 * until the matching result receipt has been presented or revoked.
 */
export function createR2rPlaybackPresentation({
  duration,
  t = 0,
  playing = true,
  playbarVisible = true,
}: {
  readonly duration: number;
  readonly t?: number;
  readonly playing?: boolean;
  readonly playbarVisible?: boolean;
}): R2rPlaybackPresentation {
  return Object.freeze({
    t,
    duration,
    active: true as const,
    playing,
    playbarVisible,
  });
}

/**
 * Complete intent for the panel-ownership handoff slice.
 *
 * Layer/resource projection still belongs to the compatibility renderer. This
 * value owns only panel identity, Stage workflow ownership, and the H2R player
 * baseline that must survive an arbitrarily reentrant R2R visit. An optional
 * R2R playback target is a capability borrowed from the independently owned
 * async result; H2R intents can never carry it.
 */
export interface PanelPresentationIntent {
  readonly panelId: string;
  readonly stageOwner: PanelStageOwner;
  readonly h2rReturnBaseline: SharedStagePlayerSnapshot;
  readonly restoreH2rPlayer: boolean;
  /** A stable repeated R2R request must not pause playback as a side effect. */
  readonly resetSharedPlayback: boolean;
  readonly r2rPlayback: R2rPlaybackPresentation | null;
}

export type PanelPresentationOperation =
  OwnedPresentationOperation<PanelPresentationIntent>;

/**
 * Test the semantic owner of the latest fully applied panel presentation.
 *
 * A same-owner panel request creates a newer exact operation, but it must not
 * revoke an independently owned motion, robot, or calibration continuation.
 * Those domains keep their own leases and use this predicate only to decide
 * whether their next shared-Stage mutation is currently allowed.
 */
export function appliedPanelPresentationOwnsStage({
  current,
  lastApplied,
  stageOwner,
}: {
  readonly current: PanelPresentationOperation | null;
  readonly lastApplied: PanelPresentationOperation | null;
  readonly stageOwner: PanelStageOwner;
}): boolean {
  return Boolean(
    current
    && current === lastApplied
    && current.value.stageOwner === stageOwner,
  );
}

function freezePlayerSnapshot(
  snapshot: SharedStagePlayerSnapshot,
): SharedStagePlayerSnapshot {
  return Object.freeze({
    t: snapshot.t,
    duration: snapshot.duration,
    active: snapshot.active,
    playing: snapshot.playing,
    playbarVisible: snapshot.playbarVisible,
  });
}

/**
 * Build one immutable panel handoff without consulting a host callback.
 *
 * An applied H2R predecessor is the only safe point at which a fresh baseline
 * may be captured. R2R ownership and an unsettled H2R return both inherit the
 * predecessor's root baseline: the live shared player may already contain a
 * partial A projection when nested B/C requests are being prepared.
 */
export function createPanelPresentationIntent({
  panelId,
  current,
  lastApplied,
  currentPlayer,
  r2rPlayback,
}: {
  readonly panelId: string;
  readonly current: PanelPresentationOperation | null;
  readonly lastApplied: PanelPresentationOperation | null;
  readonly currentPlayer: SharedStagePlayerSnapshot;
  /** Exact pending target supplied by the async-result owner, if any. */
  readonly r2rPlayback?: R2rPlaybackPresentation | null;
}): PanelPresentationIntent {
  const stageOwner: PanelStageOwner = panelId === "r2r" ? "r2r" : "h2r";
  const predecessorIsUnsettled = current !== null && current !== lastApplied;
  const predecessorCarriesR2rBaseline = Boolean(
    current
    && (
      current.value.stageOwner === "r2r"
      || (predecessorIsUnsettled && current.value.restoreH2rPlayer)
    ),
  );
  let h2rReturnBaseline: SharedStagePlayerSnapshot;
  if (predecessorCarriesR2rBaseline && current) {
    h2rReturnBaseline = current.value.h2rReturnBaseline;
  } else {
    h2rReturnBaseline = freezePlayerSnapshot(currentPlayer);
  }
  const stableSameOwner = Boolean(
    current
    && current === lastApplied
    && current.value.stageOwner === stageOwner,
  );
  const inheritedR2rPlayback = (
    r2rPlayback === undefined
    && stageOwner === "r2r"
    && predecessorIsUnsettled
    && current?.value.stageOwner === "r2r"
  ) ? current.value.r2rPlayback : null;

  return Object.freeze({
    panelId,
    stageOwner,
    h2rReturnBaseline,
    restoreH2rPlayer:
      stageOwner === "h2r" && predecessorCarriesR2rBaseline,
    resetSharedPlayback: stageOwner === "r2r" && !stableSameOwner,
    r2rPlayback: stageOwner === "r2r"
      ? r2rPlayback === undefined ? inheritedR2rPlayback : r2rPlayback
      : null,
  });
}
