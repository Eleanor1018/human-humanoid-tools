import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { Button } from "@/components/ui/button";
import { WorkflowStep } from "@/components/WorkflowSteps";
import { getCalibrationStatus } from "@/features/h2r/api";
import type { MotionLibraryEntry } from "@/features/motion/api";
import { loadRobot, type RobotPayload, type RobotSummary } from "@/features/robot/api";
import type { JobSnapshot, UploadFile } from "@/lib/api";

import {
  runHumanBatch,
  uploadHumanBatchInputs,
  type BatchResult,
} from "./api";
import {
  BatchProgress,
  BatchResultPanel,
  CommonBatchSettings,
  EntryList,
  FileImport,
  LibraryPicker,
  RobotSelect,
  StatusMessage,
  type CommonBatchSettingsValue,
} from "./BatchParts";
import {
  appendUniqueEntries,
  entryKey,
  entryReference,
  optionalNonNegativeNumber,
  optionalPositiveNumber,
  suggestedBackend,
  timeRangeError,
} from "./model";

type Compatibility = "checking" | "ready" | "missing" | "error";

interface ReferenceCheck {
  readonly reference: string;
  readonly count: number;
  readonly status: Compatibility;
}

const initialSettings: CommonBatchSettingsValue = {
  backend: "newton",
  format: "pkl",
  csvHeader: true,
  retargetFps: "",
  exportFps: "",
  start: "0",
  end: "",
  output: "batch_export",
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function invalidPositive(label: string, value: string): string | null {
  return value.trim() && optionalPositiveNumber(value) === undefined
    ? `${label} must be a positive number.`
    : null;
}

export function HumanBatchView({
  library,
  robots,
  entries,
  onEntriesChange,
  catalogError,
}: {
  library: readonly MotionLibraryEntry[];
  robots: readonly RobotSummary[];
  entries: readonly MotionLibraryEntry[];
  onEntriesChange(entries: readonly MotionLibraryEntry[]): void;
  catalogError?: string | null;
}) {
  const humanLibrary = useMemo(
    () => library.filter((entry) => entry.asset_kind !== "robot_trajectory"),
    [library],
  );
  const [librarySelection, setLibrarySelection] = useState<ReadonlySet<string>>(new Set());
  const [libraryQuery, setLibraryQuery] = useState("");
  const [robotChoice, setRobotChoice] = useState("");
  const [robot, setRobot] = useState<RobotPayload | null>(null);
  const [checks, setChecks] = useState<readonly ReferenceCheck[]>([]);
  const [settings, setSettings] = useState(initialSettings);
  const [batchSize, setBatchSize] = useState("");
  const [action, setAction] = useState<"import" | "robot" | "run" | null>(null);
  const [job, setJob] = useState<JobSnapshot<BatchResult> | null>(null);
  const [completed, setCompleted] = useState<{ jobId: string; result: BatchResult } | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState<string | null>(null);
  const operation = useRef<AbortController | null>(null);
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  const busy = action !== null;

  const referenceGroups = useMemo(() => {
    const groups = new Map<string, number>();
    for (const entry of entries) {
      const reference = entryReference(entry);
      groups.set(reference, (groups.get(reference) ?? 0) + 1);
    }
    return [...groups].sort(([left], [right]) => left.localeCompare(right));
  }, [entries]);
  const referenceKey = referenceGroups.map(([reference, count]) => `${reference}:${count}`).join("|");

  useEffect(() => () => operation.current?.abort(), []);

  useEffect(() => {
    if (!robot || !referenceGroups.length) {
      setChecks([]);
      return;
    }
    const request = new AbortController();
    setChecks(referenceGroups.map(([reference, count]) => ({ reference, count, status: "checking" })));
    void Promise.all(
      referenceGroups.map(async ([reference, count]): Promise<ReferenceCheck> => {
        try {
          const result = await getCalibrationStatus(robot.name, reference, {
            signal: request.signal,
          });
          return {
            reference,
            count,
            status: result.calibrated ? "ready" : "missing",
          };
        } catch {
          return { reference, count, status: "error" };
        }
      }),
    ).then((next) => {
      if (!request.signal.aborted) setChecks(next);
    });
    return () => request.abort();
    // `referenceKey` is the compact identity of all unique calibration scopes.
  }, [robot, referenceKey]);

  function resetRunResult(): void {
    setJob(null);
    setCompleted(null);
  }

  function addEntries(incoming: readonly MotionLibraryEntry[]): void {
    const current = entriesRef.current;
    const next = appendUniqueEntries(current, incoming);
    const added = next.length - current.length;
    onEntriesChange(next);
    setNotice(`${added} added · ${incoming.length - added} duplicates skipped`);
    const backend = suggestedBackend(incoming);
    if (backend) setSettings((current) => ({ ...current, backend }));
    setError(null);
    resetRunResult();
  }

  function addSelectedLibraryEntries(): void {
    addEntries(humanLibrary.filter((entry) => librarySelection.has(entryKey(entry))));
    setLibrarySelection(new Set());
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
      const result = await uploadHumanBatchInputs(files, "auto", {
        signal: request.signal,
        onUpdate: (snapshot) => setNotice(snapshot.message || "Recognizing clips…"),
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

  async function loadSelectedRobot(): Promise<void> {
    if (!robotChoice || busy) return;
    operation.current?.abort();
    const request = new AbortController();
    operation.current = request;
    setAction("robot");
    setError(null);
    try {
      const loaded = await loadRobot(robotChoice, { signal: request.signal });
      if (!request.signal.aborted) {
        setRobot(loaded);
        setNotice(`Loaded ${loaded.display_name}`);
        resetRunResult();
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

  const settingsError =
    timeRangeError(settings.start, settings.end) ||
    invalidPositive("Retarget FPS", settings.retargetFps) ||
    invalidPositive("Export FPS", settings.exportFps) ||
    (batchSize.trim() &&
    (!Number.isSafeInteger(Number(batchSize)) || Number(batchSize) < 1 || Number(batchSize) > 256)
      ? "GPU batch size must be an integer from 1 to 256."
      : null);
  const checkedReferenceKey = checks
    .map((check) => `${check.reference}:${check.count}`)
    .sort()
    .join("|");
  const checksAreCurrent = checkedReferenceKey === referenceKey;
  const missingReferences = checks.filter((check) => check.status !== "ready");
  const disabledReason = busy
    ? action === "run"
      ? "A batch task is running."
      : "Finish the current Batch operation first."
    : !entries.length
      ? "Add at least one motion."
      : !robot
        ? "Select and load a target robot."
        : robotChoice !== robot.name
          ? "Load the selected target robot."
          : !checksAreCurrent || checks.some((check) => check.status === "checking")
            ? "Checking calibration compatibility…"
            : missingReferences.length
              ? `Complete calibration for ${missingReferences.map((check) => check.reference.toUpperCase()).join(", ")}.`
              : settingsError;

  async function run(): Promise<void> {
    if (disabledReason || !robot) return;
    operation.current?.abort();
    const request = new AbortController();
    operation.current = request;
    setAction("run");
    setError(null);
    setCompleted(null);
    setJob({ id: "starting", kind: "batch", status: "running", progress: 0, clip_progress: 0, message: "Starting batch task…" });
    try {
      const done = await runHumanBatch(
        {
          robot: robot.name,
          entries,
          reference: "smpl",
          backend: settings.backend,
          out_dir: settings.output.trim().replace(/\.zip$/i, "") || "batch_export",
          format: settings.format,
          csv_header: settings.csvHeader,
          foot_clamp_anti_penetration: false,
          batch_size: batchSize.trim() ? Number(batchSize) : undefined,
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
        setNotice(`${done.result.written.length} clips completed.`);
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

  return (
    <div className="flex flex-col">
      <WorkflowStep title="1. Inputs" status={`${entries.length} clips`} defaultOpen>
        <div className="grid gap-2.5">
          <LibraryPicker
            entries={humanLibrary}
            selection={librarySelection}
            query={libraryQuery}
            disabled={busy}
            onQueryChange={setLibraryQuery}
            onSelectionChange={setLibrarySelection}
            onAdd={addSelectedLibraryEntries}
          />
          <FileImport
            title="Drop motion files or a folder"
            hint="Files are recognized and cached by FastAPI"
            icon="/icons/sidebar/motion.svg"
            busy={busy}
            onFiles={importFiles}
          />
          <EntryList
            entries={entries}
            kind="human"
            busy={busy}
            onRemove={(key) => {
              onEntriesChange(
                entriesRef.current.filter((entry) => entryKey(entry) !== key),
              );
              resetRunResult();
            }}
            onClear={() => {
              onEntriesChange([]);
              resetRunResult();
            }}
          />
        </div>
      </WorkflowStep>

      <WorkflowStep title="2. Target robot & calibration" status={robot?.display_name ?? "Not loaded"} defaultOpen>
        <div className="grid gap-2.5">
          <RobotSelect
            label="Target robot"
            robots={robots}
            value={robotChoice}
            loadedName={robot?.name}
            busy={busy}
            onChange={setRobotChoice}
            onLoad={() => void loadSelectedRobot()}
          />
          {referenceGroups.length > 0 && (
            <div className="rounded-md border border-border-subtle bg-background">
              {referenceGroups.map(([reference, count]) => {
                const status = checks.find((check) => check.reference === reference)?.status;
                return (
                  <div key={reference} className="flex min-h-9 items-center justify-between gap-3 border-b border-border-subtle px-2.5 py-1.5 text-[11px] last:border-b-0">
                    <span><strong className="text-foreground">{reference.toUpperCase()}</strong> · {count} clips</span>
                    <span className={status === "ready" ? "text-[#16845b]" : status === "missing" || status === "error" ? "text-[#b35c00]" : "text-muted-foreground"}>
                      {!robot ? "Load robot" : status === "checking" ? "Checking…" : status === "ready" ? "Ready" : status === "error" ? "Check failed" : "Calibration needed"}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </WorkflowStep>

      <WorkflowStep title="3. Run settings" defaultOpen>
        <CommonBatchSettings
          value={settings}
          batchSize={batchSize}
          disabled={busy}
          onChange={(patch) => setSettings((current) => ({ ...current, ...patch }))}
          onBatchSizeChange={setBatchSize}
        />
        <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
          {settings.backend === "newton"
            ? "Newton uses GPU chunks; leave batch size empty for automatic tuning."
            : "Interaction-Mesh processes clips sequentially."}
        </p>
      </WorkflowStep>

      <section className="grid gap-2.5 pt-4">
        <p className="text-xs text-muted-foreground">
          {entries.length
            ? `${entries.length} clips → ${robot?.display_name ?? "no target"} → ${(settings.output || "batch_export").replace(/\.zip$/i, "")}.zip`
            : "No inputs selected."}
        </p>
        <Button variant="primary" size="sm" disabled={Boolean(disabledReason)} onClick={() => void run()}>
          {action === "run" ? "Running batch…" : "Start H2R batch"}
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
