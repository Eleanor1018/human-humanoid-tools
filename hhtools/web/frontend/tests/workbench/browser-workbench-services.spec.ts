import { describe, expect, it, vi } from "vitest";

import { createBrowserWorkbenchServices } from "../../src/workbench/services/browser/browser-workbench-services";
import { StageModel } from "../../src/workbench/services/stage/common/stage-model";

describe("browser workbench service graph", () => {
  it("owns one Stage model and releases it with the service graph", () => {
    const services = createBrowserWorkbenchServices(vi.fn());
    const disposeStage = vi.spyOn(services.stageModelService, "dispose");

    expect(services.stageModelService.state.display.empty).toBe(true);

    services.dispose();
    services.dispose();

    expect(disposeStage).toHaveBeenCalledOnce();
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
