"""Read-only resource bindings shared by computation and rendering processes."""

from __future__ import annotations

from pathlib import Path

from hhtools.application.agent_services import assemble_agent_services
from hhtools.application.runtime import resolve_motion_library
from hhtools.application.state import SessionState
from hhtools.services.artifacts import ArtifactStore
from hhtools.services.job_store import JobStore
from hhtools.services.motion_cache import EphemeralCache
from hhtools.services.resource_reports import ResourceReports


def build_worker_services(paths, staging: Path):
    state = SessionState(
        source_root=paths.source_root,
        save_dir=paths.save_dir,
        upload_root=staging / "uploads",
        export_root=staging / "exports",
        **({"robot_root": paths.robot_root} if paths.robot_root else {}),
    )
    state.cache = EphemeralCache.create(cache_dir=staging / "cache", save_dir=staging)
    services = assemble_agent_services(
        state=state,
        scheduler=None,
        motion_library_root_provider=lambda: resolve_motion_library(paths),
        workspace_robot_root=paths.workspace_robot_root
        or Path(__file__).resolve().parents[2] / "configs/robots",
        agent_mcp_available=False,
        agent_rest_available=False,
        agent_json_cli_available=False,
        max_batch_items=0,
        max_batch_total_frames=0,
        additional_asset_roots=paths.asset_roots,
        execution_only=True,
        temporary_root=staging,
    )
    data_dir = paths.save_dir / ".hhtools-agent"
    services.resource_reports = ResourceReports(
        JobStore(data_dir, read_only=True), ArtifactStore(data_dir, read_only=True)
    )
    return state, services
