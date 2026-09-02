import { useMemo, useState } from "react";

import {
  PipelineNav,
  type PipelineNode,
} from "@/components/ui/pipeline-nav";
import { useLocaleText } from "@/workbench/services/localization/browser/use-locale-text";
import { useWindowEvent } from "@/platform/events/browser/use-window-event";
import { windowEventBus } from "@/platform/events/browser/window-event-bus";
import type { WorkspaceLocale } from "@/workbench/common/workspace";
import type { VideoToMotionStateDetail } from "@/workbench/contrib/video-to-motion/common/video-to-motion-state";

const initialState: VideoToMotionStateDetail = {
  videoName: null,
  weightSource: "official",
  checkpointName: null,
  runtimeState: "checking",
  runtimeMessage: "Checking GVHMR runtime",
  environmentConfirmed: false,
  stage: "idle",
  progress: 0,
  message: "",
  result: null,
};

/** Read-only React projection of the state still emitted by the migration runtime. */
export function VideoToMotionPipeline({ locale }: { locale: WorkspaceLocale }) {
  const text = useLocaleText(locale);
  const [state, setState] = useState(initialState);
  useWindowEvent("hhtools:video-to-motion-state", (event) =>
    setState(event.detail),
  );

  const nodes = useMemo<PipelineNode[]>(() => {
    const hasVideo = state.videoName !== null;
    const runtimeReady = state.runtimeState === "ready";
    const processing = state.stage === "uploading" || state.stage === "running";
    const open =
      (target: string): (() => void) =>
      () => {
        windowEventBus.emit("hhtools:panel-request", "video-to-motion");
        requestAnimationFrame(() => {
          const element = document.getElementById(target);
          if (element instanceof HTMLDetailsElement) element.open = true;
          element?.scrollIntoView({ block: "nearest", behavior: "smooth" });
        });
      };
    return [
      {
        id: "video",
        label: text("Select Video", "选择视频"),
        detail: state.videoName ?? text("Not selected", "未选择"),
        state: hasVideo ? "completed" : "ready",
        activate: open("gvhmr-step-video"),
      },
      {
        id: "runtime",
        label: text("Environment", "选择环境"),
        detail: state.environmentConfirmed
          ? state.weightSource === "official"
            ? text("Official GVHMR confirmed", "已确认 GVHMR 官方环境")
            : (state.checkpointName ??
              text(
                "Custom checkpoint not selected",
                "尚未选择自定义 checkpoint",
              ))
          : state.runtimeMessage,
        state: !runtimeReady
          ? state.runtimeState === "checking"
            ? "missing"
            : "failed"
          : state.environmentConfirmed
            ? "completed"
            : hasVideo
              ? "ready"
              : "missing",
        activate: open("gvhmr-step-environment"),
      },
      {
        id: "generate",
        label: text("Generate", "生成"),
        detail: processing
          ? `${Math.round(state.progress * 100)}%`
          : state.stage === "completed"
            ? text("Completed", "已完成")
            : state.stage === "failed"
              ? text("Failed", "失败")
              : text("Not started", "未开始"),
        state: processing
          ? "running"
          : state.stage === "completed"
            ? "completed"
            : state.stage === "failed"
              ? "failed"
              : hasVideo && runtimeReady && state.environmentConfirmed
                ? "ready"
                : "missing",
        activate: open("gvhmr-step-generate"),
      },
      {
        id: "result",
        label: text("Motion Result", "动作结果"),
        detail: state.result?.name ?? text("No result", "尚无结果"),
        state: state.result
          ? "completed"
          : state.stage === "failed"
            ? "failed"
            : "missing",
        activate: open("gvhmr-step-result"),
      },
    ];
  }, [state, text]);

  return (
    <PipelineNav
      label={text("Video to Motion Pipeline", "视频生成动作流程")}
      className="video-to-motion-pipeline"
      nodes={nodes}
    />
  );
}
