/**
 * Legacy-local DTO and publisher for the six H2R Stage layers.
 *
 * This module is intentionally pure: it knows nothing about DOM ids, Three.js,
 * React, or Workbench services. The compatibility renderer supplies a reader,
 * while its browser facade translates these DTOs into the canonical Stage
 * contract during the migration.
 */

export const H2R_STAGE_LAYER_IDS = [
  "sourceSkeleton",
  "sourceBody",
  "sourceEnvironment",
  "scaledSkeleton",
  "scaledEnvironment",
  "targetRobot",
] as const;

export type H2rStageLayerId = (typeof H2R_STAGE_LAYER_IDS)[number];

export interface H2rStageLayerSnapshot {
  readonly available: boolean;
  readonly visible: boolean;
  readonly canToggle: boolean;
}

export type H2rStageLayerSnapshots = Readonly<
  Record<H2rStageLayerId, H2rStageLayerSnapshot>
>;

export interface H2rStageDisplaySnapshot {
  /** False while R2R temporarily owns the shared canvas and player. */
  readonly ownsStage: boolean;
  readonly empty: boolean;
  readonly canResetView: boolean;
  readonly layers: H2rStageLayerSnapshots;
}

/** Renderer facts supplied by the legacy boundary before policy is applied. */
export interface H2rStageDisplayFacts {
  readonly ownsStage: boolean;
  readonly calibrationMode: boolean;
  readonly hasMotion: boolean;
  readonly hasRobot: boolean;
  readonly layers: Readonly<
    Record<H2rStageLayerId, Readonly<{ available: boolean; visible: boolean }>>
  >;
}

export interface H2rStagePhysicalVisibilityFacts {
  readonly ownsStage: boolean;
  readonly calibrationMode: boolean;
  readonly bodyUsesSkin: boolean;
  readonly requested: Readonly<Record<H2rStageLayerId, boolean>>;
  readonly available: Readonly<Record<H2rStageLayerId, boolean>>;
}

/** Seven renderer groups implement six semantic layers because body has two backends. */
export interface H2rStagePhysicalVisibility {
  readonly sourceSkeleton: boolean;
  readonly sourceBodyMesh: boolean;
  readonly sourceBodySkin: boolean;
  readonly sourceEnvironment: boolean;
  readonly scaledSkeleton: boolean;
  readonly scaledEnvironment: boolean;
  readonly targetRobot: boolean;
}

/**
 * Project logical visibility onto renderer groups without losing intent while
 * R2R owns the shared canvas. The body backends remain mutually exclusive.
 */
export function projectH2rPhysicalVisibility(
  facts: H2rStagePhysicalVisibilityFacts,
): H2rStagePhysicalVisibility {
  const canRender = (id: H2rStageLayerId): boolean =>
    facts.ownsStage &&
    facts.available[id] &&
    facts.requested[id] &&
    (id === "targetRobot" || !facts.calibrationMode);
  const sourceBody = canRender("sourceBody");

  return {
    sourceSkeleton: canRender("sourceSkeleton"),
    sourceBodyMesh: sourceBody && !facts.bodyUsesSkin,
    sourceBodySkin: sourceBody && facts.bodyUsesSkin,
    sourceEnvironment: canRender("sourceEnvironment"),
    scaledSkeleton: canRender("scaledSkeleton"),
    scaledEnvironment: canRender("scaledEnvironment"),
    targetRobot: canRender("targetRobot"),
  };
}

/**
 * Apply workflow policy to raw renderer facts without depending on the DOM or
 * Three.js. Calibration locks the five comparison layers while leaving the
 * target robot inspectable; R2R ownership locks every H2R control.
 */
export function projectH2rStageDisplaySnapshot(
  facts: H2rStageDisplayFacts,
): H2rStageDisplaySnapshot {
  const ownsStage = Boolean(facts.ownsStage);
  const empty = !facts.hasMotion && !facts.hasRobot;
  const standardLayersCanToggle = ownsStage && !facts.calibrationMode;
  const layers = Object.fromEntries(
    H2R_STAGE_LAYER_IDS.map((id) => {
      const available = Boolean(facts.layers[id].available);
      return [id, {
        available,
        visible: available && Boolean(facts.layers[id].visible),
        canToggle: available && (
          id === "targetRobot" ? ownsStage : standardLayersCanToggle
        ),
      }];
    }),
  ) as Record<H2rStageLayerId, H2rStageLayerSnapshot>;

  return {
    ownsStage,
    empty,
    canResetView: ownsStage && !empty,
    layers,
  };
}

export type H2rStageDisplaySnapshotReader = () => H2rStageDisplaySnapshot;
export type H2rStageDisplayListener = (
  snapshot: H2rStageDisplaySnapshot,
) => void;

interface ListenerSubscription {
  readonly listener: H2rStageDisplayListener;
  lastDelivered: H2rStageDisplaySnapshot | null;
}

function freezeLayer(
  state: H2rStageLayerSnapshot,
  ownsStage: boolean,
): H2rStageLayerSnapshot {
  const available = Boolean(state.available);
  return Object.freeze({
    available,
    visible: available && Boolean(state.visible),
    canToggle: ownsStage && available && Boolean(state.canToggle),
  });
}

function freezeSnapshot(
  candidate: H2rStageDisplaySnapshot,
): H2rStageDisplaySnapshot {
  const ownsStage = Boolean(candidate.ownsStage);
  const empty = Boolean(candidate.empty);
  const layers = Object.fromEntries(
    H2R_STAGE_LAYER_IDS.map((id) => [
      id,
      freezeLayer(candidate.layers[id], ownsStage),
    ]),
  ) as Record<H2rStageLayerId, H2rStageLayerSnapshot>;

  return Object.freeze({
    ownsStage,
    empty,
    canResetView: ownsStage && !empty && Boolean(candidate.canResetView),
    layers: Object.freeze(layers),
  });
}

function snapshotsEqual(
  left: H2rStageDisplaySnapshot,
  right: H2rStageDisplaySnapshot,
): boolean {
  if (
    left.ownsStage !== right.ownsStage ||
    left.empty !== right.empty ||
    left.canResetView !== right.canResetView
  ) {
    return false;
  }
  return H2R_STAGE_LAYER_IDS.every((id) => {
    const previous = left.layers[id];
    const next = right.layers[id];
    return (
      previous.available === next.available &&
      previous.visible === next.visible &&
      previous.canToggle === next.canToggle
    );
  });
}

/**
 * Synchronous, structurally deduplicated publisher around renderer-owned state.
 *
 * `runBatch` must contain synchronous mutations only. It coalesces nested
 * setters and resource commits into one final full snapshot; it deliberately
 * cannot hold a transaction open across an `await` and absorb unrelated work.
 */
export class H2rStageDisplayPublisher {
  readonly #readSnapshot: H2rStageDisplaySnapshotReader;
  readonly #reportError: (error: unknown) => void;
  // A record per call keeps duplicate callback registrations independently
  // disposable, matching the repository's base Event subscription semantics.
  readonly #listeners = new Set<ListenerSubscription>();
  #lastSnapshot: H2rStageDisplaySnapshot | null = null;
  #batchDepth = 0;
  #dirty = false;
  #delivering = false;
  #queuedSnapshot: H2rStageDisplaySnapshot | null = null;

  constructor(
    readSnapshot: H2rStageDisplaySnapshotReader,
    reportError: (error: unknown) => void,
  ) {
    this.#readSnapshot = readSnapshot;
    this.#reportError = reportError;
  }

  #readCurrent(): H2rStageDisplaySnapshot {
    return freezeSnapshot(this.#readSnapshot());
  }

  subscribe(listener: H2rStageDisplayListener): () => void {
    // The first listener establishes the initial committed snapshot. During a
    // batch there is no committed initial state yet, so delivery waits for the
    // outermost batch to finish instead of exposing its intermediate state.
    if (this.#lastSnapshot === null && this.#batchDepth === 0) {
      this.#lastSnapshot = this.#readCurrent();
    }

    const subscription: ListenerSubscription = {
      listener,
      lastDelivered: null,
    };
    this.#listeners.add(subscription);
    if (this.#lastSnapshot) {
      this.#deliverOne(subscription, this.#lastSnapshot);
    }

    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      this.#listeners.delete(subscription);
    };
  }

  /** Re-read and publish immediately, unless an outer synchronous batch owns it. */
  markChanged(): void {
    this.#dirty = true;
    if (this.#batchDepth === 0) this.#flush();
  }

  /** Coalesce all synchronous mutations in `operation` into one final snapshot. */
  runBatch(operation: () => void): void {
    this.#batchDepth += 1;
    try {
      operation();
    } finally {
      this.#batchDepth -= 1;
      this.#dirty = true;
      if (this.#batchDepth === 0) this.#flush();
    }
  }

  #flush(): void {
    if (!this.#dirty) return;
    this.#dirty = false;
    let next: H2rStageDisplaySnapshot;
    try {
      next = this.#readCurrent();
    } catch (error) {
      // Projection is observational. A broken snapshot reader must not roll
      // back or interrupt the renderer mutation that asked us to publish.
      this.#reportSafely(error);
      return;
    }
    if (
      this.#lastSnapshot !== null &&
      snapshotsEqual(this.#lastSnapshot, next)
    ) {
      return;
    }
    this.#lastSnapshot = next;
    this.#deliver(next);
  }

  #deliver(snapshot: H2rStageDisplaySnapshot): void {
    if (this.#delivering) {
      // Full snapshots let us retain only the newest re-entrant state while
      // still finishing the current delivery before any observer advances.
      this.#queuedSnapshot = snapshot;
      return;
    }

    this.#delivering = true;
    let next: H2rStageDisplaySnapshot | null = snapshot;
    try {
      while (next) {
        const current = next;
        next = null;
        for (const subscription of [...this.#listeners]) {
          this.#deliverOne(subscription, current);
        }
        next = this.#queuedSnapshot;
        this.#queuedSnapshot = null;
      }
    } finally {
      this.#delivering = false;
    }
  }

  #deliverOne(
    subscription: ListenerSubscription,
    snapshot: H2rStageDisplaySnapshot,
  ): void {
    if (
      subscription.lastDelivered !== null &&
      snapshotsEqual(subscription.lastDelivered, snapshot)
    ) {
      return;
    }
    // Commit before invoking user code so re-entrant delivery cannot send the
    // same semantic state to this subscription twice.
    subscription.lastDelivered = snapshot;
    try {
      subscription.listener(snapshot);
    } catch (error) {
      this.#reportSafely(error);
    }
  }

  #reportSafely(error: unknown): void {
    try {
      this.#reportError(error);
    } catch {
      // Reporting is observational and cannot break renderer mutations.
    }
  }
}
