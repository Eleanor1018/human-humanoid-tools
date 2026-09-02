import { beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";

const runtimeMocks = vi.hoisted(() => ({
  presentHumanMotion: vi.fn(),
  resetStageView: vi.fn(),
  subscribeH2rStageDisplayState: vi.fn(),
}));

vi.mock("../../src/runtime/webui-runtime", () => ({
  presentHumanMotion: runtimeMocks.presentHumanMotion,
  resetStageView: runtimeMocks.resetStageView,
  subscribeH2rStageDisplayState: runtimeMocks.subscribeH2rStageDisplayState,
}));
vi.mock("../../src/runtime/dataset-viz", () => ({}));

import type { MotionPayload } from "../../src/domain/motion/common/motion";
import { createBrowserWorkbenchServices } from "../../src/workbench/services/browser/browser-workbench-services";
import { BrowserLegacyRuntimeService } from "../../src/workbench/services/runtime/browser/browser-legacy-runtime-service";
import type { ILegacyRuntimeService } from "../../src/workbench/services/runtime/common/legacy-runtime-service";
import type {
  ILegacyStageDisplayStateSource,
  LegacyH2rStageDisplaySnapshot,
} from "../../src/workbench/services/stage/browser/legacy-stage-display-state-source";

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
  runtimeMocks.subscribeH2rStageDisplayState.mockReset();
  runtimeMocks.subscribeH2rStageDisplayState.mockReturnValue(vi.fn());
});

describe("LegacyRuntimeService", () => {
  it("keeps browser-only Stage capabilities out of the common lifecycle contract", () => {
    expectTypeOf<ILegacyRuntimeService>().not.toHaveProperty("resetStageView");
    expectTypeOf<ILegacyRuntimeService>().not.toHaveProperty(
      "subscribeH2rStageDisplayState",
    );
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

  it("forwards the synchronous initial H2R display snapshot after readiness", async () => {
    const service = new BrowserLegacyRuntimeService();
    expectTypeOf(service).toMatchTypeOf<ILegacyStageDisplayStateSource>();
    const unsubscribe = vi.fn();
    const current: LegacyH2rStageDisplaySnapshot = {
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
        scaledSkeleton: { available: true, visible: false, canToggle: true },
        scaledEnvironment: {
          available: false,
          visible: false,
          canToggle: false,
        },
        targetRobot: { available: true, visible: true, canToggle: true },
      },
    };
    runtimeMocks.subscribeH2rStageDisplayState.mockImplementationOnce(
      (listener: (snapshot: LegacyH2rStageDisplaySnapshot) => void) => {
        // The real publisher sends its first complete snapshot synchronously.
        listener(current);
        return unsubscribe;
      },
    );
    const listener = vi.fn();

    const subscription = await service.subscribeH2rStageDisplayState(listener);

    expect(runtimeMocks.subscribeH2rStageDisplayState).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(current);
    expect(listener.mock.calls[0]?.[0]).toBe(current);
    subscription.dispose();
    subscription.dispose();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("keeps readiness valid when display subscription setup fails", async () => {
    const service = new BrowserLegacyRuntimeService();
    const readiness = service.start();
    await readiness;
    const failure = new Error("display subscription failed");
    runtimeMocks.subscribeH2rStageDisplayState.mockImplementationOnce(() => {
      throw failure;
    });

    await expect(
      service.subscribeH2rStageDisplayState(vi.fn()),
    ).rejects.toBe(failure);
    expect(service.start()).toBe(readiness);
  });

  it("owns each display listener with an independent disposable", async () => {
    const service = new BrowserLegacyRuntimeService();
    const disposeFirst = vi.fn();
    const disposeSecond = vi.fn();
    runtimeMocks.subscribeH2rStageDisplayState
      .mockReturnValueOnce(disposeFirst)
      .mockReturnValueOnce(disposeSecond);

    const first = await service.subscribeH2rStageDisplayState(vi.fn());
    const second = await service.subscribeH2rStageDisplayState(vi.fn());
    first.dispose();
    first.dispose();

    expect(disposeFirst).toHaveBeenCalledOnce();
    expect(disposeSecond).not.toHaveBeenCalled();
    second.dispose();
    expect(disposeSecond).toHaveBeenCalledOnce();
  });

  it("exposes narrow runtime roles through one owned browser adapter", () => {
    const services = createBrowserWorkbenchServices(vi.fn());

    expect(services.motionResultPresentationService).toBe(
      services.legacyRuntimeService,
    );

    services.dispose();
  });
});
