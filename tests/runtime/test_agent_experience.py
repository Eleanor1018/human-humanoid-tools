"""Agent ergonomics regressions for files, errors, schemas, and MCP helpers."""

import asyncio
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
from fastapi.testclient import TestClient
from mcp import Client

from hhtools.application.runtime import ApplicationPaths
from hhtools.client.runtime import RuntimeClient, RuntimeClientError
from hhtools.contracts.runtime import RuntimeTokenRequest
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
    assert any(item["path"] == "asset_ids" for item in document["details"]["fields"])


def test_mcp_projects_output_schemas_and_local_upload_tool(tmp_path):
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
    source.write_bytes(b"agent-upload")
    try:
        deadline = time.monotonic() + 10
        while not server.started and time.monotonic() < deadline:
            time.sleep(0.05)
        client = RuntimeClient(origin, token=token.token)
        client.upload = lambda source, kind: {
            "asset_id": "asset:sha256:" + "a" * 64,
            "kind": kind,
            "display_name": source.name,
        }

        async def inspect():
            adapter = await create_client_server(client)
            async with Client(adapter, raise_exceptions=True) as mcp:
                tools = (await mcp.list_tools()).tools
                upload = next(tool for tool in tools if tool.name == "upload_local_file")
                assert upload.output_schema == {"type": "object"}
                operation = next(tool for tool in tools if tool.name == "hhtools_runtime_identity")
                assert operation.output_schema
                result = await mcp.call_tool(
                    "upload_local_file",
                    {"source_path": str(source), "kind": "video"},
                )
                assert not result.is_error
                assert result.structured_content["kind"] == "video"

        asyncio.run(inspect())
    finally:
        server.should_exit = True
        thread.join(15)
        listener.close()
        assert not thread.is_alive()
