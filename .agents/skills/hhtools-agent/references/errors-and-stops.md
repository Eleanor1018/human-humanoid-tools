# HHTools Agent errors and stopping rules

Treat structured status, `ApiError.code`, `retryable`, and `next_action` as the decision inputs.
Messages are explanations, not control flow. Never bypass a stop by changing solver parameters,
editing calibration, reading host files, or switching transports.

## Stop and recovery matrix

| Signal | Required action | Forbidden action |
|---|---|---|
| `MCP unavailable` | Stop and explain that the local HHTools MCP integration must be configured. | Do not invoke shell, JSON CLI, REST, or direct Python services as a fallback. |
| `RUNTIME_ALREADY_ACTIVE` | Stop and explain that another local runtime owns the same `save_dir`; have the human close that owner before reconnecting the intended runtime. | Do not bypass the lease, start MCP and Web together, or switch directories to hide the conflict. |
| `RUNTIME_LEASE_UNAVAILABLE` | Stop and present the runtime lease/storage error for human investigation. | Do not delete the lease file, disable locking, or continue without exclusive ownership. |
| `human_action_required` | Pause, present all `required_actions`, disconnect the stdio MCP owner, and ask the human to run the WebUI with the same `save_dir`; after calibration, close WebUI, reconnect MCP, and perform a new preflight. | Do not call `start_retarget`, run MCP and Web against the same directory, guess calibration values, or request a WebUI session token. |
| `CALIBRATION_REQUIRED` | Follow the actual human `required_actions` using the exclusive-runtime WebUI handoff, then reconnect MCP and preflight again. | Do not patch calibration, keep MCP and Web open together on one `save_dir`, or invent an action. |
| `CALIBRATION_MISMATCH` | Treat the preflight as rejected: stop and present the structured mismatch; follow `next_action` only if one is actually present. | Do not assume a human action exists, silently choose another reference, or automatically preflight again. |
| `ROBOT_ASSET_REQUIRED` / `ROBOT_BUNDLE_MISMATCH` with `actor: agent`, `action: register_asset_bundle` | Pass the returned `parameters` unchanged to the same-named MCP tool, inspect the registered bundle, use its `asset_id`, and perform a new preflight. | Do not derive a host path, search arbitrary directories, rename the action, or execute malformed/unmapped parameters. |
| `rejected` | Stop and explain the preflight checks and structured error. | Do not start a job or weaken validation to force a plan. |
| `PLAN_STALE` | Inspect the reason, resolve changed inputs, and perform a new preflight that yields a new plan and new start key. | Do not reuse the old plan or mutate its frozen parameters. |
| `QUEUE_FULL` / `SCHEDULER_UNAVAILABLE` | Respect `retryable`, `next_action`, and its polling advice; if replay is advised, retain the same logical submission key. | Do not busy-poll, generate many keys, or submit duplicate jobs. |
| `ambiguous start` | Call `lookup_job` with the exact recorded `plan_id` and idempotency key. Continue the recovered job when found; only on explicit `JOB_NOT_FOUND` replay `start_retarget` with that same pair. | Do not substitute `retry_job`, generate a new key, replay before lookup, or assume the first start failed. |
| `ambiguous retry` | Replay the exact same `retry_job` call with the same parent `job_id` and retry idempotency key, then inspect the returned child. | Do not generate a new key or create another child attempt. |
| `JOB_CONFLICT` | Stop and report that the idempotency key is already bound to a different plan or retry parent; reconcile the original logical request with the user. | Do not evade the conflict by inventing another key or submit a duplicate job. |
| `JOB_INTERRUPTED` | Explain that the prior process ended, then wait for explicit user approval before `retry_job`; the retry is a new whole-plan child attempt. | Do not claim resume, continue an active process, or retry automatically. |
| `JOB_CANCEL_UNSUPPORTED` / `INVALID_JOB_TRANSITION` | Report the current lifecycle state and available `next_action`; poll an active job only at the advised interval. | Do not force termination, mutate state, or conceal a late cancellation. |
| `cancel requested` | Poll until the service reports `cancelled` or another truthful terminal state; running native work cancels cooperatively at safe points. | Do not claim immediate cancellation merely because `cancel_job` returned. |
| `ARTIFACT_HASH_MISMATCH` | Stop artifact delivery, preserve the error, and ask the user whether to investigate or rerun. | Do not present the artifact as valid, skip verification, or read a host path directly. |
| `partial` | Read the failure and evaluation reports, summarize successful and failed portions, and pause for the user's decision. | Do not label the whole result successful or automatically retry a subset; retry is whole-plan only. |
| `review_required` | Read and present the evaluation plus manifest, then pause for explicit quality approval. | Do not preflight or start a full run and do not equate `completed` with accepted quality. |
| `rejected outcome` | Present the evaluation evidence and stop. | Do not promote the result to full or real-robot use. |

## Idempotency versus retry

These are different operations:

- Ambiguous start replay repeats the same logical submission with the same `plan_id` and
  idempotency key because it is unknown whether the original response arrived.
- Ambiguous retry replay repeats the same `retry_job`, parent `job_id`, and retry idempotency key;
  it does not authorize another child attempt.
- `retry_job` is allowed only for a terminal parent. It creates an auditable child attempt of the
  same whole H2R plan and requires explicit user intent plus its own retry idempotency key.
- A changed run mode or changed input is neither replay nor retry. It requires a new preflight,
  new plan, and new start key.

Never interpret `retryable: true` as permission to spin. Follow `next_action` and
`poll_after_ms`, preserve the relevant key, and keep retries bounded and visible.

## Terminal review

Use both lifecycle and semantic outcome:

| Job state | Outcome | Meaning |
|---|---|---|
| `completed` | `success` | Execution and automatic checks succeeded; still present smoke evidence before asking to run full. |
| `completed` | `review_required` | Execution completed, but a human must judge motion quality. |
| `completed` | `partial` | Some work failed; inspect the failure report and do not claim full success. |
| `completed` | `rejected` | Evaluation rejected the motion; stop. |
| `failed` | none | Read the structured error and failure/manifest resources when present. |
| `cancelled` | none | Cancellation reached a truthful terminal state; do not deliver it as a completed result. |

Before any full preflight, show the smoke evaluation, output identity, and limitations and obtain
explicit approval. Never send an offline trajectory to a physical robot from this workflow.
