import { useMemo } from "react";

import {
  PipelineNav,
  type PipelineNode,
} from "@/components/ui/pipeline-nav";
import type { WorkspaceLocale } from "@/workbench/common/workspace";
import type { VideoToMotionControllerState } from "./video-to-motion-controller";
import { useLocaleText } from "@/workbench/services/localization/browser/use-locale-text";

export type VideoToMotionStep =
  | "video"
  | "environment"
  | "generate"
  | "result";

interface VideoToMotionPipelineViewProps {
  readonly locale: WorkspaceLocale;
  readonly state: VideoToMotionControllerState;
  readonly canRun: boolean;
  readonly canConfirmEnvironment: boolean;
  readonly onActivateStep: (step: VideoToMotionStep) => void;
}

/** Pure state-to-navigation projection for the React-owned workflow. */
export function VideoToMotionPipelineView({
  locale,
  state,
  canRun,
  canConfirmEnvironment,
  onActivateStep,
}: VideoToMotionPipelineViewProps) {
  const text = useLocaleText(locale);

  const nodes = useMemo<PipelineNode[]>(() => {
    const busy =
      state.stage === "reserving"
      || state.stage === "uploading"
      || state.stage === "running";
    const generating = busy && state.operation === "generate";
    const importing = busy && state.operation === "import";
    const runtimeDetail = (() => {
      if (
        state.runtimePhase === "idle" ||
        state.runtimePhase === "checking"
      ) {
        return text("Checking…", "检查中……");
      }
      if (state.runtimePhase === "ready") {
        if (state.environmentConfirmed) {
          return state.weightSource === "official"
            ? text(
                "Official GVHMR confirmed",
                "已确认 GVHMR 官方环境",
              )
            : (state.checkpointName ??
                text(
                  "Custom checkpoint not selected",
                  "尚未选择自定义 checkpoint",
                ));
        }
        return state.weightSource === "custom"
          ? state.checkpointName
            ? text(
                "Ready · custom weights (best effort)",
                "已就绪 · 自定义权重（不保证兼容）",
              )
            : text(
                "Ready · select custom weights",
                "已就绪 · 请选择自定义权重",
              )
          : text("Ready · official weights", "已就绪 · 官方权重");
      }
      return (
        state.runtime?.missing[0] ??
        state.runtimeError ??
        text(
          "GVHMR runtime is unavailable",
          "GVHMR 推理环境不可用",
        )
      );
    })();

    const generateDetail = generating
      ? `${Math.round(state.progress * 100)}%`
      : state.operation === "generate" && state.stage === "completed"
        ? text("Completed", "已完成")
        : state.operation === "generate" && state.stage === "failed"
          ? text("Failed", "失败")
          : text("Not started", "未开始");

    const resultDetail = state.result?.name
      ? state.result.name
      : importing
        ? `${text("Importing", "正在导入")} ${Math.round(state.progress * 100)}%`
        : state.operation === "import" && state.stage === "failed"
          ? text("Import failed", "导入失败")
          : text("No result", "尚无结果");

    return [
      {
        id: "video",
        label: text("Select Video", "选择视频"),
        detail: state.video?.name ?? text("Not selected", "未选择"),
        state: state.video ? "completed" : "ready",
        activate: () => onActivateStep("video"),
      },
      {
        id: "environment",
        label: text("Environment", "选择环境"),
        detail: runtimeDetail,
        state:
          state.runtimePhase === "idle" ||
          state.runtimePhase === "checking"
            ? "validating"
            : state.runtimePhase === "unavailable"
              ? "failed"
              : state.environmentConfirmed
                ? "completed"
                : canConfirmEnvironment
                  ? "ready"
                  : "missing",
        activate: () => onActivateStep("environment"),
      },
      {
        id: "generate",
        label: text("Generate", "生成"),
        detail: generateDetail,
        state: generating
          ? "running"
          : state.operation === "generate" && state.stage === "completed"
            ? "completed"
            : state.operation === "generate" && state.stage === "failed"
              ? "failed"
              : canRun
                ? "ready"
                : "missing",
        activate: () => onActivateStep("generate"),
      },
      {
        id: "result",
        label: text("Motion Result", "动作结果"),
        detail: resultDetail,
        state: state.result
          ? "completed"
          : importing
            ? "running"
            : state.operation === "import" && state.stage === "failed"
              ? "failed"
              : "missing",
        activate: () => onActivateStep("result"),
      },
    ];
  }, [canConfirmEnvironment, canRun, onActivateStep, state, text]);

  return (
    <PipelineNav
      label={text("Video to Motion Pipeline", "视频生成动作流程")}
      className="video-to-motion-pipeline"
      nodes={nodes}
    />
  );
}
