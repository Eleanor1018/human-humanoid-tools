import type { LocaleText } from "@/workbench/services/localization/browser/use-locale-text";
import type {
  VideoToMotionControllerState,
  VideoToMotionOperation,
} from "../video-to-motion-controller";
import { operationMessage } from "./video-to-motion-view-helpers";

interface OperationFeedbackProps {
  readonly state: VideoToMotionControllerState;
  readonly operation: VideoToMotionOperation;
  readonly text: LocaleText;
}

/**
 * Render feedback beside the operation that owns it. Only one instance enters
 * the DOM, preserving the legacy progress/status ids for CSS and accessibility.
 */
export function OperationFeedback({
  state,
  operation,
  text,
}: OperationFeedbackProps) {
  // Before either operation starts, keep the historical empty status anchor in
  // Generate. Once an operation is known, feedback lives only in its own step.
  if (
    state.operation !== operation &&
    !(state.operation === null && operation === "generate")
  ) {
    return null;
  }

  return (
    <>
      {state.stage !== "idle" ? (
        <div
          id="gvhmr-progress"
          className="progress video-workflow-progress"
          role="progressbar"
          aria-label={text("Video workflow progress", "视频流程进度")}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(state.progress * 100)}
        >
          <div
            className="bar"
            style={{ width: `${Math.round(state.progress * 100)}%` }}
          />
        </div>
      ) : null}
      {state.stage === "failed" ? (
        <p
          id="gvhmr-status"
          className="hint video-operation-status error"
          role="alert"
        >
          {operationMessage(state, text)}
        </p>
      ) : (
        <p
          id="gvhmr-status"
          className="hint video-operation-status"
          role="status"
        >
          {operationMessage(state, text)}
        </p>
      )}
    </>
  );
}
