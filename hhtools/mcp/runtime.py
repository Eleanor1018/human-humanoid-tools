"""Lifecycle bridge from the local stdio host to HHTools application services.

The existing Web composition root owns the production loader/solver bindings.
Creating it without an HTTP listener gives MCP the exact same service and
executor instances while keeping every tool call transport-neutral.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from hhtools.services import (
    AgentAssetService,
    ArtifactExportService,
    CapabilitiesService,
    JobManager,
    PlanStore,
    PreflightService,
)


@dataclass(frozen=True)
class LocalRuntimeConfig:
    """Host-only configuration used to assemble one stdio-owned runtime."""

    source_root: Path = Path("assets/motions")
    save_dir: Path = Path("assets/save_npz")
    cache_dir: Path | None = None
    max_running_jobs: int | None = None
    max_queued_jobs: int | None = None
    job_settings_path: Path | None = None
    web_ui_url: str = "http://127.0.0.1:8009"


@dataclass(frozen=True)
class AgentRuntime:
    """Only the transport-neutral services exposed to MCP handlers."""

    capabilities: CapabilitiesService
    assets: AgentAssetService
    preflight: PreflightService
    plans: PlanStore
    jobs: JobManager
    exports: ArtifactExportService

    @classmethod
    def from_application(cls, app: Any) -> AgentRuntime:
        """Project the service surface from a fully assembled local app."""

        return cls(
            capabilities=app.state.agent_capabilities_service,
            assets=app.state.agent_asset_service,
            preflight=app.state.agent_preflight_service,
            plans=app.state.agent_plan_store,
            jobs=app.state.agent_job_manager,
            exports=app.state.agent_artifact_export_service,
        )


@asynccontextmanager
async def local_agent_runtime(
    config: LocalRuntimeConfig,
) -> AsyncIterator[AgentRuntime]:
    """Create one service owner and drain its scheduler when stdio closes."""

    # Warp prints its device banner to stdout on first initialization.  stdout
    # is the MCP JSON-RPC wire, so configure the library before importing the
    # Web composition root (and therefore before any lazy Newton import can
    # initialize Warp).  ``quiet`` is deliberately MCP-only: normal CLI/WebUI
    # processes keep Warp's useful startup diagnostics.
    from hhtools.retarget.newton_basic._warp_config import configure as configure_warp_cache

    configure_warp_cache(quiet=True)

    # Keep FastAPI and heavy Web/solver imports outside normal ``hhtools``
    # imports.  The MCP extra is useful only together with the local H2R stack.
    from hhtools.web.server import (
        create_app,
        effective_job_admission_settings,
    )

    settings, settings_path = effective_job_admission_settings(
        max_running_jobs=config.max_running_jobs,
        max_queued_jobs=config.max_queued_jobs,
        job_settings_path=config.job_settings_path,
    )
    app = create_app(
        source_root=config.source_root,
        save_dir=config.save_dir,
        cache_dir=config.cache_dir,
        max_running_jobs=settings.max_running_jobs,
        max_queued_jobs=settings.max_queued_jobs,
        job_settings_path=settings_path,
        agent_mcp_available=True,
        agent_rest_available=False,
        agent_json_cli_available=False,
    )
    async with app.router.lifespan_context(app):
        yield AgentRuntime.from_application(app)


__all__ = ["AgentRuntime", "LocalRuntimeConfig", "local_agent_runtime"]
