"""Shared Runtime identity, credentials, recovery, and data channel contracts."""

from __future__ import annotations

import asyncio
import hashlib
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi.testclient import TestClient

from hhtools.application.runtime import ApplicationPaths
from hhtools.contracts.runtime import RuntimeTokenRequest
from hhtools.runtime.server import create_runtime_app
from hhtools.services.runtime_control import RuntimeControl

PREFIX = "/api/runtime/v1"


@pytest.fixture
def runtime_app(tmp_path):
    app = create_runtime_app(ApplicationPaths.isolated(tmp_path))
    with TestClient(app, base_url="http://127.0.0.1", client=("127.0.0.1", 5000)) as client:
        yield app, client


def test_identity_persists_but_generation_changes(tmp_path):
    first = RuntimeControl(tmp_path).identity
    second = RuntimeControl(tmp_path).identity
    assert first.runtime_id == second.runtime_id
    assert first.workspace_id == second.workspace_id
    assert first.generation != second.generation


def test_identity_mismatch_is_rejected(runtime_app):
    _, client = runtime_app
    response = client.get(PREFIX + "/jobs", headers={"X-HHTools-Runtime": "another-runtime"})
    assert response.status_code == 409
    assert response.json()["code"] == "RUNTIME_MISMATCH"


def test_scoped_credentials_cannot_fall_back_to_local_admin(runtime_app):
    app, client = runtime_app
    token = app.state.runtime_control.issue_token(
        RuntimeTokenRequest(subject="reader", scopes=["read"])
    )
    headers = {"Authorization": "Bearer " + token.token}
    assert client.get(PREFIX + "/jobs", headers=headers).status_code == 200
    assert (
        client.post(
            PREFIX + "/admin/tokens",
            json={"subject": "escape", "scopes": ["admin"]},
            headers=headers,
        ).status_code
        == 403
    )
    assert client.get("/api/config", headers=headers).status_code == 403
    assert (
        client.get(PREFIX + "/identity", headers={"Authorization": "Bearer invalid"}).status_code
        == 401
    )


def test_remote_requires_token_and_rejects_legacy_paths(runtime_app):
    app, _ = runtime_app
    token = app.state.runtime_control.issue_token(
        RuntimeTokenRequest(subject="remote", scopes=["read"])
    )
    client = TestClient(app, base_url="https://runtime.example", client=("192.0.2.1", 5000))
    assert client.get(PREFIX + "/identity").status_code == 401
    headers = {"Authorization": "Bearer " + token.token}
    assert client.get(PREFIX + "/identity", headers=headers).status_code == 200
    assert client.get("/api/agent/v1/capabilities", headers=headers).status_code == 200
    assert client.get("/api/config", headers=headers).status_code == 403


def test_duplicate_json_and_large_body_fail_before_dispatch(runtime_app):
    _, client = runtime_app
    response = client.put(
        PREFIX + "/admin/budget",
        content='{"max_running_jobs":1,"max_running_jobs":2}',
        headers={"Content-Type": "application/json"},
    )
    assert response.status_code == 400
    assert response.json()["code"] == "INVALID_JSON"
    assert client.put(PREFIX + "/admin/budget", content=b"x" * (1024**2 + 1)).status_code == 413


def test_catalog_has_resolvable_schemas_and_no_duplicate_operations(runtime_app):
    import jsonschema

    _, client = runtime_app
    catalog = client.get(PREFIX + "/operations").json()
    names = [operation["name"] for operation in catalog["operations"]]
    assert len(names) == len(set(names))
    assert {
        "hhtools_preflight_batch",
        "hhtools_runtime_events",
        "hhtools_runtime_start_job",
    } <= set(names)
    for operation in catalog["operations"]:
        jsonschema.Draft202012Validator.check_schema(operation["input_schema"])


def test_empty_history_and_cursor(runtime_app):
    _, client = runtime_app
    assert client.get(PREFIX + "/jobs").json()["jobs"] == []
    assert client.get(PREFIX + "/events").json()["cursor"] == 0
    assert client.get(PREFIX + "/events?after=99").status_code == 422


def test_token_storage_contains_only_digest(tmp_path):
    control = RuntimeControl(tmp_path)
    receipt = control.issue_token(RuntimeTokenRequest(subject="agent", scopes=["read", "write"]))
    assert receipt.token not in (tmp_path / "runtime-control.json").read_text()
    assert control.authenticate(receipt.token)["subject"] == "agent"
    control.revoke_token(receipt.token_id)
    assert control.authenticate(receipt.token) is None
    assert control.scoped_key("a", "submit", "key") != control.scoped_key("b", "submit", "key")


def test_multiple_clients_reuse_daemon_and_adapter_exit_does_not_stop_it(tmp_path):
    from hhtools.client.discovery import connect_or_start, discover

    clients = []
    try:
        with ThreadPoolExecutor(max_workers=2) as pool:
            clients = list(pool.map(lambda _: connect_or_start(tmp_path, timeout=30), range(2)))
        assert clients[0].runtime_id == clients[1].runtime_id
        assert discover(tmp_path).runtime_id == clients[0].runtime_id
        catalog = clients[0].operations()
        assert any(item["name"] == "hhtools_runtime_identity" for item in catalog)

        async def mcp_roundtrip():
            from mcp import Client

            from hhtools.mcp.client_server import create_client_server

            server = await create_client_server(clients[0])
            async with Client(server, raise_exceptions=True) as adapter:
                identity = await adapter.call_tool("hhtools_runtime_identity", {})
                assert identity.structured_content["runtime_id"] == clients[0].runtime_id
                capabilities = await adapter.call_tool("get_capabilities", {})
                assert capabilities.structured_content["schema_version"] == "1.0"
                invalid = await adapter.call_tool("hhtools_runtime_identity", {"unexpected": 1})
                assert invalid.is_error

        asyncio.run(mcp_roundtrip())
        assert discover(tmp_path).runtime_id == clients[0].runtime_id
    finally:
        client = discover(tmp_path)
        if client is not None:
            client.request("POST", PREFIX + "/admin/shutdown", document={"policy": "drain"})


def test_verified_artifact_supports_range(runtime_app, monkeypatch, tmp_path):
    from hhtools.contracts import ArtifactDescriptor
    from hhtools.services.artifacts import StoredArtifact

    app, client = runtime_app
    content = b"verified-runtime-output"
    path = tmp_path / "artifact.bin"
    path.write_bytes(content)
    descriptor = ArtifactDescriptor(
        artifact_id="artifact:output:test",
        job_id="job:test",
        kind="output",
        size_bytes=len(content),
        sha256=hashlib.sha256(content).hexdigest(),
        resource_uri="hhtools://jobs/job:test/artifacts/artifact:output:test",
    )
    stored = StoredArtifact(descriptor=descriptor, path=path)
    monkeypatch.setattr(app.state.agent_job_manager, "get_artifact", lambda *a, **kw: stored)
    response = client.get(
        PREFIX + "/jobs/job:test/artifacts/artifact:output:test/content",
        headers={"Range": "bytes=9-"},
    )
    assert response.status_code == 206
    assert response.content == content[9:]
    assert response.headers["etag"] == '"' + descriptor.sha256 + '"'


def test_drain_finishes_queued_work_and_rejects_new_admission():
    import threading

    from hhtools.services.job_scheduler import JobScheduler, JobSchedulerClosedError

    scheduler = JobScheduler(max_running_jobs=1, max_queued_jobs=2)
    gate = threading.Event()
    finished = []
    scheduler.submit(lambda: gate.wait(5))
    scheduler.submit(lambda: finished.append("queued"))
    scheduler.stop_accepting()
    with pytest.raises(JobSchedulerClosedError):
        scheduler.reserve()
    gate.set()
    assert scheduler.drain(timeout=5)
    assert finished == ["queued"]
