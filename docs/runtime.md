# Resident HHTools Runtime

The Runtime owns one workspace, one scheduler, and one durable job history.
HTTP, the Python SDK, CLI, MCP, and browser clients share resource identities.
Closing a client does not stop the service. No LLM credentials are required.

## Local Service

```bash
uv sync --locked --extra runtime --extra mcp
uv run hhtools runtime start --workspace assets/save_npz --source assets/motions
uv run hhtools runtime status --workspace assets/save_npz
uv run hhtools-mcp --save-dir assets/save_npz --source assets/motions
```

`start` returns the selected HTTP origin and persistent Runtime/workspace IDs.
Open that origin in a browser. Repeating `start`, including concurrently from
different clients, reuses the service selected by the workspace lease. An
occupied network port is never taken from another process. Local discovery and
logs live under `<workspace>/.hhtools-agent/`; they do not contain access tokens.

The default MCP entry point is an HTTP client. `--endpoint https://...` selects
a remote Runtime; `--token-env HHTOOLS_RUNTIME_TOKEN` reads its credential from
the adapter environment. `--ephemeral` explicitly selects the old exclusive
stdio mode, whose lifetime owns its jobs. Use a separate workspace for that mode.

Stop a persistent service explicitly with `hhtools runtime stop --workspace ...`.
The default policy drains work; `--cancel` requests cancellation before shutdown.

## SDK And Discovery

```python
from hhtools.client import RuntimeClient

client = RuntimeClient("http://127.0.0.1:8009")
identity = client.connect()
operations = client.operations()
jobs = client.call("hhtools_runtime_list_jobs", {"limit": 20})
events = client.call("hhtools_runtime_events", {"after": 0})
```

Each operation publishes its exact input/output schema, scope, method, and
execution category. JSON request bodies appear under the `request` argument;
path/query arguments are peers. The CLI consumes the same shape:

```bash
uv run hhtools runtime call hhtools_runtime_list_jobs --endpoint http://127.0.0.1:8009
uv run hhtools runtime call hhtools_runtime_start_job --request submission.json
```

Keep `runtime_id`, `workspace_id`, resource IDs, and acknowledged event cursors
when handing work to another client. The SDK binds every request to the observed
instance identity. Job revisions are local to a job; workspace events have their
own transactional SQLite cursor. Wait expiration never cancels computation.

Use `client.download(job_id, artifact_id, destination)` for large artifacts. It
resumes an incomplete byte transfer, verifies size and SHA-256, and only then
publishes the destination. The versioned Runtime data channel is separate from
the existing v1 compact-JSON artifact boundary.

## Remote Service

Start locally first, issue a scoped token with `hhtools_runtime_issue_token`,
and keep its one-time receipt in the client's credential store. The Runtime
persists only its digest. Token creation/revocation and budget changes require
`admin`; ordinary data/job operations use `write`, queries use `read`, and saved
calibration changes use `calibrate`. An admin token includes all operations.
The first version is a shared trusted workspace, not private per-user storage.
Authorized readers can inspect the workspace's jobs and artifacts.

```bash
uv run hhtools runtime serve --workspace /srv/hhtools/workspace \
  --source /srv/hhtools/inputs --remote --host 0.0.0.0 --port 8009 \
  --ssl-certfile /etc/hhtools/server.crt --ssl-keyfile /etc/hhtools/server.key
```

Remote mode requires TLS and a valid bearer credential. Forwarded headers are
not trusted. Credentials do not belong in URLs, plans, logs, or manifests.
Legacy Web routes accepting host paths remain restricted to local administrators;
remote operations use the versioned machine resource APIs. Agent v1 operations
retain their schemas and receive the same scoped authentication in this host.

## Migration And Implementation Record

Architecture baseline: `b0bdfbd1adf3f92ddacd714365f4c92ac3a2bef7`.
The supplied Runtime RFC v0.2 guides this branch. Its M5 training backend and
multi-host execution remain separate extensions.

| Existing workflow | Shared ownership | Migration work |
| --- | --- | --- |
| H2R, R2R, Batch | Existing PlanStore, JobStore, JobManager, ArtifactStore | Resident host and client access |
| Calibration | Existing candidate, validation and save services | Shared scoped API and MCP |
| Analysis | Existing `analysis.dataset_analysis` algorithms | Durable resource inputs, jobs and reports |
| Video2Motion | Existing isolated GVHMR integration | Durable video import, jobs and exported motion |
| Motion/robot management | Existing asset registry and root-relative bundles | Verified resumable upload and managed resources |
| R3F playback | Existing client frame loop | Resource-based handoff; keep per-frame work local |
| Server preview | Existing PNG calibration renderer | Preview leases, render backend and media connection |
| Settings | Existing admission settings and library configuration | Discoverable authorized configuration |

Persistent state consists of input manifests, plans, jobs, events, candidate and
validation records, published artifacts and Runtime identity. Loaded models,
decoded motion and preview sessions are replaceable caches. Playback position,
camera and panel layout belong to clients. Do not make browser tokens identities
for new durable workflows.

The initial implementation commit covers service discovery/lifecycle, shared job
history/events, scoped credentials, an operation catalog, SDK, resumable artifact
delivery, and the default MCP client. Subsequent commits on this branch supply
the workflow and preview migrations; this paragraph is not a claim that those
stages are already complete.

## Rendering Reference

NVIDIA's [Isaac Sim livestream documentation](https://docs.isaacsim.omniverse.nvidia.com/latest/installation/manual_livestream_clients.html)
and [Web Viewer sample](https://github.com/NVIDIA-Omniverse/web-viewer-sample/blob/ffabf4231295af4e160165cd731d0f7f5cf13966/src/AppStream.tsx)
separate an engine/rendering process from a video client. HHTools follows that
lifecycle boundary: a media disconnect can close a dedicated preview, never
the persistent Runtime or an unrelated computation. A WebRTC connection requires
a real renderer/encoder, not just a browser video component. Client R3F playback
remains a distinct mode, including when computation is remote.
