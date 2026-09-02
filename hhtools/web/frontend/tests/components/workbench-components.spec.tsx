import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { JobHistoryRecord } from "../../src/domain/jobs/job";
import type { HhAppBridge } from "../../src/runtime/types";
import { PlaybackBar } from "../../src/workbench/browser/components/playback-bar";
import { SearchField } from "../../src/workbench/browser/components/search-field";
import { SidebarNavigation } from "../../src/workbench/browser/components/sidebar-navigation";
import { JobDrawer } from "../../src/workbench/browser/components/job-drawer";
import { StageModel } from "../../src/workbench/services/stage/common/stage-model";

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
