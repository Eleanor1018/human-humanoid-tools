import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { WorkflowStep } from "@/components/WorkflowSteps";
import { getR2rCalibrationStatus } from "@/features/r2r/api";
import type { MotionLibraryEntry } from "@/features/motion/api";
import { loadRobot, type RobotPayload, type RobotSummary } from "@/features/robot/api";
import type { JobSnapshot, UploadFile } from "@/lib/api";

import {
  runR2rBatch,
  uploadR2rBatchInputs,
  type BatchResult,
} from "./api";
import {
  BatchProgress,
  BatchResultPanel,
  CommonBatchSettings,
  EntryList,
  FileImport,
  RobotSelect,
  StatusMessage,
  type CommonBatchSettingsValue,
} from "./BatchParts";
import {
  appendUniqueEntries,
  entryKey,
  optionalNonNegativeNumber,
  optionalPositiveNumber,
  suggestedBackend,
  timeRangeError,
} from "./model";

type CalibrationPhase = "idle" | "checking" | "ready" | "missing" | "error";

const initialSettings: CommonBatchSettingsValue = {
  backend: "newton",
  format: "pkl",
  csvHeader: true,
  retargetFps: "",
  exportFps: "",
  start: "0",
  end: "",
  output: "r2r_batch_export",
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function invalidPositive(label: string, value: string): string | null {
  return value.trim() && optionalPositiveNumber(value) === undefined
    ? `${label} must be a positive number.`
    : null;
}

export function RobotBatchView({
  active,
  robots,
  catalogError,
}: {
  active: boolean;
  robots: readonly RobotSummary[];
  catalogError?: string | null;
}) {
  const [entries, setEntries] = useState<readonly MotionLibraryEntry[]>([]);
  const [sourceChoice, setSourceChoice] = useState("");
  const [targetChoice, setTargetChoice] = useState("");
  const [sourceRobot, setSourceRobot] = useState<RobotPayload | null>(null);
  const [targetRobot, setTargetRobot] = useState<RobotPayload | null>(null);
  const [calibration, setCalibration] = useState<CalibrationPhase>("idle");
  const [settings, setSettings] = useState(initialSettings);
  const [sourceFps, setSourceFps] = useState("50");
  const [action, setAction] = useState<"import" | "source" | "target" | "run" | null>(null);
  const [job, setJob] = useState<JobSnapshot<BatchResult> | null>(null);
  const [completed, setCompleted] = useState<{ jobId: string; result: BatchResult } | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState<string | null>(null);
  const operation = useRef<AbortController | null>(null);
  const busy = action !== null;
  const loadedPair = Boolean(
    sourceRobot &&
      targetRobot &&
      sourceChoice === sourceRobot.name &&
      targetChoice === targetRobot.name,
  );

  useEffect(() => () => operation.current?.abort(), []);

  useEffect(() => {
    if (!active) return;
    if (!sourceRobot || !targetRobot || !loadedPair) {
      setCalibration("idle");
      return;
    }
    const request = new AbortController();
    setCalibration("checking");
    void getR2rCalibrationStatus(targetRobot.name, sourceRobot.name, {
      signal: request.signal,
    })
      .then((status) => {
        if (!request.signal.aborted) setCalibration(status.calibrated ? "ready" : "missing");
      })
      .catch(() => {
        if (!request.signal.aborted) setCalibration("error");
      });
    return () => request.abort();
  }, [active, loadedPair, sourceRobot, targetRobot]);

  function resetRunResult(): void {
    setJob(null);
    setCompleted(null);
  }

  function addEntries(incoming: readonly MotionLibraryEntry[]): void {
    const next = appendUniqueEntries(entries, incoming);
    const added = next.length - entries.length;
    setEntries(next);
    setNotice(`${added} added · ${incoming.length - added} duplicates skipped`);
    const backend = suggestedBackend(incoming);
    if (backend) setSettings((current) => ({ ...current, backend }));
    setError(null);
    resetRunResult();
  }

  async function importFiles(files: readonly UploadFile[]): Promise<void> {
    if (!files.length || busy) return;
    operation.current?.abort();
    const request = new AbortController();
    operation.current = request;
    setAction("import");
    setError(null);
    setNotice(`Reading ${files.length} uploaded file${files.length === 1 ? "" : "s"}…`);
    try {
      const result = await uploadR2rBatchInputs(files, "auto", {
        signal: request.signal,
        onUpdate: (snapshot) => setNotice(snapshot.message || "Recognizing trajectories…"),
      });
      if (!request.signal.aborted) addEntries(result.entries);
    } catch (reason) {
      if (!request.signal.aborted) setError(errorMessage(reason));
    } finally {
      if (operation.current === request) {
        operation.current = null;
        setAction(null);
      }
    }
  }

  async function loadSelectedRobot(kind: "source" | "target"): Promise<void> {
    const choice = kind === "source" ? sourceChoice : targetChoice;
    if (!choice || busy) return;
    operation.current?.abort();
    const request = new AbortController();
    operation.current = request;
    setAction(kind);
    setError(null);
    setCalibration("idle");
    try {
      const loaded = await loadRobot(choice, { signal: request.signal });
      if (request.signal.aborted) return;
      if (kind === "source") setSourceRobot(loaded);
      else setTargetRobot(loaded);
      setNotice(`Loaded ${loaded.display_name}`);
      resetRunResult();
    } catch (reason) {
      if (!request.signal.aborted) setError(errorMessage(reason));
    } finally {
      if (operation.current === request) {
        operation.current = null;
        setAction(null);
      }
    }
  }

  const settingsError =
    timeRangeError(settings.start, settings.end) ||
    invalidPositive("Source FPS", sourceFps) ||
    invalidPositive("Retarget FPS", settings.retargetFps) ||
    invalidPositive("Export FPS", settings.exportFps);
  const disabledReason = busy
    ? action === "run"
      ? "An R2R batch task is running."
      : "Finish the current Batch operation first."
    : !entries.length
      ? "Add at least one source trajectory."
      : !sourceRobot
        ? "Load the source robot."
        : sourceChoice !== sourceRobot.name
          ? "Load the selected source robot."
          : !targetRobot
            ? "Load the target robot."
            : targetChoice !== targetRobot.name
              ? "Load the selected target robot."
              : calibration === "checking"
                ? "Checking robot-pair calibration…"
                : calibration !== "ready"
                  ? "Calibrate this robot pair in Robot → Robot first."
                  : settingsError;

  async function run(): Promise<void> {
    if (disabledReason || !sourceRobot || !targetRobot) return;
    operation.current?.abort();
    const request = new AbortController();
    operation.current = request;
    setAction("run");
    setError(null);
    setCompleted(null);
    setJob({ id: "starting", kind: "r2r_batch", status: "running", progress: 0, clip_progress: 0, message: "Starting R2R batch…" });
    try {
      const done = await runR2rBatch(
        {
          source: sourceRobot.name,
          target: targetRobot.name,
          entries,
          backend: settings.backend,
          out_dir: settings.output.trim().replace(/\.zip$/i, "") || "r2r_batch_export",
          format: settings.format,
          csv_header: settings.csvHeader,
          source_fps: optionalPositiveNumber(sourceFps),
          retarget_fps: optionalPositiveNumber(settings.retargetFps),
          export_fps: optionalPositiveNumber(settings.exportFps),
          t_start: optionalNonNegativeNumber(settings.start),
          t_end: optionalNonNegativeNumber(settings.end),
        },
        { signal: request.signal, onUpdate: setJob },
      );
      if (!request.signal.aborted) {
        setJob((current) => current ? { ...current, status: "done", progress: 1, clip_progress: 1 } : current);
        setCompleted(done);
        setNotice(`${done.result.written.length} trajectories completed.`);
      }
    } catch (reason) {
      if (!request.signal.aborted) setError(errorMessage(reason));
    } finally {
      if (operation.current === request) {
        operation.current = null;
        setAction(null);
      }
    }
  }

  const calibrationLabel = !loadedPair
    ? "Load both robots"
    : calibration === "checking"
      ? "Checking…"
      : calibration === "ready"
        ? "Pair ready"
        : calibration === "missing"
          ? "Calibration needed"
          : calibration === "error"
            ? "Check failed"
            : "Not checked";

  return (
    <div className="flex flex-col">
      <WorkflowStep title="1. Source trajectories" status={`${entries.length} trajectories`} defaultOpen>
        <div className="grid gap-2.5">
          <FileImport
            title="Drop trajectory files or a folder"
            hint="CSV, PKL, NPZ and dataset folders"
            icon="/icons/sidebar/r2r.svg"
            accept=".csv,.pkl,.npz"
            busy={busy}
            onFiles={importFiles}
          />
          <EntryList
            entries={entries}
            kind="robot"
            busy={busy}
            onRemove={(key) => {
              setEntries((current) => current.filter((entry) => entryKey(entry) !== key));
              resetRunResult();
            }}
            onClear={() => {
              setEntries([]);
              resetRunResult();
            }}
          />
        </div>
      </WorkflowStep>

      <WorkflowStep title="2. Source robot" status={sourceRobot?.display_name ?? "Not loaded"} defaultOpen>
        <RobotSelect
          label="Source robot"
          robots={robots}
          value={sourceChoice}
          loadedName={sourceRobot?.name}
          busy={busy}
          onChange={setSourceChoice}
          onLoad={() => void loadSelectedRobot("source")}
        />
      </WorkflowStep>

      <WorkflowStep title="3. Target robot" status={targetRobot?.display_name ?? "Not loaded"} defaultOpen>
        <div className="grid gap-2.5">
          <RobotSelect
            label="Target robot"
            robots={robots}
            value={targetChoice}
            loadedName={targetRobot?.name}
            busy={busy}
            onChange={setTargetChoice}
            onLoad={() => void loadSelectedRobot("target")}
          />
          <p
            className={`text-[11px] ${calibration === "ready" ? "text-success" : calibration === "missing" ? "text-warning" : calibration === "error" ? "text-danger" : "text-muted-foreground"}`}
          >
            {calibrationLabel}
          </p>
        </div>
      </WorkflowStep>

      <WorkflowStep title="4. Run settings" defaultOpen>
        <CommonBatchSettings
          value={settings}
          sourceFps={sourceFps}
          disabled={busy}
          onChange={(patch) => setSettings((current) => ({ ...current, ...patch }))}
          onSourceFpsChange={setSourceFps}
        />
      </WorkflowStep>

      <section className="grid gap-2.5 pt-4">
        <p className="text-xs text-muted-foreground">
          {entries.length
            ? `${entries.length} trajectories · ${sourceRobot?.display_name ?? "no source"} → ${targetRobot?.display_name ?? "no target"}`
            : "No source trajectories selected."}
        </p>
        <Button variant="primary" size="sm" disabled={Boolean(disabledReason)} onClick={() => void run()}>
          {action === "run" ? "Running R2R batch…" : "Start R2R batch"}
        </Button>
        {disabledReason && <p className="text-[11px] text-muted-foreground">{disabledReason}</p>}
        <BatchProgress job={job} />
        <StatusMessage error={Boolean(error || catalogError)}>{error || catalogError}</StatusMessage>
        {!error && <StatusMessage>{notice}</StatusMessage>}
        {completed && <BatchResultPanel jobId={completed.jobId} result={completed.result} />}
      </section>
    </div>
  );
}
