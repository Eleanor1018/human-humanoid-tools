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
import type {
  IStageView,
  IStageViewAttachment,
} from "../../src/workbench/services/stage/common/stage-view";

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
  overrides: {
    stageView?: IStageView;
    stageViewAttachment?: IStageViewAttachment;
  } = {},
) {
  const stageOwner = new StageModel(reportError);
  const runtime = runtimeService(start);
  const detachStageView = vi.fn();
  const stageView = overrides.stageView ?? { resetView: vi.fn() };
  const stageViewAttachment = overrides.stageViewAttachment ?? {
    attachView: vi.fn(() => toDisposable(detachStageView)),
  };
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
        stageView,
        stageViewAttachment,
      }),
    ],
    reportError,
  );
  return {
    lifecycle,
    stageOwner,
    stageView,
    stageViewAttachment,
    detachStageView,
    runtime,
    displayStateSource,
    reportError,
  };
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
    const {
      lifecycle,
      stageOwner,
      stageView,
      stageViewAttachment,
      detachStageView,
    } = createLifecycle(start, subscribe);

    lifecycle.advanceTo(WorkbenchLifecyclePhase.Ready);
    expect(start).not.toHaveBeenCalled();
    expect(subscribe).not.toHaveBeenCalled();
    expect(stageViewAttachment.attachView).not.toHaveBeenCalled();

    lifecycle.advanceTo(WorkbenchLifecyclePhase.Restored);
    expect(start).toHaveBeenCalledOnce();
    expect(subscribe).not.toHaveBeenCalled();
    expect(stageViewAttachment.attachView).not.toHaveBeenCalled();

    startup.resolve();
    await flushStartup();

    expect(stageViewAttachment.attachView).toHaveBeenCalledWith(stageView);
    expect(stageViewAttachment.attachView).toHaveBeenCalledOnce();
    expect(subscribe).toHaveBeenCalledOnce();
    expect(stageOwner.state.display).toEqual({
      owner: "h2r",
      empty: current.empty,
      canResetView: current.canResetView,
      layers: current.layers,
    });

    lifecycle.dispose();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(detachStageView).toHaveBeenCalledOnce();
  });

  it("does not attach when teardown wins the startup race", async () => {
    const startup = deferred<void>();
    const subscribe = vi.fn(async () => toDisposable(vi.fn()));
    const reportError = vi.fn();
    const { lifecycle, stageViewAttachment } = createLifecycle(
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
    expect(stageViewAttachment.attachView).not.toHaveBeenCalled();
    expect(reportError).not.toHaveBeenCalled();
  });

  it("does not attach when teardown wins after startup resolves", async () => {
    const startup = deferred<void>();
    const subscribe = vi.fn(async () => toDisposable(vi.fn()));
    const { lifecycle, stageViewAttachment } = createLifecycle(
      vi.fn(() => startup.promise),
      subscribe,
    );

    lifecycle.advanceTo(WorkbenchLifecyclePhase.Restored);
    startup.resolve();
    // Promise fulfillment is queued, so synchronous teardown must still win.
    lifecycle.dispose();
    await flushStartup();

    expect(stageViewAttachment.attachView).not.toHaveBeenCalled();
    expect(subscribe).not.toHaveBeenCalled();
  });

  it("contains a synchronous startup throw without creating a watchdog", () => {
    const failure = new Error("startup threw synchronously");
    const subscribe = vi.fn(async () => toDisposable(vi.fn()));
    const reportError = vi.fn();
    const { lifecycle, stageViewAttachment } = createLifecycle(
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
    expect(stageViewAttachment.attachView).not.toHaveBeenCalled();
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
    const { lifecycle, stageOwner, detachStageView } = createLifecycle(
      vi.fn(async () => undefined),
      subscribe,
      reportError,
    );
    const stateBeforeTeardown = stageOwner.state;

    lifecycle.advanceTo(WorkbenchLifecyclePhase.Restored);
    await flushStartup();
    expect(subscribe).toHaveBeenCalledOnce();

    lifecycle.dispose();
    expect(detachStageView).toHaveBeenCalledOnce();
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
    const { lifecycle, stageViewAttachment } = createLifecycle(
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
    expect(stageViewAttachment.attachView).not.toHaveBeenCalled();
    lifecycle.dispose();
  });

  it("rolls back and reports a Stage View attachment failure", async () => {
    const failure = new Error("Stage View already attached");
    const reportError = vi.fn();
    const attachView = vi.fn(() => {
      throw failure;
    });
    const subscribe = vi.fn(async () => toDisposable(vi.fn()));
    const { lifecycle } = createLifecycle(
      vi.fn(async () => undefined),
      subscribe,
      reportError,
      { stageViewAttachment: { attachView } },
    );

    lifecycle.advanceTo(WorkbenchLifecyclePhase.Restored);
    await flushStartup();

    expect(attachView).toHaveBeenCalledOnce();
    expect(subscribe).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledWith(failure);
    expect(reportError).toHaveBeenCalledOnce();
    lifecycle.dispose();
  });

  it("reports a post-start display subscription failure only once", async () => {
    const failure = new Error("display source failed");
    const reportError = vi.fn();
    const {
      lifecycle,
      stageViewAttachment,
      detachStageView,
    } = createLifecycle(
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
    expect(stageViewAttachment.attachView).toHaveBeenCalledOnce();
    expect(detachStageView).not.toHaveBeenCalled();
    lifecycle.dispose();
    expect(detachStageView).toHaveBeenCalledOnce();
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
    const stageView: IStageView = { resetView: vi.fn() };
    const stageViewAttachment: IStageViewAttachment = {
      attachView: vi.fn(() =>
        toDisposable(() => order.push("stage-view")),
      ),
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
          stageView,
          stageViewAttachment,
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
    expect(stageViewAttachment.attachView).toHaveBeenCalledWith(stageView);
    expect(order).toEqual(["display", "stage-view", "services"]);
  });
});
