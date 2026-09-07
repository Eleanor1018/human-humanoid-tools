import { useState } from "react";

import { Field, fieldClass } from "@/components/Field";
import { Button } from "@/components/ui/button";

import {
  validateExportOptions,
  type ExportFormat,
  type ExportOptions,
} from "./model";

export function ResultExportControls({
  token,
  resultFps,
  hasScene = false,
  buildUrl,
}: {
  readonly token: string;
  readonly resultFps?: number;
  readonly hasScene?: boolean;
  readonly buildUrl: (token: string, options: ExportOptions) => string;
}) {
  const [format, setFormat] = useState<ExportFormat>("csv");
  const [fps, setFps] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [csvHeader, setCsvHeader] = useState(true);

  const validation = validateExportOptions({
    format,
    fps,
    start,
    end,
    csvHeader,
  });
  const exportUrl = validation.valid
    ? buildUrl(token, validation.options)
    : null;
  const defaultFps =
    typeof resultFps === "number" && Number.isFinite(resultFps)
      ? resultFps
      : null;

  return (
    <section
      className="grid gap-2.5 border-t border-border-subtle pt-3"
      aria-label="Export result"
    >
      <div className="grid grid-cols-2 gap-2">
        <Field label="Export FPS">
          <input
            className={fieldClass}
            type="number"
            min="0.001"
            step="any"
            placeholder={
              defaultFps ? `Result: ${defaultFps.toFixed(1)}` : "Result FPS"
            }
            value={fps}
            aria-invalid={
              !validation.valid && validation.error.startsWith("Export FPS")
            }
            onChange={(event) => setFps(event.currentTarget.value)}
          />
        </Field>
        <Field label="Format">
          <select
            className={fieldClass}
            value={format}
            onChange={(event) =>
              setFormat(event.currentTarget.value as ExportFormat)
            }
          >
            <option value="csv">CSV</option>
            <option value="pkl">PKL</option>
          </select>
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Start (s)">
          <input
            className={fieldClass}
            type="number"
            min="0"
            step="0.01"
            placeholder="0"
            value={start}
            aria-invalid={
              !validation.valid && validation.error.startsWith("Start")
            }
            onChange={(event) => setStart(event.currentTarget.value)}
          />
        </Field>
        <Field label="End (s)">
          <input
            className={fieldClass}
            type="number"
            min="0"
            step="0.01"
            placeholder="End"
            value={end}
            aria-invalid={
              !validation.valid && validation.error.startsWith("End")
            }
            onChange={(event) => setEnd(event.currentTarget.value)}
          />
        </Field>
      </div>
      <label className="flex min-h-7 items-center gap-2 text-xs text-foreground">
        <input
          className="size-3.5 accent-primary"
          type="checkbox"
          checked={csvHeader}
          disabled={format !== "csv"}
          onChange={(event) => setCsvHeader(event.currentTarget.checked)}
        />
        Include CSV comments and column header
      </label>
      <p className="text-[10px] leading-[1.45] text-muted-foreground">
        Export FPS resamples the finished trajectory without running IK again.
        {hasScene ? " Terrain or object results download as a ZIP bundle." : ""}
      </p>
      {!validation.valid && (
        <p className="text-[11px] text-danger" role="alert">
          {validation.error}
        </p>
      )}
      {exportUrl ? (
        <a
          className="inline-flex min-h-[30px] items-center justify-center rounded-md border border-primary bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-accent-foreground"
          href={exportUrl}
          download
        >
          Download result
        </a>
      ) : (
        <Button size="sm" variant="primary" disabled>
          Download result
        </Button>
      )}
    </section>
  );
}
