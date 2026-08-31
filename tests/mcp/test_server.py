"""MCP v2 contract, service-parity, and real stdio integration tests."""

from __future__ import annotations

import json
import sys
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace
from typing import Any, cast

import anyio
import pytest
from mcp import Client, StdioServerParameters

from hhtools.contracts import (
    AgentJobView,
    ApiError,
    ArtifactDescriptor,
    CapabilityResponse,
    ErrorStage,
    JobProgress,
    NextAction,
    PreflightResponse,
    SchedulerCapability,
)
from hhtools.mcp.runtime import AgentRuntime
from hhtools.mcp.server import create_mcp_server
from hhtools.services.jobs import JobManagerError

_DIGEST = "a" * 64
_ASSET_ID = f"asset:sha256:{_DIGEST}"
_PLAN_ID = f"plan:sha256:{_DIGEST}"
_JOB_ID = "job-mcp-test"
_ARTIFACT_ID = "artifact:retargeted_motion:mcp-test"
_NOW = datetime(2026, 8, 31, tzinfo=UTC)

_EXPECTED_TOOLS = {
    "get_capabilities",
    "register_asset_bundle",
    "search_assets",
    "inspect_asset_bundle",
    "list_robots",
    "preflight_retarget",
    "start_retarget",
    "get_job",
    "cancel_job",
    "retry_job",
    "list_job_artifacts",
}
_EXPECTED_RESOURCES = {"hhtools://capabilities"}
_EXPECTED_RESOURCE_TEMPLATES = {
    "hhtools://schemas/agent/v1/{schema_name}",
    "hhtools://robots/{robot_id}",
    "hhtools://assets/{asset_id}/manifest",
    "hhtools://plans/{plan_id}",
    "hhtools://jobs/{job_id}/status",
    "hhtools://jobs/{job_id}/manifest",
    "hhtools://jobs/{job_id}/evaluation",
    "hhtools://jobs/{job_id}/failures",
    "hhtools://jobs/{job_id}/artifacts/{artifact_id}",
}


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


def _capabilities() -> CapabilityResponse:
    return CapabilityResponse(
        service_version="mcp-test",
        scheduler=SchedulerCapability(
            max_running_jobs=0,
            max_queued_jobs=0,
            mode="unlimited",
        ),
        asset_root_ids=["source", "motion-library", "robot-library"],
        supported_input_formats=["bvh", "npz"],
        supported_output_formats=["csv"],
        features={"agent_rest": False, "json_cli": False, "mcp": True},
    )


def _job() -> AgentJobView:
    return AgentJobView(
        job_id=_JOB_ID,
        state="queued",
        progress=JobProgress(
            phase="queued",
            fraction=0.0,
            revision=7,
            message="No change since revision 7.",
        ),
        artifact_count=1,
        cancellable=True,
        submitted_at=_NOW,
        poll_after_ms=750,
    )


def _artifact() -> ArtifactDescriptor:
    return ArtifactDescriptor(
        artifact_id=_ARTIFACT_ID,
        job_id=_JOB_ID,
        kind="retargeted_motion",
        format="csv",
        resource_uri=f"hhtools://jobs/{_JOB_ID}/artifacts/{_ARTIFACT_ID}",
        media_type="text/csv",
        size_bytes=3,
        sha256=_DIGEST,
    )


class _CapabilitiesService:
    def __init__(self) -> None:
        self.calls = 0

    def get_capabilities(self) -> CapabilityResponse:
        self.calls += 1
        return _capabilities()


class _AssetsService:
    def register(self, _request: Any) -> Any:
        raise AssertionError("asset mutation is outside this focused fixture")

    def search(self, **_kwargs: Any) -> Any:
        raise AssertionError("asset search is outside this focused fixture")

    def inspect(self, _request: Any) -> Any:
        raise AssertionError("asset inspection is outside this focused fixture")

    def get(self, _asset_id: str) -> Any:
        raise AssertionError("asset resource is outside this focused fixture")


class _PreflightService:
    def __init__(self) -> None:
        self.calls: list[Any] = []

    def preflight_retarget(self, request: Any) -> PreflightResponse:
        self.calls.append(request)
        return PreflightResponse(
            request_id="request-mcp-human-action",
            status="human_action_required",
            required_actions=[
                NextAction(
                    actor="human",
                    action="open_calibration_ui",
                    message="Create and review the robot calibration before retrying.",
                    url="http://127.0.0.1:8009/?view=calibration",
                    parameters={"robot_id": request.robot_id},
                )
            ],
        )


class _Plans:
    def get(self, _plan_id: str) -> Any:
        raise AssertionError("plan resource is outside this focused fixture")


class _Jobs:
    def __init__(self) -> None:
        self.start_calls: list[tuple[str, str]] = []
        self.get_calls: list[tuple[str, int | None]] = []
        self.list_calls: list[tuple[str, int, int]] = []
        self.artifact_calls: list[tuple[str, str, bool]] = []

    def start_retarget(self, plan_id: str, *, idempotency_key: str) -> AgentJobView:
        self.start_calls.append((plan_id, idempotency_key))
        return _job()

    def get_job(
        self,
        job_id: str,
        *,
        after_revision: int | None = None,
    ) -> AgentJobView:
        self.get_calls.append((job_id, after_revision))
        if job_id != _JOB_ID:
            raise JobManagerError(
                ApiError(
                    code="JOB_NOT_FOUND",
                    message="No canonical job has the requested id.",
                    stage=ErrorStage.ARTIFACT,
                )
            )
        return _job()

    def cancel_job(self, job_id: str) -> AgentJobView:
        return self.get_job(job_id)

    def retry_job(self, job_id: str, *, idempotency_key: str) -> AgentJobView:
        del idempotency_key
        return self.get_job(job_id)

    def list_artifacts(
        self,
        job_id: str,
        *,
        offset: int = 0,
        limit: int = 100,
    ) -> list[ArtifactDescriptor]:
        self.list_calls.append((job_id, offset, limit))
        if job_id != _JOB_ID:
            raise JobManagerError(
                ApiError(
                    code="JOB_NOT_FOUND",
                    message="No canonical job has the requested id.",
                    stage=ErrorStage.ARTIFACT,
                )
            )
        return [_artifact()][offset : offset + limit]

    def get_artifact(
        self,
        job_id: str,
        artifact_id: str,
        *,
        verify: bool = False,
    ) -> Any:
        self.artifact_calls.append((job_id, artifact_id, verify))
        if job_id != _JOB_ID or artifact_id != _ARTIFACT_ID:
            raise JobManagerError(
                ApiError(
                    code="ARTIFACT_NOT_FOUND",
                    message="The artifact is not canonically attached to this job.",
                    stage=ErrorStage.ARTIFACT,
                    details={"job_id": job_id},
                )
            )
        return SimpleNamespace(descriptor=_artifact())


class _Fixture:
    def __init__(self) -> None:
        self.capabilities = _CapabilitiesService()
        self.assets = _AssetsService()
        self.preflight = _PreflightService()
        self.plans = _Plans()
        self.jobs = _Jobs()
        self.runtime = AgentRuntime(
            capabilities=cast(Any, self.capabilities),
            assets=cast(Any, self.assets),
            preflight=cast(Any, self.preflight),
            plans=cast(Any, self.plans),
            jobs=cast(Any, self.jobs),
        )

    def server(self):
        @asynccontextmanager
        async def runtime_factory() -> AsyncIterator[AgentRuntime]:
            yield self.runtime

        return create_mcp_server(runtime_factory=runtime_factory)


def _tool_by_name(tools: list[Any], name: str) -> Any:
    return next(tool for tool in tools if tool.name == name)


@pytest.mark.anyio
async def test_mcp_enumerates_only_bounded_tools_and_resources() -> None:
    fixture = _Fixture()

    async with Client(fixture.server(), raise_exceptions=True) as client:
        tools = (await client.list_tools()).tools
        resources = await client.list_resources()
        templates = await client.list_resource_templates()

    assert {tool.name for tool in tools} == _EXPECTED_TOOLS
    assert {str(resource.uri) for resource in resources.resources} == _EXPECTED_RESOURCES
    assert {
        str(template.uri_template) for template in templates.resource_templates
    } == _EXPECTED_RESOURCE_TEMPLATES

    serialized = json.dumps(
        [tool.model_dump(mode="json", by_alias=True, exclude_none=True) for tool in tools]
    ).casefold()
    for forbidden in (
        "base64",
        "shell",
        "run_command",
        "source_path",
        "output_path",
        "absolute_path",
        '"argv"',
        '"command"',
    ):
        assert forbidden not in serialized


@pytest.mark.anyio
async def test_mcp_tool_schemas_are_generated_from_public_pydantic_contracts() -> None:
    fixture = _Fixture()

    async with Client(fixture.server(), raise_exceptions=True) as client:
        tools = (await client.list_tools()).tools

    register = _tool_by_name(tools, "register_asset_bundle")
    registration = register.input_schema["$defs"]["AssetRegistrationRequest"]
    assert register.input_schema["required"] == ["request"]
    assert set(registration["properties"]) == {
        "schema_version",
        "root_id",
        "relative_path",
        "display_name",
        "kind",
        "category",
        "recursive",
    }
    assert registration["additionalProperties"] is False

    start = _tool_by_name(tools, "start_retarget")
    start_request = start.input_schema["$defs"]["JobStartRequest"]
    assert set(start_request["properties"]) == {
        "schema_version",
        "plan_id",
        "idempotency_key",
    }
    assert "run_mode" not in json.dumps(start.input_schema)

    capabilities = _tool_by_name(tools, "get_capabilities")
    assert capabilities.output_schema["title"] == "CapabilityResponse"
    assert "features" in capabilities.output_schema["properties"]


@pytest.mark.anyio
async def test_capabilities_report_mcp_true_for_tool_and_resource() -> None:
    fixture = _Fixture()

    async with Client(fixture.server(), raise_exceptions=True) as client:
        tool_result = await client.call_tool("get_capabilities", {})
        resource_result = await client.read_resource("hhtools://capabilities")

    assert tool_result.is_error is False
    assert tool_result.structured_content["features"] == {
        "agent_rest": False,
        "json_cli": False,
        "mcp": True,
    }
    resource_document = json.loads(resource_result.contents[0].text)
    assert resource_document["features"] == {
        "agent_rest": False,
        "json_cli": False,
        "mcp": True,
    }
    assert fixture.capabilities.calls == 2


@pytest.mark.anyio
async def test_human_action_preflight_never_starts_a_job() -> None:
    fixture = _Fixture()
    request = {
        "schema_version": "1.0",
        "motion_asset_id": _ASSET_ID,
        "robot_id": "g1_29dof",
        "robot_asset_id": _ASSET_ID,
        "parameters": {"run_mode": "smoke"},
    }

    async with Client(fixture.server(), raise_exceptions=True) as client:
        result = await client.call_tool("preflight_retarget", {"request": request})

    assert result.is_error is False
    assert result.structured_content["status"] == "human_action_required"
    action = result.structured_content["required_actions"][0]
    assert action["actor"] == "human"
    assert action["action"] == "open_calibration_ui"
    assert action["url"].startswith("http://127.0.0.1:8009/")
    assert len(fixture.preflight.calls) == 1
    assert fixture.jobs.start_calls == []


@pytest.mark.anyio
async def test_revision_polling_forwards_after_revision_and_stays_compact() -> None:
    fixture = _Fixture()

    async with Client(fixture.server(), raise_exceptions=True) as client:
        result = await client.call_tool(
            "get_job",
            {"job_id": _JOB_ID, "after_revision": 7},
        )

    assert result.is_error is False
    assert result.structured_content["progress"]["revision"] == 7
    assert result.structured_content["poll_after_ms"] == 750
    assert fixture.jobs.get_calls == [(_JOB_ID, 7)]
    serialized = json.dumps(result.structured_content).casefold()
    assert "trajectory" not in serialized
    assert "base64" not in serialized


@pytest.mark.anyio
async def test_artifacts_remain_job_scoped_and_errors_are_structured() -> None:
    fixture = _Fixture()

    async with Client(fixture.server(), raise_exceptions=True) as client:
        page = await client.call_tool(
            "list_job_artifacts",
            {"job_id": _JOB_ID, "limit": 25, "offset": 0},
        )
        resource = await client.read_resource(f"hhtools://jobs/{_JOB_ID}/artifacts/{_ARTIFACT_ID}")
        denied = await client.call_tool(
            "list_job_artifacts",
            {"job_id": "job-other", "limit": 25, "offset": 0},
        )

    assert page.is_error is False
    assert page.structured_content["job_id"] == _JOB_ID
    assert page.structured_content["artifacts"][0]["artifact_id"] == _ARTIFACT_ID
    assert fixture.jobs.list_calls == [
        (_JOB_ID, 0, 25),
        ("job-other", 0, 25),
    ]

    resource_document = json.loads(resource.contents[0].text)
    assert resource_document["job_id"] == _JOB_ID
    assert resource_document["artifact_id"] == _ARTIFACT_ID
    assert fixture.jobs.artifact_calls == [(_JOB_ID, _ARTIFACT_ID, True)]
    assert "base64" not in json.dumps(resource_document).casefold()
    assert "path" not in resource_document

    assert denied.is_error is True
    assert denied.structured_content["schema_version"] == "1.0"
    assert denied.structured_content["code"] == "JOB_NOT_FOUND"
    assert denied.structured_content["stage"] == "artifact"
    assert json.loads(denied.content[0].text) == denied.structured_content


@pytest.mark.anyio
async def test_real_stdio_subprocess_preserves_framing() -> None:
    fixture_server = Path(__file__).with_name("stdio_fixture_server.py")
    parameters = StdioServerParameters(
        command=sys.executable,
        args=[str(fixture_server)],
        cwd=Path(__file__).parents[2],
        encoding="utf-8",
        encoding_error_handler="strict",
    )

    with anyio.fail_after(20):
        async with Client(parameters, read_timeout_seconds=10) as client:
            tools = await client.list_tools()
            result = await client.call_tool("get_capabilities", {})
            protocol_version = client.protocol_version

    # A successful discovery and tool round-trip over the child process proves
    # stdout contained only valid MCP frames; any prose or traceback corrupts
    # negotiation before these assertions are reachable.
    assert protocol_version == "2026-07-28"
    assert {tool.name for tool in tools.tools} == _EXPECTED_TOOLS
    assert result.is_error is False
    assert result.structured_content["service_version"] == "stdio-test"
    assert result.structured_content["features"]["mcp"] is True
