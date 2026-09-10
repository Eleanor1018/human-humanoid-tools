"""Assemble missing workflow contracts and route them through the shared JobManager."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Query, Request

from hhtools.application.analysis_reports import AnalysisReports
from hhtools.application.workflows import (
    ResourceWorkflowExecutor,
    analysis_configuration,
    workflow_availability,
    workflow_configuration_identity,
)
from hhtools.contracts import AssetBundle, JobSpecInput
from hhtools.contracts.previews import PreviewRenderParameters
from hhtools.contracts.runtime import BackendConfiguration, CleanupRequest
from hhtools.contracts.transfers import (
    ArtifactImportRequest,
    AssetMemberImportRequest,
    UploadCreateRequest,
    UploadSession,
)
from hhtools.contracts.workflows import (
    AnalysisCompareRequest,
    AnalysisExportParameters,
    AnalysisSelectionRequest,
    WorkflowJobSpec,
    WorkflowPreflightRequest,
)
from hhtools.services.asset_execution_policy import AssetExecutionPolicy
from hhtools.services.resource_reports import ResourceReports
from hhtools.services.runtime_control import RuntimeServiceError
from hhtools.services.transfers import UploadService
from hhtools.services.workflow_plans import WorkflowPlanService

from .boundary import PREFIX


def install_workflows(app, runtime, control):
    from hhtools.application.process_executor import SupervisedExecutor

    services = runtime.services
    manager = services.agent_job_manager
    policy = AssetExecutionPolicy(services.agent_asset_service, control)
    services.agent_asset_service.execution_guard = policy.require
    services.runtime_asset_policy = policy
    reports = ResourceReports(services.agent_job_store, services.agent_artifact_store)
    analysis_reports = AnalysisReports(reports)
    services.resource_reports = reports
    plans = WorkflowPlanService(
        services.agent_plan_store,
        services.agent_asset_service,
        services.agent_retarget_service,
        availability=workflow_availability,
        analysis_config=analysis_configuration,
        artifact_resolver=reports.artifact,
        backend_identity=workflow_configuration_identity,
    )
    executor = ResourceWorkflowExecutor(
        services.agent_asset_service,
        plans,
        services.agent_executor,
        control.data_dir / "temporary",
        paths=runtime.paths,
        services=services,
    )
    manager.configure_execution(
        plan_service=plans, executor=SupervisedExecutor(runtime.paths, lambda: control.budget)
    )
    services.runtime_workflow_plans = plans
    services.runtime_workflow_executor = executor
    uploads = UploadService(control.data_dir, services.agent_asset_service, control)
    router = APIRouter(prefix=PREFIX, tags=["resource workflows"])

    def subject(request):
        return request.state.runtime_principal["subject"]

    @router.get("/backends")
    def runtime_backends() -> dict:
        return {
            "analysis": workflow_availability("analysis"),
            "video_to_motion": workflow_availability("video_to_motion"),
        }

    @router.post("/workflows/preflight", response_model=WorkflowJobSpec)
    def workflow_preflight(body: WorkflowPreflightRequest):
        return plans.preflight(body)

    @router.post("/workflows/analysis-export/preflight", response_model=WorkflowJobSpec)
    def analysis_export_preflight(body: AnalysisExportParameters):
        artifact = reports.artifact(body.job_id, body.artifact_id)
        if artifact.descriptor.kind != "analysis_report":
            raise RuntimeServiceError("ARTIFACT_KIND_MISMATCH", "Select an analysis report.")
        parameters = body.model_copy(update={"artifact_sha256": artifact.descriptor.sha256})
        inputs = services.agent_job_store.get_spec(body.job_id).inputs
        return plans.create("analysis_export", inputs, parameters.model_dump(mode="json"))

    @router.post("/workflows/preview-render/preflight", response_model=WorkflowJobSpec)
    def preview_render_preflight(body: PreviewRenderParameters):
        parameters = body.model_copy(deep=True)
        if body.source.asset_id:
            asset = services.agent_asset_service.get(body.source.asset_id)
            inputs = [
                JobSpecInput(asset_id=asset.asset_id, sha256=asset.asset_id.rsplit(":", 1)[-1])
            ]
            if (
                asset.kind.value == "robot_trajectory_bundle"
                and not parameters.source.robot_asset_id
            ):
                source_id = asset.detected.source_robot_id if asset.detected else None
                matches = [
                    item
                    for item in services.agent_asset_service.search(
                        kind="robot_bundle", limit=500
                    ).assets
                    if item.metadata.get("robot_name") == source_id
                ]
                if len(matches) != 1:
                    raise RuntimeServiceError(
                        "ROBOT_ASSET_REQUIRED",
                        "Provide the exact source robot asset for this trajectory.",
                    )
                parameters.source.robot_asset_id = matches[0].asset_id
            if (
                parameters.source.robot_asset_id
                and parameters.source.robot_asset_id != asset.asset_id
            ):
                robot = services.agent_asset_service.get(parameters.source.robot_asset_id)
                inputs.append(
                    JobSpecInput(asset_id=robot.asset_id, sha256=robot.asset_id.rsplit(":", 1)[-1])
                )
        else:
            source = parameters.source
            job = services.agent_job_store.get(source.job_id)
            if source.artifact_id is None:
                candidate = next((item for item in job.artifacts if item.kind == "preview"), None)
                if candidate is None:
                    raise RuntimeServiceError(
                        "PREVIEW_NOT_FOUND", "This job has no preview artifact."
                    )
                source.artifact_id = candidate.artifact_id
            artifact = reports.artifact(source.job_id, source.artifact_id)
            parameters.artifact_sha256 = artifact.descriptor.sha256
            inputs = job.spec.inputs
        return plans.create("preview_render", inputs, parameters.model_dump(mode="json"))

    @router.get("/plans/{plan_id}")
    def runtime_get_plan(plan_id: str) -> dict:
        return services.agent_plan_store.get(plan_id).model_dump(mode="json")

    @router.post("/uploads", response_model=UploadSession)
    def runtime_create_upload(request: Request, body: UploadCreateRequest) -> dict:
        return uploads.create(body, subject(request))

    @router.get("/uploads/{upload_id}", response_model=UploadSession)
    def runtime_get_upload(request: Request, upload_id: str) -> dict:
        return uploads.get(upload_id, subject(request))

    @router.put("/uploads/{upload_id}/content", include_in_schema=False)
    async def runtime_upload_content(
        request: Request, upload_id: str, member: str, offset: int = Query(ge=0)
    ):
        from starlette.concurrency import run_in_threadpool

        return await run_in_threadpool(
            uploads.put, upload_id, member, offset, await request.body(), subject(request)
        )

    @router.post("/uploads/{upload_id}/complete", response_model=AssetBundle)
    def runtime_complete_upload(request: Request, upload_id: str):
        return uploads.complete(upload_id, subject(request))

    @router.delete("/uploads/{upload_id}")
    def runtime_abort_upload(request: Request, upload_id: str) -> dict:
        return uploads.abort(upload_id, subject(request))

    @router.post("/assets/from-artifact")
    def runtime_import_artifact(body: ArtifactImportRequest) -> dict:
        return uploads.import_artifact(reports.artifact(body.job_id, body.artifact_id), body.kind)

    @router.post("/assets/from-member", response_model=AssetBundle)
    def runtime_import_member(body: AssetMemberImportRequest):
        assets = services.agent_asset_service
        path = assets.resolve_file(body.asset_id, body.member, verify_hash=True)
        return assets.register(assets.registration_hint(path, kind=body.kind))

    @router.post("/admin/assets/{asset_id}/trust")
    def runtime_trust_asset(asset_id: str) -> dict:
        services.agent_asset_service.get(asset_id)
        return control.trust_asset(asset_id)

    @router.put("/admin/backends")
    def runtime_configure_backends(body: BackendConfiguration) -> dict:
        if services.agent_job_store.list_active():
            raise RuntimeServiceError(
                "RUNTIME_BUSY", "Drain active jobs before changing backend environments."
            )
        return {"configured": control.configure_backends(body), "availability": runtime_backends()}

    @router.get("/admin/cleanup")
    def runtime_plan_cleanup() -> dict:
        return uploads.cleanup_plan()

    @router.post("/admin/cleanup")
    def runtime_apply_cleanup(body: CleanupRequest) -> dict:
        return uploads.cleanup(body.cleanup_id)

    @router.post("/analysis/select")
    def runtime_select_analysis(body: AnalysisSelectionRequest) -> dict[str, Any]:
        return analysis_reports.select(body)

    @router.post("/analysis/compare")
    def runtime_compare_analysis(body: AnalysisCompareRequest) -> dict:
        return analysis_reports.compare(body.left, body.right)

    app.include_router(router)
