import type { ChangeEventHandler, RefObject } from "react";

import { Button } from "@/components/ui/button";
import type { LocaleText } from "@/workbench/services/localization/browser/use-locale-text";
import type { VideoToMotionControllerState } from "../video-to-motion-controller";
import { OperationFeedback } from "./operation-feedback";
import { WorkflowStep } from "./workflow-step";

interface MotionResultStepProps {
  readonly detailsRef: RefObject<HTMLDetailsElement | null>;
  readonly resultInputRef: RefObject<HTMLInputElement | null>;
  readonly state: VideoToMotionControllerState;
  readonly busy: boolean;
  readonly text: LocaleText;
  readonly onResultInputChange: ChangeEventHandler<HTMLInputElement>;
  readonly onOpenMotionLibrary: () => void;
}

/** Existing-result import and summary for the motion produced or imported. */
export function MotionResultStep({
  detailsRef,
  resultInputRef,
  state,
  busy,
  text,
  onResultInputChange,
  onOpenMotionLibrary,
}: MotionResultStepProps) {
  const result = state.result;
  const importing =
    state.operation === "import" && state.stage !== "idle";

  return (
    <WorkflowStep
      id="gvhmr-step-result"
      title={text("4. Motion result", "4. 动作结果")}
      detailsRef={detailsRef}
    >
      <input
        ref={resultInputRef}
        type="file"
        accept=".pt"
        aria-label={text(
          "Select an existing GVHMR result",
          "选择已有 GVHMR 结果",
        )}
        hidden
        disabled={busy}
        onChange={onResultInputChange}
      />
      <Button
        id="gvhmr-import-result"
        type="button"
        variant="secondary"
        size="sm"
        className="btn secondary small"
        disabled={busy}
        onClick={() => resultInputRef.current?.click()}
      >
        {text(
          "Import existing GVHMR result (.pt)",
          "导入已有 GVHMR 结果 (.pt)",
        )}
      </Button>
      <OperationFeedback state={state} operation="import" text={text} />
      {!result && !importing ? (
        <p id="gvhmr-result-empty" className="hint">
          {text("No motion result yet.", "尚未生成动作结果。")}
        </p>
      ) : result ? (
        <div id="gvhmr-result-card">
          <div className="meta-row">
            <span className="k">{text("Motion", "动作")}</span>
            <span className="v" id="gvhmr-result-name">
              {result.name}
            </span>
          </div>
          <div className="meta-row">
            <span className="k">{text("Frames", "帧数")}</span>
            <span className="v" id="gvhmr-result-frames">
              {result.frames ?? "—"}
            </span>
          </div>
          <div className="meta-row">
            <span className="k">{text("Duration", "时长")}</span>
            <span className="v" id="gvhmr-result-duration">
              {[
                result.duration === null
                  ? null
                  : `${result.duration.toFixed(2)} s`,
                result.framerate === null
                  ? null
                  : `${result.framerate.toFixed(2)} fps`,
              ]
                .filter(Boolean)
                .join(" · ") || "—"}
            </span>
          </div>
          <Button
            type="button"
            variant="secondary"
            className="btn secondary"
            onClick={onOpenMotionLibrary}
          >
            {text("Open Motion Library", "打开动作资源库")}
          </Button>
        </div>
      ) : null}
    </WorkflowStep>
  );
}
