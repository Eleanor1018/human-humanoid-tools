import { describe, expect, it, vi } from "vitest";

import { BrowserLegacyStageLayerCommands } from "../../src/workbench/services/stage/browser/browser-legacy-stage-layer-commands";
import { STAGE_LAYER_IDS } from "../../src/workbench/services/stage/common/stage-service";

describe("BrowserLegacyStageLayerCommands", () => {
  it("forwards every semantic layer without exposing a DOM id", async () => {
    const toggleH2rStageLayer = vi.fn(async () => undefined);
    const commands = new BrowserLegacyStageLayerCommands(
      { toggleH2rStageLayer },
      vi.fn(),
    );

    for (const layerId of STAGE_LAYER_IDS) commands.toggleLayer(layerId);

    await vi.waitFor(() =>
      expect(toggleH2rStageLayer).toHaveBeenCalledTimes(STAGE_LAYER_IDS.length),
    );
    expect(toggleH2rStageLayer.mock.calls).toEqual(
      STAGE_LAYER_IDS.map((layerId) => [layerId]),
    );
  });

  it("reports asynchronous runtime failures without leaking a rejection", async () => {
    const failure = new Error("layer command failed");
    const reportError = vi.fn();
    const commands = new BrowserLegacyStageLayerCommands(
      { toggleH2rStageLayer: vi.fn(async () => Promise.reject(failure)) },
      reportError,
    );

    expect(() => commands.toggleLayer("sourceEnvironment")).not.toThrow();

    await vi.waitFor(() => expect(reportError).toHaveBeenCalledWith(failure));
    expect(reportError).toHaveBeenCalledOnce();
  });

  it("isolates synchronous runtime and reporter failures", () => {
    const failure = new Error("runtime failed synchronously");
    const reportError = vi.fn(() => {
      throw new Error("reporter failed");
    });
    const commands = new BrowserLegacyStageLayerCommands(
      {
        toggleH2rStageLayer: vi.fn(() => {
          throw failure;
        }),
      },
      reportError,
    );

    expect(() => commands.toggleLayer("targetRobot")).not.toThrow();
    expect(reportError).toHaveBeenCalledOnce();
    expect(reportError).toHaveBeenCalledWith(failure);
  });
});
