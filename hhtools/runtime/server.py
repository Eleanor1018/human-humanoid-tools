"""Compose the resident control service and optional browser adapters."""

from __future__ import annotations

from pathlib import Path

from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.routing import Mount

from hhtools.application.runtime import ApplicationPaths, build_application_runtime
from hhtools.contracts import ApiError, ErrorStage
from hhtools.services.artifact_exports import ArtifactExportError
from hhtools.services.assets import AssetServiceError
from hhtools.services.job_store import JobStoreError
from hhtools.services.jobs import JobManagerError
from hhtools.services.plans import PlanStoreError
from hhtools.services.runtime_control import RuntimeControl, RuntimeServiceError
from hhtools.services.runtime_lease import AgentRuntimeLease
from hhtools.web.server.factory import _mount_web_app

from .api import register_runtime_routes
from .boundary import RuntimeBoundary


def create_runtime_app(
    paths: ApplicationPaths,
    *,
    remote: bool = False,
    allowed_origins: tuple[str, ...] = (),
    shutdown=None,
):
    """Own one workspace; legacy Web routes are available only to local administrators."""
    data_dir = Path(paths.save_dir) / ".hhtools-agent"
    lease = AgentRuntimeLease.acquire(data_dir)
    runtime = None
    try:
        for root in (paths.source_root, paths.robot_root):
            if root is not None:
                Path(root).mkdir(parents=True, exist_ok=True)
        control = RuntimeControl(data_dir, remote=remote)
        runtime = build_application_runtime(
            paths,
            agent_runtime_lease=lease,
            agent_mcp_available=True,
            max_running_jobs=control.budget.max_running_jobs,
            max_queued_jobs=control.budget.max_queued_jobs,
            max_batch_items=control.budget.max_batch_items,
            max_batch_total_frames=control.budget.max_batch_total_frames,
        )
        app = _mount_web_app(
            source_root=paths.source_root,
            save_dir=paths.save_dir,
            cache_dir=paths.cache_dir,
            runtime=runtime,
        )
        mounts = [route for route in app.routes if isinstance(route, Mount) and route.path == ""]
        app.router.routes[:] = [route for route in app.routes if route not in mounts]
        app.state.runtime_control = control
        register_runtime_routes(app, runtime, control, shutdown=shutdown)
        app.router.routes.extend(mounts)

        @app.exception_handler(RequestValidationError)
        async def validation_error(_request, _error):
            error = ApiError(
                code="INVALID_PARAMETER",
                message="Request does not match its schema.",
                stage=ErrorStage.REQUEST,
            )
            return JSONResponse(error.model_dump(mode="json"), status_code=422)

        @app.exception_handler(Exception)
        async def runtime_error(_request, exception):
            error = getattr(exception, "api_error", None)
            if not isinstance(error, ApiError):
                error = ApiError(
                    code="INTERNAL_ERROR",
                    message="Runtime operation failed.",
                    stage=ErrorStage.INTERNAL,
                    retryable=True,
                )
            code = error.code
            status = 500 if code == "INTERNAL_ERROR" else 422
            if code.endswith("NOT_FOUND"):
                status = 404
            elif code in {
                "PLAN_STALE",
                "JOB_CONFLICT",
                "RUNTIME_MISMATCH",
                "ARTIFACT_HASH_MISMATCH",
            }:
                status = 409
            elif code == "INVALID_RANGE":
                status = 416
            elif code.endswith("UNAVAILABLE"):
                status = 503
            return JSONResponse(
                error.model_dump(mode="json"),
                status_code=status,
                headers={"Cache-Control": "no-store"},
            )

        for error_type in (
            RuntimeServiceError,
            JobStoreError,
            JobManagerError,
            PlanStoreError,
            AssetServiceError,
            ArtifactExportError,
        ):
            app.add_exception_handler(error_type, runtime_error)

        app.add_middleware(RuntimeBoundary, control=control, allowed_origins=allowed_origins)
        return app
    except BaseException:
        if runtime is not None:
            runtime.scheduler.shutdown(wait=True)
            runtime.lifecycle._cleanup_once()
        lease.release()
        raise
