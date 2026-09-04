import { useCallback, useEffect, useRef, useState } from "react";

import {
  formatFileSize,
  getGvhmrRuntimeStatus,
  isSupportedVideoName,
  parseOptionalFocalLength,
  startVideoToMotion,
  summarizeMotionResult,
  waitForVideoToMotion,
  type GvhmrRuntimeStatus,
  type MotionResultSummary,
  type VideoToMotionJob,
} from "./api";

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

export function VideoToMotionPage() {
  const [runtimePhase, setRuntimePhase] = useState<RuntimePhase>("checking");
  const [runtime, setRuntime] = useState<GvhmrRuntimeStatus | null>(null);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [video, setVideo] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [staticCamera, setStaticCamera] = useState(true);
  const [focalLength, setFocalLength] = useState("");
  const [workflowPhase, setWorkflowPhase] = useState<WorkflowPhase>("idle");
  const [job, setJob] = useState<VideoToMotionJob | null>(null);
  const [workflowError, setWorkflowError] = useState<string | null>(null);
  const [result, setResult] = useState<MotionResultSummary | null>(null);
  const runtimeRequestRef = useRef<AbortController | null>(null);
  const operationRef = useRef<AbortController | null>(null);

  const busy = workflowPhase === "uploading" || workflowPhase === "running";

  const refreshRuntime = useCallback(() => {
    runtimeRequestRef.current?.abort();
    const request = new AbortController();
    runtimeRequestRef.current = request;
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
      })
      .finally(() => {
        if (runtimeRequestRef.current === request) {
          runtimeRequestRef.current = null;
        }
      });
  }, []);

  useEffect(() => {
    refreshRuntime();
    return () => runtimeRequestRef.current?.abort();
  }, [refreshRuntime]);

  useEffect(() => {
    if (!video) {
      setPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(video);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [video]);

  useEffect(() => () => operationRef.current?.abort(), []);

  const resetOutcome = () => {
    setWorkflowPhase("idle");
    setJob(null);
    setWorkflowError(null);
    setResult(null);
  };

  const selectVideo = (file: File | null) => {
    if (!file) return;
    if (!isSupportedVideoName(file.name)) {
      setVideo(null);
      setWorkflowPhase("error");
      setWorkflowError(
        "Supported formats are MP4, MOV, MKV, AVI, WebM, and M4V.",
      );
      setResult(null);
      return;
    }
    setVideo(file);
    resetOutcome();
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

    const operation = new AbortController();
    operationRef.current?.abort();
    operationRef.current = operation;
    setWorkflowPhase("uploading");
    setJob(null);
    setWorkflowError(null);
    setResult(null);

    try {
      const jobId = await startVideoToMotion(
        {
          video,
          staticCamera,
          focalLength: parsedFocalLength,
        },
        operation.signal,
      );
      if (operation.signal.aborted) return;
      setWorkflowPhase("running");
      const motion = await waitForVideoToMotion(jobId, {
        signal: operation.signal,
        onUpdate: (snapshot) => {
          if (!operation.signal.aborted) setJob(snapshot);
        },
      });
      if (operation.signal.aborted) return;
      setResult(summarizeMotionResult(motion, video.name));
      setWorkflowPhase("done");
    } catch (error) {
      if (operation.signal.aborted) return;
      setWorkflowPhase("error");
      setWorkflowError(errorMessage(error));
    } finally {
      if (operationRef.current === operation) operationRef.current = null;
    }
  };

  const runtimeLabel =
    runtimePhase === "checking"
      ? "Checking local GVHMR"
      : runtimePhase === "ready"
        ? `GVHMR ready · ${runtime?.runtime === "docker" ? "Docker" : "Local"} · official weights`
        : runtimePhase === "unavailable"
          ? "GVHMR unavailable"
          : "GVHMR status check failed";
  const progress = workflowPhase === "uploading" ? 0 : (job?.progress ?? 0);
  const canRun = Boolean(video) && runtimePhase === "ready" && !busy;
  const missingRuntimeChecks = runtime?.missing ?? [];

  return (
    <main
      className="app-content video-to-motion-page"
      aria-labelledby="video-to-motion-title"
    >
      <header className="workflow-header">
        <div>
          <h1 id="video-to-motion-title">Video → Motion</h1>
          <p>GVHMR · official weights</p>
        </div>
        <div
          className="runtime-status"
          data-state={runtimePhase}
          role="status"
          aria-live="polite"
        >
          <span className="runtime-status-dot" aria-hidden="true" />
          <span>{runtimeLabel}</span>
          <button
            type="button"
            className="quiet-button"
            onClick={refreshRuntime}
            disabled={runtimePhase === "checking" || busy}
          >
            Refresh
          </button>
        </div>
      </header>

      {(runtimePhase === "unavailable" || runtimePhase === "error") && (
        <div className="runtime-detail" role="alert">
          <span>
            {runtimeError || missingRuntimeChecks[0] || "GVHMR is not ready."}
          </span>
          {!runtimeError && missingRuntimeChecks.length > 1 && (
            <details>
              <summary>{missingRuntimeChecks.length - 1} more checks</summary>
              <ul>
                {missingRuntimeChecks.slice(1).map((missing) => (
                  <li key={missing}>{missing}</li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}

      <div className="video-workflow-body">
        <form
          className="video-controls"
          onSubmit={(event) => {
            event.preventDefault();
            void run();
          }}
        >
          <section className="control-section" aria-labelledby="source-heading">
            <div className="section-heading-row">
              <h2 id="source-heading">Source</h2>
              {video && <span>{formatFileSize(video.size)}</span>}
            </div>
            <label className="video-file-picker" data-has-file={Boolean(video)}>
              <input
                type="file"
                accept="video/mp4,video/quicktime,video/x-matroska,video/x-msvideo,video/webm,.m4v"
                onChange={(event) => selectVideo(event.target.files?.[0] ?? null)}
                disabled={busy}
              />
              <span className="file-picker-title">
                {video ? video.name : "Choose video"}
              </span>
              <span className="file-picker-meta">
                {video ? "Selected video" : "MP4, MOV, MKV, AVI, WebM or M4V"}
              </span>
            </label>
          </section>

          <section className="control-section" aria-labelledby="settings-heading">
            <h2 id="settings-heading">Capture</h2>
            <label className="setting-row">
              <span>
                <strong>Static camera</strong>
                <small>Skip visual odometry</small>
              </span>
              <input
                type="checkbox"
                checked={staticCamera}
                onChange={(event) => setStaticCamera(event.target.checked)}
                disabled={busy}
              />
            </label>
            <label className="field-label" htmlFor="gvhmr-focal-length">
              <span>Focal length</span>
              <span className="field-unit">mm · optional</span>
            </label>
            <input
              id="gvhmr-focal-length"
              className="number-input"
              type="number"
              inputMode="numeric"
              min="1"
              step="1"
              placeholder="Automatic"
              value={focalLength}
              onChange={(event) => setFocalLength(event.target.value)}
              disabled={busy}
            />
          </section>

          <section className="control-section weights-section">
            <div className="setting-row read-only-setting">
              <span>
                <strong>Model weights</strong>
                <small>Official GVHMR checkpoint</small>
              </span>
              <span className="official-badge">Official</span>
            </div>
          </section>

          <button
            type="submit"
            className="primary-action"
            disabled={!canRun}
          >
            {workflowPhase === "uploading"
              ? "Uploading…"
              : workflowPhase === "running"
                ? "Generating…"
                : "Generate motion"}
          </button>
        </form>

        <section className="video-output" aria-label="Video-to-motion output">
          <div className="video-preview">
            {previewUrl ? (
              <video key={previewUrl} src={previewUrl} controls preload="metadata" />
            ) : (
              <div className="video-empty-state">No video selected</div>
            )}
          </div>

          <div className="job-panel" data-phase={workflowPhase}>
            {workflowPhase === "idle" && (
              <div className="job-placeholder">Ready for a video</div>
            )}

            {(workflowPhase === "uploading" || workflowPhase === "running") && (
              <div className="job-running" role="status" aria-live="polite">
                <div className="job-title-row">
                  <div>
                    <span className="job-eyebrow">
                      {workflowPhase === "uploading" ? "Upload" : "GVHMR job"}
                    </span>
                    <h2>
                      {workflowPhase === "uploading"
                        ? "Sending source video"
                        : job?.message || "Generating motion"}
                    </h2>
                  </div>
                  <strong>{Math.round(progress * 100)}%</strong>
                </div>
                <progress value={progress} max="1" aria-label="Job progress" />
                {job?.id && <code>{job.id}</code>}
              </div>
            )}

            {workflowPhase === "error" && (
              <div className="job-error" role="alert">
                <span>Generation failed</span>
                <p>{workflowError}</p>
              </div>
            )}

            {workflowPhase === "done" && result && (
              <div className="job-result" aria-live="polite">
                <div className="job-title-row">
                  <div>
                    <span className="job-eyebrow">Motion ready</span>
                    <h2>{result.name}</h2>
                  </div>
                  <span className="complete-badge">Motion Library</span>
                </div>
                <dl className="result-metrics">
                  <div>
                    <dt>Frames</dt>
                    <dd>{formatMetric(result.frames)}</dd>
                  </div>
                  <div>
                    <dt>Duration</dt>
                    <dd>{formatMetric(result.duration, " s")}</dd>
                  </div>
                  <div>
                    <dt>Frame rate</dt>
                    <dd>{formatMetric(result.framerate, " fps")}</dd>
                  </div>
                  <div>
                    <dt>Token</dt>
                    <dd>{result.token || "--"}</dd>
                  </div>
                </dl>
              </div>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}
