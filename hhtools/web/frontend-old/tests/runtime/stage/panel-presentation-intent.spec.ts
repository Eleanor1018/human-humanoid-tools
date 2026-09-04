import { describe, expect, it } from "vitest";

import { LatestPresentationOperationCoordinator } from
  "../../../src/runtime/stage/latest-presentation-operation";
import {
  appliedPanelPresentationOwnsStage,
  createPanelPresentationIntent,
  createR2rPlaybackPresentation,
  type PanelPresentationIntent,
  type PanelPresentationOperation,
  type SharedStagePlayerSnapshot,
} from "../../../src/runtime/stage/panel-presentation-intent";

function player(t: number, playing = false): SharedStagePlayerSnapshot {
  return {
    t,
    duration: 10,
    active: true,
    playing,
    playbarVisible: true,
  };
}

describe("createPanelPresentationIntent", () => {
  it("freezes a fresh H2R-to-R2R root baseline", () => {
    const intent = createPanelPresentationIntent({
      panelId: "r2r",
      current: null,
      lastApplied: null,
      currentPlayer: player(2, true),
    });

    expect(intent).toEqual({
      panelId: "r2r",
      stageOwner: "r2r",
      h2rReturnBaseline: player(2, true),
      restoreH2rPlayer: false,
      resetSharedPlayback: true,
      r2rPlayback: null,
    });
    expect(Object.isFrozen(intent)).toBe(true);
    expect(Object.isFrozen(intent.h2rReturnBaseline)).toBe(true);
  });

  it("carries one exact frozen R2R playback target", () => {
    const playback = createR2rPlaybackPresentation({
      duration: 4,
      t: 1,
      playing: false,
    });

    const intent = createPanelPresentationIntent({
      panelId: "r2r",
      current: null,
      lastApplied: null,
      currentPlayer: player(2),
      r2rPlayback: playback,
    });

    expect(intent.r2rPlayback).toBe(playback);
    expect(playback).toEqual({
      t: 1,
      duration: 4,
      active: true,
      playing: false,
      playbarVisible: true,
    });
    expect(Object.isFrozen(playback)).toBe(true);
  });

  it("never lets an H2R intent carry an R2R playback capability", () => {
    const intent = createPanelPresentationIntent({
      panelId: "motion",
      current: null,
      lastApplied: null,
      currentPlayer: player(2),
      r2rPlayback: createR2rPlaybackPresentation({ duration: 4 }),
    });

    expect(intent.r2rPlayback).toBeNull();
  });

  it("inherits playback only across an unsettled same-R2R successor", () => {
    const playback = createR2rPlaybackPresentation({ duration: 4 });
    const coordinator = new LatestPresentationOperationCoordinator<
      PanelPresentationIntent
    >({ project: () => undefined });
    coordinator.publish(createPanelPresentationIntent({
      panelId: "r2r",
      current: null,
      lastApplied: null,
      currentPlayer: player(2),
      r2rPlayback: playback,
    }));

    const inherited = createPanelPresentationIntent({
      panelId: "r2r",
      current: coordinator.current,
      lastApplied: null,
      currentPlayer: player(8),
    });
    const explicitlyCleared = createPanelPresentationIntent({
      panelId: "r2r",
      current: coordinator.current,
      lastApplied: null,
      currentPlayer: player(8),
      r2rPlayback: null,
    });

    expect(inherited.r2rPlayback).toBe(playback);
    expect(explicitlyCleared.r2rPlayback).toBeNull();
  });

  it("inherits the root baseline across repeated R2R requests", () => {
    let lastApplied: PanelPresentationOperation | null = null;
    const coordinator = new LatestPresentationOperationCoordinator<
      PanelPresentationIntent
    >({
      project: (target) => {
        lastApplied = target.current;
        return undefined;
      },
    });
    const firstIntent = createPanelPresentationIntent({
      panelId: "r2r",
      current: coordinator.current,
      lastApplied,
      currentPlayer: player(2),
    });
    coordinator.publish(firstIntent);
    coordinator.reconcile();

    const repeated = createPanelPresentationIntent({
      panelId: "r2r",
      current: coordinator.current,
      lastApplied,
      // This is already R2R player state and must never replace the H2R root.
      currentPlayer: player(8, true),
    });

    expect(repeated.h2rReturnBaseline).toBe(firstIntent.h2rReturnBaseline);
    expect(repeated.resetSharedPlayback).toBe(false);
  });

  it("carries the root through a pending H2R return and nested R2R reclaim", () => {
    let lastApplied: PanelPresentationOperation | null = null;
    const coordinator = new LatestPresentationOperationCoordinator<
      PanelPresentationIntent
    >({
      project: (target) => {
        lastApplied = target.current;
        return undefined;
      },
    });
    const root = createPanelPresentationIntent({
      panelId: "r2r",
      current: null,
      lastApplied,
      currentPlayer: player(3),
    });
    coordinator.publish(root);
    coordinator.reconcile();

    const pendingReturn = createPanelPresentationIntent({
      panelId: "motion",
      current: coordinator.current,
      lastApplied,
      currentPlayer: player(9),
    });
    coordinator.publish(pendingReturn);
    const reclaim = createPanelPresentationIntent({
      panelId: "r2r",
      current: coordinator.current,
      lastApplied,
      currentPlayer: player(7),
    });

    expect(pendingReturn.restoreH2rPlayer).toBe(true);
    expect(reclaim.h2rReturnBaseline).toBe(root.h2rReturnBaseline);
    expect(reclaim.resetSharedPlayback).toBe(true);
  });

  it("keeps a repeated pending H2R return responsible for restoration", () => {
    let lastApplied: PanelPresentationOperation | null = null;
    const coordinator = new LatestPresentationOperationCoordinator<
      PanelPresentationIntent
    >({
      project: (target) => {
        lastApplied = target.current;
        return undefined;
      },
    });
    const root = createPanelPresentationIntent({
      panelId: "r2r",
      current: null,
      lastApplied,
      currentPlayer: player(4),
    });
    coordinator.publish(root);
    coordinator.reconcile();
    const firstReturn = createPanelPresentationIntent({
      panelId: "motion",
      current: coordinator.current,
      lastApplied,
      currentPlayer: player(8),
    });
    coordinator.publish(firstReturn);

    const secondReturn = createPanelPresentationIntent({
      panelId: "batch",
      current: coordinator.current,
      lastApplied,
      currentPlayer: player(9),
    });

    expect(secondReturn.restoreH2rPlayer).toBe(true);
    expect(secondReturn.h2rReturnBaseline).toBe(root.h2rReturnBaseline);
  });

  it("captures a new root only after H2R restoration is applied", () => {
    let lastApplied: PanelPresentationOperation | null = null;
    const coordinator = new LatestPresentationOperationCoordinator<
      PanelPresentationIntent
    >({
      project: (target) => {
        lastApplied = target.current;
        return undefined;
      },
    });
    const firstR2r = createPanelPresentationIntent({
      panelId: "r2r",
      current: null,
      lastApplied,
      currentPlayer: player(1),
    });
    coordinator.publish(firstR2r);
    coordinator.reconcile();
    const restored = createPanelPresentationIntent({
      panelId: "h2r",
      current: coordinator.current,
      lastApplied,
      currentPlayer: player(8),
    });
    coordinator.publish(restored);
    coordinator.reconcile();

    const nextR2r = createPanelPresentationIntent({
      panelId: "r2r",
      current: coordinator.current,
      lastApplied,
      currentPlayer: player(6, true),
    });

    expect(nextR2r.h2rReturnBaseline).toEqual(player(6, true));
    expect(nextR2r.h2rReturnBaseline).not.toBe(firstR2r.h2rReturnBaseline);
  });

  it("keeps semantic R2R ownership across a same-owner successor", () => {
    let lastApplied: PanelPresentationOperation | null = null;
    let nestedDisposition: string | null = null;
    let shouldReenter = false;
    let coordinator: LatestPresentationOperationCoordinator<
      PanelPresentationIntent
    >;
    coordinator = new LatestPresentationOperationCoordinator({
      project: (target, authority) => {
        const operation = target.current;
        if (!operation) return undefined;
        if (operation.value.stageOwner === "r2r" && shouldReenter) {
          shouldReenter = false;
          const successor = createPanelPresentationIntent({
            panelId: "r2r",
            current: coordinator.current,
            lastApplied,
            currentPlayer: player(9),
          });
          coordinator.publish(successor);
          nestedDisposition = coordinator.reconcile();
        }
        if (authority.isCurrent()) lastApplied = operation;
        return undefined;
      },
    });
    coordinator.publish(createPanelPresentationIntent({
      panelId: "h2r",
      current: null,
      lastApplied,
      currentPlayer: player(2),
    }));
    coordinator.reconcile();

    shouldReenter = true;
    const replacedOperation = coordinator.publish(
      createPanelPresentationIntent({
        panelId: "r2r",
        current: coordinator.current,
        lastApplied,
        currentPlayer: player(2),
      }),
    ).current;
    coordinator.reconcile();

    expect(nestedDisposition).toBe("deferred");
    expect(coordinator.isCurrent(replacedOperation)).toBe(false);
    expect(appliedPanelPresentationOwnsStage({
      current: coordinator.current,
      lastApplied,
      stageOwner: "r2r",
    })).toBe(true);
  });

  it("repairs a late panel commit with the nested operation and root baseline", () => {
    const order: string[] = [];
    let physicalPanel = "motion";
    let physicalOwner = "h2r";
    let physicalPlayer = player(2, true);
    let lastApplied: PanelPresentationOperation | null = null;
    let nestedDisposition: string | null = null;
    let shouldReenter = true;
    let coordinator: LatestPresentationOperationCoordinator<
      PanelPresentationIntent
    >;

    const request = (panelId: string): void => {
      const intent = createPanelPresentationIntent({
        panelId,
        current: coordinator.current,
        lastApplied,
        currentPlayer: physicalPlayer,
      });
      coordinator.publish(intent);
      const disposition = coordinator.reconcile();
      if (panelId === "motion") nestedDisposition = disposition;
    };
    coordinator = new LatestPresentationOperationCoordinator({
      project: (target, authority) => {
        const operation = target.current;
        if (!operation) return undefined;
        const intent = operation.value;
        order.push(`${intent.panelId}:host-start`);
        physicalPanel = intent.panelId;
        if (intent.panelId === "r2r" && shouldReenter) {
          shouldReenter = false;
          request("motion");
          // Simulate a browser/React host that commits A only after the nested
          // request has returned to its still-active setter frame.
          physicalPanel = "r2r-late";
          order.push("r2r:late-commit");
        }
        if (!authority.isCurrent()) return undefined;
        physicalOwner = intent.stageOwner;
        if (intent.restoreH2rPlayer) {
          physicalPlayer = {
            ...intent.h2rReturnBaseline,
            playing: false,
          };
        }
        lastApplied = operation;
        order.push(`${intent.panelId}:applied`);
        return undefined;
      },
    });

    request("r2r");

    expect(nestedDisposition).toBe("deferred");
    expect(order).toEqual([
      "r2r:host-start",
      "r2r:late-commit",
      "motion:host-start",
      "motion:applied",
    ]);
    expect(physicalPanel).toBe("motion");
    expect(physicalOwner).toBe("h2r");
    expect(physicalPlayer).toEqual(player(2, false));
  });
});
