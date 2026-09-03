import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { toDisposable } from "../../src/base/common/disposable";
import {
  WorkbenchContributionLifecycle,
  WorkbenchLifecyclePhase,
} from "../../src/workbench/common/contribution";
import { createLegacyRuntimeContribution } from "../../src/workbench/contrib/legacy-runtime/browser/legacy-runtime-contribution";
import type { ILegacyRuntimeService } from "../../src/workbench/services/runtime/common/legacy-runtime-service";
import type {
  ILegacyStageDisplayStateSource,
  LegacyH2rStageDisplaySnapshot,
} from "../../src/workbench/services/stage/browser/legacy-stage-display-state-source";
import { StageModel } from "../../src/workbench/services/stage/common/stage-model";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function runtimeService(start: () => Promise<void>): ILegacyRuntimeService {
  return {
    start,
    dispose: vi.fn(),
  };
}

function snapshot(): LegacyH2rStageDisplaySnapshot {
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
      scaledSkeleton: { available: true, visible: false, canToggle: true },
      scaledEnvironment: {
        available: false,
        visible: false,
        canToggle: false,
      },
      targetRobot: { available: true, visible: true, canToggle: true },
    },
  };
}

function createLifecycle(
  start: () => Promise<void>,
  subscribe: ILegacyStageDisplayStateSource["subscribeH2rStageDisplayState"],
  reportError = vi.fn(),
) {
  const stageOwner = new StageModel(reportError);
  const runtime = runtimeService(start);
  const displayStateSource: ILegacyStageDisplayStateSource = {
    subscribeH2rStageDisplayState: subscribe,
  };
  const lifecycle = new WorkbenchContributionLifecycle(
    stageOwner,
    [
      createLegacyRuntimeContribution({
        runtimeService: runtime,
        displayStateSource,
        stageOwner,
      }),
    ],
    reportError,
  );
  return { lifecycle, stageOwner, runtime, displayStateSource, reportError };
}

async function flushStartup(): Promise<void> {
  // startup.then -> adapter construction -> async subscription.then
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
  delete window.__hhtoolsReady;
});

afterEach(() => {
  vi.useRealTimers();
  delete window.__hhtoolsReady;
});

describe("legacy runtime contribution", () => {
  it("attaches display state only after Restored startup succeeds", async () => {
    const startup = deferred<void>();
    const start = vi.fn(() => startup.promise);
    const unsubscribe = vi.fn();
    const current = snapshot();
    const subscribe = vi.fn(
      async (listener: (value: LegacyH2rStageDisplaySnapshot) => void) => {
        listener(current);
        return toDisposable(unsubscribe);
      },
    );
    const { lifecycle, stageOwner } = createLifecycle(start, subscribe);

    lifecycle.advanceTo(WorkbenchLifecyclePhase.Ready);
    expect(start).not.toHaveBeenCalled();
    expect(subscribe).not.toHaveBeenCalled();

    lifecycle.advanceTo(WorkbenchLifecyclePhase.Restored);
    expect(start).toHaveBeenCalledOnce();
    expect(subscribe).not.toHaveBeenCalled();

    startup.resolve();
    await flushStartup();

    expect(subscribe).toHaveBeenCalledOnce();
    expect(stageOwner.state.display).toEqual({
      owner: "h2r",
      empty: current.empty,
      canResetView: current.canResetView,
      layers: current.layers,
    });

    lifecycle.dispose();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("does not attach when teardown wins the startup race", async () => {
    const startup = deferred<void>();
    const subscribe = vi.fn(async () => toDisposable(vi.fn()));
    const reportError = vi.fn();
    const { lifecycle } = createLifecycle(
      vi.fn(() => startup.promise),
      subscribe,
      reportError,
    );

    lifecycle.advanceTo(WorkbenchLifecyclePhase.Restored);
    lifecycle.dispose();
    startup.resolve();
    await flushStartup();
    vi.advanceTimersByTime(4_000);

    expect(subscribe).not.toHaveBeenCalled();
    expect(reportError).not.toHaveBeenCalled();
  });

  it("contains a synchronous startup throw without creating a watchdog", () => {
    const failure = new Error("startup threw synchronously");
    const subscribe = vi.fn(async () => toDisposable(vi.fn()));
    const reportError = vi.fn();
    const { lifecycle } = createLifecycle(
      vi.fn(() => {
        throw failure;
      }),
      subscribe,
      reportError,
    );

    expect(() =>
      lifecycle.advanceTo(WorkbenchLifecyclePhase.Restored),
    ).not.toThrow();
    vi.advanceTimersByTime(4_000);

    expect(reportError).toHaveBeenCalledWith(failure);
    expect(reportError).toHaveBeenCalledOnce();
    expect(subscribe).not.toHaveBeenCalled();
    lifecycle.dispose();
  });

  it("reclaims a subscription handle that arrives after service teardown", async () => {
    const pendingSubscription = deferred<ReturnType<typeof toDisposable>>();
    const disposeSubscription = vi.fn();
    const reportError = vi.fn();
    let publish:
      | ((value: LegacyH2rStageDisplaySnapshot) => void)
      | undefined;
    const subscribe = vi.fn(
      (listener: (value: LegacyH2rStageDisplaySnapshot) => void) => {
        publish = listener;
        return pendingSubscription.promise;
      },
    );
    const { lifecycle, stageOwner } = createLifecycle(
      vi.fn(async () => undefined),
      subscribe,
      reportError,
    );
    const stateBeforeTeardown = stageOwner.state;

    lifecycle.advanceTo(WorkbenchLifecyclePhase.Restored);
    await flushStartup();
    expect(subscribe).toHaveBeenCalledOnce();

    lifecycle.dispose();
    publish?.(snapshot());
    pendingSubscription.resolve(toDisposable(disposeSubscription));
    await flushStartup();

    expect(stageOwner.state).toBe(stateBeforeTeardown);
    expect(disposeSubscription).toHaveBeenCalledOnce();
    expect(reportError).not.toHaveBeenCalled();
  });

  it("reports startup rejection once without attaching display state", async () => {
    const failure = new Error("module failed to load");
    const subscribe = vi.fn(async () => toDisposable(vi.fn()));
    const reportError = vi.fn();
    const { lifecycle } = createLifecycle(
      vi.fn(() => Promise.reject(failure)),
      subscribe,
      reportError,
    );

    lifecycle.advanceTo(WorkbenchLifecyclePhase.Restored);
    await flushStartup();
    vi.advanceTimersByTime(4_000);

    expect(reportError).toHaveBeenCalledWith(failure);
    expect(reportError).toHaveBeenCalledOnce();
    expect(subscribe).not.toHaveBeenCalled();
    lifecycle.dispose();
  });

  it("reports a post-start display subscription failure only once", async () => {
    const failure = new Error("display source failed");
    const reportError = vi.fn();
    const { lifecycle } = createLifecycle(
      vi.fn(async () => undefined),
      vi.fn(async () => {
        throw failure;
      }),
      reportError,
    );

    lifecycle.advanceTo(WorkbenchLifecyclePhase.Restored);
    await flushStartup();

    expect(reportError).toHaveBeenCalledWith(failure);
    expect(reportError).toHaveBeenCalledOnce();
    lifecycle.dispose();
  });

  it("reports readiness timeout and cancels it when disposed", async () => {
    const subscribe = vi.fn(async () => toDisposable(vi.fn()));
    const firstReport = vi.fn();
    const { lifecycle: timedOut } = createLifecycle(
      vi.fn(async () => undefined),
      subscribe,
      firstReport,
    );
    timedOut.advanceTo(WorkbenchLifecyclePhase.Restored);
    await flushStartup();

    vi.advanceTimersByTime(4_000);

    expect(firstReport).toHaveBeenCalledOnce();
    expect(firstReport.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        message: "React workbench runtime did not finish initialization",
      }),
    );
    timedOut.dispose();

    const cancelledReport = vi.fn();
    const { lifecycle: cancelled } = createLifecycle(
      vi.fn(async () => undefined),
      vi.fn(async () => toDisposable(vi.fn())),
      cancelledReport,
    );
    cancelled.advanceTo(WorkbenchLifecyclePhase.Restored);
    await flushStartup();
    cancelled.dispose();

    vi.advanceTimersByTime(4_000);

    expect(cancelledReport).not.toHaveBeenCalled();
  });

  it("releases the display listener before the owned service graph", async () => {
    const order: string[] = [];
    const stageOwner = new StageModel(vi.fn());
    const runtime = runtimeService(vi.fn(async () => undefined));
    const displayStateSource: ILegacyStageDisplayStateSource = {
      subscribeH2rStageDisplayState: vi.fn(async () =>
        toDisposable(() => order.push("display"))),
    };
    const serviceGraph = toDisposable(() => {
      order.push("services");
      runtime.dispose();
      stageOwner.dispose();
    });
    const lifecycle = new WorkbenchContributionLifecycle(
      serviceGraph,
      [
        createLegacyRuntimeContribution({
          runtimeService: runtime,
          displayStateSource,
          stageOwner,
        }),
      ],
      vi.fn(),
    );

    lifecycle.advanceTo(WorkbenchLifecyclePhase.Restored);
    lifecycle.advanceTo(WorkbenchLifecyclePhase.Restored);
    await flushStartup();
    lifecycle.dispose();
    lifecycle.dispose();

    expect(
      displayStateSource.subscribeH2rStageDisplayState,
    ).toHaveBeenCalledOnce();
    expect(order).toEqual(["display", "services"]);
  });
});
