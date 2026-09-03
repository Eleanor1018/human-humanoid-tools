import { describe, expect, it, vi } from "vitest";

import { BrowserStageViewService } from "../../src/workbench/services/stage/browser/browser-stage-view-service";

describe("BrowserStageViewService", () => {
  it("fails closed while no Stage View is attached", () => {
    const service = new BrowserStageViewService(vi.fn());

    expect(() => service.resetView()).not.toThrow();
  });

  it("routes each reset intent exactly once to the attached View", () => {
    const resetView = vi.fn();
    const service = new BrowserStageViewService(vi.fn());
    service.attachView({ resetView });

    service.resetView();
    service.resetView();

    expect(resetView).toHaveBeenCalledTimes(2);
  });

  it("rejects an overlapping owner without replacing the active View", () => {
    const firstReset = vi.fn();
    const secondReset = vi.fn();
    const service = new BrowserStageViewService(vi.fn());
    service.attachView({ resetView: firstReset });

    expect(() =>
      service.attachView({ resetView: secondReset }),
    ).toThrow("A Stage view is already attached");
    service.resetView();

    expect(firstReset).toHaveBeenCalledOnce();
    expect(secondReset).not.toHaveBeenCalled();
  });

  it("requires an explicit detach before handing ownership to another View", () => {
    const firstReset = vi.fn();
    const secondReset = vi.fn();
    const service = new BrowserStageViewService(vi.fn());
    const first = service.attachView({ resetView: firstReset });

    first.dispose();
    const second = service.attachView({ resetView: secondReset });
    first.dispose();
    service.resetView();

    expect(firstReset).not.toHaveBeenCalled();
    expect(secondReset).toHaveBeenCalledOnce();
    second.dispose();
    expect(() => service.resetView()).not.toThrow();
    expect(secondReset).toHaveBeenCalledOnce();
  });

  it("does not replay a re-entrant reset onto a replacement View", () => {
    const replacementReset = vi.fn();
    const service = new BrowserStageViewService(vi.fn());
    let firstAttachment: { dispose(): void };
    const firstReset = vi.fn(() => {
      firstAttachment.dispose();
      service.attachView({ resetView: replacementReset });
    });
    firstAttachment = service.attachView({ resetView: firstReset });

    service.resetView();

    expect(firstReset).toHaveBeenCalledOnce();
    expect(replacementReset).not.toHaveBeenCalled();
    service.resetView();
    expect(replacementReset).toHaveBeenCalledOnce();
  });

  it("isolates View and reporter failures from later commands", () => {
    const failure = new Error("renderer failed");
    const reportError = vi.fn(() => {
      throw new Error("reporter failed");
    });
    const resetView = vi
      .fn()
      .mockImplementationOnce(() => {
        throw failure;
      })
      .mockImplementation(() => undefined);
    const service = new BrowserStageViewService(reportError);
    service.attachView({ resetView });

    expect(() => service.resetView()).not.toThrow();
    expect(reportError).toHaveBeenCalledWith(failure);
    expect(() => service.resetView()).not.toThrow();
    expect(resetView).toHaveBeenCalledTimes(2);
  });

  it("reports an asynchronous View failure exactly once", async () => {
    const failure = new Error("async renderer failed");
    const reportError = vi.fn();
    const service = new BrowserStageViewService(reportError);
    service.attachView({
      resetView: vi.fn(async () => Promise.reject(failure)),
    });

    expect(() => service.resetView()).not.toThrow();

    await vi.waitFor(() => expect(reportError).toHaveBeenCalledWith(failure));
    expect(reportError).toHaveBeenCalledOnce();
  });

  it("disposes only the borrowed reference and rejects late attachments", () => {
    const resetView = vi.fn();
    const disposeView = vi.fn();
    const service = new BrowserStageViewService(vi.fn());
    const view = { resetView, dispose: disposeView };
    const attachment = service.attachView(view);

    service.dispose();
    service.dispose();
    attachment.dispose();
    service.resetView();

    expect(resetView).not.toHaveBeenCalled();
    expect(disposeView).not.toHaveBeenCalled();
    expect(() => service.attachView({ resetView })).toThrow(
      "Stage view service is disposed",
    );
  });
});
