import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { WorkflowPipeline } from "../../src/workbench/browser/components/workflow-pipeline";

afterEach(() => cleanup());

describe("WorkflowPipeline", () => {
  it("renders the H2R pipeline and publishes navigation", () => {
    let panel: string | null = null;
    window.addEventListener(
      "hhtools:panel-request",
      (event) => {
        panel = (event as CustomEvent<string>).detail;
      },
      { once: true },
    );
    render(<WorkflowPipeline workflow="h2r" locale="en" />);
    fireEvent.click(screen.getByText("Motion"));
    expect(panel).toBe("motion");
  });

  it("accepts immutable runtime status snapshots", () => {
    render(<WorkflowPipeline workflow="r2r" locale="zh-CN" />);
    act(() =>
      window.dispatchEvent(
        new CustomEvent("hhtools:workflow-state", {
          detail: {
            workflow: "r2r",
            blockedReason: null,
            nodes: [
              {
                id: "source",
                label: "Source",
                state: "ready",
                detail: "Ready",
                panel: "r2r",
              },
            ],
          },
        }),
      ),
    );
    expect(screen.getByText("源机器人").closest("button")).toHaveClass(
      "state-ready",
    );
  });
});
