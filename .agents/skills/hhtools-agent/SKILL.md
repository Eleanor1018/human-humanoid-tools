---
name: hhtools-agent
description: "Run local HHTools H2R, scene-free R2R, and scalable H2R/R2R batches through the versioned MCP Agent interface: route H2R through Newton or Interaction-Mesh, inspect allowlisted assets, preflight immutable smoke/full plans, pause for calibration, manage jobs, and review verified artifacts. Use for HHTools H2R/R2R/Batch execution, status, cancellation, retry, or result requests. Do not use for UI or solver-code edits, scene-bearing R2R, arbitrary filesystem access, remote service setup, or real-robot deployment."
---

# HHTools Agent

Operate HHTools through its MCP tools and resources while preserving the service's asset,
plan, job, and artifact identities. Treat solver completion and motion quality as separate
claims.

## Choose the workflow

- For a new H2R run, follow the smoke-first workflow below.
- For a new scene-free R2R run, follow the R2R-specific identity checks below, then use the
  same job and artifact lifecycle.
- For a new H2R or scene-free R2R batch, preflight every item first, then follow the scalable
  batch workflow below.
- For an asset-only request, discover or register the asset, inspect it, and report the
  structured inspection without starting a job.
- For an existing job with a known `job_id`, start with `get_job`; do not recreate its inputs or
  submit another job. If an earlier start response was lost, recover only that caller-owned
  submission with `lookup_job` using its exact recorded `plan_id` and idempotency key.
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
   - If no matching bundle is registered, call `list_available_assets` with bounded filters.
     Select only a returned candidate, then call `register_asset_bundle` with one `request`
     containing `schema_version: "1.0"` plus its `root_id`, `relative_path`, `display_name`,
     `kind`, `category`, and `recursive` fields. Never browse a root, pass, or derive an absolute
     host path.
   - Register only with `register_asset_bundle` using the catalog's portable identity.
   - Call `inspect_asset_bundle` with hash verification and parsing enabled for every selected
     motion and robot bundle. Stop on `invalid`; surface warnings before continuing.
   - Continue only when category and backend agree: `plain_motion` uses `newton`, while
     `object_interaction` and `terrain_scene` use `interaction_mesh`. Never override the
     inspected routing identity. Stop when content inspection requires isolated validation;
     do not decode a rejected code-capable source format yourself.
   - Select a supported `robot_id` from `list_robots` or the capability snapshot and pair it with
     the inspected robot bundle's `asset_id`. Do not guess either identity.
3. Call `preflight_retarget` with a versioned `RetargetPreflightRequest`. Put
   `run_mode: smoke` in `request.parameters`, use the currently supported
   `output_policy: create_new`, and include the registered motion and robot asset IDs. Other
   output policies are rejected in this phase.
4. Branch on the preflight `status`.
   - `ready`: retain the returned immutable smoke `plan_id` and continue.
   - `human_action_required`: pause and present every entry in `required_actions`. Stop or
     disconnect the current stdio MCP runtime, ask the human to start the WebUI with the same
     `save_dir`, and present the loopback calibration URL when supplied. After calibration, the
     human must close the WebUI before MCP reconnects; then call capabilities again and perform
     a new preflight.
   - `rejected`: inspect the structured error and checks. Execute an `actor: agent` action only
     when it matches the allowlisted action mapping below; otherwise stop and explain it.
5. Generate one caller-owned idempotency key for this logical submission. Call
   `start_job(request={schema_version: "1.0", plan_id, idempotency_key})`; the nested request
   contains only the ready plan identity and key. `start_retarget` remains a compatibility alias.
   Persist the exact pair before submission. If the transport result is ambiguous, call
   `lookup_job` with that pair before replaying the exact same start request; never enumerate jobs
   or create a replacement key.
6. Wait with `wait_job(job_id, after_revision=<last revision>, timeout=30)`. Treat `queued` and
   `running` as nonterminal, retain the returned revision, and wait again without busy-polling.
   Use `get_job` only for an immediate snapshot when no wait is appropriate. Report
   queue/progress changes without requesting large trajectories.
7. At terminal state, use `list_job_artifacts(job_id, ...)` for canonical membership, then read
   `hhtools://jobs/{job_id}/artifacts/{artifact_id}` when one descriptor needs verification. Read
   `hhtools://jobs/{job_id}/evaluation`, `/manifest`, and `/failures` only when relevant.
   Resources expose verified structured reports or descriptors, not binary motion bytes. When the
   user asks for an artifact file, call `export_artifact(job_id, artifact_id)`: it verifies and
   materializes the file below the fixed `agent-exports` root and returns a portable receipt. Give
   the receipt to the user; do not inspect private storage or request bytes in model context.
8. Inspect both `state` and `outcome`. `completed` alone is not quality approval. For a completed
   job, present the evaluation and manifest and pause on `review_required`, `partial`, or
   `rejected`. For `failed` or `cancelled`, follow the error rules and read failure/manifest
   resources only when present.
9. Start a full run only after explicit user approval of the smoke evidence. Perform a new
   preflight with `request.parameters.run_mode: full`, receive a different immutable full plan,
   and submit it with a new idempotency key. Never promote or mutate the smoke plan.

## Run a new scene-free R2R job

1. Confirm `r2r_preflight` and `r2r_execution` in capabilities and select the advertised backend.
2. Resolve and inspect exactly three bundles: one `robot_trajectory_bundle`, its source robot, and
   the target robot. Require `category: robot_trajectory`, successful semantic parsing, a
   scene-free `mimic` trajectory profile, and an exact match between the trajectory's declared
   source robot and the selected source robot. Object or terrain sidecars are a stop condition.
3. Call `preflight_r2r` with the trajectory asset ID, source robot ID and asset ID, target robot ID
   and asset ID, `output_policy: create_new`, and `parameters.run_mode: smoke`. Retain the returned
   immutable R2R plan, which binds all three assets and the pair-calibration digest.
4. Handle `human_action_required` by performing the same exclusive-runtime WebUI handoff for the
   exact source/target calibration pair. On `rejected`, do not switch robots, strip scene files, or
   override the trajectory's source identity.
5. Submit a ready plan with `start_job`; then follow H2R steps 6–9 for revision-aware waiting,
   artifact verification, human quality review, and a separately approved full plan.

## Run an H2R or R2R batch

1. Create a ready smoke child plan for every requested item with `preflight_retarget` or
   `preflight_r2r`. Keep the user's order. Every child must use a unique input, the same workflow,
   the same run mode, and the same target robot; R2R children must also use the same source robot.
2. Call `preflight_batch` with `schema_version: "1.0"`, `workflow: h2r` or `r2r`, the ordered
   `item_plan_ids`, and `output_policy: create_new`. Do not pass asset paths or rebuild child
   identities. Batch item/frame caps are administrator settings where `0` means unlimited; the
   default is unlimited. Items execute serially within the job.
3. Start only a `ready` batch plan with `start_job`. During `wait_job`, report
   `completed_items / total_items`; never expect an unbounded per-item array in job status.
4. Cancellation is cooperative for the current child and prevents every not-yet-started child.
   A retry is a new whole-batch attempt; never silently retry only failed items.
5. At completion, read `hhtools://jobs/{job_id}/batch`, plus failures, evaluation, and manifest
   when present. `partial` means some children failed. Each successful child still requires
   quality review. Export the `batch_archive` artifact for one portable ZIP delivery.
6. A full batch requires explicit approval and new full child plans for every item, followed by a
   new `preflight_batch`, batch plan, and idempotency key. Never mix smoke and full child plans.

## Execute allowlisted agent actions

The only automatic preflight recovery mapping is:

| Returned action | MCP operation | Required behavior |
|---|---|---|
| `actor: agent`, `action: register_asset_bundle` | `register_asset_bundle` | Pass `next_action.parameters` unchanged as the tool arguments. It must contain exactly one `request` matching `AssetRegistrationRequest`. Inspect the returned robot bundle, replace `robot_asset_id` with its `asset_id`, and perform a new preflight. |

Do not translate semantic action names, derive a host path, enumerate directories, or repair a
malformed action. If the action name, wrapper shape, `root_id`, or portable `relative_path` does
not validate against the live tool schema, stop and present the contract error.

## Non-negotiable invariants

| ID | Rule |
|---|---|
| `MCP_ONLY` | Use HHTools MCP tools/resources only; never fall back to shell, JSON CLI, REST, or direct service imports. |
| `ALLOWLISTED_ASSETS` | Asset registration accepts only a capability-advertised `root_id` plus normalized `relative_path`, never an arbitrary or absolute path. |
| `H2R_BACKEND_ROUTING` | Use `newton` only for inspected `plain_motion`; use `interaction_mesh` only for inspected object interaction or terrain scenes, and never bypass isolated content validation. |
| `R2R_INITIAL_SCOPE` | R2R accepts only semantically inspected, scene-free robot trajectories whose declared source identity matches the selected source robot. |
| `SCALABLE_BATCH` | Batch accepts only ordered ready child plans from one workflow and run mode, with common robot identities and unique inputs; optional administrator caps use 0 for unlimited, while retry remains whole-batch. |
| `PREFLIGHT_OWNS_MODE` | `run_mode` belongs in preflight `request.parameters`; `start_job` accepts only `plan_id` and `idempotency_key`. |
| `OUTPUT_CREATE_NEW` | Use `output_policy: create_new`; other output policies are unsupported in the current Agent service. |
| `IDEMPOTENT_START` | Persist the exact plan and idempotency key, recover with `lookup_job`, and replay an ambiguous start only with that same plan and idempotency key; never create a second key for the same logical submission. |
| `IDEMPOTENT_RETRY` | Replay an ambiguous retry with the exact same parent job and retry idempotency key; never create a second child attempt. |
| `NEW_FULL_PLAN` | A full run requires explicit approval, a new full preflight, a new plan, and a new idempotency key. |
| `JOB_SCOPED_ARTIFACTS` | List, resolve, or export an artifact with both `job_id` and `artifact_id`; never trust or expose an unbound artifact identity. |
| `NO_BINARY_CONTEXT` | Keep binary motion, meshes, video, trajectories, and Base64 payloads out of tool arguments and model context; use `export_artifact` and its portable receipt for file delivery. |
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

Return a compact audit trail: selected input and robot asset IDs (including both R2R robots), run
mode and plan ID, job ID and lineage, final state/outcome, evaluation verdict, artifact IDs with hashes when
available, batch counts/report when applicable, any artifact export receipt requested by the user,
and any remaining human action.
Explicitly label unverified quality, unavailable actual-device provenance, and unsupported remote
or real-robot steps.
