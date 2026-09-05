import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ImportDropzone } from "@/components/ImportDropzone";
import { InspectorPage } from "@/components/Inspector";
import { SearchField } from "@/components/SearchField";
import { ValidationSummary } from "@/components/ValidationSummary";
import { motionValidationFacts } from "@/components/validationFacts";
import { Button } from "@/components/ui/button";
import type { ApplicationImportRequest } from "@/importIntent";
import { SegmentedControl } from "@/components/SegmentedControl";
import type { StageMotionPayload } from "@/stage/types";

import {
  getMotionLibrary,
  linkMotionLibraryPath,
  loadMotionLibraryEntry,
  managedMotionLibraryFolders,
  removeMotionLibraryFolder,
  setMotionLibraryRoot,
  toStageMotionPayload,
  uploadMotion,
  type MotionCategory,
  type MotionLibraryEntry,
  type MotionProfile,
} from "./api";

interface MotionProfileOption {
  id: MotionProfile;
  label: string;
  prompt: string;
  icon: string;
  acceptsFile: boolean;
}

const profiles: readonly MotionProfileOption[] = [
  {
    id: "mimic",
    label: "mimic",
    prompt: "Drop a motion file or folder",
    icon: "/icons/motion/film.svg",
    acceptsFile: true,
  },
  {
    id: "intermimic",
    label: "intermimic",
    prompt: "Drop an object-interaction motion folder",
    icon: "/icons/motion/package.svg",
    acceptsFile: false,
  },
  {
    id: "meshmimic",
    label: "meshmimic",
    prompt: "Drop a terrain-motion folder",
    icon: "/icons/motion/mountain.svg",
    acceptsFile: false,
  },
];

const categories: readonly { value: "all" | MotionCategory; label: string }[] = [
  { value: "all", label: "All" },
  { value: "motion", label: "Motion" },
  { value: "object", label: "Object interaction" },
  { value: "terrain", label: "Terrain scene" },
];

const categoryBadgeClass: Readonly<Record<MotionCategory, string>> = {
  motion: "bg-[#0071e3]/[0.12] text-[#0071e3]",
  object: "bg-[#8e44ad]/[0.14] text-[#8e44ad]",
  terrain: "bg-[#34c759]/[0.14] text-[#34c759]",
};

const fieldClass =
  "min-h-[30px] min-w-0 truncate rounded-md border border-border bg-surface px-3 py-1.5 text-xs font-medium text-foreground disabled:cursor-not-allowed disabled:text-muted-foreground";

function entryKey(entry: MotionLibraryEntry): string {
  return (
    entry.source_path ||
    [entry.folder_label, entry.sequence_id, entry.stem].join("/")
  );
}

function entryCategory(entry: MotionLibraryEntry): MotionCategory {
  return entry.motion_category === "object" || entry.motion_category === "terrain"
    ? entry.motion_category
    : "motion";
}

function entryLabel(entry: MotionLibraryEntry): string {
  return entry.stem || entry.sequence_id || entry.label || entry.source_path;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function uploadFolderLabel(files: readonly File[]): string | undefined {
  const relative = (files[0] as File & { webkitRelativePath?: string })
    ?.webkitRelativePath;
  const label = relative?.split("/")[0]?.trim();
  return label || undefined;
}

interface DesktopDirectoryBridge {
  selectDirectory?: () => Promise<string | null>;
}

async function chooseServerDirectory(message: string, current = ""): Promise<string | null> {
  const desktop = (window as Window & { hhtoolsDesktop?: DesktopDirectoryBridge })
    .hhtoolsDesktop;
  if (desktop?.selectDirectory) return desktop.selectDirectory();
  return window.prompt(message, current);
}

export function MotionView({
  currentMotion,
  onMotionLoaded,
  humanBatchEntries = [],
  onAddToHumanBatch,
  onRemoveHumanBatchFolder,
  importRequest,
}: {
  /** App-owned stable input; failed replacements leave it untouched. */
  currentMotion?: StageMotionPayload | null;
  /** App publishes this payload to the shared R3F Stage. */
  onMotionLoaded?: (motion: StageMotionPayload | null) => void;
  /** App-owned H2R Batch draft; Motion only requests additions. */
  humanBatchEntries?: readonly MotionLibraryEntry[];
  onAddToHumanBatch?: (entry: MotionLibraryEntry) => void;
  onRemoveHumanBatchFolder?: (folderLabel: string) => void;
  /** App-owned File-menu intent; this mounted view owns its input elements. */
  importRequest?: ApplicationImportRequest | null;
}) {
  const [profile, setProfile] = useState<MotionProfile>("mimic");
  const [entries, setEntries] = useState<readonly MotionLibraryEntry[]>([]);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<"all" | MotionCategory>("all");
  const [loadingLibrary, setLoadingLibrary] = useState(true);
  const [libraryAction, setLibraryAction] = useState<"root" | "link" | "remove" | null>(null);
  const [managedFolder, setManagedFolder] = useState("");
  const [pendingFolderRemoval, setPendingFolderRemoval] = useState<string | null>(null);
  const [libraryRoot, setLibraryRoot] = useState("");
  const [loadingKey, setLoadingKey] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const libraryRequest = useRef<AbortController | null>(null);
  const libraryActionRequest = useRef<AbortController | null>(null);
  const motionRequest = useRef<AbortController | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const folderInput = useRef<HTMLInputElement | null>(null);
  const handledImportRequest = useRef<number | null>(null);
  const selected = profiles.find((item) => item.id === profile) ?? profiles[0];
  const selectedKey = currentMotion?.library_entry?.source_path ?? null;

  const batchPaths = useMemo(
    () => new Set(humanBatchEntries.map((entry) => entry.source_path)),
    [humanBatchEntries],
  );
  const managedFolders = useMemo(
    () => managedMotionLibraryFolders(entries),
    [entries],
  );
  const loadedBatchEntry = useMemo(() => {
    if (!selectedKey) return null;
    const catalogEntry = entries.find((entry) => entry.source_path === selectedKey);
    if (catalogEntry) return catalogEntry;
    const snapshot = currentMotion?.library_entry as MotionLibraryEntry | undefined;
    return snapshot?.folder_label && snapshot.sequence_id ? snapshot : null;
  }, [currentMotion?.library_entry, entries, selectedKey]);

  const refreshLibrary = useCallback(() => {
    libraryRequest.current?.abort();
    const request = new AbortController();
    libraryRequest.current = request;
    setLoadingLibrary(true);
    setError(null);
    void getMotionLibrary({ signal: request.signal })
      .then((response) => {
        if (request.signal.aborted) return;
        setEntries(response.entries);
        setLibraryRoot(response.motions_library_root);
      })
      .catch((reason: unknown) => {
        if (request.signal.aborted) return;
        setError(errorMessage(reason));
      })
      .finally(() => {
        if (!request.signal.aborted) setLoadingLibrary(false);
      });
  }, []);

  useEffect(() => {
    refreshLibrary();
    return () => {
      libraryRequest.current?.abort();
      libraryActionRequest.current?.abort();
      motionRequest.current?.abort();
    };
  }, [refreshLibrary]);

  useEffect(() => {
    folderInput.current?.setAttribute("webkitdirectory", "");
  }, []);

  useEffect(() => {
    if (
      !importRequest ||
      handledImportRequest.current === importRequest.id ||
      (importRequest.target !== "motion-file" &&
        importRequest.target !== "motion-folder")
    ) {
      return;
    }
    handledImportRequest.current = importRequest.id;
    setProfile("mimic");
    if (importRequest.target === "motion-file") fileInput.current?.click();
    else folderInput.current?.click();
  }, [importRequest]);

  useEffect(() => {
    if (!managedFolders.includes(managedFolder)) {
      setManagedFolder(managedFolders[0] ?? "");
    }
    if (
      pendingFolderRemoval &&
      !managedFolders.includes(pendingFolderRemoval)
    ) {
      setPendingFolderRemoval(null);
    }
  }, [managedFolder, managedFolders, pendingFolderRemoval]);

  const addToHumanBatch = useCallback(
    (entry: MotionLibraryEntry) => {
      if (entry.asset_kind === "robot_trajectory" || batchPaths.has(entry.source_path)) return;
      onAddToHumanBatch?.(entry);
      setStatus(`Added ${entryLabel(entry)} to H2R Batch`);
    },
    [batchPaths, onAddToHumanBatch],
  );

  const visibleEntries = useMemo(() => {
    const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return entries.filter((entry) => {
      const motionCategory = entryCategory(entry);
      if (category !== "all" && motionCategory !== category) return false;
      const searchable = [
        entry.folder_label,
        entry.stem,
        entry.sequence_id,
        entry.dataset,
        motionCategory,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return tokens.every((token) => searchable.includes(token));
    });
  }, [category, entries, query]);

  const loadEntry = useCallback(
    (entry: MotionLibraryEntry) => {
      if (loadingKey) return;
      motionRequest.current?.abort();
      const request = new AbortController();
      motionRequest.current = request;
      const key = entryKey(entry);
      setLoadingKey(key);
      setError(null);
      setStatus(`Loading ${entryLabel(entry)}…`);
      void loadMotionLibraryEntry(entry, {
        signal: request.signal,
        onUpdate: (job) => {
          if (!request.signal.aborted) {
            const progress = Math.round((job.progress ?? 0) * 100);
            setStatus(`${job.message || "Loading motion…"} ${progress}%`);
          }
        },
      })
        .then((payload) => {
          if (request.signal.aborted) return;
          const stagePayload = toStageMotionPayload(payload);
          if (!stagePayload) throw new Error("The motion result has no preview data.");
          setStatus(`Loaded ${entryLabel(entry)}`);
          onMotionLoaded?.(stagePayload);
        })
        .catch((reason: unknown) => {
          if (request.signal.aborted) return;
          setError(errorMessage(reason));
          setStatus(null);
        })
        .finally(() => {
          if (!request.signal.aborted) setLoadingKey(null);
        });
    },
    [loadingKey, onMotionLoaded],
  );

  const importFiles = useCallback(
    (fileList: Iterable<File> | null) => {
      const files = fileList ? Array.from(fileList) : [];
      if (!files.length || loadingKey) return;
      motionRequest.current?.abort();
      const request = new AbortController();
      motionRequest.current = request;
      setLoadingKey(`upload:${files[0].name}`);
      setError(null);
      setStatus(`Uploading ${files.length} file${files.length === 1 ? "" : "s"}…`);
      void uploadMotion(files, {
        profile,
        libraryFolderLabel: uploadFolderLabel(files),
        signal: request.signal,
        onUpdate: (job) => {
          if (!request.signal.aborted) {
            const progress = Math.round((job.progress ?? 0) * 100);
            setStatus(`${job.message || "Processing motion…"} ${progress}%`);
          }
        },
      })
        .then((payload) => {
          if (request.signal.aborted) return;
          const stagePayload = toStageMotionPayload(payload);
          if (!stagePayload) throw new Error("The motion result has no preview data.");
          setStatus(`Loaded ${payload.name || files[0].name}`);
          onMotionLoaded?.(stagePayload);
          refreshLibrary();
        })
        .catch((reason: unknown) => {
          if (request.signal.aborted) return;
          setError(errorMessage(reason));
          setStatus(null);
        })
        .finally(() => {
          if (!request.signal.aborted) setLoadingKey(null);
        });
    },
    [loadingKey, onMotionLoaded, profile, refreshLibrary],
  );

  const manageLibrary = useCallback(
    async (action: "root" | "link") => {
      if (libraryAction || loadingKey) return;
      setLibraryAction(action);
      setError(null);
      try {
        const path = await chooseServerDirectory(
          action === "root"
            ? "Enter the Motion Library directory on the server"
            : "Enter a motion dataset directory to link",
          action === "root" ? libraryRoot : "",
        );
        if (!path?.trim()) return;
        libraryActionRequest.current?.abort();
        const request = new AbortController();
        libraryActionRequest.current = request;
        if (action === "root") {
          const result = await setMotionLibraryRoot(path.trim(), {
            signal: request.signal,
          });
          if (request.signal.aborted) return;
          setLibraryRoot(result.root);
          setStatus(`Motion Library: ${result.root}`);
        } else {
          const result = await linkMotionLibraryPath(path.trim(), {
            signal: request.signal,
          });
          if (request.signal.aborted) return;
          setStatus(`Linked ${result.folder_label}: ${result.clip_count} clips`);
        }
        refreshLibrary();
      } catch (reason) {
        setError(errorMessage(reason));
      } finally {
        setLibraryAction(null);
      }
    },
    [libraryAction, libraryRoot, loadingKey, refreshLibrary],
  );

  const removeManagedFolder = useCallback(async () => {
    if (
      !managedFolder ||
      !managedFolders.includes(managedFolder) ||
      pendingFolderRemoval !== managedFolder ||
      libraryAction ||
      loadingKey
    ) {
      return;
    }
    libraryActionRequest.current?.abort();
    const request = new AbortController();
    libraryActionRequest.current = request;
    setLibraryAction("remove");
    setError(null);
    try {
      const result = await removeMotionLibraryFolder(managedFolder, {
        signal: request.signal,
      });
      if (request.signal.aborted) return;
      setStatus(`Removed ${result.removed} from Motion Library`);
      onRemoveHumanBatchFolder?.(result.removed);
      setManagedFolder("");
      setPendingFolderRemoval(null);
      refreshLibrary();
    } catch (reason) {
      if (!request.signal.aborted) setError(errorMessage(reason));
    } finally {
      if (!request.signal.aborted) setLibraryAction(null);
    }
  }, [
    libraryAction,
    loadingKey,
    managedFolder,
    managedFolders,
    pendingFolderRemoval,
    refreshLibrary,
    onRemoveHumanBatchFolder,
  ]);

  return (
    <InspectorPage title="Motion">
      <div className="flex shrink-0 flex-col gap-2.5">
        <SegmentedControl
          label="Motion import type"
          items={profiles}
          value={profile}
          onValueChange={setProfile}
        />

        <ImportDropzone
          label={`${profile} import area`}
          icon={selected.icon}
          title={selected.prompt}
          disabled={Boolean(loadingKey)}
          onFiles={importFiles}
        >
          {selected.acceptsFile && (
            <Button
              size="sm"
              disabled={Boolean(loadingKey)}
              onClick={() => fileInput.current?.click()}
            >
              Choose file
            </Button>
          )}
          <Button
            size="sm"
            disabled={Boolean(loadingKey)}
            onClick={() => folderInput.current?.click()}
          >
            Choose folder
          </Button>
          <input
            ref={fileInput}
            className="hidden"
            type="file"
            accept=".bvh,.glb,.gltf,.npz,.npy,.pkl,.pt"
            onChange={(event) => {
              importFiles(event.currentTarget.files);
              event.currentTarget.value = "";
            }}
          />
          <input
            ref={folderInput}
            className="hidden"
            type="file"
            multiple
            onChange={(event) => {
              importFiles(event.currentTarget.files);
              event.currentTarget.value = "";
            }}
          />
        </ImportDropzone>
        <div className="flex min-h-[30px] items-center gap-2">
          <p
            className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
            aria-live="polite"
            title={status || undefined}
          >
            {status || ""}
          </p>
          {loadedBatchEntry &&
            loadedBatchEntry.asset_kind !== "robot_trajectory" &&
            onAddToHumanBatch && (
              <Button
                size="sm"
                variant="ghost"
                disabled={
                  Boolean(loadingKey) ||
                  batchPaths.has(loadedBatchEntry.source_path)
                }
                onClick={() => addToHumanBatch(loadedBatchEntry)}
              >
                {batchPaths.has(loadedBatchEntry.source_path)
                  ? "In H2R Batch"
                  : "Add loaded to Batch"}
              </Button>
            )}
        </div>
        <ValidationSummary
          items={motionValidationFacts(currentMotion ?? null)}
          label="Loaded motion validation"
        />
      </div>

      <section
        className="flex min-h-40 flex-[1_1_220px] flex-col gap-2"
        aria-labelledby="motion-library-title"
      >
        <div className="flex items-center justify-between gap-2">
          <h2
            id="motion-library-title"
            className="text-[19px] leading-tight font-bold tracking-normal text-foreground"
          >
            Library
          </h2>
          <Button
            size="sm"
            onClick={refreshLibrary}
            disabled={loadingLibrary || Boolean(loadingKey)}
          >
            {loadingLibrary ? "Loading…" : "Refresh"}
          </Button>
        </div>
        <div className="grid grid-cols-[minmax(0,1fr)_minmax(110px,42%)] gap-1.5">
          <Button
            size="sm"
            disabled={loadingLibrary || Boolean(loadingKey) || libraryAction !== null}
            title={libraryRoot}
            onClick={() => void manageLibrary("root")}
          >
            {libraryAction === "root" ? "Choosing..." : "Choose library directory"}
          </Button>
          <select
            className={fieldClass}
            value={category}
            onChange={(event) => {
              const value = event.target.value;
              if (
                value === "all" ||
                value === "motion" ||
                value === "object" ||
                value === "terrain"
              ) {
                setCategory(value);
              }
            }}
            aria-label="Motion library category"
            disabled={loadingLibrary}
          >
            {categories.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
        </div>
        <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-1.5">
          <SearchField
            label="Search the Motion Library"
            placeholder="Search motions..."
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            disabled={loadingLibrary}
          />
          <Button
            size="sm"
            disabled={loadingLibrary || Boolean(loadingKey) || libraryAction !== null}
            title="Add a server-local directory without copying its clips"
            onClick={() => void manageLibrary("link")}
          >
            {libraryAction === "link" ? "Linking..." : "Link directory"}
          </Button>
        </div>
        {managedFolders.length > 0 && (
          <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-1.5">
            <select
              className={fieldClass}
              aria-label="Managed Motion Library folder"
              value={managedFolder}
              disabled={loadingLibrary || libraryAction !== null}
              onChange={(event) => {
                setManagedFolder(event.currentTarget.value);
                setPendingFolderRemoval(null);
              }}
            >
              {managedFolders.map((folder) => (
                <option key={folder} value={folder}>
                  {folder}
                </option>
              ))}
            </select>
            <Button
              size="sm"
              disabled={
                loadingLibrary ||
                Boolean(loadingKey) ||
                libraryAction !== null ||
                !managedFolder
              }
              title="Remove a linked or uploaded folder from this managed library"
              onClick={() => setPendingFolderRemoval(managedFolder)}
            >
              Remove folder
            </Button>
            {pendingFolderRemoval === managedFolder && (
              <div className="col-span-2 grid gap-2 rounded-md border border-danger-border bg-danger-muted p-2.5 text-[11px] leading-relaxed text-danger">
                <p className="[overflow-wrap:anywhere]">
                  Remove <strong>{managedFolder}</strong> from this managed
                  library? External linked source data is kept; files copied
                  into the managed folder are deleted.
                </p>
                <div className="grid grid-cols-2 gap-2">
                  <Button
                    size="sm"
                    disabled={libraryAction !== null}
                    onClick={() => setPendingFolderRemoval(null)}
                  >
                    Cancel
                  </Button>
                  <Button
                    size="sm"
                    className="border-danger-border text-danger hover:border-danger hover:bg-danger-muted"
                    disabled={libraryAction !== null}
                    onClick={() => void removeManagedFolder()}
                  >
                    {libraryAction === "remove" ? "Removing..." : "Confirm remove"}
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
        {error && (
          <p
            className="rounded-md border border-danger-border bg-danger-muted px-2.5 py-2 text-[11px] leading-relaxed break-words text-danger"
            role="alert"
          >
            {error}
          </p>
        )}
        <div
          className="min-h-[120px] flex-[1_1_220px] overflow-y-auto rounded-md border border-border-subtle bg-surface p-1"
          aria-live="polite"
          aria-busy={loadingLibrary || Boolean(loadingKey)}
        >
          {loadingLibrary ? (
            <p className="p-2 text-xs text-muted-foreground">Loading Motion Library…</p>
          ) : !entries.length ? (
            <p className="p-2 text-xs text-muted-foreground">
              No recognizable motions are available.
            </p>
          ) : !visibleEntries.length ? (
            <p className="p-2 text-xs text-muted-foreground">
              No motions match “{query}”.
            </p>
          ) : (
            <ul className="grid gap-0.5" aria-label="Motion Library entries">
              {visibleEntries.slice(0, 300).map((entry) => {
                const key = entryKey(entry);
                const active = selectedKey === key;
                const busy = loadingKey === key;
                const motionCategory = entryCategory(entry);
                const inBatch = batchPaths.has(entry.source_path);
                const canAddToBatch =
                  entry.asset_kind !== "robot_trajectory" &&
                  Boolean(onAddToHumanBatch);
                return (
                  <li
                    key={key}
                    className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-1 list-none"
                  >
                    <button
                      type="button"
                      className="grid min-h-12 w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 rounded-md border border-transparent bg-transparent px-2 py-1.5 text-left text-foreground transition-colors hover:border-border-subtle hover:bg-background focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring data-[active=true]:border-primary data-[active=true]:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
                      data-active={active}
                      aria-current={active ? "true" : undefined}
                      aria-label={`Load motion ${entryLabel(entry)}`}
                      disabled={Boolean(loadingKey)}
                      onClick={() => loadEntry(entry)}
                    >
                      <span
                        className={`rounded-sm px-1.5 py-1 text-[10px] font-semibold uppercase ${categoryBadgeClass[motionCategory]}`}
                      >
                        {motionCategory}
                      </span>
                      <span className="grid min-w-0 gap-0.5">
                        <strong className="truncate text-[13px] font-semibold">
                          {entryLabel(entry)}
                        </strong>
                        <small className="truncate text-[11px] text-muted-foreground">
                          {[entry.folder_label, entry.dataset]
                            .filter(Boolean)
                            .join(" · ") || "Motion Library"}
                        </small>
                      </span>
                      <span className="shrink-0 text-[11px] text-muted-foreground">
                        {busy ? "Loading…" : active ? "Loaded" : "Load"}
                      </span>
                    </button>
                    {canAddToBatch && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="w-[62px] px-1.5"
                        aria-label={`Add ${entryLabel(entry)} to H2R Batch`}
                        title={inBatch ? "Already in H2R Batch" : "Add to H2R Batch"}
                        disabled={Boolean(loadingKey) || inBatch}
                        onClick={() => addToHumanBatch(entry)}
                      >
                        {inBatch ? "Added" : "+ Batch"}
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </section>
    </InspectorPage>
  );
}
