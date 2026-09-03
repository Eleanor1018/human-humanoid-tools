import { cleanup, render } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ThreeStage } from "../../src/workbench/browser/components/three-stage";
import type {
  ThreeStageRendererMount,
} from "../../src/workbench/browser/stage/three-stage-renderer-mount";
import { StageModel } from "../../src/workbench/services/stage/common/stage-model";

const models = new Set<StageModel>();

afterEach(() => {
  cleanup();
  for (const model of models) model.dispose();
  models.clear();
});

function stageProps(
  stageRendererMount: ThreeStageRendererMount | null,
  overrides: Partial<ComponentProps<typeof ThreeStage>> = {},
): ComponentProps<typeof ThreeStage> {
  const stageModelService = new StageModel(vi.fn());
  models.add(stageModelService);
  return {
    locale: "en",
    stageDisplayCommands: { resetView: vi.fn() },
    stageLayerCommands: { toggleLayer: vi.fn() },
    stageModelService,
    stagePlaybackCommands: {
      togglePlayback: vi.fn(),
      seekToFraction: vi.fn(),
      setPlaybackSpeed: vi.fn(),
      togglePlaybackLoop: vi.fn(),
    },
    stageRendererMount,
    ...overrides,
  };
}

describe("React Stage renderer mount seam", () => {
  it("keeps the committed Stage inert when composition supplies null", () => {
    const view = render(<ThreeStage {...stageProps(null)} />);

    const stage = document.getElementById("stage");
    const canvas = document.getElementById("three-canvas");
    expect(stage).toBeInstanceOf(HTMLElement);
    expect(canvas).toBeInstanceOf(HTMLCanvasElement);
    expect(stage?.isConnected).toBe(true);
    expect(canvas?.parentElement).toBe(stage);
    expect(() => view.unmount()).not.toThrow();
  });

  it("mounts exact connected refs once across unrelated rerenders", () => {
    const dispose = vi.fn();
    const mount = vi.fn(() => ({ dispose }));
    const provider: ThreeStageRendererMount = {
      mount,
      reportError: vi.fn(),
    };
    const initialProps = stageProps(provider);
    const view = render(<ThreeStage {...initialProps} />);

    const stage = document.getElementById("stage") as HTMLElement;
    const canvas = document.getElementById(
      "three-canvas",
    ) as HTMLCanvasElement;
    expect(mount).toHaveBeenCalledOnce();
    expect(mount).toHaveBeenCalledWith({ stage, canvas });
    expect(stage.isConnected).toBe(true);
    expect(canvas.isConnected).toBe(true);
    expect(canvas.parentElement).toBe(stage);

    view.rerender(
      <ThreeStage {...initialProps} locale="zh-CN" batchActive />,
    );

    expect(mount).toHaveBeenCalledOnce();
    expect(dispose).not.toHaveBeenCalled();
    expect(document.getElementById("stage")).toBe(stage);
    expect(document.getElementById("three-canvas")).toBe(canvas);

    view.unmount();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("disposes the old lease before mounting a replacement provider", () => {
    const order: string[] = [];
    const first: ThreeStageRendererMount = {
      mount: vi.fn(() => {
        order.push("mount:first");
        return { dispose: () => order.push("dispose:first") };
      }),
      reportError: vi.fn(),
    };
    const second: ThreeStageRendererMount = {
      mount: vi.fn(() => {
        order.push("mount:second");
        return { dispose: () => order.push("dispose:second") };
      }),
      reportError: vi.fn(),
    };
    const initialProps = stageProps(first);
    const view = render(<ThreeStage {...initialProps} />);

    view.rerender(
      <ThreeStage {...initialProps} stageRendererMount={second} />,
    );

    expect(order).toEqual([
      "mount:first",
      "dispose:first",
      "mount:second",
    ]);
    view.unmount();
    expect(order).toEqual([
      "mount:first",
      "dispose:first",
      "mount:second",
      "dispose:second",
    ]);
  });

  it("uses fresh, non-overlapping leases during the StrictMode cycle", () => {
    let active = 0;
    let maximumActive = 0;
    let nextLease = 0;
    const leases = new Set<object>();
    const disposed: number[] = [];
    const provider: ThreeStageRendererMount = {
      mount: vi.fn(() => {
        const id = ++nextLease;
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        let released = false;
        const lease = {
          dispose: () => {
            if (released) return;
            released = true;
            active -= 1;
            disposed.push(id);
          },
        };
        leases.add(lease);
        return lease;
      }),
      reportError: vi.fn(),
    };

    const view = render(<ThreeStage {...stageProps(provider)} />, {
      reactStrictMode: true,
    });

    expect(provider.mount).toHaveBeenCalledTimes(2);
    expect(leases.size).toBe(2);
    expect(maximumActive).toBe(1);
    expect(active).toBe(1);
    expect(disposed).toEqual([1]);

    view.unmount();
    expect(active).toBe(0);
    expect(disposed).toEqual([1, 2]);
  });

  it("isolates mount and reporter failures from the React commit", () => {
    const mountFailure = new Error("mount failed");
    const reportError = vi.fn(() => {
      throw new Error("reporter failed");
    });
    const provider: ThreeStageRendererMount = {
      mount: vi.fn(() => {
        throw mountFailure;
      }),
      reportError,
    };

    expect(() => render(<ThreeStage {...stageProps(provider)} />)).not.toThrow();
    expect(reportError).toHaveBeenCalledOnce();
    expect(reportError).toHaveBeenCalledWith(mountFailure);
  });

  it("isolates terminal lease and reporter failures during cleanup", () => {
    const cleanupFailure = new Error("cleanup failed");
    let terminal = false;
    const reportError = vi.fn((error: unknown) => {
      expect(terminal).toBe(true);
      expect(error).toBe(cleanupFailure);
      throw new Error("reporter failed");
    });
    const provider: ThreeStageRendererMount = {
      mount: vi.fn(() => ({
        dispose: () => {
          terminal = true;
          throw cleanupFailure;
        },
      })),
      reportError,
    };
    const view = render(<ThreeStage {...stageProps(provider)} />);

    expect(() => view.unmount()).not.toThrow();
    expect(reportError).toHaveBeenCalledOnce();
  });
});
