"""Connect or start a persistent local Runtime without taking task ownership."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path

from .runtime import RuntimeClient, RuntimeClientError, client_error


def discover(workspace: Path) -> RuntimeClient | None:
    path = Path(workspace).resolve() / ".hhtools-agent" / "runtime-connection.json"
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
        client = RuntimeClient(
            document["endpoint"],
            runtime_id=document["runtime_id"],
            workspace_id=document["workspace_id"],
            timeout=2,
        )
        client.connect()
        client.timeout = 35
        return client
    except (OSError, ValueError, KeyError, RuntimeClientError):
        return None


def connect_or_start(
    workspace: Path, *, source: Path | None = None, timeout: float = 45, port: int = 0
) -> RuntimeClient:
    """Competing launches are resolved by the existing workspace ownership lease."""
    workspace = Path(workspace).resolve()
    client = discover(workspace)
    if client is not None:
        return client
    directory = workspace / ".hhtools-agent"
    directory.mkdir(parents=True, exist_ok=True)
    command = [sys.executable, "-m", "hhtools.runtime.daemon", "--workspace", str(workspace)]
    if port:
        command.extend(["--port", str(port)])
    if source is not None:
        command.extend(["--source", str(Path(source).resolve())])
    options = (
        {"start_new_session": True}
        if os.name != "nt"
        else {
            "creationflags": subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP,
        }
    )
    with (directory / "runtime.log").open("ab") as log:
        process = subprocess.Popen(
            command, stdin=subprocess.DEVNULL, stdout=log, stderr=log, close_fds=True, **options
        )
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        client = discover(workspace)
        if client is not None:
            return client
        # A competing daemon may win the lease while this child exits.
        if process.poll() not in {None, 3}:
            break
        time.sleep(0.1)
    raise client_error(
        "RUNTIME_START_FAILED",
        "Runtime did not become ready; inspect its local log.",
        retryable=True,
    )
