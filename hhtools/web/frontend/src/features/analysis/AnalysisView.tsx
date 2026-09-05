import { useEffect, useMemo, useRef, useState } from "react";

import { Field, fieldClass } from "@/components/Field";
import { InspectorPage } from "@/components/Inspector";
import { Button } from "@/components/ui/button";
import { WorkflowPipeline, WorkflowStep } from "@/components/WorkflowSteps";
import { getMotionLibrary, loadMotionLibraryEntry } from "@/features/motion/api";
import { getRobotLibrary, loadRobot, type RobotSummary } from "@/features/robot/api";
import type { StageMotionPayload } from "@/stage/types";

import {
  analyzeDataset,
  computeDatasetSubset,
  downloadBlob,
  exportDatasetManifest,
  exportRobotSubset,
  getCachedDatasetResult,
  getDatasetCatalog,
  motionEntryForAnalysisClip,
  previewDatasetRobot,
  scanDataset,
  uploadDataset,
  type AnalysisRobotPreview,
  type AnalysisEmbedding,
  type DatasetAnalysisResult,
  type DatasetCatalog,
  type DatasetClip,
  type DatasetSummary,
  type DatasetUploadSummary,
  type Histogram,
} from "./api";

const pipeline = ["Select Data", "Configure", "Analyze", "Results"];
type BusyAction = "scan" | "upload" | "analyze" | "subset" | "preview" | null;

export interface AnalysisViewProps {
  /** Optional Stage handoff for human clips selected from the result table. */
  readonly onMotionLoaded?: (motion: StageMotionPayload | null) => void;
  /** Robot previews remain owned by Analysis instead of replacing a workspace robot. */
  readonly onRobotPreviewLoaded?: (preview: AnalysisRobotPreview | null) => void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function numberValue(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatNumber(value: unknown): string {
  const parsed = numberValue(value);
  if (parsed === null) return "-";
  if (Math.abs(parsed) >= 100) return parsed.toFixed(1);
  if (Math.abs(parsed) >= 10) return parsed.toFixed(2);
  return parsed.toFixed(3);
}

function clipLabel(clip: DatasetClip): string {
  return clip.clip_id || clip.source_path.split(/[\\/]/).pop() || "clip";
}

function validClips(result: DatasetAnalysisResult | null): DatasetClip[] {
  return result?.clips.filter(
    (clip) => !clip.error && Object.keys(clip.metrics).length > 0,
  ) ?? [];
}

function HistogramChart({ histogram }: { histogram: Histogram | undefined }) {
  if (!histogram) {
    return <p className="text-xs text-muted-foreground">No values for this metric.</p>;
  }
  const max = Math.max(...histogram.counts, 1);
  const width = 420;
  const height = 116;
  const gap = 2;
  const barWidth = width / Math.max(histogram.counts.length, 1);
  return (
    <div className="grid gap-1.5">
      <svg
        className="h-[116px] w-full overflow-visible"
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label="Metric histogram"
      >
        {histogram.counts.map((count, index) => {
          const barHeight = (count / max) * (height - 18);
          return (
            <rect
              key={index}
              x={index * barWidth + gap / 2}
              y={height - barHeight - 1}
              width={Math.max(1, barWidth - gap)}
              height={barHeight}
              rx="2"
              className="fill-primary/75"
            />
          );
        })}
        <line x1="0" y1={height - 1} x2={width} y2={height - 1} className="stroke-border" />
      </svg>
      <div className="flex justify-between text-[10px] text-muted-foreground">
        <span>{formatNumber(histogram.min)}</span>
        <span>mean {formatNumber(histogram.mean)}</span>
        <span>{formatNumber(histogram.max)}</span>
      </div>
    </div>
  );
}

function ScatterPlot({
  clips,
  selectedIds,
  subsetIds,
  onSelect,
}: {
  clips: readonly DatasetClip[];
  selectedIds: ReadonlySet<string>;
  subsetIds: ReadonlySet<string>;
  onSelect: (id: string) => void;
}) {
  const points = clips.filter(
    (clip): clip is DatasetClip & { scatter: readonly [number, number] } =>
      Array.isArray(clip.scatter) && clip.scatter.length === 2,
  );
  if (!points.length) {
    return <p className="text-xs text-muted-foreground">No embedding coordinates.</p>;
  }
  const xs = points.map((point) => point.scatter[0]);
  const ys = points.map((point) => point.scatter[1]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const scaleX = (value: number) =>
    18 + ((value - minX) / Math.max(maxX - minX, 1e-6)) * 604;
  const scaleY = (value: number) =>
    198 - ((value - minY) / Math.max(maxY - minY, 1e-6)) * 176;
  const color = (cluster: number | null) => {
    const palette = ["#0071e3", "#e05d44", "#2da44e", "#8250df", "#bf8700", "#0a7b83"];
    if (cluster === null || cluster < 0) return "#8c959f";
    return palette[cluster % palette.length];
  };
  return (
    <svg
      className="h-[220px] w-full rounded-md border border-border-subtle bg-background"
      viewBox="0 0 640 220"
      role="img"
      aria-label="Embedding scatter plot"
    >
      <line x1="18" y1="198" x2="622" y2="198" className="stroke-border" />
      <line x1="18" y1="22" x2="18" y2="198" className="stroke-border" />
      {points.map((clip) => {
        const selected = selectedIds.has(clip.clip_id);
        const recommended = subsetIds.has(clip.clip_id);
        return (
          <circle
            key={clip.clip_id}
            cx={scaleX(clip.scatter[0])}
            cy={scaleY(clip.scatter[1])}
            r={selected || recommended ? 6 : 4}
            fill={color(clip.cluster_id)}
            stroke={selected ? "#02122e" : recommended ? "#ff9f0a" : "#fff"}
            strokeWidth={selected || recommended ? 2 : 1}
            className="cursor-pointer"
            tabIndex={0}
            aria-label={clipLabel(clip)}
            onClick={() => onSelect(clip.clip_id)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") onSelect(clip.clip_id);
            }}
          />
        );
      })}
    </svg>
  );
}

function SummaryCards({ summary }: { summary: DatasetSummary }) {
  const cards = [
    ["Clips", summary.num_clips],
    ["Analyzed", summary.num_ok],
    ["Failed", summary.num_error],
    ["Clusters", Object.keys(summary.cluster_counts).length],
  ] as const;
  return (
    <div className="grid grid-cols-4 gap-1.5">
      {cards.map(([label, value]) => (
        <div key={label} className="rounded-md border border-border-subtle bg-surface px-2.5 py-2">
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
          <p className="mt-0.5 text-lg font-semibold text-foreground">{value}</p>
        </div>
      ))}
    </div>
  );
}

export function AnalysisView({
  onMotionLoaded,
  onRobotPreviewLoaded,
}: AnalysisViewProps) {
  const [catalog, setCatalog] = useState<DatasetCatalog>({});
  const [robots, setRobots] = useState<readonly RobotSummary[]>([]);
  const [source, setSource] = useState("");
  const [defaultSource, setDefaultSource] = useState("");
  const [sourceSummary, setSourceSummary] = useState<DatasetUploadSummary | null>(null);
  const [uploadSource, setUploadSource] = useState<string | null>(null);
  const [userSourceRoot, setUserSourceRoot] = useState("");
  const [embedding, setEmbedding] = useState<AnalysisEmbedding>("handcrafted");
  const [force, setForce] = useState(false);
  const [result, setResult] = useState<DatasetAnalysisResult | null>(null);
  const [busy, setBusy] = useState<BusyAction>(null);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [tagFilter, setTagFilter] = useState("all");
  const [kindFilter, setKindFilter] = useState("all");
  const [folderFilter, setFolderFilter] = useState("all");
  const [metric, setMetric] = useState("complexity");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [subsetIds, setSubsetIds] = useState<Set<string>>(new Set());
  const [subsetRatio, setSubsetRatio] = useState("10");
  const [subsetAlpha, setSubsetAlpha] = useState("0.99");
  const [previewing, setPreviewing] = useState<string | null>(null);
  const [previewRobot, setPreviewRobot] = useState("");
  const folderInput = useRef<HTMLInputElement | null>(null);
  const requestRef = useRef<AbortController | null>(null);

  useEffect(() => {
    folderInput.current?.setAttribute("webkitdirectory", "");
    const request = new AbortController();
    requestRef.current = request;
    void Promise.all([
      getDatasetCatalog({ signal: request.signal }),
      getMotionLibrary({ signal: request.signal }),
      getRobotLibrary({ signal: request.signal }),
    ])
      .then(([loadedCatalog, library, robotLibrary]) => {
        if (request.signal.aborted) return;
        setCatalog(loadedCatalog);
        setSource(library.source_root);
        setDefaultSource(library.source_root);
        setRobots(robotLibrary.robots.filter((robot) => robot.has_urdf));
      })
      .catch((reason: unknown) => {
        if (!request.signal.aborted) setError(errorMessage(reason));
      });
    return () => {
      request.abort();
      requestRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (!result) return;
    setMetric(result.summary.numeric_keys[0] || "complexity");
    setTagFilter("all");
    setKindFilter("all");
    setFolderFilter("all");
    setSelectedIds(new Set());
    setSubsetIds(new Set());
  }, [result]);

  const availableClips = useMemo(() => validClips(result), [result]);
  const folders = useMemo(
    () => [...new Set(availableClips.map((clip) => clip.folder_label).filter(Boolean))].sort(),
    [availableClips],
  );
  const filteredClips = useMemo(
    () =>
      availableClips.filter(
        (clip) =>
          (tagFilter === "all" || clip.tags.includes(tagFilter)) &&
          (kindFilter === "all" || clip.source_kind === kindFilter) &&
          (folderFilter === "all" || clip.folder_label === folderFilter),
      ),
    [availableClips, folderFilter, kindFilter, tagFilter],
  );
  const exportIds = useMemo(() => {
    const combined = new Set([...subsetIds, ...selectedIds]);
    if (combined.size) return [...combined];
    return filteredClips.map((clip) => clip.clip_id);
  }, [filteredClips, selectedIds, subsetIds]);
  const selectedRobotCount = useMemo(
    () =>
      exportIds.filter(
        (id) => result?.clips.find((clip) => clip.clip_id === id)?.source_kind === "robot",
      ).length,
    [exportIds, result],
  );
  const hasRobotClips = availableClips.some(
    (clip) => clip.source_kind === "robot" || clip.dataset === "robot",
  );
  const catalogMetric = (catalog.metrics?.[metric] ?? {}) as Record<string, unknown>;
  const summary = result?.summary;
  const tags = summary?.tag_order ?? [];
  const kinds = [...new Set(availableClips.map((clip) => clip.source_kind))].sort();

  function begin(action: Exclude<BusyAction, null>): AbortController {
    requestRef.current?.abort();
    const request = new AbortController();
    requestRef.current = request;
    setBusy(action);
    setProgress(0);
    setError(null);
    return request;
  }

  function finish(request: AbortController): void {
    if (requestRef.current !== request) return;
    requestRef.current = null;
    setBusy(null);
  }

  async function scanPath(path: string): Promise<void> {
    if (!path.trim()) return;
    const request = begin("scan");
    setSource(path.trim());
    setStatus("Scanning dataset...");
    try {
      const value = await scanDataset(path.trim(), { signal: request.signal });
      if (request.signal.aborted) return;
      setSource(value.source);
      setSourceSummary(value);
      setUploadSource(null);
      setResult(null);
      onMotionLoaded?.(null);
      onRobotPreviewLoaded?.(null);
      setStatus(`${value.clip_count} clips found.`);
    } catch (reason) {
      if (!request.signal.aborted) setError(errorMessage(reason));
    } finally {
      finish(request);
    }
  }

  function scanCurrentSource(): void {
    void scanPath(source);
  }

  function uploadFolder(files: FileList | null): void {
    const selected = files ? Array.from(files) : [];
    if (!selected.length) return;
    const request = begin("upload");
    setResult(null);
    onMotionLoaded?.(null);
    onRobotPreviewLoaded?.(null);
    setStatus(`Uploading ${selected.length} files...`);
    void uploadDataset(selected, {
      appendTo: uploadSource ?? undefined,
      userSourceRoot: userSourceRoot.trim() || undefined,
      signal: request.signal,
    })
      .then((value) => {
        if (request.signal.aborted) return;
        setSource(value.source);
        setSourceSummary(value);
        setUploadSource(value.source);
        setResult(null);
        setStatus(`${value.clip_count} clips ready for analysis.`);
      })
      .catch((reason: unknown) => {
        if (!request.signal.aborted) setError(errorMessage(reason));
      })
      .finally(() => finish(request));
  }

  function runAnalysis(): void {
    const request = begin("analyze");
    setStatus("Analyzing dataset...");
    void analyzeDataset(
      {
        ...(source.trim() ? { source: source.trim() } : {}),
        embedding,
        force,
      },
      {
        signal: request.signal,
        onUpdate: (job) => {
          if (!request.signal.aborted) {
            setProgress(job.progress ?? 0);
            setStatus(job.message || "Analyzing dataset...");
          }
        },
      },
    )
      .then((value) => {
        if (request.signal.aborted) return;
        setResult(value);
        setProgress(1);
        setStatus(`Analysis complete: ${value.summary.num_ok} clips.`);
      })
      .catch((reason: unknown) => {
        if (!request.signal.aborted) setError(errorMessage(reason));
      })
      .finally(() => finish(request));
  }

  async function loadCached(): Promise<void> {
    if (!source.trim()) return;
    const request = begin("scan");
    setStatus("Checking cached result...");
    try {
      const cached = await getCachedDatasetResult(source.trim(), embedding, {
        signal: request.signal,
      });
      if (request.signal.aborted) return;
      if (!cached.available || !cached.clips || !cached.summary || !cached.meta) {
        setStatus("No cached result for this source.");
        return;
      }
      setResult(cached as DatasetAnalysisResult);
      setStatus("Loaded cached result.");
    } catch (reason) {
      if (!request.signal.aborted) setError(errorMessage(reason));
    } finally {
      finish(request);
    }
  }

  function recommendSubset(): void {
    if (!result || !filteredClips.length) return;
    const request = begin("subset");
    const ratio = Math.max(1, Math.min(100, Number(subsetRatio) || 10)) / 100;
    const alpha = Math.max(0, Math.min(1, Number(subsetAlpha) || 0.99));
    const k = Math.max(1, Math.round(filteredClips.length * ratio));
    void computeDatasetSubset(filteredClips, k, alpha, { signal: request.signal })
      .then((value) => {
        if (!request.signal.aborted) {
          setSubsetIds(new Set(value.selected));
          setStatus(`Recommended ${value.count} clips.`);
        }
      })
      .catch((reason: unknown) => {
        if (!request.signal.aborted) setError(errorMessage(reason));
      })
      .finally(() => finish(request));
  }

  function toggleSelected(id: string): void {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function exportManifest(format: "json" | "csv"): Promise<void> {
    if (!result || !exportIds.length) return;
    setError(null);
    try {
      const blob = await exportDatasetManifest({
        clips: result.clips,
        ids: exportIds,
        analyze_source: result.meta.source_root,
        user_source_root: userSourceRoot.trim() || undefined,
        format,
      });
      downloadBlob(blob, `dataset_manifest.${format}`);
      setStatus(`Exported ${exportIds.length} clips.`);
    } catch (reason) {
      setError(errorMessage(reason));
    }
  }

  async function exportRobots(): Promise<void> {
    if (!result || !selectedRobotCount) return;
    setError(null);
    try {
      const blob = await exportRobotSubset({ clips: result.clips, ids: exportIds });
      downloadBlob(blob, "robot_subset_export.zip");
      setStatus(`Exported ${selectedRobotCount} robot clips.`);
    } catch (reason) {
      setError(errorMessage(reason));
    }
  }

  async function previewClip(clip: DatasetClip): Promise<void> {
    if (clip.source_kind === "robot" || clip.dataset === "robot") {
      const request = begin("preview");
      setPreviewing(clip.clip_id);
      setStatus(`Loading robot trajectory ${clipLabel(clip)}...`);
      try {
        const inferred = typeof clip.metrics.robot_preset === "string"
          ? clip.metrics.robot_preset.trim()
          : "";
        const result = await previewDatasetRobot(
          {
            source_path: clip.source_path,
            ...(previewRobot || inferred ? { robot: previewRobot || inferred } : {}),
          },
          {
            signal: request.signal,
            onUpdate: (job) => {
              if (!request.signal.aborted) {
                setStatus(job.message || "Loading robot trajectory...");
              }
            },
          },
        );
        if (request.signal.aborted) return;
        const robot = await loadRobot(result.robot, { signal: request.signal });
        if (request.signal.aborted) return;
        onRobotPreviewLoaded?.({
          robot,
          trajectory: result.trajectory,
          scene: result.scaled_scene,
          previewToken: result.preview_token,
        });
        setStatus(`Previewing ${result.name}.`);
      } catch (reason) {
        if (!request.signal.aborted) setError(errorMessage(reason));
      } finally {
        setPreviewing(null);
        finish(request);
      }
      return;
    }
    const request = begin("preview");
    setPreviewing(clip.clip_id);
    setStatus(`Loading ${clipLabel(clip)}...`);
    try {
      const motion = await loadMotionLibraryEntry(motionEntryForAnalysisClip(clip), {
        signal: request.signal,
        onUpdate: (job) => {
          if (!request.signal.aborted) setStatus(job.message || "Loading clip...");
        },
      });
      if (!request.signal.aborted) {
        onRobotPreviewLoaded?.(null);
        onMotionLoaded?.(motion);
        setStatus(`Previewing ${clipLabel(clip)}.`);
      }
    } catch (reason) {
      if (!request.signal.aborted) setError(errorMessage(reason));
    } finally {
      setPreviewing(null);
      finish(request);
    }
  }

  return (
    <InspectorPage title="Data Analysis">
      <WorkflowPipeline
        label="Data Analysis pipeline"
        steps={pipeline}
        activeIndex={result ? 3 : busy === "analyze" ? 2 : sourceSummary ? 1 : 0}
      />

      <div className="flex shrink-0 flex-col">
        <WorkflowStep
          title="1. Select data"
          status={sourceSummary ? `${sourceSummary.clip_count} clips` : "No data"}
          defaultOpen
        >
          <div className="grid gap-2.5">
            <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
              <input
                className={fieldClass}
                aria-label="Dataset source path"
                placeholder={defaultSource || "Server-local directory path"}
                value={source}
                disabled={busy !== null}
                onChange={(event) => {
                  setSource(event.target.value);
                  setSourceSummary(null);
                  setUploadSource(null);
                  setResult(null);
                  setSelectedIds(new Set());
                  setSubsetIds(new Set());
                  onMotionLoaded?.(null);
                  onRobotPreviewLoaded?.(null);
                }}
              />
              <Button size="sm" disabled={!source.trim() || busy !== null} onClick={() => void scanCurrentSource()}>
                Scan
              </Button>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Button size="sm" disabled={busy !== null} onClick={() => folderInput.current?.click()}>
                Choose folder
              </Button>
              <Button
                size="sm"
                disabled={!defaultSource || busy !== null}
                onClick={() => {
                  void scanPath(defaultSource);
                }}
              >
                Built-in library
              </Button>
            </div>
            <input
              ref={folderInput}
              className="hidden"
              type="file"
              multiple
              onChange={(event) => {
                uploadFolder(event.currentTarget.files);
                event.currentTarget.value = "";
              }}
            />
            <Field label="Original source path (optional for manifest export)">
              <input
                className={fieldClass}
                placeholder="/home/.../dataset"
                value={userSourceRoot}
                disabled={busy !== null}
                onChange={(event) => setUserSourceRoot(event.target.value)}
              />
            </Field>
            {sourceSummary && (
              <p className="text-xs text-muted-foreground">
                {sourceSummary.human_count} human · {sourceSummary.robot_count} robot · {Object.keys(sourceSummary.folders).length} folders
              </p>
            )}
          </div>
        </WorkflowStep>

        <WorkflowStep
          title="2. Configure"
          status={embedding === "handcrafted" ? "Handcrafted" : "Reserved"}
        >
          <div className="grid gap-2.5">
            <Field label="Embedding">
              <select
                className={fieldClass}
                value={embedding}
                disabled={busy !== null}
                onChange={(event) => setEmbedding(event.target.value as AnalysisEmbedding)}
              >
                <option value="handcrafted">Handcrafted features</option>
                <option value="pae" disabled>PAE (reserved)</option>
              </select>
            </Field>
            <label className="flex min-h-8 items-center gap-2 text-xs font-medium text-foreground">
              <input
                type="checkbox"
                className="size-4 accent-primary"
                checked={force}
                disabled={busy !== null}
                onChange={(event) => setForce(event.target.checked)}
              />
              Ignore cache
            </label>
            <div className="grid grid-cols-2 gap-2">
              <Button
                variant="primary"
                size="sm"
                disabled={!source.trim() || busy !== null}
                onClick={runAnalysis}
              >
                {busy === "analyze" ? "Analyzing..." : "Start analysis"}
              </Button>
              <Button size="sm" disabled={!source.trim() || busy !== null} onClick={() => void loadCached()}>
                Load cached
              </Button>
            </div>
            {busy === "analyze" && (
              <div
                className="h-1.5 overflow-hidden rounded-full bg-border-subtle"
                role="progressbar"
                aria-valuenow={Math.round(progress * 100)}
                aria-valuemin={0}
                aria-valuemax={100}
              >
                <div className="h-full bg-primary transition-[width]" style={{ width: `${Math.max(2, progress * 100)}%` }} />
              </div>
            )}
          </div>
        </WorkflowStep>

        <WorkflowStep
          title="3. Analyze"
          status={busy === "analyze" ? "Running" : result ? "Complete" : "Not started"}
        >
          <div className="grid gap-2">
            <p className="text-xs text-muted-foreground">
              {status || "Run analysis to calculate dynamics, quality, tags, embedding, and clusters."}
            </p>
            {error && (
              <p className="break-words rounded-md border border-[#efcccc] bg-[#fff5f4] px-2.5 py-2 text-[11px] text-[#8c2929]" role="alert">
                {error}
              </p>
            )}
          </div>
        </WorkflowStep>

        <WorkflowStep
          title="4. Results"
          status={summary ? `${summary.num_ok} analyzed` : "No results"}
          defaultOpen={Boolean(result)}
        >
          {!result || !summary ? (
            <p className="text-xs leading-[1.5] text-muted-foreground">Analysis results will appear here.</p>
          ) : (
            <div className="grid gap-3">
              <SummaryCards summary={summary} />

              {hasRobotClips && (
                <Field label="Preview robot">
                  <select
                    className={fieldClass}
                    value={previewRobot}
                    disabled={busy !== null}
                    onChange={(event) => setPreviewRobot(event.target.value)}
                  >
                    <option value="">Auto-detect from trajectory</option>
                    {robots.map((robot) => (
                      <option key={robot.name} value={robot.name}>
                        {robot.display_name}
                      </option>
                    ))}
                  </select>
                </Field>
              )}

              {summary.num_error > 0 && (
                <details className="rounded-md border border-[#ead7b0] bg-[#fffaf0] px-2.5 py-2">
                  <summary className="cursor-pointer list-none text-xs font-semibold text-[#7a4b00] [&::-webkit-details-marker]:hidden">
                    {summary.num_error} clips could not be analyzed
                  </summary>
                  <div className="mt-2 grid gap-1.5">
                    {result.clips
                      .filter((clip) => clip.error)
                      .map((clip) => (
                        <div key={clip.clip_id} className="grid gap-0.5 text-[11px] text-[#7a4b00]">
                          <span className="font-medium">{clipLabel(clip)}</span>
                          <span className="break-words opacity-80">{clip.error}</span>
                        </div>
                      ))}
                  </div>
                </details>
              )}

              <div className="grid gap-2 rounded-md border border-border-subtle bg-background p-2.5">
                <div className="flex items-center justify-between gap-2">
                  <h2 className="text-sm font-semibold text-foreground">Embedding map</h2>
                  <span className="text-[11px] text-muted-foreground">{Object.keys(summary.cluster_counts).length} clusters</span>
                </div>
                <ScatterPlot clips={filteredClips} selectedIds={selectedIds} subsetIds={subsetIds} onSelect={toggleSelected} />
              </div>

              <div className="grid gap-2 rounded-md border border-border-subtle bg-background p-2.5">
                <div className="grid grid-cols-3 gap-1.5">
                  <select className={fieldClass} aria-label="Analysis tag filter" value={tagFilter} onChange={(event) => setTagFilter(event.target.value)}>
                    <option value="all">All tags</option>
                    {tags.map((tag) => <option key={tag} value={tag}>{tag} ({summary.tag_counts[tag] ?? 0})</option>)}
                  </select>
                  <select className={fieldClass} aria-label="Analysis source kind filter" value={kindFilter} onChange={(event) => setKindFilter(event.target.value)}>
                    <option value="all">All sources</option>
                    {kinds.map((kind) => <option key={kind} value={kind}>{kind}</option>)}
                  </select>
                  <select className={fieldClass} aria-label="Analysis folder filter" value={folderFilter} onChange={(event) => setFolderFilter(event.target.value)}>
                    <option value="all">All folders</option>
                    {folders.map((folder) => <option key={folder} value={folder}>{folder}</option>)}
                  </select>
                </div>
                <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
                  <div>
                    <select className={fieldClass} aria-label="Analysis metric" value={metric} onChange={(event) => setMetric(event.target.value)}>
                      {summary.numeric_keys.map((key) => <option key={key} value={key}>{key}</option>)}
                    </select>
                    {typeof catalogMetric.desc === "string" && <p className="mt-1 text-[11px] text-muted-foreground">{catalogMetric.desc}</p>}
                  </div>
                  <div className="min-w-[120px] text-right text-[11px] text-muted-foreground">
                    <p>median {formatNumber(summary.histograms[metric]?.median)}</p>
                    <p>mean {formatNumber(summary.histograms[metric]?.mean)}</p>
                  </div>
                </div>
                <HistogramChart histogram={summary.histograms[metric]} />
              </div>

              <div className="grid gap-2 rounded-md border border-border-subtle bg-background p-2.5">
                <div className="flex items-center justify-between gap-2">
                  <h2 className="text-sm font-semibold text-foreground">Recommended subset</h2>
                  <span className="text-[11px] text-muted-foreground">{subsetIds.size ? `${subsetIds.size} recommended` : `${exportIds.length} selected for export`}</span>
                </div>
                <div className="grid grid-cols-[1fr_1fr_auto] items-end gap-2">
                  <Field label="Ratio %"><input className={fieldClass} type="number" min="1" max="100" value={subsetRatio} onChange={(event) => setSubsetRatio(event.target.value)} /></Field>
                  <Field label="Coverage alpha"><input className={fieldClass} type="number" min="0" max="1" step="0.01" value={subsetAlpha} onChange={(event) => setSubsetAlpha(event.target.value)} /></Field>
                  <Button size="sm" disabled={busy !== null || !filteredClips.length} onClick={recommendSubset}>{busy === "subset" ? "Selecting..." : "Recommend"}</Button>
                </div>
                <div className="grid grid-cols-4 gap-1.5">
                  <Button size="sm" disabled={busy !== null || !filteredClips.length} onClick={() => setSelectedIds(new Set(filteredClips.map((clip) => clip.clip_id)))}>Select visible</Button>
                  <Button size="sm" disabled={busy !== null || !selectedIds.size} onClick={() => setSelectedIds(new Set())}>Clear selection</Button>
                  <Button size="sm" disabled={busy !== null || !exportIds.length} onClick={() => void exportManifest("json")}>Export JSON</Button>
                  <Button size="sm" disabled={busy !== null || !exportIds.length} onClick={() => void exportManifest("csv")}>Export CSV</Button>
                </div>
                <Button size="sm" disabled={busy !== null || !selectedRobotCount} onClick={() => void exportRobots()}>Export robot ZIP ({selectedRobotCount})</Button>
              </div>

              <div className="grid gap-1.5">
                <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                  <span>{filteredClips.length} visible clips</span>
                  <span>{selectedIds.size} manually selected</span>
                </div>
                <div className="grid max-h-[300px] gap-1 overflow-y-auto pr-1">
                  {filteredClips.map((clip) => {
                    const recommended = subsetIds.has(clip.clip_id);
                    return (
                      <div key={clip.clip_id} className="grid grid-cols-[auto_minmax(0,1fr)_72px_auto] items-center gap-2 rounded-md border border-border-subtle bg-surface px-2 py-1.5">
                        <input type="checkbox" className="size-4 accent-primary" checked={selectedIds.has(clip.clip_id)} onChange={() => toggleSelected(clip.clip_id)} aria-label={`Select ${clipLabel(clip)}`} />
                        <button type="button" className="min-w-0 truncate text-left text-xs font-medium text-foreground hover:text-primary" title={clip.source_path} onClick={() => toggleSelected(clip.clip_id)}>
                          {clipLabel(clip)}
                          <span className="ml-1 text-[10px] font-normal text-muted-foreground">{clip.folder_label}</span>
                        </button>
                        <span className="text-right text-[11px] text-muted-foreground">{formatNumber(clip.metrics[metric])}</span>
                        <div className="flex items-center gap-1">
                          {recommended && <span className="text-[10px] font-semibold text-[#b35b00]">FPS</span>}
                          <Button size="sm" disabled={busy !== null} onClick={() => void previewClip(clip)}>{previewing === clip.clip_id ? "..." : "Preview"}</Button>
                        </div>
                      </div>
                    );
                  })}
                  {!filteredClips.length && <p className="py-4 text-center text-xs text-muted-foreground">No clips match these filters.</p>}
                </div>
              </div>
            </div>
          )}
        </WorkflowStep>
      </div>
    </InspectorPage>
  );
}
