"""Stdio entry-point fixture that contends for the real runtime lease."""

from __future__ import annotations

import sys
from pathlib import Path
from types import ModuleType, SimpleNamespace
from typing import Any

from hhtools.mcp.server import main
from hhtools.services.runtime_lease import AgentRuntimeLease


def _create_app(**kwargs: Any) -> Any:
    # The parent test owns this exact directory.  Use the production lease
    # primitive at the same point where the real Web composition root does.
    contender = AgentRuntimeLease.acquire(Path(kwargs["save_dir"]) / ".hhtools-agent")
    contender.release()
    raise AssertionError("the lease contender unexpectedly acquired ownership")


def _effective_job_admission_settings(**_kwargs: Any) -> tuple[Any, None]:
    return SimpleNamespace(max_running_jobs=0, max_queued_jobs=0), None


if __name__ == "__main__":
    fake_web_server = ModuleType("hhtools.web.server")
    fake_web_server.create_app = _create_app  # type: ignore[attr-defined]
    fake_web_server.effective_job_admission_settings = (  # type: ignore[attr-defined]
        _effective_job_admission_settings
    )
    sys.modules["hhtools.web.server"] = fake_web_server
    main()
