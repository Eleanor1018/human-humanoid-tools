import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
} from "react";

import type { ICommandService } from "@/platform/commands/common/command-service";
import { WorkbenchCommandIds } from "@/workbench/common/command-ids";
import type { WorkbenchPanelProps } from "@/workbench/common/panel-contribution";
import { useLocaleText } from "@/workbench/services/localization/browser/use-locale-text";
import { EnvironmentStep } from "./components/environment-step";
import { GenerateStep } from "./components/generate-step";
import { MotionResultStep } from "./components/motion-result-step";
import { VideoSelectionStep } from "./components/video-selection-step";
import {
  isAbortError,
  isInputError,
  localizeKnownError,
} from "./components/video-to-motion-view-helpers";
import type { VideoToMotionControllerModel } from "./use-video-to-motion-controller";
import {
  VideoToMotionPipelineView,
  type VideoToMotionStep,
} from "./video-to-motion-pipeline-view";

const VIDEO_ACCEPT =
  "video/mp4,video/quicktime,video/x-matroska,video/x-msvideo,video/webm,.m4v";

interface VideoToMotionViewProps extends WorkbenchPanelProps {
  readonly model: VideoToMotionControllerModel;
  readonly commandService: Pick<ICommandService, "registerCommand">;
}

function filesFromInput(event: ChangeEvent<HTMLInputElement>): File[] {
  const files = Array.from(event.currentTarget.files ?? []);
  // Clearing permits the user to choose the same file again after a failure.
  event.currentTarget.value = "";
  return files;
}

/**
 * React-owned V2M orchestrator. Step components render controls while this view
 * owns file refs, command lifetime, model actions, and cross-step navigation.
 */
export function VideoToMotionView({
  locale,
  requestPanel,
  model,
  commandService,
}: VideoToMotionViewProps) {
  const text = useLocaleText(locale);
  const videoInputRef = useRef<HTMLInputElement>(null);
  const checkpointInputRef = useRef<HTMLInputElement>(null);
  const resultInputRef = useRef<HTMLInputElement>(null);
  const videoStepRef = useRef<HTMLDetailsElement>(null);
  const environmentStepRef = useRef<HTMLDetailsElement>(null);
  const generateStepRef = useRef<HTMLDetailsElement>(null);
  const resultStepRef = useRef<HTMLDetailsElement>(null);
  const [viewError, setViewError] = useState<string | null>(null);

  const openVideoPicker = useCallback(() => {
    videoInputRef.current?.click();
  }, []);

  useEffect(() => {
    // The command follows the hidden input lifetime and cannot retain a stale
    // renderer node after this feature unmounts.
    const registration = commandService.registerCommand(
      WorkbenchCommandIds.pickVideoToMotionSource,
      openVideoPicker,
    );
    return () => registration.dispose();
  }, [commandService, openVideoPicker]);

  const state = model.state;
  const showError = useCallback(
    (error: unknown) => {
      if (!isAbortError(error)) setViewError(localizeKnownError(error, locale));
    },
    [locale],
  );
  const observeOperationFailure = useCallback(
    (error: unknown) => {
      // Transport and presentation failures are already projected by the
      // controller's failed state. Only preflight failures need view state.
      if (isInputError(error)) showError(error);
    },
    [showError],
  );

  const selectVideoFiles = useCallback(
    (files: readonly File[]) => {
      if (files.length === 0) return;
      if (files.length !== 1) {
        setViewError(
          text(
            "Select one video at a time.",
            "GVHMR 每次只处理一个视频。",
          ),
        );
        return;
      }
      try {
        model.selectVideo(files[0]);
        setViewError(null);
      } catch (error) {
        showError(error);
      }
    },
    [model.selectVideo, showError, text],
  );

  const selectCheckpointFiles = useCallback(
    (files: readonly File[]) => {
      if (files.length === 0) return;
      if (files.length !== 1) {
        setViewError(
          text(
            "Select one checkpoint at a time.",
            "每次只能选择一个权重文件。",
          ),
        );
        return;
      }
      try {
        model.selectCheckpoint(files[0]);
        setViewError(null);
      } catch (error) {
        showError(error);
      }
    },
    [model.selectCheckpoint, showError, text],
  );

  const importResultFiles = useCallback(
    (files: readonly File[]) => {
      if (files.length === 0) return;
      if (files.length !== 1) {
        setViewError(
          text(
            "Select one GVHMR result at a time.",
            "每次只能选择一个 GVHMR 结果。",
          ),
        );
        return;
      }
      setViewError(null);
      // Every event-started promise is observed; unmount cancellation is an
      // expected AbortError rather than an unhandled renderer rejection.
      void model.importResult(files[0]).catch(observeOperationFailure);
    },
    [model.importResult, observeOperationFailure, text],
  );

  const invokeModelAction = useCallback(
    (action: () => void) => {
      setViewError(null);
      try {
        action();
      } catch (error) {
        showError(error);
      }
    },
    [showError],
  );

  const retryRuntime = useCallback(() => {
    setViewError(null);
    void model.refreshRuntime().catch(showError);
  }, [model.refreshRuntime, showError]);

  const run = useCallback(() => {
    setViewError(null);
    void model.run().catch(observeOperationFailure);
  }, [model.run, observeOperationFailure]);

  const activateStep = useCallback((step: VideoToMotionStep) => {
    const target = {
      video: videoStepRef,
      environment: environmentStepRef,
      generate: generateStepRef,
      result: resultStepRef,
    }[step].current;
    if (!target) return;
    target.open = true;
    target.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
  }, []);

  return (
    <div className="panel-stack video-to-motion-stack">
      <h2>{text("Video → Motion", "视频 → 动作")}</h2>
      <input
        ref={videoInputRef}
        type="file"
        accept={VIDEO_ACCEPT}
        aria-label={text("Select a video file", "选择视频文件")}
        hidden
        disabled={model.busy}
        onChange={(event) => selectVideoFiles(filesFromInput(event))}
      />
      {!state ? (
        <p className="workflow-status-line" role="status">
          {text("Initializing video workflow…", "正在初始化视频流程……")}
        </p>
      ) : (
        <>
          <VideoToMotionPipelineView
            locale={locale}
            state={state}
            canRun={model.canRun}
            canConfirmEnvironment={model.canConfirmEnvironment}
            onActivateStep={activateStep}
          />
          {viewError ? (
            <p
              id="gvhmr-view-error"
              className="hint video-operation-status error"
              role="alert"
            >
              {viewError}
            </p>
          ) : null}

          <VideoSelectionStep
            detailsRef={videoStepRef}
            state={state}
            busy={model.busy}
            text={text}
            onOpenPicker={openVideoPicker}
            onSelectFiles={selectVideoFiles}
            onPreviewDuration={model.setPreviewDuration}
          />

          <EnvironmentStep
            detailsRef={environmentStepRef}
            checkpointInputRef={checkpointInputRef}
            state={state}
            busy={model.busy}
            canConfirmEnvironment={model.canConfirmEnvironment}
            text={text}
            onRetryRuntime={retryRuntime}
            onWeightSourceChange={(source) =>
              invokeModelAction(() => model.setWeightSource(source))
            }
            onConfirmEnvironment={() =>
              invokeModelAction(() => model.confirmEnvironment())
            }
            onCheckpointInputChange={(event) =>
              selectCheckpointFiles(filesFromInput(event))
            }
          />

          <GenerateStep
            detailsRef={generateStepRef}
            state={state}
            busy={model.busy}
            canRun={model.canRun}
            text={text}
            onStaticCameraChange={(value) =>
              invokeModelAction(() => model.setStaticCamera(value))
            }
            onFocalLengthChange={(value) =>
              invokeModelAction(() => model.setFocalLength(value))
            }
            onRun={run}
          />

          <MotionResultStep
            detailsRef={resultStepRef}
            resultInputRef={resultInputRef}
            state={state}
            busy={model.busy}
            text={text}
            onResultInputChange={(event) =>
              importResultFiles(filesFromInput(event))
            }
            onOpenMotionLibrary={() => requestPanel("motion")}
          />
        </>
      )}
    </div>
  );
}
