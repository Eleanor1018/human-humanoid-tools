import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ImportDropzone } from "@/components/ImportDropzone";
import { InspectorPage } from "@/components/Inspector";
import { SearchField } from "@/components/SearchField";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/SegmentedControl";
import type { StageMotionPayload } from "@/stage/types";

import {
  getMotionLibrary,
  loadMotionLibraryEntry,
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

export function MotionView({
  onMotionLoaded,
}: {
  /** App publishes this payload to the shared R3F Stage. */
  onMotionLoaded?: (motion: StageMotionPayload | null) => void;
}) {
  const [profile, setProfile] = useState<MotionProfile>("mimic");
  const [entries, setEntries] = useState<readonly MotionLibraryEntry[]>([]);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<"all" | MotionCategory>("all");
  const [loadingLibrary, setLoadingLibrary] = useState(true);
  const [loadingKey, setLoadingKey] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const libraryRequest = useRef<AbortController | null>(null);
  const motionRequest = useRef<AbortController | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const folderInput = useRef<HTMLInputElement | null>(null);
  const selected = profiles.find((item) => item.id === profile) ?? profiles[0];

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
      })
      .catch((reason: unknown) => {
        if (request.signal.aborted) return;
        setEntries([]);
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
      motionRequest.current?.abort();
    };
  }, [refreshLibrary]);

  useEffect(() => {
    folderInput.current?.setAttribute("webkitdirectory", "");
  }, []);

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
      setSelectedKey(null);
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
          setSelectedKey(key);
          setStatus(`Loaded ${entryLabel(entry)}`);
          onMotionLoaded?.(stagePayload);
        })
        .catch((reason: unknown) => {
          if (request.signal.aborted) return;
          setError(errorMessage(reason));
          setStatus(null);
          onMotionLoaded?.(null);
        })
        .finally(() => {
          if (!request.signal.aborted) setLoadingKey(null);
        });
    },
    [loadingKey, onMotionLoaded],
  );

  const importFiles = useCallback(
    (fileList: FileList | null) => {
      const files = fileList ? Array.from(fileList) : [];
      if (!files.length || loadingKey) return;
      motionRequest.current?.abort();
      const request = new AbortController();
      motionRequest.current = request;
      setLoadingKey(`upload:${files[0].name}`);
      setSelectedKey(null);
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
          onMotionLoaded?.(null);
        })
        .finally(() => {
          if (!request.signal.aborted) setLoadingKey(null);
        });
    },
    [loadingKey, onMotionLoaded, profile, refreshLibrary],
  );

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
        <p className="min-h-4 text-xs text-muted-foreground" aria-live="polite">
          {status || ""}
        </p>
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
            disabled
            title="Use Link directory to add an external library"
          >
            Choose library directory
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
            disabled
            title="Linking an external directory is not available in the browser shell"
          >
            Link directory
          </Button>
        </div>
        {error && (
          <p
            className="rounded-md border border-[#efcccc] bg-[#fff5f4] px-2.5 py-2 text-[11px] leading-relaxed break-words text-[#8c2929]"
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
                return (
                  <li key={key} className="min-w-0 list-none">
                    <button
                      type="button"
                      className="grid min-h-12 w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 rounded-md border border-transparent bg-transparent px-2 py-1.5 text-left text-foreground transition-colors hover:border-border-subtle hover:bg-background focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring data-[active=true]:border-primary data-[active=true]:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
                      data-active={active}
                      aria-current={active ? "true" : undefined}
                      aria-label={`Load motion ${entryLabel(entry)}`}
                      disabled={Boolean(loadingKey) && !busy}
                      onClick={() => loadEntry(entry)}
                    >
                      <span className="rounded-sm bg-primary/10 px-1.5 py-1 text-[10px] font-semibold uppercase text-primary">
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
