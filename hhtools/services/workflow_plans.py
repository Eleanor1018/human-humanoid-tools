"""Preflight and immutable execution descriptions for analysis and video workflows."""

from __future__ import annotations

from datetime import UTC, datetime

from hhtools.contracts import ApiError, AssetKind, ErrorStage, JobSpecInput, NextAction
from hhtools.contracts.workflows import (
    WorkflowJobSpec,
    WorkflowPreflightRequest,
    workflow_payload,
)

from .plans import compute_plan_id
from .retarget import RetargetServiceError, _default_provenance


class WorkflowPlanService:
    def __init__(
        self,
        plans,
        assets,
        fallback,
        *,
        availability,
        analysis_config,
        artifact_resolver=None,
        backend_identity=None,
    ):
        self.plans = plans
        self.assets = assets
        self.fallback = fallback
        self.availability = availability
        self.analysis_config = analysis_config
        self.provenance = _default_provenance()
        self.artifact_resolver = artifact_resolver
        self.backend_identity = backend_identity

    def preflight(self, request: WorkflowPreflightRequest) -> WorkflowJobSpec:
        status = self.availability(request.workflow)
        if not status["available"]:
            raise RetargetServiceError(
                ApiError(
                    code="BACKEND_UNAVAILABLE",
                    message="The workflow backend is not configured.",
                    stage=ErrorStage.PREFLIGHT,
                    details=status,
                    next_action=NextAction(
                        actor="agent",
                        action="query_runtime_backends",
                        parameters={"operation": "hhtools_runtime_backends"},
                    ),
                )
            )
        expected = (
            {AssetKind.VIDEO}
            if request.workflow == "video_to_motion"
            else {
                AssetKind.MOTION_BUNDLE,
                AssetKind.ROBOT_TRAJECTORY_BUNDLE,
                AssetKind.DATASET_BUNDLE,
            }
        )
        inputs = []
        for asset_id in request.asset_ids:
            bundle = self.assets.get(asset_id)
            if bundle.kind not in expected:
                raise RetargetServiceError(
                    ApiError(
                        code="ASSET_KIND_MISMATCH",
                        message="Input asset does not match the workflow.",
                        stage=ErrorStage.PREFLIGHT,
                        details={"asset_id": asset_id, "kind": bundle.kind},
                    )
                )
            for item in bundle.files:
                self.assets.resolve_file(asset_id, item.relative_path, verify_hash=True)
            inputs.append(JobSpecInput(asset_id=asset_id, sha256=asset_id.rsplit(":", 1)[-1]))
        parameters = dict(request.parameters)
        if request.workflow == "analysis":
            parameters["metric_config"] = self.analysis_config(parameters["metric_config"])
        return self.create(request.workflow, inputs, parameters)

    def create(self, kind, inputs, parameters):
        provenance = self.provenance.model_copy(deep=True)
        if self.backend_identity is not None:
            provenance.dependencies["runtime_configuration"] = self.backend_identity(kind)
        spec = WorkflowJobSpec(
            kind=kind,
            plan_id="plan:sha256:" + "0" * 64,
            inputs=inputs,
            backend={
                "analysis": "dataset_analysis",
                "video_to_motion": "gvhmr",
                "analysis_export": "analysis_export",
                "preview_render": "mujoco",
                "retarget_export": "retarget_export",
            }[kind],
            effective_parameters=parameters,
            provenance=provenance,
            created_at=datetime.now(UTC),
        )
        payload = workflow_payload(spec)
        plan_id = compute_plan_id(payload)
        try:
            return self.get_job_spec(plan_id)
        except RetargetServiceError as error:
            if error.code != "PLAN_NOT_FOUND":
                raise
        spec = spec.model_copy(update={"plan_id": plan_id})
        return self.plans.put_if_absent(spec, payload)

    def get_job_spec(self, plan_id):
        from .plans import PlanStoreError

        try:
            plan = self.plans.get(plan_id)
        except PlanStoreError as error:
            raise RetargetServiceError(error.api_error) from error
        if not isinstance(plan, WorkflowJobSpec):
            spec = self.fallback.get_job_spec(plan_id)
            guard = getattr(self.assets, "execution_guard", None)
            if guard is not None:
                for source in spec.inputs:
                    guard(source.asset_id)
            return spec
        parameters = plan.effective_parameters
        bound_configuration = plan.provenance.dependencies.get("runtime_configuration")
        if (
            bound_configuration is not None
            and self.backend_identity is not None
            and bound_configuration != self.backend_identity(plan.kind)
        ):
            raise RetargetServiceError(
                ApiError(
                    code="PLAN_STALE",
                    message="Backend configuration changed; run preflight again.",
                    stage=ErrorStage.PREFLIGHT,
                )
            )
        if parameters.get("artifact_sha256"):
            source = parameters.get("source", parameters)
            if self.artifact_resolver is None:
                raise RetargetServiceError(
                    ApiError(
                        code="ARTIFACT_NOT_FOUND",
                        message="Artifact resolver is unavailable.",
                        stage=ErrorStage.PREFLIGHT,
                    )
                )
            stored = self.artifact_resolver(source["job_id"], source["artifact_id"])
            if stored.descriptor.sha256 != parameters["artifact_sha256"]:
                raise RetargetServiceError(
                    ApiError(
                        code="PLAN_STALE",
                        message="Source artifact identity changed.",
                        stage=ErrorStage.PREFLIGHT,
                    )
                )
        for item in plan.inputs:
            bundle = self.assets.get(item.asset_id)
            for member in bundle.files:
                try:
                    self.assets.resolve_file(item.asset_id, member.relative_path, verify_hash=True)
                except Exception as error:
                    raise RetargetServiceError(
                        ApiError(
                            code="PLAN_STALE",
                            message="A planned input no longer matches its content identity.",
                            stage=ErrorStage.PREFLIGHT,
                            details={"asset_id": item.asset_id},
                        )
                    ) from error
        return plan
