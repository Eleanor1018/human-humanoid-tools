import { useCallback, useEffect, useRef, useState } from "react";

import { Field, fieldClass } from "@/components/Field";
import { Button } from "@/components/ui/button";
import { WorkflowStep } from "@/components/WorkflowSteps";
import {
  canSetupGvhmrInDesktop,
  formatFileSize,
  getGvhmrRuntimeStatus,
  isSupportedVideoName,
  parseOptionalFocalLength,
  setupGvhmrInDesktop,
  startVideoToMotion,
  summarizeMotionResult,
  waitForVideoToMotion,
  type GvhmrRuntimeStatus,
  type MotionResultSummary,
} from "@/features/video-to-motion/api";
import type { MotionLibraryEntry } from "@/features/motion/api";
import type { UploadFile } from "@/lib/api";

import { FileImport, StatusMessage } from "./BatchParts";
import { publishedMotionEntry, uploadFileKey } from "./model";

type VideoStatus = "queued" | "uploading" | "running" | "done" | "error";

interface VideoItem {
  readonly id: string;
  readonly file: UploadFile;
  readonly status: VideoStatus;
  readonly progress: number;
  readonly message: string;
  readonly result?: MotionResultSummary;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function statusLabel(status: VideoStatus): string {
  if (status === "queued") return "Queued";
  if (status === "uploading") return "Uploading";
  if (status === "running") return "Generating";
  if (status === "done") return "Published";
  return "Failed";
}

export function VideoBatchView({
  onMotionPublished,
}: {
  onMotionPublished(entry: MotionLibraryEntry): void;
}) {
  const [videos, setVideos] = useState<readonly VideoItem[]>([]);
  const [runtime, setRuntime] = useState<GvhmrRuntimeStatus | null>(null);
  const [runtimeChecking, setRuntimeChecking] = useState(false);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [staticCamera, setStaticCamera] = useState(true);
  const [focalLength, setFocalLength] = useState("");
  const [busy, setBusy] = useState(false);
  const [setupBusy, setSetupBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const runtimeRequest = useRef<AbortController | null>(null);
  const runRequest = useRef<AbortController | null>(null);

  const refreshRuntime = useCallback(() => {
    runtimeRequest.current?.abort();
    const request = new AbortController();
    runtimeRequest.current = request;
    setRuntimeChecking(true);
    setRuntimeError(null);
    setConfirmed(false);
    void getGvhmrRuntimeStatus(request.signal)
      .then((status) => {
        if (!request.signal.aborted) setRuntime(status);
      })
      .catch((reason: unknown) => {
        if (!request.signal.aborted) {
          setRuntime(null);
          setRuntimeError(errorMessage(reason));
        }
      })
      .finally(() => {
        if (!request.signal.aborted) setRuntimeChecking(false);
      });
  }, []);

  useEffect(() => {
    refreshRuntime();
    return () => {
      runtimeRequest.current?.abort();
      runRequest.current?.abort();
    };
  }, [refreshRuntime]);

  function addVideos(files: readonly UploadFile[]): void {
    let rejected = 0;
    const known = new Set(videos.map((item) => item.id));
    const additions: VideoItem[] = [];
    for (const file of files) {
      if (!isSupportedVideoName(file.name)) {
        rejected += 1;
        continue;
      }
      const id = uploadFileKey(file);
      if (known.has(id)) continue;
      known.add(id);
      additions.push({ id, file, status: "queued", progress: 0, message: "" });
    }
    setVideos((current) => {
      const currentKeys = new Set(current.map((item) => item.id));
      return [...current, ...additions.filter((item) => !currentKeys.has(item.id))];
    });
    setNotice(rejected ? `${rejected} unsupported file${rejected === 1 ? " was" : "s were"} skipped.` : "");
  }

  function patchVideo(id: string, patch: Partial<VideoItem>): void {
    setVideos((current) => current.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  }

  async function configureRuntime(): Promise<void> {
    setSetupBusy(true);
    setRuntimeError(null);
    try {
      const result = await setupGvhmrInDesktop();
      if (result.action === "configured") refreshRuntime();
    } catch (reason) {
      setRuntimeError(errorMessage(reason));
    } finally {
      setSetupBusy(false);
    }
  }

  let focalError: string | null = null;
  try {
    parseOptionalFocalLength(focalLength);
  } catch (reason) {
    focalError = errorMessage(reason);
  }
  const unfinished = videos.filter((item) => item.status !== "done");
  const completedCount = videos.length - unfinished.length;
  const failedCount = videos.filter((item) => item.status === "error").length;
  const aggregateProgress = videos.length
    ? videos.reduce((sum, item) => sum + item.progress, 0) / videos.length
    : 0;
  const disabledReason = busy
    ? "The video queue is running."
    : !videos.length
      ? "Add at least one video."
      : !unfinished.length
        ? "Every video is already complete."
        : runtimeChecking
          ? "Checking the GVHMR runtime…"
          : runtime?.ready !== true
            ? "The GVHMR runtime is unavailable."
            : !confirmed
              ? "Confirm the runtime before starting."
              : focalError;

  async function runQueue(): Promise<void> {
    if (disabledReason) return;
    const pending = videos.filter((item) => item.status !== "done");
    const parsedFocalLength = parseOptionalFocalLength(focalLength);
    runRequest.current?.abort();
    const request = new AbortController();
    runRequest.current = request;
    setBusy(true);
    setNotice(`Processing ${pending.length} video${pending.length === 1 ? "" : "s"} sequentially…`);
    let completed = completedCount;
    let failed = 0;
    try {
      // One official GVHMR process at a time keeps GPU memory and attribution deterministic.
      for (let index = 0; index < pending.length; index += 1) {
        const item = pending[index];
        patchVideo(item.id, {
          status: "uploading",
          progress: 0.04,
          message: "Uploading video…",
          result: undefined,
        });
        try {
          const jobId = await startVideoToMotion(
            { video: item.file, staticCamera, focalLength: parsedFocalLength },
            request.signal,
          );
          if (request.signal.aborted) return;
          patchVideo(item.id, { status: "running", progress: 0.08, message: "Starting GVHMR…" });
          const motion = await waitForVideoToMotion(jobId, {
            signal: request.signal,
            onUpdate: (job) => {
              patchVideo(item.id, {
                status: "running",
                progress: 0.08 + job.progress * 0.92,
                message: job.message || "Generating motion…",
              });
            },
          });
          if (request.signal.aborted) return;
          const result = summarizeMotionResult(motion, item.file.name);
          const libraryEntry = publishedMotionEntry(motion.library_entry);
          if (libraryEntry) onMotionPublished(libraryEntry);
          patchVideo(item.id, {
            status: "done",
            progress: 1,
            message: result.linkedFolder
              ? `Published to ${result.linkedFolder}`
              : "Published to Motion Library",
            result,
          });
          completed += 1;
        } catch (reason) {
          if (request.signal.aborted) return;
          failed += 1;
          patchVideo(item.id, {
            status: "error",
            progress: 0,
            message: errorMessage(reason),
          });
        }
        setNotice(`Processed ${index + 1} of ${pending.length}.`);
      }
      setNotice(`${completed} completed · ${failed} failed. Generated motions are in Motion Library.`);
    } finally {
      if (runRequest.current === request) {
        runRequest.current = null;
        setBusy(false);
      }
    }
  }

  const runtimeLabel = runtimeChecking
    ? "Checking"
    : runtime?.ready
      ? `Ready · ${runtime.runtime === "docker" ? "Docker" : "Local"}`
      : "Unavailable";

  return (
    <div className="flex flex-col">
      <WorkflowStep title="1. Videos" status={`${videos.length} videos`} defaultOpen>
        <div className="grid gap-2.5">
          <FileImport
            title="Drop videos or a folder"
            hint="MP4, MOV, MKV, AVI, WebM or M4V"
            icon="/icons/sidebar/video-to-motion.svg"
            accept="video/mp4,video/quicktime,video/x-matroska,video/x-msvideo,video/webm,.m4v"
            busy={busy}
            onFiles={addVideos}
          />
          <div className="max-h-56 overflow-y-auto rounded-md border border-border-subtle bg-surface">
            {videos.length ? videos.map((item) => (
              <div key={item.id} className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 border-b border-border-subtle px-2.5 py-2 last:border-b-0">
                <div className="min-w-0">
                  <p className="truncate text-xs font-semibold text-foreground" title={item.file.name}>{item.file.name}</p>
                  <p className="text-[10px] text-muted-foreground">{formatFileSize(item.file.size)} · {statusLabel(item.status)}</p>
                  {item.message && <p className={`mt-1 break-words text-[10px] ${item.status === "error" ? "text-danger" : "text-muted-foreground"}`}>{item.message}</p>}
                  {(item.status === "uploading" || item.status === "running") && (
                    <progress className="mt-1 h-1 w-full accent-primary" value={item.progress} max="1" />
                  )}
                </div>
                <button
                  type="button"
                  className="size-7 rounded-md text-lg leading-none text-muted-foreground hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                  aria-label={`Remove ${item.file.name}`}
                  title="Remove"
                  disabled={busy}
                  onClick={() => setVideos((current) => current.filter((candidate) => candidate.id !== item.id))}
                >
                  ×
                </button>
              </div>
            )) : (
              <p className="px-3 py-5 text-center text-xs text-muted-foreground">No videos yet.</p>
            )}
          </div>
          <div className="flex items-center justify-between gap-3 text-[11px] text-muted-foreground">
            <span>{completedCount} ready · {failedCount} failed</span>
            <Button size="sm" variant="ghost" disabled={busy || !videos.length} onClick={() => { setVideos([]); setNotice(""); }}>
              Clear all
            </Button>
          </div>
        </div>
      </WorkflowStep>

      <WorkflowStep title="2. Environment" status={runtimeLabel} defaultOpen>
        <div className="grid gap-2.5">
          <Field label="Runtime">
            <select className={fieldClass} value="official" disabled>
              <option value="official">GVHMR Official</option>
            </select>
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Button size="sm" disabled={runtimeChecking || busy || runtime?.ready !== true || confirmed} onClick={() => setConfirmed(true)}>
              {confirmed ? "Confirmed" : "Confirm"}
            </Button>
            <Button size="sm" disabled={runtimeChecking || busy} onClick={refreshRuntime}>
              Refresh
            </Button>
          </div>
          {canSetupGvhmrInDesktop() && runtime?.ready !== true && (
            <Button size="sm" disabled={setupBusy || busy} onClick={() => void configureRuntime()}>
              {setupBusy ? "Setting up…" : "Set up GVHMR"}
            </Button>
          )}
          <StatusMessage error={Boolean(runtimeError || (runtime && !runtime.ready))}>
            {runtimeError || (runtime?.ready ? "Official runtime and weights are ready." : runtime?.missing?.[0])}
          </StatusMessage>
          {runtime && runtime.missing.length > 1 && (
            <details className="text-[11px] text-muted-foreground">
              <summary className="cursor-pointer">{runtime.missing.length - 1} more checks</summary>
              <ul className="mt-1 grid list-disc gap-1 pl-4">
                {runtime.missing.slice(1).map((item) => <li key={item}>{item}</li>)}
              </ul>
            </details>
          )}
        </div>
      </WorkflowStep>

      <WorkflowStep title="3. Generate motions" status={busy ? `${Math.round(aggregateProgress * 100)}%` : unfinished.length ? `${unfinished.length} pending` : videos.length ? "Done" : "Waiting"} defaultOpen>
        <div className="grid gap-2.5">
          <label className="flex min-h-8 items-center justify-between gap-3 text-xs font-medium text-foreground">
            Static camera
            <input type="checkbox" className="size-4 accent-primary" checked={staticCamera} disabled={busy} onChange={(event) => setStaticCamera(event.currentTarget.checked)} />
          </label>
          <Field label="Focal length">
            <input className={fieldClass} type="number" min="1" step="1" placeholder="Auto" value={focalLength} disabled={busy} onChange={(event) => setFocalLength(event.currentTarget.value)} />
          </Field>
          <Button variant="primary" size="sm" disabled={Boolean(disabledReason)} onClick={() => void runQueue()}>
            {busy ? "Generating…" : failedCount || completedCount ? "Retry unfinished" : "Start V2M batch"}
          </Button>
          <progress className="h-1.5 w-full accent-primary" value={aggregateProgress} max="1" />
          {disabledReason && <p className="text-[11px] text-muted-foreground">{disabledReason}</p>}
          <StatusMessage error={Boolean(focalError)}>{focalError}</StatusMessage>
          {!focalError && <StatusMessage>{notice}</StatusMessage>}
        </div>
      </WorkflowStep>
    </div>
  );
}
