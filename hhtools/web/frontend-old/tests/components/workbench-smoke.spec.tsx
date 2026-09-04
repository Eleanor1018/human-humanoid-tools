import {
  act,
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
import type {
  ThreeStageRendererMount,
} from "../../src/workbench/browser/stage/three-stage-renderer-mount";
import {
  WorkbenchContributionLifecycle,
  WorkbenchLifecyclePhase,
} from "../../src/workbench/common/contribution";
import { createLegacyRuntimeContribution } from "../../src/workbench/contrib/legacy-runtime/browser/legacy-runtime-contribution";
import { WorkbenchCommandIds } from "../../src/workbench/common/command-ids";
import type { WorkbenchPanelContribution } from "../../src/workbench/common/panel-contribution";
import { createVideoToMotionPanelContribution } from "../../src/workbench/contrib/video-to-motion/browser/video-to-motion-contribution";
import { createBrowserWorkbenchServices } from "../../src/workbench/services/browser/browser-workbench-services";
import type {
  ILegacyStageDisplayStateSource,
  LegacyH2rStageDisplaySnapshot,
} from "../../src/workbench/services/stage/browser/legacy-stage-display-state-source";
import runtimeSource from "../../src/runtime/webui-runtime.ts?raw";

afterEach(() => {
  cleanup();
  delete window.__hhApp;
  delete window.__hhtoolsReady;
});

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

function renderWorkbench(
  contributions?: readonly WorkbenchPanelContribution[],
  stageRendererMount: ThreeStageRendererMount | null = null,
) {
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
      <Workbench
        panelContributions={contributions ?? [panelContribution]}
        stageRendererMount={stageRendererMount}
      />
    </WorkbenchServicesProvider>,
  );
  return { ...view, services };
}

describe("Workbench DOM contract", () => {
  it("passes the browser-local Stage mount to the committed surface", () => {
    const dispose = vi.fn();
    const mount = vi.fn(() => ({ dispose }));
    const stageRendererMount: ThreeStageRendererMount = {
      mount,
      reportError: vi.fn(),
    };

    const view = renderWorkbench(undefined, stageRendererMount);
    const stage = document.getElementById("stage") as HTMLElement;
    const canvas = document.getElementById(
      "three-canvas",
    ) as HTMLCanvasElement;

    expect(mount).toHaveBeenCalledWith({ stage, canvas });
    expect(mount).toHaveBeenCalledOnce();
    view.unmount();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("routes application Reset through the Stage command contract", () => {
    const { services } = renderWorkbench();
    const resetView = vi
      .spyOn(services.stageDisplayCommands, "resetView")
      .mockImplementation(() => undefined);

    fireEvent.click(screen.getByTitle("Open command palette"));
    fireEvent.change(screen.getByLabelText("Search commands"), {
      target: { value: "Reset 3D View" },
    });
    const resetCommand = screen
      .getByText("Reset 3D View")
      .closest("button") as HTMLButtonElement;

    expect(resetCommand).toBeDisabled();
    fireEvent.click(resetCommand);
    expect(resetView).not.toHaveBeenCalled();

    act(() => {
      services.stageModelService.updateState({
        display: { empty: false, canResetView: true },
      });
    });
    expect(resetCommand).toBeEnabled();
    fireEvent.click(resetCommand);
    expect(resetView).toHaveBeenCalledOnce();

    // Batch replaces the visible 3D surface without clearing its model, so
    // the command must close even though canResetView remains true underneath.
    fireEvent.click(
      document.querySelector<HTMLButtonElement>(
        '.nav-item[data-panel="batch"]',
      )!,
    );
    fireEvent.click(screen.getByTitle("Open command palette"));
    fireEvent.change(screen.getByLabelText("Search commands"), {
      target: { value: "Reset 3D View" },
    });
    expect(
      screen.getByText("Reset 3D View").closest("button"),
    ).toBeDisabled();
    expect(resetView).toHaveBeenCalledOnce();
  });

  it("isolates React-owned Batch state from legacy Stage classes", () => {
    renderWorkbench();
    const batchNavigation = document.querySelector<HTMLButtonElement>(
      '.nav-item[data-panel="batch"]',
    );
    const motionNavigation = document.querySelector<HTMLButtonElement>(
      '.nav-item[data-panel="motion"]',
    );
    const stage = document.getElementById("stage")!;
    stage.classList.add("calib-pickable");

    expect(batchNavigation).not.toBeNull();
    expect(motionNavigation).not.toBeNull();
    fireEvent.click(batchNavigation!);
    expect(document.getElementById("stage")).toBe(stage);
    expect(stage).toHaveAttribute("data-batch-active", "true");
    expect(stage).toHaveClass("calib-pickable");

    fireEvent.click(motionNavigation!);
    expect(document.getElementById("stage")).toBe(stage);
    expect(stage).not.toHaveAttribute("data-batch-active");
    expect(stage).toHaveClass("calib-pickable");
  });

  it("routes user navigation through the shared panel request boundary", () => {
    const requestedPanels: string[] = [];
    const onPanelRequest = (event: Event) => {
      requestedPanels.push((event as CustomEvent<string>).detail);
    };
    window.addEventListener("hhtools:panel-request", onPanelRequest);

    try {
      const requestingContribution: WorkbenchPanelContribution = {
        id: "video-to-motion",
        component: ({ requestPanel }) => (
          <button type="button" onClick={() => requestPanel("motion")}>
            Request motion panel
          </button>
        ),
      };
      renderWorkbench([requestingContribution]);
      const r2rNavigation = document.querySelector<HTMLButtonElement>(
        '.nav-item[data-panel="r2r"]',
      );
      expect(r2rNavigation).not.toBeNull();

      fireEvent.click(r2rNavigation!);

      expect(requestedPanels).toEqual(["r2r"]);
      expect(document.querySelector('[data-panel="r2r"].panel')).toHaveClass(
        "active",
      );

      fireEvent.click(screen.getByRole("button", { name: "Request motion panel" }));
      expect(requestedPanels).toEqual(["r2r", "motion"]);
      expect(document.querySelector('[data-panel="motion"].panel')).toHaveClass(
        "active",
      );
    } finally {
      window.removeEventListener("hhtools:panel-request", onPanelRequest);
    }
  });

  it("delegates each ready panel request once to the runtime coordinator", () => {
    renderWorkbench();
    const setActivePanel = window.__hhUi!.setActivePanel;
    const runtimePanelSwitch = vi.fn((panel: string) => {
      setActivePanel(panel);
    });
    window.__hhApp = {
      switchInspectorPanel: runtimePanelSwitch,
    } as unknown as NonNullable<Window["__hhApp"]>;
    const r2rNavigation = document.querySelector<HTMLButtonElement>(
      '.nav-item[data-panel="r2r"]',
    )!;

    fireEvent.click(r2rNavigation);

    expect(runtimePanelSwitch).toHaveBeenCalledOnce();
    expect(runtimePanelSwitch).toHaveBeenCalledWith("r2r");
    expect(document.querySelector('[data-panel="r2r"].panel')).toHaveClass(
      "active",
    );
  });

  it("commits every runtime DOM port before startup and display attachment", async () => {
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
    const toggleLayer = vi
      .spyOn(services.stageLayerCommands, "toggleLayer")
      .mockImplementation(() => undefined);
    let missingAtStartup: string[] | undefined;
    let missingAtViewAttachment: string[] | undefined;
    let missingAtSubscription: string[] | undefined;
    let publishDisplay:
      | ((snapshot: LegacyH2rStageDisplaySnapshot) => void)
      | undefined;
    vi.spyOn(services.legacyRuntimeService, "start").mockImplementation(
      async () => {
        missingAtStartup = ids.filter(
          (id) => document.getElementById(id) === null,
        );
      },
    );
    const attachStageView =
      services.stageViewService.attachView.bind(services.stageViewService);
    const stageViewAttachment = vi
      .spyOn(services.stageViewService, "attachView")
      .mockImplementation((view) => {
        missingAtViewAttachment = ids.filter(
          (id) => document.getElementById(id) === null,
        );
        return attachStageView(view);
      });
    const resetStageView = vi
      .spyOn(services.legacyRuntimeService, "resetStageView")
      .mockResolvedValue(undefined);
    const initialDisplay: LegacyH2rStageDisplaySnapshot = {
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
        scaledSkeleton: { available: false, visible: false, canToggle: false },
        scaledEnvironment: {
          available: false,
          visible: false,
          canToggle: false,
        },
        targetRobot: { available: true, visible: true, canToggle: true },
      },
    };
    const displayStateSource: ILegacyStageDisplayStateSource = {
      subscribeH2rStageDisplayState: vi.fn(async (listener) => {
        publishDisplay = listener;
        missingAtSubscription = ids.filter(
          (id) => document.getElementById(id) === null,
        );
        listener(initialDisplay);
        return { dispose: vi.fn() };
      }),
    };
    const lifecycle = new WorkbenchContributionLifecycle(
      services,
      [
        createLegacyRuntimeContribution({
          runtimeService: services.legacyRuntimeService,
          displayStateSource,
          stageOwner: services.stageModelService,
          stageView: services.legacyStageView,
          stageViewAttachment: services.stageViewService,
        }),
      ],
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

    const rendered = render(
      <WorkbenchServicesProvider services={services} lifecycle={lifecycle}>
        <Workbench
          panelContributions={[panelContribution]}
          stageRendererMount={null}
        />
      </WorkbenchServicesProvider>,
    );

    expect(services.legacyRuntimeService.start).toHaveBeenCalledOnce();
    expect(missingAtStartup).toEqual([]);
    await waitFor(() =>
      expect(
        displayStateSource.subscribeH2rStageDisplayState,
      ).toHaveBeenCalledOnce(),
    );
    expect(stageViewAttachment).toHaveBeenCalledWith(services.legacyStageView);
    expect(stageViewAttachment).toHaveBeenCalledOnce();
    expect(missingAtViewAttachment).toEqual([]);
    expect(missingAtSubscription).toEqual([]);
    expect(services.stageModelService.state.display).toEqual({
      owner: "h2r",
      empty: initialDisplay.empty,
      canResetView: initialDisplay.canResetView,
      layers: initialDisplay.layers,
    });
    const stageEmpty = document.getElementById("stage-empty")!;
    const resetView = document.getElementById(
      "view-reset-btn",
    ) as HTMLButtonElement;
    await waitFor(() => {
      expect(document.getElementById("tg-skeleton")).toHaveClass("on");
      expect(document.getElementById("tg-skeleton")).toBeEnabled();
      expect(document.getElementById("tg-robot")).toHaveClass("on");
      expect(document.getElementById("tg-env")).toBeDisabled();
      expect(stageEmpty).toHaveClass("hidden");
      expect(resetView).not.toHaveClass("hidden");
      expect(resetView).toBeEnabled();
    });
    fireEvent.click(resetView);
    expect(resetStageView).toHaveBeenCalledOnce();
    const skeleton = document.getElementById(
      "tg-skeleton",
    ) as HTMLButtonElement;
    fireEvent.click(skeleton);
    expect(toggleLayer).toHaveBeenCalledOnce();
    expect(toggleLayer).toHaveBeenCalledWith("sourceSkeleton");
    expect(skeleton).toHaveClass("on");

    act(() => {
      publishDisplay?.({
        ...initialDisplay,
        ownsStage: false,
        empty: true,
        canResetView: false,
      });
    });
    await waitFor(() => {
      expect(services.stageModelService.state.display.owner).toBe("r2r");
      expect(services.stageModelService.state.display.empty).toBe(true);
      expect(services.stageModelService.state.display.canResetView).toBe(false);
      expect(document.getElementById("view-hud")).toHaveClass("hidden");
      expect(document.getElementById("view-hud-r2r")).not.toHaveClass(
        "hidden",
      );
      expect(document.getElementById("stage-empty")).toBe(stageEmpty);
      expect(document.getElementById("view-reset-btn")).toBe(resetView);
      expect(stageEmpty).not.toHaveClass("hidden");
      expect(resetView).toHaveClass("hidden");
      expect(resetView).toBeDisabled();
    });

    act(() => {
      publishDisplay?.({
        ...initialDisplay,
        layers: {
          ...initialDisplay.layers,
          sourceSkeleton: {
            available: true,
            visible: false,
            canToggle: false,
          },
          sourceEnvironment: {
            available: true,
            visible: true,
            canToggle: true,
          },
        },
      });
    });
    await waitFor(() => {
      expect(services.stageModelService.state.display.owner).toBe("h2r");
      expect(document.getElementById("view-hud")).not.toHaveClass("hidden");
      expect(document.getElementById("view-hud-r2r")).toHaveClass("hidden");
      expect(document.getElementById("tg-skeleton")).not.toHaveClass("on");
      expect(document.getElementById("tg-skeleton")).toBeDisabled();
      expect(document.getElementById("tg-env")).toHaveClass("on");
      expect(document.getElementById("tg-env")).toBeEnabled();
      expect(document.getElementById("stage-empty")).toBe(stageEmpty);
      expect(document.getElementById("view-reset-btn")).toBe(resetView);
      expect(stageEmpty).toHaveClass("hidden");
      expect(resetView).not.toHaveClass("hidden");
      expect(resetView).toBeEnabled();
    });

    rendered.unmount();
    services.stageDisplayCommands.resetView();
    expect(resetStageView).toHaveBeenCalledOnce();
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

  it("projects legacy playback state through the Stage model into React", () => {
    const commands: unknown[] = [];
    window.addEventListener(
      "hhtools:playback-command",
      (event) => commands.push(event.detail),
      { once: true },
    );
    renderWorkbench();

    act(() => {
      window.dispatchEvent(
        new CustomEvent("hhtools:playback-state", {
          detail: {
            visible: true,
            active: true,
            playing: true,
            currentTime: 1.5,
            duration: 6,
            previewSourceDuration: null,
          },
        }),
      );
    });

    expect(screen.getByText("1.50 / 6.00 s")).toBeInTheDocument();
    expect(document.getElementById("playbar")).not.toHaveAttribute("hidden");
    fireEvent.click(screen.getByLabelText("暂停"));
    expect(commands).toEqual([{ action: "toggle", value: undefined }]);
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
