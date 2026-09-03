import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { Profiler } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { JobHistoryRecord } from "../../src/domain/jobs/job";
import type { HhAppBridge } from "../../src/runtime/types";
import { H2rStageLayerControls } from "../../src/workbench/browser/components/h2r-stage-layer-controls";
import { PlaybackBar } from "../../src/workbench/browser/components/playback-bar";
import { SearchField } from "../../src/workbench/browser/components/search-field";
import { SidebarNavigation } from "../../src/workbench/browser/components/sidebar-navigation";
import { JobDrawer } from "../../src/workbench/browser/components/job-drawer";
import { StageModel } from "../../src/workbench/services/stage/common/stage-model";
import {
  STAGE_LAYER_IDS,
  type StageLayerId,
} from "../../src/workbench/services/stage/common/stage-service";
import { ThreeStage } from "../../src/workbench/browser/components/three-stage";

afterEach(() => {
  cleanup();
  delete window.__hhApp;
});

describe("React workbench components", () => {
  it("requests a panel from the shared sidebar", () => {
    const request = vi.fn();
    render(
      <SidebarNavigation
        activePanel="motion"
        locale="en"
        onRequest={request}
      />,
    );
    fireEvent.click(screen.getByTitle("Human → Robot"));
    expect(request).toHaveBeenCalledWith("h2r");
  });

  it("keeps reusable search input controlled", () => {
    const change = vi.fn();
    const { rerender } = render(
      <SearchField
        id="test-search"
        value="robot"
        label="Search"
        onValueChange={change}
      />,
    );
    fireEvent.click(screen.getByLabelText("Clear search"));
    expect(change).toHaveBeenCalledWith("");
    rerender(
      <SearchField
        id="test-search"
        value=""
        label="Search"
        onValueChange={change}
      />,
    );
    expect(screen.getByRole("searchbox")).toHaveValue("");
  });

  it("renders Stage playback state while commands use the migration bridge", () => {
    const stageModel = new StageModel(vi.fn());
    const stagePlaybackCommands = {
      togglePlayback: vi.fn(),
      seekToFraction: vi.fn(),
      setPlaybackSpeed: vi.fn(),
      togglePlaybackLoop: vi.fn(),
    };
    const view = render(
      <PlaybackBar
        locale="en"
        stageModelService={stageModel}
        stagePlaybackCommands={stagePlaybackCommands}
      />,
    );
    act(() => {
      stageModel.updateState({
        playback: {
          controlsVisible: true,
          active: true,
          playing: true,
          currentTime: 2,
          duration: 8,
          previewSourceDuration: 12,
        },
      });
    });
    expect(screen.getByText("2.00 / 8.00 s (preview; source 12.0 s)"))
      .toBeInTheDocument();
    view.rerender(
      <PlaybackBar
        locale="zh-CN"
        stageModelService={stageModel}
        stagePlaybackCommands={stagePlaybackCommands}
      />,
    );
    expect(screen.getByText("2.00 / 8.00 s（预览，原片 12.0 s）"))
      .toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("暂停"));
    expect(stagePlaybackCommands.togglePlayback).toHaveBeenCalledOnce();
    fireEvent.change(screen.getByLabelText("播放进度"), {
      target: { value: "50" },
    });
    expect(stagePlaybackCommands.seekToFraction).toHaveBeenCalledWith(0.5);
    fireEvent.change(screen.getByLabelText("播放速度"), {
      target: { value: "2.5" },
    });
    fireEvent.doubleClick(screen.getByTitle("播放速度（拖动调节，双击复位 1×）"));
    expect(stagePlaybackCommands.setPlaybackSpeed.mock.calls).toEqual([
      [2.5],
      [1],
    ]);
    fireEvent.click(screen.getByLabelText("切换循环播放"));
    expect(stagePlaybackCommands.togglePlaybackLoop).toHaveBeenCalledOnce();
    stageModel.dispose();
  });

  it("routes the Stage reset button through its narrow command contract", () => {
    const stageModel = new StageModel(vi.fn());
    const resetView = vi.fn();

    render(
      <ThreeStage
        locale="en"
        stageDisplayCommands={{ resetView }}
        stageLayerCommands={{ toggleLayer: vi.fn() }}
        stageModelService={stageModel}
        stagePlaybackCommands={{
          togglePlayback: vi.fn(),
          seekToFraction: vi.fn(),
          setPlaybackSpeed: vi.fn(),
          togglePlaybackLoop: vi.fn(),
        }}
      />,
    );
    fireEvent.click(screen.getByLabelText("Reset view"));

    expect(resetView).toHaveBeenCalledOnce();
    stageModel.dispose();
  });

  it("leaves R2R layer commands on the compatibility boundary", () => {
    const stageModel = new StageModel(vi.fn());
    const toggleLayer = vi.fn();
    render(
      <ThreeStage
        locale="en"
        stageDisplayCommands={{ resetView: vi.fn() }}
        stageLayerCommands={{ toggleLayer }}
        stageModelService={stageModel}
        stagePlaybackCommands={{
          togglePlayback: vi.fn(),
          seekToFraction: vi.fn(),
          setPlaybackSpeed: vi.fn(),
          togglePlaybackLoop: vi.fn(),
        }}
      />,
    );
    const r2rRobot = document.getElementById(
      "r2r-tg-src-robot",
    ) as HTMLButtonElement;
    const legacyClick = vi.fn();
    r2rRobot.addEventListener("click", legacyClick);

    fireEvent.click(r2rRobot);

    expect(legacyClick).toHaveBeenCalledOnce();
    expect(toggleLayer).not.toHaveBeenCalled();
    stageModel.dispose();
  });

  it("renders the matching Stage HUD without replacing compatibility nodes", () => {
    const stageModel = new StageModel(vi.fn());
    render(
      <ThreeStage
        locale="en"
        stageDisplayCommands={{ resetView: vi.fn() }}
        stageLayerCommands={{ toggleLayer: vi.fn() }}
        stageModelService={stageModel}
        stagePlaybackCommands={{
          togglePlayback: vi.fn(),
          seekToFraction: vi.fn(),
          setPlaybackSpeed: vi.fn(),
          togglePlaybackLoop: vi.fn(),
        }}
      />,
    );
    const h2rHud = document.getElementById("view-hud")!;
    const r2rHud = document.getElementById("view-hud-r2r")!;

    expect(h2rHud).not.toHaveClass("hidden");
    expect(h2rHud).toHaveAttribute("aria-hidden", "false");
    expect(r2rHud).toHaveClass("hidden");
    expect(r2rHud).toHaveAttribute("aria-hidden", "true");

    act(() => {
      stageModel.updateState({ display: { owner: "r2r" } });
    });

    expect(document.getElementById("view-hud")).toBe(h2rHud);
    expect(document.getElementById("view-hud-r2r")).toBe(r2rHud);
    expect(h2rHud).toHaveClass("hidden");
    expect(h2rHud).toHaveAttribute("aria-hidden", "true");
    expect(r2rHud).not.toHaveClass("hidden");
    expect(r2rHud).toHaveAttribute("aria-hidden", "false");
    stageModel.dispose();
  });

  it("renders and commands H2R layers through canonical Stage contracts", () => {
    const stageModel = new StageModel(vi.fn());
    const toggleLayer = vi.fn();
    let renderCount = 0;
    render(
      <Profiler
        id="h2r-layer-controls"
        onRender={() => {
          renderCount += 1;
        }}
      >
        <H2rStageLayerControls
          locale="en"
          stageLayerCommands={{ toggleLayer }}
          stageModelService={stageModel}
        />
      </Profiler>,
    );
    const toggleLayers = [
      ["tg-skeleton", "sourceSkeleton"],
      ["tg-mesh", "sourceBody"],
      ["tg-env", "sourceEnvironment"],
      ["tg-scaled", "scaledSkeleton"],
      ["tg-scaled-env", "scaledEnvironment"],
      ["tg-robot", "targetRobot"],
    ] as const satisfies ReadonlyArray<readonly [string, StageLayerId]>;
    const buttons = new Map(
      toggleLayers.map(([id]) => [
        id,
        document.getElementById(id) as HTMLButtonElement,
      ]),
    );
    const skeleton = buttons.get("tg-skeleton")!;

    expect(renderCount).toBe(1);
    for (const button of buttons.values()) {
      expect(button).toBeDisabled();
      expect(button).not.toHaveClass("on");
    }

    // A one-hot projection gives every DOM id a unique turn. Swapping any two
    // descriptor mappings therefore fails instead of hiding behind equal state.
    for (const [index, toggle] of toggleLayers.entries()) {
      const [activeButtonId, activeLayerId] = toggle;
      const layers = Object.fromEntries(
        STAGE_LAYER_IDS.map((layerId) => {
          const selected = layerId === activeLayerId;
          return [
            layerId,
            {
              available: selected,
              visible: selected,
              canToggle: selected,
            },
          ];
        }),
      ) as Record<
        StageLayerId,
        { available: boolean; visible: boolean; canToggle: boolean }
      >;
      act(() => {
        stageModel.updateState({
          display: {
            empty: false,
            canResetView: true,
            layers,
          },
        });
      });

      for (const [buttonId] of toggleLayers) {
        const button = buttons.get(buttonId)!;
        const selected = buttonId === activeButtonId;
        if (selected) expect(button).toHaveClass("on");
        else expect(button).not.toHaveClass("on");
        expect(button.disabled).toBe(!selected);
        expect(document.getElementById(buttonId)).toBe(button);
      }
      fireEvent.click(buttons.get(activeButtonId)!);
      expect(toggleLayer).toHaveBeenNthCalledWith(index + 1, activeLayerId);
      // Commands wait for a confirmed renderer snapshot; the View never
      // performs an optimistic class mutation of its own.
      expect(buttons.get(activeButtonId)).toHaveClass("on");
    }
    expect(renderCount).toBe(1 + toggleLayers.length);
    expect(toggleLayer).toHaveBeenCalledTimes(toggleLayers.length);

    act(() => {
      stageModel.updateState({
        display: {
          layers: {
            sourceSkeleton: {
              available: true,
              visible: true,
              canToggle: false,
            },
          },
        },
      });
    });
    expect(skeleton).toHaveClass("on");
    expect(skeleton).toBeDisabled();
    skeleton.click();
    expect(toggleLayer).toHaveBeenCalledTimes(toggleLayers.length);

    act(() => {
      stageModel.updateState({
        display: {
          layers: {
            sourceSkeleton: { canToggle: true },
          },
        },
      });
    });
    expect(document.getElementById("tg-skeleton")).toBe(skeleton);
    fireEvent.click(skeleton);
    expect(toggleLayer).toHaveBeenLastCalledWith("sourceSkeleton");
    expect(toggleLayer).toHaveBeenCalledTimes(toggleLayers.length + 1);

    const displayBeforePlayback = stageModel.state.display;
    const renderCountBeforePlayback = renderCount;
    act(() => {
      stageModel.updateState({
        playback: { active: true, duration: 8, currentTime: 2 },
      });
    });
    expect(stageModel.state.display).toBe(displayBeforePlayback);
    expect(renderCount).toBe(renderCountBeforePlayback);
    for (const [id, button] of buttons) {
      expect(document.getElementById(id)).toBe(button);
      expect(button.isConnected).toBe(true);
    }
    fireEvent.click(skeleton);
    expect(toggleLayer).toHaveBeenLastCalledWith("sourceSkeleton");
    expect(toggleLayer).toHaveBeenCalledTimes(toggleLayers.length + 2);
    stageModel.dispose();
  });

  it("keeps JobSpec duplicate, validate, and rerun actions available", async () => {
    const job: JobHistoryRecord = {
      id: "job-1",
      kind: "retarget",
      status: "done",
      progress: 1,
      clip_progress: 1,
      message: "done",
      error: null,
      created_at: 1_700_000_000,
      finished_at: 1_700_000_001,
      duration_seconds: 1,
      parameters: { robot: "unitree_g1" },
      result_summary: {},
      can_download: false,
      can_copy_cli: true,
      can_retry: true,
      retry_reason: null,
      can_retry_failed: false,
      failed_item_count: 0,
      parent_job_id: null,
      scope: "persistent",
    };
    const get = vi.fn().mockResolvedValue({
      spec: { schema_version: 1, kind: "retarget", request: {} },
    });
    const post = vi
      .fn()
      .mockResolvedValueOnce({
        spec: { schema_version: 1, kind: "retarget", request: {} },
        replay: { available: true, reason: null, source_count: 1 },
      })
      .mockResolvedValueOnce({ job_id: "job-2" });
    window.__hhApp = {
      API: { get, post },
      toast: vi.fn(),
    } as unknown as HhAppBridge;

    render(<JobDrawer locale="en" />);
    fireEvent.click(screen.getByText("Tasks"));
    act(() =>
      window.dispatchEvent(
        new CustomEvent("hhtools:job-history-state", {
          detail: { jobs: [job], loading: false, error: null },
        }),
      ),
    );
    fireEvent.click(screen.getByText("Duplicate & Edit"));

    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith("/api/job/job-1/config");
    fireEvent.click(screen.getByText("Run as New Task"));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    expect(post).toHaveBeenNthCalledWith(1, "/api/jobs/spec/validate", {
      schema_version: 1,
      kind: "retarget",
      request: {},
    });
    expect(post).toHaveBeenNthCalledWith(2, "/api/jobs/replay", {
      spec: { schema_version: 1, kind: "retarget", request: {} },
    });
  });
});
