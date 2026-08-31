---
name: hhtools-agent
description: "Run local HHTools human-to-humanoid (H2R) retargeting through the versioned MCP Agent interface: discover capabilities, register or inspect allowlisted motion and robot assets, preflight immutable smoke/full plans, pause for calibration, manage jobs, and review verified artifacts. Use for HHTools H2R execution, status, cancellation, retry, or result requests. Do not use for UI or solver-code edits, R2R, Batch, Interaction-Mesh, arbitrary filesystem access, remote service setup, or real-robot deployment."
---

# HHTools Agent

Operate HHTools through its MCP tools and resources while preserving the service's asset,
plan, job, and artifact identities. Treat solver completion and motion quality as separate
claims.

## Choose the workflow

- For a new H2R run, follow the smoke-first workflow below.
- For an asset-only request, discover or register the asset, inspect it, and report the
  structured inspection without starting a job.
- For an existing job, start with `get_job`; do not recreate its inputs or submit another job.
- For a status or result request, poll only that job and read only its job-scoped artifacts.
- For cancellation or retry, require an explicit user request and follow the lifecycle rules in
  [errors and stops](references/errors-and-stops.md).

If the HHTools MCP tools are unavailable, stop and explain that the local MCP integration must
be configured. Never substitute shell commands, the JSON CLI, REST calls, or direct filesystem
reads. The stdio server owns its service runtime and does not require `hhtools web` to be
running. Only one local runtime may own a given `save_dir`. The separate WebUI is used only
when a returned human `next_action` requests calibration; never request or read its session
token.

## Run a new H2R job

1. Call `get_capabilities`. Confirm the MCP feature, supported formats/backend, scheduler state,
   allowlisted `asset_root_ids`, and robot readiness. Do not infer a GPU or backend that the
   response does not report.
2. Resolve both content-addressed inputs.
   - Prefer `search_assets` for an already registered motion or robot bundle.
   - Register only with `register_asset_bundle` using a returned `root_id` and a portable
     `relative_path`. Never pass or derive an absolute host path.
   - Call `inspect_asset_bundle` with hash verification and parsing enabled for every selected
     motion and robot bundle. Stop on `invalid`; surface warnings before continuing.
   - Continue only when the motion inspection category is `plain_motion` and neither the
     selected nor recommended backend is `interaction_mesh`. Stop on `object_interaction`,
     `terrain_scene`, or Interaction-Mesh routing; this skill has no validated workflow for them.
   - Select a supported `robot_id` from `list_robots` or the capability snapshot and pair it with
     the inspected robot bundle's `asset_id`. Do not guess either identity.
3. Call `preflight_retarget` with a versioned `RetargetPreflightRequest`. Put
   `run_mode: smoke` in `request.parameters`, use the currently supported
   `output_policy: create_new`, and include the registered motion and robot asset IDs. Other
   output policies are rejected in this phase.
4. Branch on the preflight `status`.
   - `ready`: retain the returned immutable smoke `plan_id` and continue.
   - `human_action_required`: pause and present every entry in `required_actions`. Stop or
     disconnect the
     current stdio MCP runtime, ask the human to start the WebUI with the same `save_dir`, and
     present the loopback calibration URL when supplied. After calibration, the human must close
     the WebUI before MCP reconnects; then call capabilities again and perform a new preflight.
   - `rejected`: stop and explain the structured error and checks.
5. Generate one caller-owned idempotency key for this logical submission. Call
   `start_retarget(request={schema_version: "1.0", plan_id, idempotency_key})`; the nested request
   contains only the ready plan identity and key. Record the exact pair for safe replay if the
   transport result is ambiguous.
6. Poll with `get_job(job_id, after_revision=<last revision>)`. Respect `poll_after_ms`; do not
   busy-poll. Treat `queued` and `running` as nonterminal, and report queue/progress changes
   without requesting large trajectories.
7. At terminal state, use `list_job_artifacts(job_id, ...)` for canonical membership, then read
   `hhtools://jobs/{job_id}/artifacts/{artifact_id}` when one descriptor needs verification. Read
   `hhtools://jobs/{job_id}/evaluation`, `/manifest`, and `/failures` only when relevant.
   Resources expose verified structured reports or descriptors, not binary motion bytes.
8. Inspect both `state` and `outcome`. `completed` alone is not quality approval. For a completed
   job, present the evaluation and manifest and pause on `review_required`, `partial`, or
   `rejected`. For `failed` or `cancelled`, follow the error rules and read failure/manifest
   resources only when present.
9. Start a full run only after explicit user approval of the smoke evidence. Perform a new
   preflight with `request.parameters.run_mode: full`, receive a different immutable full plan,
   and submit it with a new idempotency key. Never promote or mutate the smoke plan.

## Non-negotiable invariants

| ID | Rule |
|---|---|
| `MCP_ONLY` | Use HHTools MCP tools/resources only; never fall back to shell, JSON CLI, REST, or direct service imports. |
| `ALLOWLISTED_ASSETS` | Asset registration accepts only a capability-advertised `root_id` plus normalized `relative_path`, never an arbitrary or absolute path. |
| `PLAIN_H2R_ONLY` | Start new jobs only for inspected `plain_motion` assets on a non-`interaction_mesh` route; stop on object interaction, terrain scenes, or Interaction-Mesh. |
| `PREFLIGHT_OWNS_MODE` | `run_mode` belongs in preflight `request.parameters`; `start_retarget` accepts only `plan_id` and `idempotency_key`. |
| `OUTPUT_CREATE_NEW` | Use `output_policy: create_new`; other output policies are unsupported in the current H2R Agent service. |
| `IDEMPOTENT_START` | Replay an ambiguous start with the exact same plan and idempotency key; never create a second key for the same logical submission. |
| `IDEMPOTENT_RETRY` | Replay an ambiguous retry with the exact same parent job and retry idempotency key; never create a second child attempt. |
| `NEW_FULL_PLAN` | A full run requires explicit approval, a new full preflight, a new plan, and a new idempotency key. |
| `JOB_SCOPED_ARTIFACTS` | List or resolve an artifact with both `job_id` and `artifact_id`; never trust or expose an unbound artifact identity. |
| `NO_BINARY_CONTEXT` | Keep binary motion, meshes, video, trajectories, and Base64 payloads out of tool arguments and model context; MCP returns summaries, reports, and descriptors only. |
| `HUMAN_GATES` | Pause for calibration and quality review; never guess calibration or equate `completed` with accepted motion quality. |
| `COOPERATIVE_CANCEL` | Running cancellation is a request checked at safe points; do not claim cancellation until the returned job state is terminal. |
| `HONEST_PROVENANCE` | Report only device and execution provenance present in capabilities or the manifest; never infer actual GPU use. |
| `SINGLE_RUNTIME_OWNER` | One local runtime may own a `save_dir`: disconnect stdio MCP before same-directory WebUI calibration, close WebUI before reconnecting MCP, then preflight again. |
| `LOCAL_BOUNDARY` | This skill covers local stdio only, with a loopback calibration UI. It provides no remote auth, multi-user isolation, worker resume, or real-robot deployment. |

## Load references progressively

- Read [contracts](references/contracts.md) before constructing an unfamiliar tool request,
  selecting a schema resource, or interpreting an artifact.
- Read [errors and stops](references/errors-and-stops.md) for every non-ready preflight,
  failed/partial/review-required job, cancellation, retry, hash failure, or ambiguous tool call.

## Report the result

Return a compact audit trail: selected asset IDs and robot ID, run mode and plan ID, job ID and
lineage, final state/outcome, evaluation verdict, canonical artifact IDs with hashes when
available, and any remaining human action. Explicitly label unverified quality, unavailable
actual-device provenance, and unsupported remote or real-robot steps.
