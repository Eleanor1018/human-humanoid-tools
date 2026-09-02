import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/runtime/webui-runtime", () => ({}));
vi.mock("../../src/runtime/dataset-viz", () => ({}));

import { Workbench } from "../../src/workbench/browser/workbench";
import { WorkbenchServicesProvider } from "../../src/workbench/browser/workbench-service-context";
import {
  WorkbenchContributionLifecycle,
  WorkbenchLifecyclePhase,
} from "../../src/workbench/common/contribution";
import { createLegacyRuntimeContribution } from "../../src/workbench/contrib/legacy-runtime/browser/legacy-runtime-contribution";
import { createBrowserWorkbenchServices } from "../../src/workbench/services/browser/browser-workbench-services";
import runtimeSource from "../../src/runtime/webui-runtime.ts?raw";

afterEach(() => cleanup());

function renderWorkbench() {
  const services = createBrowserWorkbenchServices();
  const lifecycle = new WorkbenchContributionLifecycle(services, [], vi.fn());
  lifecycle.advanceTo(WorkbenchLifecyclePhase.Ready);
  return render(
    <WorkbenchServicesProvider services={services} lifecycle={lifecycle}>
      <Workbench />
    </WorkbenchServicesProvider>,
  );
}

describe("Workbench DOM contract", () => {
  it("mounts every runtime contribution before the compatibility service starts", () => {
    const ids = [
      "three-canvas",
      "motion-drop-shared",
      "video-pick-file",
      "robot-pick-urdf",
      "h2r-robot-select",
      "retarget-btn",
      "r2r-source-select",
      "r2r-retarget-btn",
      "basket-list",
      "batch-run",
      "r2r-basket-list",
      "r2r-batch-run",
      "dv-pick-folder",
      "dv-hist-canvas",
      "dv-scatter-canvas",
    ];
    const services = createBrowserWorkbenchServices();
    let missingAtStartup: string[] | undefined;
    vi.spyOn(services.legacyRuntimeService, "start").mockImplementation(
      async () => {
        missingAtStartup = ids.filter(
          (id) => document.getElementById(id) === null,
        );
      },
    );
    const lifecycle = new WorkbenchContributionLifecycle(
      services,
      [createLegacyRuntimeContribution(services.legacyRuntimeService)],
      vi.fn(),
    );
    lifecycle.advanceTo(WorkbenchLifecyclePhase.Ready);

    render(
      <WorkbenchServicesProvider services={services} lifecycle={lifecycle}>
        <Workbench />
      </WorkbenchServicesProvider>,
    );

    expect(services.legacyRuntimeService.start).toHaveBeenCalledOnce();
    expect(missingAtStartup).toEqual([]);
  });

  it("preserves every literal element id consumed by the existing runtime", () => {
    renderWorkbench();
    const requiredIds = [
      ...runtimeSource.matchAll(/getElementById\("([^"]+)"\)/g),
    ].map((match) => match[1]);
    const missingIds = [...new Set(requiredIds)].filter(
      (id) => document.getElementById(id) === null,
    );
    expect(missingIds).toEqual([]);
  });
});
