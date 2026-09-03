import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { LibraryEntry } from "../../src/domain/motion/common/motion";
import type { HhAppBridge } from "../../src/runtime/types";
import { MotionPickerDialog } from "../../src/workbench/browser/components/motion-picker-dialog";

const entry: LibraryEntry = {
  source_path: "/motions/walk.pt",
  stem: "Walk cycle",
  asset_kind: "human_motion",
  motion_category: "motion",
};

afterEach(() => {
  cleanup();
  delete window.__hhApp;
});

describe("MotionPickerDialog", () => {
  it("publishes and closes after the selected motion wins the Stage", async () => {
    const loadHumanMotionEntry = vi.fn(async () => "selected" as const);
    window.__hhApp = {
      API: {
        get: vi.fn(async () => ({ entries: [entry] })),
      },
      loadHumanMotionEntry,
    } as unknown as HhAppBridge;
    const onClose = vi.fn();
    const onSelected = vi.fn();

    render(
      <MotionPickerDialog
        open
        locale="en"
        onClose={onClose}
        onImport={vi.fn()}
        onSelected={onSelected}
      />,
    );
    fireEvent.click(await screen.findByRole("option", { name: /Walk cycle/ }));

    await waitFor(() => expect(onSelected).toHaveBeenCalledWith(entry));
    expect(loadHumanMotionEntry).toHaveBeenCalledWith(entry);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("keeps the picker open when another motion supersedes selection", async () => {
    const loadHumanMotionEntry = vi.fn(async () => "superseded" as const);
    window.__hhApp = {
      API: {
        get: vi.fn(async () => ({ entries: [entry] })),
      },
      loadHumanMotionEntry,
    } as unknown as HhAppBridge;
    const onClose = vi.fn();
    const onSelected = vi.fn();

    render(
      <MotionPickerDialog
        open
        locale="en"
        onClose={onClose}
        onImport={vi.fn()}
        onSelected={onSelected}
      />,
    );
    fireEvent.click(await screen.findByRole("option", { name: /Walk cycle/ }));

    await waitFor(() => expect(loadHumanMotionEntry).toHaveBeenCalledWith(entry));
    await waitFor(() =>
      expect(screen.getByRole("option", { name: /Walk cycle/ })).toBeEnabled(),
    );
    expect(onSelected).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});
