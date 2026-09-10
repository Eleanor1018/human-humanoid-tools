import { useCallback, useEffect, useRef, useState } from "react";
import { LocaleProvider } from "../../LocaleProvider";
import {
  RuntimeConnection,
  type RuntimeAsset,
  type RuntimeIdentity,
  type RuntimeJob,
  type RuntimeOperation,
  type RuntimeArtifact,
} from "./api";
import { RuntimeViewer, type PreviewSession } from "./RuntimeViewer";
import { RuntimeAnalysis } from "./RuntimeAnalysis";
import "./runtime.css";

type Tab = "assets" | "jobs" | "operations" | "settings";
type Source = {
  asset_id?: string;
  job_id?: string;
  artifact_id?: string;
  member?: string;
};
interface CatalogAsset {
  root_id: string;
  relative_path: string;
  display_name: string;
  kind: string;
  category: string;
  recursive: boolean;
}

export function RuntimeApp() {
  const [endpoint, setEndpoint] = useState(window.location.origin);
  const [token, setToken] = useState("");
  const [connection, setConnection] = useState<RuntimeConnection | null>(null);
  const [identity, setIdentity] = useState<RuntimeIdentity | null>(null);
  const [tab, setTab] = useState<Tab>(
    new URLSearchParams(location.search).has("job") ? "jobs" : "assets",
  );
  const [assets, setAssets] = useState<RuntimeAsset[]>([]);
  const [jobs, setJobs] = useState<RuntimeJob[]>([]);
  const [operations, setOperations] = useState<RuntimeOperation[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [job, setJob] = useState<RuntimeJob | null>(null);
  const [artifacts, setArtifacts] = useState<RuntimeArtifact[]>([]);
  const [analysis, setAnalysis] = useState<RuntimeArtifact | null>(null);
  const [session, setSession] = useState<PreviewSession | null>(null);
  const [source, setSource] = useState<Source | null>(null);
  const [mode, setMode] = useState<"data" | "webrtc">("data");
  const [operation, setOperation] = useState("hhtools_preflight_retarget");
  const [input, setInput] = useState('{\n  "request": {}\n}');
  const [result, setResult] = useState<unknown>(null);
  const [budget, setBudget] = useState<Record<string, number>>({});
  const [uploadKind, setUploadKind] = useState("motion_bundle");
  const [query, setQuery] = useState("");
  const [catalog, setCatalog] = useState<CatalogAsset[] | null>(null);
  const catalogDialog = useRef<HTMLDialogElement>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [uploadProgress, setUploadProgress] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const previewRef = useRef<{
    connection: RuntimeConnection;
    id: string;
  } | null>(null);
  const reportError = useCallback((value: unknown) => {
    setError(value instanceof Error ? value.message : String(value));
  }, []);

  useEffect(() => {
    if (catalog !== null) catalogDialog.current?.showModal();
    else catalogDialog.current?.close();
  }, [catalog]);

  const refresh = useCallback(async (client: RuntimeConnection) => {
    const [assetPage, jobPage] = await Promise.all([
      client.json<{ assets: RuntimeAsset[] }>("/api/agent/v1/assets?limit=500"),
      client.json<{ jobs: RuntimeJob[] }>("/api/runtime/v1/jobs?limit=100"),
    ]);
    setAssets(assetPage.assets);
    setJobs(jobPage.jobs);
  }, []);

  const connect = useCallback(
    async (client: RuntimeConnection, checkLink = false) => {
      const params = new URLSearchParams(location.search);
      const current = await client.connect(
        checkLink
          ? {
              runtime_id: params.get("runtime_id") ?? undefined,
              workspace_id: params.get("workspace_id") ?? undefined,
            }
          : undefined,
      );
      const catalog = await client.json<{
        operations: RuntimeOperation[];
        budget: Record<string, number>;
      }>("/api/runtime/v1/operations");
      setConnection(client);
      setIdentity(current);
      setOperations(catalog.operations);
      setBudget(catalog.budget);
      setError("");
      await refresh(client);
      const linkedJob = checkLink ? params.get("job") : null;
      if (linkedJob)
        setJob(
          await client.json<RuntimeJob>(
            `/api/runtime/v1/jobs/${encodeURIComponent(linkedJob)}`,
          ),
        );
    },
    [refresh],
  );

  useEffect(() => {
    void connect(new RuntimeConnection(window.location.origin), true).catch(
      reportError,
    );
  }, [connect, reportError]);
  useEffect(() => {
    if (!connection) return;
    const timer = setInterval(() => {
      void refresh(connection).catch(reportError);
    }, 3000);
    return () => clearInterval(timer);
  }, [connection, refresh, reportError]);
  useEffect(() => {
    if (!job || !connection) return;
    const current = jobs.find((item) => item.job_id === job.job_id);
    if (current && current.progress.revision !== job.progress.revision)
      setJob(current);
    void connection
      .json<{ artifacts: RuntimeArtifact[] }>(
        `/api/runtime/v1/jobs/${encodeURIComponent(job.job_id)}/artifacts?limit=500`,
      )
      .then((page) => setArtifacts(page.artifacts))
      .catch(reportError);
  }, [job, jobs, connection, reportError]);
  useEffect(
    () => () => {
      const preview = previewRef.current;
      if (preview)
        void preview.connection
          .response(`/api/runtime/v1/previews/${preview.id}`, {
            method: "DELETE",
            keepalive: true,
          })
          .catch(() => undefined);
    },
    [],
  );

  async function run(label: string, action: () => Promise<void>) {
    setBusy(label);
    setError("");
    try {
      await action();
    } catch (reason) {
      reportError(reason);
    } finally {
      setBusy("");
    }
  }

  async function preview(nextSource: Source, nextMode = mode) {
    if (!connection) return;
    await run("Opening preview", async () => {
      if (previewRef.current)
        await previewRef.current.connection.json(
          `/api/runtime/v1/previews/${previewRef.current.id}`,
          "DELETE",
        );
      previewRef.current = null;
      setSession(null);
      setSource(nextSource);
      setMode(nextMode);
      const opened = await connection.json<PreviewSession>(
        "/api/runtime/v1/previews",
        "POST",
        { source: nextSource, mode: nextMode },
      );
      previewRef.current = { connection, id: opened.session_id };
      setSession(opened);
    });
  }

  async function startWorkflow(workflow: "analysis" | "video_to_motion") {
    if (!connection) return;
    await run("Submitting workflow", async () => {
      const plan = await connection.json<{ plan_id: string }>(
        "/api/runtime/v1/workflows/preflight",
        "POST",
        { workflow, asset_ids: selected },
      );
      const started = await connection.json<RuntimeJob>(
        "/api/runtime/v1/jobs",
        "POST",
        { plan_id: plan.plan_id, idempotency_key: crypto.randomUUID() },
      );
      setJob(started);
      setTab("jobs");
      await refresh(connection);
    });
  }

  async function upload(files: FileList | null) {
    if (!files?.length || !connection) return;
    await run("Uploading", async () => {
      setUploadProgress(0);
      const asset = await connection.upload(
        Array.from(files),
        uploadKind,
        setUploadProgress,
      );
      setSelected([asset.asset_id]);
      await refresh(connection);
    });
  }

  async function jobAction(action: "cancel" | "retry") {
    if (!connection || !job) return;
    await run(action, async () => {
      setJob(
        await connection.json<RuntimeJob>(
          `/api/runtime/v1/jobs/${encodeURIComponent(job.job_id)}/${action}`,
          "POST",
          action === "retry"
            ? { idempotency_key: crypto.randomUUID() }
            : undefined,
        ),
      );
      await refresh(connection);
    });
  }

  function copyJobLink() {
    if (!job || !identity) return;
    const link = new URL(endpoint);
    link.search = new URLSearchParams({
      job: job.job_id,
      runtime_id: identity.runtime_id,
      workspace_id: identity.workspace_id,
    }).toString();
    void navigator.clipboard.writeText(link.toString()).catch(reportError);
  }

  const operationSpec = operations.find((item) => item.name === operation);
  const visibleAssets = assets.filter((asset) =>
    `${asset.display_name} ${asset.kind}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  const selectedAssets = assets.filter((asset) =>
    selected.includes(asset.asset_id),
  );
  const selectedRobot = selectedAssets.find(
    (asset) => asset.kind === "robot_bundle",
  );
  const selectedMotion = selectedAssets.find(
    (asset) => asset.kind === "motion_bundle",
  );
  const resultPlan =
    result && typeof result === "object"
      ? ((result as { plan_id?: string }).plan_id ??
        (result as { plan?: { plan_id?: string } }).plan?.plan_id)
      : undefined;

  return (
    <LocaleProvider locale="en">
      <div className="runtime-app">
        <header className="runtime-header">
          <img src="/hhtools-robot.svg" alt="" />
          <strong>HHTools Runtime</strong>
          <span className="runtime-connection-status">
            {identity
              ? `${identity.mode} · ${identity.version}`
              : "Disconnected"}
          </span>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void run("Connecting", async () => {
                setJob(null);
                setSession(null);
                setSelected([]);
                await connect(new RuntimeConnection(endpoint, token));
              });
            }}
          >
            <input
              aria-label="Runtime endpoint"
              value={endpoint}
              onChange={(event) => setEndpoint(event.target.value)}
              type="url"
              required
            />
            <input
              aria-label="Access token"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              type="password"
              placeholder="Access token"
              autoComplete="off"
            />
            <button disabled={Boolean(busy)} type="submit">
              Connect
            </button>
          </form>
        </header>
        <nav className="runtime-nav" aria-label="Runtime workspace">
          {(
            [
              ["assets", "Assets", "motion"],
              ["jobs", "Tasks", "batch"],
              ["operations", "Operations", "h2r"],
              ["settings", "Settings", "robot"],
            ] as const
          ).map(([id, label, icon]) => (
            <button
              key={id}
              className={tab === id ? "active" : ""}
              onClick={() => {
                setTab(id);
                setQuery("");
              }}
              aria-current={tab === id ? "page" : undefined}
            >
              <img src={`/icons/sidebar/${icon}.svg`} alt="" />
              <span>{label}</span>
            </button>
          ))}
          <div className="runtime-nav-bottom">
            <img src="/roboparty.svg" alt="ROBOPARTY" />
            <small title={identity?.workspace_id}>
              {identity?.workspace_id.slice(-12)}
            </small>
          </div>
        </nav>
        <main className="runtime-main">
          {error && (
            <div className="runtime-error" role="alert">
              <span>{error}</span>
              <button
                title="Dismiss"
                aria-label="Dismiss"
                onClick={() => setError("")}
              >
                <img src="/icons/common/close.svg" alt="" />
              </button>
            </div>
          )}
          {busy && (
            <div className="runtime-progress" role="status">
              {busy}
              {busy === "Uploading"
                ? ` ${Math.round(uploadProgress * 100)}%`
                : ""}
            </div>
          )}
          {(tab === "assets" || tab === "jobs") && (
            <>
              <div className="runtime-viewer-band">
                <div className="runtime-viewer-title">
                  <span>
                    {source?.asset_id
                      ? assets.find(
                          (asset) => asset.asset_id === source.asset_id,
                        )?.display_name
                      : (job?.summary.workflow ?? "Viewport")}
                  </span>
                  <div
                    className="runtime-modes"
                    role="group"
                    aria-label="Rendering mode"
                  >
                    <button
                      className={mode === "data" ? "active" : ""}
                      disabled={Boolean(busy)}
                      onClick={() => {
                        if (source) void preview(source, "data");
                        else setMode("data");
                      }}
                    >
                      Client 3D
                    </button>
                    <button
                      className={mode === "webrtc" ? "active" : ""}
                      disabled={Boolean(busy)}
                      onClick={() => {
                        if (source) void preview(source, "webrtc");
                        else setMode("webrtc");
                      }}
                    >
                      WebRTC
                    </button>
                  </div>
                </div>
                <div className="runtime-viewer">
                  {session && connection ? (
                    <RuntimeViewer
                      key={session.session_id}
                      connection={connection}
                      session={session}
                      onError={reportError}
                    />
                  ) : (
                    <div className="runtime-empty">
                      <img src="/hhtools-robot.svg" alt="HHTools" />
                      <span>No preview selected</span>
                    </div>
                  )}
                </div>
              </div>
              {tab === "assets" ? (
                <section className="runtime-records">
                  <div className="runtime-toolbar">
                    <h1>
                      Assets <small>{assets.length}</small>
                    </h1>
                    <input
                      aria-label="Search assets"
                      placeholder="Search assets"
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                    />
                    <select
                      aria-label="Upload kind"
                      value={uploadKind}
                      onChange={(event) => setUploadKind(event.target.value)}
                    >
                      <option value="motion_bundle">Motion</option>
                      <option value="robot_bundle">Robot</option>
                      <option value="dataset_bundle">Dataset</option>
                      <option value="video">Video</option>
                      <option value="robot_trajectory_bundle">
                        Robot trajectory
                      </option>
                    </select>
                    <button
                      disabled={!connection || Boolean(busy)}
                      onClick={() => fileInput.current?.click()}
                    >
                      Upload files
                    </button>
                    <button
                      disabled={!connection || Boolean(busy)}
                      onClick={() =>
                        connection &&
                        void run("Loading library", async () => {
                          const page = await connection.json<{
                            assets: CatalogAsset[];
                          }>("/api/agent/v1/assets/available?limit=500");
                          setCatalog(page.assets);
                        })
                      }
                    >
                      Library
                    </button>
                    <button
                      disabled={!connection || Boolean(busy)}
                      onClick={() => folderInput.current?.click()}
                    >
                      Upload folder
                    </button>
                    <input
                      ref={fileInput}
                      type="file"
                      multiple
                      hidden
                      onChange={(event) => {
                        void upload(event.target.files);
                        event.target.value = "";
                      }}
                    />
                    <input
                      ref={folderInput}
                      type="file"
                      multiple
                      hidden
                      {...{ webkitdirectory: "" }}
                      onChange={(event) => {
                        void upload(event.target.files);
                        event.target.value = "";
                      }}
                    />
                  </div>
                  <div className="runtime-table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th aria-label="Select" />
                          <th>Name</th>
                          <th>Kind</th>
                          <th>Files</th>
                          <th>Size</th>
                          <th />
                        </tr>
                      </thead>
                      <tbody>
                        {visibleAssets.map((asset) => (
                          <tr key={asset.asset_id}>
                            <td>
                              <input
                                type="checkbox"
                                aria-label={`Select ${asset.display_name}`}
                                checked={selected.includes(asset.asset_id)}
                                onChange={(event) =>
                                  setSelected(
                                    event.target.checked
                                      ? [...selected, asset.asset_id]
                                      : selected.filter(
                                          (id) => id !== asset.asset_id,
                                        ),
                                  )
                                }
                              />
                            </td>
                            <td title={asset.asset_id}>{asset.display_name}</td>
                            <td>{asset.kind.replaceAll("_", " ")}</td>
                            <td>{asset.files.length}</td>
                            <td>
                              {(
                                asset.files.reduce(
                                  (sum, file) => sum + file.size_bytes,
                                  0,
                                ) / 1048576
                              ).toFixed(2)}{" "}
                              MB
                            </td>
                            <td>
                              <button
                                disabled={
                                  Boolean(busy) || asset.kind === "video"
                                }
                                onClick={() =>
                                  void preview({ asset_id: asset.asset_id })
                                }
                              >
                                Open
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {!assets.length && (
                      <p className="runtime-empty-row">No registered assets</p>
                    )}
                  </div>
                  <div className="runtime-toolbar runtime-selection">
                    <span>{selected.length} selected</span>
                    <button
                      disabled={
                        !selected.length ||
                        Boolean(busy) ||
                        selectedAssets.some(
                          (asset) =>
                            asset.kind === "video" ||
                            asset.kind === "robot_bundle",
                        )
                      }
                      onClick={() => void startWorkflow("analysis")}
                    >
                      Analyze
                    </button>
                    <button
                      disabled={
                        !selected.length ||
                        Boolean(busy) ||
                        selectedAssets.some((asset) => asset.kind !== "video")
                      }
                      onClick={() => void startWorkflow("video_to_motion")}
                    >
                      Video to Motion
                    </button>
                    <button
                      disabled={!selectedRobot || !selectedMotion}
                      onClick={() => {
                        setTab("operations");
                        setOperation("hhtools_preflight_retarget");
                        setInput(
                          JSON.stringify(
                            {
                              request: {
                                motion_asset_id: selectedMotion?.asset_id,
                                robot_id: selectedRobot?.metadata?.robot_name,
                                robot_asset_id: selectedRobot?.asset_id,
                                parameters: { run_mode: "smoke" },
                              },
                            },
                            null,
                            2,
                          ),
                        );
                      }}
                    >
                      Retarget
                    </button>
                  </div>
                </section>
              ) : (
                <section className="runtime-records runtime-jobs">
                  <div className="runtime-toolbar">
                    <h1>
                      Tasks <small>{jobs.length}</small>
                    </h1>
                    <button
                      title="Refresh tasks"
                      aria-label="Refresh tasks"
                      onClick={() =>
                        connection &&
                        void refresh(connection).catch(reportError)
                      }
                    >
                      <img src="/icons/common/refresh-cw.svg" alt="" />
                    </button>
                  </div>
                  <div className="runtime-job-columns">
                    <div className="runtime-table-wrap">
                      <table>
                        <thead>
                          <tr>
                            <th>Task</th>
                            <th>State</th>
                            <th>Progress</th>
                            <th>Outcome</th>
                          </tr>
                        </thead>
                        <tbody>
                          {jobs.map((item) => (
                            <tr
                              key={item.job_id}
                              className={
                                job?.job_id === item.job_id ? "selected" : ""
                              }
                            >
                              <td>
                                <button
                                  className="runtime-link"
                                  onClick={() => setJob(item)}
                                  title={item.job_id}
                                >
                                  {item.summary.workflow ??
                                    item.summary.backend ??
                                    "retarget"}
                                  <small>{item.job_id.slice(-10)}</small>
                                </button>
                              </td>
                              <td>{item.state}</td>
                              <td>
                                <progress
                                  value={item.progress.fraction}
                                  max="1"
                                />
                                {Math.round(item.progress.fraction * 100)}%
                              </td>
                              <td>{item.outcome ?? ""}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {job && (
                      <div className="runtime-job-detail">
                        <div className="runtime-toolbar">
                          <strong>{job.job_id.slice(-12)}</strong>
                          <span>Attempt {job.attempt}</span>
                          <button onClick={copyJobLink}>Copy link</button>
                        </div>
                        <p>
                          {job.progress.phase} · {job.outcome ?? job.state}
                        </p>
                        {job.error && (
                          <p role="alert">
                            {job.error.code}: {job.error.message}
                          </p>
                        )}
                        <div className="runtime-toolbar">
                          <button
                            disabled={!job.cancellable || Boolean(busy)}
                            onClick={() => void jobAction("cancel")}
                          >
                            Cancel
                          </button>
                          <button
                            disabled={
                              ["queued", "running"].includes(job.state) ||
                              Boolean(busy)
                            }
                            onClick={() => void jobAction("retry")}
                          >
                            Retry
                          </button>
                        </div>
                        <ul className="runtime-artifacts">
                          {artifacts.map((artifact) => (
                            <li key={artifact.artifact_id}>
                              <span>
                                {artifact.kind}
                                <small>
                                  {(artifact.size_bytes / 1024).toFixed(1)} KB
                                </small>
                              </span>
                              {artifact.kind === "analysis_report" && (
                                <button onClick={() => setAnalysis(artifact)}>
                                  Inspect
                                </button>
                              )}
                              {["preview", "motion"].includes(
                                artifact.kind,
                              ) && (
                                <button
                                  disabled={Boolean(busy)}
                                  onClick={() =>
                                    void preview({
                                      job_id: job.job_id,
                                      artifact_id: artifact.artifact_id,
                                    })
                                  }
                                >
                                  View
                                </button>
                              )}
                              <button
                                title={`Download ${artifact.kind}`}
                                onClick={() =>
                                  connection &&
                                  void run("Downloading", () =>
                                    connection.download(artifact),
                                  )
                                }
                              >
                                Download
                              </button>
                            </li>
                          ))}
                        </ul>
                        {analysis?.job_id === job.job_id && connection && (
                          <RuntimeAnalysis
                            key={analysis.artifact_id}
                            connection={connection}
                            artifact={analysis}
                            onPreview={(value) => void preview(value)}
                            onJob={setJob}
                            onError={reportError}
                          />
                        )}
                      </div>
                    )}
                  </div>
                </section>
              )}
            </>
          )}
          {tab === "operations" && (
            <section className="runtime-operation-page">
              <div className="runtime-toolbar">
                <h1>Operations</h1>
                <select
                  aria-label="Operation"
                  value={operation}
                  onChange={(event) => {
                    setOperation(event.target.value);
                    setResult(null);
                  }}
                >
                  {operations.map((item) => (
                    <option key={item.name} value={item.name}>
                      {item.name.replace("hhtools_", "")}
                    </option>
                  ))}
                </select>
                <span>{operationSpec?.scope}</span>
                <button
                  disabled={!connection || !operationSpec || Boolean(busy)}
                  onClick={() =>
                    void run("Executing", async () => {
                      const value = await connection!.call(
                        operationSpec!,
                        JSON.parse(input) as Record<string, unknown>,
                      );
                      setResult(value);
                      await refresh(connection!);
                    })
                  }
                >
                  Execute
                </button>
              </div>
              <div className="runtime-operation-columns">
                <div>
                  <label htmlFor="runtime-request">Request</label>
                  <textarea
                    id="runtime-request"
                    spellCheck={false}
                    value={input}
                    onChange={(event) => setInput(event.target.value)}
                  />
                  <details>
                    <summary>Input schema</summary>
                    <pre>
                      {JSON.stringify(operationSpec?.input_schema, null, 2)}
                    </pre>
                  </details>
                </div>
                <div>
                  <label>Result</label>
                  <pre aria-live="polite">
                    {result === null ? "" : JSON.stringify(result, null, 2)}
                  </pre>
                  {resultPlan && (
                    <button
                      disabled={Boolean(busy)}
                      onClick={() => {
                        setOperation("hhtools_runtime_start_job");
                        setInput(
                          JSON.stringify(
                            {
                              request: {
                                plan_id: resultPlan,
                                idempotency_key: crypto.randomUUID(),
                              },
                            },
                            null,
                            2,
                          ),
                        );
                      }}
                    >
                      Use plan
                    </button>
                  )}
                </div>
              </div>
            </section>
          )}
          {tab === "settings" && (
            <section className="runtime-settings">
              <h1>Runtime Settings</h1>
              <dl>
                <dt>Runtime</dt>
                <dd>{identity?.runtime_id}</dd>
                <dt>Workspace</dt>
                <dd>{identity?.workspace_id}</dd>
              </dl>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  if (connection)
                    void run("Saving budget", async () => {
                      setBudget(
                        await connection.json(
                          "/api/runtime/v1/admin/budget",
                          "PUT",
                          budget,
                        ),
                      );
                    });
                }}
              >
                {Object.entries(budget).map(([name, value]) => (
                  <label key={name}>
                    {name.replaceAll("_", " ")}
                    <input
                      type="number"
                      min="0"
                      value={value}
                      onChange={(event) =>
                        setBudget({
                          ...budget,
                          [name]: Number(event.target.value),
                        })
                      }
                    />
                  </label>
                ))}
                <button type="submit" disabled={Boolean(busy)}>
                  Save
                </button>
              </form>
            </section>
          )}
        </main>
      </div>
      <dialog
        ref={catalogDialog}
        className="runtime-library"
        onCancel={() => setCatalog(null)}
      >
        <div className="runtime-toolbar">
          <h2>Available Assets</h2>
          <button onClick={() => setCatalog(null)} aria-label="Close library">
            <img src="/icons/common/close.svg" alt="" />
          </button>
        </div>
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Root</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {catalog?.map((item) => (
              <tr key={item.root_id + item.relative_path}>
                <td>{item.display_name}</td>
                <td>{item.root_id}</td>
                <td>
                  <button
                    disabled={Boolean(busy)}
                    onClick={() =>
                      connection &&
                      void run("Registering asset", async () => {
                        const asset = await connection.json<RuntimeAsset>(
                          "/api/agent/v1/assets",
                          "POST",
                          {
                            root_id: item.root_id,
                            relative_path: item.relative_path,
                            kind: item.kind,
                            category: item.category,
                            recursive: item.recursive,
                            display_name: item.display_name,
                          },
                        );
                        setSelected([asset.asset_id]);
                        await refresh(connection);
                      })
                    }
                  >
                    Register
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </dialog>
    </LocaleProvider>
  );
}
