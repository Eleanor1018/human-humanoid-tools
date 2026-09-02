import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  GvhmrRuntimeStatus,
  HhAppBridge,
  LibraryEntry,
  MotionPayload,
  UploadFile,
  WorkspaceLocale,
} from "@/runtime/types";

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

/** React model shared by the center input view and right-side V2M inspector. */
export function useVideoBatch(locale: WorkspaceLocale): VideoBatchModel {
  const text = useCallback(
    (en: string, zh: string) => (locale === "zh-CN" ? zh : en),
    [locale],
  );
  const [videos, setVideos] = useState<VideoBatchItem[]>([]);
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

  const waitForBridge = useCallback(
    async (timeoutMs = 4_000): Promise<HhAppBridge> => {
      const deadline = Date.now() + timeoutMs;
      while (!window.__hhApp && Date.now() < deadline)
        await new Promise((resolve) => window.setTimeout(resolve, 50));
      if (!window.__hhApp)
        throw new Error(
          text(
            "The application runtime is not ready.",
            "应用运行环境尚未就绪。",
          ),
        );
      return window.__hhApp;
    },
    [text],
  );

  const addFiles = useCallback(
    (files: UploadFile[]) => {
      let rejected = 0;
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
        queueMicrotask(() =>
          window.__hhApp?.toast(
            text(
              `${rejected} unsupported file(s) were skipped.`,
              `已跳过 ${rejected} 个不支持的文件。`,
            ),
            true,
          ),
        );
    },
    [text],
  );

  const pickVideos = useCallback(
    async (folder = false) => {
      try {
        const bridge = await waitForBridge();
        addFiles(
          await bridge.pickFiles({
            folder,
            accept: folder ? "" : VIDEO_ACCEPT,
          }),
        );
      } catch (cause) {
        window.__hhApp?.toast(
          cause instanceof Error ? cause.message : String(cause),
          true,
        );
      }
    },
    [addFiles, waitForBridge],
  );
  const dropVideos = useCallback(
    async (dataTransfer: DataTransfer | null) => {
      if (busy) return;
      try {
        const bridge = await waitForBridge();
        addFiles(await bridge.collectDroppedFiles(dataTransfer));
      } catch (cause) {
        window.__hhApp?.toast(
          cause instanceof Error ? cause.message : String(cause),
          true,
        );
      }
    },
    [addFiles, busy, waitForBridge],
  );
  const refreshRuntime = useCallback(async () => {
    setRuntimeChecking(true);
    setRuntimeError("");
    setEnvironmentConfirmed(false);
    try {
      setRuntime(
        await (await waitForBridge()).API.get("/api/video-to-motion/status"),
      );
    } catch (cause) {
      setRuntime(null);
      setRuntimeError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRuntimeChecking(false);
    }
  }, [waitForBridge]);
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
      window.__hhApp?.toast(
        text("Focal length must be a positive integer.", "焦距必须是正整数。"),
        true,
      );
      return;
    }
    const bridge = await waitForBridge();
    const pending = videosRef.current.filter((item) => item.status !== "done");
    const generated: LibraryEntry[] = [];
    let completed = videosRef.current.length - pending.length;
    let failed = 0;
    setBusy(true);
    setStatusMessage(
      text(
        `Processing ${pending.length} video(s)…`,
        `正在处理 ${pending.length} 个视频……`,
      ),
    );
    const patchItem = (id: string, patch: Partial<VideoBatchItem>) =>
      setVideos((current) =>
        current.map((item) => (item.id === id ? { ...item, ...patch } : item)),
      );
    for (let index = 0; index < pending.length; index += 1) {
      const item = pending[index];
      patchItem(item.id, {
        status: "uploading",
        progress: 0,
        message: text("Uploading video…", "正在上传视频……"),
      });
      try {
        const started = await bridge.uploadFilesXHR(
          "/api/video-to-motion/upload",
          [item.file],
          { staticCam: staticCamera, fMm },
          (fraction) =>
            patchItem(item.id, { progress: (fraction ?? 0) * 0.08 }),
        );
        patchItem(item.id, { status: "running" });
        const payload = await bridge.waitMotionJob<MotionPayload>(
          started.job_id,
          (progress, message) => patchItem(item.id, { progress, message }),
          { uploadFrac: 0.08 },
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
        failed += 1;
        patchItem(item.id, {
          status: "error",
          message: cause instanceof Error ? cause.message : String(cause),
        });
      }
      setStatusMessage(
        text(
          `Processed ${index + 1} of ${pending.length}.`,
          `已处理 ${index + 1}/${pending.length}。`,
        ),
      );
    }
    if (generated.length) {
      await bridge.addToBasket(generated, { silent: true });
      await bridge.refreshLibrary().catch(() => undefined);
    }
    setBusy(false);
    const message = text(
      `${completed} completed, ${failed} failed.`,
      `已完成 ${completed} 个，失败 ${failed} 个。`,
    );
    setStatusMessage(message);
    bridge.toast(message, failed > 0);
  }, [canRun, focalLength, staticCamera, text, waitForBridge]);

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
