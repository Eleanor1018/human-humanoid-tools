import { useCallback, useEffect, useRef, useState } from "react";

import { Field, fieldClass } from "@/components/Field";
import { ImportDropzone } from "@/components/ImportDropzone";
import { InspectorPage } from "@/components/Inspector";
import { Button } from "@/components/ui/button";
import { WorkflowPipeline, WorkflowStep } from "@/components/WorkflowSteps";

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
  type VideoToMotionJob,
} from "./api";

const pipeline = ["Select Video", "Environment", "Generate", "Motion Result"];

type RuntimePhase = "checking" | "ready" | "unavailable" | "error";
type WorkflowPhase = "idle" | "uploading" | "running" | "done" | "error";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatMetric(value: number | null, suffix = ""): string {
  if (value === null) return "--";
  const display = Number.isInteger(value) ? String(value) : value.toFixed(2);
  return `${display}${suffix}`;
}

export function VideoToMotionView() {
  const [runtimePhase, setRuntimePhase] = useState<RuntimePhase>("checking");
  const [runtime, setRuntime] = useState<GvhmrRuntimeStatus | null>(null);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [video, setVideo] = useState<File | null>(null);
  const [staticCamera, setStaticCamera] = useState(true);
  const [focalLength, setFocalLength] = useState("");
  const [workflowPhase, setWorkflowPhase] = useState<WorkflowPhase>("idle");
  const [job, setJob] = useState<VideoToMotionJob | null>(null);
  const [workflowError, setWorkflowError] = useState<string | null>(null);
  const [result, setResult] = useState<MotionResultSummary | null>(null);
  const [setupBusy, setSetupBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const runtimeRequest = useRef<AbortController | null>(null);
  const operation = useRef<AbortController | null>(null);
  const busy = workflowPhase === "uploading" || workflowPhase === "running";

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

  useEffect(() => () => operation.current?.abort(), []);

  const selectVideo = (file: File | null) => {
    if (!file) return;
    if (!isSupportedVideoName(file.name)) {
      setVideo(null);
      setWorkflowPhase("error");
      setWorkflowError("Supported formats are MP4, MOV, MKV, AVI, WebM, and M4V.");
      setResult(null);
      return;
    }
    setVideo(file);
    setWorkflowPhase("idle");
    setWorkflowError(null);
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
    setJob(null);
    setResult(null);
    try {
      const jobId = await startVideoToMotion(
        { video, staticCamera, focalLength: parsedFocalLength },
        request.signal,
      );
      if (request.signal.aborted) return;
      setWorkflowPhase("running");
      const motion = await waitForVideoToMotion(jobId, {
        signal: request.signal,
        onUpdate: (snapshot) => setJob(snapshot),
      });
      if (request.signal.aborted) return;
      setResult(summarizeMotionResult(motion, video.name));
      setWorkflowPhase("done");
    } catch (error) {
      if (request.signal.aborted) return;
      setWorkflowPhase("error");
      setWorkflowError(errorMessage(error));
    } finally {
      if (operation.current === request) operation.current = null;
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
    workflowPhase === "done"
      ? 3
      : busy || (video && runtimePhase === "ready")
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
          status={video ? video.name : "Not selected"}
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
              title={video?.name ?? "Drop a video file here"}
              hint={video ? formatFileSize(video.size) : "MP4, MOV, MKV, AVI, WebM or M4V"}
            >
              <input
                ref={fileInput}
                className="sr-only"
                type="file"
                accept="video/mp4,video/quicktime,video/x-matroska,video/x-msvideo,video/webm,.m4v"
                onChange={(event) => selectVideo(event.target.files?.[0] ?? null)}
                disabled={busy}
              />
              <Button size="sm" onClick={() => fileInput.current?.click()} disabled={busy}>
                Choose video
              </Button>
            </ImportDropzone>
          </div>
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
          status={busy ? `${Math.round(progress * 100)}%` : workflowPhase === "done" ? "Done" : "Waiting"}
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
            {busy && (
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

        <WorkflowStep title="4. Motion result" status={result ? "Motion Library" : "Empty"} defaultOpen>
          {result ? (
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
