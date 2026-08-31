# HHTools Agent contract map

Use the live MCP tool input/output schema as the runtime authority. These repository snapshots
explain the stable Agent v1 documents and are useful when a field, state, or resource is
unfamiliar. Load only the contracts needed for the current step.

The architectural workflow and supported boundaries are documented in the
[Agent integration plan](../../../../docs/agent-integration-plan.md).

## Tool and schema routing

| MCP operation | Request contract | Success contract |
|---|---|---|
| `get_capabilities` | No request document | [capabilities](../../../../docs/schemas/agent/v1/capabilities.schema.json) |
| `list_robots` | No request document | [robot list](../../../../docs/schemas/agent/v1/robot-list-response.schema.json) |
| `register_asset_bundle` | [asset registration request](../../../../docs/schemas/agent/v1/asset-registration-request.schema.json) | [asset bundle](../../../../docs/schemas/agent/v1/asset-bundle.schema.json) |
| `search_assets` | Bounded scalar filters from the live tool schema | [asset search response](../../../../docs/schemas/agent/v1/asset-search-response.schema.json) |
| `inspect_asset_bundle` | `asset_id`, `verify_hashes`, and `parse_content` from the live tool schema | [asset inspection](../../../../docs/schemas/agent/v1/asset-inspection.schema.json) |
| `preflight_retarget` | [retarget preflight request](../../../../docs/schemas/agent/v1/retarget-preflight-request.schema.json) | [preflight response](../../../../docs/schemas/agent/v1/preflight-response.schema.json) |
| `start_retarget` | [job start request](../../../../docs/schemas/agent/v1/job-start-request.schema.json) | [agent job view](../../../../docs/schemas/agent/v1/agent-job-view.schema.json) |
| `get_job` / `cancel_job` | Scalar job identity and live tool fields | [agent job view](../../../../docs/schemas/agent/v1/agent-job-view.schema.json) |
| `retry_job` | [job retry request](../../../../docs/schemas/agent/v1/job-retry-request.schema.json) | [agent job view](../../../../docs/schemas/agent/v1/agent-job-view.schema.json) |
| `list_job_artifacts` | `job_id`, `limit`, and `offset` | [artifact list response](../../../../docs/schemas/agent/v1/artifact-list-response.schema.json) |

Expected tool failures use the [API error](../../../../docs/schemas/agent/v1/api-error.schema.json)
contract rather than a prose-only exception. Inspect `code`, `retryable`, `stage`, `details`, and
`next_action`; do not recover from the human-readable message alone.

## Read-only resources

Use these exact URI shapes:

```text
hhtools://capabilities
hhtools://schemas/agent/v1/{schema_name}
hhtools://robots/{robot_id}
hhtools://assets/{asset_id}/manifest
hhtools://plans/{plan_id}
hhtools://jobs/{job_id}/status
hhtools://jobs/{job_id}/manifest
hhtools://jobs/{job_id}/evaluation
hhtools://jobs/{job_id}/failures
hhtools://jobs/{job_id}/artifacts/{artifact_id}
```

For the schema resource, `{schema_name}` is the exact registry slug with no filename suffix—for
example, `capabilities` or `job-spec-v2`, never `capabilities.schema.json`.

The report resources validate managed bytes before returning the versioned
[evaluation report](../../../../docs/schemas/agent/v1/evaluation-report.schema.json),
[failure report](../../../../docs/schemas/agent/v1/failure-report.schema.json), or
[job manifest](../../../../docs/schemas/agent/v1/job-manifest.schema.json). The job-scoped
artifact resource returns only a verified
[artifact descriptor](../../../../docs/schemas/agent/v1/artifact.schema.json). It does not stream
binary content.

## Field placement and identity rules

- Operational Agent v1 request and response envelopes use `schema_version: "1.0"` and reject
  unknown fields. The audit-only JobSpec v2 embedded in a manifest is the explicit exception and
  uses integer `schema_version: 2`.
- `register_asset_bundle` identifies a deployment-owned source with `root_id + relative_path`.
  Backslashes, absolute paths, drive paths, `.` segments, and `..` traversal are not portable
  registration inputs.
- `asset_id`, `plan_id`, `job_id`, and `artifact_id` are distinct identities. Never derive one
  from a display name or host path.
- `run_mode` is `RetargetPreflightRequest.parameters.run_mode`. It is frozen in the returned
  plan. [Job start](../../../../docs/schemas/agent/v1/job-start-request.schema.json) has no mode
  override.
- Use `output_policy: create_new`. The current PreflightService rejects `overwrite` and
  `fail_if_exists` as unsupported rather than treating them as user-selectable alternatives.
- An idempotency key binds one logical start request. Reuse it only with the exact same plan
  when delivery of the response is uncertain.
- `AgentJobView.artifacts` is compact and may contain only the first page. Use
  `artifact_count` and `list_job_artifacts` for canonical pagination.
- Every artifact lookup requires the owning `job_id` and `artifact_id`; verify one descriptor by
  reading its exact job-scoped resource URI. Binary data is never embedded as Base64.

## Audit-only public schemas

The immutable [JobSpec v2](../../../../docs/schemas/agent/v1/job-spec-v2.schema.json), with integer
`schema_version: 2`, appears in the terminal manifest but is not a replacement for preflight. The
public REST/CLI legacy upgrade
contracts—[request](../../../../docs/schemas/agent/v1/legacy-job-upgrade-request.schema.json),
[response](../../../../docs/schemas/agent/v1/legacy-job-upgrade-response.schema.json), and
[receipt](../../../../docs/schemas/agent/v1/legacy-migration-receipt.schema.json)—remain useful for
audit interpretation, but the initial MCP surface has no legacy-upgrade tool. Do not fall back to
the CLI or manufacture a v2 document inside this skill.

## Current boundary

The MCP stdio process assembles the same transport-neutral application services directly; it is
not a REST client and does not need `hhtools web` running. A given `save_dir` has exactly one
local runtime owner. A returned loopback WebUI URL is solely for human calibration: disconnect
the stdio MCP owner, let the human run the WebUI against that same `save_dir`, close the WebUI
after calibration, reconnect MCP, and preflight again. Never request a WebUI session token or run
MCP and Web concurrently against the same directory. There is no authenticated remote MCP
transport, multi-user authorization, cross-process active-job resume, or guaranteed actual-GPU
provenance in this phase.
