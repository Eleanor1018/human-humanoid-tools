import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { Field, fieldClass } from "@/components/Field";
import { InspectorPage } from "@/components/Inspector";
import { Button } from "@/components/ui/button";
import { WorkflowPipeline, WorkflowStep } from "@/components/WorkflowSteps";
import {
  getMotionLibrary,
  loadMotionLibraryEntry,
  type MotionLibraryEntry,
  type MotionPayload,
} from "@/features/motion/api";
import {
  getRobotLibrary,
  loadRobot,
  type RobotPayload,
  type RobotSummary,
} from "@/features/robot/api";
import type { StageMotionPayload } from "@/stage/types";

import {
  getCalibrationReferences,
  getCalibrationStatus,
  previewCalibrationPose,
  retarget,
  retargetExportUrl,
  saveCalibration,
  startCalibrationSession,
  type CalibrationSession,
  type CalibrationPose,
  type CalibrationStatus,
  type RetargetResult,
} from "./api";

const pipeline = ["Motion", "Robot", "Calibration", "Result"];
type Action = "motion" | "robot" | "calibration" | "save" | "retarget";
type Backend = "newton" | "interaction_mesh";

export interface HumanToRobotViewProps {
  readonly currentMotion?: StageMotionPayload | null;
  readonly currentRobot?: RobotPayload | null;
  readonly currentResult?: RetargetResult | null;
  readonly onMotionLoaded?: (motion: MotionPayload) => void;
  readonly onRobotLoaded?: (robot: RobotPayload) => void;
  readonly onRetargetResult?: (result: RetargetResult | null) => void;
  readonly onCalibrationReference?: (reference: StageMotionPayload | null) => void;
  readonly onRobotPose?: (pose: CalibrationPose | null) => void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function motionLabel(entry: MotionLibraryEntry): string {
  const name =
    entry.stem || entry.sequence_id || entry.label || entry.source_path;
  return entry.folder_label ? `${entry.folder_label} / ${name}` : name;
}

function positiveNumber(value: string): number | undefined {
  const parsed = Number(value);
  return value.trim() && Number.isFinite(parsed) && parsed > 0
    ? parsed
    : undefined;
}

function Picker({
  label,
  value,
  disabled,
  buttonLabel,
  onChange,
  onLoad,
  children,
}: {
  label: string;
  value: string;
  disabled: boolean;
  buttonLabel: string;
  onChange(value: string): void;
  onLoad(): void;
  children: ReactNode;
}) {
  return (
    <div className="grid gap-2">
      <select
        className={fieldClass}
        aria-label={label}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.value)}
      >
        {children}
      </select>
      <Button size="sm" disabled={disabled || !value} onClick={onLoad}>
        {buttonLabel}
      </Button>
    </div>
  );
}

/**
 * React owns this four-step transaction; FastAPI owns heavy motion/robot data.
 * The optional props make the same view work with App-owned or local inputs.
 */
export function HumanToRobotView({
  currentMotion,
  currentRobot,
  currentResult,
  onMotionLoaded,
  onRobotLoaded,
  onRetargetResult,
  onCalibrationReference,
  onRobotPose,
}: HumanToRobotViewProps) {
  const [motionEntries, setMotionEntries] = useState<
    readonly MotionLibraryEntry[]
  >([]);
  const [robotEntries, setRobotEntries] = useState<readonly RobotSummary[]>([]);
  const [references, setReferences] = useState<readonly string[]>([]);
  const [localMotion, setLocalMotion] = useState<StageMotionPayload | null>(
    null,
  );
  const [localRobot, setLocalRobot] = useState<RobotPayload | null>(null);
  const motion = currentMotion === undefined ? localMotion : currentMotion;
  const robot = currentRobot === undefined ? localRobot : currentRobot;

  const [motionPath, setMotionPath] = useState("");
  const [robotName, setRobotName] = useState(currentRobot?.name ?? "");
  const [reference, setReference] = useState(
    currentMotion?.suggested_reference ?? "",
  );
  const [calibration, setCalibration] = useState<CalibrationStatus | null>(
    null,
  );
  const [session, setSession] = useState<CalibrationSession | null>(null);
  const [jointQ, setJointQ] = useState<Record<string, number>>({});
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState<Action | null>(null);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RetargetResult | null>(
    currentResult ?? null,
  );
  const [retargetFps, setRetargetFps] = useState("");
  const [backend, setBackend] = useState<Backend>("newton");
  const [exportFormat, setExportFormat] = useState<"csv" | "pkl">("csv");
  const actionRequest = useRef<AbortController | null>(null);
  const calibrationStatusRequest = useRef<AbortController | null>(null);
  const resultCallback = useRef(onRetargetResult);
  resultCallback.current = onRetargetResult;
  const referenceCallback = useRef(onCalibrationReference);
  referenceCallback.current = onCalibrationReference;
  const poseCallback = useRef(onRobotPose);
  poseCallback.current = onRobotPose;
  const inputKey = `${motion?.token ?? ""}|${robot?.name ?? ""}|${reference}`;
  const previousInputKey = useRef(inputKey);

  useEffect(() => {
    const request = new AbortController();
    void Promise.all([
      getMotionLibrary({ signal: request.signal }),
      getRobotLibrary({ signal: request.signal }),
      getCalibrationReferences({ signal: request.signal }),
    ])
      .then(([motionLibrary, robotLibrary, referenceNames]) => {
        if (request.signal.aborted) return;
        setMotionEntries(
          motionLibrary.entries.filter(
            (entry) => entry.asset_kind !== "robot_trajectory",
          ),
        );
        setRobotEntries(robotLibrary.robots);
        setReferences(referenceNames);
      })
      .catch((reason: unknown) => {
        if (!request.signal.aborted) setError(errorMessage(reason));
      });
    return () => {
      request.abort();
      actionRequest.current?.abort();
      calibrationStatusRequest.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (currentResult !== undefined) setResult(currentResult);
  }, [currentResult]);

  useEffect(() => {
    setRobotName(robot?.name ?? "");
  }, [robot?.name]);

  useEffect(() => {
    const suggested = motion?.suggested_reference;
    const next = suggested ||
      (motion
        ? references.includes("smpl")
          ? "smpl"
          : references[0] || ""
        : "");
    setReference(next);
  }, [motion?.token, references]);

  useEffect(() => {
    if (
      motion?.suggested_backend === "newton" ||
      motion?.suggested_backend === "interaction_mesh"
    ) {
      setBackend(motion.suggested_backend);
    }
  }, [motion?.token]);

  // A result belongs to one exact motion/robot/reference tuple. The key starts
  // with the mounted tuple so returning to this view keeps an App-owned result.
  useEffect(() => {
    if (previousInputKey.current === inputKey) return;
    previousInputKey.current = inputKey;
    actionRequest.current?.abort();
    setBusy(null);
    setSession(null);
    setResult(null);
    setProgress(0);
    referenceCallback.current?.(null);
    poseCallback.current?.(null);
    resultCallback.current?.(null);
  }, [inputKey]);

  // For this Web workflow calibration/status is the lightweight preflight.
  useEffect(() => {
    if (!robot || !reference) {
      calibrationStatusRequest.current?.abort();
      setChecking(false);
      return;
    }
    const request = new AbortController();
    calibrationStatusRequest.current?.abort();
    calibrationStatusRequest.current = request;
    setCalibration(null);
    setChecking(true);
    void getCalibrationStatus(robot.name, reference, { signal: request.signal })
      .then((value) => {
        if (!request.signal.aborted) setCalibration(value);
      })
      .catch((reason: unknown) => {
        if (!request.signal.aborted) setError(errorMessage(reason));
      })
      .finally(() => {
        if (!request.signal.aborted) setChecking(false);
      });
    return () => request.abort();
  }, [robot, reference]);

  useEffect(
    () => () => {
      referenceCallback.current?.(null);
      poseCallback.current?.(null);
    },
    [],
  );

  useEffect(() => {
    if (!session || !robot) {
      poseCallback.current?.(null);
      return;
    }
    const request = new AbortController();
    const timer = window.setTimeout(() => {
      void previewCalibrationPose(robot.name, jointQ, {
        signal: request.signal,
      })
        .then((pose) => {
          if (!request.signal.aborted) poseCallback.current?.(pose);
        })
        .catch((reason: unknown) => {
          if (!request.signal.aborted) setError(errorMessage(reason));
        });
    }, 120);
    return () => {
      window.clearTimeout(timer);
      request.abort();
    };
  }, [jointQ, robot, session]);

  async function runAction(
    action: Action,
    work: (signal: AbortSignal) => Promise<void>,
  ) {
    actionRequest.current?.abort();
    const request = new AbortController();
    actionRequest.current = request;
    setBusy(action);
    setError(null);
    try {
      await work(request.signal);
    } catch (reason) {
      if (!request.signal.aborted) setError(errorMessage(reason));
    } finally {
      if (actionRequest.current === request) setBusy(null);
    }
  }

  function clearResult() {
    setResult(null);
    setStatus("");
    setError(null);
    resultCallback.current?.(null);
  }

  function selectMotion() {
    const entry = motionEntries.find((item) => item.source_path === motionPath);
    if (!entry || busy) return;
    void runAction("motion", async (signal) => {
      setStatus(`Loading ${motionLabel(entry)}…`);
      const payload = await loadMotionLibraryEntry(entry, {
        signal,
        usage: "human_to_robot",
        onUpdate: (job) => {
          setProgress(job.progress ?? 0);
          setStatus(job.message || "Loading motion…");
        },
      });
      if (signal.aborted) return;
      setLocalMotion(payload);
      setStatus(`Loaded ${payload.name}`);
      onMotionLoaded?.(payload);
    });
  }

  function selectRobot() {
    if (!robotName || busy) return;
    void runAction("robot", async (signal) => {
      setStatus("Loading robot…");
      const payload = await loadRobot(robotName, { signal });
      if (signal.aborted) return;
      setLocalRobot(payload);
      setStatus(`Loaded ${payload.display_name}`);
      onRobotLoaded?.(payload);
    });
  }

  function editCalibration() {
    if (!robot || !reference || busy) return;
    void runAction("calibration", async (signal) => {
      setStatus("Opening calibration…");
      const value = await startCalibrationSession(
        {
          robot: robot.name,
          reference,
          ...(motion?.token ? { motion_token: motion.token } : {}),
        },
        { signal },
      );
      if (signal.aborted) return;
      clearResult();
      setSession(value);
      setJointQ({ ...value.joint_q });
      referenceCallback.current?.(value.reference);
      setStatus("Edit joint values, then save calibration.");
    });
  }

  function closeCalibration() {
    setSession(null);
    referenceCallback.current?.(null);
    poseCallback.current?.(null);
  }

  function persistCalibration() {
    if (!robot || !reference || !session || busy) return;
    calibrationStatusRequest.current?.abort();
    setChecking(false);
    void runAction("save", async (signal) => {
      setStatus("Saving calibration…");
      const saved = await saveCalibration(
        {
          robot: robot.name,
          reference,
          joint_q: jointQ,
          ...(motion?.token ? { motion_token: motion.token } : {}),
        },
        { signal },
      );
      if (signal.aborted) return;
      setCalibration({ calibrated: true, path: saved.path ?? null });
      closeCalibration();
      setStatus("Calibration saved.");
    });
  }

  const blockedReason = useMemo(() => {
    if (!motion?.token) return "Select a human motion first.";
    if (!robot) return "Select a target robot first.";
    if (!reference) return "Select a reference pose.";
    if (checking) return "Checking calibration…";
    if (!calibration?.calibrated) return "Save calibration before retargeting.";
    return null;
  }, [calibration?.calibrated, checking, motion?.token, reference, robot]);

  function startRetarget() {
    if (!motion?.token || !robot || !reference || blockedReason || busy) return;
    void runAction("retarget", async (signal) => {
      clearResult();
      setProgress(0);
      setStatus(
        backend === "newton" ? "Starting Newton IK…" : "Starting Interaction-Mesh…",
      );
      const value = await retarget(
        {
          robot: robot.name,
          motion_token: motion.token!,
          reference,
          backend,
          retarget_fps: positiveNumber(retargetFps),
        },
        {
          signal,
          onUpdate: (job) => {
            setProgress(job.progress ?? 0);
            setStatus(job.message || "Retargeting…");
          },
        },
      );
      if (signal.aborted) return;
      setResult(value);
      setProgress(1);
      setStatus(`Completed ${value.num_frames} frames.`);
      resultCallback.current?.(value);
    });
  }

  const calibrationLabel = checking
    ? "Checking…"
    : calibration?.calibrated
      ? calibration.bundled && !calibration.path
        ? "Built-in"
        : "Calibrated"
      : "Not calibrated";
  const activeIndex = !motion
    ? 0
    : !robot
      ? 1
      : !calibration?.calibrated
        ? 2
        : 3;
  const exportUrl = result
    ? retargetExportUrl(result.export_token, { format: exportFormat })
    : null;

  return (
    <InspectorPage title="Human → Robot">
      <WorkflowPipeline
        label="Human to Robot pipeline"
        steps={pipeline}
        activeIndex={activeIndex}
      />
      <div className="flex shrink-0 flex-col">
        <WorkflowStep
          title="1. Motion"
          status={busy === "motion" ? "Loading…" : motion?.name || "Not loaded"}
          defaultOpen
        >
          <Picker
            label="Select human motion"
            value={motionPath}
            disabled={Boolean(busy)}
            buttonLabel="Load motion"
            onChange={setMotionPath}
            onLoad={selectMotion}
          >
            <option value="">Select from Motion Library…</option>
            {motionEntries.map((entry) => (
              <option key={entry.source_path} value={entry.source_path}>
                {motionLabel(entry)}
              </option>
            ))}
          </Picker>
        </WorkflowStep>

        <WorkflowStep
          title="2. Target robot"
          status={
            busy === "robot" ? "Loading…" : robot?.display_name || "Not loaded"
          }
        >
          <Picker
            label="Select target robot"
            value={robotName}
            disabled={Boolean(busy)}
            buttonLabel="Load robot"
            onChange={setRobotName}
            onLoad={selectRobot}
          >
            <option value="">Select a robot…</option>
            {robotEntries.map((entry) => (
              <option
                key={entry.name}
                value={entry.name}
                disabled={!entry.has_urdf}
              >
                {entry.display_name} ({entry.num_dof} DoF)
              </option>
            ))}
          </Picker>
        </WorkflowStep>

        <WorkflowStep title="3. Calibration" status={calibrationLabel}>
          <div className="grid gap-2.5">
            <Field label="Reference pose">
              <select
                className={fieldClass}
                value={reference}
                disabled={!motion || Boolean(busy)}
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  setReference(value);
                }}
              >
                <option value="">—</option>
                {references.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </Field>
            <Button
              size="sm"
              disabled={!robot || !reference || checking || Boolean(busy)}
              onClick={editCalibration}
            >
              {calibration?.calibrated ? "Edit calibration" : "Calibrate"}
            </Button>
            {session && (
              <div className="grid gap-2 rounded-md border border-border-subtle bg-background p-2.5">
                <p className="text-[11px] text-muted-foreground">
                  Joint values are radians.
                </p>
                <div className="grid max-h-56 gap-1.5 overflow-y-auto pr-1">
                  {session.joint_limits.map((limit) => (
                    <label
                      key={limit.name}
                      className="grid grid-cols-[minmax(0,1fr)_90px] items-center gap-2 text-[11px]"
                    >
                      <span className="truncate" title={limit.name}>
                        {limit.name}
                      </span>
                      <input
                        className={fieldClass}
                        type="number"
                        step="0.01"
                        min={limit.lower}
                        max={limit.upper}
                        value={jointQ[limit.name] ?? 0}
                        onChange={(event) => {
                          const value = Number(event.currentTarget.value);
                          if (Number.isFinite(value))
                            setJointQ((current) => ({
                              ...current,
                              [limit.name]: value,
                            }));
                        }}
                      />
                    </label>
                  ))}
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <Button
                    size="sm"
                    disabled={Boolean(busy)}
                    onClick={closeCalibration}
                  >
                    Cancel
                  </Button>
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={Boolean(busy)}
                    onClick={persistCalibration}
                  >
                    Save calibration
                  </Button>
                </div>
              </div>
            )}
          </div>
        </WorkflowStep>

        <WorkflowStep title="4. Result" status={result ? "Ready" : "Not ready"}>
          <div className="grid gap-2.5">
            <div className="grid grid-cols-2 gap-2">
              <Field label="Solver">
                <select
                  className={fieldClass}
                  value={backend}
                  disabled={Boolean(busy)}
                  onChange={(event) => {
                    const value = event.currentTarget.value as Backend;
                    setBackend(value);
                    clearResult();
                  }}
                >
                  <option value="newton">Newton IK</option>
                  <option value="interaction_mesh">Interaction-Mesh</option>
                </select>
              </Field>
              <Field label="Retarget FPS">
                <input
                  className={fieldClass}
                  type="number"
                  min="1"
                  step="1"
                  placeholder="Original FPS"
                  value={retargetFps}
                  disabled={Boolean(busy)}
                  onChange={(event) => {
                    setRetargetFps(event.currentTarget.value);
                    clearResult();
                  }}
                />
              </Field>
            </div>
            <Button
              variant="primary"
              size="sm"
              disabled={Boolean(blockedReason) || Boolean(busy)}
              onClick={startRetarget}
            >
              {busy === "retarget" ? "Retargeting…" : "Start Retarget"}
            </Button>
            {blockedReason && (
              <p className="text-xs text-muted-foreground">{blockedReason}</p>
            )}
            {busy === "retarget" && (
              <div
                className="h-1.5 overflow-hidden rounded-full bg-border-subtle"
                role="progressbar"
                aria-valuenow={Math.round(progress * 100)}
                aria-valuemin={0}
                aria-valuemax={100}
              >
                <div
                  className="h-full bg-primary transition-[width]"
                  style={{ width: `${Math.max(2, progress * 100)}%` }}
                />
              </div>
            )}
            {result && exportUrl && (
              <div className="grid grid-cols-[1fr_auto] gap-2 rounded-md border border-border-subtle bg-background p-2.5">
                <select
                  className={fieldClass}
                  aria-label="Export format"
                  value={exportFormat}
                  onChange={(event) =>
                    setExportFormat(event.currentTarget.value as "csv" | "pkl")
                  }
                >
                  <option value="csv">CSV</option>
                  <option value="pkl">PKL</option>
                </select>
                <a
                  className="inline-flex min-h-[30px] items-center rounded-md border border-border bg-surface px-3 text-xs font-medium hover:border-primary hover:bg-accent"
                  href={exportUrl}
                  download
                >
                  Download
                </a>
              </div>
            )}
          </div>
        </WorkflowStep>
      </div>
      {status && (
        <p className="text-xs text-muted-foreground" aria-live="polite">
          {status}
        </p>
      )}
      {error && (
        <p
          className="rounded-md border border-[#efcccc] bg-[#fff5f4] px-2.5 py-2 text-[11px] text-[#8c2929] break-words"
          role="alert"
        >
          {error}
        </p>
      )}
    </InspectorPage>
  );
}
