"""HHTools MCP Python SDK v2 server over local stdio.

Tools in this module are deliberately thin calls into application services.
They neither invoke the CLI/REST adapter nor duplicate loader, IK, calibration,
export, scheduler, or artifact-membership logic.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
from collections.abc import AsyncIterator, Callable, Sequence
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from pathlib import Path
from typing import Any, cast
from urllib.parse import urlsplit

from mcp.server import MCPServer
from mcp.server.mcpserver import Context
from mcp.server.mcpserver.exceptions import ResourceError
from mcp.types import CallToolResult, TextContent, ToolAnnotations
from pydantic import BaseModel

from hhtools._version import __version__
from hhtools.contracts import (
    AgentJobView,
    ApiError,
    ArtifactDescriptor,
    ArtifactListResponse,
    AssetBundle,
    AssetCategory,
    AssetInspection,
    AssetInspectionRequest,
    AssetKind,
    AssetRegistrationRequest,
    AssetSearchResponse,
    CapabilityResponse,
    ErrorStage,
    EvaluationReport,
    FailureReport,
    JobManifest,
    JobRetryRequest,
    JobStartRequest,
    PreflightResponse,
    RetargetPreflightRequest,
    RobotListResponse,
)
from hhtools.contracts.portability import validate_portable_json
from hhtools.contracts.schema_registry import PUBLIC_AGENT_SCHEMAS
from hhtools.services.jobs import JobManagerError

from .runtime import AgentRuntime, LocalRuntimeConfig, local_agent_runtime

_log = logging.getLogger(__name__)
_REPORT_LIMIT_BYTES = 2 * 1024 * 1024
RuntimeFactory = Callable[[], AbstractAsyncContextManager[AgentRuntime]]

_READ_ONLY = ToolAnnotations(
    read_only_hint=True,
    destructive_hint=False,
    idempotent_hint=True,
    open_world_hint=False,
)
_SAFE_WRITE = ToolAnnotations(
    read_only_hint=False,
    destructive_hint=False,
    idempotent_hint=True,
    open_world_hint=False,
)
_CANCEL = ToolAnnotations(
    read_only_hint=False,
    destructive_hint=True,
    idempotent_hint=True,
    open_world_hint=False,
)


def _model_document(model: BaseModel) -> dict[str, Any]:
    document = model.model_dump(mode="json", exclude_none=True)
    validate_portable_json(document)
    return document


def _internal_error() -> ApiError:
    return ApiError(
        code="INTERNAL_ERROR",
        message="The HHTools MCP service could not complete the request.",
        retryable=True,
        stage=ErrorStage.INTERNAL,
    )


def _public_error(exception: Exception) -> ApiError:
    error = getattr(exception, "api_error", None)
    return error if isinstance(error, ApiError) else _internal_error()


def _safe_error_document(exception: Exception) -> tuple[ApiError, dict[str, Any]]:
    """Return one portable public error without echoing rejected service data."""

    error = _public_error(exception)
    try:
        return error, _model_document(error)
    except Exception:  # noqa: BLE001 - the protocol boundary must never leak it
        # Do not log the rejected error or exception: either may contain the
        # host path (or other unsafe value) that this boundary is removing.
        _log.error("discarded a non-portable HHTools MCP service error")
        error = _internal_error()
        return error, _model_document(error)


def _error_result(document: dict[str, Any]) -> CallToolResult:
    return CallToolResult(
        content=[
            TextContent(
                type="text",
                text=json.dumps(document, ensure_ascii=False, separators=(",", ":")),
            )
        ],
        structuredContent=document,
        isError=True,
    )


def _tool_call[T](call: Callable[[], T]) -> T:
    """Keep success schemas while returning expected failures as MCP tool errors."""

    try:
        result = call()
        if isinstance(result, BaseModel):
            # Return a detached model rebuilt from the exact portable snapshot
            # that was checked.  Returning the service-owned instance would let
            # a concurrently mutated nested dict/list diverge before the SDK's
            # later serialization step.
            return cast(T, type(result).model_validate(_model_document(result)))
        return result
    except Exception as exception:  # noqa: BLE001 - protocol boundary
        error, document = _safe_error_document(exception)
        if error.code == "INTERNAL_ERROR":
            # Exception text can itself contain a host path.  Keep diagnostics
            # useful without copying untrusted service data to stderr.
            _log.error(
                "unexpected HHTools MCP tool failure (%s)",
                type(exception).__name__,
            )
        # MCPServer recognises a direct CallToolResult before validating the
        # declared success model, retaining both outputSchema and ApiError.
        return cast(T, _error_result(document))


def _resource_call[T](call: Callable[[], T]) -> T:
    try:
        return call()
    except Exception as exception:  # noqa: BLE001 - protocol boundary
        error, document = _safe_error_document(exception)
        if error.code == "INTERNAL_ERROR":
            _log.error(
                "unexpected HHTools MCP resource failure (%s)",
                type(exception).__name__,
            )
        raise ResourceError(
            json.dumps(
                document,
                ensure_ascii=False,
                separators=(",", ":"),
            )
        ) from None


def _runtime(context: Context[AgentRuntime, Any]) -> AgentRuntime:
    return context.request_context.lifespan_context


def _job_error(code: str, message: str, *, job_id: str) -> JobManagerError:
    return JobManagerError(
        ApiError(
            code=code,
            message=message,
            stage=ErrorStage.ARTIFACT,
            details={"job_id": job_id},
        )
    )


def _find_report(
    runtime: AgentRuntime,
    job_id: str,
    kind: str,
) -> ArtifactDescriptor:
    view = runtime.jobs.get_job(job_id)
    total = view.artifact_count or 0
    offset = 0
    matches: list[ArtifactDescriptor] = []
    while offset < total:
        page = runtime.jobs.list_artifacts(job_id, offset=offset, limit=500)
        if not page:
            break
        matches.extend(item for item in page if item.kind == kind)
        offset += len(page)
    if len(matches) != 1:
        raise _job_error(
            "ARTIFACT_NOT_FOUND",
            f"The job does not expose one canonical {kind} artifact.",
            job_id=job_id,
        )
    return matches[0]


def _read_report[T](
    runtime: AgentRuntime,
    job_id: str,
    kind: str,
    model: type[T],
) -> T:
    descriptor = _find_report(runtime, job_id, kind)
    stored = runtime.jobs.get_artifact(job_id, descriptor.artifact_id, verify=False)
    try:
        with stored.path.open("rb") as stream:
            payload = stream.read(_REPORT_LIMIT_BYTES + 1)
    except OSError as exception:
        raise _job_error(
            "ARTIFACT_HASH_MISMATCH",
            "The managed report no longer matches its descriptor.",
            job_id=job_id,
        ) from exception
    # Hash exactly the immutable byte string that will be parsed and returned.
    # A second read of the file would permit a concurrent writer to make the
    # digest describe different bytes (a classic check/use race).
    if (
        len(payload) > _REPORT_LIMIT_BYTES
        or len(payload) != descriptor.size_bytes
        or hashlib.sha256(payload).hexdigest() != descriptor.sha256
    ):
        raise _job_error(
            "ARTIFACT_HASH_MISMATCH",
            "The managed report no longer matches its descriptor.",
            job_id=job_id,
        )
    try:
        validator = cast(Any, model)
        return cast(T, validator.model_validate_json(payload))
    except Exception as exception:  # noqa: BLE001 - invalid managed artifact
        raise _job_error(
            "ARTIFACT_HASH_MISMATCH",
            "The managed report is not a valid versioned contract.",
            job_id=job_id,
        ) from exception


def _server_instructions(web_ui_url: str) -> str:
    return (
        "For every new H2R run: get capabilities, register/search and inspect assets, "
        "preflight a smoke plan, start only a ready plan, poll by revision, then read "
        "evaluation and manifest for human review. On human_action_required, stop and "
        "present next_action; never guess calibration. run_mode is frozen at preflight, "
        "and full requires a new full preflight plus explicit user approval. Completed "
        "does not mean quality-approved. Never use host paths, Base64 binary artifacts, "
        "or real-robot deployment. Cancellation is cooperative while native code runs. "
        "Only one local runtime may own a save directory. If calibration is required, "
        "ask the human to disconnect this stdio server before starting the WebUI with "
        f"the same save directory at {web_ui_url}; after WebUI exit, reconnect and run "
        "preflight again. Never read or request the WebUI session token."
    )


def _validate_web_ui_url(value: str) -> str:
    parsed = urlsplit(value)
    if (
        parsed.scheme != "http"
        or parsed.hostname not in {"127.0.0.1", "localhost", "::1"}
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError("web_ui_url must be an unauthenticated loopback HTTP URL")
    return value.rstrip("/")


def create_mcp_server(
    config: LocalRuntimeConfig | None = None,
    *,
    runtime_factory: RuntimeFactory | None = None,
) -> MCPServer[AgentRuntime]:
    """Build the stdio server; tests may inject the same service protocols."""

    config = config or LocalRuntimeConfig()
    web_ui_url = _validate_web_ui_url(config.web_ui_url)
    factory = runtime_factory or (lambda: local_agent_runtime(config))

    runtime_slot: AgentRuntime | None = None

    def active_runtime() -> AgentRuntime:
        if runtime_slot is None:
            raise RuntimeError("the MCP runtime is not active")
        return runtime_slot

    @asynccontextmanager
    async def lifespan(_server: MCPServer[AgentRuntime]) -> AsyncIterator[AgentRuntime]:
        nonlocal runtime_slot
        async with factory() as runtime:
            if runtime_slot is not None:
                raise RuntimeError("the MCP runtime is already active")
            runtime_slot = runtime
            try:
                yield runtime
            finally:
                runtime_slot = None

    server: MCPServer[AgentRuntime] = MCPServer(
        "hhtools",
        title="HHTools Agent",
        description="Safe local human-to-humanoid retargeting services.",
        instructions=_server_instructions(web_ui_url),
        version=__version__,
        lifespan=lifespan,
        # stdio reserves stdout for protocol frames.  Keep routine SDK
        # diagnostics on stderr quiet while retaining warnings and failures.
        log_level="WARNING",
    )

    @server.tool(annotations=_READ_ONLY)
    def get_capabilities(context: Context[AgentRuntime, Any]) -> CapabilityResponse:
        """Return backends, devices, robots, allowlisted roots, and live admission state."""

        return _tool_call(_runtime(context).capabilities.get_capabilities)

    @server.tool(annotations=_SAFE_WRITE)
    def register_asset_bundle(
        request: AssetRegistrationRequest,
        context: Context[AgentRuntime, Any],
    ) -> AssetBundle:
        """Register a content-addressed bundle using root_id plus a relative path."""

        return _tool_call(lambda: _runtime(context).assets.register(request))

    @server.tool(annotations=_READ_ONLY)
    def search_assets(
        context: Context[AgentRuntime, Any],
        query: str | None = None,
        kind: AssetKind | None = None,
        category: AssetCategory | None = None,
        dataset: str | None = None,
        reference: str | None = None,
        limit: int = 100,
        offset: int = 0,
    ) -> AssetSearchResponse:
        """Search immutable asset manifests with bounded portable filters."""

        return _tool_call(
            lambda: _runtime(context).assets.search(
                query=query,
                kind=kind,
                category=category,
                dataset=dataset,
                reference=reference,
                limit=limit,
                offset=offset,
            )
        )

    @server.tool(annotations=_READ_ONLY)
    def inspect_asset_bundle(
        request: AssetInspectionRequest,
        context: Context[AgentRuntime, Any],
    ) -> AssetInspection:
        """Verify manifest hashes and parse bundle content without starting a job."""

        return _tool_call(lambda: _runtime(context).assets.inspect(request))

    @server.tool(annotations=_READ_ONLY)
    def list_robots(context: Context[AgentRuntime, Any]) -> RobotListResponse:
        """List robot availability, references, IK-map facts, and calibration readiness."""

        return _tool_call(
            lambda: RobotListResponse(
                robots=_runtime(context).capabilities.get_capabilities().robots
            )
        )

    @server.tool(annotations=_SAFE_WRITE)
    def preflight_retarget(
        request: RetargetPreflightRequest,
        context: Context[AgentRuntime, Any],
    ) -> PreflightResponse:
        """Validate an H2R intent and freeze an immutable smoke or full plan."""

        return _tool_call(lambda: _runtime(context).preflight.preflight_retarget(request))

    @server.tool(annotations=_SAFE_WRITE)
    def start_retarget(
        request: JobStartRequest,
        context: Context[AgentRuntime, Any],
    ) -> AgentJobView:
        """Submit one preflighted plan; run_mode cannot be changed at this step."""

        return _tool_call(
            lambda: _runtime(context).jobs.start_retarget(
                request.plan_id,
                idempotency_key=request.idempotency_key,
            )
        )

    @server.tool(annotations=_READ_ONLY)
    def get_job(
        job_id: str,
        context: Context[AgentRuntime, Any],
        after_revision: int | None = None,
    ) -> AgentJobView:
        """Read a compact job snapshot, optionally marking an unchanged revision."""

        return _tool_call(
            lambda: _runtime(context).jobs.get_job(
                job_id,
                after_revision=after_revision,
            )
        )

    @server.tool(annotations=_CANCEL)
    def cancel_job(
        job_id: str,
        context: Context[AgentRuntime, Any],
    ) -> AgentJobView:
        """Request exact queued cancellation or cooperative running cancellation."""

        return _tool_call(lambda: _runtime(context).jobs.cancel_job(job_id))

    @server.tool(annotations=_SAFE_WRITE)
    def retry_job(
        job_id: str,
        request: JobRetryRequest,
        context: Context[AgentRuntime, Any],
    ) -> AgentJobView:
        """Create an idempotent whole-plan child attempt for a terminal H2R job."""

        return _tool_call(
            lambda: _runtime(context).jobs.retry_job(
                job_id,
                idempotency_key=request.idempotency_key,
            )
        )

    @server.tool(annotations=_READ_ONLY)
    def list_job_artifacts(
        job_id: str,
        context: Context[AgentRuntime, Any],
        limit: int = 100,
        offset: int = 0,
    ) -> ArtifactListResponse:
        """List a bounded page of canonical descriptors attached to one job."""

        def list_page() -> ArtifactListResponse:
            runtime = _runtime(context)
            artifacts = runtime.jobs.list_artifacts(job_id, limit=limit, offset=offset)
            view = runtime.jobs.get_job(job_id)
            if view.artifact_count is None:
                raise _job_error(
                    "INTERNAL_ERROR",
                    "The canonical artifact count is unavailable.",
                    job_id=job_id,
                )
            return ArtifactListResponse(
                job_id=job_id,
                artifacts=artifacts,
                total=view.artifact_count,
                limit=limit,
                offset=offset,
            )

        return _tool_call(list_page)

    @server.resource(
        "hhtools://capabilities",
        name="hhtools-capabilities",
        description="Current HHTools capability snapshot.",
        mime_type="application/json",
    )
    def capabilities_resource() -> dict[str, Any]:
        return _resource_call(
            lambda: _model_document(active_runtime().capabilities.get_capabilities())
        )

    @server.resource(
        "hhtools://schemas/agent/v1/{schema_name}",
        name="hhtools-agent-schema",
        description="One public Agent v1 JSON Schema by canonical slug.",
        mime_type="application/schema+json",
    )
    def schema_resource(schema_name: str) -> dict[str, Any]:
        def schema() -> dict[str, Any]:
            model = PUBLIC_AGENT_SCHEMAS.get(schema_name)
            if model is None:
                raise JobManagerError(
                    ApiError(
                        code="SCHEMA_NOT_FOUND",
                        message="No public Agent schema has the requested name.",
                        stage=ErrorStage.REQUEST,
                        details={"schema_name": schema_name},
                    )
                )
            return model.model_json_schema()

        return _resource_call(schema)

    @server.resource(
        "hhtools://robots/{robot_id}",
        name="hhtools-robot",
        description="One robot capability and calibration-readiness record.",
        mime_type="application/json",
    )
    async def robot_resource(
        robot_id: str,
        context: Context,
    ) -> dict[str, Any]:
        def robot() -> dict[str, Any]:
            robots = _runtime(context).capabilities.get_capabilities().robots
            match = next((item for item in robots if item.robot_id == robot_id), None)
            if match is None:
                raise JobManagerError(
                    ApiError(
                        code="ROBOT_NOT_FOUND",
                        message="No robot has the requested id.",
                        stage=ErrorStage.REQUEST,
                        details={"robot_id": robot_id},
                    )
                )
            return _model_document(match)

        return _resource_call(robot)

    @server.resource(
        "hhtools://assets/{asset_id}/manifest",
        name="hhtools-asset-manifest",
        description="Portable immutable manifest for one registered asset.",
        mime_type="application/json",
    )
    async def asset_resource(
        asset_id: str,
        context: Context,
    ) -> dict[str, Any]:
        return _resource_call(lambda: _model_document(_runtime(context).assets.get(asset_id)))

    @server.resource(
        "hhtools://plans/{plan_id}",
        name="hhtools-retarget-plan",
        description="One immutable preflighted retarget plan.",
        mime_type="application/json",
    )
    async def plan_resource(
        plan_id: str,
        context: Context,
    ) -> dict[str, Any]:
        return _resource_call(lambda: _model_document(_runtime(context).plans.get(plan_id)))

    @server.resource(
        "hhtools://jobs/{job_id}/status",
        name="hhtools-job-status",
        description="Compact current state for one H2R job.",
        mime_type="application/json",
    )
    async def job_resource(
        job_id: str,
        context: Context,
    ) -> dict[str, Any]:
        return _resource_call(lambda: _model_document(_runtime(context).jobs.get_job(job_id)))

    @server.resource(
        "hhtools://jobs/{job_id}/manifest",
        name="hhtools-job-manifest",
        description="Verified terminal audit manifest for one H2R job.",
        mime_type="application/json",
    )
    async def manifest_resource(
        job_id: str,
        context: Context,
    ) -> dict[str, Any]:
        return _resource_call(
            lambda: _model_document(
                _read_report(_runtime(context), job_id, "manifest", JobManifest)
            )
        )

    @server.resource(
        "hhtools://jobs/{job_id}/evaluation",
        name="hhtools-job-evaluation",
        description="Verified quality report; completion alone is not approval.",
        mime_type="application/json",
    )
    async def evaluation_resource(
        job_id: str,
        context: Context,
    ) -> dict[str, Any]:
        return _resource_call(
            lambda: _model_document(
                _read_report(
                    _runtime(context),
                    job_id,
                    "evaluation_report",
                    EvaluationReport,
                )
            )
        )

    @server.resource(
        "hhtools://jobs/{job_id}/failures",
        name="hhtools-job-failures",
        description="Verified structured failure report for a failed or partial job.",
        mime_type="application/json",
    )
    async def failures_resource(
        job_id: str,
        context: Context,
    ) -> dict[str, Any]:
        return _resource_call(
            lambda: _model_document(
                _read_report(
                    _runtime(context),
                    job_id,
                    "failure_report",
                    FailureReport,
                )
            )
        )

    @server.resource(
        "hhtools://jobs/{job_id}/artifacts/{artifact_id}",
        name="hhtools-artifact-descriptor",
        description="Job-scoped descriptor only; binary bytes are never embedded.",
        mime_type="application/json",
    )
    async def artifact_resource(
        job_id: str,
        artifact_id: str,
        context: Context,
    ) -> dict[str, Any]:
        return _resource_call(
            lambda: _model_document(
                _runtime(context).jobs.get_artifact(job_id, artifact_id, verify=True).descriptor
            )
        )

    return server


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="hhtools-mcp",
        description="Run the local HHTools MCP server over stdio.",
    )
    parser.add_argument("--source", type=Path, default=Path("assets/motions"))
    parser.add_argument("--save-dir", type=Path, default=Path("assets/save_npz"))
    parser.add_argument("--cache", type=Path, default=None)
    parser.add_argument("--job-settings", type=Path, default=None)
    parser.add_argument("--max-running-jobs", type=int, default=None)
    parser.add_argument("--max-queued-jobs", type=int, default=None)
    parser.add_argument("--web-ui-url", default="http://127.0.0.1:8009")
    return parser


def main(argv: Sequence[str] | None = None) -> None:
    """Console entry point. stdout remains exclusively owned by MCP framing."""

    arguments = _parser().parse_args(argv)
    for name in ("max_running_jobs", "max_queued_jobs"):
        value = getattr(arguments, name)
        if value is not None and value < 0:
            _parser().error(f"--{name.replace('_', '-')} must be non-negative")
    config = LocalRuntimeConfig(
        source_root=arguments.source,
        save_dir=arguments.save_dir,
        cache_dir=arguments.cache,
        max_running_jobs=arguments.max_running_jobs,
        max_queued_jobs=arguments.max_queued_jobs,
        job_settings_path=arguments.job_settings,
        web_ui_url=arguments.web_ui_url,
    )
    create_mcp_server(config).run("stdio")


if __name__ == "__main__":
    main()


__all__ = ["RuntimeFactory", "create_mcp_server", "main"]
