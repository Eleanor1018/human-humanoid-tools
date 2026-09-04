import { describe, expect, it, vi } from "vitest";

import { toDisposable, type IDisposable } from "../../src/base/common/disposable";
import {
  WorkbenchContributionLifecycle,
  WorkbenchLifecyclePhase,
  type IWorkbenchContribution,
  type IWorkbenchContributionContext,
} from "../../src/workbench/common/contribution";

function contribution(
  id: string,
  phase: WorkbenchLifecyclePhase,
  activate: (context: IWorkbenchContributionContext) => IDisposable,
): IWorkbenchContribution {
  return { id, phase, activate };
}

describe("WorkbenchContributionLifecycle", () => {
  it("activates phases monotonically and preserves registration order", () => {
    const activations: string[] = [];
    const root = toDisposable(() => undefined);
    const lifecycle = new WorkbenchContributionLifecycle(
      root,
      [
        contribution("restored", WorkbenchLifecyclePhase.Restored, () => {
          activations.push("restored");
          return toDisposable(() => undefined);
        }),
        contribution("starting", WorkbenchLifecyclePhase.Starting, () => {
          activations.push("starting");
          return toDisposable(() => undefined);
        }),
        contribution("ready-a", WorkbenchLifecyclePhase.Ready, () => {
          activations.push("ready-a");
          return toDisposable(() => undefined);
        }),
        contribution("ready-b", WorkbenchLifecyclePhase.Ready, () => {
          activations.push("ready-b");
          return toDisposable(() => undefined);
        }),
        contribution("eventually", WorkbenchLifecyclePhase.Eventually, () => {
          activations.push("eventually");
          return toDisposable(() => undefined);
        }),
      ],
      vi.fn(),
    );

    expect(lifecycle.phase).toBe(WorkbenchLifecyclePhase.Starting);
    expect(activations).toEqual(["starting"]);

    lifecycle.advanceTo(WorkbenchLifecyclePhase.Eventually);
    lifecycle.advanceTo(WorkbenchLifecyclePhase.Eventually);

    expect(activations).toEqual([
      "starting",
      "ready-a",
      "ready-b",
      "restored",
      "eventually",
    ]);
    expect(() =>
      lifecycle.advanceTo(WorkbenchLifecyclePhase.Ready),
    ).toThrow(/cannot move backwards/);
  });

  it("rejects duplicate contribution ids before activating anything", () => {
    const activate = vi.fn(() => toDisposable(() => undefined));
    const duplicate = contribution(
      "duplicate",
      WorkbenchLifecyclePhase.Starting,
      activate,
    );

    expect(
      () =>
        new WorkbenchContributionLifecycle(
          toDisposable(() => undefined),
          [duplicate, duplicate],
          vi.fn(),
        ),
    ).toThrow(/Duplicate Workbench contribution id/);
    expect(activate).not.toHaveBeenCalled();
  });

  it("reports a failed activation and continues with its siblings", () => {
    const failure = new Error("broken contribution");
    const reportError = vi.fn();
    const activateSibling = vi.fn(() => toDisposable(() => undefined));
    const lifecycle = new WorkbenchContributionLifecycle(
      toDisposable(() => undefined),
      [
        contribution("broken", WorkbenchLifecyclePhase.Ready, () => {
          throw failure;
        }),
        contribution(
          "sibling",
          WorkbenchLifecyclePhase.Ready,
          activateSibling,
        ),
      ],
      reportError,
    );

    lifecycle.advanceTo(WorkbenchLifecyclePhase.Ready);

    expect(reportError).toHaveBeenCalledWith(failure);
    expect(activateSibling).toHaveBeenCalledOnce();
  });

  it("disposes contributions in reverse activation order and services last", () => {
    const order: string[] = [];
    const lifecycle = new WorkbenchContributionLifecycle(
      toDisposable(() => order.push("services")),
      [
        contribution("starting", WorkbenchLifecyclePhase.Starting, () =>
          toDisposable(() => order.push("starting")),
        ),
        contribution("ready", WorkbenchLifecyclePhase.Ready, () =>
          toDisposable(() => order.push("ready")),
        ),
      ],
      vi.fn(),
    );
    lifecycle.advanceTo(WorkbenchLifecyclePhase.Ready);

    lifecycle.dispose();
    lifecycle.dispose();

    expect(order).toEqual(["ready", "starting", "services"]);
  });

  it("ignores late asynchronous reports after disposal", () => {
    const reportError = vi.fn();
    let context: IWorkbenchContributionContext | undefined;
    const lifecycle = new WorkbenchContributionLifecycle(
      toDisposable(() => undefined),
      [
        contribution("capture", WorkbenchLifecyclePhase.Starting, (value) => {
          context = value;
          return toDisposable(() => undefined);
        }),
      ],
      reportError,
    );

    lifecycle.dispose();
    context?.reportError(new Error("late failure"));

    expect(reportError).not.toHaveBeenCalled();
  });
});
