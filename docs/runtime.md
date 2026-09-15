# Resident HHTools Runtime

The Runtime owns one workspace, one scheduler, and one durable job history.
HTTP, the Python SDK, CLI, MCP, and the existing HHTools GUI share resource identities.
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
`hhtools web` and Electron connect to a resident service by default. `hhtools web --legacy`
and `HHTOOLS_LEGACY_SIDECAR=1` retain the previous session-owned backend. There is one
business GUI: the original Motion, Robot, H2R, R2R, Batch, Analysis and Video pages.
Its compatibility HTTP adapters submit persistent workflow plans to the same
JobManager used by Agent clients. Model loading and view preparation remain
replaceable session caches. Electron can use `HHTOOLS_RUNTIME_ENDPOINT` and
`HHTOOLS_RUNTIME_TOKEN` to connect without a local Python runtime.

## Whole Application Streaming

The Runtime's `/` serves the single HHTools GUI. `/stream` serves a thin WebRTC
client with connection, input and file-transfer controls. It contains no motion,
robot, calibration, retargeting or analysis business pages.

```bash
uv sync --locked --extra streaming --extra mcp
uv run playwright install chromium
uv run hhtools runtime start --workspace assets/save_npz --source assets/motions
```

Open `/stream` on a Runtime origin, enter the target Runtime origin and an operator
token, and connect. Remote signaling requires HTTPS and `admin` scope because the
GUI grants full workspace control. A server Chromium process opens the same `/`
page over a configured loopback origin. The daemon sets that origin from its bound
socket; embedding applications must set `app.state.gui_sessions.origin` themselves.
The browser uses a temporary HttpOnly session cookie. Its credential record stays
in server memory and is revoked when the session closes. A Runtime restart
invalidates it, and closing the session removes its browser profile.

Chromium screencast frames are encoded by aiortc. This release uses software video
encoding, not NVIDIA NVENC or Isaac Sim's proprietary client protocol. An existing
Chromium executable can be selected with `HHTOOLS_CHROMIUM_EXECUTABLE`; otherwise
Playwright uses its installed browser. [Playwright's CDP session API](https://playwright.dev/python/docs/api/class-cdpsession)
provides the browser capture and input integration.

One remote operator owns the GUI session at a time. Reconnecting as the same
principal reuses the browser and its current layout. Keyboard, pointer, wheel,
paste and text entry travel over the data channel; the text control supports IME
input. File pickers, folder pickers, file drops and downloads use authenticated,
bounded HTTP transfers. Uploads preserve relative paths, use 8 MiB chunks and
have a 4 GiB session budget. A single media connection can be replaced without
restarting the browser or cancelling work. The default lease is 300 seconds;
the connected client renews it every 30 seconds. Closing or expiring the GUI
process does not cancel durable jobs.

Both human and Agent jobs appear in the existing task drawer. The drawer can
cancel, retry, download or open supported completed results in their original
workflow views. H2R and R2R publish a lossless `retarget_state` artifact, so CSV/PKL
exports can change frame rate or time range after a service restart without
re-running IK. `POST /api/runtime/v1/workflows/retarget-export/preflight` exposes
the same export operation to Agent clients. Whole-application streaming is
independent of the resource-preview APIs described below.

### Access Tokens And SSH

For a local-mode Runtime on loopback, the stream client's Access token can be
left empty. When a token is supplied, its scope is enforced: a complete GUI
session requires an `admin` token issued by that Runtime. Direct remote-mode
connections require both HTTPS and a valid token.

A Runtime bound to loopback can also be reached through authenticated SSH.
Keep it in local mode and forward its HTTP port. To carry WebRTC media over the
same connection, run an authenticated TURN server on the Runtime host, listening
on loopback with a relay address reachable by the Runtime. Forward its TCP
listener as well. For example, with HTTP on 58800 and TURN on 58820:

```bash
ssh -N \
  -L 127.0.0.1:58800:127.0.0.1:58800 \
  -L 127.0.0.1:58820:127.0.0.1:58820 user@build-host
```

Set `HHTOOLS_ICE_SERVERS` on that Runtime to a private JSON configuration using
`turn:127.0.0.1:58820?transport=tcp` and the TURN username/credential. Both ends
then use the same URL: the browser reaches the forwarded listener and the Runtime
reaches its local listener. Open `http://127.0.0.1:58800/stream` and leave Access
token empty for this SSH-protected local-mode setup. Forwarding HTTP alone does
not forward WebRTC media. This connection uses TURN over SSH/TCP, so measure its
behavior separately from a direct UDP deployment.

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

## Resource Workflows

H2R, R2R, Batch, and calibration retain their v1 contracts and v2 specifications.
Analysis, Video2Motion, analysis exports, and rendered media use v3 specifications
and v2 manifests in the same stores and JobManager.

```python
plan = client.call("hhtools_workflow_preflight", {"request": {
    "workflow": "analysis", "asset_ids": [asset_id],
}})
job = client.call("hhtools_runtime_start_job", {"request": {
    "plan_id": plan["plan_id"], "idempotency_key": "analysis-001",
}})
```

Use the same preflight with `workflow="video_to_motion"` and video asset IDs.
GVHMR remains an optional external environment with licensed body-model files.
Availability reports configuration checks; execution validates the inference
environment. Administrators configure locations with `hhtools_runtime_configure_backends`.
New workflow plans bind configuration and GVHMR checkpoint digests.

Analysis produces an `analysis_report`, evaluation, and manifest. Use
`hhtools_runtime_select_analysis` for filtering/subsets,
`hhtools_runtime_compare_analysis` for comparison, and
`hhtools_analysis_export_preflight` for durable JSON/CSV manifests or robot ZIPs.
`hhtools_runtime_import_member` registers a selected dataset member;
`hhtools_runtime_import_artifact` continues from a prior job output.

`client.upload(path, kind="motion_bundle", on_session=save_upload_id)` uploads
a file or folder. Pass its saved `upload_id` to resume. The corresponding CLI
commands are `hhtools runtime upload PATH --kind KIND` and
`hhtools runtime download JOB_ID ARTIFACT_ID --output PATH`.

Downloads preserve existing files by default. Use SDK `overwrite=True`, CLI
`--overwrite`, or MCP `overwrite: true` only when replacement is intended.
The SDK checks artifact identity before resuming a partial file and publishes
without replacing a file created concurrently by another process.

MCP provides `upload_local_file` for files or directory bundles and
`download_artifact` for verified delivery to its own host. These operations stream
bytes through the Runtime API without putting binary content in tool text.
Use repeatable `hhtools-mcp --transfer-root PATH` options to select allowed local
directories; the default is the MCP process's current directory. Links and paths
outside these roots are rejected. A remote Runtime never receives these local paths.
The existing `export_artifact` tool creates a copy on the Runtime host.

The default MCP listing suppresses duplicate compatibility names; existing names
remain callable and `--all-tools` lists them all. Generated tools carry the HTTP
output schema (array results use a `result` wrapper) and scope metadata. Query
`hhtools_runtime_workflows` for per-workflow readiness, defaults and parameter
schemas before preflight. `hhtools_runtime_operations` retains the full HTTP
catalog. Parameter failures contain bounded field paths and constraint types;
network failures retain structured errors, including an upload ID when available.

Workers open metadata stores read-only. The controller verifies worker generation,
job ownership, staging boundaries, length, and digest before publishing outputs.
Cancellation and timeout wait for worker termination before publishing a terminal
state. Restart recovery provides a new whole-plan retry, not checkpoint continuation.

## Preview Modes

Install `uv sync --locked --extra mcp --extra preview` for server rendering.

```python
session = client.call("hhtools_runtime_create_preview", {"request": {
    "source": {"asset_id": asset_id}, "mode": "webrtc",
    "width": 960, "height": 540, "fps": 24, "ttl_seconds": 120,
}})
```

The same source can use `mode="data"` for client R3F playback. Job previews use
`job_id` plus `artifact_id`; raw robot trajectories may supply their exact
`robot_asset_id`. Data declares Z-up metres, radians, XYZW quaternions, row-major
transforms, frame indices, and original duration. Sampling is capped at 600 frames.
Robot/prop meshes and triangulated terrain stay in the scene; props without a
mesh are explicitly marked as bounding geometry.

The server renderer uses MuJoCo 3.7+ and aiortc for kinematic playback, not physics
evaluation. A session has one media connection, a renewable lease, and its own
process. Orbit, zoom, seek, play, and pause use the WebRTC data channel.
Session/resource management uses the separate HTTP control API.

`hhtools_preview_render_preflight` creates durable PNG or short MP4 jobs.
Artifacts carry source identity and sampling settings. MCP offers
`preview_snapshot` for a session frame and `inspect_artifact_image` for a
published PNG/JPEG. Binary trajectories and continuous video stay out of tool text.

Direct ICE connectivity is the default. Configure `HHTOOLS_ICE_SERVERS` as an
aiortc ICE-server JSON list when STUN/TURN is needed. DTLS/SRTP media is separate
from HTTPS signaling; allow the relevant UDP paths or provide a TURN relay.

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
The resident host exposes the versioned machine APIs. Agent v1 operations retain their
schemas and receive the same scoped authentication. Private CAs can be supplied through
`RuntimeClient(..., ca_file=...)` or `HHTOOLS_RUNTIME_CA`. Direct daemon deployment
supports explicit `--allow-origin` values; cross-origin clients still need authentication.
A TLS-terminating proxy must also use TLS to the Runtime.

Uploaded code-capable or host-bound serialization requires per-content administrator
authorization through `hhtools_runtime_trust_asset`. Host roots are operator-configured.
Process supervision is a failure-isolation boundary, not an OS security sandbox.

`hhtools_runtime_plan_cleanup` returns a reviewable staging cleanup plan. Applying its
ID rejects changed uploads and removes incomplete upload sessions. Registered assets,
plans, jobs, and artifacts are retained; automatic persistent-data garbage collection
is disabled in this release.

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
| HHTools GUI | One existing React/R3F application | Direct local access or whole-application WebRTC streaming |
| R3F playback | Existing frame loop in the GUI browser | Runs on the user's machine locally or in server Chromium remotely |
| Server preview | Existing PNG calibration renderer | Preview leases, render backend and media connection |
| Settings | Existing admission settings and library configuration | Discoverable authorized configuration |

Persistent state consists of input manifests, plans, jobs, events, candidate and
validation records, published artifacts and Runtime identity. Loaded models,
decoded motion and preview sessions are replaceable caches. Playback position,
camera and panel layout belong to GUI sessions. Do not make browser tokens identities
for new durable workflows.

The first Runtime start backs up existing Agent SQLite databases under
`before-runtime-v1` while holding the workspace lease. Existing IDs and records are
retained; new workflow records use explicit specification and manifest versions.
`hhtools_runtime_legacy_jobs` exposes old Web history with a non-replayable marker.
A rollback should stop the Runtime and restore its pre-migration backup; do not
open v3 records with an older writer.

Validation covers concurrent discovery, identity mismatch, scoped authentication,
real HTTPS transfers, upload recovery, immutable plans, events, process failures,
timeout/cancellation, H2R/Batch execution, real offscreen pixels, and WebRTC frames.
GPU rendering tests run with an NVIDIA device, or with `HHTOOLS_TEST_RENDER=1`
for another configured offscreen renderer.

Local validation used an RTX 5060 with 8 GiB VRAM and 960x540 loopback streaming at
24 fps. Browser frame cadence is not isolated GPU render time or end-to-end input
latency. WAN impairment, multi-host scheduling, training, and checkpoint resume
are not claimed by this release.

## Rendering Reference

NVIDIA's [Isaac Sim livestream documentation](https://docs.isaacsim.omniverse.nvidia.com/latest/installation/manual_livestream_clients.html)
and [Web Viewer sample](https://github.com/NVIDIA-Omniverse/web-viewer-sample/blob/ffabf4231295af4e160165cd731d0f7f5cf13966/src/AppStream.tsx)
separate an engine/rendering process from a video client. HHTools follows that
lifecycle boundary: a media disconnect can close a dedicated preview, never
the persistent Runtime or an unrelated computation. A WebRTC connection requires
a real renderer/encoder, not just a browser video component. Client R3F playback
remains a distinct mode, including when computation is remote.
