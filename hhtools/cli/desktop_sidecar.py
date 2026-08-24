"""Secured FastAPI sidecar entry point for the Electron desktop shell."""

from __future__ import annotations

import argparse
import os
from pathlib import Path


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run the hhtools Electron sidecar")
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--save-dir", type=Path, required=True)
    parser.add_argument("--cache", type=Path, required=True)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--session-secret")
    return parser


def main(argv: list[str] | None = None) -> None:
    parser = _parser()
    args = parser.parse_args(argv)
    args.source.mkdir(parents=True, exist_ok=True)
    args.save_dir.mkdir(parents=True, exist_ok=True)
    args.cache.mkdir(parents=True, exist_ok=True)
    # Electron normally uses the environment so the secret is not exposed in process listings.
    session_secret = args.session_secret or os.environ.get("HHTOOLS_DESKTOP_SESSION_SECRET")
    if not session_secret:
        parser.error(
            "a session secret is required via --session-secret or HHTOOLS_DESKTOP_SESSION_SECRET"
        )

    # Delay the heavier web imports until arguments and writable directories are valid.
    from hhtools.web.server import run_desktop_sidecar

    run_desktop_sidecar(
        source_root=args.source,
        save_dir=args.save_dir,
        cache_dir=args.cache,
        host=args.host,
        port=args.port,
        session_secret=session_secret,
    )


if __name__ == "__main__":
    main()


__all__ = ["main"]
