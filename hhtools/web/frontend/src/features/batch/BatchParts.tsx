import { useRef, type ChangeEvent, type ReactNode } from "react";

import { Field, fieldClass } from "@/components/Field";
import { ImportDropzone } from "@/components/ImportDropzone";
import { SearchField } from "@/components/SearchField";
import { Button } from "@/components/ui/button";
import type { MotionLibraryEntry } from "@/features/motion/api";
import type { RobotSummary } from "@/features/robot/api";
import type { JobSnapshot, UploadFile } from "@/lib/api";
import { cn } from "@/lib/utils";

import {
  batchDownloadUrl,
  type BatchBackend,
  type BatchFailure,
  type BatchFormat,
  type BatchResult,
} from "./api";
import { entryKey, entryReference, entryTitle } from "./model";

export function StatusMessage({
  children,
  error = false,
}: {
  children?: ReactNode;
  error?: boolean;
}) {
  if (!children) return null;
  return (
    <p
      className={cn(
        "rounded-md border px-2.5 py-2 text-[11px] leading-relaxed [overflow-wrap:anywhere]",
        error
          ? "border-danger-border bg-danger-muted text-danger"
          : "border-border-subtle bg-background text-muted-foreground",
      )}
      role={error ? "alert" : "status"}
    >
      {children}
    </p>
  );
}

export function RobotSelect({
  label,
  robots,
  value,
  loadedName,
  busy,
  onChange,
  onLoad,
}: {
  label: string;
  robots: readonly RobotSummary[];
  value: string;
  loadedName?: string | null;
  busy: boolean;
  onChange(value: string): void;
  onLoad(): void;
}) {
  const loaded = Boolean(value && value === loadedName);
  return (
    <div className="grid gap-2">
      <select
        className={fieldClass}
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
        disabled={busy}
      >
        <option value="">Select a robot…</option>
        {robots.map((robot) => (
          <option key={robot.name} value={robot.name} disabled={!robot.has_urdf}>
            {robot.display_name || robot.name} ({robot.num_dof} DoF)
          </option>
        ))}
      </select>
      <Button size="sm" onClick={onLoad} disabled={busy || !value || loaded}>
        {loaded ? "Robot loaded" : "Load robot"}
      </Button>
    </div>
  );
}

export function FileImport({
  title,
  hint,
  icon,
  accept,
  busy,
  onFiles,
}: {
  title: string;
  hint: string;
  icon: string;
  accept?: string;
  busy: boolean;
  onFiles(files: readonly UploadFile[]): void | Promise<void>;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const receive = (event: ChangeEvent<HTMLInputElement>) => {
    const files = [...(event.currentTarget.files ?? [])] as UploadFile[];
    event.currentTarget.value = "";
    if (files.length) void onFiles(files);
  };
  return (
    <ImportDropzone
      label={title}
      icon={icon}
      title={title}
      hint={hint}
      disabled={busy}
      onFiles={onFiles}
    >
      <input
        ref={fileInput}
        className="hidden"
        type="file"
        multiple
        accept={accept}
        disabled={busy}
        onChange={receive}
      />
      <input
        ref={folderInput}
        className="hidden"
        type="file"
        multiple
        disabled={busy}
        onChange={receive}
        {...({ webkitdirectory: "" } as React.InputHTMLAttributes<HTMLInputElement>)}
      />
      <Button size="sm" disabled={busy} onClick={() => fileInput.current?.click()}>
        Files
      </Button>
      <Button size="sm" disabled={busy} onClick={() => folderInput.current?.click()}>
        Folder
      </Button>
    </ImportDropzone>
  );
}

export function EntryList({
  entries,
  busy,
  kind,
  onRemove,
  onClear,
}: {
  entries: readonly MotionLibraryEntry[];
  busy: boolean;
  kind: "human" | "robot";
  onRemove(key: string): void;
  onClear(): void;
}) {
  return (
    <div className="grid gap-2">
      <div className="max-h-48 overflow-y-auto rounded-md border border-border-subtle bg-surface">
        {entries.length ? (
          entries.map((entry) => (
            <div
              key={entryKey(entry)}
              className="grid min-h-11 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 border-b border-border-subtle px-2.5 py-2 last:border-b-0"
            >
              <div className="min-w-0">
                <p className="truncate text-xs font-semibold text-foreground" title={entryTitle(entry)}>
                  {entryTitle(entry)}
                </p>
                <p className="truncate text-[10px] text-muted-foreground">
                  {kind === "human"
                    ? `${entry.motion_category ?? "motion"} · ${entryReference(entry).toUpperCase()}`
                    : entry.upload_profile ?? "auto"}
                </p>
              </div>
              <button
                type="button"
                className="size-7 rounded-md text-lg leading-none text-muted-foreground hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                aria-label={`Remove ${entryTitle(entry)}`}
                title="Remove"
                disabled={busy}
                onClick={() => onRemove(entryKey(entry))}
              >
                ×
              </button>
            </div>
          ))
        ) : (
          <p className="px-3 py-5 text-center text-xs text-muted-foreground">
            No inputs yet.
          </p>
        )}
      </div>
      <div className="flex items-center justify-between gap-3 text-[11px] text-muted-foreground">
        <span>{entries.length} {kind === "human" ? "clips" : "trajectories"}</span>
        <Button size="sm" variant="ghost" disabled={busy || !entries.length} onClick={onClear}>
          Clear all
        </Button>
      </div>
    </div>
  );
}

export function LibraryPicker({
  entries,
  selection,
  disabled,
  query,
  onQueryChange,
  onSelectionChange,
  onAdd,
}: {
  entries: readonly MotionLibraryEntry[];
  selection: ReadonlySet<string>;
  disabled: boolean;
  query: string;
  onQueryChange(value: string): void;
  onSelectionChange(value: ReadonlySet<string>): void;
  onAdd(): void;
}) {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  const visible = entries.filter((entry) => {
    const text = [entryTitle(entry), entry.folder_label, entry.dataset, entry.reference]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return tokens.every((token) => text.includes(token));
  });
  const toggle = (key: string) => {
    const next = new Set(selection);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    onSelectionChange(next);
  };
  return (
    <details className="rounded-md border border-border-subtle bg-background">
      <summary className="cursor-pointer list-none px-2.5 py-2 text-xs font-semibold text-foreground [&::-webkit-details-marker]:hidden">
        Add from Motion Library
      </summary>
      <div className="grid gap-2 border-t border-border-subtle p-2.5">
        <SearchField
          label="Search Motion Library"
          placeholder="Search motions…"
          value={query}
          disabled={disabled}
          onChange={(event) => onQueryChange(event.currentTarget.value)}
        />
        <div className="max-h-40 overflow-y-auto rounded-md border border-border-subtle bg-surface">
          {visible.map((entry) => {
            const key = entryKey(entry);
            return (
              <label
                key={key}
                className="flex min-h-9 cursor-pointer items-center gap-2 border-b border-border-subtle px-2.5 py-1.5 last:border-b-0 hover:bg-accent"
              >
                <input
                  className="size-3.5 accent-primary"
                  type="checkbox"
                  checked={selection.has(key)}
                  disabled={disabled}
                  onChange={() => toggle(key)}
                />
                <span className="min-w-0 flex-1 truncate text-[11px] text-foreground">
                  {entryTitle(entry)}
                </span>
                <span className="shrink-0 text-[10px] text-muted-foreground">
                  {entryReference(entry).toUpperCase()}
                </span>
              </label>
            );
          })}
          {!visible.length && (
            <p className="px-3 py-4 text-center text-[11px] text-muted-foreground">
              No matching motions.
            </p>
          )}
        </div>
        <Button size="sm" onClick={onAdd} disabled={disabled || !selection.size}>
          Add {selection.size || "selected"}
        </Button>
      </div>
    </details>
  );
}

export interface CommonBatchSettingsValue {
  backend: BatchBackend;
  format: BatchFormat;
  csvHeader: boolean;
  retargetFps: string;
  exportFps: string;
  start: string;
  end: string;
  output: string;
}

export function CommonBatchSettings({
  value,
  disabled,
  sourceFps,
  batchSize,
  onChange,
  onSourceFpsChange,
  onBatchSizeChange,
}: {
  value: CommonBatchSettingsValue;
  disabled: boolean;
  sourceFps?: string;
  batchSize?: string;
  onChange(patch: Partial<CommonBatchSettingsValue>): void;
  onSourceFpsChange?(value: string): void;
  onBatchSizeChange?(value: string): void;
}) {
  return (
    <div className="grid gap-2.5">
      <div className="grid grid-cols-2 gap-2">
        <Field label="Solver">
          <select
            className={fieldClass}
            value={value.backend}
            disabled={disabled}
            onChange={(event) => onChange({ backend: event.currentTarget.value as BatchBackend })}
          >
            <option value="newton">Newton IK</option>
            <option value="interaction_mesh">Interaction-Mesh</option>
          </select>
        </Field>
        <Field label="Output format">
          <select
            className={fieldClass}
            value={value.format}
            disabled={disabled}
            onChange={(event) => onChange({ format: event.currentTarget.value as BatchFormat })}
          >
            <option value="pkl">PKL</option>
            <option value="csv">CSV</option>
          </select>
        </Field>
      </div>
      <details className="rounded-md border border-border-subtle bg-background">
        <summary className="cursor-pointer list-none px-2.5 py-2 text-xs font-semibold text-foreground [&::-webkit-details-marker]:hidden">
          Advanced settings
        </summary>
        <div className="grid gap-2.5 border-t border-border-subtle p-2.5">
          {batchSize !== undefined && value.backend === "newton" && (
            <Field label="GPU batch size">
              <input
                className={fieldClass}
                type="number"
                min="1"
                max="256"
                placeholder="Auto"
                value={batchSize}
                disabled={disabled}
                onChange={(event) => onBatchSizeChange?.(event.currentTarget.value)}
              />
            </Field>
          )}
          <div className="grid grid-cols-2 gap-2">
            {sourceFps !== undefined && (
              <Field label="Source FPS">
                <input
                  className={fieldClass}
                  type="number"
                  min="1"
                  value={sourceFps}
                  disabled={disabled}
                  onChange={(event) => onSourceFpsChange?.(event.currentTarget.value)}
                />
              </Field>
            )}
            <Field label="Retarget FPS">
              <input
                className={fieldClass}
                type="number"
                min="1"
                placeholder="Source"
                value={value.retargetFps}
                disabled={disabled}
                onChange={(event) => onChange({ retargetFps: event.currentTarget.value })}
              />
            </Field>
            <Field label="Export FPS">
              <input
                className={fieldClass}
                type="number"
                min="1"
                placeholder="Retarget"
                value={value.exportFps}
                disabled={disabled}
                onChange={(event) => onChange({ exportFps: event.currentTarget.value })}
              />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Start (s)">
              <input
                className={fieldClass}
                type="number"
                min="0"
                value={value.start}
                disabled={disabled}
                onChange={(event) => onChange({ start: event.currentTarget.value })}
              />
            </Field>
            <Field label="End (s)">
              <input
                className={fieldClass}
                type="number"
                min="0"
                placeholder="End"
                value={value.end}
                disabled={disabled}
                onChange={(event) => onChange({ end: event.currentTarget.value })}
              />
            </Field>
          </div>
          {value.format === "csv" && (
            <label className="flex min-h-8 items-center justify-between gap-3 text-xs font-medium text-foreground">
              Include CSV header
              <input
                type="checkbox"
                className="size-4 accent-primary"
                checked={value.csvHeader}
                disabled={disabled}
                onChange={(event) => onChange({ csvHeader: event.currentTarget.checked })}
              />
            </label>
          )}
          <Field label="Result name">
            <input
              className={fieldClass}
              value={value.output}
              disabled={disabled}
              onChange={(event) => onChange({ output: event.currentTarget.value })}
            />
          </Field>
        </div>
      </details>
    </div>
  );
}

export function BatchProgress({ job }: { job: JobSnapshot<BatchResult> | null }) {
  if (!job) return null;
  const rows = [
    ["Overall", job.progress ?? 0],
    ["Current", job.clip_progress ?? 0],
  ] as const;
  return (
    <div className="grid gap-2" role="status" aria-live="polite">
      {rows.map(([label, value]) => (
        <div key={label} className="grid grid-cols-[52px_minmax(0,1fr)_32px] items-center gap-2 text-[10px] text-muted-foreground">
          <span>{label}</span>
          <progress className="h-1.5 w-full accent-primary" max="1" value={value} />
          <strong className="text-right text-foreground">{Math.round(value * 100)}%</strong>
        </div>
      ))}
      {job.message && <p className="text-[11px] text-muted-foreground">{job.message}</p>}
    </div>
  );
}

function FailureList({ failures }: { failures: readonly BatchFailure[] }) {
  if (!failures.length) return null;
  return (
    <details className="rounded-md border border-danger-border bg-danger-muted" open>
      <summary className="cursor-pointer list-none px-2.5 py-2 text-xs font-semibold text-danger [&::-webkit-details-marker]:hidden">
        Failures ({failures.length})
      </summary>
      <ul className="grid max-h-44 gap-2 overflow-y-auto border-t border-danger-border p-2.5">
        {failures.map((failure, index) => (
          <li key={`${failure.stem ?? "clip"}-${index}`} className="text-[11px] leading-relaxed text-danger">
            <strong>{failure.stem || "Untitled clip"}</strong>
            <span className="ml-1 rounded bg-surface/70 px-1 py-0.5 text-[9px] uppercase">
              {failure.stage || "unknown"}
            </span>
            <p className="break-words">{failure.reason || "Unknown error"}</p>
            {failure.log_rel && <code className="break-all">{failure.log_rel}</code>}
            {!failure.log_rel && failure.stash_error && (
              <p className="break-words">Source copy failed: {failure.stash_error}</p>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}

export function BatchResultPanel({
  jobId,
  result,
}: {
  jobId: string;
  result: BatchResult;
}) {
  return (
    <div className="grid gap-2.5">
      <div className="rounded-md border border-border-subtle bg-background p-2.5 text-[11px] text-muted-foreground">
        <p className="font-semibold text-foreground">
          {result.failures.length ? "Completed with failures" : "Batch complete"}
        </p>
        <p className="mt-1">
          {result.written.length} succeeded · {result.failures.length} failed
          {result.solver_mode ? ` · ${result.solver_mode}` : ""}
        </p>
        {result.failure_log && (
          <p className="mt-1 break-all">Failure data: <code>{result.failure_log}</code></p>
        )}
      </div>
      {result.download_name && (
        <a
          className="inline-flex min-h-[30px] min-w-0 items-center justify-center truncate rounded-md border border-border bg-surface px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:border-primary hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring"
          href={batchDownloadUrl(jobId)}
          download={result.download_name}
        >
          Download ZIP
        </a>
      )}
      <FailureList failures={result.failures} />
    </div>
  );
}
