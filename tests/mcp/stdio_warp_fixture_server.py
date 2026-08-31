"""Stdio fixture that initializes real Warp through the MCP runtime path."""

from __future__ import annotations

import sys
from contextlib import asynccontextmanager
from types import ModuleType, SimpleNamespace
from typing import Any, cast

from hhtools.contracts import CapabilityResponse, SchedulerCapability, SchedulerMode
from hhtools.mcp.runtime import LocalRuntimeConfig, local_agent_runtime
from hhtools.mcp.server import create_mcp_server


class _Capabilities:
    def get_capabilities(self) -> CapabilityResponse:
        return CapabilityResponse(
            service_version="stdio-warp-test",
            scheduler=SchedulerCapability(
                max_running_jobs=0,
                max_queued_jobs=0,
                mode=SchedulerMode.UNLIMITED,
            ),
            supported_input_formats=["bvh"],
            supported_output_formats=["csv"],
            features={"agent_rest": False, "json_cli": False, "mcp": True},
        )


_UNUSED = cast(Any, object())


@asynccontextmanager
async def _app_lifespan(_app: Any):
    yield


def _create_app(**_kwargs: Any) -> Any:
    # This is the first Warp initialization in this fresh subprocess.  The
    # production ``local_agent_runtime`` must have selected quiet mode before
    # reaching the Web composition root, or its banner corrupts stdout.
    import warp as wp

    wp.init()
    state = SimpleNamespace(
        agent_capabilities_service=_Capabilities(),
        agent_asset_service=_UNUSED,
        agent_preflight_service=_UNUSED,
        agent_plan_store=_UNUSED,
        agent_job_manager=_UNUSED,
        agent_artifact_export_service=_UNUSED,
    )
    return SimpleNamespace(
        state=state,
        router=SimpleNamespace(lifespan_context=_app_lifespan),
    )


def _effective_job_admission_settings(**_kwargs: Any) -> tuple[Any, None]:
    return SimpleNamespace(max_running_jobs=0, max_queued_jobs=0), None


if __name__ == "__main__":
    # Substitute only the expensive Web composition root.  Keeping the real
    # local_agent_runtime exercises the production Warp-before-Web ordering.
    fake_web_server = ModuleType("hhtools.web.server")
    fake_web_server.create_app = _create_app  # type: ignore[attr-defined]
    fake_web_server.effective_job_admission_settings = (  # type: ignore[attr-defined]
        _effective_job_admission_settings
    )
    sys.modules["hhtools.web.server"] = fake_web_server

    config = LocalRuntimeConfig()
    create_mcp_server(config, runtime_factory=lambda: local_agent_runtime(config)).run("stdio")
