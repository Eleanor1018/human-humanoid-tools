import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { VideoToMotionControllerState } from "../../src/workbench/contrib/video-to-motion/browser/video-to-motion-controller";
import { VideoToMotionPipelineView } from "../../src/workbench/contrib/video-to-motion/browser/video-to-motion-pipeline-view";

afterEach(cleanup);

function state(
  patch: Partial<VideoToMotionControllerState> = {},
): VideoToMotionControllerState {
  return {
    video: null,
    weightSource: "official",
    checkpointName: null,
    runtimePhase: "checking",
    runtime: null,
    runtimeError: null,
    environmentConfirmed: false,
    staticCamera: true,
    focalLength: "",
    operation: null,
    stage: "idle",
    progress: 0,
    progressDetail: null,
    error: null,
    result: null,
    ...patch,
  };
}

function node(name: string): HTMLButtonElement {
  return screen.getByRole("button", { name });
}

describe("VideoToMotionPipelineView", () => {
  it("projects readiness without observing global runtime events", () => {
    render(
      <VideoToMotionPipelineView
        locale="en"
        state={state({
          video: {
            name: "walk.mp4",
            size: 1,
            mediaType: "video/mp4",
            previewUrl: "blob:walk",
            duration: null,
          },
          runtimePhase: "ready",
          runtime: { ready: true, missing: [] },
        })}
        canRun={false}
        canConfirmEnvironment
        onActivateStep={vi.fn()}
      />,
    );

    expect(node("Select Video")).toHaveClass("state-completed");
    expect(node("Environment")).toHaveClass("state-ready");
    expect(node("Environment")).toHaveAttribute(
      "title",
      "Ready · official weights",
    );
    expect(node("Generate")).toHaveClass("state-missing");
    expect(node("Motion Result")).toHaveClass("state-missing");
  });

  it("projects runtime validation and transport failures", () => {
    const props = {
      locale: "en" as const,
      canRun: false,
      canConfirmEnvironment: false,
      onActivateStep: vi.fn(),
    };
    const { rerender } = render(
      <VideoToMotionPipelineView {...props} state={state()} />,
    );
    expect(node("Environment")).toHaveClass("state-validating");
    expect(node("Environment")).toHaveAttribute("title", "Checking…");

    rerender(
      <VideoToMotionPipelineView
        {...props}
        state={state({
          runtimePhase: "unavailable",
          runtime: null,
          runtimeError: "CUDA runtime missing",
        })}
      />,
    );
    expect(node("Environment")).toHaveClass("state-failed");
    expect(node("Environment")).toHaveAttribute(
      "title",
      "CUDA runtime missing",
    );
  });

  it("keeps generation and result-import progress on their owning steps", () => {
    const { rerender } = render(
      <VideoToMotionPipelineView
        locale="en"
        state={state({
          operation: "generate",
          stage: "running",
          progress: 0.54,
        })}
        canRun={false}
        canConfirmEnvironment={false}
        onActivateStep={vi.fn()}
      />,
    );

    expect(node("Generate")).toHaveClass("state-running");
    expect(node("Generate")).toHaveAttribute("title", "54%");
    expect(node("Motion Result")).toHaveClass("state-missing");

    rerender(
      <VideoToMotionPipelineView
        locale="en"
        state={state({
          operation: "import",
          stage: "uploading",
          progress: 0.04,
        })}
        canRun={false}
        canConfirmEnvironment={false}
        onActivateStep={vi.fn()}
      />,
    );

    expect(node("Generate")).toHaveClass("state-missing");
    expect(node("Motion Result")).toHaveClass("state-running");
    expect(node("Motion Result")).toHaveAttribute("title", "Importing 4%");
  });

  it("marks only the failed operation's step and delegates navigation", () => {
    const activate = vi.fn();
    const { rerender } = render(
      <VideoToMotionPipelineView
        locale="zh-CN"
        state={state({ operation: "generate", stage: "failed" })}
        canRun
        canConfirmEnvironment={false}
        onActivateStep={activate}
      />,
    );

    expect(node("生成")).toHaveClass("state-failed");
    expect(node("动作结果")).toHaveClass("state-missing");
    fireEvent.click(node("生成"));
    expect(activate).toHaveBeenLastCalledWith("generate");

    rerender(
      <VideoToMotionPipelineView
        locale="zh-CN"
        state={state({ operation: "import", stage: "failed" })}
        canRun={false}
        canConfirmEnvironment={false}
        onActivateStep={activate}
      />,
    );
    expect(node("生成")).toHaveClass("state-missing");
    expect(node("动作结果")).toHaveClass("state-failed");
    expect(node("动作结果")).toHaveAttribute("title", "导入失败");
  });
});
