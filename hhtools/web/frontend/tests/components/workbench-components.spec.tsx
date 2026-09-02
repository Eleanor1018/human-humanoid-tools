import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PlaybackBar } from "../../src/workbench/browser/components/playback-bar";
import { SearchField } from "../../src/workbench/browser/components/search-field";
import { SidebarNavigation } from "../../src/workbench/browser/components/sidebar-navigation";
import { JobDrawer } from "../../src/workbench/browser/components/job-drawer";
import type { HhAppBridge, JobHistoryRecord } from "../../src/runtime/types";

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

  it("bridges playback state and commands through typed window events", () => {
    const commands: unknown[] = [];
    window.addEventListener(
      "hhtools:playback-command",
      (event) => commands.push((event as CustomEvent).detail),
      { once: true },
    );
    render(<PlaybackBar />);
    act(() =>
      window.dispatchEvent(
        new CustomEvent("hhtools:playback-state", {
          detail: { visible: true, playing: true },
        }),
      ),
    );
    fireEvent.click(screen.getByLabelText("暂停"));
    expect(commands).toEqual([{ action: "toggle", value: undefined }]);
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
