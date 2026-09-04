import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { toDisposable } from "../../src/base/common/disposable";
import { WorkbenchServicesProvider } from "../../src/workbench/browser/workbench-service-context";
import {
  WorkbenchContributionLifecycle,
  WorkbenchLifecyclePhase,
  type IWorkbenchContribution,
} from "../../src/workbench/common/contribution";
import type { IWorkbenchServices } from "../../src/workbench/services/common/workbench-services";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function testContribution(
  id: string,
  phase: WorkbenchLifecyclePhase,
  activate: () => void,
): IWorkbenchContribution {
  return {
    id,
    phase,
    activate: () => {
      activate();
      return toDisposable(() => undefined);
    },
  };
}

function fakeServices(dispose = vi.fn()): IWorkbenchServices {
  return { dispose } as unknown as IWorkbenchServices;
}

describe("WorkbenchServicesProvider lifecycle", () => {
  it("advances Restored after commit and Eventually after yielding", () => {
    vi.useFakeTimers();
    const restored = vi.fn();
    const eventually = vi.fn();
    const services = fakeServices();
    const lifecycle = new WorkbenchContributionLifecycle(
      services,
      [
        testContribution(
          "restored",
          WorkbenchLifecyclePhase.Restored,
          restored,
        ),
        testContribution(
          "eventually",
          WorkbenchLifecyclePhase.Eventually,
          eventually,
        ),
      ],
      vi.fn(),
    );
    lifecycle.advanceTo(WorkbenchLifecyclePhase.Ready);

    const view = render(
      <WorkbenchServicesProvider services={services} lifecycle={lifecycle}>
        <div>ready</div>
      </WorkbenchServicesProvider>,
    );

    expect(restored).toHaveBeenCalledOnce();
    expect(eventually).not.toHaveBeenCalled();
    act(() => vi.runOnlyPendingTimers());
    expect(eventually).toHaveBeenCalledOnce();

    view.unmount();
    expect(services.dispose).toHaveBeenCalledOnce();
  });

  it("cancels Eventually work when the Workbench unmounts first", () => {
    vi.useFakeTimers();
    const eventually = vi.fn();
    const services = fakeServices();
    const lifecycle = new WorkbenchContributionLifecycle(
      services,
      [
        testContribution(
          "eventually",
          WorkbenchLifecyclePhase.Eventually,
          eventually,
        ),
      ],
      vi.fn(),
    );
    lifecycle.advanceTo(WorkbenchLifecyclePhase.Ready);

    const view = render(
      <WorkbenchServicesProvider services={services} lifecycle={lifecycle}>
        <div>ready</div>
      </WorkbenchServicesProvider>,
    );
    view.unmount();
    act(() => vi.runOnlyPendingTimers());

    expect(eventually).not.toHaveBeenCalled();
    expect(services.dispose).toHaveBeenCalledOnce();
  });
});
