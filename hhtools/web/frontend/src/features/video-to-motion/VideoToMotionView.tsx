import { useCallback, useEffect, useRef, useState } from "react";

import { Field, fieldClass } from "@/components/Field";
import { ImportDropzone } from "@/components/ImportDropzone";
import { InspectorPage } from "@/components/Inspector";
import { Button } from "@/components/ui/button";
import { WorkflowPipeline, WorkflowStep } from "@/components/WorkflowSteps";
import {
  toStageMotionPayload as toStageImportedMotionPayload,
  uploadMotion,
  type MotionJob,
} from "@/features/motion/api";
import type { StageMotionPayload } from "@/stage/types";

import {
  canSetupGvhmrInDesktop,
  formatFileSize,
  getGvhmrRuntimeStatus,
  isGvhmrResultName,
  isSupportedVideoName,
  parseOptionalFocalLength,
  setupGvhmrInDesktop,
  startVideoToMotion,
  summarizeMotionResult,
  toStageMotionPayload,
  waitForVideoToMotion,
  type GvhmrRuntimeStatus,
  type MotionResultSummary,
  type VideoToMotionJob,
} from "./api";

const pipeline = ["Select Video", "Environment", "Generate", "Motion Result"];

type RuntimePhase = "checking" | "ready" | "unavailable" | "error";
type WorkflowPhase = "idle" | "uploading" | "running" | "done" | "error";

interface SelectedVideo {
  readonly file: File;
  readonly previewUrl: string;
  readonly duration: number | null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatMetric(value: number | null, suffix = ""): string {
  if (value === null) return "--";
  const display = Number.isInteger(value) ? String(value) : value.toFixed(2);
  return `${display}${suffix}`;
}

export function VideoToMotionView({
  onMotionLoaded,
}: {
  onMotionLoaded?: (motion: StageMotionPayload | null) => void;
}) {
  const [runtimePhase, setRuntimePhase] = useState<RuntimePhase>("checking");
  const [runtime, setRuntime] = useState<GvhmrRuntimeStatus | null>(null);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [video, setVideo] = useState<SelectedVideo | null>(null);
  const [staticCamera, setStaticCamera] = useState(true);
  const [focalLength, setFocalLength] = useState("");
  const [workflowPhase, setWorkflowPhase] = useState<WorkflowPhase>("idle");
  const [job, setJob] = useState<VideoToMotionJob | null>(null);
  const [workflowError, setWorkflowError] = useState<string | null>(null);
  const [result, setResult] = useState<MotionResultSummary | null>(null);
  const [importing, setImporting] = useState(false);
  const [importJob, setImportJob] = useState<MotionJob | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [setupBusy, setSetupBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const resultInput = useRef<HTMLInputElement>(null);
  const previewUrl = useRef<string | null>(null);
  const runtimeRequest = useRef<AbortController | null>(null);
  const operation = useRef<AbortController | null>(null);
  const generating = workflowPhase === "uploading" || workflowPhase === "running";
  const busy = importing || generating;

  const refreshRuntime = useCallback(() => {
    runtimeRequest.current?.abort();
    const request = new AbortController();
    runtimeRequest.current = request;
    setRuntimePhase("checking");
    setRuntimeError(null);
    void getGvhmrRuntimeStatus(request.signal)
      .then((status) => {
        if (request.signal.aborted) return;
        setRuntime(status);
        setRuntimePhase(status.ready ? "ready" : "unavailable");
      })
      .catch((error: unknown) => {
        if (request.signal.aborted) return;
        setRuntime(null);
        setRuntimePhase("error");
        setRuntimeError(errorMessage(error));
      });
  }, []);

  useEffect(() => {
    refreshRuntime();
    return () => runtimeRequest.current?.abort();
  }, [refreshRuntime]);

  useEffect(
    () => () => {
      operation.current?.abort();
      if (previewUrl.current) URL.revokeObjectURL(previewUrl.current);
    },
    [],
  );

  const selectVideo = (file: File | null) => {
    if (!file) return;
    if (!isSupportedVideoName(file.name)) {
      setWorkflowPhase("error");
      setWorkflowError("Supported formats are MP4, MOV, MKV, AVI, WebM, and M4V.");
      return;
    }

    const nextUrl = URL.createObjectURL(file);
    const previousUrl = previewUrl.current;
    previewUrl.current = nextUrl;
    setVideo({ file, previewUrl: nextUrl, duration: null });
    if (previousUrl) URL.revokeObjectURL(previousUrl);
    setWorkflowPhase("idle");
    setWorkflowError(null);
    setImportError(null);
    setJob(null);
    setResult(null);
  };

  const configureRuntime = async () => {
    setSetupBusy(true);
    setRuntimeError(null);
    try {
      const setup = await setupGvhmrInDesktop();
      if (setup.action === "configured") refreshRuntime();
    } catch (error) {
      setRuntimePhase("error");
      setRuntimeError(errorMessage(error));
    } finally {
      setSetupBusy(false);
    }
  };

  const run = async () => {
    if (!video || runtimePhase !== "ready") return;
    let parsedFocalLength: number | undefined;
    try {
      parsedFocalLength = parseOptionalFocalLength(focalLength);
    } catch (error) {
      setWorkflowPhase("error");
      setWorkflowError(errorMessage(error));
      return;
    }

    operation.current?.abort();
    const request = new AbortController();
    operation.current = request;
    setWorkflowPhase("uploading");
    setWorkflowError(null);
    setImportError(null);
    setJob(null);
    setResult(null);
    try {
      const jobId = await startVideoToMotion(
        { video: video.file, staticCamera, focalLength: parsedFocalLength },
        request.signal,
      );
      if (request.signal.aborted) return;
      setWorkflowPhase("running");
      const motion = await waitForVideoToMotion(jobId, {
        signal: request.signal,
        onUpdate: (snapshot) => {
          if (!request.signal.aborted) setJob(snapshot);
        },
      });
      if (request.signal.aborted) return;
      const stageMotion = toStageMotionPayload(motion);
      if (!stageMotion) {
        throw new Error("The generated motion has no preview data.");
      }
      setResult(summarizeMotionResult(motion, video.file.name));
      onMotionLoaded?.(stageMotion);
      setWorkflowPhase("done");
    } catch (error) {
      if (request.signal.aborted) return;
      setWorkflowPhase("error");
      setWorkflowError(errorMessage(error));
    } finally {
      if (operation.current === request) operation.current = null;
    }
  };

  const importResult = async (file: File | null) => {
    if (!file || busy) return;
    if (!isGvhmrResultName(file.name)) {
      setImportError("A GVHMR result must be a .pt file.");
      return;
    }

    operation.current?.abort();
    const request = new AbortController();
    operation.current = request;
    setImporting(true);
    setImportJob(null);
    setImportError(null);
    setWorkflowError(null);
    try {
      const payload = await uploadMotion([file], {
        profile: "mimic",
        signal: request.signal,
        onUpdate: (snapshot) => {
          if (!request.signal.aborted) setImportJob(snapshot);
        },
      });
      if (request.signal.aborted) return;
      const stageMotion = toStageImportedMotionPayload(payload);
      if (!stageMotion) {
        throw new Error("The imported motion has no preview data.");
      }
      setResult(summarizeMotionResult(payload, file.name));
      onMotionLoaded?.(stageMotion);
      setWorkflowPhase("done");
    } catch (error) {
      if (request.signal.aborted) return;
      setImportError(errorMessage(error));
    } finally {
      if (operation.current === request) {
        operation.current = null;
        if (!request.signal.aborted) setImporting(false);
      }
    }
  };

  const runtimeLabel =
    runtimePhase === "checking"
      ? "Checking"
      : runtimePhase === "ready"
        ? `Ready · ${runtime?.runtime === "docker" ? "Docker" : "Local"}`
        : runtimePhase === "unavailable"
          ? "Unavailable"
          : "Check failed";
  const runtimeDot =
    runtimePhase === "ready"
      ? "bg-[#16845b]"
      : runtimePhase === "checking"
        ? "bg-[#c98413]"
        : "bg-[#c53c3c]";
  const missing = runtime?.missing ?? [];
  const progress = workflowPhase === "uploading" ? 0 : (job?.progress ?? 0);
  const canRun = Boolean(video) && runtimePhase === "ready" && !busy;
  const pipelineIndex =
    importing || workflowPhase === "done"
      ? 3
      : generating || (video && runtimePhase === "ready")
        ? 2
        : video
          ? 1
          : 0;

  return (
    <InspectorPage title="Video → Motion">
      <WorkflowPipeline
        label="Video to Motion pipeline"
        steps={pipeline}
        activeIndex={pipelineIndex}
      />
      <div className="flex shrink-0 flex-col">
        <WorkflowStep
          title="1. Select video"
          status={video ? video.file.name : "Not selected"}
          defaultOpen
        >
          <div
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              if (!busy) selectVideo(event.dataTransfer.files[0] ?? null);
            }}
          >
            <ImportDropzone
              label="Video import area"
              icon="/icons/sidebar/video-to-motion.svg"
              title={video?.file.name ?? "Drop a video file here"}
              hint={video ? formatFileSize(video.file.size) : "MP4, MOV, MKV, AVI, WebM or M4V"}
            >
              <input
                ref={fileInput}
                className="hidden"
                type="file"
                accept="video/mp4,video/quicktime,video/x-matroska,video/x-msvideo,video/webm,.m4v"
                onChange={(event) => {
                  selectVideo(event.currentTarget.files?.[0] ?? null);
                  event.currentTarget.value = "";
                }}
                disabled={busy}
              />
              <Button size="sm" onClick={() => fileInput.current?.click()} disabled={busy}>
                Choose video
              </Button>
            </ImportDropzone>
          </div>
          {video && (
            <section className="mt-3 grid gap-2" aria-label="Selected video">
              <video
                key={video.previewUrl}
                className="aspect-video w-full rounded-md bg-black object-contain"
                src={video.previewUrl}
                controls
                preload="metadata"
                aria-label="Selected video preview"
                onLoadedMetadata={(event) => {
                  const duration = Number.isFinite(event.currentTarget.duration)
                    ? event.currentTarget.duration
                    : null;
                  setVideo((current) =>
                    current?.previewUrl === video.previewUrl
                      ? { ...current, duration }
                      : current,
                  );
                }}
              />
              <div className="flex min-w-0 items-center justify-between gap-3">
                <div className="min-w-0 text-[11px] leading-relaxed">
                  <p className="truncate font-semibold text-foreground" title={video.file.name}>
                    {video.file.name}
                  </p>
                  <p className="truncate text-muted-foreground">
                    {[
                      formatFileSize(video.file.size),
                      video.file.type || "Video",
                      video.duration === null ? null : `${video.duration.toFixed(1)} s`,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                </div>
                <Button size="sm" onClick={() => fileInput.current?.click()} disabled={busy}>
                  Replace
                </Button>
              </div>
            </section>
          )}
        </WorkflowStep>

        <WorkflowStep title="2. Environment" status={runtimeLabel} defaultOpen>
          <div className="grid gap-2.5">
            <div className="flex items-center gap-2 text-xs" role="status" aria-live="polite">
              <span className={`size-2 shrink-0 rounded-full ${runtimeDot}`} aria-hidden="true" />
              <span className="min-w-0 flex-1 text-muted-foreground">
                GVHMR · official weights
              </span>
              {canSetupGvhmrInDesktop() && runtimePhase !== "ready" && (
                <Button
                  size="sm"
                  onClick={() => void configureRuntime()}
                  disabled={runtimePhase === "checking" || busy || setupBusy}
                >
                  {setupBusy ? "Setting up…" : "Set up"}
                </Button>
              )}
              <Button
                size="sm"
                onClick={refreshRuntime}
                disabled={runtimePhase === "checking" || busy || setupBusy}
              >
                Refresh
              </Button>
            </div>
            <Field label="Weights">
              <select className={fieldClass} defaultValue="official" disabled>
                <option value="official">Official weights</option>
              </select>
            </Field>
            {(runtimeError || missing.length > 0) && (
              <div className="rounded-md border border-[#efcccc] bg-[#fff5f4] px-2.5 py-2 text-[11px] leading-relaxed text-[#8c2929] break-all" role="alert">
                <p>{runtimeError ?? missing[0]}</p>
                {!runtimeError && missing.length > 1 && (
                  <details className="mt-1">
                    <summary className="w-fit cursor-pointer font-semibold">
                      {missing.length - 1} more checks
                    </summary>
                    <ul className="mt-1.5 grid list-disc gap-1 pl-4">
                      {missing.slice(1).map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            )}
          </div>
        </WorkflowStep>

        <WorkflowStep
          title="3. Generate"
          status={generating ? `${Math.round(progress * 100)}%` : workflowPhase === "done" ? "Done" : "Waiting"}
          defaultOpen
        >
          <form
            className="grid gap-2.5"
            onSubmit={(event) => {
              event.preventDefault();
              void run();
            }}
          >
            <label className="flex min-h-8 items-center justify-between gap-3 text-xs font-medium text-foreground">
              Static camera
              <input
                type="checkbox"
                checked={staticCamera}
                onChange={(event) => setStaticCamera(event.target.checked)}
                disabled={busy}
                className="size-4 accent-primary"
              />
            </label>
            <Field label="Focal length">
              <input
                className={fieldClass}
                type="number"
                inputMode="numeric"
                min="1"
                step="1"
                placeholder="Auto"
                value={focalLength}
                onChange={(event) => setFocalLength(event.target.value)}
                disabled={busy}
              />
            </Field>
            <Button type="submit" variant="primary" size="sm" disabled={!canRun}>
              {workflowPhase === "uploading"
                ? "Uploading…"
                : workflowPhase === "running"
                  ? "Generating…"
                  : "Start GVHMR"}
            </Button>
            {generating && (
              <div className="grid gap-1.5 text-[11px] text-muted-foreground" role="status">
                <div className="flex items-center justify-between gap-3">
                  <span className="min-w-0 truncate">{job?.message ?? "Sending source video"}</span>
                  <strong className="shrink-0 text-foreground">
                    {Math.round(progress * 100)}%
                  </strong>
                </div>
                <progress className="h-1.5 w-full accent-primary" value={progress} max="1" />
              </div>
            )}
            {workflowPhase === "error" && workflowError && (
              <p className="rounded-md border border-[#efcccc] bg-[#fff5f4] px-2.5 py-2 text-[11px] leading-relaxed text-[#8c2929] break-words" role="alert">
                {workflowError}
              </p>
            )}
          </form>
        </WorkflowStep>

        <WorkflowStep
          title="4. Motion result"
          status={
            importing
              ? `${Math.round((importJob?.progress ?? 0) * 100)}%`
              : result
                ? "Motion Library"
                : "Empty"
          }
          defaultOpen
        >
          <input
            ref={resultInput}
            className="hidden"
            type="file"
            accept=".pt"
            aria-label="Select an existing GVHMR result"
            disabled={busy}
            onChange={(event) => {
              void importResult(event.currentTarget.files?.[0] ?? null);
              event.currentTarget.value = "";
            }}
          />
          <div className="mb-2.5 grid gap-2">
            <Button
              size="sm"
              onClick={() => resultInput.current?.click()}
              disabled={busy}
            >
              {importing ? "Importing…" : "Import existing GVHMR result (.pt)"}
            </Button>
            {importing && (
              <div className="grid gap-1.5 text-[11px] text-muted-foreground" role="status">
                <div className="flex items-center justify-between gap-3">
                  <span className="min-w-0 truncate">
                    {importJob?.message ?? "Uploading motion result"}
                  </span>
                  <strong className="shrink-0 text-foreground">
                    {Math.round((importJob?.progress ?? 0) * 100)}%
                  </strong>
                </div>
                <progress
                  className="h-1.5 w-full accent-primary"
                  value={importJob?.progress ?? 0}
                  max="1"
                />
              </div>
            )}
            {importError && (
              <p className="rounded-md border border-[#efcccc] bg-[#fff5f4] px-2.5 py-2 text-[11px] leading-relaxed text-[#8c2929] break-words" role="alert">
                {importError}
              </p>
            )}
          </div>
          {result ? (
            <div className="grid gap-2">
              <p className="truncate text-xs font-semibold text-foreground" title={result.name}>
                {result.name}
              </p>
              <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-md bg-border-subtle text-[11px]">
                {[
                  ["Frames", formatMetric(result.frames)],
                  ["Duration", formatMetric(result.duration, " s")],
                  ["Frame rate", formatMetric(result.framerate, " fps")],
                  ["Library", result.linkedFolder ?? "Registered"],
                ].map(([label, value]) => (
                  <div key={label} className="min-w-0 bg-surface p-2.5">
                    <dt className="text-muted-foreground">{label}</dt>
                    <dd className="mt-0.5 truncate font-semibold text-foreground" title={value}>
                      {value}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              Completed motion will be registered in the Motion Library.
            </p>
          )}
        </WorkflowStep>
      </div>
    </InspectorPage>
  );
}
