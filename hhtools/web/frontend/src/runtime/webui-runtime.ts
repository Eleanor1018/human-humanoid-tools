/**
 * HHTools compatibility domain runtime, loaded only after React has committed
 * the stable DOM ports declared by Workbench.
 *
 * This module owns same-origin FastAPI/job orchestration, the shared Three.js
 * stage and timeline, H2R/R2R/Batch/Video-to-Motion sessions, and the remaining
 * imperative DOM adapters. IK, FK, dataset analysis, and video inference stay on
 * the backend; the browser uploads, polls, coordinates, and visualizes results.
 *
 * New UI state belongs in React services/components. Until each domain is moved,
 * typed window events and `window.__hhApp` are the explicit migration seams.
 */


/** Parse a positive FPS from a number input, or ``null`` to mean “use default”. */
function parseOptionalFps(el: HTMLInputElement | null): number | null {
  if (!el) return null;
  const v = parseFloat(el.value);
  return v > 0 && Number.isFinite(v) ? v : null;
}

/** Non-negative seconds for export window; empty → null (natural bound). */
function parseOptionalTime(el: HTMLInputElement | null): number | null {
  if (!el || el.value === "" || el.value == null) return null;
  const v = parseFloat(el.value);
  return Number.isFinite(v) && v >= 0 ? v : null;
}

function appendExportTimeParams(url: string, tStartElId: string, tEndElId: string): string {
  const t0 = parseOptionalTime(document.getElementById(tStartElId) as HTMLInputElement);
  const t1 = parseOptionalTime(document.getElementById(tEndElId) as HTMLInputElement);
  if (t0 != null) url += `&t_start=${encodeURIComponent(t0)}`;
  if (t1 != null) url += `&t_end=${encodeURIComponent(t1)}`;
  return url;
}

/** Create a text-only element for values that may originate from files or API responses. */
function textElement<Tag extends keyof HTMLElementTagNameMap>(
  tag: Tag,
  className: string,
  value: unknown,
): HTMLElementTagNameMap[Tag] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  element.textContent = String(value ?? "");
  return element;
}

/** Render a plain message without allowing user-controlled strings to become markup. */
function renderTextMessage(container: HTMLElement, message: unknown): void {
  container.replaceChildren(textElement("div", "hint", message));
  const messageElement = container.firstElementChild as HTMLElement | null;
  if (messageElement) messageElement.style.padding = "12px";
}

function runtimeText(en: string, zh: string): string {
  return document.documentElement.lang.toLowerCase().startsWith("zh") ? zh : en;
}

function renderSpinnerStatus(container: HTMLElement | null, message: unknown): void {
  if (!container) return;
  const spinner = document.createElement("span");
  spinner.className = "spin";
  container.replaceChildren(spinner, document.createTextNode(` ${String(message ?? "")}`));
}

function renderMetaRows(
  container: HTMLElement | null,
  rows: ReadonlyArray<readonly [unknown, unknown]>,
): void {
  if (!container) return;
  const elements = rows.map(([label, value]) => {
    const row = document.createElement("div");
    row.className = "meta-row";
    row.append(textElement("span", "k", label), textElement("span", "v", value));
    return row;
  });
  container.replaceChildren(...elements);
}

function renderStatusChip(container: HTMLElement | null, text: unknown, className = ""): void {
  if (!container) return;
  const chip = document.createElement("span");
  chip.className = `status-chip ${className}`.trim();
  chip.append(textElement("span", "dot", ""), document.createTextNode(String(text ?? "")));
  container.replaceChildren(chip);
}

type ValidationTone = "ok" | "warn" | "error";

/** Render compact, text-only validation rows without introducing an HTML injection path. */
function renderValidationSummary(
  container: HTMLElement | null,
  rows: ReadonlyArray<readonly [ValidationTone, string]>,
): void {
  if (!container) return;
  container.replaceChildren(
    ...rows.map(([tone, message]) => textElement("div", `validation-line ${tone}`, message)),
  );
}

function isPlaybackPreview(payload: PlaybackPayload | null | undefined): boolean {
  if (!payload) return false;
  const nPlay = payload.playback_frames
    ?? payload.positions?.length
    ?? payload.frames?.length
    ?? 0;
  const nTotal = payload.num_frames_total ?? nPlay;
  return nTotal > nPlay && nPlay > 0;
}

function updateRetargetFpsPlaceholder() {
  const inp = document.getElementById("rt-retarget-fps");
  if (!inp) return;
  const src = state.motion?.framerate;
  inp.placeholder = src
    ? runtimeText(`Blank = source ${src.toFixed(0)} fps`, `留空 = 原始 ${src.toFixed(0)} fps`)
    : runtimeText("Blank = source motion frame rate", "留空 = 动作原始帧率");
}

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import {
  angleForDisplay,
  angleFromDisplay,
  calibrationJointMatches,
  classifyCalibrationJoint,
  formatCalibrationAngle,
} from "./calibration-editor";
import { initTutorial } from "./tutorial";
import {
  loadWorkspacePreferences,
  updateWorkspacePreferences,
} from "./workspace-preferences";
import {
  curatedRobotLibraryItem,
  DEFAULT_ROBOT_LIBRARY_ICON,
  robotLibraryIcon,
} from "./robot-library-catalog";
import { sortRobotLibrarySummaries } from "./robot-library-order";
import {
  H2rStageDisplayPublisher,
  projectH2rPhysicalVisibility,
  projectH2rStageDisplaySnapshot,
  type H2rStageDisplayListener,
  type H2rStageDisplaySnapshot,
  type H2rStageLayerId,
} from "./h2r-stage-display";
import {
  projectR2rStageSurface,
  type R2rStageSurfaceFacts,
  type R2rStageSurfaceSnapshot,
} from "./r2r-stage-surface";
import type {
  JobConfigResponse,
  JobListResponse,
} from "@/domain/jobs/job";
import type {
  LibraryEntry,
  MotionCategory,
  MotionPayload,
  SceneObjectPayload,
  ScenePayload,
  TerrainPayload,
  Vec3,
} from "@/domain/motion/common/motion";
import { ThreeResourceDisposer } from "@/platform/graphics/common/three-resource-disposer";
import type { AsyncStageViewLoadResult } from "./stage/async-stage-view-load-result";
import { BakedMeshView } from "./stage/baked-mesh-view";
import {
  calibrationMotionLoadDisposition,
  type CalibrationBootstrapResult,
} from "./stage/calibration-motion-load-disposition";
import { CoalescedAsyncFrameTask } from "./stage/coalesced-async-frame-task";
import {
  LatestAsyncAttemptOwner,
  type LatestAsyncAttempt,
} from "./stage/latest-async-attempt-owner";
import {
  inheritedPointerGestureOrbitBaseline,
  LatestPointerGestureOwner,
  matchesOwnedPointerCaptureLoss,
  projectPointerGestureSharedState,
  type OwnedPointerGesture,
  type PointerGestureSession,
  type PointerGestureTransition,
} from "./stage/latest-pointer-gesture-owner";
import {
  effectivePlaybackDuration,
  resolvePlaybackFrame,
} from "./stage/playback-timing";
import { RobotView } from "./stage/robot-view";
import type {
  ApiClient,
  ApiGetResponse,
  ApiPostResponse,
  ApiUploadResponse,
  BatchFailure,
  BatchRetargetResult,
  CalibrationAngleUnit,
  CalibrationComparisonMode,
  CalibrationEditorCommandDetail,
  CalibrationEditorStateDetail,
  CalibrationJointRegion,
  CalibrationReferencePayload,
  ComparisonPreset,
  JobHistoryStateDetail,
  JobResponse,
  JobResult,
  JobStartResponse,
  JointWorldPayload,
  PlaybackUiState,
  PlaybackPayload,
  PlaybackView,
  RobotPayload,
  RobotSummary,
  RobotExportPreviewResult,
  RetargetResult,
  ResultDiagnostics,
  R2rBasketUploadResult,
  R2rSourceTrajectoryResult,
  RobotJointLimit,
  RobotTrajectoryPayload,
  UploadFile,
  WorkflowNodeState,
  WorkflowNodeStatus,
  WorkflowStateDetail,
  WorkflowId,
} from "./types";

// Legacy Views share one stateless disposal policy. Their Groups remain stable
// scene anchors, while every replaced child GPU resource is terminally
// released before the View drops its aliases.
const threeResourceDisposer = new ThreeResourceDisposer();

type ProgressCallback = (fraction: number | null, loaded: number, total: number) => void;
type JobProgressCallback = (fraction: number, message: string) => void;

interface UploadFilesXhrOptions {
  profile?: string;
  appendTo?: string;
  libraryFolderLabel?: string;
  userSourceRoot?: string;
}

type UploadFilesXhrResponse<Url extends string> =
  Url extends "/api/dataset/upload"
    ? import("./types").DatasetUploadSummary
    : Url extends `${string}upload${string}`
      ? JobStartResponse
      : Record<string, unknown>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Dispose an async result that no longer has a synchronous caller to receive a
 * cleanup error. Current-generation clear() paths still propagate aggregate
 * disposal failures; stale loader completions can only report and terminate.
 */
function disposeDetachedThreeObject(
  object: THREE.Object3D,
  context: string,
): void {
  try {
    threeResourceDisposer.disposeObject3DResources(object);
  } catch (error) {
    console.warn(context, errorMessage(error));
  }
}

interface OrbitSettingsSnapshot {
  minDistance: number;
  maxDistance: number;
  zoomSpeed: number;
}

interface ViewVisibilitySnapshot {
  skel: boolean;
  body: boolean;
  scaled: boolean;
  scaledEnv: boolean;
  env: boolean;
  robot: boolean;
  playing: boolean;
  t: number;
  playbar: boolean;
}

interface CalibrationSliderRow {
  row: HTMLElement;
  range: HTMLInputElement;
  num: HTMLInputElement;
  lo: number;
  hi: number;
  region: CalibrationJointRegion;
}

/** H2R/shared-stage session state; the R2R workflow owns an isolated state below. */
interface AppState {
  motion: MotionPayload | null;
  libraryEntry: LibraryEntry | null;
  robot: RobotPayload | null;
  reference: string | null;
  calibration: boolean;
  calibrationMode: boolean;
  calibNeedsCameraFocus: boolean;
  calibOrbitSaved: OrbitSettingsSnapshot | null;
  calibLimits: RobotJointLimit[] | null;
  calibRestore: ViewVisibilitySnapshot | null;
  exportToken: string | null;
  exportSrcFps: number | null;
  exportHasScene: boolean;
  calibQ: Record<string, number>;
  calibSliderRows: Record<string, CalibrationSliderRow>;
  calibBaselineQ: Record<string, number> | null;
  calibDraftQ: Record<string, number> | null;
  calibHasSaved: boolean;
  robotTrajectory: RobotTrajectoryPayload | null;
  robotPanelLocked: boolean;
}

// ----------------------------------------------------------------- API helpers
// FastAPI's `detail` can be a string OR (for 422 validation errors) an array of
// objects.  Flatten whatever we get into a human-readable string so the UI never
// shows the useless "[object Object]".
function apiDetailMessage(detail: unknown): string | undefined {
  let msg: string | undefined;
  if (typeof detail === "string") msg = detail;
  else if (Array.isArray(detail)) {
    msg = detail
      .map((item) => {
        if (item && typeof item === "object" && "msg" in item) return String(item.msg);
        return JSON.stringify(item);
      })
      .join("; ");
  } else if (detail && typeof detail === "object") {
    msg = "msg" in detail ? String(detail.msg) : JSON.stringify(detail);
  }
  return msg;
}

async function httpError(r: Response): Promise<Error> {
  let detail: unknown;
  try {
    detail = (await r.json()).detail;
  } catch {
    detail = null;
  }
  const msg = apiDetailMessage(detail);
  return new Error(msg || `${r.status} ${r.statusText}`);
}

/**
 * Same-origin FastAPI transport used by the compatibility runtime. Expensive
 * endpoints normally return a job id; callers then poll `/api/job/:id` before
 * committing the resulting payload to workflow and scene state.
 */
const API: ApiClient = {
  async get<Url extends string>(url: Url): Promise<ApiGetResponse<Url>> {
    const r = await fetch(url);
    if (!r.ok) throw await httpError(r);
    return await r.json() as ApiGetResponse<Url>;
  },
  async post<Url extends string>(url: Url, body?: unknown): Promise<ApiPostResponse<Url>> {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
    if (!r.ok) throw await httpError(r);
    return await r.json() as ApiPostResponse<Url>;
  },
  async upload<Url extends string>(
    url: Url,
    files: Iterable<UploadFile>,
    { profile, name }: { profile?: string; name?: string } = {},
  ): Promise<ApiUploadResponse<Url>> {
    const fd = new FormData();
    for (const f of files) fd.append("files", f, f._relpath || f.name);
    const qs = [];
    if (profile) qs.push(`profile=${encodeURIComponent(profile)}`);
    if (name) qs.push(`name=${encodeURIComponent(name)}`);
    const u = qs.length ? `${url}?${qs.join("&")}` : url;
    const r = await fetch(u, { method: "POST", body: fd });
    if (!r.ok) throw await httpError(r);
    return await r.json() as ApiUploadResponse<Url>;
  },
  async delete<Url extends string>(url: Url) {
    const r = await fetch(url, { method: "DELETE" });
    if (!r.ok) throw await httpError(r);
    return await r.json();
  },
};

/** Trigger a file save into the browser's default download folder. */
async function triggerBrowserDownload(url: string, filename?: string | null): Promise<void> {
  const r = await fetch(url);
  if (!r.ok) throw await httpError(r);
  const blob = await r.blob();
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename || "download";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// Stop the browser from navigating to / downloading a file when a drop misses
// a dropzone (the default behaviour the user hit).
["dragover", "drop"].forEach((ev) =>
  window.addEventListener(ev, (e) => { e.preventDefault(); }, false)
);

const TOAST_MS = 3200;
const TOAST_ERR_EXTRA_MS = 5000;

function toast(msg: unknown, isErr = false): void {
  const t = document.getElementById("toast");
  t.textContent = String(msg);
  t.className = isErr ? "show err" : "show";
  clearTimeout(t._timer);
  const hideMs = isErr ? TOAST_MS + TOAST_ERR_EXTRA_MS : TOAST_MS;
  t._timer = setTimeout(() => (t.className = isErr ? "err" : ""), hideMs);
}

// ---------------------------------------------------------- shared job drawer
// React owns the drawer UI. This store polls backend history and exchanges
// immutable snapshots/commands with it through typed window events.
let jobHistoryState: JobHistoryStateDetail = {
  jobs: [],
  loading: false,
  error: null,
};
let jobHistoryRefresh: Promise<void> | null = null;

function publishJobHistoryState(): void {
  window.dispatchEvent(
    new CustomEvent<JobHistoryStateDetail>("hhtools:job-history-state", {
      detail: {
        jobs: [...jobHistoryState.jobs],
        loading: jobHistoryState.loading,
        error: jobHistoryState.error,
      },
    }),
  );
}

function refreshJobHistory(): Promise<void> {
  if (jobHistoryRefresh) return jobHistoryRefresh;
  jobHistoryState = { ...jobHistoryState, loading: true, error: null };
  publishJobHistoryState();
  jobHistoryRefresh = (async () => {
    try {
      const response: JobListResponse = await API.get("/api/jobs");
      jobHistoryState = { jobs: response.jobs, loading: false, error: null };
    } catch (error) {
      jobHistoryState = {
        ...jobHistoryState,
        loading: false,
        error: errorMessage(error),
      };
    } finally {
      jobHistoryRefresh = null;
      publishJobHistoryState();
    }
  })();
  return jobHistoryRefresh;
}

async function writeClipboardText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error(runtimeText(
    "The browser blocked copying. View the configuration in developer tools.",
    "浏览器未允许复制，请在开发者工具中查看配置",
  ));
}

async function handleJobHistoryCommand(
  event: WindowEventMap["hhtools:job-history-command"],
): Promise<void> {
  const detail = event.detail;
  if (detail.command === "refresh") {
    await refreshJobHistory();
    return;
  }
  if (detail.command === "copy-config") {
    try {
      const config: JobConfigResponse = await API.get(`/api/job/${detail.jobId}/config`);
      await writeClipboardText(JSON.stringify(config, null, 2));
      toast(runtimeText("Effective job configuration copied", "任务有效配置已复制"));
    } catch (error) {
      toast(runtimeText(
        `Unable to copy configuration: ${errorMessage(error)}`,
        `复制配置失败：${errorMessage(error)}`,
      ), true);
    }
    return;
  }
  if (detail.command === "copy-cli") {
    try {
      const cli = await API.get(`/api/job/${detail.jobId}/cli`);
      if (!cli.available || !cli.command) {
        throw new Error(cli.reason || runtimeText(
          "This job has no equivalent CLI command",
          "该任务没有等价 CLI 命令",
        ));
      }
      await writeClipboardText(cli.command);
      toast(runtimeText("Equivalent CLI command copied", "等价 CLI 命令已复制"));
    } catch (error) {
      toast(runtimeText(
        `Unable to copy CLI command: ${errorMessage(error)}`,
        `复制 CLI 失败：${errorMessage(error)}`,
      ), true);
    }
    return;
  }
  if (detail.command === "download-config") {
    try {
      await triggerBrowserDownload(
        `/api/job/${detail.jobId}/config/download`,
        `hhtools-job-${detail.jobId}.json`,
      );
      toast(runtimeText("Job configuration download started", "任务配置已开始下载"));
    } catch (error) {
      toast(runtimeText(
        `Unable to save configuration: ${errorMessage(error)}`,
        `保存配置失败：${errorMessage(error)}`,
      ), true);
    }
    return;
  }
  try {
    await triggerBrowserDownload(
      `/api/job/${detail.jobId}/download`,
      detail.filename || `hhtools-${detail.jobId}.zip`,
    );
    toast(runtimeText("Job result download started", "任务结果已开始下载"));
  } catch (error) {
    toast(runtimeText(
      `Download failed: ${errorMessage(error)}`,
      `下载失败：${errorMessage(error)}`,
    ), true);
  }
}

function installJobHistoryBridge(): void {
  window.addEventListener("hhtools:job-history-command", (event) => {
    void handleJobHistoryCommand(event);
  });
  void refreshJobHistory();
  window.setInterval(() => void refreshJobHistory(), 2500);
}

// ----------------------------------------------------------------- loading bar
function fmtBytes(n: number): string {
  if (!n) return "0 B";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
}

function showLoading(label?: string): void {
  const o = document.getElementById("load-overlay");
  if (!o) return;
  document.getElementById("load-label").textContent = label
    || runtimeText("Loading…", "加载中…");
  document.getElementById("load-sub").textContent = "";
  document.getElementById("load-bar").style.width = "0%";
  o.classList.remove("hidden");
  o.classList.add("indet"); // server still computing → animated sweep
}

/** ``frac`` in [0,1] for a determinate bar, or ``null`` for indeterminate. */
function setLoadingProgress(frac: number | null, sub?: string | null): void {
  const o = document.getElementById("load-overlay");
  if (!o) return;
  const bar = document.getElementById("load-bar");
  if (frac == null) {
    o.classList.add("indet");
  } else {
    o.classList.remove("indet");
    bar.style.width = `${Math.max(2, Math.min(100, frac * 100)).toFixed(0)}%`;
  }
  if (sub != null) document.getElementById("load-sub").textContent = sub;
}

function hideLoading(): void {
  const o = document.getElementById("load-overlay");
  if (!o) return;
  o.classList.add("hidden");
  o.classList.remove("indet");
}

// Read a (large) JSON response as a stream so the load bar reflects real
// download progress.  The server computes FK / bakes the SMPL mesh before the
// first byte, so `onProgress(null, …)` (indeterminate) covers that wait, then
// the determinate bar tracks the payload transfer — the part that actually
// scales with clip length.
async function readJsonStream<T>(r: Response, onProgress?: ProgressCallback): Promise<T> {
  const total = Number(r.headers.get("Content-Length") || 0);
  if (!r.body || !total) {
    if (onProgress) onProgress(null, 0, 0);
    return await r.json() as T;
  }
  const reader = r.body.getReader();
  let received = 0;
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (onProgress) onProgress(received / total, received, total);
  }
  const all = new Uint8Array(received);
  let pos = 0;
  for (const c of chunks) { all.set(c, pos); pos += c.length; }
  return JSON.parse(new TextDecoder("utf-8").decode(all)) as T;
}

async function postJsonWithProgress<T>(
  url: string,
  body: unknown,
  onProgress?: ProgressCallback,
): Promise<T> {
  if (onProgress) onProgress(null, 0, 0);
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  if (!r.ok) throw await httpError(r);
  return readJsonStream<T>(r, onProgress);
}

async function uploadWithProgress<T>(
  url: string,
  files: Iterable<UploadFile>,
  { profile }: { profile?: string } = {},
  onProgress?: ProgressCallback,
): Promise<T> {
  const fd = new FormData();
  for (const f of files) fd.append("files", f, f._relpath || f.name);
  const qs = [];
  if (profile) qs.push(`profile=${encodeURIComponent(profile)}`);
  const u = qs.length ? `${url}?${qs.join("&")}` : url;
  if (onProgress) onProgress(null, 0, 0);
  const r = await fetch(u, { method: "POST", body: fd });
  if (!r.ok) throw await httpError(r);
  return readJsonStream<T>(r, onProgress);
}

/** Upload files with real byte progress, then return the JSON body (``{job_id}``). */
function uploadFilesXHR<Url extends string>(
  url: Url,
  files: Iterable<UploadFile>,
  {
    profile,
    appendTo,
    libraryFolderLabel,
    userSourceRoot,
  }: UploadFilesXhrOptions = {},
  onUploadProgress?: ProgressCallback,
): Promise<UploadFilesXhrResponse<Url>> {
  return new Promise<UploadFilesXhrResponse<Url>>((resolve, reject) => {
    const fd = new FormData();
    for (const f of files) fd.append("files", f, f._relpath || f.name);
    const qs = new URLSearchParams();
    if (profile) qs.set("profile", profile);
    if (appendTo) qs.set("append_to", appendTo);
    if (libraryFolderLabel) qs.set("library_folder_label", libraryFolderLabel);
    if (userSourceRoot) qs.set("user_source_root", userSourceRoot);
    const q = qs.toString() ? `?${qs.toString()}` : "";
    const xhr = new XMLHttpRequest();
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onUploadProgress) {
        onUploadProgress(e.loaded / e.total, e.loaded, e.total);
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try { resolve(JSON.parse(xhr.responseText) as UploadFilesXhrResponse<Url>); }
        catch (err) { reject(err); }
        return;
      }
      // XHR is required for byte-progress events, so unwrap FastAPI's detail
      // payload here just as the fetch-based helpers do above.
      let message = xhr.responseText || `upload failed (${xhr.status})`;
      try {
        const payload = JSON.parse(xhr.responseText) as { detail?: unknown };
        message = apiDetailMessage(payload.detail) || message;
      } catch {
        // Non-JSON responses (proxy errors, disconnects) are already readable.
      }
      reject(new Error(message));
    };
    xhr.onerror = () => reject(new Error("upload failed"));
    xhr.open("POST", url + q);
    xhr.send(fd);
  });
}

function formatJobProgress(job: JobResponse, prefix = ""): string {
  const pct = Math.round(Math.max(0, Math.min(100, (job.progress || 0) * 100)));
  const msg = job.message || runtimeText("Processing…", "处理中…");
  return `${prefix}${msg} (${pct}%)`;
}

/**
 * Shared long-job completion boundary. `uploadFrac` reserves the first part of
 * a combined progress bar for XHR upload; backend progress fills the remainder.
 */
async function waitMotionJob<Result = JobResult>(
  jobId: string,
  onProgress?: JobProgressCallback,
  { uploadFrac = 0 }: { uploadFrac?: number } = {},
): Promise<Result> {
  while (true) {
    const j = await API.get(`/api/job/${jobId}`);
    if (onProgress) {
      const frac = uploadFrac + (j.progress || 0) * (1 - uploadFrac);
      onProgress(frac, formatJobProgress(j));
    }
    if (j.status === "done") {
      if (!j.result) throw new Error(j.error || "motion load failed");
      // Job result shape depends on the endpoint that created the job. The
      // caller supplies that endpoint-specific contract at this API boundary.
      return j.result as Result;
    }
    if (j.status === "error") throw new Error(j.error || "motion load failed");
    await new Promise((r) => setTimeout(r, 350));
  }
}

// ----------------------------------------------------------------- 3D scene
// One persistent WebGL canvas is shared by every workflow. Views are stable
// groups under this scene; loading data updates them instead of remounting React.
const canvas = document.getElementById("three-canvas");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, 1, 0.01, 200);
camera.position.set(2.6, 1.9, 3.2);
const orbit = new OrbitControls(camera, renderer.domElement);
orbit.target.set(0, 0.9, 0);
orbit.enableDamping = true;
orbit.dampingFactor = 0.08;
orbit.zoomSpeed = 0.028;
orbit.zoomToCursor = true;
orbit.screenSpacePanning = true;
// OrbitControls uses pow(0.95, zoomSpeed*deltaY) — one wheel notch (±100) jumps ~5×
// at default speeds.  Use linear dolly steps for continuous zoom instead.
orbit.enableZoom = false;
const _smoothZoomOffset = new THREE.Vector3();
function smoothOrbitWheel(event: WheelEvent): void {
  if (!orbit.enabled) return;
  let delta = event.deltaY;
  if (event.deltaMode === 1) delta *= 16;
  else if (event.deltaMode === 2) delta *= 400;
  const step = THREE.MathUtils.clamp(-delta / 120, -2.5, 2.5);
  const scale = Math.pow(0.968, step);
  _smoothZoomOffset.copy(camera.position).sub(orbit.target);
  const dist = _smoothZoomOffset.length();
  if (dist < 1e-6) return;
  const next = THREE.MathUtils.clamp(dist * scale, orbit.minDistance, orbit.maxDistance);
  _smoothZoomOffset.setLength(next);
  camera.position.copy(orbit.target).add(_smoothZoomOffset);
  orbit.update();
  _orbitManualUntil = performance.now() + 2800;
  event.preventDefault();
}
renderer.domElement.addEventListener("wheel", smoothOrbitWheel, { passive: false });

scene.add(new THREE.AmbientLight(0xffffff, 0.55));
scene.add(new THREE.HemisphereLight(0xffffff, 0x8899aa, 1.35));
const key = new THREE.DirectionalLight(0xffffff, 1.5);
key.position.set(3, 6, 4);
scene.add(key);
const fill = new THREE.DirectionalLight(0xffffff, 0.85);
fill.position.set(-3, 4, -2);
scene.add(fill);

// World group: hhtools is Z-up; rotate so Z maps to three.js Y (up).
const world = new THREE.Group();
world.rotation.x = -Math.PI / 2;
scene.add(world);

// Spatial axes in the motion frame (X=red, Y=green, Z=blue in hhtools Z-up).
const axes = new THREE.AxesHelper(1.2);
world.add(axes);

// Environment (terrain + interaction objects) lives in its own group so it
// stays visible regardless of which figure (skeleton / mesh / robot) is shown.
const env = new THREE.Group();
world.add(env);
const scaledEnvGroup = new THREE.Group();
world.add(scaledEnvGroup);

// Triangulated heightfield mesh (matches Viser TerrainHeightfieldRenderer).
function buildTerrainMesh(
  t: TerrainPayload | null | undefined,
  materialParameters: THREE.MeshStandardMaterialParameters = {
    // flatShading keeps stair risers looking like sharp steps instead of
    // smooth-shaded ramps; the user reported stairs rendering as slopes.
    color: 0x9a9aa0,
    roughness: 0.95,
    side: THREE.DoubleSide,
    flatShading: true,
  },
): THREE.Mesh | null {
  if (!t?.vertices?.length || !t?.faces?.length) return null;
  const pos = new Float32Array(t.vertices.length * 3);
  for (let i = 0; i < t.vertices.length; i++) {
    pos[i * 3] = t.vertices[i][0];
    pos[i * 3 + 1] = t.vertices[i][1];
    pos[i * 3 + 2] = t.vertices[i][2];
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setIndex(t.faces.flat());
  geo.computeVertexNormals();
  return new THREE.Mesh(
    geo,
    new THREE.MeshStandardMaterial(materialParameters),
  );
}

// Ground grid (in three.js Y-up space, so add outside world).
const grid = new THREE.GridHelper(20, 40, 0x99a0ab, 0xd2d6dd);
grid.material.opacity = 0.35;
grid.material.transparent = true;
scene.add(grid);

function resize(): void {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (w === 0 || h === 0) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener("resize", resize);
new ResizeObserver(resize).observe(document.getElementById("stage"));

// ----------------------------------------------------------------- render loop
const clock = new THREE.Clock();
const _camFocus = new THREE.Vector3();
const _defaultCamTarget = new THREE.Vector3(0, 0.9, 0);
const _defaultCamOffset = new THREE.Vector3(2.6, 1.0, 3.2);
const _viewFocusBox = new THREE.Box3();
const _viewFocusTmp = new THREE.Box3();
let _orbitManualUntil = 0;
orbit.addEventListener("start", () => { _orbitManualUntil = performance.now() + 2800; });
orbit.addEventListener("end", () => { _orbitManualUntil = performance.now() + 2800; });

function getViewFocus(out = new THREE.Vector3()): THREE.Vector3 {
  // Fallback framing must follow the renderer that owns the shared canvas.
  // Only visible resources participate; otherwise Reset could center an H2R
  // object that is physically hidden behind an active R2R workflow.
  const candidates: Array<THREE.Object3D | null> = h2rOwnsStage
    ? [
        robot.group.visible && robot.links?.length ? robot.group : null,
        scaledSkel.group.visible && scaledSkel.joints ? scaledSkel.group : null,
        skel.group.visible && skel.joints ? skel.group : null,
        mesh.group.visible && mesh.ready ? mesh.group : null,
        skin.group.visible && skin.ready ? skin.group : null,
        env.visible && env.children.length ? env : null,
        scaledEnvGroup.visible && scaledEnvGroup.children.length
          ? scaledEnvGroup
          : null,
      ]
    : [
        r2rSrc.group.visible && r2rSrc.links?.length ? r2rSrc.group : null,
        r2rTgt.group.visible && r2rTgt.links?.length ? r2rTgt.group : null,
        r2rSrcSkel.group.visible && r2rSrcSkel.joints
          ? r2rSrcSkel.group
          : null,
        r2rTgtSkel.group.visible && r2rTgtSkel.joints
          ? r2rTgtSkel.group
          : null,
        r2rSrcEnvGroup.visible && r2rSrcEnvGroup.children.length
          ? r2rSrcEnvGroup
          : null,
        r2rTgtEnvGroup.visible && r2rTgtEnvGroup.children.length
          ? r2rTgtEnvGroup
          : null,
      ];
  let has = false;
  for (const g of candidates) {
    if (!g) continue;
    _viewFocusTmp.setFromObject(g);
    if (_viewFocusTmp.isEmpty()) continue;
    if (!has) {
      _viewFocusBox.copy(_viewFocusTmp);
      has = true;
    } else {
      _viewFocusBox.union(_viewFocusTmp);
    }
  }
  if (!has) {
    out.copy(_defaultCamTarget);
    return out;
  }
  _viewFocusBox.getCenter(out);
  return out;
}

function resetDefaultView(): void {
  focusRobotView({ resetOffset: true });
}

/** Narrow browser-service port used while camera ownership remains legacy. */
export function resetStageView(): void {
  resetDefaultView();
}

function calibRobotGroup(): THREE.Group {
  return r2r.calibrating ? r2rTgt.group : robot.group;
}

/** Robot meshes that belong to the renderer currently shown on the Stage. */
function activeRobotFocusGroups(): THREE.Group[] {
  if (h2rOwnsStage) return [robot.group];
  // Calibration isolates the target robot; the regular comparison view may
  // show source and target together, so Reset frames both visible meshes.
  return r2r.calibrating
    ? [r2rTgt.group]
    : [r2rSrc.group, r2rTgt.group];
}

/** Frame robot (+ reference skeleton during calibration) with sane orbit limits. */
function focusRobotView({ resetOffset = false }: { resetOffset?: boolean } = {}): void {
  const focusGroups = activeRobotFocusGroups();
  if ((state.calibrationMode || r2r.calibrating) && refSkel.group.visible) {
    focusGroups.push(refSkel.group);
  }
  let has = false;
  for (const g of focusGroups) {
    if (!g?.visible) continue;
    _viewFocusTmp.setFromObject(g);
    if (_viewFocusTmp.isEmpty()) continue;
    if (!has) {
      _viewFocusBox.copy(_viewFocusTmp);
      has = true;
    } else {
      _viewFocusBox.union(_viewFocusTmp);
    }
  }
  if (!has) {
    getViewFocus(_camFocus);
    orbit.target.copy(_camFocus);
    if (resetOffset) camera.position.copy(_camFocus).add(_defaultCamOffset);
    orbit.update();
    _orbitManualUntil = performance.now() + 2800;
    return;
  }
  _viewFocusBox.getCenter(_camFocus);
  orbit.target.copy(_camFocus);
  if (resetOffset) {
    const size = _viewFocusBox.getSize(new THREE.Vector3());
    const span = Math.max(0.55, size.length());
    const dist = Math.max(1.35, span * 0.9);
    camera.position.copy(_camFocus).add(
      new THREE.Vector3(dist * 0.58, dist * 0.44, dist * 0.68),
    );
  }
  orbit.update();
  _orbitManualUntil = performance.now() + 2800;
}

/** Orbit distance limits scaled to the visible robot (calibration zoom range). */
function calibOrbitDistanceLimits(): { minDistance: number; maxDistance: number } {
  let has = false;
  for (const g of [calibRobotGroup(), refSkel.group.visible ? refSkel.group : null]) {
    if (!g) continue;
    _viewFocusTmp.setFromObject(g);
    if (_viewFocusTmp.isEmpty()) continue;
    if (!has) {
      _viewFocusBox.copy(_viewFocusTmp);
      has = true;
    } else {
      _viewFocusBox.union(_viewFocusTmp);
    }
  }
  const span = has ? Math.max(0.75, _viewFocusBox.getSize(new THREE.Vector3()).length()) : 1.6;
  return {
    minDistance: Math.max(0.28, span * 0.12),
    maxDistance: Math.max(span * 6, 18),
  };
}

function applyCalibOrbitLimits({ snapCamera = false }: { snapCamera?: boolean } = {}): void {
  const lim = calibOrbitDistanceLimits();
  orbit.minDistance = lim.minDistance;
  orbit.maxDistance = lim.maxDistance;
  if (!snapCamera) return;
  const dist = camera.position.distanceTo(orbit.target);
  if (dist < lim.minDistance || dist > lim.maxDistance) {
    const dir = camera.position.clone().sub(orbit.target);
    if (dir.lengthSq() < 1e-8) dir.set(0.58, 0.44, 0.68);
    dir.normalize().multiplyScalar(Math.min(lim.maxDistance, Math.max(lim.minDistance, dist)));
    camera.position.copy(orbit.target).add(dir);
    orbit.update();
  }
}

function animate(): void {
  requestAnimationFrame(animate);
  const dt = clock.getDelta();
  player.update(dt);
  // Follow the retargeted robot in world space; pause while the user orbits.
  // On loop wrap the robot teleports (start ≠ end).  Always hard-snap the
  // camera with that wrap — even during the post-orbit "manual" grace period —
  // otherwise the robot flies across the viewport while the camera stays put.
  //
  // Target and camera must translate by the *same* delta.  Lerping only
  // ``orbit.target`` leaves the eye behind; at walk speed the lag settles
  // near the hard-snap threshold (~0.5 m) and the view stutter-snaps every
  // few frames.
  const loopSnap = player._justLooped;
  player._justLooped = false;
  if (
    !state.calibrationMode &&
    robot.group.visible && robot.trajectory &&
    (loopSnap || performance.now() > _orbitManualUntil)
  ) {
    robot.group.getWorldPosition(_camFocus);
    const dx = _camFocus.x - orbit.target.x;
    const dy = _camFocus.y - orbit.target.y;
    const dz = _camFocus.z - orbit.target.z;
    const jumpSq = dx * dx + dy * dy + dz * dz;
    const a = (loopSnap || jumpSq > 0.25) ? 1 : Math.min(1, dt * 12);
    const ox = dx * a;
    const oy = dy * a;
    const oz = dz * a;
    orbit.target.x += ox;
    orbit.target.y += oy;
    orbit.target.z += oz;
    camera.position.x += ox;
    camera.position.y += oy;
    camera.position.z += oz;
  }
  if ((state.calibrationMode || r2r.calibrating) && calibManip.active && !calibManip._hudCardDrag) {
    calibManip._positionTags();
    refSkel.updateOverlay(r2r.calibrating ? r2rTgt : robot);
  }
  orbit.update();
  renderer.render(scene, camera);
}
resize();
// NOTE: the render loop is started at the very bottom of this module, after
// `player` is defined — calling animate() here would hit the const TDZ.

// =================================================================  SKELETON
class SkeletonView implements PlaybackView {
  readonly group: THREE.Group;
  joints: Vec3[][] | null = null;
  parents: number[] = [];
  spheres: Array<THREE.Mesh<THREE.SphereGeometry, THREE.MeshStandardMaterial>> = [];
  lineGeom: THREE.BufferGeometry | null = null;
  lines: THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial> | null = null;
  frameIndices: number[] | null | undefined = null;
  color = 0x0a84ff;
  exclude = new Set<number>();
  clipDuration = 1;

  constructor() {
    this.group = new THREE.Group();
    world.add(this.group);
  }
  clear(): void {
    try {
      threeResourceDisposer.disposeObject3DChildren(this.group, {
        geometries: [
          ...this.spheres.map((sphere) => sphere.geometry),
          ...(this.lineGeom ? [this.lineGeom] : []),
        ],
        materials: [
          ...this.spheres.map((sphere) => sphere.material),
          ...(this.lines ? [this.lines.material] : []),
        ],
      });
    } finally {
      // Aliases must never retain disposed resources, even when one resource's
      // dispose listener throws and the aggregate is rethrown to the caller.
      try {
        this.group.clear();
      } finally {
        this.spheres = [];
        this.joints = null;
        this.parents = [];
        this.lineGeom = null;
        this.lines = null;
        this.frameIndices = null;
        this.exclude = new Set();
      }
    }
  }
  load(motion: MotionPayload, color = 0x0a84ff): void {
    this.clear();
    this.color = color;
    this.joints = motion.positions; // (F, J, 3)
    this.parents = motion.parent_indices;
    this.exclude = new Set(motion.exclude_joint_indices || []);
    this.frameIndices = motion.frame_indices;
    this.clipDuration = effectivePlaybackDuration(motion);
    const J = this.parents.length;
    const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.5, metalness: 0.1 });
    const sphereGeo = new THREE.SphereGeometry(0.028, 12, 12);
    for (let j = 0; j < J; j++) {
      const s = new THREE.Mesh(sphereGeo, mat);
      if (this.exclude.has(j)) s.visible = false;
      this.group.add(s);
      this.spheres.push(s);
    }
    let segCount = 0;
    for (let j = 0; j < J; j++) {
      const p = this.parents[j];
      if (p < 0 || this.exclude.has(j) || this.exclude.has(p)) continue;
      segCount++;
    }
    const positions = new Float32Array(segCount * 2 * 3);
    this.lineGeom = new THREE.BufferGeometry();
    this.lineGeom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    this.lines = new THREE.LineSegments(
      this.lineGeom,
      new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.7 })
    );
    this.group.add(this.lines);
    this.setFrame(0);
  }
  get numFrames(): number {
    return this.joints ? this.joints.length : 0;
  }
  setFrame(f: number): void {
    this.setFrameFrac(f);
  }
  setFrameFrac(fi: number): void {
    if (!this.joints || !this.lineGeom) return;
    const max = this.joints.length - 1;
    const { ia, ib, t } = resolvePlaybackFrame(this.frameIndices, fi, max);
    const fr = this.joints[ia];
    if (!fr) return;
    const blend = t > 1e-5 && ia !== ib;
    const nxt = blend ? this.joints[ib] : undefined;
    for (let j = 0; j < this.spheres.length; j++) {
      if (nxt) {
        this.spheres[j].position.set(
          fr[j][0] + (nxt[j][0] - fr[j][0]) * t,
          fr[j][1] + (nxt[j][1] - fr[j][1]) * t,
          fr[j][2] + (nxt[j][2] - fr[j][2]) * t,
        );
      } else {
        this.spheres[j].position.set(fr[j][0], fr[j][1], fr[j][2]);
      }
    }
    const position = this.lineGeom.getAttribute("position") as THREE.BufferAttribute;
    const arr = position.array;
    let k = 0;
    for (let j = 0; j < this.parents.length; j++) {
      const p = this.parents[j];
      if (p < 0 || this.exclude.has(j) || this.exclude.has(p)) continue;
      if (nxt) {
        arr[k++] = fr[j][0] + (nxt[j][0] - fr[j][0]) * t;
        arr[k++] = fr[j][1] + (nxt[j][1] - fr[j][1]) * t;
        arr[k++] = fr[j][2] + (nxt[j][2] - fr[j][2]) * t;
        arr[k++] = fr[p][0] + (nxt[p][0] - fr[p][0]) * t;
        arr[k++] = fr[p][1] + (nxt[p][1] - fr[p][1]) * t;
        arr[k++] = fr[p][2] + (nxt[p][2] - fr[p][2]) * t;
      } else {
        arr[k++] = fr[j][0]; arr[k++] = fr[j][1]; arr[k++] = fr[j][2];
        arr[k++] = fr[p][0]; arr[k++] = fr[p][1]; arr[k++] = fr[p][2];
      }
    }
    position.needsUpdate = true;
  }
}

interface ReferenceLandmarkMapping {
  semantic: string;
  targetLink: string;
  index: number;
  label: HTMLElement;
  line: SVGLineElement;
}

interface ReferenceAlignmentDiagnostic {
  semantic: string;
  targetLink: string;
  positionResidualM: number;
  verticalResidualM: number;
  rotationResidualDeg: number | null;
}

const CANONICAL_LANDMARK_LABELS: Record<string, readonly [string, string]> = {
  hips: ["Hips", "髋部"],
  chest: ["Chest", "胸部"],
  neck: ["Neck", "颈部"],
  head: ["Head", "头部"],
  left_hip: ["Left hip", "左髋"],
  right_hip: ["Right hip", "右髋"],
  left_knee: ["Left knee", "左膝"],
  right_knee: ["Right knee", "右膝"],
  left_ankle: ["Left ankle", "左踝"],
  right_ankle: ["Right ankle", "右踝"],
  left_shoulder: ["Left shoulder", "左肩"],
  right_shoulder: ["Right shoulder", "右肩"],
  left_elbow: ["Left elbow", "左肘"],
  right_elbow: ["Right elbow", "右肘"],
  left_wrist: ["Left wrist", "左腕"],
  right_wrist: ["Right wrist", "右腕"],
};

function normalizedSemanticName(value: unknown): string {
  return String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

function ikMapTargetLink(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  for (const key of ["t_body", "link", "body", "target"]) {
    if (typeof candidate[key] === "string") return candidate[key] as string;
  }
  return null;
}

// Blue reference T-pose shown only during calibration (Viser ReferenceSkeletonRenderer).
class ReferenceSkeletonView {
  readonly group: THREE.Group;
  readonly labelRoot: HTMLElement;
  readonly lineRoot: SVGSVGElement;
  spheres: Array<THREE.Mesh<THREE.SphereGeometry, THREE.MeshStandardMaterial>> = [];
  parents: number[] = [];
  boneNames: string[] = [];
  canonicalNames: string[] = [];
  referenceQuaternions: Array<[number, number, number, number]> = [];
  exclude = new Set<number>();
  mappings: ReferenceLandmarkMapping[] = [];
  lineGeom: THREE.BufferGeometry | null = null;
  lines: THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial> | null = null;
  mappedMaterial: THREE.MeshStandardMaterial | null = null;
  contextMaterial: THREE.MeshStandardMaterial | null = null;
  mappedOnly = true;
  labelsVisible = true;
  mappingLinesVisible = true;
  sourceOpacity = 0.82;

  constructor() {
    this.group = new THREE.Group();
    this.group.visible = false;
    this.labelRoot = document.getElementById("calib-landmark-labels");
    this.lineRoot = document.querySelector<SVGSVGElement>("#calib-mapping-overlay")!;
    world.add(this.group);
  }

  clear(): void {
    try {
      threeResourceDisposer.disposeObject3DChildren(this.group, {
        geometries: [
          ...this.spheres.map((sphere) => sphere.geometry),
          ...(this.lineGeom ? [this.lineGeom] : []),
        ],
        materials: [
          ...this.spheres.map((sphere) => sphere.material),
          ...(this.lines ? [this.lines.material] : []),
          ...(this.mappedMaterial ? [this.mappedMaterial] : []),
          ...(this.contextMaterial ? [this.contextMaterial] : []),
        ],
      });
    } finally {
      // DOM overlays and aliases describe the same resource generation as the
      // Group, so a failed disposer must not leave either generation reachable.
      try {
        this.group.clear();
      } finally {
        try {
          this.labelRoot.replaceChildren();
        } finally {
          try {
            this.lineRoot.replaceChildren();
          } finally {
            this.spheres = [];
            this.parents = [];
            this.boneNames = [];
            this.canonicalNames = [];
            this.referenceQuaternions = [];
            this.exclude = new Set();
            this.mappings = [];
            this.lineGeom = null;
            this.lines = null;
            this.mappedMaterial = null;
            this.contextMaterial = null;
            this.group.visible = false;
          }
        }
      }
    }
  }

  load(ref: CalibrationReferencePayload | null | undefined): void {
    this.clear();
    if (!ref?.positions?.length) return;
    const color = ref.color != null ? ref.color : 0x5eb3ff;
    const fr = ref.positions[0];
    this.parents = ref.parent_indices;
    this.boneNames = ref.bone_names?.slice() ?? this.parents.map((_, index) => `joint_${index}`);
    this.canonicalNames = ref.canonical_names?.slice() ?? this.boneNames.slice();
    this.referenceQuaternions = ref.quaternions?.[0]?.slice() ?? [];
    this.exclude = new Set(ref.exclude_joint_indices || []);
    const jointCount = this.parents.length;
    this.mappedMaterial = new THREE.MeshStandardMaterial({
      color,
      roughness: 0.34,
      metalness: 0.03,
      emissive: 0x0a4d92,
      emissiveIntensity: 0.62,
      transparent: true,
      opacity: this.sourceOpacity,
    });
    this.contextMaterial = new THREE.MeshStandardMaterial({
      color,
      roughness: 0.48,
      metalness: 0.02,
      emissive: 0x1a3a66,
      emissiveIntensity: 0.18,
      transparent: true,
      opacity: this.sourceOpacity * 0.32,
    });
    const sphereGeo = new THREE.SphereGeometry(0.022, 12, 12);
    for (let index = 0; index < jointCount; index++) {
      const sphere = new THREE.Mesh(sphereGeo, this.contextMaterial);
      if (this.exclude.has(index)) sphere.visible = false;
      this.group.add(sphere);
      this.spheres.push(sphere);
    }
    let segmentCount = 0;
    for (let index = 0; index < jointCount; index++) {
      const parent = this.parents[index];
      if (parent < 0 || this.exclude.has(index) || this.exclude.has(parent)) continue;
      segmentCount++;
    }
    const positions = new Float32Array(segmentCount * 2 * 3);
    this.lineGeom = new THREE.BufferGeometry();
    this.lineGeom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    this.lines = new THREE.LineSegments(
      this.lineGeom,
      new THREE.LineBasicMaterial({
        color,
        transparent: true,
        opacity: this.sourceOpacity * 0.38,
      }),
    );
    this.group.add(this.lines);
    for (let index = 0; index < jointCount; index++) {
      if (this.exclude.has(index)) continue;
      this.spheres[index].position.set(fr[index][0], fr[index][1], fr[index][2]);
    }
    const position = this.lineGeom.getAttribute("position") as THREE.BufferAttribute;
    const array = position.array;
    let offset = 0;
    for (let index = 0; index < jointCount; index++) {
      const parent = this.parents[index];
      if (parent < 0 || this.exclude.has(index) || this.exclude.has(parent)) continue;
      array[offset++] = fr[index][0]; array[offset++] = fr[index][1]; array[offset++] = fr[index][2];
      array[offset++] = fr[parent][0]; array[offset++] = fr[parent][1]; array[offset++] = fr[parent][2];
    }
    position.needsUpdate = true;
    this.group.visible = true;
    this.applyDisplayOptions();
  }

  configureMappings(ikMap: Record<string, unknown> | null | undefined): number {
    this.labelRoot.replaceChildren();
    this.lineRoot.replaceChildren();
    this.mappings = [];
    const canonicalIndex = new Map<string, number>();
    this.canonicalNames.forEach((name, index) => canonicalIndex.set(normalizedSemanticName(name), index));
    this.boneNames.forEach((name, index) => {
      const key = normalizedSemanticName(name);
      if (!canonicalIndex.has(key)) canonicalIndex.set(key, index);
    });

    for (const [semantic, rawTarget] of Object.entries(ikMap ?? {})) {
      const targetLink = ikMapTargetLink(rawTarget);
      const index = canonicalIndex.get(normalizedSemanticName(semantic));
      if (!targetLink || index == null || this.exclude.has(index)) continue;

      const label = document.createElement("span");
      label.className = "calib-landmark-label";
      const primary = document.createElement("strong");
      const labels = CANONICAL_LANDMARK_LABELS[semantic];
      primary.textContent = labels
        ? runtimeText(labels[0], labels[1])
        : semantic.replaceAll("_", " ");
      label.append(primary, document.createTextNode(` · ${targetLink}`));
      this.labelRoot.appendChild(label);

      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      this.lineRoot.appendChild(line);
      this.mappings.push({ semantic, targetLink, index, label, line });
    }
    this.applyDisplayOptions();
    return this.mappings.length;
  }

  setDisplayOptions({
    mappedOnly,
    labels,
    mappingLines,
    sourceOpacity,
  }: {
    mappedOnly?: boolean;
    labels?: boolean;
    mappingLines?: boolean;
    sourceOpacity?: number;
  }): void {
    if (mappedOnly != null) this.mappedOnly = mappedOnly;
    if (labels != null) this.labelsVisible = labels;
    if (mappingLines != null) this.mappingLinesVisible = mappingLines;
    if (sourceOpacity != null) this.sourceOpacity = Math.min(1, Math.max(0.1, sourceOpacity));
    this.applyDisplayOptions();
  }

  private applyDisplayOptions(): void {
    const mappedIndices = new Set(this.mappings.map((mapping) => mapping.index));
    this.spheres.forEach((sphere, index) => {
      const mapped = mappedIndices.has(index);
      sphere.material = mapped && this.mappedMaterial ? this.mappedMaterial : this.contextMaterial ?? sphere.material;
      sphere.scale.setScalar(mapped ? 1.12 : 0.62);
      sphere.visible = !this.exclude.has(index) && (mapped || !this.mappedOnly);
    });
    if (this.mappedMaterial) this.mappedMaterial.opacity = this.sourceOpacity;
    if (this.contextMaterial) this.contextMaterial.opacity = this.sourceOpacity * 0.32;
    if (this.lines) this.lines.material.opacity = this.sourceOpacity * 0.38;
    this.labelRoot.style.display = this.labelsVisible ? "block" : "none";
    this.lineRoot.style.display = this.mappingLinesVisible ? "block" : "none";
  }

  updateOverlay(robotView: RobotView): void {
    const active = this.group.visible && this.mappings.length > 0;
    const width = this.labelRoot.clientWidth;
    const height = this.labelRoot.clientHeight;
    if (!active || width <= 0 || height <= 0) {
      for (const mapping of this.mappings) {
        mapping.label.style.display = "none";
        mapping.line.style.display = "none";
      }
      return;
    }

    const referencePoint = new THREE.Vector3();
    const targetPoint = new THREE.Vector3();
    for (const mapping of this.mappings) {
      this.spheres[mapping.index].getWorldPosition(referencePoint);
      if (!robotView.getLinkWorldPosition(mapping.targetLink, targetPoint)) {
        mapping.label.style.display = "none";
        mapping.line.style.display = "none";
        continue;
      }
      const referenceNdc = referencePoint.clone().project(camera);
      const targetNdc = targetPoint.clone().project(camera);
      const visible = referenceNdc.z >= -1 && referenceNdc.z <= 1
        && targetNdc.z >= -1 && targetNdc.z <= 1;
      if (!visible) {
        mapping.label.style.display = "none";
        mapping.line.style.display = "none";
        continue;
      }
      const rx = (referenceNdc.x * 0.5 + 0.5) * width;
      const ry = (-referenceNdc.y * 0.5 + 0.5) * height;
      const tx = (targetNdc.x * 0.5 + 0.5) * width;
      const ty = (-targetNdc.y * 0.5 + 0.5) * height;
      mapping.label.style.display = this.labelsVisible ? "block" : "none";
      mapping.label.style.left = `${rx}px`;
      mapping.label.style.top = `${ry}px`;
      mapping.line.style.display = this.mappingLinesVisible ? "block" : "none";
      mapping.line.setAttribute("x1", String(rx));
      mapping.line.setAttribute("y1", String(ry));
      mapping.line.setAttribute("x2", String(tx));
      mapping.line.setAttribute("y2", String(ty));
    }
  }

  alignmentDiagnostics(robotView: RobotView): ReferenceAlignmentDiagnostic[] {
    const referencePosition = new THREE.Vector3();
    const targetPosition = new THREE.Vector3();
    const targetQuaternion = new THREE.Quaternion();
    const worldQuaternion = new THREE.Quaternion();
    world.getWorldQuaternion(worldQuaternion);
    return this.mappings.flatMap((mapping) => {
      this.spheres[mapping.index].getWorldPosition(referencePosition);
      if (!robotView.getLinkWorldPosition(mapping.targetLink, targetPosition)) return [];
      let rotationResidualDeg: number | null = null;
      const rawQuaternion = this.referenceQuaternions[mapping.index];
      if (rawQuaternion && robotView.getLinkWorldQuaternion(mapping.targetLink, targetQuaternion)) {
        const referenceQuaternion = worldQuaternion.clone().multiply(
          new THREE.Quaternion(rawQuaternion[0], rawQuaternion[1], rawQuaternion[2], rawQuaternion[3]),
        );
        const dot = Math.min(1, Math.abs(referenceQuaternion.dot(targetQuaternion)));
        rotationResidualDeg = 2 * Math.acos(dot) * 180 / Math.PI;
      }
      return [{
        semantic: mapping.semantic,
        targetLink: mapping.targetLink,
        positionResidualM: referencePosition.distanceTo(targetPosition),
        verticalResidualM: Math.abs(referencePosition.z - targetPosition.z),
        rotationResidualDeg,
      }];
    });
  }

  headingResidualDeg(robotView: RobotView): number | null {
    const findMapping = (semantic: string) => this.mappings.find(
      (mapping) => normalizedSemanticName(mapping.semantic) === normalizedSemanticName(semantic),
    );
    const candidates: Array<readonly [string, string]> = [
      ["left_shoulder", "right_shoulder"],
      ["left_hip", "right_hip"],
    ];
    const refLeft = new THREE.Vector3();
    const refRight = new THREE.Vector3();
    const targetLeft = new THREE.Vector3();
    const targetRight = new THREE.Vector3();
    for (const [leftName, rightName] of candidates) {
      const left = findMapping(leftName);
      const right = findMapping(rightName);
      if (!left || !right) continue;
      this.spheres[left.index].getWorldPosition(refLeft);
      this.spheres[right.index].getWorldPosition(refRight);
      if (!robotView.getLinkWorldPosition(left.targetLink, targetLeft)) continue;
      if (!robotView.getLinkWorldPosition(right.targetLink, targetRight)) continue;
      const referenceAxis = refRight.clone().sub(refLeft).setZ(0);
      const targetAxis = targetRight.clone().sub(targetLeft).setZ(0);
      if (referenceAxis.lengthSq() < 1e-8 || targetAxis.lengthSq() < 1e-8) continue;
      return referenceAxis.angleTo(targetAxis) * 180 / Math.PI;
    }
    return null;
  }
}

// =================================================================  ENVIRONMENT (terrain + interaction objects)
// Owns the static terrain mesh AND the per-frame object props.  Crucially this
// is a *separate* view from the skeleton: in Viser the objects follow the clip
// even when the stick figure is hidden, so object animation must NOT be tied to
// SkeletonView visibility (the previous bug: hiding the skeleton froze props).
class EnvView {
  readonly group: THREE.Group;
  objectMeshes: THREE.Object3D[] = [];
  objectTraj: SceneObjectPayload[] = [];
  joints: SceneObjectPayload[] | null = null;
  clipDuration = 1;
  private _loadGeneration = 0;

  constructor() {
    this.group = env; // reuse the existing env group (child of world)
  }
  clear(): void {
    // GLTFLoader has no ownership-safe cancellation handle. Invalidating its
    // generation makes every escaped completion terminally stale instead.
    this._loadGeneration += 1;
    try {
      threeResourceDisposer.disposeObject3DChildren(this.group);
    } finally {
      try {
        this.group.clear();
      } finally {
        this.objectMeshes = [];
        this.objectTraj = [];
        this.joints = null;
        this.clipDuration = 1;
      }
    }
  }
  load(motion: MotionPayload): void {
    this.clear();
    const generation = this._loadGeneration;
    this.clipDuration = effectivePlaybackDuration(motion);
    if (motion.terrain) {
      const m = buildTerrainMesh(motion.terrain);
      if (m) this.group.add(m);
    }
    (motion.objects || []).forEach((o, i) => {
      this._buildObject(o, i, motion.token, generation);
    });
    // Mark as animatable so the shared player drives setFrame each tick.
    this.joints = this.objectTraj.length ? this.objectTraj : null;
    this.setFrame(0);
  }
  private _buildObject(
    o: SceneObjectPayload,
    i: number,
    token: string,
    generation: number,
  ): void {
    const c = o.color ? (o.color[0] << 16) | (o.color[1] << 8) | o.color[2] : 0xff9f0a;
    const box = new THREE.Mesh(
      new THREE.BoxGeometry(o.extents[0], o.extents[1], o.extents[2]),
      new THREE.MeshStandardMaterial({
        color: c, transparent: true, opacity: o.opacity ?? 0.55, roughness: 0.6,
      })
    );
    this.group.add(box);
    this.objectMeshes.push(box);
    this.objectTraj.push(o);
    if (o.has_mesh && token) {
      const loader = new GLTFLoader();
      loader.load(
        `/api/object_glb?token=${token}&index=${i}`,
        (gltf) => {
          const real = gltf.scene;
          if (
            this._loadGeneration !== generation ||
            this.objectMeshes[i] !== box
          ) {
            disposeDetachedThreeObject(real, "stale environment GLTF cleanup failed");
            return;
          }
          // GLB from /api/object_glb is already centred + scaled on the server.
          real.position.copy(box.position);
          real.quaternion.copy(box.quaternion);
          this.group.add(real);
          this.objectMeshes[i] = real;
          this.group.remove(box);
          disposeDetachedThreeObject(box, "environment placeholder cleanup failed");
        },
        undefined,
        () => {} // keep box on failure
      );
    }
  }
  get numFrames(): number {
    return this.objectTraj.length && this.objectTraj[0].positions
      ? this.objectTraj[0].positions.length : 0;
  }
  setFrame(f: number): void {
    for (let i = 0; i < this.objectMeshes.length; i++) {
      const o = this.objectTraj[i];
      if (!o || !o.positions[f]) continue;
      const m = this.objectMeshes[i];
      m.position.set(o.positions[f][0], o.positions[f][1], o.positions[f][2]);
      const q = o.quaternions[f];
      m.quaternion.set(q[0], q[1], q[2], q[3]); // backend sends xyzw
    }
  }
}

// Scaled terrain + props in the robot retarget frame (teal tint, co-located with robot).
class ScaledEnvView {
  readonly group: THREE.Group;
  objectMeshes: THREE.Object3D[] = [];
  objectTraj: SceneObjectPayload[] = [];
  joints: SceneObjectPayload[] | null = null;
  motionToken: string | null | undefined = null;
  clipDuration = 1;
  private _objectGlbUrl: ((object: SceneObjectPayload, index: number) => string | null) | null = null;
  private _loadGeneration = 0;

  constructor(group: THREE.Group = scaledEnvGroup) {
    this.group = group;
    this.group.visible = false;
  }
  clear(): void {
    this._loadGeneration += 1;
    try {
      threeResourceDisposer.disposeObject3DChildren(this.group);
    } finally {
      try {
        this.group.clear();
      } finally {
        this.objectMeshes = [];
        this.objectTraj = [];
        this.joints = null;
        this.motionToken = null;
        this._objectGlbUrl = null;
        this.clipDuration = 1;
      }
    }
  }
  load(
    scene: ScenePayload | null | undefined,
    motionToken?: string | null,
    opts: {
      duration?: number;
      objectGlbUrl?: (object: SceneObjectPayload, index: number) => string | null;
    } = {},
  ): void {
    this.clear();
    if (!scene) return;
    const generation = this._loadGeneration;
    this.motionToken = motionToken;
    this._objectGlbUrl = opts.objectGlbUrl || null;
    this.clipDuration = Math.max(0.1, opts.duration ?? state.motion?.duration ?? 1);
    if (scene.terrain) {
      const m = buildTerrainMesh(
        scene.terrain,
        {
          color: 0x5c7a9e, roughness: 0.9, side: THREE.DoubleSide, flatShading: true,
          transparent: true, opacity: 0.92,
        },
      );
      if (m) this.group.add(m);
    }
    (scene.objects || []).forEach((o, i) => this._buildObject(o, i, generation));
    this.joints = this.objectTraj.length ? this.objectTraj : null;
    this.setFrame(0);
  }
  private _buildObject(o: SceneObjectPayload, i: number, generation: number): void {
    const c = o.color ? (o.color[0] << 16) | (o.color[1] << 8) | o.color[2] : 0x6a9fd4;
    const box = new THREE.Mesh(
      new THREE.BoxGeometry(o.extents[0], o.extents[1], o.extents[2]),
      new THREE.MeshStandardMaterial({
        color: c, transparent: true, opacity: o.opacity ?? 0.7, roughness: 0.55,
      })
    );
    this.group.add(box);
    this.objectMeshes.push(box);
    this.objectTraj.push(o);
    const srcIdx = o.source_index ?? i;
    const glbUrl = this._objectGlbUrl
      ? this._objectGlbUrl(o, srcIdx)
      : (this.motionToken
        ? `/api/object_glb?token=${this.motionToken}&index=${srcIdx}${
          o.scale != null && Number.isFinite(o.scale)
            ? `&scale=${encodeURIComponent(o.scale)}` : ""
        }`
        : null);
    if (o.has_mesh && glbUrl) {
      const loader = new GLTFLoader();
      loader.load(
        glbUrl,
        (gltf) => {
          const real = gltf.scene;
          if (
            this._loadGeneration !== generation ||
            this.objectMeshes[i] !== box
          ) {
            disposeDetachedThreeObject(real, "stale scaled-environment GLTF cleanup failed");
            return;
          }
          real.position.copy(box.position);
          real.quaternion.copy(box.quaternion);
          this.group.add(real);
          this.objectMeshes[i] = real;
          this.group.remove(box);
          disposeDetachedThreeObject(box, "scaled-environment placeholder cleanup failed");
        },
        undefined,
        () => {}
      );
    }
  }
  get numFrames(): number {
    return this.objectTraj.length && this.objectTraj[0].positions
      ? this.objectTraj[0].positions.length : 0;
  }
  setFrame(f: number): void {
    this.setFrameFrac(f);
  }
  setFrameFrac(fi: number): void {
    if (!this.objectTraj.length) return;
    const max = this.numFrames - 1;
    const { ia, ib, t } = resolvePlaybackFrame(null, fi, max);
    for (let i = 0; i < this.objectMeshes.length; i++) {
      const o = this.objectTraj[i];
      if (!o?.positions?.length) continue;
      const fr = o.positions[ia];
      if (!fr) continue;
      const m = this.objectMeshes[i];
      const blend = t > 1e-5 && ia !== ib && o.positions[ib];
      if (blend) {
        const nxt = o.positions[ib];
        m.position.set(
          fr[0] + (nxt[0] - fr[0]) * t,
          fr[1] + (nxt[1] - fr[1]) * t,
          fr[2] + (nxt[2] - fr[2]) * t,
        );
        const qa = o.quaternions[ia];
        const qb = o.quaternions[ib];
        m.quaternion.set(qa[0], qa[1], qa[2], qa[3]);
        _robotRootQuatB.set(qb[0], qb[1], qb[2], qb[3]);
        m.quaternion.slerp(_robotRootQuatB, t);
      } else {
        m.position.set(fr[0], fr[1], fr[2]);
        const q = o.quaternions[ia];
        m.quaternion.set(q[0], q[1], q[2], q[3]);
      }
    }
  }
}

// =================================================================  BODY MESH
// Per-bone tube + joint-bead "pseudo body" mesh, rebuilt from the same joint
// positions as the skeleton — works for ANY format (no SMPL weights needed).
// Mirrors hhtools.viewer.renderers.capsule_mesh.
const _SEG = 6; // fewer tube segments → smoother LAFAN / long clips
interface PrimitiveGeometryData {
  verts: Vec3[];
  faces: Array<[number, number, number]>;
}

function _unitCylinder(segments: number): PrimitiveGeometryData {
  const verts: Vec3[] = [];
  for (let r = 0; r < 2; r++)
    for (let i = 0; i < segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      verts.push([Math.cos(a), Math.sin(a), r]); // bottom ring z=0, top ring z=1
    }
  const faces: Array<[number, number, number]> = [];
  for (let i = 0; i < segments; i++) {
    const j = (i + 1) % segments;
    faces.push([i, j, i + segments], [j, j + segments, i + segments]);
  }
  return { verts, faces };
}
function _unitIcosphere(): PrimitiveGeometryData {
  const t = (1 + Math.sqrt(5)) / 2;
  const verts: Vec3[] = ([
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
    [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ] as Vec3[]).map((v): Vec3 => {
    const n = Math.hypot(...v);
    return [v[0] / n, v[1] / n, v[2] / n];
  });
  const faces: Array<[number, number, number]> = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
    [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ];
  return { verts, faces };
}
class CapsuleMeshView {
  readonly group: THREE.Group;
  readonly heavy = false;
  joints: Vec3[][] | null = null;
  frameIndices: number[] | null | undefined = null;
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial> | null = null;
  readonly boneRadius = 0.035;
  readonly jointRadius = 0.05;
  readonly cyl = _unitCylinder(_SEG);
  readonly sph = _unitIcosphere();
  edges: Array<[number, number]> = [];
  visibleJoints: number[] = [];
  numJoints = 0;
  positions = new Float32Array();
  clipDuration = 1;

  constructor() {
    this.group = new THREE.Group();
    this.group.visible = false;
    world.add(this.group);
  }
  get ready(): boolean { return this.mesh != null && this.joints != null; }
  clear(): void {
    try {
      threeResourceDisposer.disposeObject3DChildren(this.group, {
        geometries: this.mesh ? [this.mesh.geometry] : [],
        materials: this.mesh ? [this.mesh.material] : [],
      });
    } finally {
      try {
        this.group.clear();
      } finally {
        this.mesh = null;
        this.joints = null;
        this.frameIndices = null;
        this.edges = [];
        this.visibleJoints = [];
        this.numJoints = 0;
        this.positions = new Float32Array();
      }
    }
  }
  load(motion: MotionPayload): void {
    this.clear();
    this.joints = motion.positions;
    this.frameIndices = motion.frame_indices;
    this.clipDuration = effectivePlaybackDuration(motion);
    const parents = motion.parent_indices;
    const exclude = new Set(motion.exclude_joint_indices || []);
    this.edges = [];
    for (let j = 0; j < parents.length; j++) {
      const p = parents[j];
      if (p < 0 || exclude.has(j) || exclude.has(p)) continue;
      this.edges.push([p, j]);
    }
    this.visibleJoints = [];
    for (let j = 0; j < parents.length; j++) {
      if (!exclude.has(j)) this.visibleJoints.push(j);
    }
    this.numJoints = this.visibleJoints.length;
    // build index buffer once
    const vpb = this.cyl.verts.length; // verts per bone
    const vpj = this.sph.verts.length; // verts per joint
    const totalBoneV = this.edges.length * vpb;
    const idx: number[] = [];
    this.edges.forEach((_, e) => this.cyl.faces.forEach((f) =>
      idx.push(f[0] + e * vpb, f[1] + e * vpb, f[2] + e * vpb)));
    for (let j = 0; j < this.numJoints; j++)
      this.sph.faces.forEach((f) => idx.push(
        f[0] + totalBoneV + j * vpj, f[1] + totalBoneV + j * vpj, f[2] + totalBoneV + j * vpj));
    const nVerts = totalBoneV + this.numJoints * vpj;
    this.positions = new Float32Array(nVerts * 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(this.positions, 3));
    geo.setIndex(idx);
    this.mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
      color: 0xf7a470, roughness: 0.6, metalness: 0.05,
      side: THREE.DoubleSide, flatShading: true,
    }));
    this.group.add(this.mesh);
    this.setFrame(0);
  }
  get numFrames(): number { return this.joints ? this.joints.length : 0; }
  setFrame(f: number): void {
    this.setFrameFrac(f);
  }
  setFrameFrac(fi: number): void {
    if (!this.mesh || !this.joints) return;
    const max = this.joints.length - 1;
    const { ia, ib, t } = resolvePlaybackFrame(this.frameIndices, fi, max);
    const fr = this.joints[ia];
    if (!fr) return;
    const blend = t > 1e-5 && ia !== ib;
    const nxt = blend ? this.joints[ib] : undefined;
    const pos = this.positions;
    let o = 0;
    const r = this.boneRadius;
    for (const [pi, ci] of this.edges) {
      let sx = fr[pi][0], sy = fr[pi][1], sz = fr[pi][2];
      let ex = fr[ci][0], ey = fr[ci][1], ez = fr[ci][2];
      if (nxt) {
        sx += (nxt[pi][0] - sx) * t;
        sy += (nxt[pi][1] - sy) * t;
        sz += (nxt[pi][2] - sz) * t;
        ex += (nxt[ci][0] - ex) * t;
        ey += (nxt[ci][1] - ey) * t;
        ez += (nxt[ci][2] - ez) * t;
      }
      const s = [sx, sy, sz], e = [ex, ey, ez];
      let dx = e[0] - s[0], dy = e[1] - s[1], dz = e[2] - s[2];
      let len = Math.hypot(dx, dy, dz) || 1e-6;
      dx /= len; dy /= len; dz /= len;
      // orthonormal basis
      let rx, ry, rz;
      if (Math.abs(dx) < 0.9) { rx = 1; ry = 0; rz = 0; } else { rx = 0; ry = 1; rz = 0; }
      let ax = dy * rz - dz * ry, ay = dz * rx - dx * rz, az = dx * ry - dy * rx;
      let an = Math.hypot(ax, ay, az) || 1; ax /= an; ay /= an; az /= an;
      const ux = dy * az - dz * ay, uy = dz * ax - dx * az, uz = dx * ay - dy * ax;
      for (const v of this.cyl.verts) {
        pos[o++] = s[0] + ax * (v[0] * r) + ux * (v[1] * r) + dx * (v[2] * len);
        pos[o++] = s[1] + ay * (v[0] * r) + uy * (v[1] * r) + dy * (v[2] * len);
        pos[o++] = s[2] + az * (v[0] * r) + uz * (v[1] * r) + dz * (v[2] * len);
      }
    }
    const jr = this.jointRadius;
    for (const j of this.visibleJoints) {
      let cx = fr[j][0], cy = fr[j][1], cz = fr[j][2];
      if (nxt) {
        cx += (nxt[j][0] - cx) * t;
        cy += (nxt[j][1] - cy) * t;
        cz += (nxt[j][2] - cz) * t;
      }
      for (const v of this.sph.verts) {
        pos[o++] = cx + v[0] * jr; pos[o++] = cy + v[1] * jr; pos[o++] = cz + v[2] * jr;
      }
    }
    this.mesh.geometry.attributes.position.needsUpdate = true;
  }
}

// =================================================================  SCALED SKELETON (pre-IK, robot-calibrated)
class ScaledSkeletonView {
  readonly group: THREE.Group;
  joints: Vec3[][] | null = null;
  parents: number[] = [];
  frameIndices: number[] | null | undefined = null;
  spheres: Array<THREE.Mesh<THREE.SphereGeometry, THREE.MeshStandardMaterial>> = [];
  lineGeom: THREE.BufferGeometry | null = null;
  lines: THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial> | null = null;
  readonly color: number;
  clipDuration = 1;

  constructor(color = 0xffb020) {
    this.color = color;
    this.group = new THREE.Group();
    this.group.visible = false;
    world.add(this.group);
  }
  clear(): void {
    try {
      threeResourceDisposer.disposeObject3DChildren(this.group, {
        geometries: [
          ...this.spheres.map((sphere) => sphere.geometry),
          ...(this.lineGeom ? [this.lineGeom] : []),
        ],
        materials: [
          ...this.spheres.map((sphere) => sphere.material),
          ...(this.lines ? [this.lines.material] : []),
        ],
      });
    } finally {
      try {
        this.group.clear();
      } finally {
        this.spheres = [];
        this.joints = null;
        this.parents = [];
        this.frameIndices = null;
        this.lineGeom = null;
        this.lines = null;
      }
    }
  }
  load(motion: MotionPayload): void {
    this.clear();
    this.joints = motion.positions;
    this.parents = motion.parent_indices;
    this.frameIndices = motion.frame_indices;
    this.clipDuration = effectivePlaybackDuration(motion);
    const J = this.parents.length;
    const mat = new THREE.MeshStandardMaterial({
      color: this.color, roughness: 0.45, metalness: 0.15, emissive: 0x442200,
    });
    const sphereGeo = new THREE.SphereGeometry(0.026, 10, 10);
    for (let j = 0; j < J; j++) {
      const s = new THREE.Mesh(sphereGeo, mat);
      this.group.add(s);
      this.spheres.push(s);
    }
    const segCount = this.parents.filter((p) => p >= 0).length;
    const positions = new Float32Array(segCount * 2 * 3);
    this.lineGeom = new THREE.BufferGeometry();
    this.lineGeom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    this.lines = new THREE.LineSegments(
      this.lineGeom,
      new THREE.LineBasicMaterial({ color: this.color, transparent: true, opacity: 0.85 })
    );
    this.group.add(this.lines);
    this.setFrame(0);
  }
  get numFrames(): number { return this.joints ? this.joints.length : 0; }
  setFrame(f: number): void {
    this.setFrameFrac(f);
  }
  setFrameFrac(fi: number): void {
    if (!this.joints || !this.lineGeom) return;
    const max = this.joints.length - 1;
    const { ia, ib, t } = resolvePlaybackFrame(this.frameIndices, fi, max);
    const fr = this.joints[ia];
    if (!fr) return;
    const blend = t > 1e-5 && ia !== ib;
    const nxt = blend ? this.joints[ib] : undefined;
    for (let j = 0; j < this.spheres.length; j++) {
      if (nxt) {
        this.spheres[j].position.set(
          fr[j][0] + (nxt[j][0] - fr[j][0]) * t,
          fr[j][1] + (nxt[j][1] - fr[j][1]) * t,
          fr[j][2] + (nxt[j][2] - fr[j][2]) * t,
        );
      } else {
        this.spheres[j].position.set(fr[j][0], fr[j][1], fr[j][2]);
      }
    }
    const position = this.lineGeom.getAttribute("position") as THREE.BufferAttribute;
    const arr = position.array;
    let k = 0;
    for (let j = 0; j < this.parents.length; j++) {
      const p = this.parents[j];
      if (p < 0) continue;
      if (nxt) {
        arr[k++] = fr[j][0] + (nxt[j][0] - fr[j][0]) * t;
        arr[k++] = fr[j][1] + (nxt[j][1] - fr[j][1]) * t;
        arr[k++] = fr[j][2] + (nxt[j][2] - fr[j][2]) * t;
        arr[k++] = fr[p][0] + (nxt[p][0] - fr[p][0]) * t;
        arr[k++] = fr[p][1] + (nxt[p][1] - fr[p][1]) * t;
        arr[k++] = fr[p][2] + (nxt[p][2] - fr[p][2]) * t;
      } else {
        arr[k++] = fr[j][0]; arr[k++] = fr[j][1]; arr[k++] = fr[j][2];
        arr[k++] = fr[p][0]; arr[k++] = fr[p][1]; arr[k++] = fr[p][2];
      }
    }
    position.needsUpdate = true;
  }
}

// Scaled-environment interpolation reuses one scratch quaternion per frame.
const _robotRootQuatB = new THREE.Quaternion();

// =================================================================  PLAYER
const initialWorkspacePreferences = loadWorkspacePreferences();
const comparisonPresets: Record<WorkflowId, ComparisonPreset> = {
  ...initialWorkspacePreferences.comparisonPresets,
};
const skel = new SkeletonView();
const refSkel = new ReferenceSkeletonView();
const mesh = new CapsuleMeshView();
const skin = new BakedMeshView({ resourceDisposer: threeResourceDisposer });
// Extracted Views are inert until the compatibility composition root assigns
// their stable scene owner. A future Stage kernel can compose the same View.
world.add(skin.group);
const scaledSkel = new ScaledSkeletonView();
const envView = new EnvView();
const scaledEnv = new ScaledEnvView();
const robot = new RobotView({ resourceDisposer: threeResourceDisposer });
world.add(robot.group);
const ALL_VIEWS: PlaybackView[] = [skel, mesh, skin, scaledSkel, envView, scaledEnv, robot];
let playbarVisible = false;

// Logical H2R visibility survives temporary loss of the shared canvas. Only
// `applyH2rPhysicalVisibility` may project these intents onto Three.js groups.
const h2rRequestedVisibility: Record<H2rStageLayerId, boolean> = {
  sourceSkeleton: false,
  // Preserve the default source-body intent before a resource is available.
  // The projector still keeps both body groups physically hidden until loaded.
  sourceBody: true,
  sourceEnvironment: false,
  scaledSkeleton: false,
  scaledEnvironment: false,
  targetRobot: false,
};
let h2rOwnsStage = true;

interface PlayerController {
  playing: boolean;
  loop: boolean;
  t: number;
  duration: number;
  active: boolean;
  speed: number;
  _justLooped: boolean;
  _heavyTick: number;
  ready(duration: number): void;
  _applyFrac(frac: number, options?: { force?: boolean }): void;
  update(dt: number): void;
  setPlaying(playing: boolean): void;
  seek(fraction: number): void;
  setSpeed(multiplier: number): void;
  refreshFrame(): void;
  _syncScrub(fraction: number): void;
}

function publishPlaybackState(extra: Partial<PlaybackUiState> = {}): void {
  const src = state.motion || state.robotTrajectory;
  let label = `${player.t.toFixed(2)} / ${player.duration.toFixed(2)} s`;
  const sourceDuration = src?.duration ?? 0;
  const previewSourceDuration =
    isPlaybackPreview(src) && sourceDuration > player.duration + 0.5
      ? sourceDuration
      : null;
  if (previewSourceDuration !== null) {
    label += runtimeText(
      ` (preview; source ${previewSourceDuration.toFixed(1)} s)`,
      `（预览，原片 ${previewSourceDuration.toFixed(1)} s）`,
    );
  }
  window.dispatchEvent(new CustomEvent("hhtools:playback-state", {
    detail: {
      visible: playbarVisible,
      active: player.active,
      playing: player.playing,
      loop: player.loop,
      currentTime: player.t,
      duration: player.duration,
      previewSourceDuration,
      progress: player.duration > 0 ? player.t / player.duration : 0,
      speed: player.speed,
      label,
      ...extra,
    },
  }));
}

function bodyUsesSkin(): boolean {
  return skin.ready;
}

/**
 * Commit one logical H2R layer intent, reconcile the legacy renderer, then
 * request a batch-aware Stage snapshot publication.
 *
 * Internal compatibility call sites delegate to this semantic primitive, so
 * renderer state no longer depends on temporary HUD ids.
 */
function setH2rLayerVisible(layerId: H2rStageLayerId, on: boolean): void {
  if (state.calibrationMode && layerId !== "targetRobot" && on) return;
  h2rRequestedVisibility[layerId] = Boolean(on);
  applyH2rPhysicalVisibility();
  player.refreshFrame();
  markH2rStageDisplayChanged();
}

function setBodyVisible(on: boolean): void {
  setH2rLayerVisible("sourceBody", on);
}

function bodyIsRequestedVisible(): boolean {
  return h2rRequestedVisibility.sourceBody;
}

// All animatable views share ONE timeline (fraction of clip duration) so the
// human skeleton / body-mesh and the retargeted robot stay frame-synced and
// can be shown together.
const player: PlayerController = {
  playing: false,
  loop: initialWorkspacePreferences.playbackLoop,
  t: 0,
  duration: 0,
  active: false,
  speed: initialWorkspacePreferences.playbackSpeed,
  // Set by update() on a loop wrap; consumed by animate() to hard-snap the camera.
  _justLooped: false,
  ready(duration: number) {
    this.duration = Math.max(0.1, duration || 1);
    this.t = 0;
    this.active = true;
    this._justLooped = false;
    revealStage();
  },
  _heavyTick: 0,
  _applyFrac(frac: number, { force = false }: { force?: boolean } = {}) {
    if (r2r.calibrating || (state.calibrationMode && !r2r.active)) return;
    if (!force) this._heavyTick = (this._heavyTick + 1) % 2;
    const robotReady = Boolean(robot.trajectory && robot.trajectory.frames?.length);
    for (const v of ALL_VIEWS) {
      if (v.numFrames <= 0) continue;
      // Yellow overlay / scaled env only track playback once retarget has produced
      // a robot trajectory; otherwise they animate against a frozen robot pose.
      if ((v === scaledSkel || v === scaledEnv) && !robotReady) continue;
      // env views animate even when "invisible" to the HUD — except scaledEnv
      // which follows its toggle.
      if (!v.group.visible) continue;
      // Heavy views (robot mesh / baked body) update every other frame while
      // playing — but NEVER skip on a forced seek / loop wrap, or the robot
      // stays at the last frame for one tick while the timeline is already
      // back at the start (looks like a global teleport).
      if (!force && this.playing && v.heavy && this._heavyTick === 1) continue;
      const fi = frac * (v.numFrames - 1);
      if (v.setFrameFrac) v.setFrameFrac(fi);
      else v.setFrame(Math.min(v.numFrames - 1, Math.floor(fi)));
    }
  },
  update(dt: number) {
    if (!this.playing || !this.active) return;
    // Cap dt so a backgrounded tab cannot leap many seconds and land mid-clip
    // after a modulo wrap (reads as a random global jump on the 2nd play).
    const step = Math.min(Math.max(0, dt), 0.1) * this.speed;
    this.t += step;
    let looped = false;
    if (this.t >= this.duration) {
      if (this.loop) {
        // Exact restart at t=0 — do NOT use ``t % duration``.  Overshoot
        // remainder lands mid-first-frame (or much later after a large dt),
        // which looks like the robot teleporting to a wrong global pose
        // when the clip wraps for the second playthrough.
        this.t = 0;
        looped = true;
        this._justLooped = true;
      } else {
        this.t = this.duration;
        this.setPlaying(false);
      }
    }
    const frac = this.duration > 0 ? this.t / this.duration : 0;
    this._applyFrac(frac, { force: looped });
    this._syncScrub(frac);
  },
  setPlaying(p: boolean) {
    this.playing = p && this.active;
    publishPlaybackState();
  },
  seek(frac: number) {
    if (!this.active) return;
    const f = Math.min(1, Math.max(0, Number(frac) || 0));
    this.t = f * this.duration;
    this._justLooped = false;
    this._applyFrac(f, { force: true });
    this._syncScrub(f);
  },
  setSpeed(mult: number) {
    const m = Math.min(4, Math.max(0.1, Number(mult) || 1));
    this.speed = m;
    updateWorkspacePreferences({ playbackSpeed: m });
    publishPlaybackState();
  },
  // Re-pose whatever is currently visible at the current cursor (after a toggle).
  refreshFrame() {
    if (this.active) this._applyFrac(this.t / this.duration, { force: true });
  },
  _syncScrub(frac: number) {
    publishPlaybackState({ progress: frac });
  },
};

function revealStage(): void {
  // Empty/reset presentation is projected by React from the Stage model. The
  // compatibility runtime still owns playback visibility until its renderer
  // moves behind the Stage view contract.
  _setPlaybarVisible(true);
}

window.addEventListener("hhtools:playback-command", (event) => {
  const { action, value } = event.detail || {};
  if (action === "toggle") player.setPlaying(!player.playing);
  else if (action === "seek") player.seek(value ?? 0);
  else if (action === "speed") player.setSpeed(value ?? 1);
  else if (action === "loop") {
    player.loop = !player.loop;
    updateWorkspacePreferences({ playbackLoop: player.loop });
    publishPlaybackState();
  }
});

// ----------------------------------------------------------------- view toggles
function motionHasEnvironment(payload: MotionPayload | null | undefined): boolean {
  if (!payload) return false;
  if (payload.has_terrain || payload.terrain) return true;
  if (Array.isArray(payload.objects) && payload.objects.length > 0) return true;
  const meta = payload.meta;
  if (meta && typeof meta === "object") {
    if (meta.terrain_mesh) return true;
    if (Number(meta.num_objects) > 0) return true;
  }
  return false;
}

function h2rLayerAvailability(): Record<H2rStageLayerId, boolean> {
  return {
    sourceSkeleton: skel.numFrames > 0,
    sourceBody: mesh.ready || skin.ready,
    sourceEnvironment: motionHasEnvironment(state.motion),
    scaledSkeleton: scaledSkel.numFrames > 0,
    scaledEnvironment:
      scaledEnv.numFrames > 0 || scaledEnv.group.children.length > 0,
    targetRobot: state.robot !== null && robot.links.length > 0,
  };
}

/**
 * Sole authority for the seven physical H2R groups (body uses mesh + skin).
 * Resource loads may finish while R2R owns the canvas; requested visibility is
 * retained, but every H2R group stays physically hidden until ownership returns.
 */
function applyH2rPhysicalVisibility(): void {
  const available = h2rLayerAvailability();
  const physical = projectH2rPhysicalVisibility({
    ownsStage: h2rOwnsStage,
    calibrationMode: state.calibrationMode,
    bodyUsesSkin: bodyUsesSkin(),
    requested: h2rRequestedVisibility,
    available,
  });

  skel.group.visible = physical.sourceSkeleton;
  skin.group.visible = physical.sourceBodySkin;
  mesh.group.visible = physical.sourceBodyMesh;
  envView.group.visible = physical.sourceEnvironment;
  scaledSkel.group.visible = physical.scaledSkeleton;
  scaledEnv.group.visible = physical.scaledEnvironment;
  robot.group.visible = physical.targetRobot;
}

function emitResultDiagnostics(
  workflow: WorkflowId,
  diagnostics: ResultDiagnostics | null,
): void {
  window.dispatchEvent(new CustomEvent("hhtools:result-diagnostics", {
    detail: {
      workflow,
      diagnostics,
      comparisonPreset: comparisonPresets[workflow],
    },
  }));
}

function clearResultDiagnostics(workflow: WorkflowId): void {
  emitResultDiagnostics(workflow, null);
}

function emitComparisonState(workflow: WorkflowId): void {
  window.dispatchEvent(new CustomEvent("hhtools:comparison-state", {
    detail: { workflow, preset: comparisonPresets[workflow] },
  }));
}

/** Apply a repeatable H2R visibility preset without changing any trajectory data. */
function applyH2rComparisonPreset(preset: ComparisonPreset): void {
  // One comparison choice changes all six layers. Publish only the final
  // arrangement so Workbench cannot observe a half-applied preset.
  withH2rStageDisplayBatch(() => {
    comparisonPresets.h2r = preset;
    const showSource = preset === "source" || preset === "overlay";
    const showTarget = preset === "target" || preset === "overlay";
    const showResult = preset === "result" || preset === "overlay";

    setH2rLayerVisible("sourceSkeleton", showSource && skel.numFrames > 0);
    // The opaque body is useful by itself, but hides the diagnostic overlays.
    setBodyVisible(preset === "source" && Boolean(state.motion));
    setH2rLayerVisible(
      "sourceEnvironment",
      preset === "source" && motionHasEnvironment(state.motion),
    );
    setH2rLayerVisible("scaledSkeleton", showTarget && scaledSkel.numFrames > 0);
    setH2rLayerVisible(
      "scaledEnvironment",
      (showTarget || showResult) &&
        (scaledEnv.numFrames > 0 || scaledEnv.group.children.length > 0),
    );
    setH2rLayerVisible("targetRobot", showResult && Boolean(robot.trajectory));
  });
  emitComparisonState("h2r");
}

/**
 * Execute one H2R toggle against renderer-current state.
 *
 * The browser facade can cross an async readiness boundary after the click, so
 * capability is deliberately revalidated here rather than trusted from the
 * React snapshot that enabled the button.
 */
export function toggleH2rStageLayer(layerId: H2rStageLayerId): void {
  if (!Object.hasOwn(h2rRequestedVisibility, layerId)) return;
  const current = collectH2rStageDisplaySnapshot().layers[layerId];
  if (!current.canToggle) return;
  setH2rLayerVisible(layerId, !h2rRequestedVisibility[layerId]);
}

/** Remove preview resources derived from the previous motion/robot pair. */
function clearH2rScaledPreview(): void {
  withH2rStageDisplayBatch(() => {
    scaledSkel.clear();
    scaledEnv.clear();
    setH2rLayerVisible("scaledSkeleton", false);
    setH2rLayerVisible("scaledEnvironment", false);
  });
}

/** Run one renderer/UI cleanup without letting it block canonical state reset. */
function runBestEffortCleanup(context: string, cleanup: () => void): void {
  try {
    cleanup();
  } catch (error) {
    console.warn(context, errorMessage(error));
  }
}

interface RobotViewLoadAttempt {
  readonly completion: Promise<AsyncStageViewLoadResult>;
  readonly generation: number;
}

/** Capture the View generation synchronously before awaiting its completion. */
function startRobotViewLoad(
  view: RobotView,
  payload: RobotPayload,
): RobotViewLoadAttempt {
  const completion = view.load(payload);
  return { completion, generation: view.loadGeneration };
}

/**
 * Remove the H2R robot capability after its current RobotView generation fails.
 *
 * RobotView has already invalidated the previous generation at this point, so
 * keeping the old payload would advertise a renderer capability that no longer
 * exists. Canonical aliases are reset independently of best-effort GPU/UI
 * cleanup. This function deliberately does not clear RobotView again: a load
 * failure already did so, while deletion performs its own explicit clear.
 */
function clearH2rRobotAfterViewLoss(context: string): void {
  const calibrationRestore = state.calibRestore;

  h2rCalibrationBootstrapAttempts.invalidate();
  h2rCalibrationStatusAttempts.invalidate();
  // FK Promises cannot be cancelled, so withdraw their publication owner
  // before any robot or calibration aliases are released.
  h2rCalibrationFkPreview.stop();

  // If calibration teardown stopped part-way through, restore orbit ownership
  // before releasing its saved snapshot.
  if (state.calibOrbitSaved) {
    const saved = state.calibOrbitSaved;
    runBestEffortCleanup(`${context}: calibration orbit restore failed`, () => {
      orbit.minDistance = saved.minDistance;
      orbit.maxDistance = saved.maxDistance;
      orbit.zoomSpeed = saved.zoomSpeed;
    });
  }

  state.robot = null;
  state.robotTrajectory = null;
  state.exportToken = null;
  state.exportSrcFps = null;
  state.exportHasScene = false;
  state.calibration = false;
  state.calibrationMode = false;
  state.calibNeedsCameraFocus = false;
  state.calibOrbitSaved = null;
  state.calibRestore = null;
  state.calibLimits = null;
  state.calibQ = {};
  state.calibSliderRows = {};
  state.calibBaselineQ = null;
  state.calibDraftQ = null;
  state.calibHasSaved = false;
  calibrationEditorUi.h2r.comparison = "current";
  h2rRunState = "idle";

  runBestEffortCleanup(`${context}: calibration manipulator cleanup failed`, () => calibManip.stop());
  if (calibrationRestore) {
    runBestEffortCleanup(
      `${context}: calibration visibility restore failed`,
      () => _restoreVis(calibrationRestore),
    );
  }
  runBestEffortCleanup(`${context}: reference cleanup failed`, () => refSkel.clear());
  refSkel.group.visible = false;
  robot.trajectory = null;
  runBestEffortCleanup(`${context}: Stage cleanup failed`, () => {
    withH2rStageDisplayBatch(() => {
      runBestEffortCleanup(`${context}: scaled skeleton cleanup failed`, () => scaledSkel.clear());
      runBestEffortCleanup(`${context}: scaled environment cleanup failed`, () => scaledEnv.clear());
      setH2rLayerVisible("scaledSkeleton", false);
      setH2rLayerVisible("scaledEnvironment", false);
      setH2rLayerVisible("targetRobot", false);
    });
  });
  runBestEffortCleanup(
    `${context}: result diagnostics cleanup failed`,
    () => clearResultDiagnostics("h2r"),
  );

  document.getElementById("calib-banner")?.classList.add("hidden");
  const robotMetaCard = document.getElementById("robot-meta-card");
  if (robotMetaCard) robotMetaCard.style.display = "none";
  const exportCard = document.getElementById("rt-export-card");
  if (exportCard) exportCard.style.display = "none";
  const batchRobot = document.getElementById("batch-robot");
  if (batchRobot) batchRobot.textContent = runtimeText("Not loaded", "未加载");

  runBestEffortCleanup(`${context}: robot UI refresh failed`, () => {
    updatePills();
    syncRefSelect();
    populateH2rRobotSelect();
    populateBatchRobotSelect();
    renderRobotLibrary();
    renderBasket();
    publishH2rWorkflowState();
    emitCalibrationEditorState("h2r");
  });
  void refreshRetargetPanel().catch((error) => {
    console.warn(`${context}: retarget UI refresh failed`, errorMessage(error));
  });
}

async function refreshScaledPreview(): Promise<void> {
  if (!state.motion || !state.robot || !state.calibration) {
    clearH2rScaledPreview();
    return;
  }
  const motionToken = state.motion.token;
  const robotName = state.robot.name;
  const reference = state.reference;
  const inputsAreCurrent = (): boolean =>
    state.motion?.token === motionToken &&
    state.robot?.name === robotName &&
    state.reference === reference &&
    state.calibration;
  try {
    const data = await API.post("/api/scaled_preview", {
      robot: robotName,
      motion_token: motionToken,
      reference,
    });
    // A newer selection owns the renderer now; an old response must not
    // replace its scaled resources or publish a stale Stage snapshot.
    if (!inputsAreCurrent()) return;
    const preview = data.preview ?? data;
    withH2rStageDisplayBatch(() => {
      scaledSkel.load(preview);
      if (data.scaled_scene) {
        scaledEnv.load(data.scaled_scene, motionToken);
      } else {
        scaledEnv.clear();
      }
      // Preload yellow overlay data but keep it hidden until a retarget completes
      // (or the user explicitly toggles it on). Playing motion against a frozen
      // calibration / zero robot makes the overlay look collapsed inside the mesh.
      if (!state.robotTrajectory) {
        setH2rLayerVisible("scaledSkeleton", false);
        setH2rLayerVisible("scaledEnvironment", false);
      }
      if (player.active) player.refreshFrame();
    });
  } catch (e) {
    if (!inputsAreCurrent()) return;
    clearH2rScaledPreview();
    console.warn("scaled preview", errorMessage(e));
  }
}

// =================================================================  H2R STATE
/**
 * Canonical H2R session state. Loading another motion or robot invalidates the
 * calibration, trajectory, diagnostics, and export values derived from the old
 * pair. Compatibility DOM controls are projections, never another state source.
 */
const state: AppState = {
  motion: null, // serialized payload incl token
  libraryEntry: null, // resource-library row for batch basket
  robot: null, // serialized robot
  reference: null,
  calibration: false,
  calibrationMode: false,
  calibNeedsCameraFocus: false,
  calibOrbitSaved: null,
  calibLimits: null,
  calibRestore: null,
  exportToken: null,
  calibQ: {},
  calibSliderRows: {},
  calibBaselineQ: null,
  calibDraftQ: null,
  calibHasSaved: false,
  exportSrcFps: null,
  exportHasScene: false,
  robotTrajectory: null,
  robotPanelLocked: false,
};

/**
 * Read one complete H2R display projection from renderer-owned state.
 *
 * Availability comes from loaded resources, visibility from Three.js groups,
 * and interaction capability from the active workflow mode. Keeping those
 * meanings separate prevents a hidden resource from being mistaken for an
 * unavailable one when React later renders the Stage controls.
 */
function collectH2rStageDisplaySnapshot(): H2rStageDisplaySnapshot {
  const available = h2rLayerAvailability();
  const h2rSnapshot = projectH2rStageDisplaySnapshot({
    ownsStage: h2rOwnsStage,
    calibrationMode: state.calibrationMode,
    hasMotion: state.motion !== null,
    hasRobot: state.robot !== null,
    layers: {
      sourceSkeleton: {
        available: available.sourceSkeleton,
        visible: skel.group.visible,
      },
      sourceBody: {
        available: available.sourceBody,
        visible: skin.group.visible || mesh.group.visible,
      },
      sourceEnvironment: {
        available: available.sourceEnvironment,
        visible: envView.group.visible,
      },
      scaledSkeleton: {
        available: available.scaledSkeleton,
        visible: scaledSkel.group.visible,
      },
      scaledEnvironment: {
        available: available.scaledEnvironment,
        visible: scaledEnv.group.visible,
      },
      targetRobot: {
        available: available.targetRobot,
        visible: robot.group.visible,
      },
    },
  });
  if (h2rOwnsStage) return h2rSnapshot;

  // The passive source describes the active shared surface while retaining
  // H2R's confirmed layer facts for the eventual ownership hand-back.
  return { ...h2rSnapshot, ...collectR2rStageSurface() };
}

const h2rStageDisplayPublisher = new H2rStageDisplayPublisher(
  collectH2rStageDisplaySnapshot,
  (error) => console.error("H2R Stage display projection failed", error),
);

function markH2rStageDisplayChanged(): void {
  applyH2rPhysicalVisibility();
  h2rStageDisplayPublisher.markChanged();
}

function withH2rStageDisplayBatch(operation: () => void): void {
  h2rStageDisplayPublisher.runBatch(() => {
    try {
      operation();
    } finally {
      // Pure resource load/clear operations can change availability without
      // calling a visibility setter, so every batch ends with one projection.
      applyH2rPhysicalVisibility();
    }
  });
}

/**
 * Passive legacy-local source consumed by the browser facade at Restored.
 * Subscribing here never starts the runtime and installs no global DOM event.
 */
export function subscribeH2rStageDisplayState(
  listener: H2rStageDisplayListener,
): () => void {
  return h2rStageDisplayPublisher.subscribe(listener);
}

interface CalibrationEditorUiState {
  query: string;
  region: CalibrationJointRegion | "all";
  unit: CalibrationAngleUnit;
  comparison: CalibrationComparisonMode;
  mappedOnly: boolean;
  labels: boolean;
  mappingLines: boolean;
  sourceOpacity: number;
  robotOpacity: number;
}

function createCalibrationEditorUiState(): CalibrationEditorUiState {
  return {
    query: "",
    region: "all",
    unit: "rad",
    comparison: "current",
    mappedOnly: true,
    labels: true,
    mappingLines: true,
    sourceOpacity: 0.82,
    robotOpacity: 0.72,
  };
}

const calibrationEditorUi: Record<WorkflowId, CalibrationEditorUiState> = {
  h2r: createCalibrationEditorUiState(),
  r2r: createCalibrationEditorUiState(),
};

type WorkflowRunState = "idle" | "running" | "completed" | "failed";

let h2rRunState: WorkflowRunState = "idle";

function emitWorkflowState(detail: WorkflowStateDetail): void {
  window.dispatchEvent(new CustomEvent("hhtools:workflow-state", { detail }));
}

function workflowNode(
  id: string,
  label: string,
  stateName: WorkflowNodeState,
  detail: string,
  panel: WorkflowNodeStatus["panel"],
): WorkflowNodeStatus {
  return { id, label, state: stateName, detail, panel };
}

function h2rBlockedReason(): string | null {
  if (!state.motion) return runtimeText(
    "Source motion is missing. Load a clip from Motion first.",
    "缺少源 Motion：请先在“动作 Motion”中加载一个 clip。",
  );
  if (!state.robot) return runtimeText(
    "Target robot is missing. Load a robot model from the Robot Library first.",
    "缺少目标机器人：请先在机器人库中加载 Robot Model。",
  );
  if (!state.reference) return runtimeText(
    "The source reference format was not recognized. Check the motion format or select a reference pose manually.",
    "未识别源参考格式：请检查 Motion 格式或手动选择参考姿态。",
  );
  if (!state.calibration) {
    return runtimeText(
      `Calibration is missing for ${state.robot.display_name} + ${referenceLabel(state.reference)}.`,
      `缺少 ${state.robot.display_name} + ${referenceLabel(state.reference)} 标定配置。`,
    );
  }
  if (state.robotPanelLocked || h2rRunState === "running") return runtimeText(
    "Retarget is running. Wait for the current task to finish.",
    "Retarget 正在运行，请等待当前任务完成。",
  );
  return null;
}

function publishH2rWorkflowState(): void {
  const blockedReason = h2rBlockedReason();
  const solverReady = blockedReason == null || h2rRunState === "running";
  const solverState: WorkflowNodeState = h2rRunState === "running"
    ? "running"
    : h2rRunState === "failed"
      ? "failed"
      : state.exportToken
        ? "completed"
        : solverReady
          ? "ready"
          : "missing";
  const resultState: WorkflowNodeState = state.exportToken
    ? "completed"
    : h2rRunState === "failed"
      ? "failed"
      : "missing";
  const calibrationState: WorkflowNodeState = state.calibrationMode
    ? "running"
    : state.calibration
      ? "ready"
      : state.robot && state.reference
        ? "warning"
        : "missing";

  const nodes: WorkflowNodeStatus[] = [
    workflowNode(
      "motion",
      runtimeText("Motion", "动作"),
      state.motion ? "ready" : "missing",
      state.motion?.name || runtimeText("Not selected", "未选择"),
      "motion",
    ),
    workflowNode(
      "robot",
      runtimeText("Robot", "机器人"),
      state.robot ? "ready" : "missing",
      state.robot?.display_name || runtimeText("Not selected", "未选择"),
      "robot-assets",
    ),
    workflowNode(
      "calibration",
      runtimeText("Calibration", "标定"),
      calibrationState,
      state.calibrationMode
        ? runtimeText("Editing", "正在编辑")
        : state.calibration
          ? referenceLabel(state.reference)
          : runtimeText("Not ready", "未就绪"),
      "h2r",
    ),
    workflowNode(
      "solver",
      runtimeText("Solver", "求解"),
      solverState,
      h2rRunState === "running"
        ? runtimeText("Running", "运行中")
        : state.exportToken
          ? runtimeText("Completed", "已完成")
          : solverReady
            ? runtimeText("Ready to run", "可以运行")
            : runtimeText("Waiting for input", "等待输入"),
      "h2r",
    ),
    workflowNode(
      "result",
      runtimeText("Result", "结果"),
      resultState,
      state.exportToken
        ? runtimeText("Ready to preview/export", "可预览/导出")
        : h2rRunState === "failed"
          ? runtimeText("Run failed", "运行失败")
          : runtimeText("No result yet", "尚无结果"),
      "h2r",
    ),
  ];

  const runButton = document.getElementById("retarget-btn");
  if (runButton) runButton.disabled = blockedReason != null;
  const reason = document.getElementById("retarget-disabled-reason");
  if (reason) reason.textContent = blockedReason || "";
  emitWorkflowState({ workflow: "h2r", nodes, blockedReason });
}

function renderRobotValidation(robotPayload: RobotPayload): void {
  const mappings = Object.entries(robotPayload.ik_map ?? {});
  const mappedLinks = mappings
    .map(([, target]) => ikMapTargetLink(target))
    .filter((target): target is string => Boolean(target));
  const knownLinks = new Set(robotPayload.links ?? []);
  const unresolved = mappedLinks.filter((link) => !knownLinks.has(link));
  const dofCount = robotPayload.num_dof ?? robotPayload.joints?.length ?? 0;
  renderValidationSummary(document.getElementById("robot-validation-summary"), [
    [dofCount > 0 ? "ok" : "error", runtimeText(
      `${dofCount} controllable DoF`,
      `${dofCount} 个可控 DoF`,
    )],
    [mappings.length > 0 ? "ok" : "warn", runtimeText(
      `ik_map: ${mappings.length}/17 semantic slots`,
      `ik_map：${mappings.length}/17 个语义槽位`,
    )],
    [unresolved.length === 0 ? "ok" : "error", unresolved.length === 0
      ? runtimeText(
        "All target links in ik_map resolve in the robot model",
        "ik_map 中的目标 link 均可解析",
      )
      : runtimeText(
        `${unresolved.length} ik_map links do not resolve in the robot model`,
        `${unresolved.length} 个 ik_map link 无法在 Robot Model 中解析`,
      )],
  ]);
}

function renderMotionValidation(payload: MotionPayload): void {
  const frameCount = payload.num_frames_total ?? payload.positions.length;
  const frameRate = payload.framerate ?? payload.sample_rate ?? 0;
  const boneCount = payload.bone_names?.length ?? payload.parent_indices.length;
  const sceneParts: string[] = [];
  if (payload.has_terrain || payload.terrain) sceneParts.push(runtimeText("terrain", "地形"));
  if (payload.objects?.length) {
    sceneParts.push(runtimeText(
      `${payload.objects.length} interaction object${payload.objects.length === 1 ? "" : "s"}`,
      `${payload.objects.length} 个交互物体`,
    ));
  }

  renderValidationSummary(document.getElementById("motion-validation-summary"), [
    [frameCount > 0 ? "ok" : "error", frameCount > 0
      ? runtimeText(`Playable trajectory: ${frameCount} frames`, `轨迹可播放：${frameCount} 帧`)
      : runtimeText("The trajectory has no playable frames", "轨迹不包含可播放帧")],
    [frameRate > 0 ? "ok" : "warn", frameRate > 0
      ? runtimeText(`Valid timeline: ${frameRate.toFixed(1)} FPS`, `时间轴有效：${frameRate.toFixed(1)} FPS`)
      : runtimeText(
        "Frame rate was not detected; the default timeline will be used",
        "未识别帧率，将使用默认时间轴",
      )],
    [boneCount > 0 ? "ok" : "error", boneCount > 0
      ? runtimeText(`Skeleton hierarchy: ${boneCount} nodes`, `骨架层级：${boneCount} 个节点`)
      : runtimeText("Skeleton hierarchy was not detected", "未识别骨架层级")],
    ["ok", sceneParts.length > 0
      ? runtimeText(`Scene data: ${sceneParts.join(", ")}`, `场景附属数据：${sceneParts.join("、")}`)
      : runtimeText(
        "Motion only: no terrain or interaction objects",
        "纯动作轨迹：无地形或交互物体",
      )],
  ]);
}

function renderMotionDetails(payload: MotionPayload): void {
  document.getElementById("motion-meta-card").style.display = "block";
  document.getElementById("motion-name").textContent = payload.name;
  const previewNote = isPlaybackPreview(payload)
    ? runtimeText(
      ` (preview: ${payload.playback_frames ?? payload.positions.length} frames / ${effectivePlaybackDuration(payload).toFixed(1)} s)`,
      `（预览 ${payload.playback_frames ?? payload.positions.length} 帧 / ${effectivePlaybackDuration(payload).toFixed(1)} s）`,
    )
    : "";
  const motionRows: Array<[string, unknown]> = [
    [runtimeText("Format", "格式"), payload.source_format],
    [runtimeText("Frames", "帧数"), payload.num_frames_total],
    [runtimeText("Frame rate", "帧率"), `${(payload.framerate ?? payload.sample_rate ?? 30).toFixed(1)}`],
    [runtimeText("Duration", "时长"), `${effectivePlaybackDuration(payload).toFixed(2)} s${previewNote}`],
    [runtimeText("Skeleton", "骨骼"), payload.bone_names?.length ?? payload.parent_indices.length],
  ];
  if (payload.objects?.length) {
    motionRows.push([runtimeText("Interaction objects", "交互物体"), payload.objects.length]);
  }
  if (payload.has_terrain) motionRows.push([runtimeText("Terrain", "地形"), runtimeText("Yes", "有")]);
  motionRows.push([
    runtimeText("Body mesh", "身体 mesh"),
    payload.body_mesh?.available
      ? runtimeText("SMPL / skin", "SMPL / 皮肤")
      : payload.body_mesh?.reason || runtimeText("Tubular approximation", "管状近似"),
  ]);
  renderMetaRows(document.getElementById("motion-meta"), motionRows);
  renderMotionValidation(payload);
}

function updateH2rCalibrationValidation(): void {
  const scope = document.getElementById("calibration-scope");
  if (scope) {
    scope.textContent = state.robot && state.reference
      ? runtimeText(
        `Scope: ${state.robot.display_name} + ${referenceLabel(state.reference)}`,
        `配置范围：${state.robot.display_name} + ${referenceLabel(state.reference)}`,
      )
      : runtimeText(
        "Scope: target robot + source reference",
        "配置范围：目标机器人 + 源参考格式",
      );
  }
  if (!state.robot) {
    renderValidationSummary(document.getElementById("calibration-validation-summary"), []);
    return;
  }

  const mappings = Object.entries(state.robot.ik_map ?? {});
  const knownLinks = new Set(state.robot.links ?? []);
  const unresolved = mappings.filter(([, target]) => {
    const link = ikMapTargetLink(target);
    return link != null && !knownLinks.has(link);
  });
  const limits = new Map((state.calibLimits ?? []).map((limit) => [limit.name, limit]));
  const nearLimit = Object.entries(state.calibQ).filter(([joint, value]) => {
    const limit = limits.get(joint);
    if (limit?.lower == null || limit.upper == null || limit.upper <= limit.lower) return false;
    const span = limit.upper - limit.lower;
    return value - limit.lower < span * 0.03 || limit.upper - value < span * 0.03;
  });
  const changed = Object.values(state.calibQ).filter((value) => Math.abs(value) > 1e-4).length;

  renderValidationSummary(document.getElementById("calibration-validation-summary"), [
    [mappings.length > 0 ? "ok" : "warn", runtimeText(
      `Semantic mapping: ${mappings.length}/17 ik_map slots`,
      `语义映射：${mappings.length}/17 个 ik_map 槽位`,
    )],
    [unresolved.length === 0 ? "ok" : "error", unresolved.length === 0
      ? runtimeText("All mapped robot links resolve", "映射的机器人 link 均可解析")
      : runtimeText(
        `${unresolved.length} mapped links cannot be resolved`,
        `${unresolved.length} 个映射 link 无法解析`,
      )],
    [nearLimit.length === 0 ? "ok" : "warn", nearLimit.length === 0
      ? runtimeText("No joints are near their limits", "当前关节均未接近限位")
      : runtimeText(
        `${nearLimit.length} joints are near their URDF limits`,
        `${nearLimit.length} 个关节接近 URDF 限位`,
      )],
    ["ok", runtimeText(
      `Current edit: ${changed} non-zero joints`,
      `当前编辑：${changed} 个非零关节`,
    )],
    ...calibrationDiagnosticRows(robot),
  ]);
}

const REFERENCE_LABELS: Record<string, string> = {
  smpl: "SMPL",
  smplx: "SMPL-X",
  gvhmr: "GVHMR",
  soma_bvh: "SOMA BVH",
  lafan_bvh: "LAFAN / Mixamo BVH",
  mocap_bvh: "MOCAP BVH (Spine3 chest)",
  xsens_mocap: "Xsens mocap BVH",
  glb: "GLB / GLTF",
};

/** Mirror server ``_DATASET_TO_REFERENCE`` for basket rows without ``reference``. */
const DATASET_TO_REFERENCE: Record<string, string> = {
  amass: "smpl",
  motion_x: "smplx",
  phuma: "smpl",
  lafan: "lafan_bvh",
  mocap: "mocap_bvh",
  soma: "soma_bvh",
  xsens_mocap: "xsens_mocap",
  gvhmr: "gvhmr",
  omomo: "smplx",
  meshmimic_holosoma: "smplx",
  glb: "glb",
  unified_npz: "smpl",
  parc_ms: "smpl",
};

function entryReference(e: LibraryEntry | null | undefined, fallback = "smpl"): string {
  const datasetReference = e?.dataset ? DATASET_TO_REFERENCE[e.dataset] : undefined;
  return (e?.reference || "").trim() || datasetReference || fallback;
}

function referenceLabel(ref: string | null | undefined): string {
  return (ref ? REFERENCE_LABELS[ref] : undefined) || ref || "—";
}

/** Human-readable adapter / dataset id (basket ``dataset`` field). */
const DATASET_LABELS: Record<string, readonly [string, string]> = {
  soma: ["SOMA BVH", "SOMA BVH"],
  lafan: ["LAFAN / Mixamo BVH", "LAFAN / Mixamo BVH"],
  mocap: ["MOCAP BVH (Spine3 chest)", "MOCAP BVH（Spine3 胸部）"],
  xsens_mocap: ["Xsens mocap BVH", "Xsens mocap BVH"],
  amass: ["AMASS (SMPL parameters)", "AMASS（SMPL 参数）"],
  motion_x: ["Motion-X (SMPL-X)", "Motion-X（SMPL-X）"],
  phuma: ["PHUMA (SMPL)", "PHUMA（SMPL）"],
  gvhmr: ["GVHMR (SMPL-H)", "GVHMR（SMPL-H）"],
  omomo: ["OMOMO (SMPL-X)", "OMOMO（SMPL-X）"],
  glb: ["GLB skeleton", "GLB 骨骼"],
  parc_ms: ["parc_ms / meshmimic", "parc_ms / meshmimic"],
  meshmimic_holosoma: ["holosoma NPY", "holosoma NPY"],
  unified_npz: ["hhtools NPZ", "hhtools NPZ"],
  unknown: ["Unknown", "未识别"],
};

/**
 * What each calibration reference means for retarget (not the same as SMPL weights).
 * ``reference`` = which saved calibration YAML + reference T-pose to use.
 */
const REFERENCE_HELP: Record<string, { input: string; calib: string; file: string }> = {
  soma_bvh: {
    input: "SOMA 统一比例骨架 .bvh（关节名如 Hips、LeftUpLeg；来自 SOMA / soma-retargeter）",
    calib: "标定参考「SOMA BVH」— 对齐<b>蓝色 SOMA 标准骨架</b>与机器人",
    file: "retarget_calibration_soma_bvh.yaml",
  },
  lafan_bvh: {
    input: "LAFAN / Mixamo 风格 .bvh（如 Hips、LeftLeg）",
    calib: "标定参考「LAFAN / Mixamo BVH」— 对齐<b>蓝色 LAFAN 参考骨架</b>",
    file: "retarget_calibration_lafan_bvh.yaml",
  },
  mocap_bvh: {
    input: "四节脊柱 MOCAP .bvh（Hips、Spine3 挂肩、LeftToeBase）",
    calib: "标定参考「MOCAP BVH」— 对齐<b>蓝色 MOCAP 参考骨架</b>（Spine3 = chest）",
    file: "retarget_calibration_mocap_bvh.yaml",
  },
  xsens_mocap: {
    input: "Xsens MVN / 生物力学 .bvh（如 Hips、LeftHip、LeftKnee、Chest）",
    calib: "标定参考「Xsens mocap BVH」— 对齐<b>蓝色 Xsens 参考骨架</b>",
    file: "retarget_calibration_xsens_mocap.yaml",
  },
  smpl: {
    input: "AMASS / SMPL 参数 .npz（poses + trans，需 SMPL 体模）",
    calib: "标定参考「SMPL」— 对齐<b>蓝色 SMPL T-pose 参考骨架</b>",
    file: "retarget_calibration_smpl.yaml",
  },
  smplx: {
    input: "SMPL-X 参数或 OMOMO / Motion-X 等",
    calib: "标定参考「SMPL-X」— 对齐<b>蓝色 SMPL-X 参考骨架</b>",
    file: "retarget_calibration_smplx.yaml",
  },
  gvhmr: {
    input: "GVHMR / HMR4D 输出的 .pt 或 SMPL-H 轨迹",
    calib: "标定参考「GVHMR」— 对齐<b>蓝色 GVHMR 参考骨架</b>",
    file: "retarget_calibration_gvhmr.yaml",
  },
  glb: {
    input: "带骨骼的 .glb / .gltf",
    calib: "标定参考「GLB / GLTF」— 对齐<b>蓝色 GLB 第 0 帧参考骨架</b>",
    file: "retarget_calibration_glb.yaml",
  },
};

function datasetLabel(ds: string | null | undefined): string {
  if (!ds || ds === "unknown") return runtimeText("Unknown", "未识别");
  const labels = DATASET_LABELS[ds];
  return labels ? runtimeText(labels[0], labels[1]) : ds;
}

let referenceCatalog: string[] = [];

async function loadReferenceCatalog(): Promise<void> {
  try {
    const { references } = await API.get("/api/calibration/references");
    referenceCatalog = references?.length ? references : Object.keys(REFERENCE_LABELS);
  } catch {
    referenceCatalog = Object.keys(REFERENCE_LABELS);
  }
  populateRefSelect();
}

function populateRefSelect(): void {
  const sel = document.getElementById("rt-ref-select");
  if (!sel) return;
  const prev = state.reference || sel.value;
  sel.innerHTML = "";
  const blank = document.createElement("option");
  blank.value = "";
  blank.textContent = "—";
  sel.appendChild(blank);
  for (const ref of referenceCatalog) {
    const opt = document.createElement("option");
    opt.value = ref;
    opt.textContent = REFERENCE_LABELS[ref] || ref;
    sel.appendChild(opt);
  }
  if (prev && [...sel.options].some((o) => o.value === prev)) sel.value = prev;
  syncRefSelect();
}

function syncRefSelect(): void {
  const sel = document.getElementById("rt-ref-select");
  if (!sel) return;
  if (state.reference && [...sel.options].some((o) => o.value === state.reference)) {
    sel.value = state.reference;
  } else if (!state.reference) {
    sel.value = "";
  }
  sel.disabled = !state.robot;
  const hint = document.getElementById("rt-ref-hint");
  if (!hint) return;
  if (state.motion?.dataset) {
    const ref = state.reference || "—";
    hint.textContent = runtimeText(
      `Detected dataset: ${state.motion.dataset} → suggested reference ${ref}`,
      `自动识别数据集: ${state.motion.dataset} → 建议参考 ${ref}`,
    );
    hint.style.display = "block";
  } else {
    hint.textContent = "";
    hint.style.display = "none";
  }
}

async function onReferenceChange(newRef: string): Promise<void> {
  if (!newRef || newRef === state.reference) return;
  const wasCalibrating = state.calibrationMode;
  const savedQ = wasCalibrating ? { ...state.calibQ } : null;
  if (wasCalibrating) exitCalibrationMode();
  // Scale parameters and every retarget result belong to one exact
  // motion/robot/reference tuple. Invalidate them before querying calibration
  // for the new reference so an old preview can never masquerade as current.
  withH2rStageDisplayBatch(() => {
    state.reference = newRef;
    state.calibration = false;
    state.robotTrajectory = null;
    state.exportToken = null;
    robot.trajectory = null;
    if (state.robot) robot.applyStatic();
    h2rRunState = "idle";
    clearResultDiagnostics("h2r");
    clearH2rScaledPreview();
  });
  document.getElementById("rt-export-card").style.display = "none";
  syncRefSelect();
  if (wasCalibrating && state.robot && state.motion) {
    await enterCalibrationMode(savedQ);
  } else {
    await refreshRetargetPanel();
  }
}

function updatePills(): void {
  document.getElementById("motion-pill").textContent = state.motion
    ? `🎞 ${state.motion.name}` : runtimeText("No motion loaded", "未加载动作");
  document.getElementById("robot-pill").textContent = state.robot
    ? `🤖 ${state.robot.display_name}` : runtimeText("No robot loaded", "未加载机器人");
}

// =================================================================  NAVIGATION BRIDGE
let inspectorPanelSwitchHook: ((panelId: string) => void) | null = null;

function switchInspectorPanel(panelId: string): void {
  if (!panelId) return;
  const normalizedPanelId = panelId === "robot" ? "h2r" : panelId;
  window.__hhUi?.setActivePanel(normalizedPanelId);
  inspectorPanelSwitchHook?.(normalizedPanelId);
  if (normalizedPanelId === "batch") {
    renderBasket({ refreshCompatibility: false });
    void syncBatchRefHint();
  }
}

window.addEventListener("hhtools:panel-request", (event) => {
  switchInspectorPanel(event.detail);
});

/** After a robot is loaded, jump to the panel that matches the current workflow. */
async function routeAfterRobotLoad(): Promise<void> {
  if (!state.motion) {
    switchInspectorPanel("robot-assets");
    await refreshRetargetPanel();
    return;
  }
  switchInspectorPanel("h2r");
  await refreshRetargetPanel();
}

// =================================================================  MOTION
/**
 * Commit a newly loaded human motion, invalidate prior H2R results, and rebuild
 * every source-motion Three.js layer before publishing the new workflow state.
 */
async function loadMotionPayload(
  payload: MotionPayload,
): Promise<AsyncStageViewLoadResult> {
  const wasCalibrating = state.calibrationMode;
  const calibrationDraft = wasCalibrating ? { ...state.calibQ } : null;
  state.motion = payload;
  state.libraryEntry = payload.library_entry || null;
  state.reference = payload.suggested_reference ?? null;
  syncRefSelect();
  state.exportToken = null;
  clearResultDiagnostics("h2r");
  state.calibration = false;
  h2rRunState = "idle";
  // In calibration mode only the robot + blue reference T-pose should be visible.
  if (wasCalibrating) {
    try {
      // Calibration does not render the baked body, but it must still invalidate
      // a decode escaped from the previously active motion.
      skin.clear();
      state.robotTrajectory = null;
      robot.trajectory = null;
      scaledSkel.clear();
      scaledEnv.clear();
      player.setPlaying(false);

      if (state.robot && state.reference) {
        const calibrationRobot = state.robot;
        const calibrationRobotName = calibrationRobot.name;
        const calibrationRobotGeneration = robot.loadGeneration;
        const calibrationReference = state.reference;
        const calibrationMotionToken = payload.token ?? null;
        const entryResult = await enterCalibrationMode(calibrationDraft);
        const calibrationIdentityIsCurrent = (): boolean => (
          state.motion === payload
          && (state.motion?.token ?? null) === calibrationMotionToken
          && state.robot === calibrationRobot
          && state.robot?.name === calibrationRobotName
          && robot.isLoadGenerationCurrent(calibrationRobotGeneration)
          && state.reference === calibrationReference
        );
        const disposition = calibrationMotionLoadDisposition(
          entryResult,
          calibrationIdentityIsCurrent(),
          state.calibrationMode,
        );
        if (disposition === "stale") return "stale";
        if (disposition === "calibration") {
          _applyCalibSceneLayout();
          if (!calibrationIdentityIsCurrent()) return "stale";
          toast(runtimeText(
            `Loaded ${payload.name} (calibration mode)`,
            `已加载 ${payload.name}（标定模式）`,
          ));
          if (!calibrationIdentityIsCurrent()) return "stale";
          updatePills();
          return "committed";
        }
      } else {
        // A motion without a usable reference cannot retain an ownerless editor.
        exitCalibrationMode();
      }
    } catch (error) {
      if (state.motion === payload) exitCalibrationMode();
      throw error;
    }
  }
  skel.load(payload, 0x0a84ff);
  mesh.load(payload);
  envView.load(payload);
  const hasEnv = motionHasEnvironment(payload);
  if (!hasEnv) {
    envView.clear();
  }
  const skinLoadResult = await skin.load(payload.body_mesh);
  if (skinLoadResult === "stale") return "stale";
  // Terrain/objects clips default to the interaction-mesh backend (matches Viser
  // "Auto"); pure skeletal clips stay on Newton IK.
  if (payload.suggested_backend) {
    const rb = document.getElementById("rt-backend");
    const bb = document.getElementById("batch-backend");
    if (rb) rb.value = payload.suggested_backend;
    if (bb) bb.value = payload.suggested_backend;
  }
  withH2rStageDisplayBatch(() => {
    if (hasEnv) {
      setH2rLayerVisible("sourceEnvironment", true);
    } else {
      setH2rLayerVisible("sourceEnvironment", false);
    }
    // A fresh motion invalidates any previous retarget result.
    state.robotTrajectory = null;
    robot.trajectory = null;
    clearH2rScaledPreview();
    if (state.robot) robot.applyStatic();
    // parc_ms / skeletal-only: default skeleton lines (capsules collapse when FK rest is wrong).
    const isParcMs =
      payload.meta?.dataset === "parc_ms" ||
      payload.meta?.source_format === "parc_ms_pkl";
    const hasSkin = Boolean(payload.body_mesh?.available);
    const showSkeleton = isParcMs || !hasSkin;
    setH2rLayerVisible("sourceSkeleton", showSkeleton);
    setBodyVisible(!showSkeleton || hasSkin);
    setH2rLayerVisible("targetRobot", false);
    player.ready(effectivePlaybackDuration(payload));
  });
  player.setPlaying(true);
  renderMotionDetails(payload);
  updatePills();
  updateRetargetFpsPlaceholder();
  if (state.robot) switchInspectorPanel("h2r");
  await refreshRetargetPanel();
  if (state.motion !== payload || state.motion?.token !== payload.token) return "stale";
  toast(runtimeText(`Loaded ${payload.name}`, `已加载 ${payload.name}`));
  return "committed";
}

/**
 * Temporary aggregate presentation boundary used by migrated features.
 * Keep the ordering here so views never coordinate Stage, library, and basket
 * singleton state themselves; a future StageService can replace this adapter.
 */
export async function presentHumanMotion(
  payload: MotionPayload,
): Promise<"presented" | "superseded"> {
  const loadResult = await loadMotionPayload(payload);
  if (loadResult === "stale") return "superseded";
  await refreshLibrary();
  if (payload.library_entry) {
    addToBasket([payload.library_entry], { silent: true });
  }
  return "presented";
}

function datasetSceneGlbUrl(token: string | null | undefined, o: SceneObjectPayload): string | null {
  const mesh = o.mesh_file || "";
  if (!token || !mesh) return null;
  return `/api/dataset/scene_glb?token=${encodeURIComponent(token)}&mesh=${encodeURIComponent(mesh)}`;
}

async function loadRobotExportPreview(
  result: RobotExportPreviewResult,
): Promise<AsyncStageViewLoadResult> {
  if (state.calibrationMode) {
    toast(runtimeText(
      "Robot trajectories cannot be previewed in calibration mode",
      "标定模式下无法预览机器人轨迹",
    ), true);
    return "stale";
  }

  const robotName = result.robot;
  let selectedRobot = state.robot;
  const selectedRobotResourcesAvailable =
    selectedRobot?.name === robotName
    && robot.links.length > 0
    && robot.group.children.length > 0;
  if (!selectedRobotResourcesAvailable) {
    // A transport failure has not touched the renderer and therefore leaves
    // the current Stage intact. Only a failure after `robot.load` begins needs
    // a compensating visibility commit.
    const robotData = await API.post("/api/robot/select", { name: robotName });
    const attempt = startRobotViewLoad(robot, robotData);
    try {
      const loadResult = await attempt.completion;
      if (
        loadResult === "stale"
        || !robot.isLoadGenerationCurrent(attempt.generation)
      ) return "stale";
      selectedRobot = robotData;
    } catch (error) {
      if (!robot.isLoadGenerationCurrent(attempt.generation)) return "stale";
      clearH2rRobotAfterViewLoss("export preview robot load");
      throw error;
    }
  }

  const clipDur = Math.max(0.1, (result.num_frames - 1) / (result.framerate || 30));
  withH2rStageDisplayBatch(() => {
    state.motion = null;
    state.libraryEntry = null;
    state.robot = selectedRobot;
    state.exportToken = null;
    clearResultDiagnostics("h2r");
    skel.clear();
    mesh.clear();
    skin.clear();
    envView.clear();
    setH2rLayerVisible("sourceEnvironment", false);
    state.robotTrajectory = result.trajectory;
    robot.setTrajectory(result.trajectory);

    scaledSkel.clear();
    setH2rLayerVisible("scaledSkeleton", false);
    if (result.scaled_scene) {
      scaledEnv.load(result.scaled_scene, result.preview_token, {
        duration: clipDur,
        objectGlbUrl: (o) => datasetSceneGlbUrl(result.preview_token, o),
      });
      setH2rLayerVisible("scaledEnvironment", true);
    } else {
      scaledEnv.clear();
      setH2rLayerVisible("scaledEnvironment", false);
    }

    setH2rLayerVisible("sourceSkeleton", false);
    setBodyVisible(false);
    setH2rLayerVisible("targetRobot", true);
    player.ready(robot.clipDuration || clipDur);
  });

  document.getElementById("motion-meta-card").style.display = "none";
  player.setPlaying(true);
  robot.group.getWorldPosition(_camFocus);
  orbit.target.copy(_camFocus);
  _orbitManualUntil = 0;
  revealStage();
  updatePills();
  toast(runtimeText(
    `Playing robot mesh: ${result.name}`,
    `机器人 mesh 播放：${result.name}`,
  ));
  return "committed";
}

async function previewRobotClip(
  entry: LibraryEntry,
  robotName?: string,
): Promise<RobotExportPreviewResult> {
  const label = entry.stem || entry.sequence_id || "";
  showLoading(runtimeText(
    `Loading robot trajectory ${label}`.trim(),
    `加载机器人轨迹 ${label}`.trim(),
  ));
  try {
    const body: { source_path: string; robot?: string } = { source_path: entry.source_path };
    if (robotName) body.robot = robotName;
    const { job_id } = await API.post("/api/dataset/preview_robot", body);
    const result = await waitMotionJob<RobotExportPreviewResult>(job_id, (frac, sub) => {
      setLoadingProgress(frac, sub);
    });
    setLoadingProgress(1, runtimeText("Building robot scene…", "构建机器人场景…"));
    await loadRobotExportPreview(result);
    return result;
  } catch (e) {
    toast(errorMessage(e), true);
    throw e;
  } finally {
    hideLoading();
  }
}

async function populateDvRobotSelect(preferred?: string): Promise<string> {
  const sel = document.getElementById("dv-robot-select");
  if (!sel) return preferred || "";
  const data = await API.get("/api/robots");
  const prev = preferred || sel.value;
  sel.innerHTML = "";
  for (const r of data.robots || []) {
    if (!r.has_urdf) continue;
    const opt = document.createElement("option");
    opt.value = r.name;
    opt.textContent = r.display_name || r.name;
    sel.appendChild(opt);
  }
  if (prev && [...sel.options].some((o) => o.value === prev)) {
    sel.value = prev;
  } else if (sel.options.length) {
    sel.selectedIndex = 0;
  }
  return sel.value;
}

async function loadLibraryEntryRequest(
  entry: LibraryEntry,
  options: { usage?: "human_to_robot"; rethrow?: boolean } = {},
): Promise<AsyncStageViewLoadResult> {
  const label = entry.stem || entry.sequence_id || "";
  showLoading(runtimeText(`Loading motion… ${label}`, `加载动作中… ${label}`).trim());
  try {
    const body = options.usage ? { ...entry, usage: options.usage } : entry;
    const { job_id } = await API.post("/api/motion/load_library", body);
    const payload = await waitMotionJob<MotionPayload>(job_id, (frac, sub) => {
      setLoadingProgress(frac, sub);
    });
    setLoadingProgress(1, runtimeText("Building scene…", "构建场景…"));
    const loadResult = await loadMotionPayload(payload);
    if (loadResult === "stale") return "stale";
    return "committed";
  } catch (e) {
    toast(errorMessage(e), true);
    if (options.rethrow) throw e;
    return "committed";
  } finally {
    hideLoading();
  }
}

async function loadLibraryEntry(entry: LibraryEntry): Promise<void> {
  await loadLibraryEntryRequest(entry);
}

/** H2R loads only human reference motion; the backend verifies the real file. */
async function loadHumanMotionEntry(
  entry: LibraryEntry,
): Promise<"selected" | "superseded"> {
  const loadResult = await loadLibraryEntryRequest(entry, {
    usage: "human_to_robot",
    rethrow: true,
  });
  return loadResult === "stale" ? "superseded" : "selected";
}

// library navigator
let libMotionsRoot = "";

async function linkLibraryPath(): Promise<void> {
  const hint = libMotionsRoot
    ? runtimeText(
      `Link to the library directory (${libMotionsRoot})`,
      `链接到资源库目录（${libMotionsRoot}）`,
    )
    : runtimeText("Link to the current library directory", "链接到当前资源库目录");
  const path = window.prompt(hint, "");
  if (!path?.trim()) return;
  try {
    const data = await API.post("/api/library/link", { path: path.trim() });
    if (data.motions_library_root) libMotionsRoot = data.motions_library_root;
    await refreshLibrary();
    if (data.folder_label) setLibrarySearch(data.folder_label);
    toast(runtimeText(
      `Linked: ${data.folder_label} (${data.clip_count} clips)`,
      `已链接：${data.folder_label}（${data.clip_count} 个动作）`,
    ));
  } catch (e) {
    toast(errorMessage(e), true);
  }
}

// library navigator
let libEntries: LibraryEntry[] = [];
let libSourceRoot = "";
let libCategoryFilter: "all" | MotionCategory = "all";
const libCategoryCopy: Record<MotionCategory, { en: string; zh: string }> = {
  motion: { en: "Motion", zh: "动作" },
  object: { en: "Object", zh: "物体" },
  terrain: { en: "Terrain", zh: "地形" },
};

function libraryCategoryLabel(category: MotionCategory): string {
  const copy = libCategoryCopy[category];
  return runtimeText(copy.en, copy.zh);
}

function normalizedMotionCategory(entry: LibraryEntry): MotionCategory {
  const category = entry.motion_category;
  return category === "object" || category === "terrain" ? category : "motion";
}

function selectLibraryCategory(category: "all" | MotionCategory): void {
  libCategoryFilter = category;
  renderLibrary();
}

function setLibrarySearch(value: string): void {
  const input = document.getElementById("lib-search");
  if (input.value === value) {
    renderLibrary();
    return;
  }
  // Dispatching a real input event keeps the React SearchField state, its
  // clear affordance, and the imperative library renderer in one state.
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function refreshLibrary(): Promise<void> {
  const list = document.getElementById("lib-list");
  try {
    const data = await API.get("/api/library");
    libEntries = data.entries || [];
    libSourceRoot = data.source_root || "";
    if (data.motions_library_root) libMotionsRoot = data.motions_library_root;
    renderLibrary();
  } catch (e) {
    renderTextMessage(list, runtimeText(
      `Unable to read the library: ${errorMessage(e)}`,
      `无法读取资源库：${errorMessage(e)}`,
    ));
  }
}
function renderLibrary(): void {
  const query = document.getElementById("lib-search").value || "";
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  const list = document.getElementById("lib-list");
  list.replaceChildren();
  const filtered = libEntries.filter((e) => {
    if (libCategoryFilter !== "all" && normalizedMotionCategory(e) !== libCategoryFilter) {
      return false;
    }
    const category = normalizedMotionCategory(e);
    const categoryCopy = libCategoryCopy[category];
    // Search both languages so switching the workspace locale never changes
    // which rows match an existing query.
    const hay = [
      e.folder_label || "",
      e.stem || "",
      category,
      categoryCopy.en,
      categoryCopy.zh,
    ].join(" ").toLowerCase();
    return tokens.every((t) => hay.includes(t));
  });

  if (!libEntries.length) {
    renderTextMessage(
      list,
      runtimeText(
        "No recognizable motions are available. Choose a library directory or link an external dataset directory.",
        "资源库中还没有可识别的动作。请选择资源库目录，或链接一个外部数据集目录。",
      ),
    );
    return;
  }
  if (!filtered.length) {
    renderTextMessage(list, runtimeText(
      `No results match “${query}”`,
      `没有匹配「${query}」的结果`,
    ));
    return;
  }
  for (const e of filtered.slice(0, 300)) {
    const row = document.createElement("div");
    row.className = "lib-row";
    const category = normalizedMotionCategory(e);
    const categoryBadge = textElement("span", "lr-category", libraryCategoryLabel(category));
    categoryBadge.dataset.category = category;
    const loadButton = document.createElement("button");
    loadButton.type = "button";
    loadButton.className = "lr-load";
    loadButton.setAttribute(
      "aria-label",
      runtimeText(
        `Load motion ${[e.folder_label, e.stem].filter(Boolean).join(" ")}`,
        `加载动作 ${[e.folder_label, e.stem].filter(Boolean).join(" ")}`,
      ),
    );
    loadButton.append(
      categoryBadge,
      textElement("span", "lr-folder", e.folder_label),
      textElement("span", "lr-stem", e.stem),
    );
    const addButton = textElement("button", "lr-add", "＋");
    addButton.type = "button";
    addButton.title = runtimeText("Add to basket", "加入篮子");
    addButton.setAttribute("aria-label", runtimeText(
      `Add ${e.stem || "motion"} to basket`,
      `将 ${e.stem || "动作"} 加入篮子`,
    ));
    row.append(loadButton, addButton);
    loadButton.onclick = () => loadLibraryEntry(e);
    addButton.onclick = () => addToBasket([e]);
    list.appendChild(row);
  }
  if (filtered.length > 300) {
    const more = document.createElement("div");
    more.className = "hint";
    more.style.padding = "8px 10px";
    more.textContent = runtimeText(
      `… ${filtered.length - 300} more. Keep typing to narrow the results.`,
      `… 还有 ${filtered.length - 300} 条，继续输入以缩小范围`,
    );
    list.appendChild(more);
  }
}
document.getElementById("lib-search").oninput = () => renderLibrary();
document.getElementById("lib-category").onchange = (event) => {
  const category = (event.currentTarget as HTMLSelectElement).value;
  if (category === "all" || category === "motion" || category === "object" || category === "terrain") {
    selectLibraryCategory(category);
  }
};
window.addEventListener("hhtools:workspace-locale-change", () => {
  renderLibrary();
  renderRobotLibrary();
  populateH2rRobotSelect();
  populateBatchRobotSelect();
  renderBasket();
  const batchRobotStatus = document.getElementById("batch-robot");
  if (batchRobotStatus) batchRobotStatus.textContent = state.robot?.display_name
    || runtimeText("Not loaded", "未加载");
  renderBatchResultCard();
  renderBatchFailures(lastBatchResult);
  void r2rPopulateSelects();
  updateRobotImportStatus();
  const motionMetaCard = document.getElementById("motion-meta-card");
  // Calibration-only loads intentionally keep the details card hidden. A
  // locale change should translate visible details, not alter that UI state.
  if (state.motion && motionMetaCard?.style.display !== "none") {
    renderMotionDetails(state.motion);
  }
  const robotMetaCard = document.getElementById("robot-meta-card");
  if (state.robot && robotMetaCard?.style.display !== "none") {
    renderRobotDetails(state.robot);
  }
  // Workflow nodes and blocked reasons are emitted by the imperative runtime,
  // so republish them after React switches locale instead of leaving stale copy.
  publishH2rWorkflowState();
  publishR2rWorkflowState();
  updateH2rCalibrationValidation();
  updateR2rCalibrationValidation();
  syncRefSelect();
  updatePills();
  updateRetargetFpsPlaceholder();
  publishPlaybackState();
  updateCalibRestoreButton();
  if (state.calibrationMode) {
    refSkel.configureMappings(state.robot?.ik_map ?? {});
    syncCalibrationNumberInputs("h2r");
    emitCalibrationEditorState("h2r");
  }
  if (r2r.calibrating) {
    refSkel.configureMappings(r2r.targetPayload?.ik_map ?? {});
    syncCalibrationNumberInputs("r2r");
    emitCalibrationEditorState("r2r");
  }
  setR2rRobotStatus("source", r2r.sourcePayload
    ? runtimeText(
      `Source robot: ${r2r.sourcePayload.display_name}`,
      `源机器人：${r2r.sourcePayload.display_name}`,
    )
    : runtimeText("Not loaded", "未加载"));
  setR2rRobotStatus("target", r2r.targetPayload
    ? runtimeText(
      `Target robot: ${r2r.targetPayload.display_name}`,
      `目标机器人：${r2r.targetPayload.display_name}`,
    )
    : runtimeText("Not loaded", "未加载"));
  const r2rTrajectoryStatus = document.getElementById("r2r-traj-status");
  if (r2rTrajectoryStatus) {
    r2rTrajectoryStatus.textContent = r2rTrajectoryState === "validating"
      ? runtimeText("Validating trajectory…", "正在校验机器人轨迹……")
      : r2r.sourceToken
        ? runtimeText(`Loaded: ${r2r.sourceStem || "trajectory"}`, `已加载：${r2r.sourceStem || "轨迹"}`)
        : "";
  }
  const h2rStatus = document.getElementById("rt-status");
  if (h2rStatus && h2rRunState !== "idle") {
    h2rStatus.textContent = h2rRunState === "running"
      ? runtimeText("Retargeting…", "正在 retarget…")
      : h2rRunState === "completed"
        ? runtimeText("Retarget complete; ready to export", "Retarget 完成，可导出")
        : "";
  }
  const r2rStatus = document.getElementById("r2r-status");
  if (r2rStatus && r2rRunState !== "idle") {
    r2rStatus.textContent = r2rRunState === "running"
      ? runtimeText("Retargeting…", "正在 retarget…")
      : r2rRunState === "completed"
        ? runtimeText("R2R retarget complete", "R2R Retarget 完成")
        : "";
  }
  r2rRenderBasket();
  void r2rUpdateRetargetBtn();
  if (state.calibrationMode && state.reference) updateCalibBanner(state.reference);
  if (r2r.calibrating) updateR2rCalibBanner();
});

// ================================================ FILE IMPORT (folder-aware)
function readAllDirectoryEntries(
  reader: FileSystemDirectoryReader,
): Promise<FileSystemEntry[]> {
  return new Promise<FileSystemEntry[]>((resolve, reject) => {
    const entries: FileSystemEntry[] = [];
    const readBatch = (): void => {
      reader.readEntries((batch: FileSystemEntry[]) => {
        if (!batch.length) {
          resolve(entries);
          return;
        }
        entries.push(...batch);
        readBatch();
      }, reject);
    };
    readBatch();
  });
}

function walkEntry(
  entry: FileSystemEntry,
  out: UploadFile[],
  prefix = "",
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (entry.isFile) {
      (entry as FileSystemFileEntry).file((file: File) => {
        const uploadFile = file as UploadFile;
        uploadFile._relpath = prefix + uploadFile.name;
        out.push(uploadFile);
        resolve();
      }, reject);
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      readAllDirectoryEntries(reader)
        .then((entries) => Promise.all(
          entries.map((e) => walkEntry(e, out, `${prefix}${entry.name}/`)),
        ))
        .then(() => resolve())
        .catch(reject);
    } else {
      resolve();
    }
  });
}

async function collectDroppedFiles(dataTransfer: DataTransfer | null): Promise<UploadFile[]> {
  const files: UploadFile[] = [];
  // Prefer the entry API: it recurses into dropped folders AND distinguishes a
  // real file from a *directory*.  A dropped folder shows up in
  // ``dataTransfer.files`` as a single zero-byte, type-less File whose body
  // cannot be read — appending it to FormData makes the upload ``fetch`` reject
  // with "Failed to fetch".  ``webkitGetAsEntry`` must be called synchronously
  // while the drop event's items are still alive, so capture every entry first,
  // then walk them.
  const items = dataTransfer?.items;
  if (items?.length) {
    const entries: FileSystemEntry[] = [];
    const looseFiles: UploadFile[] = [];
    for (const it of items) {
      const entry = it.webkitGetAsEntry?.();
      if (entry) entries.push(entry);
      else {
        const file = it.getAsFile?.();
        if (file) looseFiles.push(file as UploadFile);
      }
    }
    if (entries.length) await Promise.all(entries.map((e) => walkEntry(e, files)));
    for (const f of looseFiles) {
      f._relpath = f._relpath || f.webkitRelativePath || f.name;
      files.push(f);
    }
    if (files.length) return files;
  }
  // Fallback for browsers without the entry API: a flat file list only. Best-
  // effort skip of a dropped folder, which surfaces here as a zero-byte,
  // type-less, extension-less File that would break the upload fetch.
  if (dataTransfer?.files?.length) {
    for (const f of dataTransfer.files) {
      if (!f) continue;
      const looksLikeDir = f.size === 0 && !f.type && !/\.[^/.]+$/.test(f.name || "");
      if (looksLikeDir) continue;
      f._relpath = f._relpath || f.webkitRelativePath || f.name;
      files.push(f);
    }
  }
  return files;
}

function setupDropzone<DropContext = void>(
  el: HTMLElement,
  onFiles: (files: UploadFile[], context: DropContext) => void | Promise<void>,
  captureDropContext?: () => DropContext,
  acceptsEvent: (event: DragEvent) => boolean = () => true,
): void {
  ["dragenter", "dragover"].forEach((ev) =>
    el.addEventListener(ev, (event) => {
      if (!acceptsEvent(event as DragEvent)) return;
      event.preventDefault();
      el.classList.add("hover");
    })
  );
  ["dragleave", "drop"].forEach((ev) =>
    el.addEventListener(ev, (event) => {
      if (!acceptsEvent(event as DragEvent)) return;
      event.preventDefault();
      el.classList.remove("hover");
    })
  );
  el.addEventListener("drop", (event) => {
    const dropEvent = event as DragEvent;
    if (!acceptsEvent(dropEvent)) return;
    dropEvent.stopPropagation();
    el.classList.remove("hover");
    // Snapshot mutable UI state before recursively walking a potentially large
    // folder; changing a selector mid-walk must not reinterpret this drop.
    const dropContext = captureDropContext?.() as DropContext;
    void collectDroppedFiles(dropEvent.dataTransfer).then((files) => {
      if (files.length) void onFiles(files, dropContext);
    });
  });
}
// Hidden <input> based file / folder picker (for environments where native
// drag-drop is awkward). Folder picker preserves relative paths via
// webkitRelativePath so mesh subdirs + sidecars survive. Native `accept`
// filtering applies only to individual files: a folder must retain required
// .obj sidecars, and its full structure is validated by the server instead.
function pickFiles(
  { folder = false, accept = "" }: { folder?: boolean; accept?: string } = {},
): Promise<UploadFile[]> {
  return new Promise<UploadFile[]>((resolve) => {
    const inp = document.createElement("input");
    inp.type = "file";
    inp.multiple = true;
    if (folder) inp.webkitdirectory = true;
    else if (accept) inp.accept = accept;
    inp.style.display = "none";
    inp.onchange = () => {
      const files = Array.from(inp.files || []) as UploadFile[];
      for (const f of files) f._relpath = f.webkitRelativePath || f.name;
      document.body.removeChild(inp);
      resolve(files);
    };
    document.body.appendChild(inp);
    inp.click();
  });
}

function inferLibraryFolderLabel(files: UploadFile[]): string | undefined {
  if (!files?.length) return undefined;
  const rels = files.map((f) => f._relpath || f.name);
  const first = rels[0];
  if (first && rels.some((path) => path.includes("/"))) return first.split("/")[0];
  return undefined;
}

async function ingestMotionFiles(
  files: UploadFile[],
  profile = "mimic",
): Promise<MotionPayload | null> {
  if (!files || !files.length) return null;
  const libraryFolderLabel = inferLibraryFolderLabel(files);
  showLoading(runtimeText(
    `Linking and parsing… (${files.length} files)`,
    `链接并解析中…（${files.length} 个文件）`,
  ));
  try {
    const uploadResp = await uploadFilesXHR(
      "/api/motion/upload",
      files,
      { profile, libraryFolderLabel },
      () => {},
    );
    const { job_id, linked, folder_label, materialize_mode } = uploadResp;
    const payload = await waitMotionJob<MotionPayload>(job_id, (frac, sub) => {
      setLoadingProgress(frac, sub);
    }, { uploadFrac: 0 });
    setLoadingProgress(1, runtimeText("Building scene…", "构建场景…"));
    const loadResult = await loadMotionPayload(payload);
    if (loadResult === "stale") return null;
    if (linked || folder_label || payload.linked_folder) {
      await refreshLibrary();
      const label = folder_label || payload.linked_folder;
      if (label) setLibrarySearch(label);
    }
    const resolvedMaterializeMode = materialize_mode === "pending"
      ? payload.materialize_mode
      : materialize_mode;
    const modeHint = resolvedMaterializeMode === "symlink"
      ? { en: "Symlinked", zh: "软链接" }
      : resolvedMaterializeMode === "hardlink"
        ? { en: "Hard-linked", zh: "硬链接" }
        : { en: "Copied", zh: "已复制" };
    if (payload.library_entry) {
      addToBasket([payload.library_entry]);
      toast(runtimeText(
        `${modeHint.en} and loaded: ${payload.name} (Library · ${folder_label || payload.linked_folder})`,
        `已${modeHint.zh}并加载：${payload.name}（资源库 · ${folder_label || payload.linked_folder}）`,
      ));
    } else if (linked || payload.linked_folder) {
      toast(runtimeText(
        `${modeHint.en} to the Library: ${payload.linked_folder || folder_label}; loaded the first clip`,
        `已${modeHint.zh}到资源库：${payload.linked_folder || folder_label}，已加载首条 clip`,
      ));
    }
    return payload;
  } catch (e) {
    toast(errorMessage(e), true);
    return null;
  } finally {
    hideLoading();
  }
}

function initMotionImportZone(): void {
  const dropzone = document.getElementById("motion-drop-shared");
  if (dropzone) {
    setupDropzone(
      dropzone,
      async (files, profile) => {
        await ingestMotionFiles(files, profile);
      },
      () => dropzone.dataset.profile || "mimic",
    );
  }
  document.querySelectorAll<HTMLButtonElement>("[data-pick]").forEach((btn) => {
    btn.onclick = async () => {
      const profile = btn.dataset.pick || "mimic";
      const folder = btn.dataset.folder === "1";
      const accept = btn.dataset.accept || "";
      await ingestMotionFiles(await pickFiles({ folder, accept }), profile);
    };
  });
}
initMotionImportZone();

setupDropzone(
  document.getElementById("stage"),
  (files) => {
    void ingestMotionFiles(files, "mimic");
  },
  undefined,
  (event) => {
    // The V2M batch area is React-owned. Let its delegated `onDrop` reach the
    // React root instead of swallowing the event in this legacy stage handler.
    const target = event.target;
    return !(target instanceof Element && target.closest("#v2m-batch-drop"));
  },
);

document.getElementById("add-to-basket").onclick = () => {
  if (state.libraryEntry) {
    addToBasket([state.libraryEntry]);
    return;
  }
  toast(runtimeText(
    "Load a motion from the Library before adding it to the basket, or use ＋ on a library row.",
    "请从资源库加载动作后再加入篮子，或使用资源库列表行的 ＋",
  ), true);
};

// =================================================================  ROBOT
let _robotPanelLockDepth = 0;
let robotSummaries: RobotSummary[] = [];
let robotLibraryDir = "";
let robotLoadingName = "";

function isBuiltinRobot(summary: RobotSummary): boolean {
  return summary.builtin === true || curatedRobotLibraryItem(summary.name) != null;
}

function robotSummaryLabel(summary: RobotSummary): string {
  const copy = curatedRobotLibraryItem(summary.name);
  return copy ? runtimeText(copy.en, copy.zh) : summary.display_name || summary.name;
}

function sortedRobotSummaries(): RobotSummary[] {
  return sortRobotLibrarySummaries(robotSummaries, robotSummaryLabel);
}

/** Keep a compact workflow robot picker in sync with the shared Robot Library. */
function populateWorkflowRobotSelect(
  selectId: string,
  loadButtonId: string,
  preferredName?: string,
): void {
  const select = document.getElementById(selectId) as HTMLSelectElement | null;
  const loadButton = document.getElementById(loadButtonId) as HTMLButtonElement | null;
  if (!select || !loadButton) return;

  const preferred = preferredName || select.value || state.robot?.name;
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = runtimeText("Select a robot…", "选择机器人……");
  select.replaceChildren(placeholder);

  for (const summary of sortedRobotSummaries()) {
    const option = document.createElement("option");
    option.value = summary.name;
    option.textContent = `${robotSummaryLabel(summary)} (${summary.num_dof} DoF)`;
    option.disabled = !summary.has_urdf;
    select.appendChild(option);
  }

  if (preferred && [...select.options].some((option) => option.value === preferred && !option.disabled)) {
    select.value = preferred;
  } else {
    select.value = "";
  }
  const selectedRobotIsLoaded = Boolean(select.value && select.value === state.robot?.name);
  select.disabled = state.robotPanelLocked || Boolean(robotLoadingName);
  loadButton.disabled = select.disabled || !select.value || selectedRobotIsLoaded;
  loadButton.textContent = selectedRobotIsLoaded
    ? runtimeText(
      selectId === "batch-robot-select" ? "Target robot loaded" : "Robot loaded",
      selectId === "batch-robot-select" ? "目标机器人已加载" : "机器人已加载",
    )
    : runtimeText(
      selectId === "batch-robot-select" ? "Load target robot" : "Load robot",
      selectId === "batch-robot-select" ? "加载目标机器人" : "加载机器人",
    );
}

function populateH2rRobotSelect(preferredName?: string): void {
  populateWorkflowRobotSelect("h2r-robot-select", "h2r-robot-load", preferredName);
}

function populateBatchRobotSelect(preferredName?: string): void {
  populateWorkflowRobotSelect("batch-robot-select", "batch-robot-load", preferredName);
}

/**
 * Reference-counted workspace lock: overlapping async workflows may share the
 * robot controls, so one completion must not unlock another caller's operation.
 */
function setRobotPanelLocked(locked: boolean): void {
  if (locked) _robotPanelLockDepth++;
  else _robotPanelLockDepth = Math.max(0, _robotPanelLockDepth - 1);
  const busy = _robotPanelLockDepth > 0;
  state.robotPanelLocked = busy;

  for (const id of ["robot-pick-urdf", "robot-pick-mesh-folder"]) {
    const el = document.getElementById(id) as HTMLButtonElement | null;
    if (el) el.disabled = busy;
  }
  for (const id of ["robot-drop-urdf", "robot-drop-mesh"]) {
    document.getElementById(id)?.classList.toggle("disabled", busy);
  }
  populateH2rRobotSelect();
  populateBatchRobotSelect();
  renderRobotLibrary();
  publishH2rWorkflowState();
  updateBatchRunAvailability();
}

function renderRobotDetails(robotData: RobotPayload): void {
  document.getElementById("robot-name").textContent = robotData.display_name;
  renderMetaRows(document.getElementById("robot-meta"), [
    [runtimeText("Links", "链接"), robotData.links.length],
    [runtimeText("Degrees of freedom", "自由度"), robotData.num_dof ?? robotData.joints?.length ?? 0],
    [runtimeText("ik_map slots", "ik_map 槽位"), Object.keys(robotData.ik_map ?? {}).length],
  ]);
  renderRobotValidation(robotData);
}

interface ApplyRobotOptions {
  /** Batch selects a target in place instead of navigating away from its task builder. */
  stayOnCurrentPanel?: boolean;
}

async function applyRobot(
  robotData: RobotPayload,
  { stayOnCurrentPanel = false }: ApplyRobotOptions = {},
): Promise<AsyncStageViewLoadResult> {
  if (state.robotPanelLocked) {
    toast(runtimeText(
      "Retargeting is running. Wait for it to finish before switching robots.",
      "Retarget 进行中，请等待完成后再切换机器人",
    ), true);
    return "stale";
  }
  const attempt = startRobotViewLoad(robot, robotData);
  try {
    const loadResult = await attempt.completion;
    if (
      loadResult === "stale"
      || !robot.isLoadGenerationCurrent(attempt.generation)
    ) return "stale";
  } catch (error) {
    if (!robot.isLoadGenerationCurrent(attempt.generation)) return "stale";
    clearH2rRobotAfterViewLoss("selected robot load");
    throw error;
  }
  // RobotView's generation is the renderer commit point. Derived workflow and
  // UI state must not be published for an attempt superseded while parsing.
  state.robot = robotData;
  state.exportToken = null;
  state.robotTrajectory = null;
  clearResultDiagnostics("h2r");
  state.calibration = false;
  h2rRunState = "idle";
  document.getElementById("rt-export-card").style.display = "none";
  populateH2rRobotSelect(robotData.name);
  populateBatchRobotSelect(robotData.name);
  document.getElementById("robot-meta-card").style.display = "block";
  renderRobotDetails(robotData);
  renderRobotLibrary();
  document.getElementById("batch-robot").textContent = robotData.display_name;
  renderBasket();
  updatePills();
  withH2rStageDisplayBatch(() => {
    clearH2rScaledPreview();
    setH2rLayerVisible("targetRobot", true);
  });
  revealStage();
  // Await so state.calibration is fresh; refreshRetargetPanel itself loads the
  // scaled skeleton/scene when a calibration already exists (no retarget needed).
  if (state.calibrationMode) {
    switchInspectorPanel("h2r");
    const calibrationMotion = state.motion;
    const calibrationMotionToken = calibrationMotion?.token ?? null;
    const calibrationReference = state.reference;
    const calibrationRobotName = robotData.name;
    const calibrationEntry = await enterCalibrationMode(state.calibQ);
    if (
      calibrationEntry !== "entered"
      || state.robot !== robotData
      || state.robot?.name !== calibrationRobotName
      || !robot.isLoadGenerationCurrent(attempt.generation)
      || state.motion !== calibrationMotion
      || (state.motion?.token ?? null) !== calibrationMotionToken
      || state.reference !== calibrationReference
    ) {
      return state.robot === robotData
        && robot.isLoadGenerationCurrent(attempt.generation)
        ? "committed"
        : "stale";
    }
    toast(runtimeText(
      `Robot loaded in calibration pose: ${robotData.display_name}`,
      `机器人已加载（标定姿态）：${robotData.display_name}`,
    ));
    return "committed";
  }
  if (stayOnCurrentPanel) await refreshRetargetPanel();
  else await routeAfterRobotLoad();
  toast(
    state.motion
      ? runtimeText(
        `Robot loaded: ${robotData.display_name}`,
        `机器人已加载：${robotData.display_name}`,
      )
      : runtimeText(
        `Robot loaded: ${robotData.display_name} — load a motion next`,
        `机器人已加载：${robotData.display_name} — 请先加载动作`,
      ),
  );
  return "committed";
}

async function refreshRobotList(): Promise<void> {
  try {
    const data = await API.get("/api/robots");
    robotSummaries = data.robots || [];
    robotLibraryDir = data.library_dir || "";
    populateH2rRobotSelect();
    populateBatchRobotSelect();
    renderRobotLibrary();
  } catch (e) {
    renderTextMessage(
      document.getElementById("robot-library-list"),
      runtimeText(
        `Unable to read the Robot Library: ${errorMessage(e)}`,
        `无法读取机器人库：${errorMessage(e)}`,
      ),
    );
  }
}

function renderRobotLibrary(): void {
  const list = document.getElementById("robot-library-list");
  if (!list) return;
  const input = document.getElementById("robot-library-search") as HTMLInputElement | null;
  const query = input?.value.trim().toLowerCase() || "";
  const tokens = query.split(/\s+/).filter(Boolean);
  const filtered = sortedRobotSummaries().filter((summary) => {
    const builtin = isBuiltinRobot(summary);
    const haystack = [
      summary.name,
      summary.display_name,
      robotSummaryLabel(summary),
      summary.num_dof,
      builtin ? "builtin built-in included 内置 预置" : "imported custom uploaded 导入 自定义 上传",
    ].join(" ").toLowerCase();
    return tokens.every((token) => haystack.includes(token));
  });

  list.replaceChildren();
  if (!robotSummaries.length) {
    renderTextMessage(list, runtimeText(
      "No robot models are available. Import a complete robot folder above.",
      "机器人库中暂无模型，请从上方导入完整的机器人文件夹。",
    ));
    return;
  }
  if (!filtered.length) {
    renderTextMessage(list, runtimeText(
      `No robots match “${input?.value || ""}”`,
      `没有匹配「${input?.value || ""}」的机器人`,
    ));
    return;
  }

  for (const summary of filtered) {
    const builtin = isBuiltinRobot(summary);
    const active = state.robot?.name === summary.name;
    const unavailable = !summary.has_urdf;
    const row = document.createElement("div");
    row.className = "lib-row robot-lib-row";
    row.classList.toggle("is-active", active);
    row.classList.toggle("is-unavailable", unavailable);

    const loadButton = document.createElement("button");
    loadButton.type = "button";
    loadButton.className = "lr-load robot-library-load";
    loadButton.disabled = unavailable || state.robotPanelLocked || Boolean(robotLoadingName);
    loadButton.setAttribute("aria-label", runtimeText(
      `Load robot ${robotSummaryLabel(summary)}`,
      `加载机器人 ${robotSummaryLabel(summary)}`,
    ));
    if (active) loadButton.setAttribute("aria-current", "true");

    const icon = document.createElement("img");
    icon.className = "robot-library-icon";
    icon.src = robotLibraryIcon(summary.name);
    // Broken or unavailable curated artwork must degrade to the same generic
    // mark used by user imports, never to a browser broken-image glyph.
    icon.onerror = () => {
      icon.onerror = null;
      icon.src = DEFAULT_ROBOT_LIBRARY_ICON;
    };
    icon.alt = "";
    icon.setAttribute("aria-hidden", "true");

    const copy = document.createElement("span");
    copy.className = "robot-library-copy";
    copy.append(
      textElement("strong", "robot-library-name", robotSummaryLabel(summary)),
      textElement("small", "robot-library-meta", runtimeText(
        `${summary.num_dof} DoF · ${builtin ? "Built-in" : "Imported"}${unavailable ? " · URDF missing" : ""}`,
        `${summary.num_dof} DoF · ${builtin ? "内置" : "已导入"}${unavailable ? " · 缺少 URDF" : ""}`,
      )),
    );
    loadButton.append(icon, copy);
    if (robotLoadingName === summary.name) {
      loadButton.append(textElement("span", "robot-library-state", runtimeText("Loading…", "加载中……")));
    } else if (active) {
      loadButton.append(textElement("span", "robot-library-state", runtimeText("Loaded", "已加载")));
    }
    loadButton.onclick = () => loadRobotSummary(summary);
    row.appendChild(loadButton);

    if (summary.deletable && !builtin) {
      const deleteButton = textElement("button", "robot-library-delete", "×");
      deleteButton.type = "button";
      deleteButton.disabled = state.robotPanelLocked || Boolean(robotLoadingName);
      deleteButton.title = runtimeText("Remove from Robot Library", "从机器人库删除");
      deleteButton.setAttribute("aria-label", runtimeText(
        `Delete robot ${robotSummaryLabel(summary)}`,
        `删除机器人 ${robotSummaryLabel(summary)}`,
      ));
      deleteButton.onclick = (event) => {
        event.stopPropagation();
        void deleteRobotSummary(summary);
      };
      row.appendChild(deleteButton);
    }
    list.appendChild(row);
  }

  const hint = document.getElementById("robot-library-hint");
  if (hint) {
    hint.textContent = runtimeText(
      "Imported robot models stay in the local library.",
      "导入的机器人模型会保存在本机资源库。",
    );
    hint.title = robotLibraryDir;
  }
}

async function loadRobotSummary(
  summary: RobotSummary,
  options: ApplyRobotOptions = {},
): Promise<void> {
  if (state.robotPanelLocked) {
    toast(runtimeText(
      "Retargeting is running. Wait for it to finish before switching robots.",
      "Retarget 进行中，请等待完成后再切换机器人",
    ), true);
    return;
  }
  if (options.stayOnCurrentPanel && state.calibrationMode) {
    toast(runtimeText(
      "Finish or cancel the current calibration before changing the Batch target robot.",
      "请先保存或取消当前标定，再更换 Batch 目标机器人。",
    ), true);
    return;
  }
  if (!summary.has_urdf || robotLoadingName) return;
  robotLoadingName = summary.name;
  renderRobotLibrary();
  toast(runtimeText("Loading robot…", "加载机器人……"));
  try {
    await applyRobot(await API.post("/api/robot/select", { name: summary.name }), options);
  } catch (e) {
    toast(errorMessage(e), true);
  } finally {
    robotLoadingName = "";
    populateH2rRobotSelect();
    populateBatchRobotSelect();
    renderRobotLibrary();
  }
}

async function deleteRobotSummary(summary: RobotSummary): Promise<void> {
  if (state.robotPanelLocked) {
    toast(runtimeText(
      "Retargeting is running. Wait for it to finish before editing the library.",
      "Retarget 进行中，请等待完成后再操作",
    ), true);
    return;
  }
  const label = robotSummaryLabel(summary);
  if (!confirm(runtimeText(
    `Remove “${label}” from the Robot Library?\nThis permanently deletes its local folder and cannot be undone.`,
    `确定从机器人库删除「${label}」？\n将永久删除对应目录，不可恢复。`,
  ))) return;
  toast(runtimeText("Removing robot…", "删除机器人……"));
  try {
    await API.delete(`/api/robot/${encodeURIComponent(summary.name)}`);
    if (state.robot?.name === summary.name) {
      runBestEffortCleanup("deleted robot: resource cleanup failed", () => robot.clear());
      clearH2rRobotAfterViewLoss("deleted robot");
    }
    await refreshRobotList();
    toast(runtimeText(
      `Removed from Robot Library: ${label}`,
      `已从机器人库删除：${label}`,
    ));
  } catch (e) { toast(errorMessage(e), true); }
}

const robotSearchInput = document.getElementById("robot-library-search") as HTMLInputElement | null;
if (robotSearchInput) robotSearchInput.oninput = renderRobotLibrary;

const h2rRobotSelect = document.getElementById("h2r-robot-select");
if (h2rRobotSelect) {
  h2rRobotSelect.onchange = () => populateH2rRobotSelect();
}
const h2rRobotLoadButton = document.getElementById("h2r-robot-load");
if (h2rRobotLoadButton) {
  h2rRobotLoadButton.onclick = async () => {
    const name = h2rRobotSelect?.value;
    const summary = robotSummaries.find((candidate) => candidate.name === name);
    if (summary) await loadRobotSummary(summary);
  };
}

const batchRobotSelect = document.getElementById("batch-robot-select") as HTMLSelectElement | null;
if (batchRobotSelect) {
  batchRobotSelect.onchange = () => {
    populateBatchRobotSelect();
    updateBatchRunAvailability();
  };
}
const batchRobotLoadButton = document.getElementById("batch-robot-load") as HTMLButtonElement | null;
if (batchRobotLoadButton) {
  batchRobotLoadButton.onclick = async () => {
    const summary = robotSummaries.find((candidate) => candidate.name === batchRobotSelect?.value);
    if (summary) await loadRobotSummary(summary, { stayOnCurrentPanel: true });
  };
}

interface RobotImportState {
  urdf: UploadFile | null;
  meshes: UploadFile[];
}

const robotImport: RobotImportState = { urdf: null, meshes: [] };

function isUrdfFile(f: UploadFile): boolean {
  return (f._relpath || f.name).toLowerCase().endsWith(".urdf");
}
function isMeshFile(f: UploadFile): boolean {
  const p = (f._relpath || f.name).toLowerCase();
  return /\.(stl|obj|dae|ply|glb|gltf)$/i.test(p);
}
function updateRobotImportStatus(): void {
  const el = document.getElementById("robot-import-status");
  if (!el) return;
  const parts: string[] = [];
  if (robotImport.urdf) parts.push(`URDF: ${robotImport.urdf.name || "robot.urdf"}`);
  if (robotImport.meshes.length) parts.push(runtimeText(
    `Assets: ${robotImport.meshes.length} files`,
    `资源：${robotImport.meshes.length} 个文件`,
  ));
  if (robotImport.urdf && !robotImport.meshes.length) {
    parts.push(runtimeText(
      "Choose the matching mesh folder to continue",
      "请继续选择对应的 mesh 文件夹",
    ));
  }
  el.textContent = parts.length
    ? parts.join(" · ")
    : runtimeText("No URDF selected.", "尚未选择 URDF。");
}

async function tryUploadRobot(): Promise<void> {
  if (state.robotPanelLocked) {
    toast(runtimeText(
      "Retargeting is running. Wait for it to finish before switching robots.",
      "Retarget 进行中，请等待完成后再切换机器人",
    ), true);
    return;
  }
  if (!robotImport.urdf) {
    toast(runtimeText("Choose a .urdf file first.", "请先选择 .urdf 文件。"), true);
    return;
  }
  // The backend wipes the upload dir on every call, so URDF + meshes MUST be
  // sent together.  ``name`` is passed as a query param so the temp dir matches
  // the URDF stem (the registered preset name still comes from the URDF's
  // ``<robot name>`` during scaffolding).
  const files = [robotImport.urdf, ...robotImport.meshes];
  const name = (robotImport.urdf.name || "robot")
    .replace(/\.urdf$/i, "")
    .replace(/[^a-z0-9_]/gi, "_")
    .toLowerCase();
  toast(runtimeText(
    `Importing robot… (${files.length} files)`,
    `导入机器人……（${files.length} 个文件）`,
  ));
  try {
    const robotData = await API.upload("/api/robot/upload", files, { name });
    const loadResult = await applyRobot(robotData);
    if (loadResult === "stale") return;
    // The backend persists the imported preset; refreshing exposes it through
    // the same Robot Library used for the bundled G1 and X2 models.
    await refreshRobotList();
    robotImport.urdf = null;
    robotImport.meshes = [];
    updateRobotImportStatus();
    toast(runtimeText(
      `Robot added to the library: ${robotData.display_name || robotData.name}`,
      `机器人已加入资源库：${robotData.display_name || robotData.name}`,
    ));
  } catch (e) { toast(errorMessage(e), true); }
}

function ingestRobotUrdf(files: UploadFile[]): void {
  if (state.robotPanelLocked) {
    toast(runtimeText(
      "Retargeting is running. Wait for it to finish before switching robots.",
      "Retarget 进行中，请等待完成后再切换机器人",
    ), true);
    return;
  }
  if (!files?.length) return;
  const urdf = files.find(isUrdfFile);
  if (!urdf) {
    toast(runtimeText("No .urdf file was found.", "未找到 .urdf 文件。"), true);
    return;
  }
  robotImport.urdf = urdf;
  const extra = files.filter((f) => f !== urdf && (isMeshFile(f) || !isUrdfFile(f)));
  if (extra.length) robotImport.meshes = [...robotImport.meshes, ...extra];
  updateRobotImportStatus();
  // Only upload now when the same drop already carried the meshes (a whole
  // robot folder).  A bare .urdf drop must WAIT for step 2 (the meshes/ folder)
  // — uploading immediately used to register a mesh-less robot and reset the
  // stored URDF, so the subsequent meshes drop hit the "add a .urdf first" guard.
  if (robotImport.meshes.length) {
    void tryUploadRobot();
  } else {
    toast(runtimeText(
      "URDF selected. Choose the matching mesh folder to finish importing.",
      "已读取 URDF，请继续选择对应的 mesh 文件夹完成导入。",
    ));
  }
}

function ingestRobotMesh(files: UploadFile[]): void {
  if (state.robotPanelLocked) {
    toast(runtimeText(
      "Retargeting is running. Wait for it to finish before switching robots.",
      "Retarget 进行中，请等待完成后再切换机器人",
    ), true);
    return;
  }
  if (!files?.length) return;
  const meshes = files.filter((f) => !isUrdfFile(f));
  if (!meshes.length) {
    toast(runtimeText("No mesh assets were found.", "未找到 mesh 资源。"), true);
    return;
  }
  if (!robotImport.urdf) {
    toast(runtimeText(
      "Choose the robot URDF before selecting its mesh folder.",
      "请先选择机器人 URDF，再选择对应的 mesh 文件夹。",
    ), true);
    return;
  }
  robotImport.meshes = meshes;
  updateRobotImportStatus();
  void tryUploadRobot();
}

setupDropzone(document.getElementById("robot-drop-urdf"), ingestRobotUrdf);
setupDropzone(document.getElementById("robot-drop-mesh"), ingestRobotMesh);
document.getElementById("robot-pick-urdf").onclick = async () =>
  ingestRobotUrdf(await pickFiles());
document.getElementById("robot-pick-mesh-folder").onclick = async () =>
  ingestRobotMesh(await pickFiles({ folder: true }));

// =================================================================  CALIBRATION 3D MANIPULATOR
const _hhtoolsWorld = new THREE.Vector3();
const _hhtoolsAxis = new THREE.Vector3();
const _projScratch = new THREE.Vector3();
const _dragPlane = new THREE.Plane();
const _arcRef = new THREE.Vector3();
const _arcCross = new THREE.Vector3();

/** Map hhtools Z-up coordinates to three.js world (inside the rotated ``world`` group). */
function hhtoolsToWorldVec3(
  x: number,
  y: number,
  z: number,
  out = _hhtoolsWorld,
): THREE.Vector3 {
  out.set(x, y, z);
  return out.applyMatrix4(world.matrixWorld);
}

/** Point on a rotation arc: pivot + R·(cos θ·ref + sin θ·(axis×ref)). */
function arcPointWorld(
  pivot: THREE.Vector3,
  axis: THREE.Vector3,
  ref: THREE.Vector3,
  angle: number,
  radius: number,
): THREE.Vector3 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  _arcCross.crossVectors(axis, ref);
  return pivot.clone()
    .add(ref.clone().multiplyScalar(c * radius))
    .add(_arcCross.multiplyScalar(s * radius));
}

interface CalibrationJointMeta {
  child_link?: string;
  lower: number;
  upper: number;
  type: string;
}

type CalibrationJointWorld = JointWorldPayload;

interface CalibrationChangeOptions {
  from: string;
  live?: boolean;
}

interface CalibrationPreviewOptions {
  live?: boolean;
  flush?: boolean;
}

interface CalibrationContext {
  robotView: RobotView;
  getQ: () => Record<string, number>;
  getSliderRows: () => Record<string, CalibrationSliderRow>;
  jointChange: (
    name: string,
    value: string | number,
    options: CalibrationChangeOptions,
  ) => void;
  previewFk: (options?: CalibrationPreviewOptions) => void | Promise<void>;
}

interface CalibrationHudTag {
  el: HTMLElement;
  input: HTMLInputElement;
  nameEl: HTMLElement;
  unitEl: HTMLElement;
  loEl: HTMLElement;
  hiEl: HTMLElement;
  track: HTMLElement;
  thumb: HTMLElement;
  fill: HTMLElement;
}

interface CalibrationLimitGizmo {
  group: THREE.Group;
  arc: THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial>;
  loTick: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
  hiTick: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
  curTick: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
  needle: THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial>;
}

interface HudLayout {
  ox: number;
  oy: number;
  w: number;
  h: number;
  cardW: number;
  cardH: number;
  pad: number;
}

interface Point2D {
  x: number;
  y: number;
}

type CalibrationPointerGestureEnd =
  | "complete"
  | "cancel"
  | "lost-capture"
  | "replacement"
  | "stop";

interface CalibrationPointerGestureBase {
  readonly pointerId: number;
  readonly captureTarget: HTMLElement;
  readonly context: CalibrationContext;
  readonly session: PointerGestureSession;
  activated: boolean;
  orbitEnabledBefore: boolean;
}

interface CalibrationCardPointerGesture extends CalibrationPointerGestureBase {
  readonly kind: "card";
  readonly card: HTMLElement;
  readonly layout: HudLayout;
  readonly start: { px: number; py: number; ax: number; ay: number };
}

interface CalibrationTrackPointerGesture extends CalibrationPointerGestureBase {
  readonly kind: "track";
  readonly joint: string;
  readonly track: HTMLElement;
  readonly tag: CalibrationHudTag | null;
  readonly meta: CalibrationJointMeta;
}

interface CalibrationCanvasPointerGesture extends CalibrationPointerGestureBase {
  readonly kind: "canvas";
  readonly joint: string;
  dragRef: THREE.Vector3 | null;
  dragStartQ: number;
}

type CalibrationPointerGesture =
  | CalibrationCardPointerGesture
  | CalibrationTrackPointerGesture
  | CalibrationCanvasPointerGesture;

type OwnedCalibrationPointerGesture = OwnedPointerGesture<CalibrationPointerGesture>;
type CalibrationPointerGestureTransition =
  PointerGestureTransition<CalibrationPointerGesture>;

class CalibManipulator {
  readonly canvas: HTMLCanvasElement;
  readonly hud: HTMLElement;
  readonly stage: HTMLElement;
  active = false;
  readonly raycaster = new THREE.Raycaster();
  readonly pointer = new THREE.Vector2();
  jointMeta: Record<string, CalibrationJointMeta> = {};
  linkToJoint: Record<string, string> = {};
  jointToLink: Record<string, string> = {};
  jointWorld: Record<string, CalibrationJointWorld> = {};
  selected: string | null = null;
  hoveredLink: string | null = null;
  hoveredJoint: string | null = null;
  angleUnit: CalibrationAngleUnit = "rad";
  readonly _tags = new Map<string, CalibrationHudTag>();
  _limitGroup: CalibrationLimitGizmo | null = null;
  _pickScreen: Point2D | null = null;
  _pickAnchor: THREE.Vector3 | null = null;
  _hudPinned: Point2D | null = null;
  _ctx: CalibrationContext | null = null;
  readonly _gestureOwner = new LatestPointerGestureOwner<CalibrationPointerGesture>();
  readonly _onDown: (event: PointerEvent) => void;
  readonly _onMove: (event: PointerEvent) => void;
  readonly _onUp: (event: PointerEvent) => void;
  readonly _onCancel: (event: PointerEvent) => void;
  readonly _onLostPointerCapture: (event: PointerEvent) => void;

  constructor({
    canvasEl,
    hudEl,
    stageEl,
  }: {
    canvasEl: HTMLCanvasElement;
    hudEl: HTMLElement;
    stageEl: HTMLElement;
  }) {
    this.canvas = canvasEl;
    this.hud = hudEl;
    this.stage = stageEl;
    this._onDown = (event) => this._pointerDown(event);
    this._onMove = (event) => this._pointerMove(event);
    this._onUp = (event) => this._pointerUp(event, "complete");
    this._onCancel = (event) => this._pointerUp(event, "cancel");
    this._onLostPointerCapture = (event) => {
      // Pointer Events may dispatch a pending loss after release. If its target
      // was disconnected, the spec retargets the event to its ownerDocument;
      // resolve only the exact capture token currently awaiting that pointer.
      const owned = this._gestureOwner.capture;
      const gesture = owned?.value;
      if (
        owned
        && gesture
        && matchesOwnedPointerCaptureLoss(gesture, event)
      ) this._finishPointerGesture(owned, "lost-capture");
    };
  }

  get dragging(): boolean {
    const gesture = this._gestureOwner.current?.value;
    return gesture?.kind === "canvas" && gesture.activated;
  }

  get _hudCardDrag(): boolean {
    const gesture = this._gestureOwner.current?.value;
    return gesture?.kind === "card" && gesture.activated;
  }

  private _defaultCtx(): CalibrationContext {
    return {
      robotView: robot,
      getQ: () => state.calibQ,
      getSliderRows: () => state.calibSliderRows,
      jointChange: (name, val, opts) => setCalibJointValue(name, val, opts),
      previewFk: (opts) => previewCalibPose(opts),
    };
  }

  /** Active calibration methods share one context for their full lifetime. */
  private get context(): CalibrationContext {
    if (!this._ctx) throw new Error("Calibration manipulator is not active");
    return this._ctx;
  }

  start(limitsList: RobotJointLimit[], ctx: CalibrationContext | null = null): void {
    const session = this._gestureOwner.beginSession();
    const sessionIsCurrent = (): boolean => (
      this._gestureOwner.isSessionCurrent(session)
    );
    if (!this._finishPointerGestureForReplacement()) return;
    if (!sessionIsCurrent()) return;
    const context = ctx || this._defaultCtx();
    const jointMeta: Record<string, CalibrationJointMeta> = {};
    const linkToJoint: Record<string, string> = {};
    const jointToLink: Record<string, string> = {};
    for (const L of limitsList || []) {
      if (!L.name || L.type === "fixed") continue;
      const lo = L.lower != null ? L.lower : -Math.PI;
      const hi = L.upper != null ? L.upper : Math.PI;
      jointMeta[L.name] = {
        child_link: L.child_link,
        lower: lo,
        upper: hi,
        type: L.type || "revolute",
      };
      if (L.child_link) {
        linkToJoint[L.child_link] = L.name;
        jointToLink[L.name] = L.child_link;
      }
    }
    if (!sessionIsCurrent()) return;
    this.active = true;
    this._ctx = context;
    this.jointMeta = jointMeta;
    this.linkToJoint = linkToJoint;
    this.jointToLink = jointToLink;
    this.hud.classList.remove("hidden");
    if (!sessionIsCurrent()) return;
    this.hud.setAttribute("aria-hidden", "false");
    if (!sessionIsCurrent()) return;
    this.stage.classList.add("calib-pickable");
    if (!sessionIsCurrent()) return;
    this._initLimitGizmo(session);
    if (!sessionIsCurrent()) return;
    this._buildTags(session);
    if (!sessionIsCurrent()) return;
    this.canvas.addEventListener("pointerdown", this._onDown);
    if (!sessionIsCurrent()) return;
    window.addEventListener("pointermove", this._onMove);
    if (!sessionIsCurrent()) return;
    window.addEventListener("pointerup", this._onUp);
    if (!sessionIsCurrent()) return;
    window.addEventListener("pointercancel", this._onCancel);
    if (!sessionIsCurrent()) return;
    window.addEventListener("lostpointercapture", this._onLostPointerCapture);
  }

  stop(): void {
    const session = this._gestureOwner.beginSession();
    const sessionIsCurrent = (): boolean => (
      this._gestureOwner.isSessionCurrent(session)
    );
    // Fail closed before releasing capture, then clean the exact gesture while
    // its captured context and HUD nodes are still available.
    this.active = false;
    const gesture = this._gestureOwner.current;
    if (gesture) this._finishPointerGesture(gesture, "stop");
    // Treat releasePointerCapture as a reentrant host boundary even though the
    // browser processes the corresponding capture loss later. If host code or
    // a test adapter started a successor, this stop no longer owns shared UI.
    if (!sessionIsCurrent()) return;
    this.selected = null;
    this.hoveredLink = null;
    this.hoveredJoint = null;
    this._pickScreen = null;
    this._pickAnchor = null;
    this._hudPinned = null;
    this.hud.innerHTML = "";
    if (!sessionIsCurrent()) return;
    this.hud.classList.add("hidden");
    if (!sessionIsCurrent()) return;
    this.hud.setAttribute("aria-hidden", "true");
    if (!sessionIsCurrent()) return;
    this.stage.classList.remove("calib-pickable", "calib-dragging", "calib-hover-joint");
    if (!sessionIsCurrent()) return;
    this._tags.clear();
    this._disposeLimitGizmo();
    if (!sessionIsCurrent()) return;
    (this._ctx?.robotView || robot).setCalibHighlights({});
    if (!sessionIsCurrent()) return;
    this._ctx = null;
    document.getElementById("calib-hover-hint")?.classList.remove("show");
    if (!sessionIsCurrent()) return;
    this.canvas.removeEventListener("pointerdown", this._onDown);
    if (!sessionIsCurrent()) return;
    window.removeEventListener("pointermove", this._onMove);
    if (!sessionIsCurrent()) return;
    window.removeEventListener("pointerup", this._onUp);
    if (!sessionIsCurrent()) return;
    window.removeEventListener("pointercancel", this._onCancel);
    if (!sessionIsCurrent()) return;
    window.removeEventListener("lostpointercapture", this._onLostPointerCapture);
  }

  private _initLimitGizmo(session: PointerGestureSession): void {
    this._disposeLimitGizmo();
    if (!this._gestureOwner.isSessionCurrent(session)) return;
    const g = new THREE.Group();
    const arcMat = new THREE.LineBasicMaterial({ color: 0x94a3b8, transparent: true, opacity: 0.85 });
    const loMat = new THREE.MeshBasicMaterial({ color: 0xef4444 });
    const hiMat = new THREE.MeshBasicMaterial({ color: 0xef4444 });
    const curMat = new THREE.MeshBasicMaterial({ color: 0x2563eb });
    const needleMat = new THREE.LineBasicMaterial({ color: 0x2563eb, linewidth: 2 });
    const tickGeo = new THREE.SphereGeometry(0.012, 10, 10);
    const candidate: CalibrationLimitGizmo = {
      group: g,
      arc: new THREE.Line(new THREE.BufferGeometry(), arcMat),
      loTick: new THREE.Mesh(tickGeo, loMat),
      hiTick: new THREE.Mesh(tickGeo.clone(), hiMat),
      curTick: new THREE.Mesh(tickGeo.clone(), curMat),
      needle: new THREE.Line(new THREE.BufferGeometry(), needleMat),
    };
    g.add(candidate.arc, candidate.loTick, candidate.hiTick,
      candidate.curTick, candidate.needle);
    if (!this._gestureOwner.isSessionCurrent(session)) {
      disposeDetachedThreeObject(g, "Stale calibration limit gizmo disposal failed");
      return;
    }
    g.visible = false;
    this._limitGroup = candidate;
    world.add(g);
  }

  private _disposeLimitGizmo(): void {
    // Relinquish the shared alias before detach/dispose dispatches synchronous
    // Three.js events. A callback may install a successor that this release must
    // neither clear nor dispose after it returns.
    const owned = this._limitGroup;
    this._limitGroup = null;
    if (!owned) return;

    const errors: unknown[] = [];
    try {
      world.remove(owned.group);
    } catch (error) {
      errors.push(error);
    }
    try {
      threeResourceDisposer.disposeObject3DResources(owned.group);
    } catch (error) {
      if (error instanceof AggregateError) errors.push(...error.errors);
      else errors.push(error);
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "Failed to dispose calibration limit gizmo");
    }
  }

  private _buildTags(session: PointerGestureSession): void {
    // Build off-DOM so a reentrant start cannot observe a half-built tag set.
    // Only the exact session may publish the fragment and its matching aliases.
    if (!this._gestureOwner.isSessionCurrent(session)) return;
    const context = this._ctx;
    if (!context) return;
    const jointMeta = this.jointMeta;
    const angleUnit = this.angleUnit;
    const fragment = document.createDocumentFragment();
    const candidateTags = new Map<string, CalibrationHudTag>();
    for (const name of Object.keys(jointMeta)) {
      const meta = jointMeta[name];
      const card = document.createElement("div");
      card.className = "calib-hud-card";
      card.dataset.joint = name;

      const head = document.createElement("div");
      head.className = "calib-hud-head calib-hud-drag-handle";
      head.title = runtimeText("Drag the title bar to move the control", "拖动标题栏移动控件");
      const grip = document.createElement("span");
      grip.className = "calib-hud-grip";
      grip.setAttribute("aria-hidden", "true");
      grip.textContent = "⋮⋮";
      const nameEl = document.createElement("span");
      nameEl.className = "joint-name";
      nameEl.textContent = name;
      nameEl.title = name;
      const unit = document.createElement("span");
      unit.className = "joint-unit";
      unit.textContent = angleUnit;
      head.append(grip, nameEl, unit);

      const limitRow = document.createElement("div");
      limitRow.className = "calib-limit-row";
      const loEl = document.createElement("span");
      loEl.className = "limit-end limit-lo";
      loEl.textContent = formatCalibrationAngle(meta.lower, angleUnit, 2);
      const track = document.createElement("div");
      track.className = "limit-track";
      const fill = document.createElement("div");
      fill.className = "limit-fill";
      const thumb = document.createElement("div");
      thumb.className = "limit-thumb";
      track.appendChild(fill);
      track.appendChild(thumb);
      const hiEl = document.createElement("span");
      hiEl.className = "limit-end limit-hi";
      hiEl.textContent = formatCalibrationAngle(meta.upper, angleUnit, 2);
      limitRow.append(loEl, track, hiEl);

      const input = document.createElement("input");
      input.type = "number";
      input.className = "calib-angle-input";
      input.step = angleUnit === "deg" ? "0.1" : "0.001";
      input.value = "0.000";
      input.min = String(angleForDisplay(meta.lower, angleUnit));
      input.max = String(angleForDisplay(meta.upper, angleUnit));
      input.addEventListener("input", () => {
        this.context.jointChange(name, input.value, { from: "hud-input", live: true });
      });
      input.addEventListener("change", () => {
        this.context.jointChange(name, input.value, { from: "hud-input" });
      });
      input.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") input.blur();
        ev.stopPropagation();
      });
      input.addEventListener("pointerdown", (ev) => ev.stopPropagation());

      card.append(head, limitRow, input);
      const tag: CalibrationHudTag = {
        el: card,
        input,
        nameEl,
        unitEl: unit,
        loEl,
        hiEl,
        track,
        thumb,
        fill,
      };
      // DOM dispatch keeps its original event path after replacement. Capture
      // the exact build owner so a detached A listener can never adopt B.
      this._bindHudCardDrag(card, head, context, session);
      this._bindHudTrackDrag(name, track, thumb, meta, tag, context, session);
      fragment.appendChild(card);
      candidateTags.set(name, tag);
    }
    if (!this._gestureOwner.isSessionCurrent(session)) return;
    this.hud.replaceChildren(fragment);
    if (!this._gestureOwner.isSessionCurrent(session)) return;
    this._tags.clear();
    for (const [name, tag] of candidateTags) this._tags.set(name, tag);
  }

  setAngleUnit(unit: CalibrationAngleUnit): void {
    this.angleUnit = unit;
    for (const [joint, tag] of this._tags) {
      const meta = this.jointMeta[joint];
      if (!meta) continue;
      tag.unitEl.textContent = unit;
      tag.loEl.textContent = formatCalibrationAngle(meta.lower, unit, 2);
      tag.hiEl.textContent = formatCalibrationAngle(meta.upper, unit, 2);
      tag.input.min = String(angleForDisplay(meta.lower, unit));
      tag.input.max = String(angleForDisplay(meta.upper, unit));
      tag.input.step = unit === "deg" ? "0.1" : "0.001";
      this.updateHudValue(joint, this.context.getQ()[joint] ?? 0);
    }
  }

  private _hudLayout(): HudLayout {
    const canvasRect = this.canvas.getBoundingClientRect();
    const hudRect = this.hud.getBoundingClientRect();
    return {
      ox: canvasRect.left - hudRect.left,
      oy: canvasRect.top - hudRect.top,
      w: canvasRect.width,
      h: canvasRect.height,
      cardW: 180,
      cardH: 112,
      pad: 14,
    };
  }

  private _applyHudPin(
    el: HTMLElement,
    x: number,
    y: number,
    layout: HudLayout = this._hudLayout(),
    gesture: OwnedCalibrationPointerGesture | null = null,
  ): Point2D | null {
    const gestureIsCurrent = (): boolean => (
      !gesture || this._isCurrentPointerGesture(gesture)
    );
    if (!gestureIsCurrent()) return null;
    const { w, h, cardW, cardH, pad } = layout;
    const clamped = this._clampHudCard(x, y, w, h, cardW, cardH, pad);
    el.classList.remove("screen-docked", "screen-pick");
    if (!gestureIsCurrent()) return null;
    el.classList.add("user-pinned", "visible");
    if (!gestureIsCurrent()) return null;
    el.style.left = `${clamped.x}px`;
    if (!gestureIsCurrent()) return null;
    el.style.top = `${clamped.y}px`;
    if (!gestureIsCurrent()) return null;
    return clamped;
  }

  private _isCurrentPointerGesture(owned: OwnedCalibrationPointerGesture): boolean {
    const gesture = owned.value;
    return (
      this._gestureOwner.isCurrent(owned)
      && this._gestureOwner.isSessionCurrent(gesture.session)
      && this.active
      && this._ctx === gesture.context
    );
  }

  /** Fail closed before publishing, then replace before releasing old capture. */
  private _beginPointerGesture(
    gesture: CalibrationPointerGesture,
    expectedSession: PointerGestureSession,
  ): OwnedCalibrationPointerGesture | null {
    // Layout, picking, and DOM dispatch are host boundaries. A same-context
    // start may have replaced their session while the old handler was paused;
    // never let that stale handler publish and retire the newer gesture.
    if (
      gesture.session !== expectedSession
      || !this.active
      || this._ctx !== gesture.context
      || !this._gestureOwner.isSessionCurrent(expectedSession)
    ) return null;
    const replacement = this._gestureOwner.begin(gesture);
    const owned = replacement.current;
    gesture.orbitEnabledBefore = inheritedPointerGestureOrbitBaseline(
      replacement.previous?.value ?? null,
      orbit.enabled,
    );
    if (replacement.previous) {
      this._cleanupPointerGesture(replacement.previous, replacement.handoff);
    }
    if (!this._isCurrentPointerGesture(owned)) {
      if (this._gestureOwner.isCurrent(owned)) {
        this._finishPointerGesture(owned, "cancel");
      }
      return null;
    }

    gesture.activated = true;
    try {
      if (gesture.kind === "card") {
        gesture.card.classList.add("user-pinned", "is-dragging");
        if (!this._isCurrentPointerGesture(owned)) return null;
      } else if (gesture.kind === "track") {
        gesture.tag?.el.classList.add("track-dragging");
        if (!this._isCurrentPointerGesture(owned)) return null;
        this.stage.classList.add("calib-dragging");
        if (!this._isCurrentPointerGesture(owned)) return null;
      } else {
        this.stage.classList.add("calib-dragging");
        if (!this._isCurrentPointerGesture(owned)) return null;
      }
      orbit.enabled = false;
    } catch (error) {
      this._finishPointerGesture(owned, "cancel");
      throw error;
    }
    if (!this._isCurrentPointerGesture(owned)) return null;

    // Reserve the exact capture identity before invoking host code. The stable
    // window pointerup/cancel listeners remain the fallback when capture fails.
    if (!this._gestureOwner.reserveCapture(owned)) {
      this._finishPointerGesture(owned, "cancel");
      return null;
    }
    try {
      gesture.captureTarget.setPointerCapture(gesture.pointerId);
    } catch {
      this._gestureOwner.takeCapture(owned);
      // The stable window pointerup/cancel listeners still terminate the drag.
    }
    if (!this._isCurrentPointerGesture(owned)) {
      if (this._gestureOwner.isCurrent(owned)) {
        this._finishPointerGesture(owned, "cancel");
      } else {
        this._releasePointerGestureCapture(owned);
      }
      return null;
    }
    return owned;
  }

  /**
   * Clear shared effects only while the handoff that took this gesture is
   * still current. Every DOM/host call may synchronously install generation C;
   * A cleanup must then stop before it mutates C's CSS or orbit state.
   */
  private _cleanupPointerGesture(
    owned: OwnedCalibrationPointerGesture,
    handoff: CalibrationPointerGestureTransition,
  ): void {
    const gesture = owned.value;
    const handoffIsCurrent = (): boolean => (
      this._gestureOwner.isTransitionCurrent(handoff)
    );
    const wasActivated = gesture.activated;
    gesture.activated = false;
    if (wasActivated) {
      const successor = handoff.current?.value ?? null;
      if (
        gesture.kind === "card"
        && handoffIsCurrent()
        && !(
          successor?.activated
          && successor.kind === "card"
          && successor.card === gesture.card
        )
      ) {
        runBestEffortCleanup("Calibration card drag cleanup failed", () => {
          gesture.card.classList.remove("is-dragging");
        });
      } else if (gesture.kind === "track") {
        const successorOwnsTag = Boolean(
          successor?.activated
          && successor.kind === "track"
          && successor.tag?.el === gesture.tag?.el,
        );
        if (handoffIsCurrent() && !successorOwnsTag) {
          runBestEffortCleanup("Calibration track tag cleanup failed", () => {
            gesture.tag?.el.classList.remove("track-dragging");
          });
        }
      }
    }
    if (gesture.kind === "canvas") gesture.dragRef = null;

    // Projection, rather than inverse mutation, also terminalizes shared state
    // when an unactivated B is replaced by a nested C during A's DOM cleanup.
    this._projectPointerGestureSharedState(handoff, gesture.orbitEnabledBefore);

    // Capture is record-private and must always be released, even after a
    // successor invalidates the shared cleanup handoff. Take before asking
    // for release: pending-capture processing may dispatch the loss later, and
    // this retired record must no longer appear capture-current.
    this._releasePointerGestureCapture(owned);
  }

  private _projectPointerGestureSharedState(
    handoff: CalibrationPointerGestureTransition,
    orbitEnabledBefore: boolean,
  ): void {
    if (!this._gestureOwner.isTransitionCurrent(handoff)) return;
    const current = handoff.current?.value ?? null;
    const projection = projectPointerGestureSharedState(
      current
        ? {
            activated: current.activated,
            stageDragging: current.kind !== "card",
          }
        : null,
      orbitEnabledBefore,
    );
    runBestEffortCleanup("Calibration stage drag projection failed", () => {
      this.stage.classList.toggle("calib-dragging", projection.stageDragging);
    });
    if (!this._gestureOwner.isTransitionCurrent(handoff)) return;
    runBestEffortCleanup("Calibration orbit projection failed", () => {
      orbit.enabled = projection.orbitEnabled;
    });
  }

  private _releasePointerGestureCapture(owned: OwnedCalibrationPointerGesture): void {
    if (!this._gestureOwner.takeCapture(owned)) return;
    const gesture = owned.value;
    runBestEffortCleanup("Calibration pointer capture release failed", () => {
      gesture.captureTarget.releasePointerCapture(gesture.pointerId);
    });
  }

  private _finishPointerGesture(
    owned: OwnedCalibrationPointerGesture,
    reason: CalibrationPointerGestureEnd,
  ): CalibrationPointerGestureTransition | null {
    const handoff = this._gestureOwner.finish(owned);
    if (!handoff) return null;
    const gesture = owned.value;
    this._cleanupPointerGesture(owned, handoff);

    // A host override may re-enter while capture is released; the browser can
    // also report loss later. Only an uninterrupted normal completion may
    // publish one final FK preview.
    if (
      reason === "complete"
      && gesture.kind !== "card"
      && this._gestureOwner.isTransitionCurrent(handoff)
      && this.active
      && this._ctx === gesture.context
    ) gesture.context.previewFk({ flush: true });
    return handoff;
  }

  /** Abort if capture release re-entry installed a newer gesture. */
  private _finishPointerGestureForReplacement(): boolean {
    const owned = this._gestureOwner.current;
    if (!owned) return true;
    const handoff = this._finishPointerGesture(owned, "replacement");
    return Boolean(
      handoff && this._gestureOwner.isTransitionCurrent(handoff),
    );
  }

  private _bindHudCardDrag(
    card: HTMLElement,
    head: HTMLElement,
    context: CalibrationContext,
    session: PointerGestureSession,
  ): void {
    const onDown = (e: PointerEvent): void => {
      const eventSessionIsCurrent = (): boolean => (
        this.active
        && this._ctx === context
        && this._gestureOwner.isSessionCurrent(session)
      );
      if (!eventSessionIsCurrent() || e.button !== 0) return;
      if (!eventSessionIsCurrent()) return;
      e.stopPropagation();
      if (!eventSessionIsCurrent()) return;
      e.preventDefault();
      if (!eventSessionIsCurrent()) return;
      const layout = this._hudLayout();
      if (!eventSessionIsCurrent()) return;
      const hudRect = this.hud.getBoundingClientRect();
      if (!eventSessionIsCurrent()) return;
      const cardRect = card.getBoundingClientRect();
      if (!eventSessionIsCurrent()) return;
      const anchorX = cardRect.left - hudRect.left + cardRect.width * 0.5;
      const anchorY = cardRect.top - hudRect.top + cardRect.height * 0.5;
      const start = { px: e.clientX, py: e.clientY, ax: anchorX, ay: anchorY };
      this._beginPointerGesture({
        kind: "card",
        pointerId: e.pointerId,
        captureTarget: head,
        context,
        session,
        activated: false,
        orbitEnabledBefore: orbit.enabled,
        card,
        layout,
        start,
      }, session);
    };
    head.addEventListener("pointerdown", onDown);
  }

  private _bindHudTrackDrag(
    name: string,
    track: HTMLElement,
    thumb: HTMLElement,
    meta: CalibrationJointMeta,
    tag: CalibrationHudTag,
    context: CalibrationContext,
    session: PointerGestureSession,
  ): void {
    const onDown = (e: PointerEvent): void => {
      const eventSessionIsCurrent = (): boolean => (
        this.active
        && this._ctx === context
        && this._gestureOwner.isSessionCurrent(session)
      );
      if (!eventSessionIsCurrent() || e.button !== 0) return;
      if (!eventSessionIsCurrent()) return;
      e.stopPropagation();
      if (!eventSessionIsCurrent()) return;
      e.preventDefault();
      if (!eventSessionIsCurrent()) return;
      const gesture: CalibrationTrackPointerGesture = {
        kind: "track",
        pointerId: e.pointerId,
        captureTarget: track,
        context,
        session,
        activated: false,
        orbitEnabledBefore: orbit.enabled,
        joint: name,
        track,
        tag,
        meta,
      };
      const owned = this._beginPointerGesture(gesture, session);
      if (!owned) return;
      try {
        this.setSelected(name, { gesture: owned });
        if (this._isCurrentPointerGesture(owned)) {
          this._moveTrackPointerGesture(owned, e.clientX);
        }
      } catch (error) {
        this._finishPointerGesture(owned, "cancel");
        throw error;
      }
    };
    track.addEventListener("pointerdown", onDown);
    thumb.addEventListener("pointerdown", onDown);
  }

  private _moveCardPointerGesture(
    owned: OwnedCalibrationPointerGesture,
    clientX: number,
    clientY: number,
  ): void {
    const gesture = owned.value;
    if (gesture.kind !== "card" || !this._isCurrentPointerGesture(owned)) return;
    const x = gesture.start.ax + (clientX - gesture.start.px);
    const y = gesture.start.ay + (clientY - gesture.start.py);
    this._hudPinned = { x, y };
    if (!this._isCurrentPointerGesture(owned)) return;
    this._applyHudPin(gesture.card, x, y, gesture.layout, owned);
    if (!this._isCurrentPointerGesture(owned)) return;
  }

  private _moveTrackPointerGesture(
    owned: OwnedCalibrationPointerGesture,
    clientX: number,
  ): void {
    const gesture = owned.value;
    if (gesture.kind !== "track" || !this._isCurrentPointerGesture(owned)) return;
    const rect = gesture.track.getBoundingClientRect();
    if (!this._isCurrentPointerGesture(owned)) return;
    const t = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    const pct = `${(t * 100).toFixed(2)}%`;
    if (gesture.tag) {
      gesture.tag.thumb.style.left = pct;
      if (!this._isCurrentPointerGesture(owned)) return;
      gesture.tag.fill.style.width = pct;
      if (!this._isCurrentPointerGesture(owned)) return;
    }
    const value = gesture.meta.lower + t * (gesture.meta.upper - gesture.meta.lower);
    gesture.context.jointChange(gesture.joint, value, {
      from: "hud-track",
      live: true,
    });
  }

  setSelected(
    jointName: string,
    {
      scrollPanel = false,
      gesture = null,
    }: {
      scrollPanel?: boolean;
      gesture?: OwnedCalibrationPointerGesture | null;
    } = {},
  ): void {
    const gestureIsCurrent = (): boolean => (
      !gesture || this._isCurrentPointerGesture(gesture)
    );
    if (!this.active || !gestureIsCurrent()) return;
    const context = gesture?.value.context ?? this.context;
    const tags = [...this._tags.entries()];
    this.selected = jointName;
    for (const [j, { el }] of tags) {
      if (!gestureIsCurrent()) return;
      el.classList.toggle("visible", j === jointName);
      if (!gestureIsCurrent()) return;
    }
    const sliderRows = context.getSliderRows();
    if (!gestureIsCurrent()) return;
    const sliderEntries = Object.entries(sliderRows);
    if (!gestureIsCurrent()) return;
    for (const [j, rowRec] of sliderEntries) {
      if (!gestureIsCurrent()) return;
      rowRec.row?.classList.toggle("selected", j === jointName);
      if (!gestureIsCurrent()) return;
    }
    this._syncHighlights(gesture);
    if (!gestureIsCurrent()) return;
    this._updateLimitGizmo(gesture);
    if (!gestureIsCurrent()) return;
    if (scrollPanel && jointName && sliderRows[jointName]?.row) {
      sliderRows[jointName].row.scrollIntoView({ block: "nearest", behavior: "smooth" });
      if (!gestureIsCurrent()) return;
    }
  }

  private _syncHighlights(
    gesture: OwnedCalibrationPointerGesture | null = null,
  ): void {
    if (gesture && !this._isCurrentPointerGesture(gesture)) return;
    const context = gesture?.value.context ?? this.context;
    const selLink = this.selected ? this.jointToLink[this.selected] : null;
    const hovLink = this.hoveredLink;
    const hoveredJoint = this.hoveredJoint;
    const dragging = gesture
      ? gesture.value.kind === "canvas" && gesture.value.activated
      : this.dragging;
    context.robotView.setCalibHighlights({ hover: hovLink, selected: selLink });
    if (gesture && !this._isCurrentPointerGesture(gesture)) return;
    this.stage.classList.toggle("calib-hover-joint", !!(hoveredJoint && !dragging));
  }

  updateHudValue(
    jointName: string,
    value: string | number,
    {
      live = false,
      syncInput = true,
    }: { live?: boolean; syncInput?: boolean } = {},
  ): void {
    const tag = this._tags.get(jointName);
    if (!tag) return;
    const x = parseFloat(String(value));
    if (!Number.isFinite(x)) return;
    const meta = this.jointMeta[jointName];
    if (syncInput) {
      tag.input.value = formatCalibrationAngle(x, this.angleUnit, live ? 4 : 3);
    }
    if (meta) {
      const span = meta.upper - meta.lower;
      const t = span > 1e-9 ? (x - meta.lower) / span : 0.5;
      const pct = `${Math.min(100, Math.max(0, t * 100)).toFixed(1)}%`;
      tag.thumb.style.left = pct;
      tag.fill.style.width = pct;
      const atLo = Math.abs(x - meta.lower) < 0.008;
      const atHi = Math.abs(x - meta.upper) < 0.008;
      tag.el.classList.toggle("at-limit-lo", atLo);
      tag.el.classList.toggle("at-limit-hi", atHi);
    }
    if (jointName === this.selected) this._updateLimitGizmo();
  }

  updateJointWorld(jointWorld: Record<string, CalibrationJointWorld> | null | undefined): void {
    this.jointWorld = jointWorld || {};
    this._positionTags();
    if (this.selected) this._updateLimitGizmo();
  }

  private _perpRef(axis: THREE.Vector3, pivot: THREE.Vector3): THREE.Vector3 {
    const camDir = camera.position.clone().sub(pivot).normalize();
    _arcRef.crossVectors(axis, camDir);
    if (_arcRef.lengthSq() < 1e-8) _arcRef.crossVectors(axis, new THREE.Vector3(0, 1, 0));
    return _arcRef.normalize();
  }

  private _updateLimitGizmo(
    gesture: OwnedCalibrationPointerGesture | null = null,
  ): void {
    if (gesture && !this._isCurrentPointerGesture(gesture)) return;
    const limitGroup = this._limitGroup;
    const selected = this.selected;
    const jointMeta = this.jointMeta;
    const jointWorld = this.jointWorld;
    const context = gesture?.value.context ?? this.context;
    if (!limitGroup || !selected) {
      if (limitGroup) limitGroup.group.visible = false;
      return;
    }
    const joint = selected;
    const meta = jointMeta[joint];
    const jw = jointWorld[joint];
    if (!meta || !jw?.pivot || !jw?.axis || meta.type === "prismatic") {
      limitGroup.group.visible = false;
      return;
    }
    const q = context.getQ()[joint] ?? 0;
    if (gesture && !this._isCurrentPointerGesture(gesture)) return;
    const pivot = hhtoolsToWorldVec3(jw.pivot[0], jw.pivot[1], jw.pivot[2], new THREE.Vector3());
    const axis = hhtoolsToWorldVec3(jw.axis[0], jw.axis[1], jw.axis[2], _hhtoolsAxis).normalize();
    const ref = this._perpRef(axis, pivot);
    const R = 0.11;

    const steps = 36;
    const arcPts: THREE.Vector3[] = [];
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const ang = meta.lower + (meta.upper - meta.lower) * t;
      arcPts.push(arcPointWorld(pivot, axis, ref, ang, R));
    }
    limitGroup.arc.geometry.setFromPoints(arcPts);
    if (gesture && !this._isCurrentPointerGesture(gesture)) return;

    const loP = arcPointWorld(pivot, axis, ref, meta.lower, R);
    const hiP = arcPointWorld(pivot, axis, ref, meta.upper, R);
    const curP = arcPointWorld(pivot, axis, ref, q, R);
    limitGroup.loTick.position.copy(loP);
    if (gesture && !this._isCurrentPointerGesture(gesture)) return;
    limitGroup.hiTick.position.copy(hiP);
    if (gesture && !this._isCurrentPointerGesture(gesture)) return;
    limitGroup.curTick.position.copy(curP);
    if (gesture && !this._isCurrentPointerGesture(gesture)) return;
    limitGroup.needle.geometry.setFromPoints([pivot, curP]);
    if (gesture && !this._isCurrentPointerGesture(gesture)) return;

    limitGroup.group.visible = true;
  }

  private _clampHudCard(
    sx: number,
    sy: number,
    w: number,
    h: number,
    cardW: number,
    cardH: number,
    pad: number,
  ): Point2D {
    return {
      x: Math.min(w - pad - cardW * 0.5, Math.max(pad + cardW * 0.5, sx)),
      y: Math.min(h - pad, Math.max(pad + cardH, sy)),
    };
  }

  private _projectToHud(
    worldPoint: THREE.Vector3,
    w: number,
    h: number,
    ox: number,
    oy: number,
    out = new THREE.Vector3(),
  ): Point2D & { inFront: boolean } {
    out.copy(worldPoint).project(camera);
    return {
      x: (out.x * 0.5 + 0.5) * w + ox,
      y: (-out.y * 0.5 + 0.5) * h + oy,
      inFront: out.z >= -1 && out.z <= 1,
    };
  }

  _positionTags(
    gesture: OwnedCalibrationPointerGesture | null = null,
  ): void {
    const gestureIsCurrent = (): boolean => (
      !gesture || this._isCurrentPointerGesture(gesture)
    );
    if (!this.active || !gestureIsCurrent() || this._hudCardDrag) return;
    const selected = this.selected;
    const tags = [...this._tags.entries()];
    const jointWorld = this.jointWorld;
    const hudPinned = this._hudPinned ? { ...this._hudPinned } : null;
    const pickAnchor = this._pickAnchor?.clone() ?? null;
    const layout = this._hudLayout();
    if (!gestureIsCurrent()) return;
    const { ox, oy, w, h } = layout;
    const _proj = new THREE.Vector3();
    for (const [name, { el }] of tags) {
      if (!gestureIsCurrent()) return;
      if (!selected || name !== selected) {
        el.classList.remove("visible", "screen-docked", "screen-pick", "user-pinned", "is-dragging");
        if (!gestureIsCurrent()) return;
        continue;
      }
      const jw = jointWorld[name];
      if (!jw?.pivot) continue;

      if (hudPinned) {
        this._applyHudPin(el, hudPinned.x, hudPinned.y, layout, gesture);
        if (!gestureIsCurrent()) return;
        continue;
      }

      let sx = w * 0.72 + ox;
      let sy = h * 0.38 + oy;
      let mode = "screen-docked";

      const anchor = pickAnchor;
      if (anchor) {
        const hit = this._projectToHud(anchor, w, h, ox, oy, _proj);
        if (hit.inFront) {
          sx = hit.x;
          sy = hit.y - 18;
          mode = "screen-pick";
        }
      } else {
        const pivot = hhtoolsToWorldVec3(jw.pivot[0], jw.pivot[1], jw.pivot[2], _proj);
        const hit = this._projectToHud(pivot, w, h, ox, oy, _proj);
        if (hit.inFront) {
          sx = hit.x;
          sy = hit.y - 18;
          mode = "anchored";
        }
      }

      const clamped = this._clampHudCard(sx, sy, w, h, layout.cardW, layout.cardH, layout.pad);
      el.classList.remove("user-pinned");
      if (!gestureIsCurrent()) return;
      el.classList.toggle("screen-docked", mode === "screen-docked");
      if (!gestureIsCurrent()) return;
      el.classList.toggle("screen-pick", mode === "screen-pick");
      if (!gestureIsCurrent()) return;
      el.style.left = `${clamped.x}px`;
      if (!gestureIsCurrent()) return;
      el.style.top = `${clamped.y}px`;
      if (!gestureIsCurrent()) return;
      el.classList.add("visible");
      if (!gestureIsCurrent()) return;
    }
  }

  private _pointerNdc(clientX: number, clientY: number): void {
    const rect = this.canvas.getBoundingClientRect();
    this.pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
  }

  private _pickMeshes(
    clientX: number,
    clientY: number,
    context: CalibrationContext | null = this._ctx,
  ): THREE.Intersection<THREE.Object3D>[] {
    this._pointerNdc(clientX, clientY);
    this.raycaster.setFromCamera(this.pointer, camera);
    const meshes: THREE.Object3D[] = [];
    context?.robotView.group.traverse((node) => {
      const candidate = node as THREE.Mesh;
      if (candidate.isMesh && candidate.visible) meshes.push(candidate);
    });
    return this.raycaster.intersectObjects(meshes, false);
  }

  private _pickLink(clientX: number, clientY: number): string | null {
    const hits = this._pickMeshes(clientX, clientY);
    if (!hits.length) return null;
    return this._ctx?.robotView._linkForNode(hits[0].object) ?? null;
  }

  private _jointForLink(link: string | null): string | null {
    if (!link) return null;
    return this.linkToJoint[link] || null;
  }

  private _updateHover(clientX: number, clientY: number): void {
    const link = this._pickLink(clientX, clientY);
    const joint = this._jointForLink(link);
    this.hoveredLink = link;
    this.hoveredJoint = joint;
    this._syncHighlights();
    if (joint && joint !== this.selected) {
      const hint = document.getElementById("calib-hover-hint");
      if (hint) {
        hint.textContent = joint;
        hint.classList.add("show");
      }
    } else {
      document.getElementById("calib-hover-hint")?.classList.remove("show");
    }
  }

  private _pointerDown(e: PointerEvent): void {
    const context = this._ctx;
    const session = this._gestureOwner.currentSession;
    if (!context || !session) return;
    const eventSessionIsCurrent = (): boolean => (
      this.active
      && this._ctx === context
      && this._gestureOwner.isSessionCurrent(session)
    );
    if (!eventSessionIsCurrent() || e.button !== 0) return;
    if (!eventSessionIsCurrent()) return;
    const hudCard = e.target instanceof Element
      ? e.target.closest(".calib-hud-card")
      : null;
    if (!eventSessionIsCurrent() || hudCard) return;
    const hits = this._pickMeshes(e.clientX, e.clientY, context);
    if (!eventSessionIsCurrent()) return;
    const link = hits.length
      ? context.robotView._linkForNode(hits[0].object)
      : null;
    if (!eventSessionIsCurrent()) return;
    const joint = this._jointForLink(link);
    if (!joint) {
      if (!this._finishPointerGestureForReplacement()) return;
      if (!eventSessionIsCurrent()) return;
      this.selected = null;
      for (const { el } of this._tags.values()) el.classList.remove("visible");
      for (const rowRec of Object.values(this.context.getSliderRows())) {
        rowRec.row?.classList.remove("selected");
      }
      this._updateLimitGizmo();
      this._syncHighlights();
      return;
    }
    e.preventDefault();
    if (!eventSessionIsCurrent()) return;
    const meta = this.jointMeta[joint];
    if (!meta || meta.type === "prismatic") {
      if (!this._finishPointerGestureForReplacement()) return;
      if (!eventSessionIsCurrent()) return;
      this._pickScreen = { x: e.clientX, y: e.clientY };
      this._pickAnchor = hits[0].point.clone();
      this._hudPinned = null;
      this.setSelected(joint, { scrollPanel: true });
      return;
    }
    const dragStartQ = context.getQ()[joint] ?? 0;
    if (!eventSessionIsCurrent()) return;
    const gesture: CalibrationCanvasPointerGesture = {
      kind: "canvas",
      pointerId: e.pointerId,
      captureTarget: this.canvas,
      context,
      session,
      activated: false,
      orbitEnabledBefore: orbit.enabled,
      joint,
      dragRef: null,
      dragStartQ,
    };
    const owned = this._beginPointerGesture(gesture, session);
    if (!owned) return;
    try {
      this._pickScreen = { x: e.clientX, y: e.clientY };
      this._pickAnchor = hits[0].point.clone();
      this._hudPinned = null;
      this.setSelected(joint, { scrollPanel: true, gesture: owned });
    } catch (error) {
      this._finishPointerGesture(owned, "cancel");
      throw error;
    }
  }

  private _pointerMove(e: PointerEvent): void {
    if (!this.active) return;
    const owned = this._gestureOwner.current;
    if (owned) {
      const gesture = owned.value;
      if (e.pointerId !== gesture.pointerId) return;
      try {
        if (gesture.kind === "card") {
          this._moveCardPointerGesture(owned, e.clientX, e.clientY);
        } else if (gesture.kind === "track") {
          this._moveTrackPointerGesture(owned, e.clientX);
        } else {
          this._applyDrag(owned, e.clientX, e.clientY);
        }
        if (this._isCurrentPointerGesture(owned)) this._positionTags(owned);
      } catch (error) {
        this._finishPointerGesture(owned, "cancel");
        throw error;
      }
      return;
    }
    this._updateHover(e.clientX, e.clientY);
    this._positionTags();
  }

  private _pointerUp(
    event: PointerEvent,
    reason: Extract<CalibrationPointerGestureEnd, "complete" | "cancel">,
  ): void {
    const owned = this._gestureOwner.current;
    if (!owned || event.pointerId !== owned.value.pointerId) return;
    this._finishPointerGesture(owned, reason);
  }

  private _applyDrag(
    owned: OwnedCalibrationPointerGesture,
    clientX: number,
    clientY: number,
  ): void {
    const gesture = owned.value;
    if (gesture.kind !== "canvas" || !this._isCurrentPointerGesture(owned)) return;
    const joint = gesture.joint;
    const jw = this.jointWorld[joint];
    const meta = this.jointMeta[joint];
    if (!jw?.pivot || !jw?.axis || !meta) return;

    const pivot = hhtoolsToWorldVec3(jw.pivot[0], jw.pivot[1], jw.pivot[2], new THREE.Vector3());
    const axis = hhtoolsToWorldVec3(jw.axis[0], jw.axis[1], jw.axis[2], _hhtoolsAxis).normalize();

    this._pointerNdc(clientX, clientY);
    this.raycaster.setFromCamera(this.pointer, camera);
    _dragPlane.setFromNormalAndCoplanarPoint(axis, pivot);
    if (!this.raycaster.ray.intersectPlane(_dragPlane, _projScratch)) return;

    const vec = _projScratch.clone().sub(pivot);
    const len = vec.length();
    if (len < 1e-6) return;
    vec.divideScalar(len);

    if (!gesture.dragRef) {
      gesture.dragRef = vec.clone();
      return;
    }

    const cross = new THREE.Vector3().crossVectors(gesture.dragRef, vec);
    const sinA = axis.dot(cross);
    const cosA = gesture.dragRef.dot(vec);
    const delta = Math.atan2(sinA, cosA);
    const newQ = Math.min(meta.upper, Math.max(meta.lower, gesture.dragStartQ + delta));
    if (!this._isCurrentPointerGesture(owned)) return;
    gesture.context.jointChange(joint, newQ, { from: "drag", live: true });
  }
}

const calibManip = new CalibManipulator({
  canvasEl: document.getElementById("three-canvas"),
  hudEl: document.getElementById("calib-hud"),
  stageEl: document.getElementById("stage"),
});

// =================================================================  RETARGET / CALIBRATION
function setCalChip(text: unknown, cls = ""): void {
  renderStatusChip(document.getElementById("rt-cal"), text, cls);
}

function _snapshotVis(): ViewVisibilitySnapshot {
  return {
    skel: h2rRequestedVisibility.sourceSkeleton,
    body: bodyIsRequestedVisible(),
    scaled: h2rRequestedVisibility.scaledSkeleton,
    scaledEnv: h2rRequestedVisibility.scaledEnvironment,
    env: h2rRequestedVisibility.sourceEnvironment,
    robot: h2rRequestedVisibility.targetRobot,
    playing: player.playing,
    t: player.t,
    playbar: playbarVisible,
  };
}

function _setPlaybarVisible(on: boolean): void {
  playbarVisible = Boolean(on);
  publishPlaybackState();
}

function updateCalibBanner(_reference: string): void {
  const el = document.getElementById("calib-banner");
  if (!el) return;
  const message = document.createElement("span");
  message.append(
    document.createTextNode(runtimeText(
      "Calibration mode · Align the grey robot to the ",
      "标定模式 · 请将灰色机器人对齐到",
    )),
    textElement("b", "", runtimeText("blue reference skeleton", "蓝色参考骨架")),
    document.createTextNode(runtimeText(
      ". Drag joints or use the right-side sliders, then save.",
      " · 点击关节拖动或右栏滑块调整，完成后保存",
    )),
  );
  el.replaceChildren(textElement("span", "dot", ""), message);
}

function updateR2rCalibBanner(): void {
  const el = document.getElementById("calib-banner");
  if (!el) return;
  const src = r2r.sourcePayload?.display_name || r2r.sourceName
    || runtimeText("source robot", "源机器人");
  const tgt = r2r.targetPayload?.display_name || r2r.targetName
    || runtimeText("target robot", "目标机器人");
  const message = document.createElement("span");
  message.append(
    document.createTextNode(runtimeText("R2R calibration · Align ", "R2R 标定 · 将")),
    textElement("b", "", tgt),
    document.createTextNode(runtimeText(" to the ", "对齐到")),
    textElement("b", "", runtimeText(`blue ${src} reference pose`, `蓝色 ${src} 参考姿态`)),
    document.createTextNode(runtimeText(
      ". Drag joints or use the right-side sliders, then save.",
      " · 点击关节拖动或右侧滑块调整，完成后保存",
    )),
  );
  el.replaceChildren(textElement("span", "dot", ""), message);
}

function _applyCalibSceneLayout(): void {
  // Calibration changes both resource availability and all layer toggles.
  // Commit that layout as one display state instead of six transient states.
  withH2rStageDisplayBatch(() => {
    state.robotTrajectory = null;
    robot.trajectory = null;
    clearResultDiagnostics("h2r");
    scaledSkel.clear();
    scaledEnv.clear();
    setH2rLayerVisible("sourceSkeleton", false);
    setBodyVisible(false);
    setH2rLayerVisible("sourceEnvironment", false);
    setH2rLayerVisible("scaledSkeleton", false);
    setH2rLayerVisible("scaledEnvironment", false);
    setH2rLayerVisible("targetRobot", true);
    robot.applyStatic();
    refSkel.group.visible = true;
    player.setPlaying(false);
    _setPlaybarVisible(false);
  });
}

function _restoreVis(snap: ViewVisibilitySnapshot | null): void {
  if (!snap) {
    // `calibrationMode` may still have changed even when no prior layout was
    // captured, so capability observers must be refreshed.
    markH2rStageDisplayChanged();
    return;
  }
  withH2rStageDisplayBatch(() => {
    refSkel.clear();
    refSkel.group.visible = false;
    setH2rLayerVisible("sourceSkeleton", snap.skel);
    setBodyVisible(snap.body);
    setH2rLayerVisible("sourceEnvironment", snap.env);
    setH2rLayerVisible("scaledSkeleton", snap.scaled);
    setH2rLayerVisible("scaledEnvironment", snap.scaledEnv);
    setH2rLayerVisible("targetRobot", snap.robot);
    _setPlaybarVisible(snap.playbar);
    player.t = snap.t;
    player.setPlaying(snap.playing);
    player.refreshFrame();
  });
}

interface H2rCalibrationPairIdentity {
  readonly robot: RobotPayload;
  readonly robotName: string;
  readonly robotViewGeneration: number;
  readonly motion: MotionPayload | null;
  readonly motionToken: string | null;
  readonly reference: string;
}

interface H2rCalibrationBootstrapIdentity extends H2rCalibrationPairIdentity {
  readonly robotGroundOffset: number;
}

const h2rCalibrationBootstrapAttempts = new LatestAsyncAttemptOwner<
  H2rCalibrationBootstrapIdentity
>((identity) => (
  state.robot === identity.robot
  && state.robot?.name === identity.robotName
  && robot.isLoadGenerationCurrent(identity.robotViewGeneration)
  && state.motion === identity.motion
  && (state.motion?.token ?? null) === identity.motionToken
  && state.reference === identity.reference
));

const h2rCalibrationStatusAttempts = new LatestAsyncAttemptOwner<
  H2rCalibrationPairIdentity
>((identity) => (
  state.robot === identity.robot
  && state.robot?.name === identity.robotName
  && robot.isLoadGenerationCurrent(identity.robotViewGeneration)
  && state.motion === identity.motion
  && (state.motion?.token ?? null) === identity.motionToken
  && state.reference === identity.reference
));

function h2rCalibrationStatusUrl(
  identity: H2rCalibrationPairIdentity,
): `/api/calibration/status${string}` {
  return `/api/calibration/status?robot=${encodeURIComponent(identity.robotName)}&reference=${encodeURIComponent(identity.reference)}`;
}

function rollbackH2rCalibrationBootstrap(
  attempt: LatestAsyncAttempt<H2rCalibrationBootstrapIdentity>,
  error: unknown,
): boolean {
  if (!h2rCalibrationBootstrapAttempts.isCurrent(attempt)) return false;
  const visibilitySnapshot = state.calibRestore;
  const orbitSnapshot = state.calibOrbitSaved;

  h2rCalibrationFkPreview.stop();
  if (!h2rCalibrationBootstrapAttempts.isCurrent(attempt)) return false;

  // Canonical aliases become terminal before fallible renderer/DOM cleanup.
  state.calibrationMode = false;
  state.calibNeedsCameraFocus = false;
  state.calibLimits = null;
  state.calibQ = {};
  state.calibSliderRows = {};
  state.calibBaselineQ = null;
  state.calibDraftQ = null;
  state.calibHasSaved = false;
  calibrationEditorUi.h2r.comparison = "current";

  const cleanup = (context: string, action: () => void): boolean => {
    if (!h2rCalibrationBootstrapAttempts.isCurrent(attempt)) return false;
    runBestEffortCleanup(context, action);
    return h2rCalibrationBootstrapAttempts.isCurrent(attempt);
  };

  if (orbitSnapshot && !cleanup("calibration bootstrap: orbit restore failed", () => {
    orbit.minDistance = orbitSnapshot.minDistance;
    orbit.maxDistance = orbitSnapshot.maxDistance;
    orbit.zoomSpeed = orbitSnapshot.zoomSpeed;
  })) return false;
  if (!cleanup("calibration bootstrap: manipulator cleanup failed", () => calibManip.stop())) return false;
  if (!cleanup("calibration bootstrap: robot opacity restore failed", () => robot.setOpacity(1))) return false;
  if (!cleanup("calibration bootstrap: editor cleanup failed", () => {
    const card = document.getElementById("calib-card");
    if (card) card.style.display = "none";
    document.getElementById("calib-sliders")?.replaceChildren();
    document.getElementById("calib-banner")?.classList.add("hidden");
  })) return false;
  if (!cleanup("calibration bootstrap: visibility restore failed", () => {
    if (visibilitySnapshot) {
      _restoreVis(visibilitySnapshot);
    } else {
      refSkel.clear();
      refSkel.group.visible = false;
      markH2rStageDisplayChanged();
    }
  })) return false;
  if (!cleanup("calibration bootstrap: robot ground offset restore failed", () => {
    robot.groundOffset = attempt.identity.robotGroundOffset;
  })) return false;
  if (!cleanup("calibration bootstrap: robot pose restore failed", () => {
    if (robot.trajectory) robot.setFrame(0);
    else robot.applyStatic();
  })) return false;
  if (!cleanup("calibration bootstrap: workflow publication failed", () => {
    publishH2rWorkflowState();
    emitCalibrationEditorState("h2r");
  })) return false;
  if (!cleanup("calibration bootstrap: error notification failed", () => {
    toast(errorMessage(error), true);
  })) return false;
  if (!h2rCalibrationBootstrapAttempts.finish(attempt)) return false;
  // The original snapshots belong to the whole calibration lifetime. Keep them
  // available until A is fully retired so a reentrant B inherits the real
  // pre-calibration baseline instead of a partially restored scene.
  state.calibOrbitSaved = null;
  state.calibRestore = null;
  return true;
}

async function enterCalibrationMode(
  initialQ: Record<string, number> | null = null,
): Promise<CalibrationBootstrapResult> {
  const activeRobot = state.robot;
  const activeMotion = state.motion;
  const reference = state.reference;
  if (!activeRobot || !reference) return "failed";

  h2rCalibrationStatusAttempts.invalidate();
  const attempt = h2rCalibrationBootstrapAttempts.begin({
    robot: activeRobot,
    robotName: activeRobot.name,
    robotViewGeneration: robot.loadGeneration,
    motion: activeMotion,
    motionToken: activeMotion?.token ?? null,
    robotGroundOffset: robot.groundOffset,
    reference,
  });
  const requestedInitialQ = initialQ && typeof initialQ === "object"
    ? { ...initialQ }
    : null;
  const enteringFresh = (
    !state.calibrationMode
    && state.calibRestore === null
    && state.calibOrbitSaved === null
  );
  const isCurrent = (): boolean =>
    h2rCalibrationBootstrapAttempts.isCurrent(attempt);

  try {
    if (enteringFresh) {
      state.calibRestore = _snapshotVis();
      state.calibOrbitSaved = {
        minDistance: orbit.minDistance,
        maxDistance: orbit.maxDistance,
        zoomSpeed: orbit.zoomSpeed,
      };
    }
    if (!isCurrent()) return "stale";

    // Each bootstrap attempt owns a fresh FK publication generation, while the
    // original visibility/orbit snapshots span all same-session re-entries.
    h2rCalibrationFkPreview.start();
    if (!isCurrent()) return "stale";
    state.calibrationMode = true;
    state.calibNeedsCameraFocus = true;

    const calCard = document.getElementById("calib-card");
    if (!calCard) throw new Error("Calibration card is unavailable");
    calCard.style.display = "block";
    const retargetButton = document.getElementById("retarget-btn") as HTMLButtonElement | null;
    if (retargetButton) retargetButton.disabled = true;
    setCalChip(runtimeText("Calibrating…", "标定中…"), "warn");
    if (!isCurrent()) return "stale";

    orbit.zoomSpeed = 0.022;
    applyCalibOrbitLimits();
    if (!isCurrent()) return "stale";
    updateCalibBanner(reference);
    if (!isCurrent()) return "stale";
    document.getElementById("calib-banner")?.classList.remove("hidden");
    _applyCalibSceneLayout();
    if (!isCurrent()) return "stale";
    publishH2rWorkflowState();
    if (!isCurrent()) return "stale";
    toast(runtimeText(
      "Calibration mode started. Align the robot to the blue reference skeleton.",
      "已进入标定模式：请对齐蓝色参考骨架",
    ));
    if (!isCurrent()) return "stale";
    if (player.active) player.seek(0);
    if (!isCurrent()) return "stale";

    const session = await API.post("/api/calibration/session", {
      robot: attempt.identity.robotName,
      reference: attempt.identity.reference,
      motion_token: attempt.identity.motionToken,
    });
    if (!isCurrent()) return "stale";
    if (!session.reference) throw new Error(runtimeText(
      "Calibration session did not include a reference pose",
      "标定会话未返回参考姿态",
    ));

    state.calibLimits = session.joint_limits || [];
    robot.groundOffset = session.ground_offset_z ?? robot.groundOffset;
    refSkel.load(session.reference);
    if (!isCurrent()) return "stale";
    refSkel.configureMappings(attempt.identity.robot.ik_map ?? {});
    if (!isCurrent()) return "stale";
    if (session.reference_name) updateCalibBanner(session.reference_name);
    if (!isCurrent()) return "stale";
    _applyCalibSceneLayout();
    if (!isCurrent()) return "stale";

    const q = requestedInitialQ ?? { ...(session.joint_q || {}) };
    state.calibHasSaved = !!session.has_saved_calibration;
    state.calibBaselineQ = state.calibHasSaved ? { ...q } : null;
    state.calibDraftQ = { ...q };
    calibrationEditorUi.h2r.comparison = "current";
    updateCalibRestoreButton();
    if (!isCurrent()) return "stale";
    calibManip.start(state.calibLimits);
    if (!isCurrent()) return "stale";
    buildCalibSliders(q, state.calibLimits);
    if (!isCurrent()) return "stale";
    applyCalibrationVisualization("h2r");
    if (!isCurrent()) return "stale";
    updateH2rCalibrationValidation();
    if (!isCurrent()) return "stale";
    publishH2rWorkflowState();
    if (!isCurrent()) return "stale";
    calCard.scrollIntoView({ behavior: "smooth", block: "nearest" });
    if (!isCurrent()) return "stale";
    return h2rCalibrationBootstrapAttempts.finish(attempt)
      ? "entered"
      : "stale";
  } catch (error) {
    if (!isCurrent()) return "stale";
    return rollbackH2rCalibrationBootstrap(attempt, error)
      ? "failed"
      : "stale";
  }
}

function updateCalibRestoreButton(): void {
  const btn = document.getElementById("calib-restore");
  if (!btn) return;
  btn.disabled = !state.calibHasSaved;
  btn.title = state.calibHasSaved
    ? runtimeText("Restore the last saved calibration", "恢复到上次保存的标定值")
    : runtimeText(
      "No saved calibration yet; save one before resetting",
      "尚无已保存标定（保存后可重置）",
    );
}

function exitCalibrationMode(): void {
  h2rCalibrationBootstrapAttempts.invalidate();
  h2rCalibrationStatusAttempts.invalidate();
  h2rCalibrationFkPreview.stop();
  state.calibrationMode = false;
  state.calibNeedsCameraFocus = false;
  if (state.calibOrbitSaved) {
    orbit.minDistance = state.calibOrbitSaved.minDistance;
    orbit.maxDistance = state.calibOrbitSaved.maxDistance;
    orbit.zoomSpeed = state.calibOrbitSaved.zoomSpeed ?? orbit.zoomSpeed;
    state.calibOrbitSaved = null;
  }
  calibManip.stop();
  robot.setOpacity(1);
  state.calibSliderRows = {};
  document.getElementById("calib-banner")?.classList.add("hidden");
  state.calibLimits = null;
  state.calibBaselineQ = null;
  state.calibDraftQ = null;
  state.calibHasSaved = false;
  calibrationEditorUi.h2r.comparison = "current";
  const snap = state.calibRestore;
  state.calibRestore = null;
  _restoreVis(snap);
  if (robot.trajectory) {
    robot.setFrame(0);
  } else {
    robot.applyStatic();
  }
  publishH2rWorkflowState();
  emitCalibrationEditorState("h2r");
}

function setCalibJointValue(
  jointName: string,
  value: string | number,
  { from, live = false }: CalibrationChangeOptions,
): void {
  const limByName: Record<string, RobotJointLimit> = {};
  for (const L of state.calibLimits || []) limByName[L.name] = L;
  const lim = limByName[jointName];
  let lo = lim?.lower != null ? lim.lower : -Math.PI;
  let hi = lim?.upper != null ? lim.upper : Math.PI;
  if (hi <= lo) { lo = -Math.PI; hi = Math.PI; }
  let x = parseFloat(String(value));
  if (!Number.isFinite(x)) return;
  if (from === "number" || from === "hud-input") {
    x = angleFromDisplay(x, calibrationEditorUi.h2r.unit);
  }
  x = Math.min(hi, Math.max(lo, x));
  state.calibQ[jointName] = x;

  const row = state.calibSliderRows[jointName];
  const prec = live ? 4 : 3;
  if (row) {
    if (from === "slider") {
      row.range.value = String(x);
      row.num.value = formatCalibrationAngle(x, calibrationEditorUi.h2r.unit, prec);
    } else if (from === "number") {
      row.range.value = String(x);
      if (!live) row.num.value = formatCalibrationAngle(x, calibrationEditorUi.h2r.unit, prec);
    } else if (from !== "hud-input") {
      row.range.value = String(x);
      row.num.value = formatCalibrationAngle(x, calibrationEditorUi.h2r.unit, prec);
    }
    const span = hi - lo;
    row.row.classList.toggle("near-limit", span > 0 && (x - lo < span * 0.03 || hi - x < span * 0.03));
  }
  if (from === "hud-input") {
    calibManip.updateHudValue(jointName, x, { live, syncInput: false });
  } else {
    calibManip.updateHudValue(jointName, x, { live });
  }
  if (from === "slider" || from === "number") calibManip.setSelected(jointName);
  markCalibrationEdited("h2r");
  updateH2rCalibrationValidation();
  previewCalibPose({ live });
}

function buildCalibSliders(
  initialQ: Record<string, number>,
  limitsList: RobotJointLimit[] | null,
): void {
  const box = document.getElementById("calib-sliders");
  box.replaceChildren();
  state.calibQ = {};
  state.calibSliderRows = {};
  if (!state.robot) return;

  const limByName: Record<string, RobotJointLimit> = {};
  for (const L of limitsList || []) limByName[L.name] = L;

  const q = initialQ;
  const joints = (limitsList || []).map((L) => L.name)
    .filter(Boolean)
    .concat((state.robot.actuated_joints ?? []).filter((joint) => !limByName[joint]));

  const seen = new Set<string>();
  for (const j of joints) {
    if (seen.has(j)) continue;
    seen.add(j);
    const lim = limByName[j];
    let lo = lim?.lower != null ? lim.lower : -Math.PI;
    let hi = lim?.upper != null ? lim.upper : Math.PI;
    if (hi <= lo) { lo = -Math.PI; hi = Math.PI; }
    let v = q[j] != null ? Number(q[j]) : 0;
    v = Math.min(hi, Math.max(lo, v));
    state.calibQ[j] = v;

    const row = document.createElement("div");
    row.className = "slider-row";
    const region = classifyCalibrationJoint(j);
    row.dataset.region = region;
    const label = textElement("label", "", j);
    label.title = j;
    const range = document.createElement("input");
    range.type = "range";
    range.min = String(lo);
    range.max = String(hi);
    range.step = "0.001";
    range.value = String(v);
    const num = document.createElement("input");
    num.type = "number";
    num.className = "calib-num";
    num.min = String(angleForDisplay(lo, calibrationEditorUi.h2r.unit));
    num.max = String(angleForDisplay(hi, calibrationEditorUi.h2r.unit));
    num.step = calibrationEditorUi.h2r.unit === "deg" ? "0.1" : "0.001";
    num.value = formatCalibrationAngle(v, calibrationEditorUi.h2r.unit);
    row.append(label, range, num);

    state.calibSliderRows[j] = { row, range, num, lo, hi, region };
    const span = hi - lo;
    row.classList.toggle("near-limit", span > 0 && (v - lo < span * 0.03 || hi - v < span * 0.03));
    calibManip.updateHudValue(j, v);

    range.oninput = () => setCalibJointValue(j, range.value, { from: "slider", live: true });
    num.oninput = () => setCalibJointValue(j, num.value, { from: "number", live: true });
    num.onchange = () => setCalibJointValue(j, num.value, { from: "number" });
    num.onkeydown = (ev: KeyboardEvent) => {
      if (ev.key === "Enter") { setCalibJointValue(j, num.value, { from: "number" }); num.blur(); }
    };
    row.onclick = () => {
      calibManip._pickScreen = null;
      calibManip._pickAnchor = null;
      calibManip._hudPinned = null;
      calibManip.setSelected(j);
    };
    box.appendChild(row);
  }
  if (calibrationEditorUi.h2r.comparison === "current") state.calibDraftQ = { ...state.calibQ };
  syncCalibrationNumberInputs("h2r");
  applyCalibrationRowFilter("h2r");
  updateH2rCalibrationValidation();
  previewCalibPose();
}

interface H2rCalibrationFkResult {
  readonly activeRobot: RobotPayload;
  readonly activeMotion: MotionPayload | null;
  readonly reference: string;
  readonly response: ApiPostResponse<"/api/robot/fk_preview">;
}

// One task session belongs to one active calibration lifetime. The owner keeps
// late HTTP settlements outside any calibration session that replaces it.
const h2rCalibrationFkPreview = new CoalescedAsyncFrameTask<
  H2rCalibrationFkResult | null
>({
  scheduler: {
    requestFrame: (callback) => requestAnimationFrame(callback),
    cancelFrame: (handle) => cancelAnimationFrame(handle),
  },
  execute: async () => {
    const activeRobot = state.robot;
    const activeMotion = state.motion;
    const reference = state.reference;
    if (!activeRobot || !reference || !state.calibrationMode) return null;
    const response = await API.post("/api/robot/fk_preview", {
      robot: activeRobot.name,
      joint_q: { ...state.calibQ },
    });
    return { activeRobot, activeMotion, reference, response };
  },
  commit: (result) => {
    if (
      !result
      || !state.calibrationMode
      || state.robot !== result.activeRobot
      || state.motion !== result.activeMotion
      || state.reference !== result.reference
    ) return;

    const { response } = result;
    robot.applyCalibPose(response.link_transforms, response.ground_offset_z);
    refSkel.updateOverlay(robot);
    if (calibManip.active) {
      calibManip.updateJointWorld(response.joint_world);
    }
    updateH2rCalibrationValidation();
    if (state.calibNeedsCameraFocus) {
      state.calibNeedsCameraFocus = false;
      applyCalibOrbitLimits({ snapCamera: true });
      focusRobotView({ resetOffset: true });
    }
  },
  reportError: (error) => {
    console.warn("calib FK preview", errorMessage(error));
  },
});

function previewCalibPose(
  { live = false, flush = false }: CalibrationPreviewOptions = {},
): void {
  if (!state.robot || !state.calibrationMode) return;
  if (flush) h2rCalibrationFkPreview.flush();
  else h2rCalibrationFkPreview.schedule();
}

/**
 * Reconcile the current H2R robot/reference pair with saved calibration. This
 * is orchestration, not a pure render: a missing calibration may open the editor.
 */
async function refreshRetargetPanel(): Promise<void> {
  h2rCalibrationStatusAttempts.invalidate();
  document.getElementById("rt-motion").textContent = state.motion
    ? state.motion.name
    : runtimeText("Not loaded", "未加载");
  document.getElementById("rt-robot").textContent = state.robot
    ? state.robot.display_name
    : runtimeText("Not loaded", "未加载");
  syncRefSelect();
  if (state.calibrationMode) {
    publishH2rWorkflowState();
    return;
  }
  const calCard = document.getElementById("calib-card");
  const btn = document.getElementById("retarget-btn");
  const recal = document.getElementById("recalib-btn");
  recal.disabled = !(state.robot && state.reference);
  if (!state.robot || !state.reference) {
    setCalChip("—", "");
    calCard.style.display = "none";
    btn.disabled = true;
    publishH2rWorkflowState();
    return;
  }

  const statusAttempt = h2rCalibrationStatusAttempts.begin({
    robot: state.robot,
    robotName: state.robot.name,
    robotViewGeneration: robot.loadGeneration,
    motion: state.motion,
    motionToken: state.motion?.token ?? null,
    reference: state.reference,
  });
  const statusIsCurrent = (): boolean => (
    !state.calibrationMode
    && h2rCalibrationStatusAttempts.isCurrent(statusAttempt)
  );
  let calibrationStatus: ApiGetResponse<`/api/calibration/status${string}`>;
  try {
    calibrationStatus = await API.get(h2rCalibrationStatusUrl(statusAttempt.identity));
    if (!statusIsCurrent()) return;
  } catch {
    if (!statusIsCurrent()) return;
    setCalChip(runtimeText("Not calibrated", "未标定"), "warn");
    if (!statusIsCurrent()) return;
    btn.disabled = true;
    if (state.motion) {
      await enterCalibrationMode(null);
      return;
    }
    calCard.style.display = "none";
    if (!statusIsCurrent()) return;
    publishH2rWorkflowState();
    if (statusIsCurrent()) h2rCalibrationStatusAttempts.finish(statusAttempt);
    return;
  }

  state.calibration = calibrationStatus.calibrated;
  if (calibrationStatus.calibrated) {
    setCalChip(
      calibrationStatus.bundled && !calibrationStatus.path
        ? runtimeText("Built-in scale parameters", "内置缩放参数")
        : runtimeText("Calibrated", "已标定"),
      "ok",
    );
    if (!statusIsCurrent()) return;
    calCard.style.display = "none";
    btn.disabled = !state.motion;
    if (state.motion) {
      await refreshScaledPreview();
      if (!statusIsCurrent()) return;
    }
  } else {
    setCalChip(runtimeText(
      "Not calibrated — calibration required",
      "未标定 — 请先标定",
    ), "warn");
    if (!statusIsCurrent()) return;
    btn.disabled = true;
    if (state.motion) {
      await enterCalibrationMode(calibrationStatus.joint_q || null);
      return;
    } else {
      calCard.style.display = "none";
    }
  }
  if (!statusIsCurrent()) return;
  publishH2rWorkflowState();
  if (statusIsCurrent()) h2rCalibrationStatusAttempts.finish(statusAttempt);
}

document.getElementById("rt-ref-select")?.addEventListener("change", (ev) => {
  const val = (ev.currentTarget as HTMLSelectElement).value;
  if (!val) return;
  onReferenceChange(val);
});

document.getElementById("recalib-btn").onclick = async () => {
  const activeRobot = state.robot;
  const activeMotion = state.motion;
  const reference = state.reference;
  if (!activeRobot || !reference || state.calibrationMode) return;
  const statusAttempt = h2rCalibrationStatusAttempts.begin({
    robot: activeRobot,
    robotName: activeRobot.name,
    robotViewGeneration: robot.loadGeneration,
    motion: activeMotion,
    motionToken: activeMotion?.token ?? null,
    reference,
  });
  let jq: Record<string, number> | null = null;
  try {
    const st = await API.get(h2rCalibrationStatusUrl(statusAttempt.identity));
    if (!h2rCalibrationStatusAttempts.isCurrent(statusAttempt)) return;
    jq = st.joint_q || null;
  } catch {
    if (!h2rCalibrationStatusAttempts.isCurrent(statusAttempt)) return;
    // The calibration session can still seed its draft from backend defaults.
  }
  if (
    state.calibrationMode
    || !h2rCalibrationStatusAttempts.isCurrent(statusAttempt)
  ) return;
  await enterCalibrationMode(jq);
};

document.getElementById("calib-zero").onclick = async () => {
  await applyCalibrationComparison("h2r", "zero");
  toast(runtimeText("Reset to the URDF zero pose", "已归零（URDF 零位）"));
};

document.getElementById("calib-restore").onclick = async () => {
  if (!state.calibHasSaved || !state.calibBaselineQ) {
    toast(runtimeText(
      "There is no saved calibration to restore",
      "尚无已保存标定可恢复",
    ), true);
    return;
  }
  await applyCalibrationComparison("h2r", "saved");
  toast(runtimeText(
    "Restored the last saved calibration",
    "已恢复到上次保存的标定",
  ));
};

document.getElementById("calib-cancel").onclick = async () => {
  exitCalibrationMode();
  document.getElementById("calib-card").style.display = "none";
  toast(runtimeText("Calibration cancelled", "已取消标定"));
  refreshRetargetPanel();
};

document.getElementById("calib-save").onclick = async () => {
  if (!state.robot) return;
  try {
    const savedQ = { ...state.calibQ };
    const scope = `${state.robot.display_name} + ${referenceLabel(state.reference)}`;
    const response = await API.post("/api/calibration/save", {
      robot: state.robot.name,
      reference: state.reference,
      joint_q: savedQ,
      motion_token: state.motion?.token || null,
    });
    state.calibBaselineQ = { ...savedQ };
    state.calibHasSaved = true;
    exitCalibrationMode();
    document.getElementById("calib-card").style.display = "none";
    state.calibration = true;
    // Robot still holds the last calibration FK pose until retarget supplies a
    // trajectory; do not resume motion playback with the yellow overlay yet.
    player.setPlaying(false);
    robot.applyStatic();
    withH2rStageDisplayBatch(() => {
      setH2rLayerVisible("scaledSkeleton", false);
      setH2rLayerVisible("scaledEnvironment", false);
    });
    refreshRetargetPanel();
    renderCalibrationSaveSummary("calibration-save-summary", scope, response.path ?? null, savedQ);
    updateH2rCalibrationValidation();
    publishH2rWorkflowState();
    void syncBatchRefHint();
    const changed = Object.values(savedQ).filter((value) => Math.abs(value) > 1e-4).length;
    toast(runtimeText(
      `Calibration saved: ${changed} non-zero joints. Run Retarget before playing the preview.`,
      `标定已保存：${changed} 个非零关节 — 请点击 Retarget 后再播放预览`,
    ));
  } catch (e) { toast(errorMessage(e), true); }
};

type CompletedJob<Result> = Omit<JobResponse, "status" | "result"> & {
  status: "done";
  result: Result;
};

async function pollJob<Result = JobResult>(
  jobId: string,
  onProgress?: (job: JobResponse) => void,
): Promise<CompletedJob<Result>> {
  while (true) {
    const j = await API.get(`/api/job/${jobId}`);
    if (onProgress) onProgress(j);
    if (j.status === "done") {
      if (!j.result) throw new Error(j.error || "job completed without a result");
      return { ...j, status: "done", result: j.result as Result };
    }
    if (j.status === "error") throw new Error(j.error || "job failed");
    await new Promise((r) => setTimeout(r, 700));
  }
}

function setRetargetProgress(
  progressElement: HTMLElement,
  bar: HTMLElement,
  job: JobResponse,
): void {
  const p = job.progress || 0;
  const indet = job.status === "running" && p < 0.1;
  progressElement.classList.toggle("indet", indet);
  if (!indet) {
    bar.style.width = `${Math.max(2, p * 100).toFixed(0)}%`;
  }
}

document.getElementById("retarget-btn").onclick = async () => {
  if (!state.motion || !state.robot) return;
  const retargetRobotName = state.robot.name;
  const retargetMotionToken = state.motion.token;
  const retargetMotionFps = state.motion.framerate;
  const retargetReference = state.reference;
  const prog = document.getElementById("rt-progress");
  const bar = prog.querySelector<HTMLElement>(".bar");
  const status = document.getElementById("rt-status");
  if (!bar) throw new Error("Retarget progress bar is missing");
  prog.style.display = "block";
  prog.classList.add("indet");
  bar.style.width = "0%";
  const firstHint = !state.robot.ik_prewarmed;
  renderSpinnerStatus(
    status,
    firstHint
      ? runtimeText(
        "Retargeting… The first run for a new robot is slower, and progress may pause briefly.",
        "正在 retarget…（新机器人首次较慢，进度条可能短暂不动）",
      )
      : runtimeText("Retargeting…", "正在 retarget…"),
  );
  document.getElementById("retarget-btn").disabled = true;
  h2rRunState = "running";
  clearResultDiagnostics("h2r");
  setRobotPanelLocked(true);
  publishH2rWorkflowState();
  const discardStaleResult = (): boolean => {
    const inputsAreCurrent =
      state.robot?.name === retargetRobotName &&
      state.motion?.token === retargetMotionToken &&
      state.reference === retargetReference;
    if (inputsAreCurrent) return false;
    prog.classList.remove("indet");
    status.textContent = "";
    h2rRunState = "idle";
    toast(runtimeText(
      "Retarget completed, but its motion, robot, or reference changed while it was running. The stale result was discarded; run Retarget again.",
      "Retarget 已完成，但过程中动作、机器人或参考姿态发生了变化。旧结果已丢弃，请重新执行 Retarget。",
    ), true);
    return true;
  };
  try {
    const retargetFps = parseOptionalFps(document.getElementById("rt-retarget-fps"));
    const body: {
      robot: string;
      motion_token: string;
      reference: string | null;
      backend: string;
      foot_clamp_anti_penetration: boolean;
      retarget_fps?: number;
    } = {
      robot: retargetRobotName,
      motion_token: retargetMotionToken,
      reference: retargetReference,
      backend: document.getElementById("rt-backend").value,
      foot_clamp_anti_penetration: false,
    };
    if (retargetFps) body.retarget_fps = retargetFps;
    const { job_id } = await API.post("/api/retarget", body);
    const j = await pollJob<RetargetResult>(job_id, (jp) => {
      setRetargetProgress(prog, bar, jp);
      const msg = jp.message || (firstHint
        ? runtimeText(
          "Compiling the first retarget for this robot. This may take a moment…",
          "新机器人首次 retarget 编译中，请耐心等待…",
        )
        : runtimeText("Retargeting…", "正在 retarget…"));
      renderSpinnerStatus(status, msg);
    });
    if (discardStaleResult()) return;
    prog.classList.remove("indet");
    bar.style.width = "100%";
    const srcFps = j.result.motion_source_fps ?? retargetMotionFps;
    const rtFps = j.result.retarget_fps ?? j.result.source_fps;
    const effectiveRtFps = rtFps ?? 30;
    status.textContent = runtimeText(
      `Completed: ${j.result.num_frames} frames @ ${effectiveRtFps.toFixed(1)} fps`
        + (srcFps && Math.abs(srcFps - effectiveRtFps) > 0.5
          ? ` (source motion ${srcFps.toFixed(1)} fps)`
          : ""),
      `完成：${j.result.num_frames} 帧 @ ${effectiveRtFps.toFixed(1)} fps`
        + (srcFps && Math.abs(srcFps - effectiveRtFps) > 0.5
          ? `（动作原始 ${srcFps.toFixed(1)} fps）`
          : ""),
    );
    if (!j.result.scaled_preview) {
      await refreshScaledPreview();
    }
    if (discardStaleResult()) return;
    withH2rStageDisplayBatch(() => {
      if (state.robot) state.robot.ik_prewarmed = true;
      state.robotTrajectory = j.result.trajectory;
      robot.setTrajectory(j.result.trajectory);
      // Always restart the shared timeline at t=0. Previously we only called
      // `ready` when inactive, so a source scrub could leave the first result
      // playback already near its end.
      player.ready(robot.clipDuration);
      player.refreshFrame();
      if (j.result.scaled_preview) {
        scaledSkel.load(j.result.scaled_preview);
      }
      if (j.result.scaled_scene) {
        scaledEnv.load(j.result.scaled_scene, retargetMotionToken);
        setH2rLayerVisible("scaledEnvironment", true);
      }
      setH2rLayerVisible("sourceSkeleton", true);
      setBodyVisible(true);
      setH2rLayerVisible("scaledSkeleton", true);
      setH2rLayerVisible("targetRobot", true);
      applyH2rComparisonPreset(comparisonPresets.h2r);
    });
    emitResultDiagnostics("h2r", j.result.diagnostics ?? {
      schema_version: 1,
      available: false,
      reason: runtimeText(
        "The current result did not return usable tracking/contact diagnostics.",
        "当前结果未返回可用的 tracking/contact 诊断。",
      ),
    });
    player.setPlaying(true);
    robot.group.getWorldPosition(_camFocus);
    orbit.target.copy(_camFocus);
    _orbitManualUntil = 0;
    state.exportToken = j.result.export_token;
    state.exportSrcFps = j.result.source_fps ?? null;
    state.exportHasScene = Boolean(j.result.has_scene);
    document.getElementById("rt-export-card").style.display = "block";
    const fpsInput = document.getElementById("rt-export-fps");
    fpsInput.value = "";
    const tStartEl = document.getElementById("rt-export-t-start");
    const tEndEl = document.getElementById("rt-export-t-end");
    if (tStartEl) tStartEl.value = "";
    if (tEndEl) tEndEl.value = "";
    const eff = j.result.retarget_fps ?? j.result.source_fps ?? 30;
    fpsInput.placeholder = runtimeText(
      `Blank = ${eff.toFixed(0)} fps (Retarget result)`,
      `留空 = ${eff.toFixed(0)} fps（Retarget 结果）`,
    );
    const clipSrc = j.result.motion_source_fps ?? retargetMotionFps;
    const exportHint = document.createDocumentFragment();
    exportHint.append(
      document.createTextNode(runtimeText("Current cache: ", "当前缓存：")),
      textElement("b", "", `${eff.toFixed(1)} fps`),
      document.createTextNode(runtimeText(
        " (Retarget solve frame rate)",
        "（Retarget 求解帧率）",
      )),
    );
    if (clipSrc && Math.abs(clipSrc - eff) > 0.5) {
      exportHint.append(
        document.createTextNode(runtimeText("; source motion ", "；动作文件原始 ")),
        textElement("b", "", `${clipSrc.toFixed(1)} fps`),
      );
    }
    exportHint.append(
      document.createTextNode(runtimeText(". ", "。")),
      textElement("b", "", runtimeText("Export FPS", "导出 FPS")),
      document.createTextNode(runtimeText(
        " only interpolates the robot trajectory; it does not solve it again.",
        " 仅插值机器人轨迹，不重新求解。",
      )),
    );
    const bundleHint = document.getElementById("rt-export-bundle-hint");
    if (bundleHint) bundleHint.style.display = j.result.has_scene ? "block" : "none";
    if (j.result.has_scene) {
      exportHint.append(document.createTextNode(runtimeText(
        " Results with terrain or objects are packaged as ZIP (data file + OBJ).",
        " 含地形/物体时将打包为 ZIP（数据文件 + OBJ）。",
      )));
    }
    document.getElementById("rt-export-srcfps").replaceChildren(exportHint);
    h2rRunState = "completed";
    publishH2rWorkflowState();
    toast(runtimeText("Retarget complete; ready to export", "Retarget 完成，可导出"));
  } catch (e) {
    status.textContent = "";
    prog.classList.remove("indet");
    h2rRunState = "failed";
    toast(errorMessage(e), true);
  } finally {
    setRobotPanelLocked(false);
    publishH2rWorkflowState();
  }
};
function csvHeaderEnabled(elId: string): boolean {
  const el = document.getElementById(elId) as HTMLInputElement | null;
  return el ? el.checked : true;
}

document.getElementById("rt-export-btn").onclick = async () => {
  if (!state.exportToken) return;
  const fps = parseFloat(document.getElementById("rt-export-fps").value);
  const fmt = document.getElementById("rt-export-format")?.value || "csv";
  let url = `/api/export/${state.exportToken}?fmt=${encodeURIComponent(fmt)}`;
  if (fps && fps > 0) url += `&fps=${fps}`;
  if (!csvHeaderEnabled("rt-csv-header")) url += "&csv_header=0";
  url = appendExportTimeParams(url, "rt-export-t-start", "rt-export-t-end");
  const name = state.exportHasScene || fmt === "pkl"
    ? `${state.motion?.name || "clip"}_export.zip`
    : `${state.motion?.name || "clip"}.csv`;
  try {
    await triggerBrowserDownload(url, name);
    toast(runtimeText(
      "Download started (saved to the browser's default download directory)",
      "已开始下载（保存到浏览器默认下载目录）",
    ));
  } catch (e) { toast(errorMessage(e), true); }
};

// =================================================================  BATCH
let basket: LibraryEntry[] = [];
let batchBasketQuery = "";
let batchBasketCategory: "all" | MotionCategory = "all";
let batchSelectedPaths = new Set<string>();
let batchMissingReferences = new Set<string>();
let batchCompatibilityPending = false;
let batchCompatibilityRevision = 0;
let batchRunning = false;
let lastBatchJobId: string | null = null;
let lastBatchDownloadName: string | null = null;
let lastBatchFailureCount = 0;
let lastBatchResult: BatchRetargetResult | null = null;

function basketEntryKey(entry: LibraryEntry): string {
  return entry.source_path || entry.token || [entry.folder_label, entry.stem].filter(Boolean).join("/");
}

function basketEntryTitle(entry: LibraryEntry): string {
  return entry.stem || entry.sequence_id || entry.display_name || entry.label || entry.name
    || runtimeText("Untitled motion", "未命名动作");
}

function basketEntryContext(entry: LibraryEntry): string {
  const parts = [entry.folder_label, entry.dataset ? datasetLabel(entry.dataset) : ""].filter(Boolean);
  return [...new Set(parts)].join(" · ") || runtimeText("Imported motion", "导入动作");
}

function visibleBasketEntries(): LibraryEntry[] {
  const tokens = batchBasketQuery.toLowerCase().split(/\s+/).filter(Boolean);
  return basket.filter((entry) => {
    const category = normalizedMotionCategory(entry);
    if (batchBasketCategory !== "all" && category !== batchBasketCategory) return false;
    const haystack = [
      basketEntryTitle(entry),
      basketEntryContext(entry),
      category,
      libraryCategoryLabel(category),
      entryReference(entry, "smpl"),
    ].join(" ").toLowerCase();
    return tokens.every((token) => haystack.includes(token));
  });
}

interface BatchReferenceGroup {
  count: number;
  datasets: Set<string>;
}

/**
 * Check calibration once per reference format represented in the basket. The
 * revision guard discards responses started for an older basket/robot choice.
 */
async function syncBatchRefHint(): Promise<void> {
  const revision = ++batchCompatibilityRevision;
  const el = document.getElementById("batch-ref-hint");
  if (!el) return;
  if (!basket.length) {
    batchCompatibilityPending = false;
    batchMissingReferences.clear();
    el.replaceChildren(textElement("p", "batch-compatibility-empty", runtimeText(
      "Add inputs to check calibration compatibility.",
      "添加输入动作后会在这里检查标定兼容性。",
    )));
    updateBatchRunAvailability();
    return;
  }
  const groups = new Map<string, BatchReferenceGroup>();
  for (const e of basket) {
    // The reference must be intrinsic to each entry. Previewing another motion
    // changes state.reference, so using that mutable global would corrupt the batch.
    const ref = entryReference(e, "smpl");
    if (!groups.has(ref)) groups.set(ref, { count: 0, datasets: new Set<string>() });
    const g = groups.get(ref);
    if (!g) continue;
    g.count += 1;
    g.datasets.add(e.dataset || "unknown");
  }

  batchCompatibilityPending = Boolean(state.robot?.name);
  batchMissingReferences.clear();
  updateBatchRunAvailability();

  const checks = await Promise.all([...groups].map(async ([ref, group]) => {
    if (!state.robot?.name) return { ref, group, calibrated: null as boolean | null, unavailable: false };
    try {
      const status = await API.get(
        `/api/calibration/status?robot=${encodeURIComponent(state.robot.name)}`
        + `&reference=${encodeURIComponent(ref)}`,
      );
      return { ref, group, calibrated: Boolean(status.calibrated), unavailable: false };
    } catch {
      return { ref, group, calibrated: false, unavailable: true };
    }
  }));
  if (revision !== batchCompatibilityRevision) return;

  const missing = new Set<string>();
  const blocks = checks.map(({ ref, group, calibrated, unavailable }) => {
    if (calibrated === false) missing.add(ref);
    const block = document.createElement("div");
    block.className = `batch-compatibility-row${calibrated ? " is-ready" : calibrated === false ? " is-missing" : ""}`;

    const copy = document.createElement("div");
    copy.className = "batch-compatibility-copy";
    copy.append(
      textElement("strong", "", referenceLabel(ref)),
      textElement("small", "", runtimeText(
        `${group.count} clips · ${[...group.datasets].map(datasetLabel).join(", ")}`,
        `${group.count} 条 · ${[...group.datasets].map(datasetLabel).join("、")}`,
      )),
    );
    block.appendChild(copy);
    const controls = document.createElement("div");
    controls.className = "batch-compatibility-controls";

    if (calibrated === true) {
      controls.append(textElement("span", "batch-compatibility-status ok", runtimeText("Ready", "已就绪")));
    } else if (calibrated === false) {
      controls.append(textElement(
        "span",
        "batch-compatibility-status warn",
        unavailable ? runtimeText("Check failed", "检查失败") : runtimeText("Calibration needed", "需要标定"),
      ));
      const action = textElement("button", "batch-compatibility-action", runtimeText("Calibrate", "去标定"));
      action.type = "button";
      action.onclick = async () => {
        switchInspectorPanel("h2r");
        await onReferenceChange(ref);
        if (!state.calibrationMode && state.reference === ref) {
          (document.getElementById("recalib-btn") as HTMLButtonElement | null)?.click();
        }
      };
      controls.appendChild(action);
    } else {
      controls.append(textElement("span", "batch-compatibility-status", runtimeText(
        "Select a robot",
        "请选择机器人",
      )));
    }
    block.appendChild(controls);
    return block;
  });
  batchMissingReferences = missing;
  batchCompatibilityPending = false;
  el.replaceChildren(...blocks);
  updateBatchRunAvailability();
}

function updateBatchSelectionState(visible = visibleBasketEntries()): void {
  const visibleKeys = visible.map(basketEntryKey);
  const selectedVisible = visibleKeys.filter((key) => batchSelectedPaths.has(key)).length;
  const selectAll = document.getElementById("batch-select-all") as HTMLInputElement | null;
  if (selectAll) {
    selectAll.checked = Boolean(visibleKeys.length) && selectedVisible === visibleKeys.length;
    selectAll.indeterminate = selectedVisible > 0 && selectedVisible < visibleKeys.length;
    selectAll.disabled = batchRunning || !visibleKeys.length;
  }
  const selectedCount = document.getElementById("batch-selected-count");
  if (selectedCount) selectedCount.textContent = runtimeText(
    `${batchSelectedPaths.size} selected`,
    `已选择 ${batchSelectedPaths.size} 条`,
  );
  const removeSelected = document.getElementById("batch-remove-selected") as HTMLButtonElement | null;
  if (removeSelected) removeSelected.disabled = batchRunning || !batchSelectedPaths.size;
}

function updateBatchSettingsNote(): void {
  const backend = (document.getElementById("batch-backend") as HTMLSelectElement | null)?.value || "newton";
  const format = (document.getElementById("batch-format") as HTMLSelectElement | null)?.value || "pkl";
  const note = document.getElementById("batch-settings-note");
  const batchSizeField = document.getElementById("batch-size-field");
  const csvHeaderRow = document.getElementById("batch-csv-header-row");
  const hasSceneInputs = basket.some((entry) => normalizedMotionCategory(entry) !== "motion");

  if (batchSizeField) batchSizeField.hidden = backend !== "newton";
  if (csvHeaderRow) csvHeaderRow.hidden = format !== "csv";
  if (!note) return;
  const base = backend === "interaction_mesh"
    ? runtimeText("Interaction-Mesh processes clips sequentially.", "Interaction-Mesh 会逐条处理动作。")
    : runtimeText("Newton uses GPU chunks; leave batch size empty for automatic tuning.", "Newton 使用 GPU 分块；批大小留空可自动调节。")
  const recommendation = hasSceneInputs && backend === "newton"
    ? runtimeText(" Scene inputs are present; verify whether Interaction-Mesh is required.", " 清单中包含场景动作，请确认是否应使用 Interaction-Mesh。")
    : "";
  note.textContent = base + recommendation;
  note.classList.toggle("warn", Boolean(recommendation));
}

function updateBatchRunAvailability(): void {
  const runButton = document.getElementById("batch-run") as HTMLButtonElement | null;
  const reason = document.getElementById("batch-disabled-reason");
  const summary = document.getElementById("batch-run-summary");
  if (!runButton || !reason || !summary) return;

  const startInput = document.getElementById("batch-export-t-start") as HTMLInputElement | null;
  const endInput = document.getElementById("batch-export-t-end") as HTMLInputElement | null;
  const start = parseOptionalTime(startInput);
  const end = parseOptionalTime(endInput);
  const invalidStart = Boolean(startInput?.value) && start == null;
  const invalidEnd = Boolean(endInput?.value) && end == null;
  let disabledReason = "";
  if (batchRunning) disabledReason = runtimeText("A batch task is running.", "批量任务正在运行。")
  else if (state.robotPanelLocked) disabledReason = runtimeText(
    "Another retarget task is using the workspace.",
    "另一个重定向任务正在占用工作区。",
  )
  else if (state.calibrationMode) disabledReason = runtimeText(
    "Finish or cancel the current calibration first.",
    "请先保存或取消当前标定。",
  )
  else if (!basket.length) disabledReason = runtimeText("Add at least one motion.", "请至少添加一条动作。")
  else if (!state.robot) disabledReason = runtimeText("Select and load a target robot.", "请选择并加载目标机器人。")
  else if ((document.getElementById("batch-robot-select") as HTMLSelectElement | null)?.value !== state.robot.name) {
    disabledReason = runtimeText("Load the selected target robot.", "请加载当前选择的目标机器人。");
  }
  else if (batchCompatibilityPending) disabledReason = runtimeText("Checking calibration compatibility…", "正在检查标定兼容性……")
  else if (batchMissingReferences.size) disabledReason = runtimeText(
    `Complete calibration for ${[...batchMissingReferences].map(referenceLabel).join(", ")}.`,
    `请先完成 ${[...batchMissingReferences].map(referenceLabel).join("、")} 标定。`,
  )
  else if (invalidStart || invalidEnd) disabledReason = runtimeText(
    "Enter a valid non-negative time range.",
    "请输入有效的非负时间范围。",
  )
  else if (start != null && end != null && start > end) disabledReason = runtimeText(
    "Start time cannot be later than end time.",
    "起始时间不能晚于截止时间。",
  );

  runButton.disabled = Boolean(disabledReason);
  reason.textContent = disabledReason;
  reason.hidden = !disabledReason;
  const target = state.robot?.display_name || runtimeText("no target", "未选择目标");
  const output = ((document.getElementById("batch-out") as HTMLInputElement | null)?.value || "batch_export")
    .replace(/\.zip$/i, "");
  summary.textContent = basket.length
    ? runtimeText(
      `${basket.length} clips → ${target} → ${output}.zip`,
      `${basket.length} 条动作 → ${target} → ${output}.zip`,
    )
    : runtimeText("No inputs selected.", "尚未选择输入动作。");
}

function setBatchDraftLocked(locked: boolean): void {
  batchRunning = locked;
  for (const id of [
    "batch-library-open", "batch-pick-file", "batch-pick-folder", "batch-select-all", "batch-remove-selected",
    "basket-clear", "batch-robot-select", "batch-robot-load", "batch-backend", "batch-format",
    "batch-size", "batch-retarget-fps", "batch-export-fps", "batch-export-t-start",
    "batch-export-t-end", "batch-csv-header", "batch-out",
  ]) {
    const control = document.getElementById(id) as HTMLButtonElement | HTMLInputElement | HTMLSelectElement | null;
    if (control) control.disabled = locked;
  }
  document.getElementById("basket-drop")?.classList.toggle("is-locked", locked);
  renderBasket({ refreshCompatibility: false });
}

function renderBasket({ refreshCompatibility = true }: { refreshCompatibility?: boolean } = {}): void {
  const list = document.getElementById("basket-list");
  if (!list) return;
  list.replaceChildren();
  const currentKeys = new Set(basket.map(basketEntryKey));
  batchSelectedPaths = new Set([...batchSelectedPaths].filter((key) => currentKeys.has(key)));
  const visible = visibleBasketEntries();

  if (!basket.length) {
    const empty = document.createElement("div");
    empty.className = "batch-basket-empty";
    empty.append(
      textElement("strong", "", runtimeText("No motions yet", "还没有动作")),
      textElement("span", "", runtimeText(
        "Add from the Library, import files, or drop a folder here.",
        "可以从资源库添加、导入文件，或把文件夹拖到这里。",
      )),
    );
    list.appendChild(empty);
  } else if (!visible.length) {
    const empty = textElement("div", "batch-basket-empty", runtimeText(
      "No inputs match the current search and filter.",
      "没有符合当前搜索与筛选条件的动作。",
    ));
    list.appendChild(empty);
  }

  for (const entry of visible) {
    const key = basketEntryKey(entry);
    const row = document.createElement("div");
    row.className = `batch-basket-row${batchSelectedPaths.has(key) ? " is-selected" : ""}`;
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = batchSelectedPaths.has(key);
    checkbox.disabled = batchRunning;
    checkbox.setAttribute("aria-label", runtimeText(
      `Select ${basketEntryTitle(entry)}`,
      `选择 ${basketEntryTitle(entry)}`,
    ));
    checkbox.onchange = () => {
      if (checkbox.checked) batchSelectedPaths.add(key);
      else batchSelectedPaths.delete(key);
      row.classList.toggle("is-selected", checkbox.checked);
      updateBatchSelectionState(visible);
    };

    const identity = document.createElement("div");
    identity.className = "batch-basket-copy";
    identity.append(
      textElement("strong", "batch-basket-title", basketEntryTitle(entry)),
      textElement("span", "batch-basket-context", basketEntryContext(entry)),
    );
    const category = normalizedMotionCategory(entry);
    const categoryBadge = textElement("span", "batch-category-tag", libraryCategoryLabel(category));
    categoryBadge.dataset.category = category;
    const reference = textElement("span", "batch-basket-reference", referenceLabel(entryReference(entry, "smpl")));
    const removeButton = textElement("button", "batch-basket-remove", "×");
    removeButton.type = "button";
    removeButton.disabled = batchRunning;
    removeButton.title = runtimeText("Remove from batch", "从批量清单移除");
    removeButton.setAttribute("aria-label", runtimeText(
      `Remove ${basketEntryTitle(entry)} from batch`,
      `从批量清单移除 ${basketEntryTitle(entry)}`,
    ));
    removeButton.onclick = () => {
      basket = basket.filter((candidate) => basketEntryKey(candidate) !== key);
      batchSelectedPaths.delete(key);
      void syncBasket();
    };
    row.append(checkbox, identity, categoryBadge, reference, removeButton);
    list.appendChild(row);
  }

  const count = document.getElementById("basket-count");
  if (count) count.textContent = String(basket.length);
  const inspectorCount = document.getElementById("batch-inspector-count");
  if (inspectorCount) inspectorCount.textContent = String(basket.length);
  const badge = document.getElementById("basket-badge");
  if (badge) {
    badge.textContent = String(basket.length);
    badge.style.display = basket.length ? "inline-block" : "none";
  }
  const clearButton = document.getElementById("basket-clear") as HTMLButtonElement | null;
  if (clearButton) clearButton.disabled = batchRunning || !basket.length;
  updateBatchSelectionState(visible);
  updateBatchSettingsNote();
  updateBatchRunAvailability();
  if (refreshCompatibility) void syncBatchRefHint();
}
async function syncBasket(): Promise<void> {
  renderBasket();
  window.dispatchEvent(new CustomEvent("hhtools:batch-basket-changed"));
}
function addToBasket(
  entries: LibraryEntry[],
  { silent = false }: { silent?: boolean } = {},
): void {
  if (batchRunning) {
    if (!silent) toast(runtimeText(
      "Wait for the current Batch task before changing its inputs.",
      "当前 Batch 任务结束后才能修改输入清单。",
    ), true);
    return;
  }
  let added = 0;
  for (const e of entries) {
    if (!basket.find((x) => basketEntryKey(x) === basketEntryKey(e))) {
      basket.push(e);
      added++;
    }
  }
  renderBasket();
  window.dispatchEvent(new CustomEvent("hhtools:batch-basket-changed"));
  if (!silent) toast(runtimeText(
    `${added} added${entries.length - added ? ` · ${entries.length - added} duplicates skipped` : ""}`,
    `已添加 ${added} 条${entries.length - added ? ` · 跳过 ${entries.length - added} 条重复项` : ""}`,
  ));
}

window.addEventListener("hhtools:batch-filter", (event) => {
  const detail = (event as CustomEvent<{ query?: unknown; category?: unknown }>).detail ?? {};
  batchBasketQuery = typeof detail.query === "string" ? detail.query : "";
  batchBasketCategory = detail.category === "motion" || detail.category === "object" || detail.category === "terrain"
    ? detail.category
    : "all";
  renderBasket({ refreshCompatibility: false });
});

document.getElementById("batch-select-all")?.addEventListener("change", (event) => {
  const checked = (event.currentTarget as HTMLInputElement).checked;
  for (const entry of visibleBasketEntries()) {
    const key = basketEntryKey(entry);
    if (checked) batchSelectedPaths.add(key);
    else batchSelectedPaths.delete(key);
  }
  renderBasket({ refreshCompatibility: false });
});
document.getElementById("batch-remove-selected")?.addEventListener("click", () => {
  basket = basket.filter((entry) => !batchSelectedPaths.has(basketEntryKey(entry)));
  batchSelectedPaths.clear();
  void syncBasket();
});
document.getElementById("basket-clear")?.addEventListener("click", () => {
  basket = [];
  batchSelectedPaths.clear();
  void syncBasket();
});
document.getElementById("batch-pick-file")?.addEventListener("click", async () => {
  await ingestBasketFiles(await pickFiles(), "auto");
});
document.getElementById("batch-pick-folder")?.addEventListener("click", async () => {
  await ingestBasketFiles(await pickFiles({ folder: true }), "auto");
});

async function ingestBasketFiles(files: UploadFile[], profile = "auto"): Promise<void> {
  if (!files || !files.length) return;
  showLoading(runtimeText(
    `Uploading to the session cache… (${files.length} files)`,
    `上传到会话缓存…（${files.length} 个文件）`,
  ));
  try {
    const { job_id } = await uploadFilesXHR(
      "/api/basket/upload",
      files,
      { profile },
      (frac, recv, total) => {
        setLoadingProgress((frac ?? 0) * 0.35, runtimeText(
          `Uploading ${fmtBytes(recv)} / ${fmtBytes(total)}`,
          `上传 ${fmtBytes(recv)} / ${fmtBytes(total)}`,
        ));
      },
    );
    const payload = await waitMotionJob<{ entries: LibraryEntry[] }>(job_id, (frac, sub) => {
      setLoadingProgress(0.35 + frac * 0.65, sub);
    }, { uploadFrac: 0.35 });
    const entries = payload.entries || [];
    if (!entries.length) {
      toast(runtimeText(
        "No retargetable clips were recognized.",
        "未识别到可重定向的 clip。",
      ), true);
      return;
    }
    addToBasket(entries, { silent: true });
    toast(runtimeText(
      `${entries.length} clips cached for this session.`,
      `已缓存 ${entries.length} 个 clip（关闭 Web 后自动清除）`,
    ));
  } catch (e) {
    toast(errorMessage(e), true);
  } finally {
    hideLoading();
  }
}

setupDropzone(document.getElementById("basket-drop"), (files) => {
  if (batchRunning) {
    toast(runtimeText(
      "Wait for the current Batch task before changing its inputs.",
      "当前 Batch 任务结束后才能修改输入清单。",
    ), true);
    return;
  }
  return ingestBasketFiles(files, "auto");
});

for (const id of [
  "batch-backend", "batch-format", "batch-size", "batch-retarget-fps", "batch-export-fps",
  "batch-export-t-start", "batch-export-t-end", "batch-csv-header", "batch-out",
]) {
  document.getElementById(id)?.addEventListener("input", () => {
    updateBatchSettingsNote();
    updateBatchRunAvailability();
  });
  document.getElementById(id)?.addEventListener("change", () => {
    updateBatchSettingsNote();
    updateBatchRunAvailability();
  });
}

const BATCH_STAGE_LABELS: Record<string, { en: string; zh: string }> = {
  load: { en: "Load", zh: "加载" },
  retarget: { en: "Retarget", zh: "重定向" },
  export: { en: "Export", zh: "导出" },
};

function renderBatchFailures(result: BatchRetargetResult | null): void {
  const box = document.getElementById("batch-failures");
  if (!box) return;
  const failures = result?.failures || [];
  if (!failures.length) {
    box.classList.add("hidden");
    box.replaceChildren();
    return;
  }
  box.classList.remove("hidden");
  const heading = textElement("h4", "", runtimeText(
    `Failures (${failures.length})`,
    `失败明细（${failures.length}）`,
  ));
  const list = document.createElement("ul");
  list.className = "batch-fail-list";
  for (const failure of failures) {
    const stageCopy = failure.stage ? BATCH_STAGE_LABELS[failure.stage] : undefined;
    const stage = (stageCopy ? runtimeText(stageCopy.en, stageCopy.zh) : undefined)
      || failure.stage
      || runtimeText("Unknown stage", "未知阶段");
    const item = document.createElement("li");
    item.append(
      textElement("b", "", failure.stem || runtimeText("Untitled clip", "未命名 clip")),
      document.createTextNode(" "),
      textElement("span", "tag", stage),
      textElement("div", "reason", failure.reason || runtimeText("Unknown error", "未知错误")),
    );
    if (failure.log_rel) {
      const logLine = document.createElement("div");
      logLine.className = "sub";
      logLine.append(
        document.createTextNode(runtimeText("Copied → ", "已复制 → ")),
        textElement("code", "", failure.log_rel),
      );
      item.append(logLine);
    } else if (failure.stash_error) {
      item.append(textElement("div", "sub warn", runtimeText(
        `Unable to copy the source file: ${failure.stash_error}`,
        `未能复制源文件：${failure.stash_error}`,
      )));
    }
    list.append(item);
  }
  const children: Node[] = [heading, list];
  const failureLog = result?.failure_log;
  if (failureLog) {
    const hint = document.createElement("p");
    hint.className = "hint";
    hint.append(
      document.createTextNode(runtimeText("Failure data: ", "失败数据目录：")),
      textElement("code", "", failureLog),
      document.createElement("br"),
      document.createTextNode(runtimeText(
        "After fixing the inputs, drop this folder (or a child folder) into the list to retry. See ",
        "修复后可将该文件夹（或其中子目录）拖入上方清单重试；也可打开 ",
      )),
      textElement("code", "", "失败说明.txt"),
      document.createTextNode(" / "),
      textElement("code", "", "failures.json"),
      document.createTextNode(runtimeText(" for details.", " 查看详情。")),
    );
    children.push(hint);
  }
  box.replaceChildren(...children);
}

function renderBatchResultCard(result: BatchRetargetResult | null = lastBatchResult): void {
  const card = document.getElementById("batch-result-card");
  if (!card || !result || !lastBatchJobId) return;
  const successCount = result.written?.length ?? 0;
  const failureCount = result.failures?.length ?? 0;
  const title = document.getElementById("batch-result-title");
  const summary = document.getElementById("batch-result-summary");
  const downloadButton = document.getElementById("batch-result-download") as HTMLButtonElement | null;
  const retryButton = document.getElementById("batch-result-retry") as HTMLButtonElement | null;
  if (title) title.textContent = failureCount
    ? runtimeText("Batch completed with failures", "批量任务完成，但有失败项")
    : runtimeText("Batch complete", "批量任务完成");
  if (summary) summary.textContent = runtimeText(
    `${successCount} succeeded${failureCount ? ` · ${failureCount} failed` : ""}`,
    `${successCount} 条成功${failureCount ? ` · ${failureCount} 条失败` : ""}`,
  );
  if (downloadButton) downloadButton.hidden = !result.download_name;
  if (retryButton) retryButton.hidden = !failureCount;
  card.classList.remove("hidden");
}

function setBatchProgress(
  job: Pick<JobResponse, "status" | "progress" | "clip_progress">,
): void {
  const totalProg = document.getElementById("batch-progress-total");
  const clipProg = document.getElementById("batch-progress-clip");
  if (!totalProg || !clipProg) return;
  const totalBar = totalProg.querySelector<HTMLElement>(".bar");
  const clipBar = clipProg.querySelector<HTMLElement>(".bar");
  if (!totalBar || !clipBar) return;
  const totalP = job.progress || 0;
  const clipP = job.clip_progress ?? 0;
  const totalPercent = Math.max(0, Math.min(100, totalP * 100));
  const clipPercent = Math.max(0, Math.min(100, clipP * 100));
  const totalIndet = job.status === "running" && totalP < 0.01;
  const clipIndet = job.status === "running" && clipP < 0.02 && totalP < 0.99;
  totalProg.classList.toggle("indet", totalIndet);
  clipProg.classList.toggle("indet", clipIndet);
  totalProg.setAttribute("aria-valuenow", totalPercent.toFixed(0));
  clipProg.setAttribute("aria-valuenow", clipPercent.toFixed(0));
  totalProg.setAttribute("aria-valuetext", totalIndet
    ? runtimeText("Starting", "正在启动")
    : `${totalPercent.toFixed(0)}%`);
  clipProg.setAttribute("aria-valuetext", clipIndet
    ? runtimeText("Preparing current chunk", "正在准备当前批次")
    : `${clipPercent.toFixed(0)}%`);
  if (!totalIndet) {
    totalBar.style.width = `${totalPercent.toFixed(0)}%`;
  } else {
    totalBar.style.width = "0%";
  }
  if (!clipIndet) {
    clipBar.style.width = `${clipPercent.toFixed(0)}%`;
  } else {
    clipBar.style.width = "0%";
  }
}

document.getElementById("batch-run").onclick = async () => {
  updateBatchRunAvailability();
  const runButton = document.getElementById("batch-run") as HTMLButtonElement;
  if (!basket.length || !state.robot || runButton.disabled) return;
  const batchRobotName = state.robot.name;
  const progStack = document.getElementById("batch-progress-stack");
  const status = document.getElementById("batch-status");
  const failBox = document.getElementById("batch-failures");
  const resultCard = document.getElementById("batch-result-card");
  if (failBox) {
    failBox.classList.add("hidden");
    failBox.replaceChildren();
  }
  resultCard?.classList.add("hidden");
  lastBatchJobId = null;
  lastBatchDownloadName = null;
  lastBatchFailureCount = 0;
  lastBatchResult = null;
  progStack?.classList.remove("hidden");
  setBatchProgress({ status: "running", progress: 0, clip_progress: 0 });
  renderSpinnerStatus(status, runtimeText("Starting batch task…", "正在启动批量任务……"));
  setBatchDraftLocked(true);
  setRobotPanelLocked(true);
  try {
    const batchBody: {
      robot: string;
      reference: string;
      backend: string;
      out_dir: string;
      format: string;
      csv_header: boolean;
      entries: LibraryEntry[];
      foot_clamp_anti_penetration: boolean;
      batch_size?: number;
      retarget_fps?: number;
      export_fps?: number;
      t_start?: number;
      t_end?: number;
    } = {
      robot: batchRobotName,
      // Each entry carries its own reference. This is only the stable fallback
      // for older entries that have neither reference nor dataset metadata.
      reference: "smpl",
      backend: document.getElementById("batch-backend").value,
      out_dir: document.getElementById("batch-out").value || "batch_export",
      format: document.getElementById("batch-format").value,
      csv_header: csvHeaderEnabled("batch-csv-header"),
      entries: basket,
      foot_clamp_anti_penetration: false,
    };
    const batchSizeRaw = parseInt(document.getElementById("batch-size")?.value, 10);
    if (Number.isFinite(batchSizeRaw) && batchSizeRaw >= 1) {
      batchBody.batch_size = Math.min(256, batchSizeRaw);
    }
    const rtFps = parseOptionalFps(document.getElementById("batch-retarget-fps"));
    const exFps = parseOptionalFps(document.getElementById("batch-export-fps"));
    if (rtFps) batchBody.retarget_fps = rtFps;
    if (exFps) batchBody.export_fps = exFps;
    const t0 = parseOptionalTime(document.getElementById("batch-export-t-start"));
    const t1 = parseOptionalTime(document.getElementById("batch-export-t-end"));
    if (t0 != null) batchBody.t_start = t0;
    if (t1 != null) batchBody.t_end = t1;
    const { job_id } = await API.post("/api/batch/retarget", batchBody);
    lastBatchJobId = job_id;
    window.dispatchEvent(new CustomEvent("hhtools:job-history-command", {
      detail: { command: "refresh" },
    }));
    const j = await pollJob<BatchRetargetResult>(job_id, (jp) => {
      setBatchProgress(jp);
      status.textContent = jp.message || "";
    });
    setBatchProgress({ status: "done", progress: 1, clip_progress: 1 });
    const r = j.result;
    const modeNote = r.solver_mode ? ` · ${r.solver_mode}` : "";
    const partialNote = (r.failures?.length && r.written?.length)
      ? runtimeText(" (ZIP contains successful items only)", "（ZIP 仅含成功项，失败见下方）") : "";
    const successCount = r.written?.length ?? 0;
    const failureCount = r.failures?.length ?? 0;
    lastBatchDownloadName = r.download_name || null;
    lastBatchFailureCount = failureCount;
    lastBatchResult = r;
    status.textContent = runtimeText(`Complete: ${successCount} clips`, `完成：${successCount} 个 clip`) +
      (failureCount ? runtimeText(`, ${failureCount} failed`, `，${failureCount} 个失败`) : "") +
      partialNote +
      modeNote +
      (r.download_name ? runtimeText(` — downloading ${r.download_name}`, ` — 正在下载 ${r.download_name}`) : "");
    renderBatchFailures(r);
    renderBatchResultCard(r);
    if (r.download_name) {
      try {
        await triggerBrowserDownload(`/api/job/${job_id}/download`, r.download_name);
      } catch (e) { toast(errorMessage(e), true); }
    }
    toast(
      runtimeText(
        `Batch complete: ${successCount} succeeded${failureCount ? `, ${failureCount} failed` : ""}`,
        `批量完成：${successCount} 个${failureCount ? `，${failureCount} 失败（见下方明细）` : ""}`,
      ),
      Boolean(failureCount),
    );
    window.dispatchEvent(new CustomEvent("hhtools:job-history-command", {
      detail: { command: "refresh" },
    }));
  } catch (e) {
    status.textContent = runtimeText(
      `Batch failed: ${errorMessage(e)}`,
      `批量任务失败：${errorMessage(e)}`,
    );
    renderBatchFailures(null);
    toast(errorMessage(e), true);
  } finally {
    setBatchDraftLocked(false);
    setRobotPanelLocked(false);
    void syncBatchRefHint();
  }
};

document.getElementById("batch-result-download")?.addEventListener("click", async () => {
  if (!lastBatchJobId || !lastBatchDownloadName) return;
  try {
    await triggerBrowserDownload(`/api/job/${lastBatchJobId}/download`, lastBatchDownloadName);
  } catch (error) {
    toast(errorMessage(error), true);
  }
});

document.getElementById("batch-result-retry")?.addEventListener("click", async () => {
  if (!lastBatchJobId || !lastBatchFailureCount) return;
  try {
    const started = await API.post("/api/jobs/replay", {
      job_id: lastBatchJobId,
      failed_only: true,
    });
    toast(runtimeText(
      `Created failed-item retry task ${started.job_id}`,
      `已创建失败项重试任务 ${started.job_id}`,
    ));
    window.dispatchEvent(new CustomEvent("hhtools:job-history-command", {
      detail: { command: "refresh" },
    }));
  } catch (error) {
    toast(errorMessage(error), true);
  }
});

document.getElementById("batch-result-tasks")?.addEventListener("click", () => {
  (document.querySelector(".job-drawer-summary") as HTMLButtonElement | null)?.click();
  window.dispatchEvent(new CustomEvent("hhtools:job-history-command", {
    detail: { command: "refresh" },
  }));
});

// Wrap every <select> so a CSS chevron can sit outside the native control.
function wrapSelectDropdowns(): void {
  for (const sel of document.querySelectorAll<HTMLSelectElement>("select.search")) {
    if (sel.parentElement?.classList.contains("select-wrap")) continue;
    const wrap = document.createElement("div");
    wrap.className = "select-wrap";
    for (const prop of ["flex", "flexGrow", "flexShrink", "flexBasis", "width"]) {
      const property = prop as keyof CSSStyleDeclaration;
      const value = sel.style[property];
      if (typeof value === "string" && value) {
        Object.assign(wrap.style, { [property]: value });
        Object.assign(sel.style, { [property]: "" });
      }
    }
    sel.parentNode?.insertBefore(wrap, sel);
    wrap.appendChild(sel);
  }
}

// =================================================================  ROBOT-TO-ROBOT (R2R)
// A self-contained module: its own two RobotView instances + state, so it never
// touches the human→robot workflow's `state.robot` / `robot` view. Shared
// player/reference state is snapshotted across panel switches; H2R visibility
// remains live in its requested model and is physically projected on return.
type R2rVisibilityKey =
  | "srcRobot"
  | "srcSkel"
  | "srcEnv"
  | "tgtRobot"
  | "tgtSkel"
  | "tgtEnv";

interface R2rState {
  active: boolean;
  sourceName: string | null;
  sourcePayload: RobotPayload | null;
  targetName: string | null;
  targetPayload: RobotPayload | null;
  sourceToken: string | null;
  sourceStem: string | null;
  resultStem: string | null;
  exportToken: string | null;
  exportHasScene: boolean;
  calibrating: boolean;
  calibrated: boolean;
  calibQ: Record<string, number>;
  calibBaselineQ: Record<string, number> | null;
  calibDraftQ: Record<string, number> | null;
  calibHasSaved: boolean;
  calibLimits: RobotJointLimit[];
  calibRows: Record<string, CalibrationSliderRow>;
  calibNeedsCameraFocus: boolean;
  calibOrbitSaved: OrbitSettingsSnapshot | null;
  hasScene: boolean;
  basket: LibraryEntry[];
  scaledScene: ScenePayload | null;
  tgtScaledScene: ScenePayload | null;
}

interface R2rMainSnapshot {
  refSkel: boolean;
  player: {
    t: number;
    duration: number;
    active: boolean;
    playbarVisible: boolean;
  };
}

interface R2rRetargetRequest {
  target: string;
  source: string;
  source_token: string;
  backend: string;
  retarget_fps?: number;
}

interface R2rBatchRequest {
  target: string;
  source: string;
  entries: LibraryEntry[];
  backend: string;
  out_dir: string;
  format: string;
  csv_header: boolean;
  export_fps?: number;
  retarget_fps?: number;
  source_fps?: number;
  t_start?: number;
  t_end?: number;
}

const r2rSrc = new RobotView({ resourceDisposer: threeResourceDisposer });
world.add(r2rSrc.group);
const r2rTgt = new RobotView({ resourceDisposer: threeResourceDisposer });
world.add(r2rTgt.group);
const r2rSrcSkel = new ScaledSkeletonView(0x60a5fa);
const r2rTgtSkel = new ScaledSkeletonView(0xffb020);
const r2rSrcEnvGroup = new THREE.Group();
world.add(r2rSrcEnvGroup);
const r2rTgtEnvGroup = new THREE.Group();
world.add(r2rTgtEnvGroup);
const r2rSrcEnv = new ScaledEnvView(r2rSrcEnvGroup);
const r2rTgtEnv = new ScaledEnvView(r2rTgtEnvGroup);
const R2R_VIEWS: PlaybackView[] = [
  r2rSrc,
  r2rTgt,
  r2rSrcSkel,
  r2rTgtSkel,
  r2rSrcEnv,
  r2rTgtEnv,
];
ALL_VIEWS.push(...R2R_VIEWS);

const r2r: R2rState = {
  active: false,
  sourceName: null,
  sourcePayload: null,
  targetName: null,
  targetPayload: null,
  sourceToken: null,
  sourceStem: null,
  resultStem: null,
  exportToken: null,
  exportHasScene: false,
  calibrating: false,
  calibrated: false,
  calibQ: {},
  calibBaselineQ: null,
  calibDraftQ: null,
  calibHasSaved: false,
  calibLimits: [],
  calibRows: {},
  calibNeedsCameraFocus: false,
  calibOrbitSaved: null,
  hasScene: false,
  basket: [],
  scaledScene: null,
  tgtScaledScene: null,
};

interface R2rCalibrationIdentity {
  readonly sourceName: string;
  readonly sourcePayload: RobotPayload | null;
  readonly sourceToken: string | null;
  readonly sourceViewGeneration: number;
  readonly targetName: string;
  /** Target payload selected when the attempt began. */
  readonly targetPayload: RobotPayload | null;
  /** Locally resolved fallback accepted only by this attempt. */
  readonly resolvedTargetPayload: RobotPayload | null;
  /** Null while bootstrap itself owns the target load that will reserve it. */
  readonly targetViewGeneration: number | null;
  readonly calibratedBefore: boolean;
  /** Rollback may atomically withdraw a failed target View before cleanup. */
  readonly targetCapabilityWithdrawn: boolean;
}

type R2rCalibrationBootstrapResult = "entered" | "stale" | "failed";
interface R2rCalibrationStatusReceipt {
  readonly attempt: LatestAsyncAttempt<R2rCalibrationIdentity>;
  readonly calibrated: boolean;
}
type R2rCalibrationStatusResult =
  | { readonly kind: "current"; readonly receipt: R2rCalibrationStatusReceipt | null }
  | { readonly kind: "stale"; readonly receipt: null };

function r2rCalibrationIdentityIsCurrent(
  identity: R2rCalibrationIdentity,
): boolean {
  const targetSelectionIsCurrent = (
    r2r.targetPayload === identity.targetPayload
    || (
      identity.resolvedTargetPayload !== null
      && r2r.targetPayload === identity.resolvedTargetPayload
    )
  );
  const targetCapabilityIsCurrent = (
    r2r.targetName === identity.targetName
    && targetSelectionIsCurrent
  ) || (
    identity.targetCapabilityWithdrawn
    && r2r.targetName === null
    && r2r.targetPayload === null
  );
  return (
    r2r.sourceName === identity.sourceName
    && r2r.sourcePayload === identity.sourcePayload
    && r2r.sourceToken === identity.sourceToken
    && r2rSrc.isLoadGenerationCurrent(identity.sourceViewGeneration)
    && targetCapabilityIsCurrent
    && (
      identity.targetViewGeneration === null
      || r2rTgt.isLoadGenerationCurrent(identity.targetViewGeneration)
    )
  );
}

const r2rCalibrationBootstrapAttempts = new LatestAsyncAttemptOwner<
  R2rCalibrationIdentity
>(r2rCalibrationIdentityIsCurrent);

const r2rCalibrationStatusAttempts = new LatestAsyncAttemptOwner<
  R2rCalibrationIdentity
>(r2rCalibrationIdentityIsCurrent);

let r2rCalibrationPendingAttempt: LatestAsyncAttempt<R2rCalibrationIdentity> | null = null;

function beginR2rCalibrationBootstrapAttempt(
  identity: R2rCalibrationIdentity,
): LatestAsyncAttempt<R2rCalibrationIdentity> {
  const attempt = r2rCalibrationBootstrapAttempts.begin(identity);
  r2rCalibrationPendingAttempt = attempt;
  return attempt;
}

/** A stale A cannot clear the pending claim installed by successor B. */
function finishR2rCalibrationBootstrapAttempt(
  attempt: LatestAsyncAttempt<R2rCalibrationIdentity>,
): boolean {
  if (!r2rCalibrationBootstrapAttempts.finish(attempt)) return false;
  if (r2rCalibrationPendingAttempt === attempt) {
    r2rCalibrationPendingAttempt = null;
  }
  return true;
}

function r2rCalibrationBootstrapIsPending(): boolean {
  const attempt = r2rCalibrationPendingAttempt;
  return attempt !== null && r2rCalibrationBootstrapAttempts.isCurrent(attempt);
}

function invalidateR2rCalibrationBootstrapAttempt(): void {
  const claimedAttempt = r2rCalibrationPendingAttempt;
  r2rCalibrationBootstrapAttempts.invalidate();
  if (r2rCalibrationPendingAttempt === claimedAttempt) {
    r2rCalibrationPendingAttempt = null;
  }
}

// A same-pair successor may take over while A is rolling back. Keep the
// shared renderer/session baseline alive until one owner completes teardown.
let r2rCalibrationResourcesOwned = false;
let r2rCalibrationRestoreGroundOffset: number | null = null;

function captureR2rCalibrationIdentity(): R2rCalibrationIdentity | null {
  if (!r2r.sourceName || !r2r.targetName) return null;
  return {
    sourceName: r2r.sourceName,
    sourcePayload: r2r.sourcePayload,
    sourceToken: r2r.sourceToken,
    sourceViewGeneration: r2rSrc.loadGeneration,
    targetName: r2r.targetName,
    targetPayload: r2r.targetPayload,
    resolvedTargetPayload: r2r.targetPayload,
    targetViewGeneration: r2rTgt.loadGeneration,
    calibratedBefore: r2r.calibrated,
    targetCapabilityWithdrawn: false,
  };
}

function invalidateR2rCalibrationAttempts(): void {
  invalidateR2rCalibrationBootstrapAttempt();
  r2rCalibrationStatusAttempts.invalidate();
}

function calibrationRows(workflow: WorkflowId): Record<string, CalibrationSliderRow> {
  return workflow === "h2r" ? state.calibSliderRows : r2r.calibRows;
}

function calibrationQ(workflow: WorkflowId): Record<string, number> {
  return workflow === "h2r" ? state.calibQ : r2r.calibQ;
}

function calibrationActive(workflow: WorkflowId): boolean {
  return workflow === "h2r" ? state.calibrationMode : r2r.calibrating;
}

function calibrationCanUseSaved(workflow: WorkflowId): boolean {
  return workflow === "h2r" ? state.calibHasSaved : r2r.calibHasSaved;
}

function calibrationRobotView(workflow: WorkflowId): RobotView {
  return workflow === "h2r" ? robot : r2rTgt;
}

function emitCalibrationEditorState(workflow: WorkflowId): void {
  const rows = Object.values(calibrationRows(workflow));
  const ui = calibrationEditorUi[workflow];
  const detail: CalibrationEditorStateDetail = {
    workflow,
    active: calibrationActive(workflow),
    totalJoints: rows.length,
    visibleJoints: rows.filter((row) => !row.row.hidden).length,
    mappedLandmarks: refSkel.mappings.length,
    canUseSaved: calibrationCanUseSaved(workflow),
    ...ui,
  };
  window.dispatchEvent(new CustomEvent("hhtools:calibration-editor-state", { detail }));
}

function applyCalibrationRowFilter(workflow: WorkflowId): void {
  const ui = calibrationEditorUi[workflow];
  for (const [joint, row] of Object.entries(calibrationRows(workflow))) {
    row.row.hidden = !calibrationJointMatches(joint, ui.query, ui.region);
  }
  emitCalibrationEditorState(workflow);
}

function syncCalibrationNumberInputs(workflow: WorkflowId): void {
  const unit = calibrationEditorUi[workflow].unit;
  const q = calibrationQ(workflow);
  for (const [joint, row] of Object.entries(calibrationRows(workflow))) {
    row.num.min = String(angleForDisplay(row.lo, unit));
    row.num.max = String(angleForDisplay(row.hi, unit));
    row.num.step = unit === "deg" ? "0.1" : "0.001";
    row.num.value = formatCalibrationAngle(q[joint] ?? 0, unit);
    row.num.title = unit === "deg"
      ? runtimeText("Angle (degrees); stored internally in radians", "角度（度）；内部仍以弧度保存")
      : runtimeText("Angle (radians)", "角度（弧度）");
  }
  calibManip.setAngleUnit(unit);
}

function applyCalibrationVisualization(workflow: WorkflowId): void {
  if (!calibrationActive(workflow)) return;
  const ui = calibrationEditorUi[workflow];
  refSkel.setDisplayOptions({
    mappedOnly: ui.mappedOnly,
    labels: ui.labels,
    mappingLines: ui.mappingLines,
    sourceOpacity: ui.sourceOpacity,
  });
  const robotView = calibrationRobotView(workflow);
  robotView.setOpacity(ui.robotOpacity);
  refSkel.updateOverlay(robotView);
  emitCalibrationEditorState(workflow);
}

function markCalibrationEdited(workflow: WorkflowId): void {
  const ui = calibrationEditorUi[workflow];
  ui.comparison = "current";
  if (workflow === "h2r") state.calibDraftQ = { ...state.calibQ };
  else r2r.calibDraftQ = { ...r2r.calibQ };
  emitCalibrationEditorState(workflow);
}

async function applyCalibrationComparison(
  workflow: WorkflowId,
  comparison: CalibrationComparisonMode,
): Promise<void> {
  const ui = calibrationEditorUi[workflow];
  if (ui.comparison === "current") {
    if (workflow === "h2r") state.calibDraftQ = { ...state.calibQ };
    else r2r.calibDraftQ = { ...r2r.calibQ };
  }

  const current = calibrationQ(workflow);
  let target: Record<string, number> | null = null;
  if (comparison === "zero") {
    target = Object.fromEntries(Object.keys(current).map((joint) => [joint, 0]));
  } else if (comparison === "saved") {
    target = workflow === "h2r" ? state.calibBaselineQ : r2r.calibBaselineQ;
    if (!target) {
      toast(runtimeText(
        "There is no saved calibration available for comparison",
        "尚无已保存标定可用于对照",
      ), true);
      return;
    }
  } else {
    target = workflow === "h2r" ? state.calibDraftQ : r2r.calibDraftQ;
  }
  if (!target) target = { ...current };

  ui.comparison = comparison;
  if (workflow === "h2r") buildCalibSliders({ ...target }, state.calibLimits);
  else r2rBuildSliders({ ...target }, r2r.calibLimits);
  emitCalibrationEditorState(workflow);
}

async function resetCalibrationRegion(workflow: WorkflowId): Promise<void> {
  const ui = calibrationEditorUi[workflow];
  const next = { ...calibrationQ(workflow) };
  let changed = 0;
  for (const joint of Object.keys(next)) {
    if (!calibrationJointMatches(joint, "", ui.region)) continue;
    if (Math.abs(next[joint]) > 1e-9) changed++;
    next[joint] = 0;
  }
  ui.comparison = "current";
  if (workflow === "h2r") {
    state.calibDraftQ = { ...next };
    buildCalibSliders(next, state.calibLimits);
  } else {
    r2r.calibDraftQ = { ...next };
    r2rBuildSliders(next, r2r.calibLimits);
  }
  toast(changed > 0
    ? runtimeText(
      `Reset ${changed} joints in the current region`,
      `当前关节分组已归零：${changed} 个关节`,
    )
    : runtimeText("The current region is already at zero", "当前分组已经是零位"));
}

function calibrationCommandValue<T extends string>(detail: CalibrationEditorCommandDetail): T {
  return String(detail.value ?? "") as T;
}

async function handleCalibrationEditorCommand(
  event: WindowEventMap["hhtools:calibration-editor-command"],
): Promise<void> {
  const { workflow, command, value } = event.detail;
  if (!calibrationActive(workflow)) return;
  const ui = calibrationEditorUi[workflow];
  if (command === "search") ui.query = String(value ?? "");
  else if (command === "region") ui.region = calibrationCommandValue(event.detail);
  else if (command === "unit") {
    ui.unit = calibrationCommandValue(event.detail);
    syncCalibrationNumberInputs(workflow);
  } else if (command === "comparison") {
    await applyCalibrationComparison(workflow, calibrationCommandValue(event.detail));
    return;
  } else if (command === "reset-region") {
    await resetCalibrationRegion(workflow);
    return;
  } else if (command === "mapped-only") ui.mappedOnly = Boolean(value);
  else if (command === "labels") ui.labels = Boolean(value);
  else if (command === "mapping-lines") ui.mappingLines = Boolean(value);
  else if (command === "source-opacity") ui.sourceOpacity = Number(value);
  else if (command === "robot-opacity") ui.robotOpacity = Number(value);

  if (command === "search" || command === "region") applyCalibrationRowFilter(workflow);
  else if (["mapped-only", "labels", "mapping-lines", "source-opacity", "robot-opacity"].includes(command)) {
    applyCalibrationVisualization(workflow);
  } else {
    emitCalibrationEditorState(workflow);
  }
}

function renderCalibrationSaveSummary(
  elementId: string,
  scope: string,
  path: string | null,
  q: Record<string, number>,
): void {
  const element = document.getElementById(elementId);
  if (!element) return;
  const changed = Object.values(q).filter((value) => Math.abs(value) > 1e-4).length;
  const mapped = refSkel.mappings.length;
  element.textContent = [
    runtimeText(`Saved: ${scope}`, `已保存：${scope}`),
    runtimeText(
      `${changed} non-zero joints, ${mapped} mapped effectors`,
      `${changed} 个非零关节，${mapped} 个映射效应器`,
    ),
    path ? runtimeText(`File: ${path}`, `文件：${path}`) : "",
  ].filter(Boolean).join(" · ");
  element.classList.add("visible");
}

function calibrationDiagnosticRows(
  robotView: RobotView,
): Array<readonly [ValidationTone, string]> {
  const diagnostics = refSkel.alignmentDiagnostics(robotView);
  if (diagnostics.length === 0) return [];

  const mean = (values: number[]): number => (
    values.reduce((total, value) => total + value, 0) / Math.max(1, values.length)
  );
  const rows: Array<readonly [ValidationTone, string]> = [];
  const positionCm = mean(diagnostics.map((item) => item.positionResidualM)) * 100;
  rows.push(["ok", runtimeText(
    `Mapped position residual (diagnostic): mean ${positionCm.toFixed(1)} cm`,
    `映射位置残差（诊断值）：平均 ${positionCm.toFixed(1)} cm`,
  )]);

  const rotations = diagnostics
    .map((item) => item.rotationResidualDeg)
    .filter((value): value is number => value != null && Number.isFinite(value));
  if (rotations.length > 0) {
    rows.push(["ok", runtimeText(
      `Mapped rotation residual (diagnostic): mean ${mean(rotations).toFixed(1)}°`,
      `映射旋转残差（诊断值）：平均 ${mean(rotations).toFixed(1)}°`,
    )]);
  }

  const bySemantic = new Map(
    diagnostics.map((item) => [normalizedSemanticName(item.semantic), item]),
  );
  const sideDifferences: number[] = [];
  for (const [semantic, item] of bySemantic) {
    if (!semantic.startsWith("left")) continue;
    const counterpart = bySemantic.get(`right${semantic.slice(4)}`);
    if (counterpart) {
      sideDifferences.push(Math.abs(item.positionResidualM - counterpart.positionResidualM));
    }
  }
  if (sideDifferences.length > 0) {
    const asymmetryCm = mean(sideDifferences) * 100;
    rows.push([asymmetryCm <= 8 ? "ok" : "warn", runtimeText(
      `Left/right mapping difference: mean ${asymmetryCm.toFixed(1)} cm`,
      `左右映射差异：平均 ${asymmetryCm.toFixed(1)} cm`,
    )]);
  }

  const feet = diagnostics.filter((item) => {
    const semantic = normalizedSemanticName(item.semantic);
    return semantic.includes("ankle") || semantic.includes("foot");
  });
  if (feet.length > 0) {
    const groundCm = mean(feet.map((item) => item.verticalResidualM)) * 100;
    rows.push([groundCm <= 8 ? "ok" : "warn", runtimeText(
      `Foot height difference: mean ${groundCm.toFixed(1)} cm`,
      `脚部高度差：平均 ${groundCm.toFixed(1)} cm`,
    )]);
  }

  const heading = refSkel.headingResidualDeg(robotView);
  if (heading != null) {
    rows.push([heading <= 15 ? "ok" : "warn", runtimeText(
      `Torso heading difference: ${heading.toFixed(1)}°`,
      `躯干朝向差：${heading.toFixed(1)}°`,
    )]);
  } else {
    rows.push(["warn", runtimeText(
      "Torso heading difference: no usable left/right shoulder or hip mapping baseline",
      "躯干朝向差：缺少可用的左右肩 / 髋映射基线",
    )]);
  }
  return rows;
}

let r2rRunState: WorkflowRunState = "idle";
let r2rTrajectoryState: "idle" | "validating" | "failed" = "idle";

function r2rBlockedReason(): string | null {
  if (!r2r.sourceName) return runtimeText(
    "Source robot is missing. Load the robot model associated with the trajectory first.",
    "缺少源机器人：请先加载轨迹所属的 Robot Model。",
  );
  if (!r2r.sourceToken) return runtimeText(
    "Source robot trajectory is missing. Upload a CSV, PKL, or NPZ trajectory.",
    "缺少源 Robot Trajectory：请上传 CSV、PKL 或 NPZ 轨迹。",
  );
  if (!r2r.targetName) return runtimeText(
    "Target robot is missing. Select the robot model that should receive the motion.",
    "缺少目标机器人：请选择要接收动作的 Robot Model。",
  );
  if (!r2r.calibrated) {
    const target = r2r.targetPayload?.display_name || r2r.targetName;
    const source = r2r.sourcePayload?.display_name || r2r.sourceName;
    return runtimeText(
      `R2R calibration is missing for ${target} + ${source}.`,
      `缺少 ${target} + ${source} R2R 标定配置。`,
    );
  }
  if (r2rRunState === "running") return runtimeText(
    "R2R retarget is running. Wait for the current task to finish.",
    "R2R Retarget 正在运行，请等待当前任务完成。",
  );
  return null;
}

function publishR2rWorkflowState(): void {
  const blockedReason = r2rBlockedReason();
  const trajectoryState: WorkflowNodeState = r2rTrajectoryState === "validating"
    ? "validating"
    : r2rTrajectoryState === "failed"
      ? "failed"
      : r2r.sourceToken
        ? "ready"
        : "missing";
  const calibrationState: WorkflowNodeState = r2r.calibrating
    ? "running"
    : r2r.calibrated
      ? "ready"
      : r2r.sourceName && r2r.targetName
        ? "warning"
        : "missing";
  const resultState: WorkflowNodeState = r2r.exportToken
    ? "completed"
    : r2rRunState === "running"
      ? "running"
      : r2rRunState === "failed"
        ? "failed"
        : "missing";

  const nodes: WorkflowNodeStatus[] = [
    workflowNode(
      "source",
      runtimeText("Source robot", "源机器人"),
      r2r.sourceName ? "ready" : "missing",
      r2r.sourcePayload?.display_name || r2r.sourceName || runtimeText("Not selected", "未选择"),
      "r2r",
    ),
    workflowNode(
      "trajectory",
      runtimeText("Source trajectory", "源轨迹"),
      trajectoryState,
      r2rTrajectoryState === "validating"
        ? runtimeText("Validating", "正在验证")
        : r2r.sourceToken
          ? r2r.sourceStem || runtimeText("Loaded", "已加载")
          : r2rTrajectoryState === "failed"
            ? runtimeText("Validation failed", "验证失败")
            : runtimeText("Not uploaded", "未上传"),
      "r2r",
    ),
    workflowNode(
      "target",
      runtimeText("Target robot", "目标机器人"),
      r2r.targetName ? "ready" : "missing",
      r2r.targetPayload?.display_name || r2r.targetName || runtimeText("Not selected", "未选择"),
      "r2r",
    ),
    workflowNode(
      "calibration",
      runtimeText("Calibration", "标定"),
      calibrationState,
      r2r.calibrating
        ? runtimeText("Editing", "正在编辑")
        : r2r.calibrated
          ? runtimeText("Matched", "已匹配")
          : runtimeText("Not ready", "未就绪"),
      "r2r",
    ),
    workflowNode(
      "result",
      runtimeText("Result", "结果"),
      resultState,
      r2r.exportToken
        ? runtimeText("Ready to preview/export", "可预览/导出")
        : r2rRunState === "running"
          ? runtimeText("Solving", "求解中")
          : r2rRunState === "failed"
            ? runtimeText("Run failed", "运行失败")
            : blockedReason == null
              ? runtimeText("Ready to run", "可以运行")
              : runtimeText("No result yet", "尚无结果"),
      "r2r",
    ),
  ];

  const runButton = document.getElementById("r2r-retarget-btn");
  if (runButton) runButton.disabled = blockedReason != null;
  const reason = document.getElementById("r2r-disabled-reason");
  if (reason) reason.textContent = blockedReason || "";
  emitWorkflowState({ workflow: "r2r", nodes, blockedReason });
  updateR2rCalibrationValidation();
}

function updateR2rCalibrationValidation(): void {
  const scope = document.getElementById("r2r-calibration-scope");
  if (scope) {
    const target = r2r.targetPayload?.display_name || r2r.targetName;
    const source = r2r.sourcePayload?.display_name || r2r.sourceName;
    scope.textContent = target && source
      ? runtimeText(`Scope: ${target} + ${source}`, `配置范围：${target} + ${source}`)
      : runtimeText(
        "Scope: target robot + source robot",
        "配置范围：目标机器人 + 源机器人",
      );
  }

  const container = document.getElementById("r2r-calibration-validation-summary");
  if (!r2r.sourceName && !r2r.targetName) {
    renderValidationSummary(container, []);
    return;
  }

  const limits = new Map(r2r.calibLimits.map((limit) => [limit.name, limit]));
  const nearLimit = Object.entries(r2r.calibQ).filter(([joint, value]) => {
    const limit = limits.get(joint);
    if (limit?.lower == null || limit.upper == null || limit.upper <= limit.lower) return false;
    const span = limit.upper - limit.lower;
    return value - limit.lower < span * 0.03 || limit.upper - value < span * 0.03;
  });
  const changed = Object.values(r2r.calibQ).filter((value) => Math.abs(value) > 1e-4).length;

  renderValidationSummary(container, [
    [r2r.sourceName ? "ok" : "warn", r2r.sourceName
      ? runtimeText(
        `Source robot: ${r2r.sourcePayload?.display_name || r2r.sourceName}`,
        `源机器人：${r2r.sourcePayload?.display_name || r2r.sourceName}`,
      )
      : runtimeText("No source robot selected", "尚未选择源机器人")],
    [r2r.targetName ? "ok" : "warn", r2r.targetName
      ? runtimeText(
        `Target robot: ${r2r.targetPayload?.display_name || r2r.targetName}`,
        `目标机器人：${r2r.targetPayload?.display_name || r2r.targetName}`,
      )
      : runtimeText("No target robot selected", "尚未选择目标机器人")],
    [r2r.calibLimits.length > 0 ? "ok" : "warn", r2r.calibLimits.length > 0
      ? runtimeText(
        `Editable joints: ${r2r.calibLimits.length}`,
        `可编辑关节：${r2r.calibLimits.length} 个`,
      )
      : runtimeText(
        "Enter calibration to view target-robot joint diagnostics",
        "进入标定后显示目标机器人关节诊断",
      )],
    [nearLimit.length === 0 ? "ok" : "warn", nearLimit.length === 0
      ? runtimeText(
        `Current edit: ${changed} non-zero joints; none are near their limits`,
        `当前编辑：${changed} 个非零关节，均未接近限位`,
      )
      : runtimeText(
        `${nearLimit.length} joints are near their URDF limits`,
        `${nearLimit.length} 个关节接近 URDF 限位`,
      )],
    ...calibrationDiagnosticRows(r2rTgt),
  ]);
}
const r2rVis: Record<R2rVisibilityKey, boolean> = {
  srcRobot: true,
  srcSkel: false,
  srcEnv: false,
  tgtRobot: false,
  tgtSkel: false,
  tgtEnv: false,
};

let _r2rMainSnap: R2rMainSnapshot | null = null;
const _r2rVec = new THREE.Vector3();

function r2rFocus(view: PlaybackView): void {
  try {
    view.group.getWorldPosition(_r2rVec);
    orbit.target.copy(_r2rVec);
  } catch { /* ignore */ }
}

function r2rSetToggle(btnId: string, on: boolean): void {
  const btn = document.getElementById(btnId);
  if (btn) btn.classList.toggle("on", !!on);
}

function r2rSyncPlayerDuration(): void {
  let dur = 0.1;
  for (const v of R2R_VIEWS) {
    if (v.numFrames > 0) {
      dur = Math.max(dur, v.clipDuration || (v.numFrames / 30));
    }
  }
  player.duration = dur;
  if (player.active) player.refreshFrame();
}

function r2rSceneGlbUrl(
  token: string | null | undefined,
  o: SceneObjectPayload,
): string | null {
  const mesh = o.mesh_file || "";
  if (!token || !mesh) return null;
  let url =
    `/api/r2r/scene_glb?token=${encodeURIComponent(token)}&mesh=${encodeURIComponent(mesh)}`;
  if (o.scale != null && Number.isFinite(o.scale)) {
    url += `&scale=${encodeURIComponent(o.scale)}`;
  }
  return url;
}

function r2rLoadSrcScene(
  scene: ScenePayload | null | undefined,
  token: string | null | undefined,
  duration: number,
): void {
  if (!scene) {
    r2rSrcEnv.clear();
    r2r.scaledScene = null;
    document.getElementById("r2r-tg-src-env")?.setAttribute("disabled", "");
    return;
  }
  r2r.scaledScene = scene;
  r2rSrcEnv.load(scene, token, {
    duration,
    objectGlbUrl: (o) => r2rSceneGlbUrl(token, o),
  });
  const envBtn = document.getElementById("r2r-tg-src-env");
  if (envBtn) envBtn.disabled = false;
}

function r2rLoadTgtScene(
  scene: ScenePayload | null | undefined,
  token: string | null | undefined,
  duration: number,
): void {
  if (!scene) {
    r2rTgtEnv.clear();
    r2r.tgtScaledScene = null;
    document.getElementById("r2r-tg-tgt-env")?.setAttribute("disabled", "");
    return;
  }
  r2r.tgtScaledScene = scene;
  r2rTgtEnv.load(scene, token, {
    duration,
    objectGlbUrl: (o) => r2rSceneGlbUrl(token, o),
  });
  const envBtn = document.getElementById("r2r-tg-tgt-env");
  if (envBtn) envBtn.disabled = false;
}

/** Read the same R2R resource facts used by rendering and presentation. */
function collectR2rStageSurfaceFacts(): R2rStageSurfaceFacts {
  return {
    calibrating: r2r.calibrating,
    // A trajectory cannot render without robot geometry. Read the group so a
    // cleared view cannot stay available through RobotView's cached metadata.
    sourceRobotAvailable: r2rSrc.group.children.length > 0,
    targetRobotAvailable: r2rTgt.group.children.length > 0,
    sourceSkeletonAvailable: r2rSrcSkel.numFrames > 0,
    targetSkeletonAvailable: r2rTgtSkel.numFrames > 0,
    sourceEnvironmentAvailable:
      r2rSrcEnv.numFrames > 0 || Boolean(r2r.scaledScene?.terrain),
    targetEnvironmentAvailable:
      r2rTgtEnv.numFrames > 0 || Boolean(r2r.tgtScaledScene?.terrain),
    referenceAvailable: refSkel.spheres.length > 0,
  };
}

function collectR2rStageSurface(): R2rStageSurfaceSnapshot {
  return projectR2rStageSurface(collectR2rStageSurfaceFacts());
}

interface R2rStageApplyOptions {
  /** Suppress the transient R2R snapshot during synchronous H2R hand-back. */
  readonly publishStageDisplay?: boolean;
}

/**
 * Sole authority for R2R stage visibility: hide H2R views while R2R owns the
 * shared canvas, then project the workflow's visibility model onto its views.
 */
function r2rApplyStage(
  { publishStageDisplay = true }: R2rStageApplyOptions = {},
): void {
  if (!r2r.active) {
    r2rSrc.group.visible = false;
    r2rTgt.group.visible = false;
    r2rSrcSkel.group.visible = false;
    r2rTgtSkel.group.visible = false;
    r2rSrcEnv.group.visible = false;
    r2rTgtEnv.group.visible = false;
    if (publishStageDisplay) markH2rStageDisplayChanged();
    return;
  }
  // R2R may re-project after any of its own resource changes. Re-assert the
  // H2R ownership boundary every time without mutating H2R's logical intents.
  applyH2rPhysicalVisibility();
  if (r2r.calibrating) {
    const facts = collectR2rStageSurfaceFacts();
    r2rSrc.group.visible = false;
    r2rSrcSkel.group.visible = false;
    r2rSrcEnv.group.visible = false;
    r2rTgtSkel.group.visible = false;
    r2rTgtEnv.group.visible = false;
    r2rTgt.group.visible = facts.targetRobotAvailable;
    refSkel.group.visible = facts.referenceAvailable;
    player.active = false;
    _setPlaybarVisible(false);
    player.setPlaying(false);
    if (publishStageDisplay) markH2rStageDisplayChanged();
    return;
  }
  refSkel.group.visible = false;
  const facts = collectR2rStageSurfaceFacts();
  const surface = projectR2rStageSurface(facts);
  const hasSrc = facts.sourceRobotAvailable;
  const hasTgt = facts.targetRobotAvailable;
  const hasSrcSk = facts.sourceSkeletonAvailable;
  const hasTgtSk = facts.targetSkeletonAvailable;
  const hasSrcEnv = facts.sourceEnvironmentAvailable;
  const hasTgtEnv = facts.targetEnvironmentAvailable;
  r2rSrc.group.visible = r2rVis.srcRobot && hasSrc;
  r2rSrcSkel.group.visible = r2rVis.srcSkel && hasSrcSk;
  r2rSrcEnv.group.visible = r2rVis.srcEnv && hasSrcEnv;
  r2rTgt.group.visible = r2rVis.tgtRobot && hasTgt;
  r2rTgtSkel.group.visible = r2rVis.tgtSkel && hasTgtSk;
  r2rTgtEnv.group.visible = r2rVis.tgtEnv && hasTgtEnv;
  r2rSetToggle("r2r-tg-src-robot", r2rSrc.group.visible);
  r2rSetToggle("r2r-tg-src-skel", r2rSrcSkel.group.visible);
  r2rSetToggle("r2r-tg-src-env", r2rSrcEnv.group.visible);
  r2rSetToggle("r2r-tg-tgt-robot", r2rTgt.group.visible);
  r2rSetToggle("r2r-tg-tgt-skel", r2rTgtSkel.group.visible);
  r2rSetToggle("r2r-tg-tgt-env", r2rTgtEnv.group.visible);
  if (!surface.empty) {
    player.active = true;
    revealStage();
    _setPlaybarVisible(true);
    r2rSyncPlayerDuration();
    player.refreshFrame();
  } else {
    // Entering an empty R2R workspace must not inherit playback from the main workflow.
    player.active = false;
    player.setPlaying(false);
    _setPlaybarVisible(false);
  }
  if (publishStageDisplay) markH2rStageDisplayChanged();
}

/** Apply a repeatable R2R visibility preset using the workflow's isolated views. */
function applyR2rComparisonPreset(preset: ComparisonPreset): void {
  comparisonPresets.r2r = preset;
  r2rVis.srcRobot = preset === "source" || preset === "overlay";
  r2rVis.srcSkel = false;
  r2rVis.srcEnv = preset === "source";
  r2rVis.tgtRobot = preset === "result" || preset === "overlay";
  r2rVis.tgtSkel = preset === "target" || preset === "overlay";
  r2rVis.tgtEnv = preset !== "source";
  r2rApplyStage();
  emitComparisonState("r2r");
}

const comparisonPresetIds = new Set<ComparisonPreset>([
  "source",
  "target",
  "result",
  "overlay",
]);

window.addEventListener("hhtools:comparison-command", (event) => {
  const { workflow, preset } = event.detail;
  if (!comparisonPresetIds.has(preset)) return;
  comparisonPresets[workflow] = preset;
  updateWorkspacePreferences({ comparisonPresets: { [workflow]: preset } });
  if (workflow === "h2r") applyH2rComparisonPreset(preset);
  else applyR2rComparisonPreset(preset);
});

/**
 * Transfer the shared canvas/player from H2R to R2R. Shared player/reference
 * state is snapshotted; H2R visibility intent remains live while physically hidden.
 */
function r2rEnterPanel(): void {
  if (r2r.active) {
    h2rOwnsStage = false;
    applyH2rPhysicalVisibility();
    r2rApplyStage();
    return;
  }
  // Capture shared non-visibility state before transferring canvas ownership.
  // H2R visibility stays live in `h2rRequestedVisibility`, so it is projected
  // from the newest intent on return instead of restored from a stale snapshot.
  _r2rMainSnap = {
    refSkel: refSkel.group.visible,
    player: {
      t: player.t,
      duration: player.duration,
      active: player.active,
      playbarVisible,
    },
  };
  r2r.active = true;
  h2rOwnsStage = false;
  applyH2rPhysicalVisibility();
  player.setPlaying(false);
  r2rApplyStage();
  void r2rUpdateRetargetBtn();
}

function r2rLeavePanel(): void {
  if (!r2r.active) return;
  // Leaving owns teardown even when bootstrap has not reached `calibrating` yet.
  invalidateR2rCalibrationAttempts();
  r2rCalibrationFkPreview.stop();
  r2r.active = false;
  if (
    r2r.calibrating
    || r2rCalibrationResourcesOwned
    || r2r.calibOrbitSaved !== null
  ) {
    r2rExitCalib({ publishStageDisplay: false });
  }
  r2rApplyStage({ publishStageDisplay: false });
  const s = _r2rMainSnap;
  _r2rMainSnap = null;
  if (s) {
    refSkel.group.visible = s.refSkel;
    player.t = s.player.t;
    player.duration = s.player.duration;
    player.active = s.player.active;
    player.setPlaying(false);
    _setPlaybarVisible(s.player.playbarVisible);
  } else {
    refSkel.group.visible = false;
  }
  // Re-open H2R capabilities only after its renderer snapshot has been
  // restored. React derives HUD ownership from the final publication.
  h2rOwnsStage = true;
  applyH2rPhysicalVisibility();
  if (player.active) player.refreshFrame();
  markH2rStageDisplayChanged();
}

// Hook panel switching so the R2R stage is shown/hidden with its tab.
inspectorPanelSwitchHook = (panelId: string): void => {
  const leaving = r2r.active && panelId !== "r2r";
  if (panelId === "r2r") r2rEnterPanel();
  else if (leaving) r2rLeavePanel();
};

function r2rSetCalChip(text: unknown, cls = ""): void {
  const el = document.getElementById("r2r-cal");
  if (!el) return;
  renderStatusChip(el, text, cls);
}

async function r2rUpdateRetargetBtn(): Promise<R2rCalibrationStatusResult> {
  const calBtn = document.getElementById("r2r-calib-btn");
  const rtBtn = document.getElementById("r2r-retarget-btn");
  if (calBtn) calBtn.disabled = !(r2r.targetName && r2r.sourceName);
  if (r2r.calibrating || r2rCalibrationBootstrapIsPending()) {
    r2rCalibrationStatusAttempts.invalidate();
    if (rtBtn) rtBtn.disabled = true;
    publishR2rWorkflowState();
    return { kind: "current", receipt: null };
  }

  const identity = captureR2rCalibrationIdentity();
  if (!identity) {
    r2rCalibrationStatusAttempts.invalidate();
    r2r.calibrated = false;
    r2rSetCalChip("—", "");
    const batchCalibrationStatus = document.getElementById("r2r-batch-calibration-status");
    if (batchCalibrationStatus) batchCalibrationStatus.textContent = "";
    if (rtBtn) rtBtn.disabled = true;
    r2rRenderBasket();
    publishR2rWorkflowState();
    return { kind: "current", receipt: null };
  }

  const statusAttempt = r2rCalibrationStatusAttempts.begin(identity);
  const statusIsCurrent = (): boolean => (
    !r2r.calibrating
    && !r2rCalibrationBootstrapIsPending()
    && r2rCalibrationStatusAttempts.isCurrent(statusAttempt)
  );
  let calibrated = false;
  try {
    const st = await API.get(
      `/api/r2r/calibration/status?target=${encodeURIComponent(identity.targetName)}&source=${encodeURIComponent(identity.sourceName)}`
    );
    if (!statusIsCurrent()) return { kind: "stale", receipt: null };
    calibrated = !!st.calibrated;
  } catch {
    if (!statusIsCurrent()) return { kind: "stale", receipt: null };
    // A current request failure is equivalent to an unavailable calibration.
  }

  r2r.calibrated = calibrated;
  r2rSetCalChip(
    calibrated
      ? runtimeText("Calibrated", "已标定")
      : runtimeText("Not calibrated — calibration required", "未标定 — 请先标定"),
    calibrated ? "ok" : "warn",
  );
  if (!statusIsCurrent()) return { kind: "stale", receipt: null };
  const batchCalibrationStatus = document.getElementById("r2r-batch-calibration-status");
  if (batchCalibrationStatus) {
    batchCalibrationStatus.textContent = calibrated
      ? runtimeText("Calibration ready", "标定已就绪")
      : runtimeText("Calibration required in Robot → Robot", "需要先在“机器人 → 机器人”中完成标定");
  }
  if (rtBtn) rtBtn.disabled = !(r2r.sourceToken && r2r.targetName && calibrated);
  r2rRenderBasket();
  if (!statusIsCurrent()) return { kind: "stale", receipt: null };
  publishR2rWorkflowState();
  if (!statusIsCurrent()) return { kind: "stale", receipt: null };
  // Keep the status claim live across the caller's await continuation. Ensure
  // consumes it synchronously; exit, replacement, or B invalidates it first.
  return {
    kind: "current",
    receipt: { attempt: statusAttempt, calibrated },
  };
}

// --------------------------------------------------------------- robot pickers
async function r2rPopulateSelects(): Promise<void> {
  let data: ApiGetResponse<"/api/robots">;
  try { data = await API.get("/api/robots"); }
  catch { return; }
  const fill = (sel: HTMLSelectElement | null, preferG1: boolean): void => {
    if (!sel) return;
    const prev = sel.value;
    sel.replaceChildren();
    let g1: string | null = null;
    for (const r of data.robots) {
      const opt = document.createElement("option");
      opt.value = r.name;
      opt.textContent = `${r.display_name} (${r.num_dof} DOF)${
        r.has_urdf ? "" : runtimeText(" — no URDF", " — 无 URDF")
      }`;
      opt.disabled = !r.has_urdf;
      sel.appendChild(opt);
      if (preferG1 && !g1 && r.has_urdf && /g1/i.test(r.name + r.display_name)) g1 = r.name;
    }
    if (prev && [...sel.options].some((o) => o.value === prev)) sel.value = prev;
    else if (g1) sel.value = g1;
  };
  fill(document.getElementById("r2r-source-select"), true);
  fill(document.getElementById("r2r-target-select"), false);
  fill(document.getElementById("r2r-batch-source-select"), true);
  fill(document.getElementById("r2r-batch-target-select"), false);
  for (const id of ["r2r-source-select", "r2r-batch-source-select"]) {
    const select = document.getElementById(id) as HTMLSelectElement | null;
    if (select && r2r.sourceName) select.value = r2r.sourceName;
  }
  for (const id of ["r2r-target-select", "r2r-batch-target-select"]) {
    const select = document.getElementById(id) as HTMLSelectElement | null;
    if (select && r2r.targetName) select.value = r2r.targetName;
  }
}

function setR2rRobotStatus(kind: "source" | "target", text: string): void {
  const ids = kind === "source"
    ? ["r2r-source-status", "r2r-batch-source-status"]
    : ["r2r-target-status", "r2r-batch-target-status"];
  for (const id of ids) {
    const element = document.getElementById(id);
    if (element) element.textContent = text;
  }
}

function syncR2rRobotSelects(kind: "source" | "target", name: string): void {
  const ids = kind === "source"
    ? ["r2r-source-select", "r2r-batch-source-select"]
    : ["r2r-target-select", "r2r-batch-target-select"];
  for (const id of ids) {
    const select = document.getElementById(id) as HTMLSelectElement | null;
    if (select && [...select.options].some((option) => option.value === name)) {
      select.value = name;
    }
  }
}

/** Withdraw calibration ownership before a robot-selection intent can await. */
function prepareR2rRobotReplacement(): void {
  invalidateR2rCalibrationAttempts();
  r2rCalibrationFkPreview.stop();
  if (
    r2r.calibrating
    || r2rCalibrationResourcesOwned
    || r2r.calibOrbitSaved !== null
  ) r2rExitCalib();
}

/** Invalidate calibration aliases even when interactive teardown reports a warning. */
function clearR2rCalibrationAfterViewLoss(context: string): void {
  invalidateR2rCalibrationAttempts();
  const targetGroundOffset = r2rCalibrationRestoreGroundOffset;
  // Renderer-loss cleanup is a terminal calibration path even if the
  // manipulator or later best-effort cleanup reports an error.
  r2rCalibrationFkPreview.stop();
  if (r2r.calibOrbitSaved) {
    const saved = r2r.calibOrbitSaved;
    runBestEffortCleanup(`${context}: calibration orbit restore failed`, () => {
      orbit.minDistance = saved.minDistance;
      orbit.maxDistance = saved.maxDistance;
      orbit.zoomSpeed = saved.zoomSpeed;
    });
  }
  r2r.calibrating = false;
  r2r.calibrated = false;
  r2r.calibQ = {};
  r2r.calibBaselineQ = null;
  r2r.calibDraftQ = null;
  r2r.calibHasSaved = false;
  r2r.calibLimits = [];
  r2r.calibRows = {};
  r2r.calibNeedsCameraFocus = false;
  r2r.calibOrbitSaved = null;
  calibrationEditorUi.r2r.comparison = "current";
  runBestEffortCleanup(`${context}: calibration manipulator cleanup failed`, () => calibManip.stop());
  runBestEffortCleanup(`${context}: target opacity restore failed`, () => r2rTgt.setOpacity(1));
  if (targetGroundOffset !== null) {
    runBestEffortCleanup(`${context}: target ground offset restore failed`, () => {
      r2rTgt.groundOffset = targetGroundOffset;
    });
    runBestEffortCleanup(`${context}: target pose restore failed`, () => {
      if (r2rTgt.trajectory) r2rTgt.setFrame(0);
      else r2rTgt.applyStatic();
    });
  }
  runBestEffortCleanup(`${context}: reference cleanup failed`, () => refSkel.clear());
  refSkel.group.visible = false;
  const editor = document.getElementById("r2r-calib-edit");
  if (editor) editor.style.display = "none";
  document.getElementById("calib-banner")?.classList.add("hidden");
  r2rCalibrationResourcesOwned = false;
  r2rCalibrationRestoreGroundOffset = null;
}

/** Clear every result derived from the current R2R source/target pair. */
function clearR2rDerivedTargetAfterViewLoss(
  context: string,
  {
    targetViewAlreadyEmpty = false,
  }: { targetViewAlreadyEmpty?: boolean } = {},
): void {
  r2r.exportToken = null;
  r2r.exportHasScene = false;
  r2r.resultStem = null;
  r2r.tgtScaledScene = null;
  r2rRunState = "idle";

  if (!targetViewAlreadyEmpty) {
    r2rTgt.trajectory = null;
    r2rTgt.frameIndices = null;
    r2rTgt.clipDuration = 1;
    runBestEffortCleanup(`${context}: target pose reset failed`, () => r2rTgt.applyStatic());
  }
  runBestEffortCleanup(`${context}: target skeleton cleanup failed`, () => r2rTgtSkel.clear());
  runBestEffortCleanup(`${context}: target environment cleanup failed`, () => r2rTgtEnv.clear());
  r2rVis.tgtRobot = false;
  r2rVis.tgtSkel = false;
  r2rVis.tgtEnv = false;
  runBestEffortCleanup(
    `${context}: result diagnostics cleanup failed`,
    () => clearResultDiagnostics("r2r"),
  );
  const exportCard = document.getElementById("r2r-export-card");
  if (exportCard) exportCard.style.display = "none";
  for (const id of ["r2r-tg-tgt-robot", "r2r-tg-tgt-skel", "r2r-tg-tgt-env"]) {
    const button = document.getElementById(id) as HTMLButtonElement | null;
    if (button) button.disabled = true;
  }
}

/** Terminal compensation for a current-generation R2R source load failure. */
function clearR2rSourceAfterViewLoss(context: string): void {
  invalidateR2rCalibrationAttempts();
  r2r.sourceName = null;
  r2r.sourcePayload = null;
  r2r.sourceToken = null;
  r2r.sourceStem = null;
  r2r.hasScene = false;
  r2r.scaledScene = null;
  r2rTrajectoryState = "idle";
  clearR2rCalibrationAfterViewLoss(context);

  runBestEffortCleanup(`${context}: source skeleton cleanup failed`, () => r2rSrcSkel.clear());
  runBestEffortCleanup(`${context}: source environment cleanup failed`, () => r2rSrcEnv.clear());
  r2rVis.srcRobot = false;
  r2rVis.srcSkel = false;
  r2rVis.srcEnv = false;
  clearR2rDerivedTargetAfterViewLoss(context);

  setR2rRobotStatus("source", runtimeText("Source robot: not loaded", "源机器人：未加载"));
  const trajectory = document.getElementById("r2r-trajectory-value");
  if (trajectory) trajectory.textContent = runtimeText("Not loaded", "未加载");
  for (const id of ["r2r-tg-src-robot", "r2r-tg-src-skel", "r2r-tg-src-env"]) {
    const button = document.getElementById(id) as HTMLButtonElement | null;
    if (button) button.disabled = true;
  }
  runBestEffortCleanup(`${context}: Stage projection failed`, () => r2rApplyStage());
  runBestEffortCleanup(`${context}: workflow publication failed`, () => {
    publishR2rWorkflowState();
    r2rRenderBasket();
    emitCalibrationEditorState("r2r");
  });
  r2rSetCalChip("—", "");
  const calibrationButton = document.getElementById("r2r-calib-btn") as HTMLButtonElement | null;
  if (calibrationButton) calibrationButton.disabled = true;
  const retargetButton = document.getElementById("r2r-retarget-btn") as HTMLButtonElement | null;
  if (retargetButton) retargetButton.disabled = true;
}

/** Terminal compensation for a current-generation R2R target load failure. */
function clearR2rTargetAfterViewLoss(context: string): void {
  invalidateR2rCalibrationAttempts();
  r2r.targetName = null;
  r2r.targetPayload = null;
  clearR2rCalibrationAfterViewLoss(context);
  clearR2rDerivedTargetAfterViewLoss(context, { targetViewAlreadyEmpty: true });

  setR2rRobotStatus("target", runtimeText("Target robot: not loaded", "目标机器人：未加载"));
  runBestEffortCleanup(`${context}: Stage projection failed`, () => r2rApplyStage());
  runBestEffortCleanup(`${context}: workflow publication failed`, () => {
    publishR2rWorkflowState();
    r2rRenderBasket();
    emitCalibrationEditorState("r2r");
  });
  r2rSetCalChip("—", "");
  const calibrationButton = document.getElementById("r2r-calib-btn") as HTMLButtonElement | null;
  if (calibrationButton) calibrationButton.disabled = true;
  const retargetButton = document.getElementById("r2r-retarget-btn") as HTMLButtonElement | null;
  if (retargetButton) retargetButton.disabled = true;
}

async function r2rLoadSourceRobot(
  name: string,
  { activateWorkspace = true }: { activateWorkspace?: boolean } = {},
): Promise<void> {
  if (!name) return;
  prepareR2rRobotReplacement();
  toast(runtimeText("Loading source robot…", "加载源机器人…"));
  try {
    const sourcePayload = await API.post("/api/robot/select", { name });
    prepareR2rRobotReplacement();
    const attempt = startRobotViewLoad(r2rSrc, sourcePayload);
    let loadResult: AsyncStageViewLoadResult;
    try {
      loadResult = await attempt.completion;
    } catch (error) {
      if (!r2rSrc.isLoadGenerationCurrent(attempt.generation)) return;
      clearR2rSourceAfterViewLoss("selected R2R source load");
      throw error;
    }
    if (
      loadResult === "stale"
      || !r2rSrc.isLoadGenerationCurrent(attempt.generation)
    ) return;
    prepareR2rRobotReplacement();
    if (r2r.sourceName !== name) {
      r2r.sourceToken = null;
      r2r.sourceStem = null;
      r2rTrajectoryState = "idle";
      const trajectoryValue = document.getElementById("r2r-trajectory-value");
      if (trajectoryValue) trajectoryValue.textContent = runtimeText("Not loaded", "未加载");
    }
    r2r.calibrated = false;
    r2r.sourcePayload = sourcePayload;
    r2r.sourceName = name;
    r2r.exportToken = null;
    r2rRunState = "idle";
    clearResultDiagnostics("r2r");
    syncR2rRobotSelects("source", name);
    if (activateWorkspace) {
      switchInspectorPanel("r2r");
      if (!r2r.active) r2rEnterPanel();
      r2rApplyStage();
      r2rFocus(r2rSrc);
    }
    setR2rRobotStatus("source", runtimeText(
      `Source robot: ${sourcePayload.display_name}`,
      `源机器人：${sourcePayload.display_name}`,
    ));
    toast(runtimeText(
      `Source robot loaded: ${sourcePayload.display_name}`,
      `源机器人已加载：${sourcePayload.display_name}`,
    ));
    await r2rMaybeAutoCalib();
    r2rRenderBasket();
  } catch (error) {
    toast(errorMessage(error), true);
  }
}

async function r2rLoadTargetRobot(name: string): Promise<void> {
  if (!name) return;
  prepareR2rRobotReplacement();
  toast(runtimeText("Loading target robot…", "加载目标机器人…"));
  try {
    const targetPayload = await API.post("/api/robot/select", { name });
    prepareR2rRobotReplacement();
    r2r.calibrated = false;
    r2r.targetPayload = targetPayload;
    r2r.targetName = name;
    r2r.exportToken = null;
    r2rRunState = "idle";
    clearResultDiagnostics("r2r");
    syncR2rRobotSelects("target", name);
    setR2rRobotStatus("target", runtimeText(
      `Target robot: ${targetPayload.display_name}`,
      `目标机器人：${targetPayload.display_name}`,
    ));
    toast(runtimeText(
      `Target robot loaded: ${targetPayload.display_name}`,
      `目标机器人已加载：${targetPayload.display_name}`,
    ));
    await r2rMaybeAutoCalib();
    r2rRenderBasket();
  } catch (error) {
    toast(errorMessage(error), true);
  }
}

// --------------------------------------------------------------- calibration
interface R2rCalibrationFkResult {
  readonly sourceName: string;
  readonly sourcePayload: RobotPayload | null;
  readonly targetName: string;
  readonly targetPayload: RobotPayload | null;
  readonly response: ApiPostResponse<"/api/robot/fk_preview">;
}

const r2rCalibrationFkPreview = new CoalescedAsyncFrameTask<
  R2rCalibrationFkResult | null
>({
  scheduler: {
    requestFrame: (callback) => requestAnimationFrame(callback),
    cancelFrame: (handle) => cancelAnimationFrame(handle),
  },
  execute: async () => {
    const sourceName = r2r.sourceName;
    const sourcePayload = r2r.sourcePayload;
    const targetName = r2r.targetName;
    const targetPayload = r2r.targetPayload;
    if (!r2r.calibrating || !sourceName || !targetName) return null;
    const response = await API.post("/api/robot/fk_preview", {
      robot: targetName,
      joint_q: { ...r2r.calibQ },
    });
    return { sourceName, sourcePayload, targetName, targetPayload, response };
  },
  commit: (result) => {
    if (
      !result
      || !r2r.calibrating
      || r2r.sourceName !== result.sourceName
      || r2r.sourcePayload !== result.sourcePayload
      || r2r.targetName !== result.targetName
      || r2r.targetPayload !== result.targetPayload
    ) return;

    const { response } = result;
    r2rTgt.applyCalibPose(response.link_transforms, response.ground_offset_z);
    refSkel.updateOverlay(r2rTgt);
    if (calibManip.active) calibManip.updateJointWorld(response.joint_world);
    updateR2rCalibrationValidation();
    if (r2r.calibNeedsCameraFocus) {
      r2r.calibNeedsCameraFocus = false;
      applyCalibOrbitLimits({ snapCamera: true });
      focusRobotView({ resetOffset: true });
    }
  },
  reportError: (error) => {
    console.warn("r2r fk preview", errorMessage(error));
  },
});

function r2rCalibCtx(): CalibrationContext {
  return {
    robotView: r2rTgt,
    getQ: () => r2r.calibQ,
    getSliderRows: () => r2r.calibRows,
    jointChange: (name, val, opts) => r2rSetCalibJointValue(name, val, opts),
    previewFk: (opts) => r2rPreviewCalibPose(opts),
  };
}

function r2rPreviewCalibPose(
  { flush = false }: CalibrationPreviewOptions = {},
): void {
  if (!r2r.calibrating || !r2r.targetName) return;
  if (flush) r2rCalibrationFkPreview.flush();
  else r2rCalibrationFkPreview.schedule();
}

function r2rSetCalibJointValue(
  jointName: string,
  value: string | number,
  { from, live = false }: CalibrationChangeOptions,
): void {
  const limByName: Record<string, RobotJointLimit> = {};
  for (const limit of r2r.calibLimits) limByName[limit.name] = limit;
  const lim = limByName[jointName];
  let lo = lim?.lower != null ? lim.lower : -Math.PI;
  let hi = lim?.upper != null ? lim.upper : Math.PI;
  if (hi <= lo) { lo = -Math.PI; hi = Math.PI; }
  let x = parseFloat(String(value));
  if (!Number.isFinite(x)) return;
  if (from === "number" || from === "hud-input") {
    x = angleFromDisplay(x, calibrationEditorUi.r2r.unit);
  }
  x = Math.min(hi, Math.max(lo, x));
  r2r.calibQ[jointName] = x;

  const row = r2r.calibRows[jointName];
  const prec = live ? 4 : 3;
  if (row) {
    if (from === "slider") {
      row.range.value = String(x);
      row.num.value = formatCalibrationAngle(x, calibrationEditorUi.r2r.unit, prec);
    } else if (from === "number") {
      row.range.value = String(x);
      if (!live) row.num.value = formatCalibrationAngle(x, calibrationEditorUi.r2r.unit, prec);
    } else if (from !== "hud-input") {
      row.range.value = String(x);
      row.num.value = formatCalibrationAngle(x, calibrationEditorUi.r2r.unit, prec);
    }
    const span = hi - lo;
    row.row.classList.toggle("near-limit", span > 0 && (x - lo < span * 0.03 || hi - x < span * 0.03));
  }
  if (from === "hud-input") {
    calibManip.updateHudValue(jointName, x, { live, syncInput: false });
  } else {
    calibManip.updateHudValue(jointName, x, { live });
  }
  if (from === "slider" || from === "number") calibManip.setSelected(jointName);
  markCalibrationEdited("r2r");
  updateR2rCalibrationValidation();
  r2rPreviewCalibPose({ live });
}

function r2rBuildSliders(
  initialQ: Record<string, number>,
  limits: RobotJointLimit[],
  isCurrent: () => boolean = () => true,
): boolean {
  const box = document.getElementById("r2r-calib-sliders");
  if (!box) return true;
  box.replaceChildren();
  if (!isCurrent()) return false;
  r2r.calibQ = {};
  r2r.calibRows = {};
  const limByName: Record<string, RobotJointLimit> = {};
  for (const limit of limits) limByName[limit.name] = limit;
  const joints = limits.map((limit) => limit.name).filter(Boolean);
  for (const j of r2r.targetPayload?.actuated_joints || []) {
    if (!limByName[j]) joints.push(j);
  }
  const seen = new Set<string>();
  for (const j of joints) {
    if (!isCurrent()) return false;
    if (seen.has(j)) continue;
    seen.add(j);
    const lim = limByName[j];
    let lo = lim?.lower != null ? lim.lower : -Math.PI;
    let hi = lim?.upper != null ? lim.upper : Math.PI;
    if (hi <= lo) { lo = -Math.PI; hi = Math.PI; }
    let v = initialQ[j] ?? 0;
    v = Math.min(hi, Math.max(lo, v));
    r2r.calibQ[j] = v;
    const rowEl = document.createElement("div");
    rowEl.className = "slider-row";
    const region = classifyCalibrationJoint(j);
    rowEl.dataset.region = region;
    const label = textElement("label", "", j);
    label.title = j;
    const range = document.createElement("input");
    range.type = "range";
    range.min = String(lo);
    range.max = String(hi);
    range.step = "0.001";
    range.value = String(v);
    const num = document.createElement("input");
    num.type = "number";
    num.className = "calib-num";
    num.min = String(angleForDisplay(lo, calibrationEditorUi.r2r.unit));
    num.max = String(angleForDisplay(hi, calibrationEditorUi.r2r.unit));
    num.step = calibrationEditorUi.r2r.unit === "deg" ? "0.1" : "0.001";
    num.value = formatCalibrationAngle(v, calibrationEditorUi.r2r.unit);
    rowEl.append(label, range, num);
    r2r.calibRows[j] = { row: rowEl, range, num, lo, hi, region };
    const span = hi - lo;
    rowEl.classList.toggle("near-limit", span > 0 && (v - lo < span * 0.03 || hi - v < span * 0.03));
    calibManip.updateHudValue(j, v);
    if (!isCurrent()) return false;
    range.oninput = () => r2rSetCalibJointValue(j, range.value, { from: "slider", live: true });
    num.oninput = () => r2rSetCalibJointValue(j, num.value, { from: "number", live: true });
    num.onchange = () => r2rSetCalibJointValue(j, num.value, { from: "number" });
    num.onkeydown = (ev: KeyboardEvent) => {
      if (ev.key === "Enter") { r2rSetCalibJointValue(j, num.value, { from: "number" }); num.blur(); }
    };
    rowEl.onclick = () => {
      calibManip._pickScreen = null;
      calibManip._pickAnchor = null;
      calibManip._hudPinned = null;
      calibManip.setSelected(j, { scrollPanel: true });
    };
    box.appendChild(rowEl);
    if (!isCurrent()) return false;
  }
  if (calibrationEditorUi.r2r.comparison === "current") r2r.calibDraftQ = { ...r2r.calibQ };
  syncCalibrationNumberInputs("r2r");
  if (!isCurrent()) return false;
  applyCalibrationRowFilter("r2r");
  if (!isCurrent()) return false;
  updateR2rCalibrationValidation();
  if (!isCurrent()) return false;
  r2rPreviewCalibPose();
  return isCurrent();
}

function rollbackR2rCalibrationBootstrap(
  attempt: LatestAsyncAttempt<R2rCalibrationIdentity>,
  error: unknown,
  targetGroundOffset: number,
  calibrationResourcesOwned: boolean,
  { targetViewLost = false }: { targetViewLost?: boolean } = {},
): boolean {
  if (!r2rCalibrationBootstrapAttempts.isCurrent(attempt)) return false;
  const orbitSnapshot = r2r.calibOrbitSaved;

  r2rCalibrationFkPreview.stop();
  if (!r2rCalibrationBootstrapAttempts.isCurrent(attempt)) return false;

  if (targetViewLost) {
    // Keep terminal target withdrawal under an owned token until every
    // destructive cleanup step is done; a reentrant replacement supersedes it.
    attempt = beginR2rCalibrationBootstrapAttempt({
      ...attempt.identity,
      targetCapabilityWithdrawn: true,
    });
    r2r.targetName = null;
    r2r.targetPayload = null;
    r2r.exportToken = null;
    r2r.exportHasScene = false;
    r2r.resultStem = null;
    r2r.tgtScaledScene = null;
    r2rRunState = "idle";
  }

  // Canonical editor aliases become terminal before fallible renderer cleanup.
  r2r.calibrating = false;
  r2r.calibrated = targetViewLost ? false : attempt.identity.calibratedBefore;
  r2r.calibNeedsCameraFocus = false;
  r2r.calibQ = {};
  r2r.calibBaselineQ = null;
  r2r.calibDraftQ = null;
  r2r.calibHasSaved = false;
  r2r.calibLimits = [];
  r2r.calibRows = {};
  calibrationEditorUi.r2r.comparison = "current";

  const cleanup = (context: string, action: () => void): boolean => {
    if (!r2rCalibrationBootstrapAttempts.isCurrent(attempt)) return false;
    runBestEffortCleanup(context, action);
    return r2rCalibrationBootstrapAttempts.isCurrent(attempt);
  };
  const readForCleanup = <Value>(
    context: string,
    read: () => Value | null,
  ): { readonly current: boolean; readonly value: Value | null } => {
    if (!r2rCalibrationBootstrapAttempts.isCurrent(attempt)) {
      return { current: false, value: null };
    }
    let value: Value | null = null;
    runBestEffortCleanup(context, () => { value = read(); });
    return {
      current: r2rCalibrationBootstrapAttempts.isCurrent(attempt),
      value,
    };
  };

  if (orbitSnapshot) {
    if (!cleanup("R2R calibration bootstrap: minimum orbit restore failed", () => {
      orbit.minDistance = orbitSnapshot.minDistance;
    })) return false;
    if (!cleanup("R2R calibration bootstrap: maximum orbit restore failed", () => {
      orbit.maxDistance = orbitSnapshot.maxDistance;
    })) return false;
    if (!cleanup("R2R calibration bootstrap: orbit speed restore failed", () => {
      orbit.zoomSpeed = orbitSnapshot.zoomSpeed;
    })) return false;
  }
  if (calibrationResourcesOwned) {
    if (!cleanup("R2R calibration bootstrap: manipulator cleanup failed", () => calibManip.stop())) return false;
    if (!cleanup("R2R calibration bootstrap: target opacity restore failed", () => r2rTgt.setOpacity(1))) return false;
    if (!cleanup("R2R calibration bootstrap: reference cleanup failed", () => refSkel.clear())) return false;
    if (!cleanup("R2R calibration bootstrap: reference visibility cleanup failed", () => {
      refSkel.group.visible = false;
    })) return false;
    if (!cleanup("R2R calibration bootstrap: target ground offset restore failed", () => {
      r2rTgt.groundOffset = targetGroundOffset;
    })) return false;
    if (!cleanup("R2R calibration bootstrap: target pose restore failed", () => {
      if (r2rTgt.trajectory) r2rTgt.setFrame(0);
      else r2rTgt.applyStatic();
    })) return false;
  }
  if (targetViewLost) {
    if (!cleanup("R2R calibration bootstrap: target skeleton cleanup failed", () => r2rTgtSkel.clear())) return false;
    if (!cleanup("R2R calibration bootstrap: target environment cleanup failed", () => r2rTgtEnv.clear())) return false;
    // Plain aliases can move together; every DOM/renderer publication below is
    // its own guarded boundary so reentrant B stops A immediately.
    r2rTgt.trajectory = null;
    r2rTgt.frameIndices = null;
    r2rTgt.clipDuration = 1;
    r2rVis.tgtRobot = false;
    r2rVis.tgtSkel = false;
    r2rVis.tgtEnv = false;
    if (!cleanup("R2R calibration bootstrap: result diagnostics cleanup failed", () => {
      clearResultDiagnostics("r2r");
    })) return false;
    const exportCardLookup = readForCleanup(
      "R2R calibration bootstrap: export card lookup failed",
      () => document.getElementById("r2r-export-card"),
    );
    if (!exportCardLookup.current) return false;
    const exportCard = exportCardLookup.value;
    if (exportCard) {
      const currentExportCard = exportCard;
      if (!cleanup("R2R calibration bootstrap: export card cleanup failed", () => {
        currentExportCard.style.display = "none";
      })) return false;
    }
    const targetStatusText = runtimeText("Target robot: not loaded", "目标机器人：未加载");
    for (const id of ["r2r-target-status", "r2r-batch-target-status"]) {
      const statusLookup = readForCleanup(
        "R2R calibration bootstrap: target status lookup failed",
        () => document.getElementById(id),
      );
      if (!statusLookup.current) return false;
      const status = statusLookup.value;
      if (status) {
        const currentStatus = status;
        if (!cleanup("R2R calibration bootstrap: target status cleanup failed", () => {
          currentStatus.textContent = targetStatusText;
        })) return false;
      }
    }
    for (const id of ["r2r-tg-tgt-robot", "r2r-tg-tgt-skel", "r2r-tg-tgt-env"]) {
      const buttonLookup = readForCleanup(
        "R2R calibration bootstrap: target toggle lookup failed",
        () => document.getElementById(id) as HTMLButtonElement | null,
      );
      if (!buttonLookup.current) return false;
      const button = buttonLookup.value;
      if (button) {
        const currentButton = button;
        if (!cleanup("R2R calibration bootstrap: target toggle cleanup failed", () => {
          currentButton.disabled = true;
        })) return false;
      }
    }
  }
  const editorLookup = readForCleanup(
    "R2R calibration bootstrap: editor lookup failed",
    () => document.getElementById("r2r-calib-edit"),
  );
  if (!editorLookup.current) return false;
  const editor = editorLookup.value;
  if (editor) {
    const currentEditor = editor;
    if (!cleanup("R2R calibration bootstrap: editor cleanup failed", () => {
      currentEditor.style.display = "none";
    })) return false;
  }
  const slidersLookup = readForCleanup(
    "R2R calibration bootstrap: slider lookup failed",
    () => document.getElementById("r2r-calib-sliders"),
  );
  if (!slidersLookup.current) return false;
  const sliders = slidersLookup.value;
  if (sliders) {
    const currentSliders = sliders;
    if (!cleanup("R2R calibration bootstrap: slider cleanup failed", () => {
      currentSliders.replaceChildren();
    })) return false;
  }
  if (calibrationResourcesOwned) {
    const bannerLookup = readForCleanup(
      "R2R calibration bootstrap: banner lookup failed",
      () => document.getElementById("calib-banner"),
    );
    if (!bannerLookup.current) return false;
    const banner = bannerLookup.value;
    if (banner) {
      const currentBanner = banner;
      if (!cleanup("R2R calibration bootstrap: banner cleanup failed", () => {
        currentBanner.classList.add("hidden");
      })) return false;
    }
  }
  if ((calibrationResourcesOwned || targetViewLost) && !cleanup(
    "R2R calibration bootstrap: Stage restore failed",
    () => r2rApplyStage(),
  )) return false;
  if (!cleanup("R2R calibration bootstrap: workflow publication failed", () => {
    publishR2rWorkflowState();
  })) return false;
  if (!cleanup("R2R calibration bootstrap: editor publication failed", () => {
    emitCalibrationEditorState("r2r");
  })) return false;
  if (!cleanup("R2R calibration bootstrap: error notification failed", () => {
    toast(errorMessage(error), true);
  })) return false;
  if (!finishR2rCalibrationBootstrapAttempt(attempt)) return false;
  // Keep the original orbit baseline available to a reentrant same-pair owner.
  r2r.calibOrbitSaved = null;
  r2rCalibrationResourcesOwned = false;
  r2rCalibrationRestoreGroundOffset = null;
  return true;
}

async function r2rStartCalib(
  { auto = false }: { auto?: boolean } = {},
): Promise<R2rCalibrationBootstrapResult> {
  if (r2r.calibrating) return "entered";
  r2rCalibrationStatusAttempts.invalidate();
  const capturedIdentity = captureR2rCalibrationIdentity();
  if (!capturedIdentity) {
    // Missing selection is not itself an ownership transfer. In particular,
    // target-loss rollback temporarily publishes a missing target while it
    // still owns terminal cleanup; explicit exit/replacement paths invalidate.
    toast(runtimeText(
      "Load both the source and target robots first",
      "请先加载源机器人与目标机器人",
    ), true);
    return "failed";
  }

  let attempt = beginR2rCalibrationBootstrapAttempt(capturedIdentity);
  let targetLoadGeneration: number | null = null;
  let targetGroundOffset = (
    r2rCalibrationRestoreGroundOffset ?? r2rTgt.groundOffset
  );
  let calibrationResourcesOwned = r2rCalibrationResourcesOwned;
  const isCurrent = (): boolean => (
    r2rCalibrationBootstrapAttempts.isCurrent(attempt)
    && (
      targetLoadGeneration === null
      || r2rTgt.isLoadGenerationCurrent(targetLoadGeneration)
    )
  );

  try {
    // A replacement attempt owns FK publication as soon as it starts, even
    // while its session and renderer are still pending.
    r2rCalibrationFkPreview.stop();
    if (!isCurrent()) return "stale";
    if (!auto) {
      toast(runtimeText("Preparing calibration…", "准备标定…"));
      if (!isCurrent()) return "stale";
    }

    const session = await API.post("/api/r2r/calibration/session", {
      target: attempt.identity.targetName,
      source: attempt.identity.sourceName,
    });
    if (!isCurrent()) return "stale";

    let targetPayload = attempt.identity.resolvedTargetPayload;
    if (!targetPayload) {
      targetPayload = await API.post("/api/robot/select", {
        name: attempt.identity.targetName,
      });
      if (!isCurrent()) return "stale";
    }
    const reference = session.reference ?? session.reference_pose;
    if (!targetPayload || !reference) {
      throw new Error(runtimeText(
        "The calibration session is missing the target robot or reference pose",
        "标定会话缺少目标机器人或参考姿态",
      ));
    }

    // Rebase the same logical attempt with its locally resolved payload before
    // RobotView reserves the exact generation guarded below.
    if (!isCurrent()) return "stale";
    attempt = beginR2rCalibrationBootstrapAttempt({
      ...attempt.identity,
      resolvedTargetPayload: targetPayload,
      targetViewGeneration: null,
    });
    const targetLoadAttempt = startRobotViewLoad(r2rTgt, targetPayload);
    targetLoadGeneration = targetLoadAttempt.generation;
    if (!isCurrent()) return "stale";
    attempt = beginR2rCalibrationBootstrapAttempt({
      ...attempt.identity,
      targetViewGeneration: targetLoadGeneration,
    });
    if (!isCurrent()) return "stale";

    let targetLoadResult: AsyncStageViewLoadResult;
    try {
      targetLoadResult = await targetLoadAttempt.completion;
    } catch (error) {
      if (!isCurrent()) return "stale";
      const rolledBack = rollbackR2rCalibrationBootstrap(
        attempt,
        error,
        targetGroundOffset,
        calibrationResourcesOwned,
        { targetViewLost: true },
      );
      return rolledBack ? "failed" : "stale";
    }
    if (targetLoadResult === "stale" || !isCurrent()) return "stale";
    if (!r2rCalibrationResourcesOwned) {
      r2rCalibrationRestoreGroundOffset = r2rTgt.groundOffset;
    }
    targetGroundOffset = (
      r2rCalibrationRestoreGroundOffset ?? r2rTgt.groundOffset
    );
    r2rCalibrationResourcesOwned = true;
    calibrationResourcesOwned = true;

    // Enter calibration only after the target renderer generation commits.
    r2r.targetPayload = targetPayload;
    if (!isCurrent()) return "stale";
    switchInspectorPanel("r2r");
    if (!isCurrent()) return "stale";
    if (!r2r.active) r2rEnterPanel();
    if (!isCurrent()) return "stale";
    r2rCalibrationFkPreview.start();
    if (!isCurrent()) return "stale";

    const enteringFresh = !r2r.calibrating && r2r.calibOrbitSaved === null;
    if (enteringFresh) {
      r2r.calibOrbitSaved = {
        minDistance: orbit.minDistance,
        maxDistance: orbit.maxDistance,
        zoomSpeed: orbit.zoomSpeed,
      };
    }
    // Status may have started while this bootstrap awaited its session/View.
    // Entering calibration terminalizes that receipt before active is visible.
    r2rCalibrationStatusAttempts.invalidate();
    r2r.calibrating = true;
    r2r.calibNeedsCameraFocus = true;
    orbit.zoomSpeed = 0.022;
    applyCalibOrbitLimits();
    if (!isCurrent()) return "stale";
    updateR2rCalibBanner();
    if (!isCurrent()) return "stale";
    document.getElementById("calib-banner")?.classList.remove("hidden");
    if (!isCurrent()) return "stale";
    r2rSetCalChip(runtimeText("Calibrating…", "标定中…"), "warn");
    if (!isCurrent()) return "stale";
    const retargetButton = document.getElementById("r2r-retarget-btn") as HTMLButtonElement | null;
    if (retargetButton) retargetButton.disabled = true;
    if (!isCurrent()) return "stale";
    publishR2rWorkflowState();
    if (!isCurrent()) return "stale";

    r2r.calibLimits = session.joint_limits ?? session.limits ?? [];
    r2rTgt.groundOffset = session.ground_offset_z ?? r2rTgt.groundOffset;
    refSkel.load(reference);
    if (!isCurrent()) return "stale";
    refSkel.configureMappings(targetPayload.ik_map ?? {});
    if (!isCurrent()) return "stale";
    const initialQ = { ...(session.joint_q || {}) };
    r2r.calibHasSaved = !!session.has_saved_calibration;
    r2r.calibBaselineQ = r2r.calibHasSaved ? { ...initialQ } : null;
    r2r.calibDraftQ = { ...initialQ };
    calibrationEditorUi.r2r.comparison = "current";
    const editor = document.getElementById("r2r-calib-edit");
    if (!editor) throw new Error("R2R calibration editor is unavailable");
    editor.style.display = "block";
    if (!isCurrent()) return "stale";
    r2rApplyStage();
    if (!isCurrent()) return "stale";
    calibManip.start(r2r.calibLimits, r2rCalibCtx());
    if (!isCurrent()) return "stale";
    if (!r2rBuildSliders(initialQ, r2r.calibLimits, isCurrent)) return "stale";
    if (!isCurrent()) return "stale";
    applyCalibrationVisualization("r2r");
    if (!isCurrent()) return "stale";
    editor.scrollIntoView({ behavior: "smooth", block: "nearest" });
    if (!isCurrent()) return "stale";
    r2rFocus(r2rTgt);
    if (!isCurrent()) return "stale";
    toast(auto
      ? runtimeText(
        "The target robot is not calibrated. Calibration mode opened automatically; drag joints or use the right-side sliders.",
        "目标机器人尚未标定：已自动进入标定模式（点击关节拖动或右侧滑块）",
      )
      : runtimeText(
        "Calibration started. Align the target robot to the blue source reference pose.",
        "已进入标定：把目标机器人对齐到蓝色源参考姿态",
      ));
    if (!isCurrent()) return "stale";
    return finishR2rCalibrationBootstrapAttempt(attempt)
      ? "entered"
      : "stale";
  } catch (error) {
    if (!isCurrent()) return "stale";
    return rollbackR2rCalibrationBootstrap(
      attempt,
      error,
      targetGroundOffset,
      calibrationResourcesOwned,
    )
      ? "failed"
      : "stale";
  }
}

function r2rExitCalib(
  { publishStageDisplay = true }: R2rStageApplyOptions = {},
): void {
  invalidateR2rCalibrationAttempts();
  const orbitSnapshot = r2r.calibOrbitSaved;
  const targetGroundOffset = r2rCalibrationRestoreGroundOffset;
  r2rCalibrationFkPreview.stop();
  r2r.calibrating = false;
  r2r.calibNeedsCameraFocus = false;
  r2r.calibQ = {};
  r2r.calibRows = {};
  r2r.calibLimits = [];
  r2r.calibBaselineQ = null;
  r2r.calibDraftQ = null;
  r2r.calibHasSaved = false;
  calibrationEditorUi.r2r.comparison = "current";

  if (orbitSnapshot) {
    runBestEffortCleanup("R2R calibration exit: orbit restore failed", () => {
      orbit.minDistance = orbitSnapshot.minDistance;
      orbit.maxDistance = orbitSnapshot.maxDistance;
      orbit.zoomSpeed = orbitSnapshot.zoomSpeed;
    });
  }
  runBestEffortCleanup("R2R calibration exit: manipulator cleanup failed", () => calibManip.stop());
  runBestEffortCleanup("R2R calibration exit: target opacity restore failed", () => r2rTgt.setOpacity(1));
  if (targetGroundOffset !== null) {
    runBestEffortCleanup("R2R calibration exit: target ground offset restore failed", () => {
      r2rTgt.groundOffset = targetGroundOffset;
    });
    runBestEffortCleanup("R2R calibration exit: target pose restore failed", () => {
      if (r2rTgt.trajectory) r2rTgt.setFrame(0);
      else r2rTgt.applyStatic();
    });
  }
  runBestEffortCleanup("R2R calibration exit: editor cleanup failed", () => {
    const editor = document.getElementById("r2r-calib-edit");
    if (editor) editor.style.display = "none";
    document.getElementById("r2r-calib-sliders")?.replaceChildren();
    document.getElementById("calib-banner")?.classList.add("hidden");
  });
  runBestEffortCleanup("R2R calibration exit: reference cleanup failed", () => {
    refSkel.clear();
    refSkel.group.visible = false;
  });
  runBestEffortCleanup(
    "R2R calibration exit: Stage restore failed",
    () => r2rApplyStage({ publishStageDisplay }),
  );
  runBestEffortCleanup("R2R calibration exit: workflow publication failed", () => {
    publishR2rWorkflowState();
    emitCalibrationEditorState("r2r");
  });
  r2r.calibOrbitSaved = null;
  r2rCalibrationResourcesOwned = false;
  r2rCalibrationRestoreGroundOffset = null;
}

type R2rEnsureCalibrationResult = R2rCalibrationBootstrapResult | "ready";

async function r2rEnsureCalibration(
  { auto = true }: { auto?: boolean } = {},
): Promise<R2rEnsureCalibrationResult> {
  const statusResult = await r2rUpdateRetargetBtn();
  if (statusResult.kind === "stale") return "stale";
  const receipt = statusResult.receipt;
  if (!receipt) {
    return r2r.calibrating || r2rCalibrationBootstrapIsPending()
      ? "entered"
      : "failed";
  }
  // A bootstrap can enter after the producer's final guard but before this
  // continuation. Active calibration always wins and retarget stays closed.
  if (r2r.calibrating || r2rCalibrationBootstrapIsPending()) return "entered";
  if (!r2rCalibrationStatusAttempts.isCurrent(receipt.attempt)) return "stale";
  if (receipt.calibrated) {
    return r2rCalibrationStatusAttempts.finish(receipt.attempt)
      ? "ready"
      : "stale";
  }
  // r2rStartCalib invalidates the receipt synchronously before its first await,
  // closing the gap where exit/replacement could otherwise revive old status.
  return r2rStartCalib({ auto });
}

async function r2rMaybeAutoCalib(): Promise<void> {
  publishR2rWorkflowState();
  if (!r2r.targetName || !r2r.sourceName || r2r.calibrating) return;
  await r2rEnsureCalibration({ auto: true });
}

async function r2rSaveCalib(): Promise<void> {
  try {
    const savedQ = { ...r2r.calibQ };
    const scope = `${r2r.targetPayload?.display_name || r2r.targetName} + ${r2r.sourcePayload?.display_name || r2r.sourceName}`;
    const response = await API.post("/api/r2r/calibration/save", {
      target: r2r.targetName,
      source: r2r.sourceName,
      joint_q: savedQ,
    });
    r2r.calibBaselineQ = { ...savedQ };
    r2r.calibHasSaved = true;
    r2rExitCalib();
    renderCalibrationSaveSummary(
      "r2r-calibration-save-summary",
      scope,
      response.path ?? null,
      savedQ,
    );
    toast(runtimeText("R2R calibration saved", "R2R 标定已保存"));
    await r2rUpdateRetargetBtn();
  } catch (e) { toast(errorMessage(e), true); }
}

// --------------------------------------------------------------- trajectory IO
async function r2rEnsureSourceLoaded(): Promise<boolean> {
  if (r2r.sourceName && r2r.sourcePayload) return true;
  const name = document.getElementById("r2r-source-select")?.value;
  if (!name) {
    toast(runtimeText(
      "Select and load G1 (or another source robot) in “1 · Source robot” first",
      "请先在「1 · 源机器人」选择并加载 G1（或其它源机器人）",
    ), true);
    return false;
  }
  prepareR2rRobotReplacement();
  toast(runtimeText("Loading source robot automatically…", "自动加载源机器人…"));
  try {
    const sourcePayload = await API.post("/api/robot/select", { name });
    prepareR2rRobotReplacement();
    const attempt = startRobotViewLoad(r2rSrc, sourcePayload);
    let loadResult: AsyncStageViewLoadResult;
    try {
      loadResult = await attempt.completion;
    } catch (error) {
      if (!r2rSrc.isLoadGenerationCurrent(attempt.generation)) return false;
      clearR2rSourceAfterViewLoss("automatic R2R source load");
      throw error;
    }
    if (
      loadResult === "stale"
      || !r2rSrc.isLoadGenerationCurrent(attempt.generation)
    ) return false;
    prepareR2rRobotReplacement();
    r2r.sourcePayload = sourcePayload;
    r2r.sourceName = name;
    r2r.calibrated = false;
    setR2rRobotStatus("source", runtimeText(
      `Source robot: ${sourcePayload.display_name}`,
      `源机器人：${sourcePayload.display_name}`,
    ));
    publishR2rWorkflowState();
    return true;
  } catch (e) {
    toast(errorMessage(e), true);
    return false;
  }
}

async function r2rUploadTraj(
  files: UploadFile[],
  profile = "auto",
): Promise<void> {
  if (!files?.length) return;
  if (!(await r2rEnsureSourceLoaded())) return;
  const sourceName = r2r.sourceName;
  const sourcePayload = r2r.sourcePayload;
  if (!sourceName || !sourcePayload) return;
  const st = document.getElementById("r2r-traj-status");
  const prog = document.getElementById("r2r-traj-progress");
  const bar = prog?.querySelector<HTMLElement>(".bar");
  if (prog) {
    prog.style.display = "block";
    prog.classList.remove("indet");
    if (bar) bar.style.width = "0%";
  }
  r2rTrajectoryState = "validating";
  r2r.exportToken = null;
  r2rRunState = "idle";
  clearResultDiagnostics("r2r");
  publishR2rWorkflowState();
  st.textContent = runtimeText("Uploading…", "上传中…");
  toast(runtimeText("Uploading source trajectory…", "上传源轨迹…"));
  try {
    switchInspectorPanel("r2r");
    if (!r2r.active) r2rEnterPanel();
    const qsParts = [
      `source_robot=${encodeURIComponent(sourceName)}`,
      `profile=${encodeURIComponent(profile)}`,
    ];
    const srcFps = parseOptionalFps(document.getElementById("r2r-source-fps"));
    if (srcFps != null) qsParts.push(`source_fps=${encodeURIComponent(srcFps)}`);
    const qs = qsParts.join("&");
    const { job_id } = await uploadFilesXHR(
      `/api/r2r/source/upload?${qs}`,
      files,
      {},
      (frac) => {
        const progress = frac ?? 0;
        if (bar) bar.style.width = `${Math.max(2, progress * 18).toFixed(0)}%`;
        st.textContent = runtimeText(
          `Uploading ${Math.round(progress * 100)}%…`,
          `上传 ${Math.round(progress * 100)}%…`,
        );
      },
    );
    const data = await waitMotionJob<R2rSourceTrajectoryResult>(job_id, (frac, sub) => {
      if (bar) bar.style.width = `${Math.max(2, 18 + frac * 82).toFixed(0)}%`;
      st.textContent = sub;
    }, { uploadFrac: 0.18 });
    const fallbackStem = (files[0].name || "source").replace(/\.[^.]+$/, "");
    const loadResult = await r2rApplySourceTrajectoryResult(
      data,
      sourcePayload,
      fallbackStem,
    );
    if (loadResult === "stale") return;
    toast(runtimeText(
      `Uploaded ${data.num_frames} frames; playing the source trajectory`,
      `上传成功：${data.num_frames} 帧，正在播放源机器人轨迹`,
    ));
  } catch (e) {
    r2rTrajectoryState = "failed";
    st.textContent = "";
    if (prog) prog.style.display = "none";
    publishR2rWorkflowState();
    toast(errorMessage(e), true);
  }
}

async function r2rApplySourceTrajectoryResult(
  data: R2rSourceTrajectoryResult,
  sourcePayload: RobotPayload,
  fallbackStem: string,
): Promise<AsyncStageViewLoadResult> {
  const status = document.getElementById("r2r-traj-status");
  const progress = document.getElementById("r2r-traj-progress");
  const bar = progress?.querySelector<HTMLElement>(".bar");
  const sourceStem = data.name || fallbackStem || "source";

  // Replacing the source View changes calibration identity even when the robot
  // name stays the same, so pending bootstrap/status continuations lose ownership.
  prepareR2rRobotReplacement();
  const attempt = startRobotViewLoad(r2rSrc, sourcePayload);
  let loadResult: AsyncStageViewLoadResult;
  try {
    loadResult = await attempt.completion;
  } catch (error) {
    if (!r2rSrc.isLoadGenerationCurrent(attempt.generation)) return "stale";
    clearR2rSourceAfterViewLoss("R2R trajectory source load");
    throw error;
  }
  if (
    loadResult === "stale"
    || !r2rSrc.isLoadGenerationCurrent(attempt.generation)
  ) return "stale";

  prepareR2rRobotReplacement();
  r2r.sourceToken = data.token;
  r2rTrajectoryState = "idle";
  r2r.sourceStem = sourceStem;
  r2r.hasScene = !!data.has_scene;
  if (data.suggested_backend) r2rApplySuggestedBackend(data.suggested_backend);
  r2rSrc.setTrajectory(data.trajectory);
  if (data.skeleton_preview) {
    r2rSrcSkel.load(data.skeleton_preview);
    const skBtn = document.getElementById("r2r-tg-src-skel");
    if (skBtn) skBtn.disabled = false;
  }
  const clipDur = Math.max(0.1, (data.num_frames - 1) / (data.framerate || 30));
  r2rLoadSrcScene(data.scaled_scene, data.token, clipDur);
  r2rVis.srcRobot = true;
  r2rVis.srcSkel = false;
  r2rVis.srcEnv = !!data.scaled_scene;
  r2rVis.tgtRobot = false;
  r2rVis.tgtSkel = false;
  r2rVis.tgtEnv = false;
  player.ready(r2rSrc.clipDuration || 1);
  player.seek(0);
  r2rApplyStage();
  r2rFocus(r2rSrc);
  player.setPlaying(true);
  const profile = data.upload_profile ? ` · ${data.upload_profile}` : "";
  if (status) {
    status.textContent = runtimeText(
      `Loaded: ${data.num_frames} frames @ ${data.framerate.toFixed(1)} fps${profile}`,
      `已加载：${data.num_frames} 帧 @ ${data.framerate.toFixed(1)} fps${profile}`,
    );
  }
  const selection = document.getElementById("r2r-trajectory-value");
  if (selection) selection.textContent = sourceStem;
  if (progress) progress.style.display = "block";
  if (bar) bar.style.width = "100%";
  publishR2rWorkflowState();
  await r2rUpdateRetargetBtn();
  return "committed";
}

/** Load an existing robot trajectory through the R2R-only backend boundary. */
async function loadR2rLibraryEntry(entry: LibraryEntry): Promise<void> {
  if (!(await r2rEnsureSourceLoaded())) {
    throw new Error(runtimeText(
      "Load the source robot before selecting its trajectory.",
      "请先加载源机器人，再选择对应轨迹。",
    ));
  }
  const sourceName = r2r.sourceName;
  const sourcePayload = r2r.sourcePayload;
  if (!sourceName || !sourcePayload) return;

  const status = document.getElementById("r2r-traj-status");
  const progress = document.getElementById("r2r-traj-progress");
  const bar = progress?.querySelector<HTMLElement>(".bar");
  if (progress) {
    progress.style.display = "block";
    progress.classList.remove("indet");
  }
  if (bar) bar.style.width = "2%";
  if (status) status.textContent = runtimeText("Validating trajectory…", "正在校验机器人轨迹……");
  r2rTrajectoryState = "validating";
  r2r.exportToken = null;
  r2rRunState = "idle";
  clearResultDiagnostics("r2r");
  publishR2rWorkflowState();

  try {
    switchInspectorPanel("r2r");
    if (!r2r.active) r2rEnterPanel();
    const sourceFps = parseOptionalFps(document.getElementById("r2r-source-fps"));
    const { job_id } = await API.post("/api/r2r/source/library", {
      ...entry,
      source_robot: sourceName,
      source_fps: sourceFps,
    });
    const data = await waitMotionJob<R2rSourceTrajectoryResult>(job_id, (frac, sub) => {
      if (bar) bar.style.width = `${Math.max(2, frac * 100).toFixed(0)}%`;
      if (status) status.textContent = sub;
    });
    const fallbackStem = entry.stem || entry.sequence_id || "source";
    const loadResult = await r2rApplySourceTrajectoryResult(
      data,
      sourcePayload,
      fallbackStem,
    );
    if (loadResult === "stale") return;
    toast(runtimeText(
      `Loaded robot trajectory: ${data.name || fallbackStem}`,
      `机器人轨迹已加载：${data.name || fallbackStem}`,
    ));
  } catch (error) {
    r2rTrajectoryState = "failed";
    if (status) status.textContent = "";
    if (progress) progress.style.display = "none";
    publishR2rWorkflowState();
    toast(errorMessage(error), true);
    throw error;
  }
}

async function pickR2rTrajectory(
  { folder = false }: { folder?: boolean } = {},
): Promise<void> {
  const files = await pickFiles({
    folder,
    accept: folder ? "" : ".csv,.pkl,.npz",
  });
  await r2rUploadTraj(files, "auto");
}

function r2rSuggestedBackendForProfile(profile: string): string {
  const p = (profile || "mimic").toLowerCase();
  if (p === "intermimic" || p === "meshmimic") return "interaction_mesh";
  return "newton";
}

function r2rApplySuggestedBackend(backend: string | null | undefined): void {
  if (!backend) return;
  const rb = document.getElementById("r2r-backend");
  const bb = document.getElementById("r2r-batch-backend");
  if (rb) rb.value = backend;
  if (bb) bb.value = backend;
}

function r2rIngestTraj(files: UploadFile[], profile = "auto"): void {
  if (!files?.length) return;
  if (profile && profile !== "auto") {
    r2rApplySuggestedBackend(r2rSuggestedBackendForProfile(profile));
  }
  void r2rUploadTraj(files, profile);
}

// --------------------------------------------------------------- retarget
async function r2rRunRetarget(): Promise<void> {
  if (!r2r.sourceToken || !r2r.targetName || !r2r.sourceName) {
    toast(runtimeText(
      "Upload a source trajectory and load the target robot first",
      "请先上传源轨迹并加载目标机器人",
    ), true);
    return;
  }
  const calibrationResult = await r2rEnsureCalibration({ auto: true });
  if (calibrationResult !== "ready") return;
  const prog = document.getElementById("r2r-progress");
  const bar = prog.querySelector<HTMLElement>(".bar");
  const status = document.getElementById("r2r-status");
  if (!bar) throw new Error("R2R progress bar is missing");
  prog.style.display = "block";
  prog.classList.add("indet");
  bar.style.width = "0%";
  renderSpinnerStatus(status, runtimeText(
    "Retargeting… The first run for a new robot is slower.",
    "正在 retarget…（新机器人首次较慢）",
  ));
  document.getElementById("r2r-retarget-btn").disabled = true;
  r2rRunState = "running";
  r2r.exportToken = null;
  clearResultDiagnostics("r2r");
  publishR2rWorkflowState();
  try {
    const body: R2rRetargetRequest = {
      target: r2r.targetName,
      source: r2r.sourceName,
      source_token: r2r.sourceToken,
      backend: document.getElementById("r2r-backend")?.value || "newton",
    };
    const fps = parseOptionalFps(document.getElementById("r2r-retarget-fps"));
    if (fps) body.retarget_fps = fps;
    const { job_id } = await API.post("/api/r2r/retarget", body);
    const j = await pollJob<RetargetResult>(job_id, (jp) => {
      setRetargetProgress(prog, bar, jp);
      renderSpinnerStatus(status, jp.message || runtimeText("Retargeting…", "正在 retarget…"));
    });
    let targetPayload = r2r.targetPayload;
    if (!targetPayload) {
      targetPayload = await API.post("/api/robot/select", { name: r2r.targetName });
    }
    if (!targetPayload) throw new Error("Target robot payload is missing");
    prepareR2rRobotReplacement();
    const attempt = startRobotViewLoad(r2rTgt, targetPayload);
    let targetLoadResult: AsyncStageViewLoadResult;
    try {
      targetLoadResult = await attempt.completion;
    } catch (error) {
      if (!r2rTgt.isLoadGenerationCurrent(attempt.generation)) return;
      clearR2rTargetAfterViewLoss("R2R result target load");
      toast(errorMessage(error), true);
      return;
    }
    if (
      targetLoadResult === "stale"
      || !r2rTgt.isLoadGenerationCurrent(attempt.generation)
    ) return;
    prepareR2rRobotReplacement();
    r2r.targetPayload = targetPayload;
    prog.classList.remove("indet");
    bar.style.width = "100%";
    r2rTgt.setTrajectory(j.result.trajectory);
    if (j.result.scaled_preview) {
      r2rTgtSkel.load(j.result.scaled_preview);
      document.getElementById("r2r-tg-tgt-skel").disabled = false;
    }
    const tgtDur = Math.max(
      0.1,
      ((j.result.num_frames || 1) - 1) / (j.result.source_fps || 30),
    );
    r2rLoadTgtScene(j.result.scaled_scene, r2r.sourceToken, tgtDur);
    document.getElementById("r2r-tg-tgt-robot").disabled = false;
    r2r.exportToken = j.result.export_token;
    r2rRunState = "completed";
    r2r.exportHasScene = !!j.result.has_scene;
    r2r.resultStem = j.result.stem || r2r.sourceStem || "r2r";
    r2rVis.tgtRobot = true;
    r2rVis.tgtSkel = !!j.result.scaled_preview;
    r2rVis.tgtEnv = !!j.result.scaled_scene;
    player.ready(r2rTgt.clipDuration || 1);
    applyR2rComparisonPreset(comparisonPresets.r2r);
    emitResultDiagnostics("r2r", j.result.diagnostics ?? {
      schema_version: 1,
      available: false,
      reason: runtimeText(
        "The current result did not return usable tracking/contact diagnostics.",
        "当前结果未返回可用的 tracking/contact 诊断。",
      ),
    });
    player.seek(0);
    r2rApplyStage();
    r2rFocus(r2rTgt);
    player.setPlaying(true);
    status.textContent = runtimeText(
      `Completed: ${j.result.num_frames} frames @ ${(j.result.source_fps || 30).toFixed(1)} fps`,
      `完成：${j.result.num_frames} 帧 @ ${(j.result.source_fps || 30).toFixed(1)} fps`,
    );
    document.getElementById("r2r-export-card").style.display = "block";
    document.getElementById("r2r-export-fps").value = "";
    const r2rT0 = document.getElementById("r2r-export-t-start");
    const r2rT1 = document.getElementById("r2r-export-t-end");
    if (r2rT0) r2rT0.value = "";
    if (r2rT1) r2rT1.value = "";
    const r2rBundleHint = document.getElementById("r2r-export-bundle-hint");
    if (r2rBundleHint) r2rBundleHint.style.display = j.result.has_scene ? "block" : "none";
    publishR2rWorkflowState();
    toast(runtimeText(
      "R2R retarget complete; playing the target robot",
      "R2R Retarget 完成，正在播放目标机器人",
    ));
  } catch (e) {
    status.textContent = "";
    prog.classList.remove("indet");
    r2rRunState = "failed";
    toast(errorMessage(e), true);
  } finally {
    publishR2rWorkflowState();
  }
}

// --------------------------------------------------------------- batch
function r2rRenderBasket() {
  const list = document.getElementById("r2r-basket-list");
  if (!list) return;
  list.replaceChildren();
  if (!r2r.basket.length) {
    const empty = document.createElement("div");
    empty.className = "batch-basket-empty";
    empty.append(
      textElement("strong", "", runtimeText("No robot trajectories yet", "还没有机器人轨迹")),
      document.createTextNode(runtimeText(
        "Import trajectory files or folders to build this R2R batch.",
        "导入轨迹文件或文件夹来建立 R2R 批量任务。",
      )),
    );
    list.appendChild(empty);
  }
  for (const e of r2r.basket) {
    const row = document.createElement("div");
    row.className = "batch-basket-row r2r-batch-basket-row";
    const label = e.export_subdir ? `${e.export_subdir}/${e.stem}` : e.stem;
    const main = textElement("span", "batch-basket-main", label);
    const profile = textElement(
      "span",
      "batch-basket-type",
      e.upload_profile || "mimic",
    );
    const actions = document.createElement("span");
    actions.className = "batch-basket-actions";
    const removeButton = textElement("button", "batch-basket-remove rm", "×");
    removeButton.type = "button";
    removeButton.setAttribute("aria-label", runtimeText(`Remove ${label}`, `移除 ${label}`));
    removeButton.onclick = () => {
      r2r.basket = r2r.basket.filter((x) => x !== e);
      r2rRenderBasket();
    };
    actions.appendChild(removeButton);
    row.append(main, profile, actions);
    list.appendChild(row);
  }
  const count = String(r2r.basket.length);
  for (const id of ["r2r-basket-count", "r2r-batch-inspector-count"]) {
    const element = document.getElementById(id);
    if (element) element.textContent = count;
  }
  const clearButton = document.getElementById("r2r-basket-clear") as HTMLButtonElement | null;
  if (clearButton) clearButton.disabled = !r2r.basket.length;
  const summary = document.getElementById("r2r-batch-stage-summary");
  if (summary) {
    summary.textContent = r2r.basket.length
      ? runtimeText(
        `${r2r.basket.length} robot trajectories ready`,
        `已准备 ${r2r.basket.length} 条机器人轨迹`,
      )
      : runtimeText("No robot trajectories selected", "尚未选择机器人轨迹");
  }
  const runSummary = document.getElementById("r2r-batch-run-summary");
  if (runSummary) {
    runSummary.textContent = r2r.basket.length
      ? runtimeText(
        `${r2r.basket.length} trajectories · ${r2r.sourceName || "no source robot"} → ${r2r.targetName || "no target robot"}`,
        `${r2r.basket.length} 条轨迹 · ${r2r.sourceName || "未加载源机器人"} → ${r2r.targetName || "未加载目标机器人"}`,
      )
      : runtimeText("No source trajectories selected.", "尚未选择源轨迹。");
  }
  const runBtn = document.getElementById("r2r-batch-run");
  const ready = Boolean(
    r2r.basket.length && r2r.targetName && r2r.sourceName && r2r.calibrated,
  );
  if (runBtn) runBtn.disabled = !ready;
  const disabledReason = document.getElementById("r2r-batch-disabled-reason");
  if (disabledReason) {
    if (!r2r.basket.length) {
      disabledReason.textContent = runtimeText(
        "Add at least one source trajectory.",
        "请至少添加一条源轨迹。",
      );
    } else if (!r2r.sourceName) {
      disabledReason.textContent = runtimeText("Load the source robot.", "请加载源机器人。");
    } else if (!r2r.targetName) {
      disabledReason.textContent = runtimeText("Load the target robot.", "请加载目标机器人。");
    } else if (!r2r.calibrated) {
      disabledReason.textContent = runtimeText(
        "Calibrate this robot pair in Robot → Robot first.",
        "请先在“机器人 → 机器人”中完成这组机器人的标定。",
      );
    } else {
      disabledReason.textContent = "";
    }
  }
}

async function r2rIngestBasket(
  files: UploadFile[],
  profile = "auto",
): Promise<void> {
  if (!files?.length) return;
  showLoading(runtimeText(
    `Uploading R2R batch… (${files.length} files)`,
    `R2R 批量上传… (${files.length} 个文件)`,
  ));
  try {
    const { job_id } = await uploadFilesXHR(
      `/api/r2r/basket/upload?profile=${encodeURIComponent(profile)}`,
      files,
      {},
      (frac) => setLoadingProgress(
        (frac ?? 0) * 0.4,
        runtimeText("Uploading…", "上传中…"),
      ),
    );
    const payload = await waitMotionJob<R2rBasketUploadResult>(job_id, (frac, sub) => {
      setLoadingProgress(0.4 + frac * 0.6, sub);
    }, { uploadFrac: 0.4 });
    const entries = payload.entries || [];
    for (const e of entries) {
      if (!r2r.basket.find((x) => x.source_path === e.source_path)) r2r.basket.push(e);
    }
    const last = entries[entries.length - 1];
    if (last?.suggested_backend) r2rApplySuggestedBackend(last.suggested_backend);
    else if (profile && profile !== "auto") {
      r2rApplySuggestedBackend(r2rSuggestedBackendForProfile(profile));
    }
    r2rRenderBasket();
    toast(runtimeText(
      `Added to basket: ${entries.length} clips (${payload.profile || profile})`,
      `已加入篮子：${entries.length} 个 clip（${payload.profile || profile}）`,
    ));
  } catch (e) {
    toast(errorMessage(e), true);
  } finally {
    hideLoading();
  }
}

// --------------------------------------------------------------- wiring
function r2rInit(): void {
  void r2rPopulateSelects();
  for (const el of document.querySelectorAll<HTMLElement>("[data-r2r-profile]")) {
    const prof = el.dataset.r2rProfile || "mimic";
    setupDropzone(el, (files) => r2rIngestTraj(files, prof));
  }
  document.querySelectorAll<HTMLElement>("[data-r2r-pick]").forEach((btn) => {
    btn.onclick = async () => {
      const prof = btn.dataset.r2rPick || "mimic";
      const folder = btn.dataset.folder === "1";
      await r2rIngestTraj(await pickFiles({ folder }), prof);
    };
  });
  setupDropzone(document.getElementById("r2r-basket-drop"), (files) => r2rIngestBasket(files, "auto"));
  const toggleBindings: Array<readonly [string, R2rVisibilityKey]> = [
    ["r2r-tg-src-robot", "srcRobot"],
    ["r2r-tg-src-skel", "srcSkel"],
    ["r2r-tg-src-env", "srcEnv"],
    ["r2r-tg-tgt-robot", "tgtRobot"],
    ["r2r-tg-tgt-skel", "tgtSkel"],
    ["r2r-tg-tgt-env", "tgtEnv"],
  ];
  for (const [id, key] of toggleBindings) {
    document.getElementById(id)?.addEventListener("click", (ev) => {
      const button = ev.currentTarget as HTMLButtonElement;
      if (button.disabled) return;
      r2rVis[key] = !r2rVis[key];
      r2rApplyStage();
    });
  }
  document.getElementById("r2r-source-load")?.addEventListener("click", () => {
    const name = (document.getElementById("r2r-source-select") as HTMLSelectElement | null)?.value || "";
    void r2rLoadSourceRobot(name);
  });
  document.getElementById("r2r-batch-source-load")?.addEventListener("click", () => {
    const name = (document.getElementById("r2r-batch-source-select") as HTMLSelectElement | null)?.value || "";
    void r2rLoadSourceRobot(name, { activateWorkspace: false });
  });
  document.getElementById("r2r-target-load")?.addEventListener("click", () => {
    const name = (document.getElementById("r2r-target-select") as HTMLSelectElement | null)?.value || "";
    void r2rLoadTargetRobot(name);
  });
  document.getElementById("r2r-batch-target-load")?.addEventListener("click", () => {
    const name = (document.getElementById("r2r-batch-target-select") as HTMLSelectElement | null)?.value || "";
    void r2rLoadTargetRobot(name);
  });
  document.getElementById("r2r-calib-btn").onclick = () => void r2rStartCalib();
  document.getElementById("r2r-calib-zero").onclick = () => {
    void applyCalibrationComparison("r2r", "zero");
    toast(runtimeText("Reset to the URDF zero pose", "已归零（URDF 零位）"));
  };
  document.getElementById("r2r-calib-cancel").onclick = () => {
    r2rExitCalib();
    toast(runtimeText("Calibration cancelled", "已取消标定"));
    void r2rUpdateRetargetBtn();
  };
  document.getElementById("r2r-calib-save").onclick = () => void r2rSaveCalib();
  document.getElementById("r2r-retarget-btn").onclick = () => void r2rRunRetarget();
  document.getElementById("r2r-export-btn").onclick = async () => {
    if (!r2r.exportToken) {
      toast(runtimeText("Complete Retarget first", "请先完成 Retarget"), true);
      return;
    }
    const fps = parseFloat(document.getElementById("r2r-export-fps").value);
    const fmt = document.getElementById("r2r-export-format")?.value || "csv";
    let url = `/api/export/${r2r.exportToken}?fmt=${encodeURIComponent(fmt)}`;
    if (fps && fps > 0) url += `&fps=${fps}`;
    if (!document.getElementById("r2r-csv-header").checked) url += "&csv_header=0";
    url = appendExportTimeParams(url, "r2r-export-t-start", "r2r-export-t-end");
    const stem = r2r.resultStem || "r2r";
    const name = r2r.exportHasScene || fmt === "pkl"
      ? `${stem}_export.zip`
      : (fmt === "pkl" ? `${stem}.pkl` : `${stem}.csv`);
    try {
      await triggerBrowserDownload(url, name);
      toast(runtimeText(
        "Download started (saved to the browser's default download directory)",
        "已开始下载（保存到浏览器默认下载目录）",
      ));
    } catch (e) { toast(errorMessage(e), true); }
  };
  document.getElementById("r2r-basket-clear")?.addEventListener("click", () => {
    r2r.basket = [];
    r2rRenderBasket();
  });
  document.getElementById("r2r-batch-pick-file")?.addEventListener("click", async () => {
    await r2rIngestBasket(await pickFiles({ accept: ".csv,.pkl,.npz" }), "auto");
  });
  document.getElementById("r2r-batch-pick-folder")?.addEventListener("click", async () => {
    await r2rIngestBasket(await pickFiles({ folder: true }), "auto");
  });
  document.getElementById("r2r-batch-run")?.addEventListener("click", async () => {
    if (!r2r.basket.length || !r2r.targetName || !r2r.sourceName) return;
    const prog = document.getElementById("r2r-batch-progress");
    const bar = prog?.querySelector<HTMLElement>(".bar");
    const status = document.getElementById("r2r-batch-status");
    prog.style.display = "block";
    if (bar) bar.style.width = "0%";
    renderSpinnerStatus(status, runtimeText("Processing R2R batch…", "批量 R2R 处理中…"));
    try {
      const body: R2rBatchRequest = {
        target: r2r.targetName,
        source: r2r.sourceName,
        entries: r2r.basket,
        backend: document.getElementById("r2r-batch-backend")?.value || "newton",
        out_dir: document.getElementById("r2r-batch-out")?.value || "r2r_batch_export",
        format: document.getElementById("r2r-batch-format")?.value || "csv",
        csv_header: document.getElementById("r2r-batch-csv-header")?.checked !== false,
      };
      const exFps = parseOptionalFps(document.getElementById("r2r-batch-export-fps"));
      const rtFps = parseOptionalFps(document.getElementById("r2r-batch-retarget-fps"));
      const srcFps = parseOptionalFps(document.getElementById("r2r-batch-source-fps"));
      if (exFps) body.export_fps = exFps;
      if (rtFps) body.retarget_fps = rtFps;
      if (srcFps) body.source_fps = srcFps;
      const t0 = parseOptionalTime(document.getElementById("r2r-batch-t-start"));
      const t1 = parseOptionalTime(document.getElementById("r2r-batch-t-end"));
      if (t0 != null) body.t_start = t0;
      if (t1 != null) body.t_end = t1;
      const { job_id } = await API.post("/api/r2r/batch/retarget", body);
      const j = await pollJob<BatchRetargetResult>(job_id, (jp) => {
        if (bar) bar.style.width = `${Math.max(2, (jp.progress || 0) * 100).toFixed(0)}%`;
        status.textContent = jp.message || "";
      });
      if (bar) bar.style.width = "100%";
      const r = j.result;
      status.textContent = runtimeText(
        `Completed: ${r.written?.length ?? 0} clips`,
        `完成：${r.written?.length ?? 0} 个 clip`,
      );
      if (r.download_name) {
        await triggerBrowserDownload(`/api/job/${job_id}/download`, r.download_name);
        toast(runtimeText("Batch ZIP download started", "批量 ZIP 已开始下载"));
      }
    } catch (e) {
      status.textContent = "";
      toast(errorMessage(e), true);
    }
  });
  r2rRenderBasket();
}

// =================================================================  INIT
/**
 * Module bootstrap contract: React has already committed every compatibility
 * DOM id. `__hhtoolsReady` means bindings and the RAF loop are live; catalog,
 * robot, reference, and health requests continue asynchronously in `init`.
 */
animate(); // start the render loop now that `player` is initialised
window.__hh = { skel, mesh, skin, scaledSkel, robot, player, scene, world }; // debug handle
window.__hhtoolsReady = true;
window.addEventListener("hhtools:calibration-editor-command", (event) => {
  void handleCalibrationEditorCommand(event);
});

// Narrow capability bridge for dataset-viz, which is loaded next. Keeping this
// explicit avoids importing or reaching into this module's private singleton state.
window.__hhApp = {
  API,
  toast,
  loadLibraryEntry,
  loadHumanMotionEntry,
  loadR2rLibraryEntry,
  pickR2rTrajectory,
  previewRobotClip,
  populateDvRobotSelect,
  addToBasket,
  switchInspectorPanel,
  getLibrarySourceRoot: () => libSourceRoot,
  refreshLibrary,
  pickFiles,
  collectDroppedFiles,
  waitMotionJob,
  uploadFilesXHR,
};

async function verifyUiBuild() {
  try {
    const h = await API.get("/api/health");
    const el = document.getElementById("ui-build");
    if (el) el.textContent = `UI·${h.ui_build || "?"}`;
    if (h.motions_library_root) libMotionsRoot = h.motions_library_root;
    const assetsHint = document.getElementById("motion-assets-hint");
    if (assetsHint && h.source_root) assetsHint.textContent = h.source_root;
    const missingFeatures =
      !h.ui_features?.view_hud ||
      !h.ui_features?.scaled_skeleton_toggle ||
      h.ui_features?.merged_robot_panel === false;
    if (missingFeatures) {
      toast(
        "服务端静态资源可能过旧（缺少新版 UI 特性）。请在仓库根目录执行 uv sync 后 uv run hhtools web 重启。",
        true,
      );
    }
  } catch {
    /* offline / API down — boot overlay handles it */
  }
}

(async function init() {
  wrapSelectDropdowns();
  installJobHistoryBridge();
  // React owns panel dimensions and persistence; the runtime only consumes the resulting canvas size.
  document.getElementById("lib-link-path")?.addEventListener("click", () => linkLibraryPath());
  await verifyUiBuild();
  // Independent catalogs load together; none is allowed to delay the others.
  await Promise.all([loadReferenceCatalog(), refreshLibrary(), refreshRobotList()]);
  renderBasket();
  r2rInit();
  switchInspectorPanel(initialWorkspacePreferences.activePanel);
  // Reconcile initial HUD preferences after catalogs and the active workflow
  // have established their resource/ownership state.
  markH2rStageDisplayChanged();
  publishPlaybackState();
  emitComparisonState("h2r");
  emitComparisonState("r2r");
  publishH2rWorkflowState();
  publishR2rWorkflowState();
  const tour = initTutorial(toast);
  tour.maybeAutoStart();
})();
