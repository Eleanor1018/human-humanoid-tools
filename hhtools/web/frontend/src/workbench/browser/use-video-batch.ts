import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  GvhmrRuntimeStatus,
  HhAppBridge,
  JobStartResponse,
  LibraryEntry,
  MotionPayload,
  UploadFile,
} from "@/runtime/types";
import type { WorkspaceLocale } from "@/workbench/common/workspace";
import type { JobStatusResponse } from "@/workbench/services/jobs/common/job-service";
import { useWorkbenchServices } from "./workbench-service-context";

export type VideoBatchStatus =
  "queued" | "uploading" | "running" | "done" | "error";

export interface VideoBatchItem {
  id: string;
  file: UploadFile;
  progress: number;
  status: VideoBatchStatus;
  message: string;
  result?: LibraryEntry;
}

export interface VideoBatchModel {
  videos: VideoBatchItem[];
  runtime: GvhmrRuntimeStatus | null;
  runtimeChecking: boolean;
  runtimeError: string;
  environmentConfirmed: boolean;
  staticCamera: boolean;
  focalLength: string;
  busy: boolean;
  statusMessage: string;
  completedCount: number;
  errorCount: number;
  aggregateProgress: number;
  canRun: boolean;
  pickVideos(folder?: boolean): Promise<void>;
  dropVideos(dataTransfer: DataTransfer | null): Promise<void>;
  removeVideo(id: string): void;
  clearVideos(): void;
  refreshRuntime(): Promise<void>;
  confirmEnvironment(): void;
  setStaticCamera(value: boolean): void;
  setFocalLength(value: string): void;
  runBatch(): Promise<void>;
}

const VIDEO_SUFFIXES = new Set(["mp4", "mov", "mkv", "avi", "webm", "m4v"]);
const VIDEO_ACCEPT = ".mp4,.mov,.mkv,.avi,.webm,.m4v,video/*";
const UPLOAD_PROGRESS_WEIGHT = 0.08;

type LegacyVideoBatchBridge = Pick<
  HhAppBridge,
  | "pickFiles"
  | "collectDroppedFiles"
  | "addToBasket"
  | "refreshLibrary"
  | "toast"
>;

/**
 * Return only the currently available legacy capabilities used by this slice.
 * Lifecycle waiting belongs to `requireLegacyBridge`, not to this synchronous
 * accessor, because drop-event file handles cannot survive an async wait.
 */
function legacyVideoBatchBridge(): LegacyVideoBatchBridge | null {
  return window.__hhApp ?? null;
}

function boundedProgress(value: number | null | undefined): number {
  return Math.max(0, Math.min(1, value ?? 0));
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/** React model shared by the center input view and right-side V2M inspector. */
export function useVideoBatch(locale: WorkspaceLocale): VideoBatchModel {
  const { jobService, legacyRuntimeService, requestService } =
    useWorkbenchServices();
  const text = useCallback(
    (en: string, zh: string) => (locale === "zh-CN" ? zh : en),
    [locale],
  );
  const [videos, setVideos] = useState<VideoBatchItem[]>([]);
  // Async jobs span many React renders. The ref lets the sequential runner
  // read the latest queue without making runBatch depend on the whole array.
  const videosRef = useRef(videos);
  videosRef.current = videos;
  const [runtime, setRuntime] = useState<GvhmrRuntimeStatus | null>(null);
  const [runtimeChecking, setRuntimeChecking] = useState(false);
  const [runtimeError, setRuntimeError] = useState("");
  const [environmentConfirmed, setEnvironmentConfirmed] = useState(false);
  const [staticCamera, setStaticCamera] = useState(true);
  const [focalLength, setFocalLength] = useState("");
  const [busy, setBusy] = useState(false);
  const [statusMessage, setStatusMessage] = useState("");
  const nextId = useRef(1);
  const mounted = useRef(true);
  const runAbortController = useRef<AbortController | null>(null);
  const runtimeStatusAbortController = useRef<AbortController | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      runAbortController.current?.abort();
      runtimeStatusAbortController.current?.abort();
    };
  }, []);

  const requireLegacyBridge = useCallback(
    async (): Promise<LegacyVideoBatchBridge> => {
      // File picking and library publication are still legacy capabilities. Wait
      // on their injected lifecycle owner instead of polling a window property.
      await legacyRuntimeService.start();
      const bridge = legacyVideoBatchBridge();
      if (!bridge) {
        throw new Error(
          text(
            "The compatibility UI is not ready.",
            "兼容界面尚未就绪。",
          ),
        );
      }
      return bridge;
    },
    [legacyRuntimeService, text],
  );

  const toast = useCallback((message: string, isError = false) => {
    legacyVideoBatchBridge()?.toast(message, isError);
  }, []);

  const formatJobProgress = useCallback(
    (job: JobStatusResponse<MotionPayload>) => {
      const progress = boundedProgress(job.progress);
      const percent = Math.round(progress * 100);
      const detail = job.message?.trim();
      const message = text(
        `Generating motion… ${percent}%`,
        `正在生成动作…… ${percent}%`,
      );
      return {
        progress:
          UPLOAD_PROGRESS_WEIGHT +
          progress * (1 - UPLOAD_PROGRESS_WEIGHT),
        message: detail ? `${message} · ${detail}` : message,
      };
    },
    [text],
  );

  const addFiles = useCallback(
    (files: UploadFile[]) => {
      let rejected = 0;
      // Browser and Electron folder pickers expose paths differently, so the
      // dedupe key combines their relative-path variants with file metadata.
      setVideos((current) => {
        const existing = new Set(
          current.map(
            (item) =>
              `${item.file._relpath || item.file.webkitRelativePath || item.file.name}:${item.file.size}:${item.file.lastModified}`,
          ),
        );
        const additions: VideoBatchItem[] = [];
        for (const file of files) {
          const suffix = file.name.toLowerCase().split(".").pop() || "";
          if (!VIDEO_SUFFIXES.has(suffix)) {
            rejected += 1;
            continue;
          }
          const key = `${file._relpath || file.webkitRelativePath || file.name}:${file.size}:${file.lastModified}`;
          if (existing.has(key)) continue;
          existing.add(key);
          additions.push({
            id: `v2m-${nextId.current++}`,
            file,
            progress: 0,
            status: "queued",
            message: "",
          });
        }
        return [...current, ...additions];
      });
      if (rejected)
        queueMicrotask(() => {
          if (!mounted.current) return;
          toast(
            text(
              `${rejected} unsupported file(s) were skipped.`,
              `已跳过 ${rejected} 个不支持的文件。`,
            ),
            true,
          );
        });
    },
    [text, toast],
  );

  const pickVideos = useCallback(
    async (folder = false) => {
      try {
        const bridge = await requireLegacyBridge();
        if (!mounted.current) return;
        const files = await bridge.pickFiles({
          folder,
          accept: folder ? "" : VIDEO_ACCEPT,
        });
        if (mounted.current) addFiles(files);
      } catch (cause) {
        toast(
          cause instanceof Error ? cause.message : String(cause),
          true,
        );
      }
    },
    [addFiles, requireLegacyBridge, toast],
  );
  const dropVideos = useCallback(
    async (dataTransfer: DataTransfer | null) => {
      if (busy) return;
      try {
        const readyBridge = legacyVideoBatchBridge();
        if (!readyBridge) {
          // DataTransfer directory entries expire after native event dispatch.
          // Start the contribution for the next attempt, but never await it
          // before capturing files from this event.
          setStatusMessage(
            text(
              "The interface is still starting. Drop the files again shortly.",
              "界面仍在启动，请稍后重新拖入文件。",
            ),
          );
          void legacyRuntimeService.start().catch(() => undefined);
          return;
        }
        const collection = readyBridge.collectDroppedFiles(dataTransfer);
        const files = await collection;
        if (mounted.current) addFiles(files);
      } catch (cause) {
        toast(
          cause instanceof Error ? cause.message : String(cause),
          true,
        );
      }
    },
    [addFiles, busy, legacyRuntimeService, text, toast],
  );
  const refreshRuntime = useCallback(
    async () => {
      runtimeStatusAbortController.current?.abort();
      const controller = new AbortController();
      runtimeStatusAbortController.current = controller;
      setRuntimeChecking(true);
      setRuntimeError("");
      setEnvironmentConfirmed(false);
      try {
        const nextRuntime = await requestService.get<GvhmrRuntimeStatus>(
          "/api/video-to-motion/status",
          { signal: controller.signal },
        );
        if (!controller.signal.aborted) setRuntime(nextRuntime);
      } catch (cause) {
        if (isAbortError(cause)) return;
        setRuntime(null);
        setRuntimeError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (runtimeStatusAbortController.current === controller) {
          runtimeStatusAbortController.current = null;
          if (mounted.current) setRuntimeChecking(false);
        }
      }
    },
    [requestService],
  );
  useEffect(() => {
    void refreshRuntime();
  }, [refreshRuntime]);

  const completedCount = videos.filter((item) => item.status === "done").length;
  const errorCount = videos.filter((item) => item.status === "error").length;
  const aggregateProgress = videos.length
    ? videos.reduce((sum, item) => sum + item.progress, 0) / videos.length
    : 0;
  const canRun =
    !busy &&
    videos.some((item) => item.status !== "done") &&
    runtime?.ready === true &&
    environmentConfirmed;

  const runBatch = useCallback(async () => {
    if (!canRun) return;
    const rawFocalLength = focalLength.trim();
    const fMm = rawFocalLength ? Number(rawFocalLength) : undefined;
    if (fMm !== undefined && (!Number.isSafeInteger(fMm) || fMm <= 0)) {
      toast(
        text("Focal length must be a positive integer.", "焦距必须是正整数。"),
        true,
      );
      return;
    }
    const pending = videosRef.current.filter((item) => item.status !== "done");
    const generated: LibraryEntry[] = [];
    let completed = videosRef.current.length - pending.length;
    let failed = 0;
    runAbortController.current?.abort();
    const controller = new AbortController();
    runAbortController.current = controller;
    setBusy(true);
    setStatusMessage(
      text(
        `Processing ${pending.length} video(s)…`,
        `正在处理 ${pending.length} 个视频……`,
      ),
    );
    const patchItem = (id: string, patch: Partial<VideoBatchItem>) => {
      if (!mounted.current || controller.signal.aborted) return;
      setVideos((current) =>
        current.map((item) => (item.id === id ? { ...item, ...patch } : item)),
      );
    };

    try {
      // Run sequentially: multiple GVHMR processes would compete for the same
      // GPU and make progress/error attribution much harder for the user.
      for (let index = 0; index < pending.length; index += 1) {
        const item = pending[index];
        patchItem(item.id, {
          status: "uploading",
          progress: 0,
          message: text("Uploading video…", "正在上传视频……"),
        });
        try {
          const query = new URLSearchParams({
            static_cam: String(staticCamera),
          });
          if (fMm !== undefined) query.set("f_mm", String(fMm));
          const started = await requestService.upload<JobStartResponse>(
            `/api/video-to-motion/upload?${query.toString()}`,
            [
              {
                fieldName: "files",
                data: item.file,
                filename: item.file._relpath || item.file.name,
              },
            ],
            {
              signal: controller.signal,
              onProgress: ({ fraction }) => {
                const uploadProgress = boundedProgress(fraction);
                const percent = Math.round(uploadProgress * 100);
                patchItem(item.id, {
                  progress: uploadProgress * UPLOAD_PROGRESS_WEIGHT,
                  message: text(
                    `Uploading video… ${percent}%`,
                    `正在上传视频…… ${percent}%`,
                  ),
                });
              },
            },
          );
          patchItem(item.id, { status: "running" });
          const payload = await jobService.waitForResult<MotionPayload>(
            started.job_id,
            {
              expectedKind: "video_to_motion",
              signal: controller.signal,
              onProgress: (job) => {
                patchItem(item.id, formatJobProgress(job));
              },
            },
          );
          patchItem(item.id, {
            status: "done",
            progress: 1,
            message: payload.name,
            result: payload.library_entry,
          });
          completed += 1;
          if (payload.library_entry) generated.push(payload.library_entry);
        } catch (cause) {
          // Unmount/disposal aborts the whole client-side batch. Treating it as
          // one failed item would incorrectly submit every remaining video.
          if (controller.signal.aborted || isAbortError(cause)) return;
          failed += 1;
          patchItem(item.id, {
            status: "error",
            message: cause instanceof Error ? cause.message : String(cause),
          });
        }
        if (!mounted.current) return;
        setStatusMessage(
          text(
            `Processed ${index + 1} of ${pending.length}.`,
            `已处理 ${index + 1}/${pending.length}。`,
          ),
        );
      }

      let publicationError = "";
      if (generated.length) {
        // Publishing is a separate compatibility step: generated motions stay
        // successful even if the legacy basket cannot refresh its local view.
        try {
          if (!mounted.current || controller.signal.aborted) return;
          const bridge = await requireLegacyBridge();
          if (!mounted.current || controller.signal.aborted) return;
          await bridge.addToBasket(generated, { silent: true });
          if (!mounted.current || controller.signal.aborted) return;
          await bridge.refreshLibrary();
        } catch (cause) {
          publicationError =
            cause instanceof Error ? cause.message : String(cause);
        }
      }
      if (!mounted.current || controller.signal.aborted) return;
      const summary = text(
        `${completed} completed, ${failed} failed.`,
        `已完成 ${completed} 个，失败 ${failed} 个。`,
      );
      const message = publicationError
        ? `${summary} ${text(
            "Library refresh failed: ",
            "资源库刷新失败：",
          )}${publicationError}`
        : summary;
      setStatusMessage(message);
      toast(message, failed > 0 || Boolean(publicationError));
    } finally {
      if (runAbortController.current === controller) {
        runAbortController.current = null;
        if (mounted.current) setBusy(false);
      }
    }
  }, [
    canRun,
    focalLength,
    formatJobProgress,
    jobService,
    requestService,
    requireLegacyBridge,
    staticCamera,
    text,
    toast,
  ]);

  return useMemo(
    () => ({
      videos,
      runtime,
      runtimeChecking,
      runtimeError,
      environmentConfirmed,
      staticCamera,
      focalLength,
      busy,
      statusMessage,
      completedCount,
      errorCount,
      aggregateProgress,
      canRun,
      pickVideos,
      dropVideos,
      removeVideo: (id: string) => {
        if (!busy)
          setVideos((current) => current.filter((item) => item.id !== id));
      },
      clearVideos: () => {
        if (!busy) {
          setVideos([]);
          setStatusMessage("");
        }
      },
      refreshRuntime,
      confirmEnvironment: () => {
        if (runtime?.ready) setEnvironmentConfirmed(true);
      },
      setStaticCamera,
      setFocalLength,
      runBatch,
    }),
    [
      aggregateProgress,
      busy,
      canRun,
      completedCount,
      dropVideos,
      environmentConfirmed,
      errorCount,
      focalLength,
      pickVideos,
      refreshRuntime,
      runBatch,
      runtime,
      runtimeChecking,
      runtimeError,
      staticCamera,
      statusMessage,
      videos,
    ],
  );
}
