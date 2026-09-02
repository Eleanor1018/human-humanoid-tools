import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
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
import { WorkbenchCommandIds } from "../../src/workbench/common/command-ids";
import { createVideoToMotionPanelContribution } from "../../src/workbench/contrib/video-to-motion/browser/video-to-motion-contribution";
import { createBrowserWorkbenchServices } from "../../src/workbench/services/browser/browser-workbench-services";
import runtimeSource from "../../src/runtime/webui-runtime.ts?raw";

afterEach(() => cleanup());

function mockWorkbenchGetRequests(
  services: ReturnType<typeof createBrowserWorkbenchServices>,
) {
  return vi
    .spyOn(services.requestService, "get")
    .mockImplementation(async <T,>(url: string): Promise<T> => {
      if (url === "/api/video-to-motion/status") {
        return { ready: true, missing: [] } as T;
      }
      if (url === "/api/settings/motion-library") {
        return {
          root: "/tmp/motions",
          default_root: "/tmp/motions",
          editable: true,
        } as T;
      }
      throw new Error(`Unexpected test GET: ${url}`);
    });
}

function renderWorkbench() {
  const services = createBrowserWorkbenchServices(vi.fn());
  mockWorkbenchGetRequests(services);
  const lifecycle = new WorkbenchContributionLifecycle(services, [], vi.fn());
  lifecycle.advanceTo(WorkbenchLifecyclePhase.Ready);
  const panelContribution = createVideoToMotionPanelContribution({
    commandService: services.commandService,
    requestService: services.requestService,
    jobService: services.jobService,
    presentationService: services.motionResultPresentationService,
    reportError: vi.fn(),
  });
  const view = render(
    <WorkbenchServicesProvider services={services} lifecycle={lifecycle}>
      <Workbench panelContributions={[panelContribution]} />
    </WorkbenchServicesProvider>,
  );
  return { ...view, services };
}

describe("Workbench DOM contract", () => {
  it("mounts every runtime contribution before the compatibility service starts", () => {
    const ids = [
      "three-canvas",
      "motion-drop-shared",
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
    const services = createBrowserWorkbenchServices(vi.fn());
    mockWorkbenchGetRequests(services);
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
    const panelContribution = createVideoToMotionPanelContribution({
      commandService: services.commandService,
      requestService: services.requestService,
      jobService: services.jobService,
      presentationService: services.motionResultPresentationService,
      reportError: vi.fn(),
    });

    render(
      <WorkbenchServicesProvider services={services} lifecycle={lifecycle}>
        <Workbench panelContributions={[panelContribution]} />
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

  it("routes video imports through the contributed command without DOM lookup", async () => {
    const { services } = renderWorkbench();
    const videoInput = await screen.findByLabelText("Select a video file");
    const inputClick = vi.spyOn(videoInput, "click");
    const executeCommand = vi.spyOn(
      services.commandService,
      "executeCommand",
    );
    const panel = document.querySelector(
      '[data-panel="video-to-motion"]',
    );
    const querySelector = vi.spyOn(document, "querySelector");

    fireEvent(
      window,
      new CustomEvent("hhtools:import-command", {
        detail: { target: "video-file" },
      }),
    );

    await waitFor(() => {
      expect(panel).toHaveClass("active");
      expect(executeCommand).toHaveBeenCalledWith(
        WorkbenchCommandIds.pickVideoToMotionSource,
      );
      expect(inputClick).toHaveBeenCalledOnce();
    });
    expect(querySelector).not.toHaveBeenCalled();
  });
});
