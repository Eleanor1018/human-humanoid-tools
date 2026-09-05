import { useEffect, useRef, useState, type ReactNode } from "react";

import { Field, fieldClass } from "@/components/Field";
import { Button } from "@/components/ui/button";
import {
  getJobAdmissionSettings,
  updateJobAdmissionSettings,
  type JobAdmissionSnapshot,
} from "@/features/settings/api";

import { PROJECT_README_URL } from "../appCommands";

export type ApplicationDialog = "settings" | "about" | null;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function Modal({
  title,
  onClose,
  children,
}: {
  readonly title: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    panel.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[400] grid place-items-center bg-black/35 p-4"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panel}
        className="grid w-full max-w-[440px] gap-4 rounded-lg border border-border-subtle bg-surface p-4 text-foreground shadow-[0_18px_50px_rgba(0,0,0,0.22)] outline-none"
        role="dialog"
        aria-modal="true"
        aria-labelledby="application-dialog-title"
        tabIndex={-1}
      >
        <header className="flex items-center justify-between gap-3">
          <h2
            id="application-dialog-title"
            className="text-base font-bold tracking-normal"
          >
            {title}
          </h2>
          <Button size="sm" variant="ghost" onClick={onClose}>
            Close
          </Button>
        </header>
        {children}
      </div>
    </div>
  );
}

function parseLimit(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }
  return parsed;
}

function SettingsDialog({ onClose }: { readonly onClose: () => void }) {
  const [snapshot, setSnapshot] = useState<JobAdmissionSnapshot | null>(null);
  const [runningLimit, setRunningLimit] = useState("0");
  const [queueLimit, setQueueLimit] = useState("0");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const request = new AbortController();
    void getJobAdmissionSettings({ signal: request.signal })
      .then((result) => {
        if (request.signal.aborted) return;
        setSnapshot(result);
        setRunningLimit(String(result.max_running_jobs));
        setQueueLimit(String(result.max_queued_jobs));
      })
      .catch((reason: unknown) => {
        if (!request.signal.aborted) setError(errorMessage(reason));
      })
      .finally(() => {
        if (!request.signal.aborted) setLoading(false);
      });
    return () => request.abort();
  }, []);

  const save = async () => {
    if (snapshot?.editable !== true) return;
    setError(null);
    setSaved(false);
    let maxRunningJobs: number;
    let maxQueuedJobs: number;
    try {
      maxRunningJobs = parseLimit(runningLimit, "Concurrent jobs");
      maxQueuedJobs = parseLimit(queueLimit, "Queued jobs");
    } catch (reason) {
      setError(errorMessage(reason));
      return;
    }

    setSaving(true);
    try {
      const result = await updateJobAdmissionSettings({
        max_running_jobs: maxRunningJobs,
        max_queued_jobs: maxQueuedJobs,
      });
      setSnapshot(result);
      setRunningLimit(String(result.max_running_jobs));
      setQueueLimit(String(result.max_queued_jobs));
      setSaved(true);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title="Settings" onClose={onClose}>
      <form
        className="grid gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <div className="grid grid-cols-2 gap-3">
          <Field label="Concurrent jobs">
            <input
              className={fieldClass}
              type="number"
              min="0"
              step="1"
              value={runningLimit}
              disabled={loading || saving || snapshot?.editable !== true}
              onChange={(event) => setRunningLimit(event.currentTarget.value)}
            />
          </Field>
          <Field label="Queued jobs">
            <input
              className={fieldClass}
              type="number"
              min="0"
              step="1"
              value={queueLimit}
              disabled={loading || saving || snapshot?.editable !== true}
              onChange={(event) => setQueueLimit(event.currentTarget.value)}
            />
          </Field>
        </div>
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          0 means unlimited. Running: {snapshot?.running_jobs ?? "--"}; queued:{" "}
          {snapshot?.queued_jobs ?? "--"}.
        </p>
        {snapshot?.editable === false && (
          <p className="text-[11px] text-muted-foreground">
            These limits can only be changed from the local WebUI or desktop app.
          </p>
        )}
        {error && (
          <p
            className="rounded-md border border-danger-border bg-danger-muted px-2.5 py-2 text-[11px] text-danger"
            role="alert"
          >
            {error}
          </p>
        )}
        {saved && !error && (
          <p className="text-[11px] font-medium text-success" role="status">
            Settings saved.
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            variant="primary"
            type="submit"
            disabled={loading || saving || snapshot?.editable !== true}
          >
            {loading ? "Loading…" : saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function AboutDialog({ onClose }: { readonly onClose: () => void }) {
  return (
    <Modal title="About hhtools" onClose={onClose}>
      <div className="grid gap-2 text-sm leading-relaxed text-muted-foreground">
        <p className="font-semibold text-foreground">Human-Humanoid Tools</p>
        <p>Motion inspection, analysis, and humanoid retargeting tools.</p>
        <a
          className="w-fit text-primary hover:underline"
          href={PROJECT_README_URL}
          target="_blank"
          rel="noreferrer"
        >
          Project source and documentation
        </a>
      </div>
    </Modal>
  );
}

export function ApplicationDialogs({
  dialog,
  onClose,
}: {
  readonly dialog: ApplicationDialog;
  readonly onClose: () => void;
}) {
  if (dialog === "settings") return <SettingsDialog onClose={onClose} />;
  if (dialog === "about") return <AboutDialog onClose={onClose} />;
  return null;
}
