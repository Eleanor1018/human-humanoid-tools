import { describe, expect, it, vi } from "vitest";

import { BrowserLegacyStageDisplayCommands } from "../../src/workbench/services/stage/browser/browser-legacy-stage-display-commands";

describe("BrowserLegacyStageDisplayCommands", () => {
  it("forwards one reset intent to the compatibility runtime", async () => {
    const resetStageView = vi.fn(async () => undefined);
    const commands = new BrowserLegacyStageDisplayCommands(
      { resetStageView },
      vi.fn(),
    );

    commands.resetView();

    await vi.waitFor(() => expect(resetStageView).toHaveBeenCalledOnce());
  });

  it("reports asynchronous reset failures without leaking a rejection", async () => {
    const failure = new Error("camera reset failed");
    const reportError = vi.fn();
    const commands = new BrowserLegacyStageDisplayCommands(
      { resetStageView: vi.fn(async () => Promise.reject(failure)) },
      reportError,
    );

    expect(() => commands.resetView()).not.toThrow();

    await vi.waitFor(() => expect(reportError).toHaveBeenCalledWith(failure));
  });

  it("isolates synchronous runtime and reporter failures", () => {
    const failure = new Error("runtime failed synchronously");
    const reportError = vi.fn(() => {
      throw new Error("reporter failed");
    });
    const commands = new BrowserLegacyStageDisplayCommands(
      {
        resetStageView: vi.fn(() => {
          throw failure;
        }),
      },
      reportError,
    );

    expect(() => commands.resetView()).not.toThrow();
    expect(reportError).toHaveBeenCalledWith(failure);
  });
});
