import { describe, expect, it, vi } from "vitest";

import {
  H2R_STAGE_LAYER_IDS,
  H2rStageDisplayPublisher,
  projectH2rPhysicalVisibility,
  projectH2rStageDisplaySnapshot,
  type H2rStageDisplayFacts,
  type H2rStageDisplaySnapshot,
  type H2rStagePhysicalVisibilityFacts,
} from "../../src/runtime/h2r-stage-display";

function createMutableSnapshot() {
  return {
    ownsStage: true,
    empty: false,
    canResetView: true,
    layers: {
      sourceSkeleton: { available: true, visible: true, canToggle: true },
      sourceBody: { available: true, visible: false, canToggle: true },
      sourceEnvironment: {
        available: false,
        visible: true,
        canToggle: true,
      },
      scaledSkeleton: {
        available: true,
        visible: false,
        canToggle: false,
      },
      scaledEnvironment: {
        available: false,
        visible: false,
        canToggle: false,
      },
      targetRobot: { available: true, visible: true, canToggle: true },
    },
  };
}

function createDisplayFacts(
  overrides: Partial<H2rStageDisplayFacts> = {},
): H2rStageDisplayFacts {
  return {
    ownsStage: true,
    calibrationMode: false,
    hasMotion: true,
    hasRobot: true,
    layers: Object.fromEntries(
      H2R_STAGE_LAYER_IDS.map((id) => [
        id,
        { available: true, visible: true },
      ]),
    ) as H2rStageDisplayFacts["layers"],
    ...overrides,
  };
}

function layerFlags(value: boolean): Record<
  (typeof H2R_STAGE_LAYER_IDS)[number],
  boolean
> {
  return Object.fromEntries(
    H2R_STAGE_LAYER_IDS.map((id) => [id, value]),
  ) as Record<(typeof H2R_STAGE_LAYER_IDS)[number], boolean>;
}

function createPhysicalFacts(
  overrides: Partial<H2rStagePhysicalVisibilityFacts> = {},
): H2rStagePhysicalVisibilityFacts {
  return {
    ownsStage: true,
    calibrationMode: false,
    bodyUsesSkin: false,
    requested: layerFlags(true),
    available: layerFlags(true),
    ...overrides,
  };
}

describe("projectH2rPhysicalVisibility", () => {
  it("keeps every H2R group hidden while R2R owns the Stage", () => {
    const physical = projectH2rPhysicalVisibility(
      createPhysicalFacts({ ownsStage: false }),
    );

    expect(Object.values(physical).every((visible) => !visible)).toBe(true);
  });

  it("applies the newest requested visibility only after ownership returns", () => {
    const requested = layerFlags(false);
    requested.sourceSkeleton = true;

    expect(projectH2rPhysicalVisibility(createPhysicalFacts({
      ownsStage: false,
      requested,
    })).sourceSkeleton).toBe(false);
    expect(projectH2rPhysicalVisibility(createPhysicalFacts({
      ownsStage: true,
      requested,
    })).sourceSkeleton).toBe(true);
  });

  it("keeps capsule and baked body renderers mutually exclusive", () => {
    const mesh = projectH2rPhysicalVisibility(createPhysicalFacts({
      bodyUsesSkin: false,
    }));
    const skin = projectH2rPhysicalVisibility(createPhysicalFacts({
      bodyUsesSkin: true,
    }));
    const hidden = projectH2rPhysicalVisibility(createPhysicalFacts({
      ownsStage: false,
      bodyUsesSkin: true,
    }));

    expect([mesh.sourceBodyMesh, mesh.sourceBodySkin]).toEqual([true, false]);
    expect([skin.sourceBodyMesh, skin.sourceBodySkin]).toEqual([false, true]);
    expect([hidden.sourceBodyMesh, hidden.sourceBodySkin]).toEqual([false, false]);
  });

  it("locks comparison groups in calibration but leaves the target robot visible", () => {
    const physical = projectH2rPhysicalVisibility(createPhysicalFacts({
      calibrationMode: true,
    }));

    expect(physical).toEqual({
      sourceSkeleton: false,
      sourceBodyMesh: false,
      sourceBodySkin: false,
      sourceEnvironment: false,
      scaledSkeleton: false,
      scaledEnvironment: false,
      targetRobot: true,
    });
  });

  it("waits to expose a newly available layer until H2R reacquires Stage", () => {
    const available = layerFlags(true);
    available.scaledEnvironment = false;
    expect(projectH2rPhysicalVisibility(createPhysicalFacts({
      ownsStage: false,
      available,
    })).scaledEnvironment).toBe(false);

    available.scaledEnvironment = true;
    expect(projectH2rPhysicalVisibility(createPhysicalFacts({
      ownsStage: false,
      available,
    })).scaledEnvironment).toBe(false);
    expect(projectH2rPhysicalVisibility(createPhysicalFacts({
      ownsStage: true,
      available,
    })).scaledEnvironment).toBe(true);
  });
});

describe("projectH2rStageDisplaySnapshot", () => {
  it("separates availability, visibility, and calibration capability", () => {
    const facts = createDisplayFacts({
      calibrationMode: true,
      layers: {
        ...createDisplayFacts().layers,
        sourceEnvironment: { available: false, visible: true },
      },
    });

    const snapshot = projectH2rStageDisplaySnapshot(facts);

    expect(snapshot.layers.sourceEnvironment).toEqual({
      available: false,
      visible: false,
      canToggle: false,
    });
    expect(snapshot.layers.sourceSkeleton.canToggle).toBe(false);
    expect(snapshot.layers.scaledEnvironment.canToggle).toBe(false);
    expect(snapshot.layers.targetRobot.canToggle).toBe(true);
  });

  it("closes all H2R commands while R2R owns the shared Stage", () => {
    const snapshot = projectH2rStageDisplaySnapshot(
      createDisplayFacts({ ownsStage: false }),
    );

    expect(snapshot.canResetView).toBe(false);
    expect(
      Object.values(snapshot.layers).every((layer) => !layer.canToggle),
    ).toBe(true);
  });

  it("derives empty and reset state from loaded domain resources", () => {
    const empty = projectH2rStageDisplaySnapshot(createDisplayFacts({
      hasMotion: false,
      hasRobot: false,
    }));

    expect(empty.empty).toBe(true);
    expect(empty.canResetView).toBe(false);
  });
});

describe("H2rStageDisplayPublisher", () => {
  it("immediately exposes one normalized, deeply frozen full snapshot", () => {
    const mutable = createMutableSnapshot();
    const publisher = new H2rStageDisplayPublisher(() => mutable, vi.fn());
    const listener = vi.fn<(snapshot: H2rStageDisplaySnapshot) => void>();

    publisher.subscribe(listener);

    expect(listener).toHaveBeenCalledOnce();
    const current = listener.mock.calls[0][0];
    expect(Object.keys(current.layers)).toEqual(H2R_STAGE_LAYER_IDS);
    expect(current.layers.sourceEnvironment).toEqual({
      available: false,
      visible: false,
      canToggle: false,
    });
    expect(Object.isFrozen(current)).toBe(true);
    expect(Object.isFrozen(current.layers)).toBe(true);
    expect(Object.values(current.layers).every(Object.isFrozen)).toBe(true);
  });

  it("deduplicates no-ops and publishes a changed capability", () => {
    const mutable = createMutableSnapshot();
    const publisher = new H2rStageDisplayPublisher(() => mutable, vi.fn());
    const listener = vi.fn<(snapshot: H2rStageDisplaySnapshot) => void>();
    publisher.subscribe(listener);
    listener.mockClear();

    publisher.markChanged();
    mutable.layers.scaledSkeleton.canToggle = true;
    publisher.markChanged();
    publisher.markChanged();

    expect(listener).toHaveBeenCalledOnce();
    expect(
      listener.mock.calls[0][0].layers.scaledSkeleton.canToggle,
    ).toBe(true);
  });

  it("coalesces nested synchronous batches into one final snapshot", () => {
    const mutable = createMutableSnapshot();
    const publisher = new H2rStageDisplayPublisher(() => mutable, vi.fn());
    const listener = vi.fn<(snapshot: H2rStageDisplaySnapshot) => void>();
    publisher.subscribe(listener);
    listener.mockClear();

    publisher.runBatch(() => {
      mutable.layers.sourceSkeleton.visible = false;
      publisher.markChanged();
      publisher.runBatch(() => {
        mutable.layers.sourceBody.visible = true;
        publisher.markChanged();
        mutable.layers.targetRobot.visible = false;
      });
    });

    expect(listener).toHaveBeenCalledOnce();
    expect(listener.mock.calls[0][0].layers).toMatchObject({
      sourceSkeleton: { visible: false },
      sourceBody: { visible: true },
      targetRobot: { visible: false },
    });
  });

  it("publishes committed mutations without masking a batch error", () => {
    const mutable = createMutableSnapshot();
    const publisher = new H2rStageDisplayPublisher(() => mutable, vi.fn());
    const listener = vi.fn<(snapshot: H2rStageDisplaySnapshot) => void>();
    const failure = new Error("mutation failed after commit");
    publisher.subscribe(listener);
    listener.mockClear();

    expect(() =>
      publisher.runBatch(() => {
        mutable.layers.sourceSkeleton.visible = false;
        throw failure;
      }),
    ).toThrow(failure);

    expect(listener).toHaveBeenCalledOnce();
    expect(listener.mock.calls[0][0].layers.sourceSkeleton.visible).toBe(false);
  });

  it("closes reset and interaction capabilities while R2R owns Stage", () => {
    const mutable = createMutableSnapshot();
    const publisher = new H2rStageDisplayPublisher(() => mutable, vi.fn());
    const listener = vi.fn<(snapshot: H2rStageDisplaySnapshot) => void>();
    publisher.subscribe(listener);
    listener.mockClear();

    mutable.ownsStage = false;
    publisher.markChanged();

    const current = listener.mock.calls[0][0];
    expect(current.canResetView).toBe(false);
    expect(
      Object.values(current.layers).every((layer) => !layer.canToggle),
    ).toBe(true);
  });

  it("gives late subscribers committed state without replaying existing listeners", () => {
    const mutable = createMutableSnapshot();
    const reportError = vi.fn(() => {
      throw new Error("reporter failed");
    });
    const publisher = new H2rStageDisplayPublisher(
      () => mutable,
      reportError,
    );
    const first = vi.fn<(snapshot: H2rStageDisplaySnapshot) => void>();
    const failure = new Error("observer failed");
    publisher.subscribe(first);
    publisher.subscribe(() => {
      throw failure;
    });
    first.mockClear();

    mutable.layers.sourceBody.visible = true;
    publisher.markChanged();
    expect(first).toHaveBeenCalledOnce();
    first.mockClear();

    const late = vi.fn<(snapshot: H2rStageDisplaySnapshot) => void>();
    const unsubscribe = publisher.subscribe(late);

    expect(first).not.toHaveBeenCalled();
    expect(late).toHaveBeenCalledOnce();
    expect(reportError).toHaveBeenCalledWith(failure);
    unsubscribe();
    unsubscribe();
    mutable.layers.sourceBody.visible = false;
    publisher.markChanged();
    expect(late).toHaveBeenCalledOnce();
  });

  it("never exposes a synchronous batch's intermediate state", () => {
    const mutable = createMutableSnapshot();
    const publisher = new H2rStageDisplayPublisher(() => mutable, vi.fn());
    const existing = vi.fn<(snapshot: H2rStageDisplaySnapshot) => void>();
    const late = vi.fn<(snapshot: H2rStageDisplaySnapshot) => void>();
    publisher.subscribe(existing);
    existing.mockClear();

    publisher.runBatch(() => {
      mutable.layers.sourceSkeleton.visible = false;
      publisher.markChanged();
      publisher.subscribe(late);
      mutable.layers.sourceBody.visible = true;
      publisher.markChanged();
    });

    expect(existing).toHaveBeenCalledOnce();
    expect(existing.mock.calls[0][0].layers).toMatchObject({
      sourceSkeleton: { visible: false },
      sourceBody: { visible: true },
    });
    // A batch-time subscriber first sees the prior committed state, then the
    // one final state; it never sees skeleton hidden while body is still off.
    expect(late).toHaveBeenCalledTimes(2);
    expect(late.mock.calls[0][0].layers.sourceSkeleton.visible).toBe(true);
    expect(late.mock.calls[1][0].layers).toMatchObject({
      sourceSkeleton: { visible: false },
      sourceBody: { visible: true },
    });
  });

  it("keeps duplicate callback subscriptions independently disposable", () => {
    const mutable = createMutableSnapshot();
    const publisher = new H2rStageDisplayPublisher(() => mutable, vi.fn());
    const listener = vi.fn<(snapshot: H2rStageDisplaySnapshot) => void>();
    const unsubscribeFirst = publisher.subscribe(listener);
    const unsubscribeSecond = publisher.subscribe(listener);
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribeFirst();
    mutable.layers.sourceBody.visible = true;
    publisher.markChanged();
    expect(listener).toHaveBeenCalledTimes(3);

    unsubscribeSecond();
    mutable.layers.sourceBody.visible = false;
    publisher.markChanged();
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it("serializes re-entrant changes so siblings never observe time backwards", () => {
    const mutable = createMutableSnapshot();
    const publisher = new H2rStageDisplayPublisher(() => mutable, vi.fn());
    let armed = false;
    publisher.subscribe((current) => {
      if (
        armed &&
        current.layers.sourceBody.visible &&
        current.layers.targetRobot.visible
      ) {
        mutable.layers.targetRobot.visible = false;
        publisher.markChanged();
      }
    });
    const observed: Array<readonly [boolean, boolean]> = [];
    publisher.subscribe((current) => {
      if (armed) {
        observed.push([
          current.layers.sourceBody.visible,
          current.layers.targetRobot.visible,
        ]);
      }
    });

    armed = true;
    mutable.layers.sourceBody.visible = true;
    publisher.markChanged();

    expect(observed).toEqual([
      [true, true],
      [true, false],
    ]);
  });

  it("cancels re-entrant changes that return to the delivered state", () => {
    const mutable = createMutableSnapshot();
    const publisher = new H2rStageDisplayPublisher(() => mutable, vi.fn());
    let armed = false;
    publisher.subscribe((current) => {
      if (
        armed &&
        current.layers.sourceBody.visible &&
        current.layers.targetRobot.visible
      ) {
        mutable.layers.targetRobot.visible = false;
        publisher.markChanged();
      }
    });
    const observed = vi.fn<(snapshot: H2rStageDisplaySnapshot) => void>(
      (current) => {
        if (
          armed &&
          current.layers.sourceBody.visible &&
          current.layers.targetRobot.visible
        ) {
          mutable.layers.targetRobot.visible = true;
          publisher.markChanged();
        }
      },
    );
    publisher.subscribe(observed);
    observed.mockClear();

    armed = true;
    mutable.layers.sourceBody.visible = true;
    publisher.markChanged();

    expect(observed).toHaveBeenCalledOnce();
    expect(observed.mock.calls[0][0].layers).toMatchObject({
      sourceBody: { visible: true },
      targetRobot: { visible: true },
    });
  });

  it("does not let a snapshot-reader failure break renderer mutations", () => {
    const mutable = createMutableSnapshot();
    const failure = new Error("snapshot read failed");
    let fail = false;
    const reportError = vi.fn(() => {
      throw new Error("reporter failed");
    });
    const publisher = new H2rStageDisplayPublisher(() => {
      if (fail) throw failure;
      return mutable;
    }, reportError);
    const listener = vi.fn<(snapshot: H2rStageDisplaySnapshot) => void>();
    publisher.subscribe(listener);
    listener.mockClear();

    fail = true;
    expect(() => publisher.markChanged()).not.toThrow();
    expect(reportError).toHaveBeenCalledWith(failure);

    fail = false;
    mutable.layers.sourceSkeleton.visible = false;
    publisher.markChanged();
    expect(listener).toHaveBeenCalledOnce();
  });
});
