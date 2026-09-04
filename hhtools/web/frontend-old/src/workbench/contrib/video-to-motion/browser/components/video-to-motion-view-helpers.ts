import type { WorkspaceLocale } from "@/workbench/common/workspace";
import type { LocaleText } from "@/workbench/services/localization/browser/use-locale-text";
import {
  VideoToMotionInputError,
  type VideoToMotionControllerState,
} from "../video-to-motion-controller";

export function formatBytes(bytes: number): string {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isInputError(
  error: unknown,
): error is VideoToMotionInputError {
  return error instanceof VideoToMotionInputError;
}

/** Translate validation errors still owned by the controller at the view edge. */
export function localizeKnownError(
  error: unknown,
  locale: WorkspaceLocale,
): string {
  const message = errorMessage(error);
  if (locale !== "zh-CN") return message;
  if (error instanceof VideoToMotionInputError) {
    switch (error.code) {
      case "unsupported-video":
        return "支持 MP4、MOV、MKV、AVI、WebM 和 M4V 视频。";
      case "invalid-focal-length":
        return "焦距必须是正整数。";
      case "invalid-result":
        return "请选择一个 .pt 格式的 GVHMR 结果。";
      case "operation-in-progress":
      case "input-locked":
        return "当前任务运行中，请等待完成后再修改。";
      case "not-ready":
        return "视频生成动作流程尚未准备好。";
    }
  }
  return message;
}

export function runtimeMessage(
  state: VideoToMotionControllerState,
  text: LocaleText,
): string {
  if (state.runtimePhase === "idle" || state.runtimePhase === "checking") {
    return text("Checking…", "检查中……");
  }
  if (state.runtimePhase === "ready") {
    if (state.weightSource === "custom") {
      return state.checkpointName
        ? text(
            "Ready · custom weights (best effort)",
            "已就绪 · 自定义权重（不保证兼容）",
          )
        : text(
            "Ready · select custom weights",
            "已就绪 · 请选择自定义权重",
          );
    }
    return text("Ready · official weights", "已就绪 · 官方权重");
  }
  return (
    state.runtime?.missing[0] ??
    state.runtimeError ??
    text("GVHMR runtime is unavailable", "GVHMR 推理环境不可用")
  );
}

export function runDisabledReason(
  state: VideoToMotionControllerState,
  busy: boolean,
  text: LocaleText,
): string {
  if (busy) return "";
  if (state.runtimePhase === "idle" || state.runtimePhase === "checking") {
    return text(
      "Checking the GVHMR runtime.",
      "正在检查 GVHMR 推理环境。",
    );
  }
  if (state.runtimePhase === "unavailable") {
    return runtimeMessage(state, text);
  }
  if (!state.video) return text("Select a video first.", "请先选择视频。");
  if (state.weightSource === "custom" && !state.checkpointName) {
    return text(
      "Select a custom checkpoint or switch back to official weights.",
      "请选择自定义 checkpoint，或切回官方权重。",
    );
  }
  if (!state.environmentConfirmed) {
    return text("Confirm the runtime environment.", "请确认运行环境。");
  }
  return "";
}

export function operationMessage(
  state: VideoToMotionControllerState,
  text: LocaleText,
): string {
  if (state.stage === "idle") return "";
  if (state.stage === "failed") return state.error ?? text("Failed", "失败");
  if (state.stage === "completed") {
    return state.operation === "import"
      ? text(
          "Existing GVHMR result imported.",
          "已有 GVHMR 结果已导入。",
        )
      : text(
          "Motion generated successfully.",
          "视频动作生成完成。",
        );
  }
  if (state.stage === "reserving") {
    return state.operation === "import"
      ? text("Preparing result import…", "正在准备导入动作……")
      : text("Preparing motion presentation…", "正在准备动作展示……");
  }
  if (state.progressDetail?.kind === "job") {
    const message = state.progressDetail.message.trim();
    if (message) return message;
  }
  if (state.operation === "import") {
    if (
      state.progressDetail?.kind === "upload" &&
      state.progressDetail.totalBytes > 0
    ) {
      return text(
        `Importing ${formatBytes(state.progressDetail.loadedBytes)} / ${formatBytes(state.progressDetail.totalBytes)}`,
        `正在导入 ${formatBytes(state.progressDetail.loadedBytes)} / ${formatBytes(state.progressDetail.totalBytes)}`,
      );
    }
    return text("Importing result…", "正在导入结果……");
  }
  if (
    state.progressDetail?.kind === "upload" &&
    state.progressDetail.totalBytes > 0
  ) {
    return text(
      `Uploading ${formatBytes(state.progressDetail.loadedBytes)} / ${formatBytes(state.progressDetail.totalBytes)}`,
      `正在上传 ${formatBytes(state.progressDetail.loadedBytes)} / ${formatBytes(state.progressDetail.totalBytes)}`,
    );
  }
  return state.stage === "uploading"
    ? text("Uploading video…", "正在上传视频……")
    : text("Generating motion…", "正在生成动作……");
}
