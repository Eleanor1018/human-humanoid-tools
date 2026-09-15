"""Machine-readable resident Runtime management and operation calls."""

from __future__ import annotations

import json
import os
from pathlib import Path

import typer

app = typer.Typer(help=__doc__, pretty_exceptions_show_locals=False)


def _print(value):
    typer.echo(json.dumps(value, ensure_ascii=False, allow_nan=False))


@app.command()
def start(workspace: Path = typer.Option(Path("assets/save_npz")), source: Path | None = None):
    """Start or reuse a local daemon; it survives this command and all viewers."""
    from hhtools.client.discovery import connect_or_start

    client = connect_or_start(workspace, source=source)
    _print({"endpoint": client.endpoint, **client.connect()})


@app.command()
def serve(
    workspace: Path = typer.Option(Path("assets/save_npz")),
    source: Path | None = None,
    host: str = "127.0.0.1",
    port: int = 8009,
    remote: bool = False,
    ssl_certfile: str | None = None,
    ssl_keyfile: str | None = None,
):
    """Run in the foreground for systemd, containers, or Windows service supervision."""
    from hhtools.runtime.daemon import main

    arguments = ["--workspace", str(workspace), "--host", host, "--port", str(port)]
    if source:
        arguments.extend(["--source", str(source)])
    if remote:
        arguments.append("--remote")
    if ssl_certfile:
        arguments.extend(["--ssl-certfile", ssl_certfile])
    if ssl_keyfile:
        arguments.extend(["--ssl-keyfile", ssl_keyfile])
    raise typer.Exit(main(arguments))


@app.command()
def call(
    operation: str,
    request: Path | None = typer.Option(None, "--request"),
    endpoint: str | None = None,
    workspace: Path = typer.Option(Path("assets/save_npz")),
    token_env: str = "HHTOOLS_RUNTIME_TOKEN",
):
    """Call a discoverable operation using JSON, without interactive prompts."""
    from hhtools.client import RuntimeClient, RuntimeClientError
    from hhtools.client.discovery import connect_or_start

    try:
        client = (
            RuntimeClient(endpoint, token=os.environ.get(token_env))
            if endpoint
            else connect_or_start(workspace)
        )
        arguments = json.loads(request.read_text(encoding="utf-8")) if request else {}
        _print(client.call(operation, arguments))
    except RuntimeClientError as error:
        _print(error.api_error.model_dump(mode="json"))
        raise typer.Exit(1) from None


@app.command()
def status(workspace: Path = typer.Option(Path("assets/save_npz"))):
    """Discover a local service without starting or stopping it."""
    from hhtools.client.discovery import discover

    client = discover(workspace)
    _print(
        {
            "running": client is not None,
            **({"endpoint": client.endpoint, **client.connect()} if client else {}),
        }
    )


@app.command()
def stop(workspace: Path = typer.Option(Path("assets/save_npz")), cancel: bool = False):
    """Explicitly drain or cancel jobs, then stop the resident local service."""
    from hhtools.client.discovery import discover

    client = discover(workspace)
    if client is None:
        _print({"running": False})
        return
    _print(
        client.call(
            "hhtools_runtime_shutdown", {"request": {"policy": "cancel" if cancel else "drain"}}
        )
    )


@app.command()
def upload(
    source: Path,
    kind: str = "motion_bundle",
    endpoint: str | None = None,
    workspace: Path = typer.Option(Path("assets/save_npz")),
    upload_id: str | None = None,
    token_env: str = "HHTOOLS_RUNTIME_TOKEN",
):
    """Upload a local file or bundle, with an optional prior session ID for resumption."""
    from hhtools.client import RuntimeClient, RuntimeClientError
    from hhtools.client.discovery import connect_or_start

    try:
        client = (
            RuntimeClient(endpoint, token=os.environ.get(token_env))
            if endpoint
            else connect_or_start(workspace)
        )
        _print(client.upload(source, kind=kind, upload_id=upload_id))
    except RuntimeClientError as error:
        _print(error.api_error.model_dump(mode="json"))
        raise typer.Exit(1) from None


@app.command()
def download(
    job_id: str,
    artifact_id: str,
    output: Path = typer.Option(..., "--output"),
    endpoint: str | None = None,
    workspace: Path = typer.Option(Path("assets/save_npz")),
    token_env: str = "HHTOOLS_RUNTIME_TOKEN",
    overwrite: bool = typer.Option(False, "--overwrite", help="Replace an existing output file."),
):
    """Resume a download and publish the local file only after integrity verification."""
    from hhtools.client import RuntimeClient, RuntimeClientError
    from hhtools.client.discovery import connect_or_start

    try:
        client = (
            RuntimeClient(endpoint, token=os.environ.get(token_env))
            if endpoint
            else connect_or_start(workspace)
        )
        _print(client.download(job_id, artifact_id, output, overwrite=overwrite))
    except RuntimeClientError as error:
        _print(error.api_error.model_dump(mode="json"))
        raise typer.Exit(1) from None
