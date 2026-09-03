import { describe, expect, expectTypeOf, it, vi } from "vitest";

import { createBrowserWorkbenchServices } from "../../src/workbench/services/browser/browser-workbench-services";
import { BrowserLegacyRuntimeService } from "../../src/workbench/services/runtime/browser/browser-legacy-runtime-service";
import { BrowserLegacyStageLayerCommands } from "../../src/workbench/services/stage/browser/browser-legacy-stage-layer-commands";
import { BrowserStageViewService } from "../../src/workbench/services/stage/browser/browser-stage-view-service";
import { StageModel } from "../../src/workbench/services/stage/common/stage-model";

describe("browser workbench service graph", () => {
  it("owns one Stage model and releases it with the service graph", () => {
    const services = createBrowserWorkbenchServices(vi.fn());
    expectTypeOf(services.stageModelService).toEqualTypeOf<StageModel>();
    expectTypeOf(services.legacyRuntimeService).toEqualTypeOf<
      BrowserLegacyRuntimeService
    >();
    expect(services.stageLayerCommands).toBeInstanceOf(
      BrowserLegacyStageLayerCommands,
    );
    expect(services.stageViewService).toBeInstanceOf(BrowserStageViewService);
    expect(services.stageDisplayCommands).toBe(services.stageViewService);
    const disposeStage = vi.spyOn(services.stageModelService, "dispose");

    expect(services.stageModelService.state.display.empty).toBe(true);

    services.dispose();
    services.dispose();

    expect(disposeStage).toHaveBeenCalledOnce();
  });

  it("routes Reset through the attached compatibility View", async () => {
    const services = createBrowserWorkbenchServices(vi.fn());
    const resetStageView = vi
      .spyOn(services.legacyRuntimeService, "resetStageView")
      .mockResolvedValue(undefined);

    services.stageDisplayCommands.resetView();

    await vi.waitFor(() => expect(resetStageView).toHaveBeenCalledOnce());
    services.dispose();
    services.stageDisplayCommands.resetView();
    expect(resetStageView).toHaveBeenCalledOnce();
  });

  it("detaches the Stage View before disposing its service and runtime", () => {
    const services = createBrowserWorkbenchServices(vi.fn());
    const order: string[] = [];
    const resetStageView = vi
      .spyOn(services.legacyRuntimeService, "resetStageView")
      .mockResolvedValue(undefined);
    const disposeStageViewService =
      services.stageViewService.dispose.bind(services.stageViewService);
    vi.spyOn(services.stageViewService, "dispose").mockImplementation(() => {
      // The attachment lease is registered after the service, so reverse
      // disposal must make this command a no-op before the service itself dies.
      services.stageViewService.resetView();
      order.push("stage-view-service");
      disposeStageViewService();
    });
    const disposeRuntime =
      services.legacyRuntimeService.dispose.bind(services.legacyRuntimeService);
    vi.spyOn(services.legacyRuntimeService, "dispose").mockImplementation(() => {
      order.push("legacy-runtime");
      disposeRuntime();
    });

    services.dispose();

    expect(resetStageView).not.toHaveBeenCalled();
    expect(order).toEqual(["stage-view-service", "legacy-runtime"]);
  });

  it("routes Stage observer failures through the composition reporter", () => {
    const reportError = vi.fn();
    const services = createBrowserWorkbenchServices(reportError);
    const failure = new Error("Stage observer failed");
    services.stageModelService.onDidChangeState(() => {
      throw failure;
    });

    // Only the composition owner sees the write side. Views receive the
    // read-only IStageModelService exposed on IWorkbenchServices.
    const stageOwner = services.stageModelService as StageModel;
    stageOwner.updateState({ display: { empty: false } });

    expect(reportError).toHaveBeenCalledWith(failure);
    services.dispose();
  });
});
