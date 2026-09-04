export const SUPPORTED_VIDEO_EXTENSIONS = [
  "mp4",
  "mov",
  "mkv",
  "avi",
  "webm",
  "m4v",
] as const;

export interface GvhmrRuntimeStatus {
  readonly ready: boolean;
  readonly missing: readonly string[];
  readonly runtime?: "local" | "docker" | string;
  readonly root?: string | null;
  readonly python?: string | null;
  readonly uses_official_weights?: boolean;
}

export interface MotionResult {
  readonly name?: string;
  readonly token?: string;
  readonly positions?: readonly unknown[];
  readonly playback_frames?: number;
  readonly num_frames_total?: number;
  readonly playback_duration?: number;
  readonly duration?: number;
  readonly framerate?: number;
  readonly sample_rate?: number;
  readonly linked_folder?: string;
}

export interface MotionResultSummary {
  readonly name: string;
  readonly token: string | null;
  readonly frames: number | null;
  readonly duration: number | null;
  readonly framerate: number | null;
  readonly linkedFolder: string | null;
}

export interface VideoToMotionJob {
  readonly id: string;
  readonly kind: string;
  readonly status: string;
  readonly progress: number;
  readonly message?: string;
  readonly error?: string | null;
  readonly result?: MotionResult | null;
  readonly scope?: "current_session" | "persistent";
}

export interface DesktopGvhmrSetupResult {
  readonly action: "cancelled" | "configured" | "guide-opened";
}

interface DesktopGvhmrBridge {
  setupGvhmr(): Promise<DesktopGvhmrSetupResult>;
}

type Fetcher = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function desktopBridge(host: unknown = globalThis): DesktopGvhmrBridge | null {
  const candidate = (host as { hhtoolsDesktop?: Partial<DesktopGvhmrBridge> })
    .hhtoolsDesktop;
  return typeof candidate?.setupGvhmr === "function"
    ? (candidate as DesktopGvhmrBridge)
    : null;
}

async function responseError(response: Response): Promise<Error> {
  let message = `${response.status} ${response.statusText}`.trim();
  try {
    const body = (await response.json()) as { detail?: unknown };
    if (typeof body.detail === "string" && body.detail.trim()) {
      message = body.detail;
    }
  } catch {
    // Keep the HTTP status when the response has no JSON error body.
  }
  return new Error(message || "Request failed");
}

async function requestJson<T>(
  url: string,
  init: RequestInit,
  fetcher: Fetcher,
): Promise<T> {
  const response = await fetcher(url, init);
  if (!response.ok) throw await responseError(response);
  return (await response.json()) as T;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      globalThis.clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = globalThis.setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function isSupportedVideoName(name: string): boolean {
  const separator = name.lastIndexOf(".");
  if (separator < 0) return false;
  const extension = name.slice(separator + 1).toLowerCase();
  return (SUPPORTED_VIDEO_EXTENSIONS as readonly string[]).includes(extension);
}

export function parseOptionalFocalLength(value: string): number | undefined {
  const normalized = value.trim();
  if (!normalized) return undefined;
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error("Focal length must be a positive integer.");
  }
  return parsed;
}

export function boundedProgress(value: unknown): number {
  const parsed = finiteNumber(value);
  return parsed === null ? 0 : Math.max(0, Math.min(1, parsed));
}

export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const exponent = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  const value = bytes / 1024 ** exponent;
  return `${value >= 10 || exponent === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[exponent]}`;
}

export function summarizeMotionResult(
  result: MotionResult,
  fallbackName: string,
): MotionResultSummary {
  return {
    name:
      typeof result.name === "string" && result.name.trim()
        ? result.name
        : fallbackName,
    token:
      typeof result.token === "string" && result.token ? result.token : null,
    frames:
      finiteNumber(result.num_frames_total) ??
      finiteNumber(result.playback_frames) ??
      (Array.isArray(result.positions) ? result.positions.length : null),
    duration:
      finiteNumber(result.playback_duration) ?? finiteNumber(result.duration),
    framerate:
      finiteNumber(result.framerate) ?? finiteNumber(result.sample_rate),
    linkedFolder:
      typeof result.linked_folder === "string" && result.linked_folder
        ? result.linked_folder
        : null,
  };
}

export function canSetupGvhmrInDesktop(host: unknown = globalThis): boolean {
  return desktopBridge(host) !== null;
}

export async function setupGvhmrInDesktop(
  host: unknown = globalThis,
): Promise<DesktopGvhmrSetupResult> {
  const bridge = desktopBridge(host);
  if (!bridge) throw new Error("GVHMR setup is available in the desktop app only.");
  return bridge.setupGvhmr();
}

export async function getGvhmrRuntimeStatus(
  signal: AbortSignal,
  fetcher: Fetcher = fetch,
): Promise<GvhmrRuntimeStatus> {
  const status = await requestJson<GvhmrRuntimeStatus>(
    "/api/video-to-motion/status",
    { signal },
    fetcher,
  );
  return {
    ...status,
    ready: status.ready === true,
    missing: Array.isArray(status.missing)
      ? status.missing.filter((item): item is string => typeof item === "string")
      : [],
  };
}

export async function startVideoToMotion(
  input: {
    video: File;
    staticCamera: boolean;
    focalLength?: number;
  },
  signal: AbortSignal,
  fetcher: Fetcher = fetch,
): Promise<string> {
  const query = new URLSearchParams({
    static_cam: String(input.staticCamera),
  });
  if (input.focalLength !== undefined) {
    query.set("f_mm", String(input.focalLength));
  }

  const form = new FormData();
  form.append("files", input.video, input.video.name);
  const response = await requestJson<{ job_id?: unknown }>(
    `/api/video-to-motion/upload?${query.toString()}`,
    { method: "POST", body: form, signal },
    fetcher,
  );
  if (typeof response.job_id !== "string" || !response.job_id) {
    throw new Error("The server did not return a job ID.");
  }
  return response.job_id;
}

export async function waitForVideoToMotion(
  jobId: string,
  options: {
    signal: AbortSignal;
    onUpdate(job: VideoToMotionJob): void;
    pollIntervalMs?: number;
  },
  fetcher: Fetcher = fetch,
): Promise<MotionResult> {
  const interval = Math.max(0, options.pollIntervalMs ?? 500);
  for (;;) {
    const response = await requestJson<VideoToMotionJob>(
      `/api/job/${encodeURIComponent(jobId)}`,
      { signal: options.signal },
      fetcher,
    );
    const job = { ...response, progress: boundedProgress(response.progress) };
    if (job.kind !== "video_to_motion") {
      throw new Error(`Job ${job.id} has kind ${job.kind}; expected video_to_motion.`);
    }

    if (job.status === "done") {
      if (job.scope === "persistent") {
        throw new Error("This completed job no longer has a live motion result.");
      }
      if (!job.result) throw new Error("The job completed without a motion result.");
      return job.result;
    }
    if (["error", "failed", "cancelled"].includes(job.status)) {
      throw new Error(job.error || "Video-to-motion failed.");
    }
    if (job.status !== "pending" && job.status !== "running") {
      throw new Error(`Job ${job.id} returned an unknown status.`);
    }
    options.onUpdate(job);
    await delay(interval, options.signal);
  }
}
