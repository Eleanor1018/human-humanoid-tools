import { describe, expect, it, vi } from "vitest";

import { BrowserLegacyStageDisplayStateAdapter } from "../../src/workbench/services/stage/browser/browser-legacy-stage-display-state-adapter";
import type {
  ILegacyStageDisplayStateSource,
  LegacyH2rStageDisplaySnapshot,
} from "../../src/workbench/services/stage/browser/legacy-stage-display-state-source";
import { StageModel } from "../../src/workbench/services/stage/common/stage-model";

function snapshot(
  overrides: Partial<LegacyH2rStageDisplaySnapshot> = {},
): LegacyH2rStageDisplaySnapshot {
  return {
    ownsStage: true,
    empty: false,
    canResetView: true,
    layers: {
      sourceSkeleton: { available: true, visible: true, canToggle: true },
      sourceBody: { available: true, visible: false, canToggle: true },
      sourceEnvironment: {
        available: false,
        visible: false,
        canToggle: false,
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
    ...overrides,
  };
}

function controlledSource() {
  let listener:
    | ((value: LegacyH2rStageDisplaySnapshot) => void)
    | undefined;
  const dispose = vi.fn();
  const source: ILegacyStageDisplayStateSource = {
    subscribeH2rStageDisplayState: vi.fn(async (next) => {
      listener = next;
      return { dispose };
    }),
  };
  return {
    source,
    dispose,
    publish(value: LegacyH2rStageDisplaySnapshot) {
      listener?.(value);
    },
  };
}

describe("BrowserLegacyStageDisplayStateAdapter", () => {
  it("commits one complete H2R display snapshot atomically", async () => {
    const model = new StageModel(vi.fn());
    const legacy = controlledSource();
    const listener = vi.fn();
    model.onDidChangeState(listener);
    const adapter = new BrowserLegacyStageDisplayStateAdapter(
      model,
      legacy.source,
      vi.fn(),
    );
    await vi.waitFor(() =>
      expect(
        legacy.source.subscribeH2rStageDisplayState,
      ).toHaveBeenCalledOnce(),
    );

    const current = snapshot();
    legacy.publish(current);

    expect(listener).toHaveBeenCalledOnce();
    expect(model.state.display).toEqual({
      owner: "h2r",
      empty: current.empty,
      canResetView: current.canResetView,
      layers: current.layers,
    });
    adapter.dispose();
    model.dispose();
  });

  it("projects the active R2R surface while holding the last H2R layers", async () => {
    const model = new StageModel(vi.fn());
    const legacy = controlledSource();
    const listener = vi.fn();
    model.onDidChangeState(listener);
    const adapter = new BrowserLegacyStageDisplayStateAdapter(
      model,
      legacy.source,
      vi.fn(),
    );
    await vi.waitFor(() =>
      expect(
        legacy.source.subscribeH2rStageDisplayState,
      ).toHaveBeenCalledOnce(),
    );
    const h2r = snapshot();
    legacy.publish(h2r);

    const emptyR2r = snapshot({
      ownsStage: false,
      empty: true,
      canResetView: false,
    });
    legacy.publish(emptyR2r);
    legacy.publish(emptyR2r);

    expect(model.state.display).toEqual({
      owner: "r2r",
      empty: true,
      canResetView: false,
      layers: h2r.layers,
    });
    // Repeated inactive snapshots carry no new H2R facts and must not create a
    // second ownership transition.
    expect(listener).toHaveBeenCalledTimes(2);

    legacy.publish(snapshot({
      ownsStage: false,
      empty: false,
      canResetView: true,
      layers: {
        ...h2r.layers,
        sourceSkeleton: {
          available: false,
          visible: false,
          canToggle: false,
        },
      },
    }));
    expect(listener).toHaveBeenCalledTimes(3);
    expect(model.state.display).toEqual({
      owner: "r2r",
      empty: false,
      canResetView: true,
      layers: h2r.layers,
    });

    const restored = snapshot({
      layers: {
        ...h2r.layers,
        sourceBody: { available: true, visible: true, canToggle: true },
      },
    });
    legacy.publish(restored);
    expect(listener).toHaveBeenCalledTimes(4);
    expect(model.state.display.owner).toBe("h2r");
    expect(model.state.display.layers.sourceBody.visible).toBe(true);

    adapter.dispose();
    model.dispose();
  });

  it("disposes a subscription that resolves after Workbench teardown", async () => {
    const model = new StageModel(vi.fn());
    let resolveSubscription:
      | ((subscription: { dispose(): void }) => void)
      | undefined;
    let publish: ((value: LegacyH2rStageDisplaySnapshot) => void) | undefined;
    const dispose = vi.fn();
    const source: ILegacyStageDisplayStateSource = {
      subscribeH2rStageDisplayState: vi.fn(
        (listener) =>
          new Promise<{ dispose(): void }>((resolve) => {
            publish = listener;
            resolveSubscription = resolve;
          }),
      ),
    };
    const adapter = new BrowserLegacyStageDisplayStateAdapter(
      model,
      source,
      vi.fn(),
    );

    adapter.dispose();
    publish?.(snapshot());
    resolveSubscription?.({ dispose });

    await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());
    expect(model.state.display.empty).toBe(true);
    model.dispose();
  });

  it("ignores a subscription failure that arrives after teardown", async () => {
    const model = new StageModel(vi.fn());
    const reportError = vi.fn();
    let rejectSubscription: ((error: unknown) => void) | undefined;
    const source: ILegacyStageDisplayStateSource = {
      subscribeH2rStageDisplayState: vi.fn(
        () =>
          new Promise<{ dispose(): void }>((_, reject) => {
            rejectSubscription = reject;
          }),
      ),
    };
    const adapter = new BrowserLegacyStageDisplayStateAdapter(
      model,
      source,
      reportError,
    );

    adapter.dispose();
    rejectSubscription?.(new Error("late boot failure"));

    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(reportError).not.toHaveBeenCalled();
    model.dispose();
  });

  it("isolates subscription and cleanup failures from the owner", async () => {
    const subscribeFailure = new Error("legacy subscription failed");
    const cleanupFailure = new Error("legacy cleanup failed");
    const reportError = vi.fn((error: unknown) => {
      if (error === cleanupFailure) throw new Error("reporter failed");
    });
    const model = new StageModel(reportError);
    const rejectedSource: ILegacyStageDisplayStateSource = {
      subscribeH2rStageDisplayState: vi.fn(async () => {
        throw subscribeFailure;
      }),
    };
    const rejectedAdapter = new BrowserLegacyStageDisplayStateAdapter(
      model,
      rejectedSource,
      reportError,
    );
    await vi.waitFor(() =>
      expect(reportError).toHaveBeenCalledWith(subscribeFailure),
    );
    rejectedAdapter.dispose();

    const throwingSource: ILegacyStageDisplayStateSource = {
      subscribeH2rStageDisplayState: vi.fn(async () => ({
        dispose() {
          throw cleanupFailure;
        },
      })),
    };
    const throwingAdapter = new BrowserLegacyStageDisplayStateAdapter(
      model,
      throwingSource,
      reportError,
    );
    await vi.waitFor(() =>
      expect(
        throwingSource.subscribeH2rStageDisplayState,
      ).toHaveBeenCalledOnce(),
    );

    await expect(
      vi.waitFor(() => {
        throwingAdapter.dispose();
        expect(reportError).toHaveBeenCalledWith(cleanupFailure);
      }),
    ).resolves.toBeUndefined();
    model.dispose();
  });
});
