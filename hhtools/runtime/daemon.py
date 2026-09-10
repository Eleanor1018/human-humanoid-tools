"""Foreground daemon entry point suitable for detached clients and service managers."""

from __future__ import annotations

import argparse
import os
import socket
from pathlib import Path

from hhtools.application.runtime import ApplicationPaths
from hhtools.services.runtime_control import atomic_private_json
from hhtools.services.runtime_lease import RuntimeLeaseError

from .server import create_runtime_app


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workspace", type=Path, required=True)
    parser.add_argument("--source", type=Path)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--remote", action="store_true")
    parser.add_argument("--ssl-certfile")
    parser.add_argument("--ssl-keyfile")
    arguments = parser.parse_args(argv)
    if arguments.remote and not (arguments.ssl_certfile and arguments.ssl_keyfile):
        parser.error("Remote mode requires --ssl-certfile and --ssl-keyfile.")
    if not arguments.remote and arguments.host not in {"127.0.0.1", "::1"}:
        parser.error("Non-loopback binding requires --remote and TLS.")
    workspace = arguments.workspace.resolve()
    source = (arguments.source or workspace / "source").resolve()
    source.mkdir(parents=True, exist_ok=True)
    paths = ApplicationPaths(
        source_root=source,
        save_dir=workspace,
        cache_dir=workspace / "cache",
        robot_root=workspace / "robots",
        motion_library_root=workspace / "motion-library",
        motion_library_settings_path=workspace / "settings/motion-library.json",
        job_history_dir=workspace / "history",
        job_settings_path=workspace / "settings/jobs.json",
    )
    import uvicorn

    server = None

    def shutdown():
        if server is not None:
            server.should_exit = True

    try:
        app = create_runtime_app(paths, remote=arguments.remote, shutdown=shutdown)
    except RuntimeLeaseError as error:
        print(error.code, file=__import__("sys").stderr)
        return 3
    sock = socket.socket(socket.AF_INET6 if ":" in arguments.host else socket.AF_INET)
    connection_path = workspace / ".hhtools-agent/runtime-connection.json"
    try:
        sock.bind((arguments.host, arguments.port))
        sock.listen(128)
        identity = app.state.runtime_control.identity
        hostname = f"[{arguments.host}]" if ":" in arguments.host else arguments.host
        endpoint = f"{'https' if arguments.remote else 'http'}://{hostname}:{sock.getsockname()[1]}"
        if not arguments.remote:
            atomic_private_json(
                connection_path,
                {
                    "endpoint": endpoint,
                    "runtime_id": identity.runtime_id,
                    "workspace_id": identity.workspace_id,
                    "generation": identity.generation,
                    "pid": os.getpid(),
                },
            )
        config = uvicorn.Config(
            app,
            host=arguments.host,
            port=sock.getsockname()[1],
            log_level="warning",
            access_log=False,
            proxy_headers=False,
            ssl_certfile=arguments.ssl_certfile,
            ssl_keyfile=arguments.ssl_keyfile,
        )
        server = uvicorn.Server(config)
        server.run(sockets=[sock])
    finally:
        connection_path.unlink(missing_ok=True)
        sock.close()
        runtime = app.state.application_runtime
        runtime.scheduler.shutdown(wait=True)
        runtime.lifecycle._cleanup_once()
        runtime.lifecycle.agent_lease.release()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
