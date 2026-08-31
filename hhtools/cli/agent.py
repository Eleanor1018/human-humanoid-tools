"""Strict, versioned JSON client for the HHTools Agent REST API.

Every invocation writes exactly one JSON document to stdout.  Human-oriented
diagnostics belong on stderr, while large artifact bytes require an explicit
``--output`` file and never appear in JSON or Base64 form.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import Any, Never, TextIO
from urllib.parse import quote

import typer
from pydantic import BaseModel, ValidationError

from hhtools.contracts import (
    AgentJobView,
    ApiError,
    ArtifactDescriptor,
    ArtifactListResponse,
    AssetBundle,
    AssetInspection,
    AssetRegistrationRequest,
    AssetSearchResponse,
    CapabilityResponse,
    ErrorStage,
    JobRetryRequest,
    JobStartRequest,
    LegacyJobUpgradeRequest,
    LegacyJobUpgradeResponse,
    PreflightResponse,
    PreflightStatus,
    RetargetPreflightRequest,
)

from .agent_transport import (
    AgentTransport,
    AgentTransportError,
    HttpAgentTransport,
    PortableJsonError,
    StrictJsonError,
    ensure_portable_json,
    loads_strict_json,
)

DEFAULT_BASE_URL = "http://127.0.0.1:8009/api/agent/v1"
EXIT_SUCCESS = 0
EXIT_PARAMETER_ERROR = 2
EXIT_PREFLIGHT_ERROR = 3
EXIT_JOB_ERROR = 4
EXIT_INTERNAL_ERROR = 5
_MAX_REQUEST_BYTES = 8 * 1024 * 1024

TransportFactory = Callable[[str, float], AgentTransport]


class _ArgumentError(RuntimeError):
    pass


class _JsonArgumentParser(argparse.ArgumentParser):
    """Raise parse failures so stdout can remain one structured document."""

    def error(self, message: str) -> Never:
        raise _ArgumentError(message)

    def exit(self, status: int = 0, message: str | None = None) -> Never:
        raise _ArgumentError(message or "Help is available in the project documentation.")


def _parser() -> _JsonArgumentParser:
    parser = _JsonArgumentParser(prog="hhtools agent", add_help=False)
    commands = parser.add_subparsers(dest="group", required=True)

    capabilities = commands.add_parser("capabilities", add_help=False)
    capabilities.set_defaults(operation="capabilities")

    asset = commands.add_parser("asset", add_help=False)
    asset_commands = asset.add_subparsers(dest="asset_command", required=True)
    register = asset_commands.add_parser("register", add_help=False)
    register.add_argument("--request", required=True)
    register.set_defaults(operation="asset_register")
    get_asset = asset_commands.add_parser("get", add_help=False)
    get_asset.add_argument("asset_id")
    get_asset.set_defaults(operation="asset_get")
    inspect = asset_commands.add_parser("inspect", add_help=False)
    inspect.add_argument("asset_id")
    inspect.add_argument("--no-verify-hashes", action="store_false", dest="verify_hashes")
    inspect.add_argument("--no-parse-content", action="store_false", dest="parse_content")
    inspect.set_defaults(operation="asset_inspect")
    search = asset_commands.add_parser("search", add_help=False)
    search.add_argument("--query")
    search.add_argument("--kind")
    search.add_argument("--category")
    search.add_argument("--dataset")
    search.add_argument("--reference")
    search.add_argument("--limit", type=int, default=100)
    search.add_argument("--offset", type=int, default=0)
    search.set_defaults(operation="asset_search")

    preflight = commands.add_parser("preflight", add_help=False)
    preflight_commands = preflight.add_subparsers(dest="preflight_command", required=True)
    retarget = preflight_commands.add_parser("retarget", add_help=False)
    retarget.add_argument("--request", required=True)
    retarget.set_defaults(operation="preflight_retarget")

    job = commands.add_parser("job", add_help=False)
    job_commands = job.add_subparsers(dest="job_command", required=True)
    start = job_commands.add_parser("start", add_help=False)
    start.add_argument("--plan", required=True)
    start.add_argument("--idempotency-key", required=True)
    start.set_defaults(operation="job_start")
    get_job = job_commands.add_parser("get", add_help=False)
    get_job.add_argument("job_id")
    get_job.add_argument("--after-revision", type=int)
    get_job.set_defaults(operation="job_get")
    cancel = job_commands.add_parser("cancel", add_help=False)
    cancel.add_argument("job_id")
    cancel.set_defaults(operation="job_cancel")
    retry = job_commands.add_parser("retry", add_help=False)
    retry.add_argument("job_id")
    retry.add_argument("--idempotency-key", required=True)
    retry.set_defaults(operation="job_retry")

    artifact = commands.add_parser("artifact", add_help=False)
    artifact_commands = artifact.add_subparsers(dest="artifact_command", required=True)
    list_artifacts = artifact_commands.add_parser("list", add_help=False)
    list_artifacts.add_argument("job_id")
    list_artifacts.add_argument("--limit", type=int, default=100)
    list_artifacts.add_argument("--offset", type=int, default=0)
    list_artifacts.set_defaults(operation="artifact_list")
    get_artifact = artifact_commands.add_parser("get", add_help=False)
    get_artifact.add_argument("job_id")
    get_artifact.add_argument("artifact_id")
    get_artifact.add_argument("--verify", action="store_true")
    get_artifact.add_argument("--output", type=Path)
    get_artifact.add_argument("--force", action="store_true")
    get_artifact.set_defaults(operation="artifact_get")

    legacy = commands.add_parser("legacy", add_help=False)
    legacy_commands = legacy.add_subparsers(dest="legacy_command", required=True)
    upgrade = legacy_commands.add_parser("upgrade", add_help=False)
    upgrade.add_argument("--request", required=True)
    upgrade.set_defaults(operation="legacy_upgrade")
    return parser


def _extract_global_option(
    arguments: list[str],
    name: str,
    *,
    default: str,
) -> tuple[list[str], str]:
    """Allow connection options before or after nested command names."""

    remaining: list[str] = []
    selected: str | None = None
    index = 0
    while index < len(arguments):
        value = arguments[index]
        if value == name:
            if selected is not None or index + 1 >= len(arguments):
                raise _ArgumentError(f"{name} must be provided exactly once with a value")
            selected = arguments[index + 1]
            index += 2
            continue
        prefix = f"{name}="
        if value.startswith(prefix):
            if selected is not None:
                raise _ArgumentError(f"{name} must be provided at most once")
            selected = value[len(prefix) :]
            index += 1
            continue
        remaining.append(value)
        index += 1
    return remaining, selected if selected is not None else default


def _normalize_argv(argv: Sequence[str]) -> tuple[list[str], str, float]:
    # ``--json`` is accepted in any position for parity with the documented
    # examples.  Agent commands are always strict JSON even when it is omitted.
    arguments = [value for value in argv if value != "--json"]
    arguments, base_url = _extract_global_option(
        arguments,
        "--base-url",
        default=os.environ.get("HHTOOLS_AGENT_BASE_URL", DEFAULT_BASE_URL),
    )
    arguments, raw_timeout = _extract_global_option(
        arguments,
        "--timeout",
        default=os.environ.get("HHTOOLS_AGENT_TIMEOUT", "30"),
    )
    try:
        timeout = float(raw_timeout)
    except ValueError as error:
        raise _ArgumentError("--timeout must be a finite number") from error
    if not math.isfinite(timeout) or not 0.1 <= timeout <= 3_600:
        raise _ArgumentError("--timeout must be between 0.1 and 3600 seconds")
    return arguments, base_url, timeout


def _request_document(location: str, stdin: TextIO) -> Any:
    if location == "-":
        raw = stdin.read(_MAX_REQUEST_BYTES + 1)
    else:
        try:
            with Path(location).open("r", encoding="utf-8") as stream:
                raw = stream.read(_MAX_REQUEST_BYTES + 1)
        except (OSError, UnicodeError) as error:
            raise _ArgumentError("--request could not be read as a UTF-8 JSON file") from error
    try:
        encoded_size = len(raw.encode("utf-8"))
    except UnicodeError as error:
        raise _ArgumentError("--request must be valid UTF-8 JSON") from error
    if encoded_size > _MAX_REQUEST_BYTES:
        raise _ArgumentError("--request exceeds the 8 MiB CLI safety limit")
    try:
        return loads_strict_json(raw)
    except StrictJsonError as error:
        raise _ArgumentError("--request must contain exactly one valid JSON document") from error


def _validated_request[ContractT: BaseModel](
    model: type[ContractT], location: str, stdin: TextIO
) -> ContractT:
    try:
        return model.model_validate(_request_document(location, stdin))
    except ValidationError as error:
        issues = [
            {
                "location": ".".join(str(part) for part in issue["loc"]),
                "type": issue["type"],
            }
            for issue in error.errors(include_url=False, include_input=False)
        ]
        raise AgentTransportError(
            ApiError(
                code="INVALID_PARAMETER",
                message="The CLI request does not match the versioned contract.",
                stage=ErrorStage.REQUEST,
                details={"issues": issues},
            )
        ) from error


def _response[ContractT: BaseModel](model: type[ContractT], payload: Any) -> ContractT:
    try:
        return model.model_validate(payload)
    except ValidationError as error:
        raise AgentTransportError(
            ApiError(
                code="REMOTE_PROTOCOL_ERROR",
                message="The Agent service response does not match the versioned contract.",
                retryable=True,
                stage=ErrorStage.INTERNAL,
            )
        ) from error


def _path_segment(value: str) -> str:
    return quote(value, safe="")


def _execute(  # noqa: PLR0911 - one explicit branch per public CLI operation
    namespace: argparse.Namespace,
    transport: AgentTransport,
    *,
    stdin: TextIO,
) -> BaseModel:
    operation = namespace.operation
    if operation == "capabilities":
        return _response(CapabilityResponse, transport.request_json("GET", "/capabilities"))

    if operation == "asset_register":
        request = _validated_request(AssetRegistrationRequest, namespace.request, stdin)
        return _response(
            AssetBundle,
            transport.request_json(
                "POST", "/assets", document=request.model_dump(mode="json", exclude_none=True)
            ),
        )
    if operation == "asset_get":
        path = f"/assets/{_path_segment(namespace.asset_id)}"
        return _response(AssetBundle, transport.request_json("GET", path))
    if operation == "asset_inspect":
        path = f"/assets/{_path_segment(namespace.asset_id)}/inspect"
        return _response(
            AssetInspection,
            transport.request_json(
                "GET",
                path,
                query={
                    "verify_hashes": namespace.verify_hashes,
                    "parse_content": namespace.parse_content,
                },
            ),
        )
    if operation == "asset_search":
        return _response(
            AssetSearchResponse,
            transport.request_json(
                "GET",
                "/assets",
                query={
                    "query": namespace.query,
                    "kind": namespace.kind,
                    "category": namespace.category,
                    "dataset": namespace.dataset,
                    "reference": namespace.reference,
                    "limit": namespace.limit,
                    "offset": namespace.offset,
                },
            ),
        )

    if operation == "preflight_retarget":
        request = _validated_request(RetargetPreflightRequest, namespace.request, stdin)
        return _response(
            PreflightResponse,
            transport.request_json(
                "POST",
                "/preflight/retarget",
                document=request.model_dump(mode="json", exclude_none=True),
            ),
        )

    if operation == "job_start":
        try:
            request = JobStartRequest(
                plan_id=namespace.plan,
                idempotency_key=namespace.idempotency_key,
            )
        except ValidationError as error:
            raise AgentTransportError(
                ApiError(
                    code="INVALID_PARAMETER",
                    message="The job start parameters do not match the versioned contract.",
                    stage=ErrorStage.REQUEST,
                )
            ) from error
        return _response(
            AgentJobView,
            transport.request_json(
                "POST", "/jobs", document=request.model_dump(mode="json", exclude_none=True)
            ),
        )
    if operation == "job_get":
        path = f"/jobs/{_path_segment(namespace.job_id)}"
        return _response(
            AgentJobView,
            transport.request_json("GET", path, query={"after_revision": namespace.after_revision}),
        )
    if operation == "job_cancel":
        path = f"/jobs/{_path_segment(namespace.job_id)}/cancel"
        return _response(AgentJobView, transport.request_json("POST", path, document={}))
    if operation == "job_retry":
        try:
            request = JobRetryRequest(idempotency_key=namespace.idempotency_key)
        except ValidationError as error:
            raise AgentTransportError(
                ApiError(
                    code="INVALID_PARAMETER",
                    message="The job retry parameters do not match the versioned contract.",
                    stage=ErrorStage.REQUEST,
                )
            ) from error
        path = f"/jobs/{_path_segment(namespace.job_id)}/retry"
        return _response(
            AgentJobView,
            transport.request_json(
                "POST", path, document=request.model_dump(mode="json", exclude_none=True)
            ),
        )

    if operation == "artifact_list":
        path = f"/jobs/{_path_segment(namespace.job_id)}/artifacts"
        return _response(
            ArtifactListResponse,
            transport.request_json(
                "GET", path, query={"limit": namespace.limit, "offset": namespace.offset}
            ),
        )
    if operation == "artifact_get":
        path = (
            f"/jobs/{_path_segment(namespace.job_id)}/artifacts/"
            f"{_path_segment(namespace.artifact_id)}"
        )
        descriptor = _response(
            ArtifactDescriptor,
            transport.request_json("GET", path, query={"verify": namespace.verify}),
        )
        if descriptor.job_id != namespace.job_id or descriptor.artifact_id != namespace.artifact_id:
            raise AgentTransportError(
                ApiError(
                    code="REMOTE_PROTOCOL_ERROR",
                    message="The Agent service returned a descriptor for another job or artifact.",
                    retryable=True,
                    stage=ErrorStage.INTERNAL,
                )
            )
        if namespace.output is not None:
            transport.download_artifact(
                f"{path}/content",
                destination=namespace.output,
                descriptor=descriptor,
                overwrite=namespace.force,
            )
        elif namespace.force:
            raise AgentTransportError(
                ApiError(
                    code="INVALID_PARAMETER",
                    message="--force is only valid together with --output.",
                    stage=ErrorStage.REQUEST,
                )
            )
        return descriptor

    if operation == "legacy_upgrade":
        # The file is the historical v1 document (or its historical download
        # wrapper), not a second transport wrapper users must manufacture.  The
        # CLI adds the versioned request envelope before crossing REST.
        try:
            request = LegacyJobUpgradeRequest(payload=_request_document(namespace.request, stdin))
        except ValidationError as error:
            raise AgentTransportError(
                ApiError(
                    code="INVALID_PARAMETER",
                    message="The legacy request must contain one JSON object.",
                    stage=ErrorStage.REQUEST,
                )
            ) from error
        return _response(
            LegacyJobUpgradeResponse,
            transport.request_json(
                "POST",
                "/legacy/jobspec-v1/upgrade",
                document=request.model_dump(mode="json", exclude_none=True),
            ),
        )
    raise RuntimeError("unknown Agent CLI operation")


def _error_exit_code(error: ApiError) -> int:
    if error.stage in {
        ErrorStage.REQUEST,
        ErrorStage.ASSET_REGISTRATION,
        ErrorStage.ASSET_INSPECTION,
    }:
        return EXIT_PARAMETER_ERROR
    if error.stage is ErrorStage.PREFLIGHT:
        return EXIT_PREFLIGHT_ERROR
    if error.stage in {
        ErrorStage.ADMISSION,
        ErrorStage.EXECUTION,
        ErrorStage.EVALUATION,
        ErrorStage.ARTIFACT,
    }:
        return EXIT_JOB_ERROR
    return EXIT_INTERNAL_ERROR


def _result_exit_code(result: BaseModel) -> int:
    if isinstance(result, PreflightResponse):
        return EXIT_SUCCESS if result.status is PreflightStatus.READY else EXIT_PREFLIGHT_ERROR
    if isinstance(result, LegacyJobUpgradeResponse):
        return (
            EXIT_SUCCESS
            if result.preflight.status is PreflightStatus.READY
            else EXIT_PREFLIGHT_ERROR
        )
    return EXIT_SUCCESS


def _write_document(document: BaseModel, stdout: TextIO) -> bool:
    """Write one portable document, replacing unsafe responses as a whole."""

    safe = True
    try:
        payload = document.model_dump(mode="json", exclude_none=True)
        ensure_portable_json(payload)
        encoded = json.dumps(
            payload,
            ensure_ascii=False,
            allow_nan=False,
            separators=(",", ":"),
        )
    except (PortableJsonError, TypeError, ValueError, OverflowError):
        safe = False
        fallback = ApiError(
            code="INTERNAL_ERROR",
            message="The Agent response was not safe for portable JSON output.",
            retryable=False,
            stage=ErrorStage.INTERNAL,
        )
        encoded = fallback.model_dump_json(exclude_none=True)
    stdout.write(encoded)
    stdout.write("\n")
    stdout.flush()
    return safe


def _default_transport_factory(base_url: str, timeout: float) -> AgentTransport:
    return HttpAgentTransport(base_url, timeout_seconds=timeout)


def run(
    argv: Sequence[str] | None = None,
    *,
    transport_factory: TransportFactory | None = None,
    stdin: TextIO | None = None,
    stdout: TextIO | None = None,
    stderr: TextIO | None = None,
) -> int:
    """Run one command without allowing parser or protocol prose on stdout."""

    input_stream = stdin or sys.stdin
    output_stream = stdout or sys.stdout
    # Retained as an explicit dependency boundary for future progress logging;
    # no current command emits human prose during a successful invocation.
    _ = stderr or sys.stderr
    try:
        arguments, base_url, timeout = _normalize_argv(list(argv or ()))
        namespace = _parser().parse_args(arguments)
        factory = transport_factory or _default_transport_factory
        transport = factory(base_url, timeout)
        result = _execute(namespace, transport, stdin=input_stream)
        safe = _write_document(result, output_stream)
        return _result_exit_code(result) if safe else EXIT_INTERNAL_ERROR
    except _ArgumentError:
        api_error = ApiError(
            code="INVALID_PARAMETER",
            message="The Agent command arguments are invalid.",
            stage=ErrorStage.REQUEST,
        )
    except AgentTransportError as error:
        api_error = error.error
    except Exception:  # noqa: BLE001 - stdout must remain a JSON contract on failure
        api_error = ApiError(
            code="INTERNAL_ERROR",
            message="The JSON CLI could not complete the request.",
            retryable=True,
            stage=ErrorStage.INTERNAL,
        )
    safe = _write_document(api_error, output_stream)
    return _error_exit_code(api_error) if safe else EXIT_INTERNAL_ERROR


_PASSTHROUGH_CONTEXT = {
    "allow_extra_args": True,
    "ignore_unknown_options": True,
    "help_option_names": [],
}

app = typer.Typer(
    help="Call the versioned Agent API with strict JSON input and output.",
    add_completion=False,
    no_args_is_help=False,
    context_settings=_PASSTHROUGH_CONTEXT,
)


@app.callback(invoke_without_command=True)
def launch(ctx: typer.Context) -> None:
    """Return a JSON argument error when no operation was selected."""

    if ctx.invoked_subcommand is None:
        raise typer.Exit(code=run(ctx.args))


def _passthrough(prefix: Sequence[str], ctx: typer.Context) -> None:
    raise typer.Exit(code=run([*prefix, *ctx.args]))


@app.command("capabilities", context_settings=_PASSTHROUGH_CONTEXT)
def capabilities_command(ctx: typer.Context) -> None:
    _passthrough(["capabilities"], ctx)


asset_app = typer.Typer(
    add_completion=False,
    no_args_is_help=False,
    context_settings=_PASSTHROUGH_CONTEXT,
)
app.add_typer(asset_app, name="asset")


@asset_app.callback(invoke_without_command=True)
def asset_group(ctx: typer.Context) -> None:
    if ctx.invoked_subcommand is None:
        _passthrough(["asset"], ctx)


@asset_app.command("register", context_settings=_PASSTHROUGH_CONTEXT)
def asset_register_command(ctx: typer.Context) -> None:
    _passthrough(["asset", "register"], ctx)


@asset_app.command("get", context_settings=_PASSTHROUGH_CONTEXT)
def asset_get_command(ctx: typer.Context) -> None:
    _passthrough(["asset", "get"], ctx)


@asset_app.command("inspect", context_settings=_PASSTHROUGH_CONTEXT)
def asset_inspect_command(ctx: typer.Context) -> None:
    _passthrough(["asset", "inspect"], ctx)


@asset_app.command("search", context_settings=_PASSTHROUGH_CONTEXT)
def asset_search_command(ctx: typer.Context) -> None:
    _passthrough(["asset", "search"], ctx)


preflight_app = typer.Typer(
    add_completion=False,
    no_args_is_help=False,
    context_settings=_PASSTHROUGH_CONTEXT,
)
app.add_typer(preflight_app, name="preflight")


@preflight_app.callback(invoke_without_command=True)
def preflight_group(ctx: typer.Context) -> None:
    if ctx.invoked_subcommand is None:
        _passthrough(["preflight"], ctx)


@preflight_app.command("retarget", context_settings=_PASSTHROUGH_CONTEXT)
def preflight_retarget_command(ctx: typer.Context) -> None:
    _passthrough(["preflight", "retarget"], ctx)


job_app = typer.Typer(
    add_completion=False,
    no_args_is_help=False,
    context_settings=_PASSTHROUGH_CONTEXT,
)
app.add_typer(job_app, name="job")


@job_app.callback(invoke_without_command=True)
def job_group(ctx: typer.Context) -> None:
    if ctx.invoked_subcommand is None:
        _passthrough(["job"], ctx)


@job_app.command("start", context_settings=_PASSTHROUGH_CONTEXT)
def job_start_command(ctx: typer.Context) -> None:
    _passthrough(["job", "start"], ctx)


@job_app.command("get", context_settings=_PASSTHROUGH_CONTEXT)
def job_get_command(ctx: typer.Context) -> None:
    _passthrough(["job", "get"], ctx)


@job_app.command("cancel", context_settings=_PASSTHROUGH_CONTEXT)
def job_cancel_command(ctx: typer.Context) -> None:
    _passthrough(["job", "cancel"], ctx)


@job_app.command("retry", context_settings=_PASSTHROUGH_CONTEXT)
def job_retry_command(ctx: typer.Context) -> None:
    _passthrough(["job", "retry"], ctx)


artifact_app = typer.Typer(
    add_completion=False,
    no_args_is_help=False,
    context_settings=_PASSTHROUGH_CONTEXT,
)
app.add_typer(artifact_app, name="artifact")


@artifact_app.callback(invoke_without_command=True)
def artifact_group(ctx: typer.Context) -> None:
    if ctx.invoked_subcommand is None:
        _passthrough(["artifact"], ctx)


@artifact_app.command("list", context_settings=_PASSTHROUGH_CONTEXT)
def artifact_list_command(ctx: typer.Context) -> None:
    _passthrough(["artifact", "list"], ctx)


@artifact_app.command("get", context_settings=_PASSTHROUGH_CONTEXT)
def artifact_get_command(ctx: typer.Context) -> None:
    _passthrough(["artifact", "get"], ctx)


legacy_app = typer.Typer(
    add_completion=False,
    no_args_is_help=False,
    context_settings=_PASSTHROUGH_CONTEXT,
)
app.add_typer(legacy_app, name="legacy")


@legacy_app.callback(invoke_without_command=True)
def legacy_group(ctx: typer.Context) -> None:
    if ctx.invoked_subcommand is None:
        _passthrough(["legacy"], ctx)


@legacy_app.command("upgrade", context_settings=_PASSTHROUGH_CONTEXT)
def legacy_upgrade_command(ctx: typer.Context) -> None:
    _passthrough(["legacy", "upgrade"], ctx)


def main(argv: Sequence[str] | None = None) -> int:
    """Standalone entry point used by tests and embedders."""

    return run(sys.argv[1:] if argv is None else argv)


__all__ = [
    "DEFAULT_BASE_URL",
    "EXIT_INTERNAL_ERROR",
    "EXIT_JOB_ERROR",
    "EXIT_PARAMETER_ERROR",
    "EXIT_PREFLIGHT_ERROR",
    "EXIT_SUCCESS",
    "app",
    "main",
    "run",
]
