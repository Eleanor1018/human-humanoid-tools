"""Agent ergonomics regressions for files, errors, schemas, and MCP helpers."""

import asyncio
import hashlib
import io
import json
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import jsonschema
import pytest
from fastapi.testclient import TestClient
from mcp import Client

from hhtools.application.runtime import ApplicationPaths
from hhtools.client.runtime import RuntimeClient, RuntimeClientError
from hhtools.contracts.runtime import RuntimeTokenRequest
from hhtools.contracts.workflows import WorkflowPreflightRequest
from hhtools.mcp.client_server import create_client_server
from hhtools.runtime.server import create_runtime_app


def test_runtime_download_refuses_existing_output(tmp_path):
    client = RuntimeClient("http://127.0.0.1")
    client.runtime_id = "runtime:test"
    client.workspace_id = "workspace:test"
    destination = tmp_path / "result.bin"
    destination.write_bytes(b"keep this")
    client.request = lambda *args, **kwargs: {
        "size_bytes": 1,
        "sha256": "2bb80d537b1da3e38bd30361aa855686bde0ba4e" + "0" * 24,
    }
    with pytest.raises(RuntimeClientError) as error:
        client.download("job:test", "artifact:test", destination)
    assert error.value.api_error.code == "OUTPUT_EXISTS"
    assert destination.read_bytes() == b"keep this"


def test_runtime_response_body_timeout_is_structured(tmp_path):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", "100")
            self.end_headers()
            self.wfile.write(b"{")
            self.wfile.flush()
            time.sleep(0.3)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        client = RuntimeClient(f"http://127.0.0.1:{server.server_port}", timeout=0.05)
        with pytest.raises(RuntimeClientError) as error:
            client.request("GET", "/api/runtime/v1/identity")
        assert error.value.api_error.code == "RUNTIME_UNAVAILABLE"
        assert error.value.api_error.retryable
    finally:
        server.shutdown()
        server.server_close()
        thread.join(2)


def test_runtime_validation_returns_field_paths(tmp_path):
    app = create_runtime_app(ApplicationPaths.isolated(tmp_path))
    with TestClient(app, base_url="http://127.0.0.1", client=("127.0.0.1", 1234)) as client:
        response = client.post(
            "/api/runtime/v1/workflows/preflight",
            json={"workflow": "video_to_motion", "asset_ids": []},
        )
    assert response.status_code == 422
    document = response.json()
    assert document["code"] == "INVALID_PARAMETER"
    assert document["details"]["fields"]
    assert any(item["path"] == ["asset_ids"] for item in document["details"]["fields"])


def test_mcp_projects_output_schemas_and_local_upload_tool(tmp_path, synthetic_terrain_motion):
    import numpy as np

    from hhtools.io.npz import save_npz

    app = create_runtime_app(ApplicationPaths.isolated(tmp_path / "runtime"))
    control = app.state.runtime_control
    token = control.issue_token(RuntimeTokenRequest(subject="agent", scopes=["read", "write"]))
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    origin = f"http://127.0.0.1:{listener.getsockname()[1]}"
    import uvicorn

    server = uvicorn.Server(uvicorn.Config(app, log_level="critical"))
    thread = threading.Thread(target=lambda: server.run(sockets=[listener]), daemon=True)
    thread.start()
    source = tmp_path / "motion.npz"
    motion = synthetic_terrain_motion
    motion.terrain = None
    motion.meta = {}
    motion.positions = np.repeat(motion.positions, 30, axis=0)
    motion.quaternions = np.repeat(motion.quaternions, 30, axis=0)
    save_npz(motion, source)
    try:
        deadline = time.monotonic() + 10
        while not server.started and time.monotonic() < deadline:
            time.sleep(0.05)
        client = RuntimeClient(origin, token=token.token)

        async def inspect():
            adapter = await create_client_server(client, transfer_roots=[tmp_path])
            async with Client(adapter, raise_exceptions=True) as mcp:
                tools = (await mcp.list_tools()).tools
                upload = next(tool for tool in tools if tool.name == "upload_local_file")
                assert upload.output_schema["properties"]["asset_id"]
                operation = next(tool for tool in tools if tool.name == "hhtools_runtime_identity")
                assert operation.output_schema
                result = await mcp.call_tool(
                    "upload_local_file",
                    {"source_path": str(source), "kind": "motion_bundle"},
                )
                assert not result.is_error, result.structured_content
                asset_id = result.structured_content["asset_id"]
                folder = tmp_path / "dataset"
                folder.mkdir()
                (folder / "motion.npz").write_bytes(source.read_bytes())
                bundle = await mcp.call_tool(
                    "upload_local_file",
                    {
                        "source_path": str(folder),
                        "kind": "dataset_bundle",
                    },
                )
                assert not bundle.is_error, bundle.structured_content
                plan = await mcp.call_tool(
                    "hhtools_workflow_preflight",
                    {
                        "request": {
                            "workflow": "analysis",
                            "asset_ids": [asset_id],
                            "parameters": {},
                        }
                    },
                )
                assert not plan.is_error, plan.structured_content
                job = (
                    await mcp.call_tool(
                        "start_job",
                        {
                            "request": {
                                "plan_id": plan.structured_content["plan_id"],
                                "idempotency_key": "mcp-analysis",
                            }
                        },
                    )
                ).structured_content
                while job["state"] in {"queued", "running"}:
                    job = (
                        await mcp.call_tool(
                            "wait_job",
                            {
                                "job_id": job["job_id"],
                                "after_revision": job["progress"]["revision"],
                                "timeout": 10,
                            },
                        )
                    ).structured_content
                assert job["state"] == "completed", job
                artifact = next(
                    item for item in job["artifacts"] if item["kind"] == "analysis_report"
                )
                args = {
                    "job_id": job["job_id"],
                    "artifact_id": artifact["artifact_id"],
                    "destination_path": str(tmp_path / "report.json"),
                }
                downloaded = await mcp.call_tool("download_artifact", args)
                assert not downloaded.is_error, downloaded.structured_content
                assert (
                    hashlib.sha256((tmp_path / "report.json").read_bytes()).hexdigest()
                    == artifact["sha256"]
                )
                refused = await mcp.call_tool("download_artifact", args)
                assert refused.structured_content["code"] == "OUTPUT_EXISTS"
                overwritten = await mcp.call_tool("download_artifact", {**args, "overwrite": True})
                assert not overwritten.is_error, overwritten.structured_content
                forbidden = await mcp.call_tool(
                    "download_artifact",
                    {**args, "destination_path": str(tmp_path.parent / "outside.json")},
                )
                assert forbidden.structured_content["code"] == "TRANSFER_PATH_FORBIDDEN"
                invalid = await mcp.call_tool(
                    "hhtools_workflow_preflight",
                    {
                        "request": {
                            "workflow": "analysis",
                            "asset_ids": [asset_id],
                            "parameters": {"embedding": "bad-secret-input"},
                        }
                    },
                )
                assert invalid.is_error
                assert invalid.structured_content["details"]["fields"]
                assert "bad-secret-input" not in json.dumps(invalid.structured_content)
                assert not any(tool.name == "hhtools_runtime_start_job" for tool in tools)
                workflows = await mcp.call_tool("hhtools_runtime_workflows", {})
                assert workflows.structured_content["workflows"][0]["parameters_schema"]
                print(
                    json.dumps(
                        {
                            "default_tools": len(tools),
                            "tools_without_output_schema": sum(
                                not tool.output_schema for tool in tools
                            ),
                        }
                    )
                )

        asyncio.run(inspect())
    finally:
        server.should_exit = True
        thread.join(15)
        listener.close()
        assert not thread.is_alive()


@pytest.mark.parametrize("workflow", ["analysis", "video_to_motion"])
def test_default_and_workflow_specific_parameter_schemas(workflow):
    from pydantic import ValidationError

    base = {"workflow": workflow, "asset_ids": ["asset:sha256:" + "a" * 64]}
    schema = WorkflowPreflightRequest.model_json_schema()
    for args in (base, {**base, "parameters": {}}):
        jsonschema.validate(args, schema)
        WorkflowPreflightRequest(**args)
    invalid = {
        **base,
        "parameters": {"static_camera": True} if workflow == "analysis" else {"embedding": "pae"},
    }
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate(invalid, schema)
    with pytest.raises(ValidationError):
        WorkflowPreflightRequest(**invalid)


def test_metric_schema_rejects_unknown_keys_and_matches_defaults():
    from hhtools.analysis.config import load_config
    from hhtools.contracts.workflows import AnalysisParameters

    schema = AnalysisParameters.model_json_schema()
    jsonschema.validate({"metric_config": load_config()}, schema)
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate({"metric_config": {"invented_metric": 1}}, schema)


def test_download_publication_does_not_replace_concurrent_output(tmp_path):
    from contextlib import contextmanager

    client = RuntimeClient("http://localhost", runtime_id="test", workspace_id="test")
    target = tmp_path / "result.bin"
    payload = b"verified artifact"
    client.request = lambda *args, **kwargs: {
        "size_bytes": len(payload),
        "sha256": hashlib.sha256(payload).hexdigest(),
    }

    @contextmanager
    def open_response(*args, **kwargs):
        response = io.BytesIO(payload)
        response.status = 200
        yield response
        target.write_bytes(b"other client output")

    client._open = open_response
    with pytest.raises(RuntimeClientError) as error:
        client.download("job:test", "artifact:test", target)
    assert error.value.api_error.code == "OUTPUT_EXISTS"
    assert target.read_bytes() == b"other client output"


def test_upload_acknowledgement_timeout_keeps_session_id(tmp_path):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_PUT(self):
            self.rfile.read(int(self.headers["Content-Length"]))
            self.send_response(200)
            self.send_header("Content-Length", "100")
            self.end_headers()
            self.wfile.write(b"{")
            self.wfile.flush()
            time.sleep(0.3)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    source = tmp_path / "video.mp4"
    source.write_bytes(b"abc")
    client = RuntimeClient(
        f"http://127.0.0.1:{server.server_port}", runtime_id="test", timeout=0.05
    )
    client.request = lambda *args, **kwargs: {
        "upload_id": "a" * 32,
        "chunk_bytes": 8,
        "state": "uploading",
        "files": [{"relative_path": source.name, "offset": 0, "size_bytes": 3}],
    }
    try:
        with pytest.raises(RuntimeClientError) as error:
            client.upload(source, kind="video")
        assert error.value.api_error.code == "RUNTIME_UNAVAILABLE"
        assert error.value.api_error.details["upload_id"] == "a" * 32
    finally:
        server.shutdown()
        server.server_close()
        thread.join(2)


def test_transfer_roots_reject_symlink_parents_and_support_local_directories(tmp_path):
    from hhtools.mcp.transfers import LocalTransfers

    root = tmp_path / "allowed"
    root.mkdir()
    outside = tmp_path / "private"
    outside.mkdir()
    (outside / "secret.mp4").write_bytes(b"private")
    (root / "alias").symlink_to(outside, target_is_directory=True)
    transfers = LocalTransfers(None, [root])
    assert transfers.path(str(root)) == root
    with pytest.raises(RuntimeClientError) as error:
        transfers.path(str(root / "alias" / "secret.mp4"))
    assert error.value.api_error.code == "TRANSFER_PATH_FORBIDDEN"


def test_download_resumes_matching_artifact_and_resets_different_identity(tmp_path):
    from contextlib import contextmanager

    client = RuntimeClient(
        "http://localhost", runtime_id="runtime:test", workspace_id="workspace:test"
    )
    payload = b"artifact bytes"
    descriptor = {"size_bytes": len(payload), "sha256": hashlib.sha256(payload).hexdigest()}
    client.request = lambda *args, **kwargs: descriptor
    target = tmp_path / "result.bin"
    partial = tmp_path / "result.bin.hhtools-part"
    identity = tmp_path / "result.bin.hhtools-part.json"
    binding = {
        **descriptor,
        "job_id": "job:test",
        "artifact_id": "artifact:test",
        "runtime_id": client.runtime_id,
        "workspace_id": client.workspace_id,
    }
    headers = []

    @contextmanager
    def open_response(*args, **kwargs):
        supplied = kwargs["headers"]
        headers.append(supplied)
        response = io.BytesIO(payload[4:] if "Range" in supplied else payload)
        response.status = 206 if "Range" in supplied else 200
        yield response

    client._open = open_response
    for same in (False, True):
        partial.write_bytes(payload[:4] if same else b"other")
        identity.write_text(json.dumps(binding if same else {**binding, "artifact_id": "other"}))
        client.download("job:test", "artifact:test", target)
        assert target.read_bytes() == payload
        assert ("Range" in headers[-1]) == same
        assert not partial.exists() and not identity.exists()
        target.unlink()
