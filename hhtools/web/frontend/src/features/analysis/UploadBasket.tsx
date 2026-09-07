import { Button } from "@/components/ui/button";

import type { DatasetUploadSummary } from "./api";

export interface UploadBasketProps {
  readonly summary: DatasetUploadSummary;
  readonly disabled: boolean;
  readonly onRemove: (folder: string) => void;
  readonly onClear: () => void;
}

export function UploadBasket({
  summary,
  disabled,
  onRemove,
  onClear,
}: UploadBasketProps) {
  const namesByFolder = new Map<string, string[]>();
  for (const clip of summary.clips) {
    const names = namesByFolder.get(clip.folder_label) ?? [];
    names.push(clip.clip_id.split("/").pop() || clip.clip_id);
    namesByFolder.set(clip.folder_label, names);
  }
  const folders = Object.entries(summary.folders).sort(([left], [right]) =>
    left.localeCompare(right),
  );

  return (
    <div className="grid gap-2 rounded-md border border-border-subtle bg-background p-2.5">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-semibold text-foreground">
          Upload basket · {summary.clip_count} clips
        </p>
        <Button size="sm" disabled={disabled || !folders.length} onClick={onClear}>
          Clear
        </Button>
      </div>
      <ul className="grid gap-1" aria-label="Uploaded dataset folders">
        {folders.map(([folder, count]) => {
          const names = namesByFolder.get(folder) ?? [];
          return (
            <li
              key={folder}
              className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-md border border-border-subtle bg-surface px-2 py-1.5"
            >
              <span className="min-w-0">
                <span className="block truncate text-xs font-medium text-foreground" title={folder}>
                  {folder}
                </span>
                <span className="block truncate text-[10px] text-muted-foreground">
                  {count} clips
                  {names.length ? ` · ${names.slice(0, 3).join(" · ")}${names.length > 3 ? " …" : ""}` : ""}
                </span>
              </span>
              <button
                type="button"
                className="flex size-7 items-center justify-center rounded-md text-base leading-none text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
                disabled={disabled}
                aria-label={`Remove ${folder}`}
                title="Remove folder"
                onClick={() => onRemove(folder)}
              >
                ×
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
