import { useEffect, useState } from "react";
import { ScatterPlot } from "../analysis/ScatterPlot";
import type { DatasetClip } from "../analysis/api";
import type { RuntimeArtifact, RuntimeConnection, RuntimeJob } from "./api";

interface Clip extends DatasetClip {
  asset_id: string;
  relative_path: string;
}

export function RuntimeAnalysis({
  connection,
  artifact,
  onPreview,
  onJob,
  onError,
}: {
  connection: RuntimeConnection;
  artifact: RuntimeArtifact;
  onPreview(source: { asset_id: string; member: string }): void;
  onJob(job: RuntimeJob): void;
  onError(error: unknown): void;
}) {
  const [clips, setClips] = useState<Clip[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [tags, setTags] = useState("");
  const [subset, setSubset] = useState(0);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [busy, setBusy] = useState(false);
  const parameters = () => ({
    job_id: artifact.job_id,
    artifact_id: artifact.artifact_id,
    tags: tags
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean),
    subset_size: subset > 0 ? subset : null,
    offset,
    limit: 100,
  });
  async function load() {
    setBusy(true);
    try {
      const report = await connection.json<{ clips: Clip[]; total: number }>(
        "/api/runtime/v1/analysis/select",
        "POST",
        parameters(),
      );
      setClips(report.clips);
      setTotal(report.total);
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void load();
  }, [artifact.artifact_id, offset]);

  async function exportSelection(format: string) {
    setBusy(true);
    try {
      const plan = await connection.json<{ plan_id: string }>(
        "/api/runtime/v1/workflows/analysis-export/preflight",
        "POST",
        {
          ...parameters(),
          clip_ids: [...selected],
          format,
        },
      );
      const job = await connection.json<RuntimeJob>(
        "/api/runtime/v1/jobs",
        "POST",
        { plan_id: plan.plan_id, idempotency_key: crypto.randomUUID() },
      );
      onJob(job);
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  }

  function choose(clip: DatasetClip, additive: boolean) {
    const next = additive ? new Set(selected) : new Set<string>();
    if (next.has(clip.clip_id)) next.delete(clip.clip_id);
    else next.add(clip.clip_id);
    setSelected(next);
  }

  return (
    <section className="runtime-analysis">
      <div className="runtime-toolbar">
        <h2>
          Analysis <small>{total} clips</small>
        </h2>
      </div>
      <div className="runtime-toolbar">
        <input
          aria-label="Analysis tags"
          placeholder="Tags"
          value={tags}
          onChange={(event) => setTags(event.target.value)}
        />
        <label>
          Subset{" "}
          <input
            aria-label="Subset size"
            type="number"
            min="0"
            max="10000"
            value={subset}
            onChange={(event) => setSubset(Number(event.target.value))}
          />
        </label>
        <button
          disabled={busy}
          onClick={() => {
            if (offset) setOffset(0);
            else void load();
          }}
        >
          Filter
        </button>
      </div>
      <ScatterPlot
        clips={clips}
        visibleIds={new Set(clips.map((clip) => clip.clip_id))}
        selectedIds={selected}
        subsetIds={new Set()}
        onActivate={choose}
      />
      <div className="runtime-table-wrap">
        <table>
          <thead>
            <tr>
              <th />
              <th>Clip</th>
              <th>Quality</th>
              <th>Tags</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {clips.map((clip) => (
              <tr key={clip.clip_id}>
                <td>
                  <input
                    type="checkbox"
                    aria-label={`Select ${clip.relative_path}`}
                    checked={selected.has(clip.clip_id)}
                    onChange={() => choose(clip, true)}
                  />
                </td>
                <td title={clip.clip_id}>{clip.relative_path}</td>
                <td>
                  {String(clip.metrics.quality_score ?? clip.error ?? "")}
                </td>
                <td>{clip.tags.join(", ")}</td>
                <td>
                  <button
                    onClick={() =>
                      onPreview({
                        asset_id: clip.asset_id,
                        member: clip.relative_path,
                      })
                    }
                  >
                    View
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="runtime-toolbar">
        <button
          disabled={busy || offset === 0}
          onClick={() => setOffset(Math.max(0, offset - 100))}
        >
          Previous
        </button>
        <span>
          {total ? offset + 1 : 0}-{Math.min(offset + 100, total)} / {total}
        </span>
        <button
          disabled={busy || offset + 100 >= total}
          onClick={() => setOffset(offset + 100)}
        >
          Next
        </button>
        <button disabled={busy} onClick={() => void exportSelection("json")}>
          Export JSON
        </button>
        <button disabled={busy} onClick={() => void exportSelection("csv")}>
          Export CSV
        </button>
        {clips.some((clip) => clip.source_kind === "robot") && (
          <button
            disabled={busy}
            onClick={() => void exportSelection("robot_zip")}
          >
            Export clips
          </button>
        )}
      </div>
    </section>
  );
}
