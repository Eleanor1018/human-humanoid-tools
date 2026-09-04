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

  it("keeps the compatibility View detached until its contribution starts", async () => {
    const services = createBrowserWorkbenchServices(vi.fn());
    const resetStageView = vi
      .spyOn(services.legacyRuntimeService, "resetStageView")
      .mockResolvedValue(undefined);

    services.stageDisplayCommands.resetView();
    expect(resetStageView).not.toHaveBeenCalled();

    const attachment = services.stageViewService.attachView(
      services.legacyStageView,
    );
    services.stageDisplayCommands.resetView();

    await vi.waitFor(() => expect(resetStageView).toHaveBeenCalledOnce());
    attachment.dispose();
    services.dispose();
    services.stageDisplayCommands.resetView();
    expect(resetStageView).toHaveBeenCalledOnce();
  });

  it("disposes the Stage View service before the compatibility runtime", () => {
    const services = createBrowserWorkbenchServices(vi.fn());
    const order: string[] = [];
    const disposeStageViewService =
      services.stageViewService.dispose.bind(services.stageViewService);
    vi.spyOn(services.stageViewService, "dispose").mockImplementation(() => {
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
