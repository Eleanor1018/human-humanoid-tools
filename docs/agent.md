# Agent interfaces

HHTools exposes the same versioned H2R, scene-free R2R, and bounded Batch Agent contracts
through two local adapters. Use the JSON CLI from scripts and use MCP when a compatible coding
agent should discover and call tools directly.

| Adapter | Runtime | Entry point |
|---|---|---|
| JSON CLI | Client of a running WebUI Agent API | `uv run hhtools agent ...` |
| MCP | Own local stdio process; no WebUI required | `uv run --extra mcp hhtools-mcp` |

The current Agent surface supports human-to-robot (H2R) retargeting—plain motion through Newton
and safely inspectable object-interaction or terrain-scene bundles through Interaction-Mesh—and
scene-free robot-to-robot (R2R) trajectories through Newton, plus ordered H2R/R2R batches of at
most 32 ready child plans and 100,000 estimated frames. It includes capability and robot
discovery, allowlisted asset registration and inspection, workflow-specific preflight, jobs,
revision-aware waiting, verified artifacts, and export. Scene-bearing R2R, Video2Motion, Analysis,
remote service access, and robot deployment are not part of this interface. Code-capable
source formats still require safe content inspection; the Agent never bypasses an
isolated-validation requirement.

## Install

Use any compatible Python 3.12 or newer and install the adapter you need:

```bash
# JSON CLI plus the resident WebUI service
uv sync --locked --extra web --extra retarget

# Self-contained local MCP H2R/R2R server
uv sync --locked --extra mcp
```

After installation, `uv run hhtools doctor --require mcp` provides a
side-effect-free readiness check. Add `--json` for a single machine-readable
document; optional body-model and GVHMR checks do not fail the default command.

The JSON CLI always emits one strict JSON document. Start the WebUI service,
then query it from another terminal:

```bash
uv run hhtools web
uv run hhtools agent capabilities
uv run hhtools agent --help
uv run hhtools agent preflight batch --request batch-request.json
uv run hhtools agent job wait JOB_ID --after-revision REVISION --wait-timeout 20
```

Use `hhtools agent asset catalog` to discover registerable Motion Library and
Robot Library entries before the registry contains any assets. MCP clients use
the equivalent read-only `list_available_assets` tool. Both return only an
allowlisted `root_id` and portable `relative_path`, never a host path.

`hhtools-mcp` is a stdio server, so start it through an MCP client rather than
an interactive terminal. Its available options can be inspected with
`uv run --extra mcp hhtools-mcp --help`.

## Safe H2R, R2R, and Batch workflows

For a new run, discover capabilities and inspect every input. H2R binds one motion and one robot;
R2R binds one scene-free robot trajectory, its declared source robot, the target robot, and their
pair calibration. Call the matching preflight with `run_mode: smoke`, then submit only an immutable
plan returned with `status: ready` through `start_job`; retain its `plan_id` and caller-owned key.
Wait by revision and review the evaluation and manifest before considering a
full run. Calibration and final motion quality remain human decisions.

Batch composition happens only after every single item already has a ready H2R or R2R plan.
Call `preflight_batch` with one workflow and the ordered child `plan_id` list. The service rejects
mixed run modes, mixed robot identities, duplicate inputs, more than 32 items, or more than
100,000 estimated frames. Execution is serial so cancellation can stop the current child and
guarantee later children never start. Job status carries only `completed_items / total_items`;
the verified `hhtools://jobs/{job_id}/batch` resource contains bounded per-item results, and the
`batch_archive` artifact provides one portable ZIP. A retry always creates a new whole-batch
attempt rather than silently selecting failed items.

Only one local runtime may own a `save-dir`. MCP normally owns its directory
for its entire stdio connection. If preflight requests calibration, disconnect
MCP, run the WebUI against that exact directory, finish calibration, close that
WebUI, reconnect MCP, and preflight again. Never run MCP and WebUI concurrently
against the same directory.

## Codex

This repository includes a project-scoped [Codex configuration](../.codex/config.toml).
It starts the `hhtools` stdio server with `uv` and keeps its save/cache state in
the ignored `.hhtools/agent/` directory, separate from the default WebUI. Its
job-admission settings live in that directory too. Open a new Codex session from
a trusted checkout after installing the `mcp` extra, then use `/mcp` or
`codex mcp list` to confirm that `hhtools` connected.

The checked-in launcher uses `uv run --frozen --no-sync`, so opening Codex never
changes the repository environment. Run the explicit `uv sync --extra mcp`
installation command again after dependency updates.

When calibration is required, disconnect the MCP server and run:

```bash
HHTOOLS_WEB_SETTINGS_PATH=.hhtools/agent/job-settings.json \
uv run --frozen --no-sync hhtools web \
  --save-dir .hhtools/agent/save \
  --cache .hhtools/agent/cache \
  --port 8010
```

Close that WebUI before reconnecting MCP. Project-level MCP configuration and
the supported stdio fields are documented in the
[official Codex MCP guide](https://developers.openai.com/codex/mcp).
