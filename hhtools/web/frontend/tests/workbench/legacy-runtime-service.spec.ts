import { beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";

const runtimeMocks = vi.hoisted(() => ({
  presentHumanMotion: vi.fn(),
  resetStageView: vi.fn(),
}));

vi.mock("../../src/runtime/webui-runtime", () => ({
  presentHumanMotion: runtimeMocks.presentHumanMotion,
  resetStageView: runtimeMocks.resetStageView,
}));
vi.mock("../../src/runtime/dataset-viz", () => ({}));

import type { MotionPayload } from "../../src/domain/motion/common/motion";
import { createBrowserWorkbenchServices } from "../../src/workbench/services/browser/browser-workbench-services";
import { BrowserLegacyRuntimeService } from "../../src/workbench/services/runtime/browser/browser-legacy-runtime-service";
import type { ILegacyRuntimeService } from "../../src/workbench/services/runtime/common/legacy-runtime-service";

const payload: MotionPayload = {
  name: "generated walk",
  token: "motion-token",
  positions: [],
  parent_indices: [],
};

beforeEach(() => {
  runtimeMocks.presentHumanMotion.mockReset();
  runtimeMocks.presentHumanMotion.mockResolvedValue(undefined);
  runtimeMocks.resetStageView.mockReset();
});

describe("LegacyRuntimeService", () => {
  it("keeps browser-only Stage capabilities out of the common lifecycle contract", () => {
    expectTypeOf<ILegacyRuntimeService>().not.toHaveProperty("resetStageView");
  });

  it("shares one readiness promise across concurrent callers", async () => {
    const service = new BrowserLegacyRuntimeService();

    const first = service.start();
    const concurrent = service.start();

    expect(concurrent).toBe(first);
    await expect(first).resolves.toBeUndefined();
    expect(service.start()).toBe(first);
  });

  it("starts implicitly before forwarding one aggregate presentation", async () => {
    const service = new BrowserLegacyRuntimeService();

    await expect(service.presentHumanMotion(payload)).resolves.toBeUndefined();

    expect(runtimeMocks.presentHumanMotion).toHaveBeenCalledOnce();
    expect(runtimeMocks.presentHumanMotion).toHaveBeenCalledWith(payload);
  });

  it("propagates presentation failures without invalidating readiness", async () => {
    const service = new BrowserLegacyRuntimeService();
    const readiness = service.start();
    await readiness;
    const failure = new Error("stage rejected motion");
    runtimeMocks.presentHumanMotion.mockRejectedValueOnce(failure);

    await expect(service.presentHumanMotion(payload)).rejects.toBe(failure);

    expect(service.start()).toBe(readiness);
  });

  it("joins runtime readiness before forwarding Stage reset", async () => {
    const service = new BrowserLegacyRuntimeService();

    await expect(service.resetStageView()).resolves.toBeUndefined();

    expect(runtimeMocks.resetStageView).toHaveBeenCalledOnce();
    await expect(service.start()).resolves.toBeUndefined();
  });

  it("exposes both contracts through one owned browser adapter", () => {
    const services = createBrowserWorkbenchServices(vi.fn());

    expect(services.motionResultPresentationService).toBe(
      services.legacyRuntimeService,
    );

    services.dispose();
  });
});
