from __future__ import annotations

import hashlib
import io
import json
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from typer.testing import CliRunner

from hhtools.cli import agent as agent_cli
from hhtools.cli import agent_transport
from hhtools.cli.agent import (
    EXIT_INTERNAL_ERROR,
    EXIT_JOB_ERROR,
    EXIT_PARAMETER_ERROR,
    EXIT_PREFLIGHT_ERROR,
    EXIT_SUCCESS,
    run,
)
from hhtools.cli.agent_transport import (
    AgentTransportError,
    HttpAgentTransport,
    StrictJsonError,
    ensure_portable_json,
    loads_strict_json,
)
from hhtools.contracts import (
    AgentJobView,
    ApiError,
    ArtifactDescriptor,
    ArtifactListResponse,
    CapabilityResponse,
    ErrorStage,
    JobProgress,
    PreflightResponse,
    SchedulerCapability,
)
from hhtools.web.agent_api import router as agent_router

_DIGEST = "a" * 64
_ASSET_ID = f"asset:sha256:{_DIGEST}"
_PLAN_ID = f"plan:sha256:{_DIGEST}"
_ARTIFACT_ID = "artifact:retargeted_motion:cli-test"
_NOW = datetime(2026, 8, 31, tzinfo=UTC)


class FakeTransport:
    def __init__(self, responses: list[Any]) -> None:
        self.responses = list(responses)
        self.requests: list[tuple[str, str, dict[str, Any], dict[str, Any] | None]] = []
        self.downloads: list[tuple[str, Path, ArtifactDescriptor, bool]] = []

    def request_json(
        self,
        method: str,
        path: str,
        *,
        query: dict[str, Any] | None = None,
        document: dict[str, Any] | None = None,
    ) -> Any:
        self.requests.append((method, path, dict(query or {}), document))
        response = self.responses.pop(0)
        if isinstance(response, BaseException):
            raise response
        if hasattr(response, "model_dump"):
            return response.model_dump(mode="json", exclude_none=True)
        return response

    def download_artifact(
        self,
        path: str,
        *,
        destination: Path,
        descriptor: ArtifactDescriptor,
        overwrite: bool,
    ) -> None:
        self.downloads.append((path, destination, descriptor, overwrite))
        destination.write_bytes(b"csv")


def _capabilities() -> CapabilityResponse:
    return CapabilityResponse(
        service_version="test",
        scheduler=SchedulerCapability(
            max_running_jobs=0,
            max_queued_jobs=0,
            mode="unlimited",
        ),
        supported_input_formats=["bvh"],
        supported_output_formats=["csv"],
        features={"agent_rest": True},
    )


def _job(job_id: str = "job_cli") -> AgentJobView:
    return AgentJobView(
        job_id=job_id,
        state="queued",
        progress=JobProgress(phase="queued", fraction=0.0),
        submitted_at=_NOW,
        cancellable=True,
        artifact_count=1,
    )


def _descriptor(job_id: str = "job_cli") -> ArtifactDescriptor:
    return ArtifactDescriptor(
        artifact_id=_ARTIFACT_ID,
        job_id=job_id,
        kind="retargeted_motion",
        format="csv",
        resource_uri=f"hhtools://jobs/{job_id}/artifacts/{_ARTIFACT_ID}",
        size_bytes=3,
        sha256=_DIGEST,
    )


def _invoke(arguments: list[str], transport: Any, *, stdin: str = ""):
    stdout = io.StringIO()
    stderr = io.StringIO()
    selected: list[tuple[str, float]] = []

    def factory(base_url: str, timeout: float) -> FakeTransport:
        selected.append((base_url, timeout))
        return transport

    code = run(
        arguments,
        transport_factory=factory,
        stdin=io.StringIO(stdin),
        stdout=stdout,
        stderr=stderr,
    )
    # Exactly one JSON document and no Rich/progress prose on stdout.
    document = json.loads(stdout.getvalue())
    assert stdout.getvalue().count("\n") == 1
    assert stderr.getvalue() == ""
    return code, document, selected


def test_capabilities_is_one_contract_and_accepts_global_options_anywhere() -> None:
    transport = FakeTransport([_capabilities()])

    code, document, selected = _invoke(
        [
            "capabilities",
            "--json",
            "--timeout",
            "12.5",
            "--base-url",
            "http://127.0.0.1:9000/api/agent/v1",
        ],
        transport,
    )

    assert code == EXIT_SUCCESS
    assert document["schema_version"] == "1.0"
    assert document["service_version"] == "test"
    assert selected == [("http://127.0.0.1:9000/api/agent/v1", 12.5)]
    assert transport.requests == [("GET", "/capabilities", {}, None)]


def test_request_validation_fails_before_transport_without_echoing_input() -> None:
    transport = FakeTransport([])
    raw = json.dumps(
        {
            "schema_version": "1.0",
            "root_id": "motion-library",
            "relative_path": "walk.bvh",
            "unexpected_secret": "do-not-echo",
        }
    )

    code, document, _selected = _invoke(
        ["asset", "register", "--request", "-", "--json"], transport, stdin=raw
    )

    assert code == EXIT_PARAMETER_ERROR
    assert document["code"] == "INVALID_PARAMETER"
    assert "do-not-echo" not in json.dumps(document)
    assert transport.requests == []


@pytest.mark.parametrize(
    ("arguments", "sensitive_value"),
    [
        (
            ["capabilities", "--unknown", r"C:\Users\Nora\secret.txt"],
            r"C:\Users\Nora\secret.txt",
        ),
        (
            [
                "asset",
                "register",
                "--request",
                r"C:\Users\Nora\does-not-exist.json",
            ],
            r"C:\Users\Nora\does-not-exist.json",
        ),
    ],
)
def test_cli_argument_errors_never_echo_argv_or_request_paths(
    arguments: list[str], sensitive_value: str
) -> None:
    transport = FakeTransport([])

    code, document, _selected = _invoke(arguments, transport)

    assert code == EXIT_PARAMETER_ERROR
    assert document["code"] == "INVALID_PARAMETER"
    assert document["message"] == "The Agent command arguments are invalid."
    assert sensitive_value not in json.dumps(document)
    assert transport.requests == []


@pytest.mark.parametrize(
    "raw",
    [
        '{"schema_version":"1.0","root_id":"a","root_id":"b","relative_path":"x"}',
        '{"schema_version":"1.0","root_id":"a","relative_path":"x","recursive":NaN}',
        '{"schema_version":"1.0","root_id":"a","relative_path":"x","recursive":Infinity}',
        '{"schema_version":"1.0","root_id":"a","relative_path":"x","recursive":1e9999}',
        '{"schema_version":"1.0","root_id":"a","relative_path":"x","recursive":' + "1" * 129 + "}",
        '{"schema_version":"1.0","root_id":"a","relative_path":"x","recursive":0.'
        + "1" * 129
        + "}",
    ],
)
def test_request_json_rejects_ambiguous_or_unbounded_json(raw: str) -> None:
    transport = FakeTransport([])

    code, document, _selected = _invoke(
        ["asset", "register", "--request", "-"], transport, stdin=raw
    )

    assert code == EXIT_PARAMETER_ERROR
    assert document["code"] == "INVALID_PARAMETER"
    assert transport.requests == []


def test_shared_strict_json_loader_also_protects_http_documents() -> None:
    with pytest.raises(StrictJsonError):
        loads_strict_json(b'{"code":"ONE","code":"TWO"}')
    with pytest.raises(StrictJsonError):
        loads_strict_json(b'{"value":-Infinity}')


def test_portable_output_guard_allows_controlled_resource_uris() -> None:
    ensure_portable_json(
        {
            "resource_uri": "hhtools://jobs/job_cli/artifacts/artifact:test:value",
            "documentation": "https://example.test/agent/v1",
            "message": ("See https://example.test/callback?next=/agent/v1 for details."),
        }
    )


def test_deep_request_json_is_a_parameter_error_instead_of_an_internal_error() -> None:
    transport = FakeTransport([])
    raw = "[" * 2_000 + "0" + "]" * 2_000

    code, document, _selected = _invoke(
        ["asset", "register", "--request", "-"], transport, stdin=raw
    )

    assert code == EXIT_PARAMETER_ERROR
    assert document["code"] == "INVALID_PARAMETER"
    assert transport.requests == []


class _HttpResponse:
    def __init__(self, payload: bytes) -> None:
        self._stream = io.BytesIO(payload)

    def __enter__(self):
        return self

    def __exit__(self, *_args: Any) -> None:
        return None

    def read(self, size: int = -1) -> bytes:
        return self._stream.read(size)


def test_http_transport_rejects_non_strict_success_json(monkeypatch) -> None:
    monkeypatch.setattr(
        agent_transport,
        "urlopen",
        lambda *_args, **_kwargs: _HttpResponse(b'{"schema_version":"1.0","x":1,"x":2}'),
    )
    transport = HttpAgentTransport("http://127.0.0.1:8009/api/agent/v1")

    with pytest.raises(AgentTransportError) as caught:
        transport.request_json("GET", "/capabilities")

    assert caught.value.error.code == "REMOTE_PROTOCOL_ERROR"


def test_http_artifact_download_streams_and_verifies_before_atomic_publish(
    tmp_path: Path, monkeypatch
) -> None:
    payload = b"frame,root_x\n0,1.0\n"
    digest = hashlib.sha256(payload).hexdigest()
    descriptor = ArtifactDescriptor(
        artifact_id=_ARTIFACT_ID,
        job_id="job_cli",
        kind="retargeted_motion",
        format="csv",
        resource_uri=f"hhtools://jobs/job_cli/artifacts/{_ARTIFACT_ID}",
        size_bytes=len(payload),
        sha256=digest,
    )
    monkeypatch.setattr(
        agent_transport,
        "urlopen",
        lambda *_args, **_kwargs: _HttpResponse(payload),
    )
    transport = HttpAgentTransport("http://127.0.0.1:8009/api/agent/v1")
    destination = tmp_path / "result.csv"

    transport.download_artifact(
        "/jobs/job_cli/artifacts/artifact%3Aretargeted_motion%3Acli-test/content",
        destination=destination,
        descriptor=descriptor,
        overwrite=False,
    )

    assert destination.read_bytes() == payload
    assert list(tmp_path.glob("*.tmp")) == []


class _WriteFailingStream:
    def __init__(self, stream: Any) -> None:
        self._stream = stream

    def __enter__(self) -> _WriteFailingStream:
        return self

    def __exit__(self, *_args: Any) -> None:
        self._stream.close()

    def write(self, _payload: bytes) -> int:
        raise OSError(r"C:\Users\Nora\private-output.csv")

    def flush(self) -> None:
        self._stream.flush()

    def fileno(self) -> int:
        return self._stream.fileno()


class _ReadFailingResponse(_HttpResponse):
    def read(self, size: int = -1) -> bytes:
        raise OSError("connection reset")


def test_http_artifact_response_read_failure_remains_a_service_error(
    tmp_path: Path, monkeypatch
) -> None:
    descriptor = _descriptor()
    monkeypatch.setattr(
        agent_transport,
        "urlopen",
        lambda *_args, **_kwargs: _ReadFailingResponse(b""),
    )
    transport = HttpAgentTransport("http://127.0.0.1:8009/api/agent/v1")

    with pytest.raises(AgentTransportError) as caught:
        transport.download_artifact(
            "/jobs/job_cli/artifacts/artifact/content",
            destination=tmp_path / "result.csv",
            descriptor=descriptor,
            overwrite=False,
        )

    assert caught.value.error.code == "AGENT_SERVICE_UNAVAILABLE"
    assert list(tmp_path.glob("*.tmp")) == []


def test_http_artifact_local_write_failure_is_not_a_service_error(
    tmp_path: Path, monkeypatch
) -> None:
    payload = b"frame,root_x\n0,1.0\n"
    descriptor = ArtifactDescriptor(
        artifact_id=_ARTIFACT_ID,
        job_id="job_cli",
        kind="retargeted_motion",
        format="csv",
        resource_uri=f"hhtools://jobs/job_cli/artifacts/{_ARTIFACT_ID}",
        size_bytes=len(payload),
        sha256=hashlib.sha256(payload).hexdigest(),
    )
    original_fdopen = agent_transport.os.fdopen
    monkeypatch.setattr(
        agent_transport,
        "urlopen",
        lambda *_args, **_kwargs: _HttpResponse(payload),
    )
    monkeypatch.setattr(
        agent_transport.os,
        "fdopen",
        lambda fd, mode: _WriteFailingStream(original_fdopen(fd, mode)),
    )
    destination = tmp_path / "result.csv"
    transport = HttpAgentTransport("http://127.0.0.1:8009/api/agent/v1")

    with pytest.raises(AgentTransportError) as caught:
        transport.download_artifact(
            "/jobs/job_cli/artifacts/artifact/content",
            destination=destination,
            descriptor=descriptor,
            overwrite=False,
        )

    assert caught.value.error.code == "OUTPUT_WRITE_FAILED"
    assert caught.value.error.stage is ErrorStage.ARTIFACT
    assert "private-output" not in caught.value.error.model_dump_json()
    assert not destination.exists()
    assert list(tmp_path.glob("*.tmp")) == []


@pytest.mark.parametrize(
    ("overwrite", "publish_operation"),
    [(False, "link"), (True, "replace")],
)
def test_http_artifact_publish_failure_has_stable_artifact_error(
    tmp_path: Path,
    monkeypatch,
    overwrite: bool,
    publish_operation: str,
) -> None:
    payload = b"csv"
    descriptor = ArtifactDescriptor(
        artifact_id=_ARTIFACT_ID,
        job_id="job_cli",
        kind="retargeted_motion",
        format="csv",
        resource_uri=f"hhtools://jobs/job_cli/artifacts/{_ARTIFACT_ID}",
        size_bytes=len(payload),
        sha256=hashlib.sha256(payload).hexdigest(),
    )
    monkeypatch.setattr(
        agent_transport,
        "urlopen",
        lambda *_args, **_kwargs: _HttpResponse(payload),
    )

    def fail_publish(*_args: Any, **_kwargs: Any) -> None:
        raise OSError(r"C:\Users\Nora\private-output.csv")

    monkeypatch.setattr(agent_transport.os, publish_operation, fail_publish)
    destination = tmp_path / "result.csv"
    transport = HttpAgentTransport("http://127.0.0.1:8009/api/agent/v1")

    with pytest.raises(AgentTransportError) as caught:
        transport.download_artifact(
            "/jobs/job_cli/artifacts/artifact/content",
            destination=destination,
            descriptor=descriptor,
            overwrite=overwrite,
        )

    assert caught.value.error.code == "OUTPUT_WRITE_FAILED"
    assert caught.value.error.stage is ErrorStage.ARTIFACT
    assert "private-output" not in caught.value.error.model_dump_json()
    assert not destination.exists()
    assert list(tmp_path.glob("*.tmp")) == []


def test_preflight_non_ready_is_structured_and_uses_preflight_exit_code() -> None:
    preflight = PreflightResponse(
        request_id="req_cli",
        status="rejected",
        error=ApiError(
            code="CALIBRATION_REQUIRED",
            message="Calibration is required.",
            stage=ErrorStage.PREFLIGHT,
        ),
    )
    request = {
        "schema_version": "1.0",
        "motion_asset_id": _ASSET_ID,
        "robot_id": "g1_29dof",
        "robot_asset_id": _ASSET_ID,
    }
    transport = FakeTransport([preflight])

    code, document, _selected = _invoke(
        ["preflight", "retarget", "--request", "-"],
        transport,
        stdin=json.dumps(request),
    )

    assert code == EXIT_PREFLIGHT_ERROR
    assert document["status"] == "rejected"
    assert document["error"]["code"] == "CALIBRATION_REQUIRED"
    assert transport.requests[0][0:2] == ("POST", "/preflight/retarget")
    assert transport.requests[0][3] == request | {
        "output_format": "csv",
        "output_policy": "create_new",
        "parameters": {},
    }


@pytest.mark.parametrize(
    ("stage", "expected"),
    [
        (ErrorStage.REQUEST, EXIT_PARAMETER_ERROR),
        (ErrorStage.PREFLIGHT, EXIT_PREFLIGHT_ERROR),
        (ErrorStage.ADMISSION, EXIT_JOB_ERROR),
        (ErrorStage.ARTIFACT, EXIT_JOB_ERROR),
        (ErrorStage.INTERNAL, EXIT_INTERNAL_ERROR),
    ],
)
def test_service_errors_have_stable_exit_code_mapping(stage: ErrorStage, expected: int) -> None:
    error = AgentTransportError(
        ApiError(code="TEST_ERROR", message="Expected failure.", stage=stage)
    )

    code, document, _selected = _invoke(["capabilities"], FakeTransport([error]))

    assert code == expected
    assert document["code"] == "TEST_ERROR"
    assert document["stage"] == stage.value


@pytest.mark.parametrize(
    "unsafe_value",
    [
        r"debug:C:\Users\Nora\server-secret.log",
        r"path[\\private-host\share\server-secret.log]",
        "debug:/srv/hhtools/private/result.csv",
        r"path[C:\Users\Nora\server-secret.log]",
        "path{/srv/hhtools/private/result.csv}",
        "path|/srv/hhtools/private/result.csv",
        "path[//private-host/share]",
        r"https://example.test/path]C:\Users\Nora\server-secret.log",
        r"https://example.test,C:\Users\Nora\server-secret.log",
        "hhtools://jobs/job_cli/artifacts/report|/srv/hhtools/private/result.csv",
    ],
)
def test_valid_remote_api_error_with_host_path_fails_closed_on_stdout(
    unsafe_value: str,
) -> None:
    remote_error = AgentTransportError(
        ApiError(
            code="REMOTE_FAILURE",
            message="The remote service failed.",
            stage=ErrorStage.INTERNAL,
            details={"debug_path": unsafe_value},
        )
    )

    code, document, _selected = _invoke(["capabilities"], FakeTransport([remote_error]))

    assert code == EXIT_INTERNAL_ERROR
    assert document["code"] == "INTERNAL_ERROR"
    assert document["message"] == ("The Agent response was not safe for portable JSON output.")
    assert document["details"] == {}


def test_valid_remote_success_contract_with_host_path_fails_closed_on_stdout() -> None:
    descriptor = _descriptor().model_copy(
        update={"metadata": {"debug_path": "debug:/srv/hhtools/private/result.csv"}}
    )

    code, document, _selected = _invoke(
        ["artifact", "get", "job_cli", _ARTIFACT_ID],
        FakeTransport([descriptor]),
    )

    assert code == EXIT_INTERNAL_ERROR
    assert document["code"] == "INTERNAL_ERROR"
    assert document["details"] == {}


def test_job_commands_use_public_requests_and_versioned_routes() -> None:
    transport = FakeTransport([_job(), _job(), _job(), _job("job_retry")])

    start_code, _, _ = _invoke(
        ["job", "start", "--plan", _PLAN_ID, "--idempotency-key", "cli:start-1"],
        transport,
    )
    get_code, _, _ = _invoke(["job", "get", "job_cli", "--after-revision", "0"], transport)
    cancel_code, _, _ = _invoke(["job", "cancel", "job_cli"], transport)
    retry_code, _, _ = _invoke(
        ["job", "retry", "job_cli", "--idempotency-key", "cli:retry-1"],
        transport,
    )

    assert {start_code, get_code, cancel_code, retry_code} == {EXIT_SUCCESS}
    assert transport.requests == [
        (
            "POST",
            "/jobs",
            {},
            {
                "schema_version": "1.0",
                "plan_id": _PLAN_ID,
                "idempotency_key": "cli:start-1",
            },
        ),
        ("GET", "/jobs/job_cli", {"after_revision": 0}, None),
        ("POST", "/jobs/job_cli/cancel", {}, {}),
        (
            "POST",
            "/jobs/job_cli/retry",
            {},
            {"schema_version": "1.0", "idempotency_key": "cli:retry-1"},
        ),
    ]


def test_artifact_get_requires_job_membership_and_never_writes_bytes_to_json(
    tmp_path: Path,
) -> None:
    descriptor = _descriptor()
    page = ArtifactListResponse(
        job_id="job_cli", artifacts=[descriptor], total=1, limit=100, offset=0
    )
    transport = FakeTransport([page, descriptor])
    destination = tmp_path / "motion.csv"

    list_code, list_document, _ = _invoke(["artifact", "list", "job_cli"], transport)
    get_code, get_document, _ = _invoke(
        [
            "artifact",
            "get",
            "job_cli",
            _ARTIFACT_ID,
            "--verify",
            "--output",
            str(destination),
        ],
        transport,
    )

    assert list_code == get_code == EXIT_SUCCESS
    assert list_document["artifacts"][0]["artifact_id"] == _ARTIFACT_ID
    assert get_document == descriptor.model_dump(mode="json", exclude_none=True)
    assert "output" not in get_document
    assert "base64" not in json.dumps(get_document).casefold()
    assert destination.read_bytes() == b"csv"
    assert transport.requests[1][2] == {"verify": True}
    assert transport.downloads[0][0] == (
        "/jobs/job_cli/artifacts/artifact%3Aretargeted_motion%3Acli-test/content"
    )


def test_artifact_descriptor_identity_mismatch_fails_before_download() -> None:
    transport = FakeTransport([_descriptor(job_id="job_other")])

    code, document, _ = _invoke(["artifact", "get", "job_cli", _ARTIFACT_ID], transport)

    assert code == EXIT_INTERNAL_ERROR
    assert document["code"] == "REMOTE_PROTOCOL_ERROR"
    assert transport.downloads == []


def test_typer_adapter_passes_the_raw_tail_to_strict_json_runner(monkeypatch) -> None:
    transport = FakeTransport([_capabilities()])
    monkeypatch.setattr(
        agent_cli,
        "_default_transport_factory",
        lambda _base_url, _timeout: transport,
    )

    result = CliRunner().invoke(agent_cli.app, ["capabilities", "--json"])

    assert result.exit_code == EXIT_SUCCESS
    assert json.loads(result.stdout)["service_version"] == "test"
    assert result.stdout.count("\n") == 1


def test_typer_parameter_failure_is_one_api_error_without_rich_usage() -> None:
    result = CliRunner().invoke(agent_cli.app, ["job", "start", "--json"])

    assert result.exit_code == EXIT_PARAMETER_ERROR
    assert json.loads(result.stdout)["code"] == "INVALID_PARAMETER"
    assert result.stdout.count("\n") == 1
    assert result.stderr == ""


def test_installed_hhtools_agent_group_keeps_success_and_parse_errors_json(
    monkeypatch,
) -> None:
    # Importing the project root proves the public ``hhtools agent`` group is
    # installed, rather than only exercising this module's inner Typer object.
    from hhtools.cli.main import app as hhtools_app

    transport = FakeTransport([_capabilities()])
    monkeypatch.setattr(
        agent_cli,
        "_default_transport_factory",
        lambda _base_url, _timeout: transport,
    )
    runner = CliRunner()

    success = runner.invoke(hhtools_app, ["agent", "capabilities", "--json"])
    failure = runner.invoke(hhtools_app, ["agent", "job", "start", "--json"])

    assert success.exit_code == EXIT_SUCCESS
    assert json.loads(success.stdout)["service_version"] == "test"
    assert success.stdout.count("\n") == 1
    assert success.stderr == ""
    assert failure.exit_code == EXIT_PARAMETER_ERROR
    assert json.loads(failure.stdout)["code"] == "INVALID_PARAMETER"
    assert failure.stdout.count("\n") == 1
    assert failure.stderr == ""

    unknown = runner.invoke(hhtools_app, ["agent", "not-a-command"])
    assert unknown.exit_code == EXIT_PARAMETER_ERROR
    assert json.loads(unknown.stdout)["code"] == "INVALID_PARAMETER"
    assert unknown.stdout.count("\n") == 1
    assert unknown.stderr == ""


def test_installed_agent_accepts_connection_options_before_operation(monkeypatch) -> None:
    from hhtools.cli.main import app as hhtools_app

    def unavailable(*_args: Any, **_kwargs: Any) -> None:
        raise OSError("connection refused")

    monkeypatch.setattr(agent_transport, "urlopen", unavailable)
    result = CliRunner().invoke(
        hhtools_app,
        [
            "agent",
            "--base-url",
            "http://127.0.0.1:1/api/agent/v1",
            "--timeout",
            "0.1",
            "capabilities",
        ],
    )

    assert result.exit_code == EXIT_INTERNAL_ERROR
    assert json.loads(result.stdout)["code"] == "AGENT_SERVICE_UNAVAILABLE"
    assert result.stdout.count("\n") == 1
    assert result.stderr == ""


def test_legacy_upgrade_wraps_raw_v1_before_rest() -> None:
    preflight = PreflightResponse(
        request_id="req_legacy_cli",
        status="rejected",
        error=ApiError(
            code="CALIBRATION_REQUIRED",
            message="Calibration is required.",
            stage=ErrorStage.PREFLIGHT,
        ),
    )
    raw_v1 = {
        "schema_version": 1,
        "kind": "retarget",
        "request": {"source_path": "C:/allowed/walk.bvh", "robot": "g1_29dof"},
    }
    transport = FakeTransport(
        [{"schema_version": "1.0", "preflight": preflight.model_dump(mode="json")}]
    )

    code, document, _ = _invoke(
        ["legacy", "upgrade", "--request", "-"],
        transport,
        stdin=json.dumps(raw_v1),
    )

    assert code == EXIT_PREFLIGHT_ERROR
    assert document["preflight"]["status"] == "rejected"
    assert transport.requests[0] == (
        "POST",
        "/legacy/jobspec-v1/upgrade",
        {},
        {"schema_version": "1.0", "payload": raw_v1},
    )


class _ParityJobManager:
    def __init__(self) -> None:
        self.calls: list[tuple[Any, ...]] = []
        self.descriptor = _descriptor()

    def start_retarget(self, plan_id: str, *, idempotency_key: str) -> AgentJobView:
        self.calls.append(("start", plan_id, idempotency_key))
        return _job()

    def get_job(self, job_id: str, *, after_revision: int | None = None) -> AgentJobView:
        self.calls.append(("get", job_id, after_revision))
        return _job(job_id)

    def cancel_job(self, job_id: str) -> AgentJobView:
        self.calls.append(("cancel", job_id))
        return _job(job_id)

    def retry_job(self, job_id: str, *, idempotency_key: str) -> AgentJobView:
        self.calls.append(("retry", job_id, idempotency_key))
        return _job("job_retry")

    def list_artifacts(
        self, job_id: str, *, offset: int = 0, limit: int = 100
    ) -> list[ArtifactDescriptor]:
        self.calls.append(("list_artifacts", job_id, offset, limit))
        return [self.descriptor]

    def get_artifact(self, job_id: str, artifact_id: str, *, verify: bool = False) -> Any:
        self.calls.append(("get_artifact", job_id, artifact_id, verify))
        return SimpleNamespace(descriptor=self.descriptor)


class _TestClientTransport:
    """Adapter used only to exercise CLI -> real router -> fake service."""

    def __init__(self, client: TestClient) -> None:
        self.client = client

    def request_json(
        self,
        method: str,
        path: str,
        *,
        query: dict[str, Any] | None = None,
        document: dict[str, Any] | None = None,
    ) -> Any:
        response = self.client.request(
            method,
            f"/api/agent/v1{path}",
            params={key: value for key, value in (query or {}).items() if value is not None},
            json=document,
        )
        payload = response.json()
        if response.status_code >= 400:
            raise AgentTransportError(ApiError.model_validate(payload))
        return payload

    def download_artifact(self, *args: Any, **kwargs: Any) -> None:
        raise AssertionError("parity test does not download artifact bytes")


def test_cli_rest_service_parity_for_jobs_and_artifact_membership() -> None:
    manager = _ParityJobManager()
    app = FastAPI()
    app.state.agent_job_manager = manager
    app.include_router(agent_router)
    client = TestClient(app)
    transport = _TestClientTransport(client)

    start_args = [
        "job",
        "start",
        "--plan",
        _PLAN_ID,
        "--idempotency-key",
        "cli:parity-start",
    ]
    start_code, start_document, _ = _invoke(start_args, transport)
    direct_start = client.post(
        "/api/agent/v1/jobs",
        json={
            "schema_version": "1.0",
            "plan_id": _PLAN_ID,
            "idempotency_key": "cli:parity-start",
        },
    )
    assert start_code == EXIT_SUCCESS
    assert start_document == direct_start.json()
    assert manager.calls[:2] == [
        ("start", _PLAN_ID, "cli:parity-start"),
        ("start", _PLAN_ID, "cli:parity-start"),
    ]

    manager.calls.clear()
    get_code, get_document, _ = _invoke(
        ["job", "get", "job_cli", "--after-revision", "0"], transport
    )
    direct_get = client.get("/api/agent/v1/jobs/job_cli", params={"after_revision": 0})
    assert get_code == EXIT_SUCCESS
    assert get_document == direct_get.json()
    assert manager.calls == [("get", "job_cli", 0), ("get", "job_cli", 0)]

    manager.calls.clear()
    list_code, list_document, _ = _invoke(
        ["artifact", "list", "job_cli", "--limit", "25", "--offset", "0"],
        transport,
    )
    direct_list = client.get(
        "/api/agent/v1/jobs/job_cli/artifacts",
        params={"limit": 25, "offset": 0},
    )
    assert list_code == EXIT_SUCCESS
    assert list_document == direct_list.json()
    assert manager.calls == [
        ("list_artifacts", "job_cli", 0, 25),
        ("get", "job_cli", None),
        ("list_artifacts", "job_cli", 0, 25),
        ("get", "job_cli", None),
    ]

    manager.calls.clear()
    descriptor_code, descriptor_document, _ = _invoke(
        ["artifact", "get", "job_cli", _ARTIFACT_ID, "--verify"], transport
    )
    direct_descriptor = client.get(
        f"/api/agent/v1/jobs/job_cli/artifacts/{_ARTIFACT_ID}",
        params={"verify": True},
    )
    assert descriptor_code == EXIT_SUCCESS
    assert descriptor_document == direct_descriptor.json()
    assert manager.calls == [
        ("get_artifact", "job_cli", _ARTIFACT_ID, True),
        ("get_artifact", "job_cli", _ARTIFACT_ID, True),
    ]
