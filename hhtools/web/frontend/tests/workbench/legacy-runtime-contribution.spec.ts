import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { toDisposable } from "../../src/base/common/disposable";
import {
  WorkbenchContributionLifecycle,
  WorkbenchLifecyclePhase,
} from "../../src/workbench/common/contribution";
import { createLegacyRuntimeContribution } from "../../src/workbench/contrib/legacy-runtime/browser/legacy-runtime-contribution";
import type { ILegacyRuntimeService } from "../../src/workbench/services/runtime/common/legacy-runtime-service";

function runtimeService(start: () => Promise<void>): ILegacyRuntimeService {
  return {
    start,
    dispose: vi.fn(),
  };
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
  it("starts only after the Workbench reaches Restored", () => {
    const start = vi.fn(async () => undefined);
    const lifecycle = new WorkbenchContributionLifecycle(
      toDisposable(() => undefined),
      [createLegacyRuntimeContribution(runtimeService(start))],
      vi.fn(),
    );

    lifecycle.advanceTo(WorkbenchLifecyclePhase.Ready);
    expect(start).not.toHaveBeenCalled();

    lifecycle.advanceTo(WorkbenchLifecyclePhase.Restored);
    expect(start).toHaveBeenCalledOnce();

    lifecycle.dispose();
  });

  it("reports startup rejection through the lifecycle error boundary", async () => {
    const failure = new Error("module failed to load");
    const reportError = vi.fn();
    const lifecycle = new WorkbenchContributionLifecycle(
      toDisposable(() => undefined),
      [
        createLegacyRuntimeContribution(
          runtimeService(vi.fn(() => Promise.reject(failure))),
        ),
      ],
      reportError,
    );

    lifecycle.advanceTo(WorkbenchLifecyclePhase.Restored);
    await Promise.resolve();
    vi.advanceTimersByTime(4_000);

    expect(reportError).toHaveBeenCalledWith(failure);
    expect(reportError).toHaveBeenCalledOnce();
    lifecycle.dispose();
  });

  it("reports readiness timeout and cancels it when disposed", () => {
    const firstReport = vi.fn();
    const timedOut = new WorkbenchContributionLifecycle(
      toDisposable(() => undefined),
      [
        createLegacyRuntimeContribution(
          runtimeService(vi.fn(async () => undefined)),
        ),
      ],
      firstReport,
    );
    timedOut.advanceTo(WorkbenchLifecyclePhase.Restored);

    vi.advanceTimersByTime(4_000);

    expect(firstReport).toHaveBeenCalledOnce();
    expect(firstReport.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        message: "React workbench runtime did not finish initialization",
      }),
    );
    timedOut.dispose();

    const cancelledReport = vi.fn();
    const cancelled = new WorkbenchContributionLifecycle(
      toDisposable(() => undefined),
      [
        createLegacyRuntimeContribution(
          runtimeService(vi.fn(async () => undefined)),
        ),
      ],
      cancelledReport,
    );
    cancelled.advanceTo(WorkbenchLifecyclePhase.Restored);
    cancelled.dispose();

    vi.advanceTimersByTime(4_000);

    expect(cancelledReport).not.toHaveBeenCalled();
  });
});
