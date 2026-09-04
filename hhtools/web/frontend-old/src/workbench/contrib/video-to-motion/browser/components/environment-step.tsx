import type { ChangeEventHandler, RefObject } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { LocaleText } from "@/workbench/services/localization/browser/use-locale-text";
import type { GvhmrWeightSource } from "../../common/video-to-motion-state";
import type { VideoToMotionControllerState } from "../video-to-motion-controller";
import { runtimeMessage } from "./video-to-motion-view-helpers";
import { WorkflowStep } from "./workflow-step";

interface EnvironmentStepProps {
  readonly detailsRef: RefObject<HTMLDetailsElement | null>;
  readonly checkpointInputRef: RefObject<HTMLInputElement | null>;
  readonly state: VideoToMotionControllerState;
  readonly busy: boolean;
  readonly canConfirmEnvironment: boolean;
  readonly text: LocaleText;
  readonly onRetryRuntime: () => void;
  readonly onWeightSourceChange: (source: GvhmrWeightSource) => void;
  readonly onConfirmEnvironment: () => void;
  readonly onCheckpointInputChange: ChangeEventHandler<HTMLInputElement>;
}

/** Runtime discovery, weight source, and explicit environment confirmation. */
export function EnvironmentStep({
  detailsRef,
  checkpointInputRef,
  state,
  busy,
  canConfirmEnvironment,
  text,
  onRetryRuntime,
  onWeightSourceChange,
  onConfirmEnvironment,
  onCheckpointInputChange,
}: EnvironmentStepProps) {
  return (
    <WorkflowStep
      id="gvhmr-step-environment"
      title={text("2. Select environment", "2. 选择环境")}
      detailsRef={detailsRef}
    >
      <p
        id="gvhmr-runtime-status"
        className={cn(
          "workflow-status-line video-runtime-status",
          state.runtimePhase === "unavailable" && "error",
        )}
        role="status"
        title={
          state.runtime?.missing.join("\n") || state.runtimeError || ""
        }
      >
        {runtimeMessage(state, text)}
      </p>
      {state.runtimePhase === "unavailable" ? (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="btn secondary small"
          disabled={busy}
          onClick={onRetryRuntime}
        >
          {text("Retry check", "重新检查")}
        </Button>
      ) : null}
      <div className="video-environment-control">
        <label className="video-workflow-field">
          <span className="k">
            {text("Runtime environment", "运行环境")}
          </span>
          <select
            id="gvhmr-weight-source"
            className="search"
            value={state.weightSource}
            disabled={busy}
            onChange={(event) =>
              onWeightSourceChange(
                event.currentTarget.value === "custom"
                  ? "custom"
                  : "official",
              )
            }
          >
            <option value="official">
              {text("Official GVHMR", "GVHMR 官方环境")}
            </option>
            <option value="custom">
              {text(
                "Custom checkpoint (best effort)",
                "自定义 checkpoint（不保证兼容）",
              )}
            </option>
          </select>
        </label>
        <Button
          id="gvhmr-confirm-environment"
          type="button"
          variant="secondary"
          size="sm"
          className="btn secondary small"
          disabled={!canConfirmEnvironment}
          onClick={onConfirmEnvironment}
        >
          {state.environmentConfirmed
            ? text("Confirmed", "已确认")
            : text("Confirm", "确认环境")}
        </Button>
      </div>
      {state.weightSource === "custom" ? (
        <div id="gvhmr-custom-checkpoint" className="video-custom-checkpoint">
          <input
            ref={checkpointInputRef}
            type="file"
            aria-label={text(
              "Select a custom checkpoint",
              "选择自定义 checkpoint",
            )}
            hidden
            disabled={busy}
            onChange={onCheckpointInputChange}
          />
          <div className="video-checkpoint-control">
            <Button
              id="gvhmr-pick-checkpoint"
              type="button"
              variant="secondary"
              size="sm"
              className="btn secondary small"
              disabled={busy}
              onClick={() => checkpointInputRef.current?.click()}
            >
              {text("Choose checkpoint", "选择 checkpoint")}
            </Button>
            <span
              id="gvhmr-checkpoint-name"
              className="video-checkpoint-name"
            >
              {state.checkpointName ??
                text("No checkpoint selected", "尚未选择 checkpoint")}
            </span>
          </div>
          <p className="hint video-checkpoint-hint">
            {text(
              "Custom checkpoints are passed through as selected. Compatibility is not guaranteed.",
              "自定义 checkpoint 会按所选文件直接传入，不保证兼容性。",
            )}
          </p>
        </div>
      ) : null}
    </WorkflowStep>
  );
}
