"""Runtime control and common job/resource HTTP operations."""

from __future__ import annotations

import hashlib
import re
import threading
from typing import Annotated, Any

from fastapi import APIRouter, Query, Request
from fastapi.responses import StreamingResponse

from hhtools.contracts import (
    AgentJobView,
    ArtifactDescriptor,
    ArtifactExportReceipt,
    JobLookupRequest,
    JobRetryRequest,
    JobStartRequest,
)
from hhtools.contracts.runtime import (
    RuntimeBudget,
    RuntimeIdentity,
    RuntimeJobList,
    RuntimeShutdown,
    RuntimeTokenReceipt,
    RuntimeTokenRequest,
)
from hhtools.services.runtime_control import RuntimeServiceError

from .boundary import PREFIX
from .catalog import operation_catalog


def register_runtime_routes(app, runtime, control, *, shutdown=None):
    router = APIRouter(prefix=PREFIX, tags=["runtime"])
    services = runtime.services
    manager = services.agent_job_manager
    store = services.agent_job_store
    store.enable_events()

    def scoped(request: Request, key: str, operation: str = "submit"):
        return control.scoped_key(request.state.runtime_principal["subject"], operation, key)

    @router.get("/identity", response_model=RuntimeIdentity)
    def runtime_identity():
        """Read persistent instance identity before using saved resource IDs."""
        return control.identity

    @router.get("/operations")
    def runtime_operations() -> dict[str, Any]:
        """Discover actual operations, schemas, scopes, and current backend availability."""
        return {
            "identity": control.identity.model_dump(mode="json"),
            "operations": operation_catalog(app),
            "budget": control.budget.model_dump(),
            "backends": services.agent_capabilities_service.get_capabilities().model_dump(
                mode="json"
            ),
        }

    @router.get("/jobs", response_model=RuntimeJobList)
    def runtime_list_jobs(
        limit: Annotated[int, Query(ge=1, le=500)] = 100, offset: Annotated[int, Query(ge=0)] = 0
    ):
        """List the same durable jobs for humans, agents, and scripts."""
        rows, total = store.list_jobs(limit=limit, offset=offset)
        return RuntimeJobList(
            runtime_id=control.identity.runtime_id,
            workspace_id=control.identity.workspace_id,
            jobs=[row.view.model_dump(mode="json") for row in rows],
            total=total,
            limit=limit,
            offset=offset,
        )

    @router.get("/events")
    def runtime_events(
        after: Annotated[int, Query(ge=0)] = 0, limit: Annotated[int, Query(ge=1, le=500)] = 100
    ) -> dict[str, Any]:
        """Resume durable workspace events using the last acknowledged cursor."""
        return {
            **store.events(after=after, limit=limit),
            "runtime_id": control.identity.runtime_id,
            "workspace_id": control.identity.workspace_id,
        }

    @router.post("/jobs", response_model=AgentJobView)
    def runtime_start_job(request: Request, body: JobStartRequest):
        """Submit a preflight plan with a subject- and workspace-scoped idempotency key."""
        return manager.start_job(
            body.plan_id, idempotency_key=scoped(request, body.idempotency_key)
        )

    @router.post("/jobs/lookup", response_model=AgentJobView)
    def runtime_lookup_job(request: Request, body: JobLookupRequest):
        return manager.lookup_job(
            body.plan_id,
            idempotency_key=scoped(request, body.idempotency_key),
            after_revision=body.after_revision,
        )

    @router.get("/jobs/{job_id}", response_model=AgentJobView)
    def runtime_get_job(job_id: str):
        return manager.get_job(job_id)

    @router.get("/jobs/{job_id}/wait", response_model=AgentJobView)
    def runtime_wait_job(
        job_id: str,
        after_revision: Annotated[int, Query(ge=0)] = 0,
        timeout_seconds: Annotated[float, Query(ge=0, le=30)] = 25,
    ):
        return manager.wait_job(job_id, after_revision=after_revision, timeout=timeout_seconds)

    @router.post("/jobs/{job_id}/cancel", response_model=AgentJobView)
    def runtime_cancel_job(job_id: str):
        return manager.cancel_job(job_id)

    @router.post("/jobs/{job_id}/retry", response_model=AgentJobView)
    def runtime_retry_job(request: Request, job_id: str, body: JobRetryRequest):
        if manager.get_job(job_id).attempt >= control.budget.max_retry_attempts:
            raise RuntimeServiceError(
                "RETRY_BUDGET_EXCEEDED", "The retry chain exhausted its attempt budget."
            )
        return manager.retry_job(
            job_id, idempotency_key=scoped(request, body.idempotency_key, "retry")
        )

    @router.get("/jobs/{job_id}/artifacts")
    def runtime_list_artifacts(
        job_id: str,
        limit: Annotated[int, Query(ge=1, le=500)] = 100,
        offset: Annotated[int, Query(ge=0)] = 0,
    ) -> dict:
        artifacts = manager.list_artifacts(job_id, limit=limit, offset=offset)
        return {
            "job_id": job_id,
            "artifacts": [item.model_dump(mode="json") for item in artifacts],
            "total": manager.get_job(job_id).artifact_count,
            "limit": limit,
            "offset": offset,
        }

    @router.post(
        "/jobs/{job_id}/artifacts/{artifact_id}/export", response_model=ArtifactExportReceipt
    )
    def runtime_export_artifact(job_id: str, artifact_id: str):
        return services.agent_artifact_export_service.export(job_id, artifact_id)

    @router.get("/jobs/{job_id}/artifacts/{artifact_id}", response_model=ArtifactDescriptor)
    def runtime_get_artifact(job_id: str, artifact_id: str):
        return manager.get_artifact(job_id, artifact_id, verify=False).descriptor

    @router.get("/jobs/{job_id}/artifacts/{artifact_id}/content", include_in_schema=False)
    def runtime_artifact_content(request: Request, job_id: str, artifact_id: str):
        stored = manager.get_artifact(job_id, artifact_id, verify=False)
        descriptor = stored.descriptor
        handle = stored.path.open("rb")
        try:
            digest = hashlib.file_digest(handle, "sha256").hexdigest()
            size = handle.tell()
            if digest != descriptor.sha256 or size != descriptor.size_bytes:
                raise RuntimeServiceError(
                    "ARTIFACT_HASH_MISMATCH", "Artifact content failed verification."
                )
            etag = '"' + digest + '"'
            start, end, status = 0, size - 1, 200
            value = request.headers.get("range")
            if value and request.headers.get("if-range", etag) == etag:
                match = re.fullmatch(r"bytes=(\d+)-(\d*)", value)
                if not match:
                    raise RuntimeServiceError("INVALID_RANGE", "Only one byte range is supported.")
                start = int(match[1])
                end = min(int(match[2]), size - 1) if match[2] else size - 1
                if not 0 <= start <= end < size:
                    raise RuntimeServiceError(
                        "INVALID_RANGE", "Byte range is outside the artifact."
                    )
                status = 206
            handle.seek(start)
        except BaseException:
            handle.close()
            raise

        def stream():
            try:
                remaining = end - start + 1
                while remaining > 0:
                    chunk = handle.read(min(1024**2, remaining))
                    if not chunk:
                        break
                    remaining -= len(chunk)
                    yield chunk
            finally:
                handle.close()

        headers = {
            "ETag": etag,
            "Accept-Ranges": "bytes",
            "X-Content-SHA256": digest,
            "Content-Length": str(end - start + 1),
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
        }
        if status == 206:
            headers["Content-Range"] = f"bytes {start}-{end}/{size}"
        return StreamingResponse(
            stream(),
            status_code=status,
            headers=headers,
            media_type=descriptor.media_type or "application/octet-stream",
        )

    @router.get("/budget", response_model=RuntimeBudget)
    def runtime_budget():
        return control.budget

    @router.put("/admin/budget", response_model=RuntimeBudget)
    def runtime_set_budget(body: RuntimeBudget):
        with runtime.job_settings_update_lock:
            control.save_budget(body)
            runtime.scheduler.reconfigure(
                max_running_jobs=body.max_running_jobs, max_queued_jobs=body.max_queued_jobs
            )
            services.agent_batch_limit_policy.reconfigure(
                max_batch_items=body.max_batch_items,
                max_batch_total_frames=body.max_batch_total_frames,
            )
        return body

    @router.get("/admin/tokens")
    def runtime_list_tokens() -> dict:
        return {"tokens": control.list_tokens()}

    @router.post("/admin/tokens", response_model=RuntimeTokenReceipt)
    def runtime_issue_token(body: RuntimeTokenRequest):
        return control.issue_token(body)

    @router.delete("/admin/tokens/{token_id}")
    def runtime_revoke_token(token_id: str) -> dict:
        return control.revoke_token(token_id)

    @router.post("/admin/shutdown")
    def runtime_shutdown(body: RuntimeShutdown) -> dict:
        if shutdown is None:
            raise RuntimeServiceError(
                "SHUTDOWN_UNAVAILABLE", "This host manages its own lifecycle."
            )

        def stop():
            if body.policy == "cancel":
                for row in store.list_active():
                    manager.cancel_job(row.job_id)
            runtime.scheduler.shutdown(wait=True)
            shutdown()

        threading.Thread(target=stop, name="hhtools-runtime-shutdown", daemon=True).start()
        return {"stopping": True, "policy": body.policy}

    app.include_router(router)
