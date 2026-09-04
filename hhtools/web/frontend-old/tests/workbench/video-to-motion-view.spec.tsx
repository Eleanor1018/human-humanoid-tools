import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { MotionPayload } from "../../src/domain/motion/common/motion";
import { CommandService } from "../../src/platform/commands/common/command-service";
import { WorkbenchCommandIds } from "../../src/workbench/common/command-ids";
import type { VideoToMotionControllerModel } from "../../src/workbench/contrib/video-to-motion/browser/use-video-to-motion-controller";
import {
  VideoToMotionInputError,
  type VideoToMotionControllerState,
} from "../../src/workbench/contrib/video-to-motion/browser/video-to-motion-controller";
import { VideoToMotionView } from "../../src/workbench/contrib/video-to-motion/browser/video-to-motion-view";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

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

function motion(name: string): MotionPayload {
  return {
    name,
    token: `${name}-token`,
    positions: [],
    parent_indices: [],
  };
}

function model(
  snapshot: VideoToMotionControllerState | null = state(),
  capabilities: {
    readonly busy?: boolean;
    readonly canRun?: boolean;
    readonly canConfirmEnvironment?: boolean;
  } = {},
): VideoToMotionControllerModel {
  return {
    state: snapshot,
    busy: capabilities.busy ?? false,
    canRun: capabilities.canRun ?? false,
    canConfirmEnvironment:
      capabilities.canConfirmEnvironment ?? false,
    selectVideo: vi.fn(),
    selectCheckpoint: vi.fn(),
    setWeightSource: vi.fn(),
    setStaticCamera: vi.fn(),
    setFocalLength: vi.fn(),
    setPreviewDuration: vi.fn(),
    confirmEnvironment: vi.fn(() => true),
    refreshRuntime: vi.fn(async () => undefined),
    run: vi.fn(async () => motion("generated")),
    importResult: vi.fn(async () => motion("imported")),
  };
}

function renderView(
  currentModel: VideoToMotionControllerModel,
  locale: "en" | "zh-CN" = "en",
) {
  const commandService = new CommandService();
  const requestPanel = vi.fn();
  const view = render(
    <VideoToMotionView
      locale={locale}
      requestPanel={requestPanel}
      model={currentModel}
      commandService={commandService}
    />,
  );
  return { commandService, requestPanel, view };
}

describe("VideoToMotionView", () => {
  it("renders accessible inputs and owns the global video picker command", async () => {
    const currentModel = model();
    const inputClick = vi.spyOn(HTMLInputElement.prototype, "click");
    const { commandService, view } = renderView(currentModel);

    const videoInput = screen.getByLabelText("Select a video file");
    expect(videoInput).toHaveAttribute(
      "accept",
      "video/mp4,video/quicktime,video/x-matroska,video/x-msvideo,video/webm,.m4v",
    );
    expect(screen.getByRole("button", { name: "Start GVHMR" })).toBeDisabled();
    expect(screen.getByText("Checking the GVHMR runtime.")).toHaveAttribute(
      "id",
      "gvhmr-disabled-reason",
    );
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();

    await commandService.executeCommand(
      WorkbenchCommandIds.pickVideoToMotionSource,
    );
    expect(inputClick).toHaveBeenCalledOnce();

    view.unmount();
    await expect(
      commandService.executeCommand(
        WorkbenchCommandIds.pickVideoToMotionSource,
      ),
    ).rejects.toMatchObject({ name: "CommandNotFoundError" });
  });

  it("handles picker, drop, validation, and preview metadata through the model", () => {
    const currentModel = model();
    const { commandService, requestPanel, view } = renderView(
      currentModel,
      "zh-CN",
    );
    const videoInput = screen.getByLabelText("选择视频文件");
    const selected = new File(["video"], "walk.mp4", {
      type: "video/mp4",
    });

    fireEvent.change(videoInput, { target: { files: [selected] } });
    expect(currentModel.selectVideo).toHaveBeenCalledWith(selected);
    expect(videoInput).toHaveValue("");

    const dropzone = screen.getByRole("group", { name: "视频上传区" });
    fireEvent.dragEnter(dropzone);
    expect(dropzone).toHaveClass("hover");
    fireEvent.drop(dropzone, {
      dataTransfer: {
        files: [selected, new File(["other"], "other.mp4")],
      },
    });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "GVHMR 每次只处理一个视频。",
    );

    vi.mocked(currentModel.selectVideo).mockImplementation(() => {
      throw new VideoToMotionInputError(
        "unsupported-video",
        "Supported formats: MP4, MOV, MKV, AVI, WebM, and M4V",
      );
    });
    fireEvent.drop(dropzone, {
      dataTransfer: { files: [new File(["text"], "notes.txt")] },
    });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "支持 MP4、MOV、MKV、AVI、WebM 和 M4V 视频。",
    );
    expect(screen.getByRole("alert").closest("details")).toBeNull();

    const previewModel = model(
      state({
        video: {
          name: "walk.mp4",
          size: 2048,
          mediaType: "video/mp4",
          previewUrl: "blob:walk",
          duration: null,
        },
      }),
    );
    view.rerender(
      <VideoToMotionView
        locale="zh-CN"
        requestPanel={requestPanel}
        model={previewModel}
        commandService={commandService}
      />,
    );
    const preview = screen.getByLabelText("所选视频预览");
    Object.defineProperty(preview, "duration", {
      configurable: true,
      value: 2.5,
    });
    fireEvent.loadedMetadata(preview);
    expect(previewModel.setPreviewDuration).toHaveBeenCalledWith(
      "blob:walk",
      2.5,
    );
    expect(screen.getByText("2.0 KB · video/mp4")).toBeInTheDocument();
  });

  it("binds environment, checkpoint, camera, and focal controls", () => {
    const currentModel = model(
      state({
        video: {
          name: "walk.mp4",
          size: 5,
          mediaType: "video/mp4",
          previewUrl: "blob:walk",
          duration: null,
        },
        weightSource: "custom",
        checkpointName: "research.weights",
        runtimePhase: "ready",
        runtime: { ready: true, missing: [] },
      }),
      { canConfirmEnvironment: true },
    );
    renderView(currentModel);

    fireEvent.change(screen.getByLabelText("Runtime environment"), {
      target: { value: "official" },
    });
    expect(currentModel.setWeightSource).toHaveBeenCalledWith("official");

    const checkpoint = new File(["weights"], "experiment.anything");
    fireEvent.change(screen.getByLabelText("Select a custom checkpoint"), {
      target: { files: [checkpoint] },
    });
    expect(currentModel.selectCheckpoint).toHaveBeenCalledWith(checkpoint);
    expect(
      screen.getByText("Ready · custom weights (best effort)"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/official weights/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(currentModel.confirmEnvironment).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByLabelText("Static camera"));
    expect(currentModel.setStaticCamera).toHaveBeenCalledWith(false);
    fireEvent.change(screen.getByLabelText("Focal length (optional, mm)"), {
      target: { value: "35" },
    });
    expect(currentModel.setFocalLength).toHaveBeenCalledWith("35");
  });

  it("renders weighted progress and catches run validation failures", async () => {
    const running = model(
      state({
        operation: "generate",
        stage: "uploading",
        progress: 0.04,
        progressDetail: {
          kind: "upload",
          loadedBytes: 1,
          totalBytes: 4,
        },
      }),
      { busy: true },
    );
    const { view, commandService, requestPanel } = renderView(running);

    expect(screen.getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "4",
    );
    expect(screen.getByRole("progressbar").closest("details")).toHaveAttribute(
      "id",
      "gvhmr-step-generate",
    );
    expect(screen.getByLabelText("Select a video file")).toBeDisabled();
    expect(
      screen.getByLabelText("Select an existing GVHMR result"),
    ).toBeDisabled();
    expect(document.getElementById("gvhmr-status")).toHaveTextContent(
      "Uploading 1 B / 4 B",
    );

    const ready = model(state(), { canRun: true });
    const failure = new VideoToMotionInputError(
      "invalid-focal-length",
      "Focal length must be a positive integer",
    );
    vi.mocked(ready.run).mockRejectedValue(failure);
    view.rerender(
      <VideoToMotionView
        locale="zh-CN"
        requestPanel={requestPanel}
        model={ready}
        commandService={commandService}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "开始 GVHMR 推理" }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "焦距必须是正整数。",
      ),
    );
  });

  it("leaves operation failures to the controller's single alert", async () => {
    const transportFailure = new Error("backend failed");
    const failed = model(
      state({
        operation: "generate",
        stage: "failed",
        error: transportFailure.message,
      }),
      { canRun: true },
    );
    vi.mocked(failed.run).mockRejectedValue(transportFailure);
    renderView(failed);

    fireEvent.click(screen.getByRole("button", { name: "Start GVHMR" }));
    await waitFor(() => expect(failed.run).toHaveBeenCalledOnce());
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.getByRole("alert")).toHaveTextContent("backend failed");
  });

  it("imports results, renders their summary, and navigates without DOM lookup", async () => {
    const currentModel = model(
      state({
        operation: "import",
        stage: "completed",
        progress: 1,
        result: {
          name: "existing motion",
          frames: 72,
          duration: 2.4,
          framerate: 30,
        },
      }),
    );
    const { commandService, requestPanel, view } = renderView(currentModel);
    const source = new File(["motion"], "existing.pt");

    const resultInput = screen.getByLabelText(
      "Select an existing GVHMR result",
    );
    expect(resultInput).toHaveAttribute("accept", ".pt");
    fireEvent.change(resultInput, { target: { files: [source] } });
    await waitFor(() =>
      expect(currentModel.importResult).toHaveBeenCalledWith(source),
    );

    expect(screen.getByText("existing motion")).toBeInTheDocument();
    expect(screen.getByText("72")).toBeInTheDocument();
    expect(screen.getByText("2.40 s · 30.00 fps")).toBeInTheDocument();
    expect(document.getElementById("gvhmr-status")?.closest("details")).toHaveAttribute(
      "id",
      "gvhmr-step-result",
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Open Motion Library" }),
    );
    expect(requestPanel).toHaveBeenCalledWith("motion");

    const resultStep = document.getElementById("gvhmr-step-result");
    expect(resultStep).not.toHaveAttribute("open");
    fireEvent.click(screen.getByRole("button", { name: "Motion Result" }));
    expect(resultStep).toHaveAttribute("open");

    view.rerender(
      <VideoToMotionView
        locale="en"
        requestPanel={requestPanel}
        model={model(state({ operation: "import", stage: "running" }), {
          busy: true,
        })}
        commandService={commandService}
      />,
    );
    expect(resultStep).toHaveAttribute("open");
    expect(screen.getByText("Importing result…")).toBeInTheDocument();
    expect(screen.queryByText("No motion result yet.")).not.toBeInTheDocument();
  });
});
