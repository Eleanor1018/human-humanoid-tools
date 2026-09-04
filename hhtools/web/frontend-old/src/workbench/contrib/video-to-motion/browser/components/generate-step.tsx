import type { RefObject } from "react";

import { Button } from "@/components/ui/button";
import type { LocaleText } from "@/workbench/services/localization/browser/use-locale-text";
import type { VideoToMotionControllerState } from "../video-to-motion-controller";
import { OperationFeedback } from "./operation-feedback";
import { runDisabledReason } from "./video-to-motion-view-helpers";
import { WorkflowStep } from "./workflow-step";

interface GenerateStepProps {
  readonly detailsRef: RefObject<HTMLDetailsElement | null>;
  readonly state: VideoToMotionControllerState;
  readonly busy: boolean;
  readonly canRun: boolean;
  readonly text: LocaleText;
  readonly onStaticCameraChange: (value: boolean) => void;
  readonly onFocalLengthChange: (value: string) => void;
  readonly onRun: () => void;
}

/** Generation parameters and feedback for only the generate operation. */
export function GenerateStep({
  detailsRef,
  state,
  busy,
  canRun,
  text,
  onStaticCameraChange,
  onFocalLengthChange,
  onRun,
}: GenerateStepProps) {
  return (
    <WorkflowStep
      id="gvhmr-step-generate"
      title={text("3. Generate", "3. 生成动作")}
      detailsRef={detailsRef}
    >
      <label className="workflow-checkbox-row">
        <input
          id="gvhmr-static-cam"
          type="checkbox"
          checked={state.staticCamera}
          disabled={busy}
          onChange={(event) =>
            onStaticCameraChange(event.currentTarget.checked)
          }
        />
        <span>{text("Static camera", "静态相机")}</span>
      </label>
      <label className="video-workflow-field">
        <span className="k">
          {text("Focal length (optional, mm)", "焦距（可选，mm）")}
        </span>
        <input
          id="gvhmr-f-mm"
          className="search"
          inputMode="numeric"
          placeholder="Auto"
          value={state.focalLength}
          disabled={busy}
          onChange={(event) =>
            onFocalLengthChange(event.currentTarget.value)
          }
        />
      </label>
      <Button
        id="gvhmr-run"
        type="button"
        className="btn"
        disabled={!canRun}
        aria-describedby="gvhmr-disabled-reason"
        onClick={onRun}
      >
        {state.operation === "generate" && busy
          ? text("Generating…", "生成中……")
          : text("Start GVHMR", "开始 GVHMR 推理")}
      </Button>
      <p
        id="gvhmr-disabled-reason"
        className="disabled-action-reason"
        role="status"
      >
        {runDisabledReason(state, busy, text)}
      </p>
      <OperationFeedback state={state} operation="generate" text={text} />
    </WorkflowStep>
  );
}
