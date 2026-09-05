import { useEffect, useMemo, useRef, useState } from "react";

import { Field, fieldClass } from "@/components/Field";
import { CalibrationEditor } from "@/components/CalibrationEditor";
import {
  normalizeCalibrationValues,
  setCalibrationJointValue,
  type CalibrationAngleUnit,
} from "@/components/calibrationEditorState";
import { InspectorPage } from "@/components/Inspector";
import { Button } from "@/components/ui/button";
import { WorkflowPipeline, WorkflowStep } from "@/components/WorkflowSteps";
import { ResultDiagnostics } from "@/features/result/ResultDiagnostics";
import { ResultExportControls } from "@/features/result/ResultExportControls";
import type { ComparisonPreset } from "@/features/result/comparison";
import {
  DEFAULT_CALIBRATION_DISPLAY,
  type CalibrationDisplayOptions,
} from "@/stage/calibrationDisplay";
import type { CalibrationInteractionModel } from "@/stage/calibrationInteraction";

import {
  getR2rCalibrationSession,
  getR2rCalibrationStatus,
  getR2rLibrary,
  getRobotLibrary,
  loadR2rLibraryEntry,
  loadRobot,
  previewR2rCalibrationPose,
  r2rExportUrl,
  runR2rRetarget,
  saveR2rCalibration,
  uploadR2rTrajectory,
  type MotionLibraryEntry,
  type RobotPayload,
  type RobotSummary,
  type R2rBackend,
  type R2rCalibrationReference,
  type R2rCalibrationSession,
  type R2rCalibrationPose,
  type R2rRetargetResult,
  type R2rSourceResult,
} from "./api";

const pipeline = [
  "Source Robot",
  "Source Trajectory",
  "Target Robot",
  "Calibration",
  "Result",
];

type BusyAction =
  | "source-robot"
  | "source-trajectory"
  | "target-robot"
  | "calibration-open"
  | "calibration-save"
  | "retarget";

export interface RobotToRobotViewProps {
  active: boolean;
  currentSourceRobot?: RobotPayload | null;
  currentTargetRobot?: RobotPayload | null;
  currentSourceResult?: R2rSourceResult | null;
  currentResult?: R2rRetargetResult | null;
  onSourceRobotLoaded?: (robot: RobotPayload | null) => void;
  onTargetRobotLoaded?: (robot: RobotPayload | null) => void;
  onSourceLoaded?: (result: R2rSourceResult | null) => void;
  onResultLoaded?: (result: R2rRetargetResult | null) => void;
  onCalibrationReference?: (reference: R2rCalibrationReference | null) => void;
  onTargetPose?: (pose: R2rCalibrationPose | null) => void;
  calibrationDisplay?: CalibrationDisplayOptions;
  onCalibrationDisplayChange?: (value: CalibrationDisplayOptions) => void;
  onCalibrationInteraction?: (
    interaction: CalibrationInteractionModel | null,
  ) => void;
  comparisonPreset?: ComparisonPreset;
  onComparisonPresetChange?: (preset: ComparisonPreset) => void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function positiveNumber(value: string): number | undefined {
  const parsed = Number(value);
  return value.trim() && Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function entryLabel(entry: MotionLibraryEntry): string {
  return entry.stem || entry.sequence_id || entry.label || entry.source_path;
}

function suggestedBackend(result?: R2rSourceResult | null): R2rBackend {
  return result?.suggested_backend === "interaction_mesh"
    ? "interaction_mesh"
    : "newton";
}

function RobotSelect({
  label,
  robots,
  value,
  loaded,
  disabled,
  onChange,
  onLoad,
}: {
  label: string;
  robots: readonly RobotSummary[];
  value: string;
  loaded: RobotPayload | null;
  disabled: boolean;
  onChange: (value: string) => void;
  onLoad: () => void;
}) {
  return (
    <div className="grid gap-2.5">
      <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
        <select
          className={fieldClass}
          aria-label={label}
          value={value}
          disabled={disabled || robots.length === 0}
          onChange={(event) => onChange(event.target.value)}
        >
          {!robots.length && <option value="">No robots available</option>}
          {robots.map((robot) => (
            <option
              key={robot.name}
              value={robot.name}
              disabled={!robot.has_urdf}
            >
              {robot.display_name} ({robot.num_dof} DoF)
            </option>
          ))}
        </select>
        <Button size="sm" disabled={disabled || !value} onClick={onLoad}>
          Load
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        {loaded ? `${loaded.display_name} loaded` : "Not loaded"}
      </p>
    </div>
  );
}

export function RobotToRobotView({
  active,
  currentSourceRobot,
  currentTargetRobot,
  currentSourceResult,
  currentResult,
  onSourceRobotLoaded,
  onTargetRobotLoaded,
  onSourceLoaded,
  onResultLoaded,
  onCalibrationReference,
  onTargetPose,
  calibrationDisplay: controlledCalibrationDisplay,
  onCalibrationDisplayChange,
  onCalibrationInteraction,
  comparisonPreset,
  onComparisonPresetChange,
}: RobotToRobotViewProps) {
  const [robots, setRobots] = useState<readonly RobotSummary[]>([]);
  const [entries, setEntries] = useState<readonly MotionLibraryEntry[]>([]);
  const [sourceChoice, setSourceChoice] = useState(currentSourceRobot?.name ?? "");
  const [targetChoice, setTargetChoice] = useState(currentTargetRobot?.name ?? "");
  const [trajectoryChoice, setTrajectoryChoice] = useState("");
  const [sourceRobot, setSourceRobot] = useState<RobotPayload | null>(
    currentSourceRobot ?? null,
  );
  const [targetRobot, setTargetRobot] = useState<RobotPayload | null>(
    currentTargetRobot ?? null,
  );
  const [sourceResult, setSourceResult] = useState<R2rSourceResult | null>(
    currentSourceResult ?? null,
  );
  const [retargetResult, setRetargetResult] =
    useState<R2rRetargetResult | null>(currentResult ?? null);
  const [sourceFps, setSourceFps] = useState("");
  const [retargetFps, setRetargetFps] = useState("");
  const [backend, setBackend] = useState<R2rBackend>(
    suggestedBackend(currentSourceResult),
  );
  const [calibrated, setCalibrated] = useState(false);
  const [checkingCalibration, setCheckingCalibration] = useState(false);
  const [calibration, setCalibration] = useState<R2rCalibrationSession | null>(null);
  const [jointQ, setJointQ] = useState<Record<string, number>>({});
  const [jointGeometry, setJointGeometry] = useState<{
    readonly jointWorld: R2rCalibrationSession["joint_world"];
    readonly groundOffsetZ: number;
  } | null>(null);
  const [angleUnit, setAngleUnit] = useState<CalibrationAngleUnit>("rad");
  const [selectedCalibrationJoint, setSelectedCalibrationJoint] =
    useState<string | null>(null);
  const [calibrationBaseline, setCalibrationBaseline] = useState<
    Record<string, number>
  >({});
  const [localCalibrationDisplay, setLocalCalibrationDisplay] = useState(
    DEFAULT_CALIBRATION_DISPLAY,
  );
  const calibrationDisplay =
    controlledCalibrationDisplay ?? localCalibrationDisplay;
  const publishCalibrationDisplay =
    onCalibrationDisplayChange ?? setLocalCalibrationDisplay;
  const [calibrationPath, setCalibrationPath] = useState<string | null>(null);
  const [busy, setBusy] = useState<BusyAction | null>(null);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const folderInput = useRef<HTMLInputElement | null>(null);
  const actionRequest = useRef<AbortController | null>(null);
  const calibrationStatusRequest = useRef<AbortController | null>(null);
  const poseCallback = useRef(onTargetPose);
  const referenceCallback = useRef(onCalibrationReference);
  const interactionCallback = useRef(onCalibrationInteraction);
  const poseWasActive = useRef(false);
  poseCallback.current = onTargetPose;
  referenceCallback.current = onCalibrationReference;
  interactionCallback.current = onCalibrationInteraction;

  useEffect(
    () => () => {
      actionRequest.current?.abort();
      calibrationStatusRequest.current?.abort();
    },
    [],
  );

  // This view stays mounted to preserve jobs, so refresh its catalogs on entry.
  useEffect(() => {
    if (!active) return;
    const request = new AbortController();
    void getRobotLibrary({ signal: request.signal })
      .then((catalog) => {
        if (request.signal.aborted) return;
        setRobots(catalog.robots);
        const available = catalog.robots.filter((robot) => robot.has_urdf);
        const first = available[0]?.name ?? "";
        setSourceChoice((current) => current || first);
        setTargetChoice((current) => current || available[1]?.name || first);
      })
      .catch((reason: unknown) => {
        if (!request.signal.aborted) setError(errorMessage(reason));
      });
    void getR2rLibrary({ signal: request.signal })
      .then((libraryEntries) => {
        if (request.signal.aborted) return;
        setEntries(libraryEntries);
        setTrajectoryChoice((current) => current || libraryEntries[0]?.source_path || "");
      })
      .catch((reason: unknown) => {
        if (!request.signal.aborted) setError(errorMessage(reason));
      });
    return () => request.abort();
  }, [active]);

  useEffect(() => {
    folderInput.current?.setAttribute("webkitdirectory", "");
  }, []);

  useEffect(() => {
    calibrationStatusRequest.current?.abort();
    if (currentSourceRobot === undefined) return;
    setSourceRobot(currentSourceRobot);
    setSourceChoice(currentSourceRobot?.name ?? "");
  }, [currentSourceRobot]);

  useEffect(() => {
    if (currentTargetRobot === undefined) return;
    setTargetRobot(currentTargetRobot);
    setTargetChoice(currentTargetRobot?.name ?? "");
  }, [currentTargetRobot]);

  useEffect(() => {
    if (currentSourceResult === undefined) return;
    setSourceResult(currentSourceResult);
    setBackend(suggestedBackend(currentSourceResult));
  }, [currentSourceResult]);

  useEffect(() => {
    if (currentResult !== undefined) setRetargetResult(currentResult);
  }, [currentResult]);

  // Calibration is stored for one exact source/target pair. Recheck it whenever
  // either loaded robot changes instead of trusting stale UI state.
  useEffect(() => {
    setCalibration(null);
    referenceCallback.current?.(null);
    setJointQ({});
    setJointGeometry(null);
    setSelectedCalibrationJoint(null);
    setCalibrationBaseline({});
    setCalibrationPath(null);
    setCalibrated(false);
    setCheckingCalibration(false);
    if (!sourceRobot || !targetRobot) return;
    const request = new AbortController();
    calibrationStatusRequest.current = request;
    setCheckingCalibration(true);
    void getR2rCalibrationStatus(targetRobot.name, sourceRobot.name, {
      signal: request.signal,
    })
      .then((response) => {
        if (!request.signal.aborted) setCalibrated(Boolean(response.calibrated));
      })
      .catch((reason: unknown) => {
        if (!request.signal.aborted) setError(errorMessage(reason));
      })
      .finally(() => {
        if (!request.signal.aborted) setCheckingCalibration(false);
      });
    return () => request.abort();
  }, [sourceRobot, targetRobot]);

  useEffect(() => {
    if (!calibration || !targetRobot) {
      if (poseWasActive.current) {
        poseWasActive.current = false;
        poseCallback.current?.(null);
      }
      return;
    }
    poseWasActive.current = true;
    const request = new AbortController();
    const timer = window.setTimeout(() => {
      void previewR2rCalibrationPose(targetRobot.name, jointQ, {
        signal: request.signal,
      })
        .then((pose) => {
          if (!request.signal.aborted) {
            setJointGeometry({
              jointWorld: pose.joint_world,
              groundOffsetZ: pose.ground_offset_z,
            });
            poseCallback.current?.(pose);
          }
        })
        .catch((reason: unknown) => {
          if (!request.signal.aborted) setError(errorMessage(reason));
        });
    }, 120);
    return () => {
      window.clearTimeout(timer);
      request.abort();
    };
  }, [calibration, jointQ, targetRobot]);

  useEffect(
    () => () => {
      if (poseWasActive.current) poseCallback.current?.(null);
      referenceCallback.current?.(null);
      interactionCallback.current?.(null);
    },
    [],
  );

  useEffect(() => {
    if (!calibration || !jointGeometry) {
      interactionCallback.current?.(null);
      return;
    }
    interactionCallback.current?.({
      jointQ,
      jointLimits: calibration.joint_limits,
      jointWorld: jointGeometry.jointWorld,
      groundOffsetZ: jointGeometry.groundOffsetZ,
      angleUnit,
      selectedJoint: selectedCalibrationJoint,
      disabled: busy !== null,
      onJointChange: (name, value) => {
        setJointQ((current) =>
          setCalibrationJointValue(
            calibration.joint_limits,
            current,
            name,
            value,
          ),
        );
      },
      onSelectedJointChange: setSelectedCalibrationJoint,
      onAngleUnitChange: setAngleUnit,
    });
  }, [
    angleUnit,
    busy,
    calibration,
    jointGeometry,
    jointQ,
    selectedCalibrationJoint,
  ]);

  const selectedEntry = useMemo(
    () => entries.find((entry) => entry.source_path === trajectoryChoice) ?? null,
    [entries, trajectoryChoice],
  );
  const activeStep = calibration
    ? 3
    : retargetResult || calibrated
      ? 4
      : targetRobot
        ? 3
        : sourceResult
          ? 2
          : sourceRobot
            ? 1
            : 0;
  const blockedReason = (() => {
    if (!sourceRobot) return "Load the source robot first.";
    if (!sourceResult) return "Load a source trajectory first.";
    if (!targetRobot) return "Load the target robot first.";
    if (calibration) return "Save the open calibration before retargeting.";
    if (checkingCalibration) return "Checking calibration…";
    if (!calibrated) return "Save calibration for this robot pair first.";
    return null;
  })();

  function beginAction(action: BusyAction): AbortController {
    actionRequest.current?.abort();
    const request = new AbortController();
    actionRequest.current = request;
    setBusy(action);
    setProgress(0);
    setError(null);
    return request;
  }

  function finishAction(request: AbortController): void {
    if (actionRequest.current !== request) return;
    actionRequest.current = null;
    setBusy(null);
  }

  function clearRetargetResult(): void {
    setRetargetResult(null);
    onResultLoaded?.(null);
  }

  async function loadSourceRobot(): Promise<void> {
    if (!sourceChoice || calibration) return;
    const request = beginAction("source-robot");
    setStatus(`Loading source robot ${sourceChoice}…`);
    try {
      const payload = await loadRobot(sourceChoice, { signal: request.signal });
      if (request.signal.aborted) return;
      setSourceRobot(payload);
      setSourceResult(null);
      onSourceRobotLoaded?.(payload);
      onSourceLoaded?.(null);
      clearRetargetResult();
      setStatus(`Source robot loaded: ${payload.display_name}`);
    } catch (reason) {
      if (!request.signal.aborted) setError(errorMessage(reason));
    } finally {
      finishAction(request);
    }
  }

  async function loadTargetRobot(): Promise<void> {
    if (!targetChoice || calibration) return;
    const request = beginAction("target-robot");
    setStatus(`Loading target robot ${targetChoice}…`);
    try {
      const payload = await loadRobot(targetChoice, { signal: request.signal });
      if (request.signal.aborted) return;
      setTargetRobot(payload);
      onTargetRobotLoaded?.(payload);
      clearRetargetResult();
      setStatus(`Target robot loaded: ${payload.display_name}`);
    } catch (reason) {
      if (!request.signal.aborted) setError(errorMessage(reason));
    } finally {
      finishAction(request);
    }
  }

  async function receiveSourceResult(
    load: (request: AbortController) => Promise<R2rSourceResult>,
  ): Promise<void> {
    if (!sourceRobot || calibration) return;
    const request = beginAction("source-trajectory");
    setStatus("Loading source trajectory…");
    try {
      const result = await load(request);
      if (request.signal.aborted) return;
      clearRetargetResult();
      setSourceResult(result);
      onSourceLoaded?.(result);
      if (result.suggested_backend === "interaction_mesh") {
        setBackend("interaction_mesh");
      } else if (result.suggested_backend === "newton") {
        setBackend("newton");
      }
      setProgress(1);
      setStatus(`Trajectory loaded: ${result.num_frames} frames @ ${result.framerate.toFixed(1)} fps`);
    } catch (reason) {
      if (!request.signal.aborted) setError(errorMessage(reason));
    } finally {
      finishAction(request);
    }
  }

  function loadLibraryTrajectory(): void {
    if (!sourceRobot || !selectedEntry) return;
    void receiveSourceResult((request) =>
      loadR2rLibraryEntry(
        selectedEntry,
        sourceRobot.name,
        positiveNumber(sourceFps),
        {
          signal: request.signal,
          onUpdate: (job) => {
            if (!request.signal.aborted) {
              setProgress(job.progress ?? 0);
              setStatus(job.message || "Loading source trajectory…");
            }
          },
        },
      ),
    );
  }

  function uploadTrajectory(files: FileList | null): void {
    const selectedFiles = files ? Array.from(files) : [];
    if (!sourceRobot || !selectedFiles.length) return;
    void receiveSourceResult((request) =>
      uploadR2rTrajectory(
        selectedFiles,
        sourceRobot.name,
        positiveNumber(sourceFps),
        {
          signal: request.signal,
          onUpdate: (job) => {
            if (!request.signal.aborted) {
              setProgress(job.progress ?? 0);
              setStatus(job.message || "Processing source trajectory…");
            }
          },
        },
      ),
    );
  }

  async function openCalibration(): Promise<void> {
    if (!sourceRobot || !targetRobot || calibration) return;
    const request = beginAction("calibration-open");
    setStatus("Loading calibration…");
    try {
      const session = await getR2rCalibrationSession(
        targetRobot.name,
        sourceRobot.name,
        { signal: request.signal },
      );
      if (request.signal.aborted) return;
      const initial = normalizeCalibrationValues(
        session.joint_limits,
        session.joint_q,
      );
      setCalibration(session);
      setJointQ(initial);
      setJointGeometry({
        jointWorld: session.joint_world,
        groundOffsetZ: session.ground_offset_z,
      });
      setCalibrationBaseline(initial);
      clearRetargetResult();
      referenceCallback.current?.(session.reference);
      setStatus(`Calibration ready: ${session.reference_name}`);
    } catch (reason) {
      if (!request.signal.aborted) setError(errorMessage(reason));
    } finally {
      finishAction(request);
    }
  }

  async function saveCalibration(): Promise<void> {
    if (!sourceRobot || !targetRobot || !calibration) return;
    calibrationStatusRequest.current?.abort();
    setCheckingCalibration(false);
    const request = beginAction("calibration-save");
    setStatus("Saving calibration…");
    try {
      const safeJointQ = normalizeCalibrationValues(
        calibration.joint_limits,
        jointQ,
      );
      const response = await saveR2rCalibration(
        targetRobot.name,
        sourceRobot.name,
        safeJointQ,
        { signal: request.signal },
      );
      if (request.signal.aborted) return;
      setCalibrationPath(response.path);
      setCalibrated(true);
      closeCalibration();
      clearRetargetResult();
      setStatus("Calibration saved.");
    } catch (reason) {
      if (!request.signal.aborted) setError(errorMessage(reason));
    } finally {
      finishAction(request);
    }
  }

  function closeCalibration(cancelled = false): void {
    setCalibration(null);
    setJointQ({});
    setJointGeometry(null);
    setSelectedCalibrationJoint(null);
    setCalibrationBaseline({});
    referenceCallback.current?.(null);
    poseCallback.current?.(null);
    poseWasActive.current = false;
    if (cancelled) setStatus("Calibration cancelled.");
  }

  async function retarget(): Promise<void> {
    if (!sourceRobot || !targetRobot || !sourceResult || !calibrated || calibration) return;
    const request = beginAction("retarget");
    clearRetargetResult();
    setStatus("Retargeting… The first run for a robot can take longer.");
    try {
      const result = await runR2rRetarget(
        {
          source: sourceRobot.name,
          target: targetRobot.name,
          sourceToken: sourceResult.token,
          backend,
          retargetFps: positiveNumber(retargetFps),
        },
        {
          signal: request.signal,
          onUpdate: (job) => {
            if (!request.signal.aborted) {
              setProgress(job.progress ?? 0);
              setStatus(job.message || "Retargeting…");
            }
          },
        },
      );
      if (request.signal.aborted) return;
      setRetargetResult(result);
      onResultLoaded?.(result);
      setProgress(1);
      setStatus(`Completed: ${result.num_frames} frames @ ${result.source_fps.toFixed(1)} fps`);
    } catch (reason) {
      if (!request.signal.aborted) setError(errorMessage(reason));
    } finally {
      finishAction(request);
    }
  }

  return (
    <InspectorPage title="Robot → Robot">
      <WorkflowPipeline
        label="Robot to Robot pipeline"
        steps={pipeline}
        activeIndex={activeStep}
      />
      <div className="flex shrink-0 flex-col">
        <WorkflowStep title="1. Source robot" status={sourceRobot?.display_name || "Not loaded"} defaultOpen>
          <RobotSelect
            label="Select source robot"
            robots={robots}
            value={sourceChoice}
            loaded={sourceRobot}
            disabled={busy !== null || calibration !== null}
            onChange={setSourceChoice}
            onLoad={() => void loadSourceRobot()}
          />
        </WorkflowStep>

        <WorkflowStep title="2. Source trajectory" status={sourceResult?.name || "Not loaded"}>
          <div className="grid gap-2.5">
            <Field label="Robot trajectory library">
              <select
                className={fieldClass}
                value={trajectoryChoice}
                disabled={!sourceRobot || busy !== null || calibration !== null || entries.length === 0}
                onChange={(event) => setTrajectoryChoice(event.target.value)}
              >
                {!entries.length && <option value="">No robot trajectories available</option>}
                {entries.map((entry) => (
                  <option key={entry.source_path} value={entry.source_path}>
                    {entryLabel(entry)}
                  </option>
                ))}
              </select>
            </Field>
            <div className="grid grid-cols-3 gap-2">
              <Button size="sm" disabled={!sourceRobot || !selectedEntry || busy !== null || calibration !== null} onClick={loadLibraryTrajectory}>
                Load from library
              </Button>
              <Button size="sm" disabled={!sourceRobot || busy !== null || calibration !== null} onClick={() => fileInput.current?.click()}>
                Upload files
              </Button>
              <Button
                size="sm"
                disabled={!sourceRobot || busy !== null || calibration !== null}
                onClick={() => folderInput.current?.click()}
              >
                Upload folder
              </Button>
              <input
                ref={fileInput}
                className="hidden"
                type="file"
                multiple
                accept=".csv,.pkl,.npz"
                onChange={(event) => {
                  uploadTrajectory(event.currentTarget.files);
                  event.currentTarget.value = "";
                }}
              />
              <input
                ref={folderInput}
                className="hidden"
                type="file"
                multiple
                onChange={(event) => {
                  uploadTrajectory(event.currentTarget.files);
                  event.currentTarget.value = "";
                }}
              />
            </div>
            <Field label="Source trajectory FPS">
              <input
                className={fieldClass}
                inputMode="decimal"
                placeholder="Use trajectory FPS"
                value={sourceFps}
                disabled={!sourceRobot || busy !== null || calibration !== null}
                onChange={(event) => setSourceFps(event.target.value)}
              />
            </Field>
          </div>
        </WorkflowStep>

        <WorkflowStep title="3. Target robot" status={targetRobot?.display_name || "Not loaded"}>
          <RobotSelect
            label="Select target robot"
            robots={robots}
            value={targetChoice}
            loaded={targetRobot}
            disabled={busy !== null || calibration !== null}
            onChange={setTargetChoice}
            onLoad={() => void loadTargetRobot()}
          />
        </WorkflowStep>

        <WorkflowStep
          title="4. Calibration"
          status={
            calibration
              ? busy === "calibration-save"
                ? "Saving…"
                : "Editing…"
              : checkingCalibration
                ? "Checking…"
                : calibrated
                  ? "Ready"
                  : "Required"
          }
        >
          <div className="grid gap-2.5">
            <div className="flex items-center justify-between gap-3">
              <span className="min-w-0 truncate text-xs text-muted-foreground">
                {sourceRobot && targetRobot
                  ? `${sourceRobot.display_name} → ${targetRobot.display_name}`
                  : "Load both robots first"}
              </span>
              <Button
                size="sm"
                disabled={
                  !sourceRobot ||
                  !targetRobot ||
                  checkingCalibration ||
                  busy !== null ||
                  calibration !== null
                }
                onClick={() => void openCalibration()}
              >
                {calibration ? "Editing…" : calibrated ? "Edit" : "Calibrate"}
              </Button>
            </div>
            {calibration && (
              <CalibrationEditor
                limits={calibration.joint_limits}
                value={jointQ}
                baseline={calibrationBaseline}
                hasSavedBaseline={Boolean(calibration.has_saved_calibration)}
                reference={calibration.reference}
                robot={targetRobot!}
                display={calibrationDisplay}
                angleUnit={angleUnit}
                selectedJoint={selectedCalibrationJoint}
                disabled={busy !== null}
                saving={busy === "calibration-save"}
                onChange={setJointQ}
                onDisplayChange={publishCalibrationDisplay}
                onAngleUnitChange={setAngleUnit}
                onJointSelected={setSelectedCalibrationJoint}
                onCancel={() => closeCalibration(true)}
                onSave={() => void saveCalibration()}
              />
            )}
            {calibrationPath && (
              <p className="truncate text-[11px] text-muted-foreground" title={calibrationPath}>
                Saved to {calibrationPath}
              </p>
            )}
          </div>
        </WorkflowStep>

        <WorkflowStep
          title="5. Result"
          status={retargetResult ? "Completed" : busy === "retarget" ? "Running" : "Not ready"}
        >
          <div className="grid gap-2.5">
            <div className="grid grid-cols-2 gap-2">
              <Field label="Solver">
                <select
                  className={fieldClass}
                  value={backend}
                  disabled={busy !== null || calibration !== null}
                  onChange={(event) => {
                    const value = event.target.value as R2rBackend;
                    setBackend(value);
                    clearRetargetResult();
                  }}
                >
                  <option value="newton">Newton IK</option>
                  <option value="interaction_mesh">Interaction Mesh</option>
                </select>
              </Field>
              <Field label="Retarget FPS">
                <input
                  className={fieldClass}
                  inputMode="decimal"
                  placeholder="Trajectory FPS"
                  value={retargetFps}
                  disabled={busy !== null || calibration !== null}
                  onChange={(event) => {
                    setRetargetFps(event.target.value);
                    clearRetargetResult();
                  }}
                />
              </Field>
            </div>
            <Button variant="primary" size="sm" disabled={Boolean(blockedReason) || busy !== null} onClick={() => void retarget()}>
              {busy === "retarget" ? "Retargeting…" : "Start Retarget"}
            </Button>
            {blockedReason && <p className="text-xs leading-[1.4] text-muted-foreground">{blockedReason}</p>}
            {busy && progress > 0 && (
              <div
                className="h-1.5 overflow-hidden rounded-full bg-border-subtle"
                role="progressbar"
                aria-valuenow={Math.round(progress * 100)}
                aria-valuemin={0}
                aria-valuemax={100}
              >
                <div className="h-full bg-primary transition-[width]" style={{ width: `${Math.max(2, progress * 100)}%` }} />
              </div>
            )}
            <p className="min-h-4 text-xs text-muted-foreground" aria-live="polite">{status}</p>
            {error && (
              <p
                className="rounded-md border border-[#efcccc] bg-[#fff5f4] px-2.5 py-2 text-[11px] leading-relaxed break-words text-[#8c2929]"
                role="alert"
              >
                {error}
              </p>
            )}
            {retargetResult && (
              <>
                <ResultDiagnostics
                  diagnostics={retargetResult.diagnostics}
                  preset={comparisonPreset}
                  onPresetChange={onComparisonPresetChange}
                />
                <ResultExportControls
                  key={retargetResult.export_token}
                  token={retargetResult.export_token}
                  resultFps={retargetResult.source_fps}
                  hasScene={retargetResult.has_scene}
                  buildUrl={r2rExportUrl}
                />
              </>
            )}
          </div>
        </WorkflowStep>
      </div>
    </InspectorPage>
  );
}
