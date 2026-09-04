import { describe, expect, it, vi } from "vitest";

import { BrowserLegacyStageView } from "../../src/workbench/services/stage/browser/browser-legacy-stage-view";

describe("BrowserLegacyStageView", () => {
  it("forwards one reset intent to the compatibility runtime", async () => {
    const resetStageView = vi.fn(async () => undefined);
    const view = new BrowserLegacyStageView({ resetStageView });

    await expect(view.resetView()).resolves.toBeUndefined();

    expect(resetStageView).toHaveBeenCalledOnce();
  });

  it("preserves asynchronous failures for the attachment error owner", async () => {
    const failure = new Error("camera reset failed");
    const view = new BrowserLegacyStageView({
      resetStageView: vi.fn(async () => Promise.reject(failure)),
    });

    await expect(view.resetView()).rejects.toBe(failure);
  });

  it("preserves synchronous runtime failures", () => {
    const failure = new Error("runtime failed synchronously");
    const view = new BrowserLegacyStageView({
      resetStageView: vi.fn(() => {
        throw failure;
      }),
    });

    expect(() => view.resetView()).toThrow(failure);
  });
});
