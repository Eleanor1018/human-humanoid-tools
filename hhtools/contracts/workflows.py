"""Explicit v3 execution contracts for workflows that do not require a robot."""

from __future__ import annotations

import json
from typing import Annotated, Any, Literal

from pydantic import AwareDatetime, ConfigDict, Field, model_validator

from .artifacts import JobManifest
from .common import AssetId, ContractModel, PlanId, Sha256Hex
from .execution import TrajectoryExportOptions
from .job_spec import JobSpecInput, JobSpecProvenance, JobSpecV2
from .preflight import OutputPolicy
from .previews import PreviewRenderParameters

WORKFLOW_SEMANTICS = "hhtools.workflow.plan.v1"


class AnalysisParameters(ContractModel):
    embedding: Literal["handcrafted", "pae"] = "handcrafted"
    metric_config: dict[str, Any] = Field(default_factory=dict)


class VideoParameters(ContractModel):
    static_camera: bool = True
    focal_length_mm: Annotated[int | None, Field(default=None, ge=1, le=1000)]


class WorkflowPreflightRequest(ContractModel):
    workflow: Literal["analysis", "video_to_motion"]
    asset_ids: Annotated[list[AssetId], Field(min_length=1, max_length=1000)]
    parameters: dict[str, Any] = Field(default_factory=dict)

    @model_validator(mode="after")
    def validate_parameters(self):
        if len(set(self.asset_ids)) != len(self.asset_ids):
            raise ValueError("Duplicate asset IDs")
        model = AnalysisParameters if self.workflow == "analysis" else VideoParameters
        object.__setattr__(
            self, "parameters", model.model_validate(self.parameters).model_dump(mode="json")
        )
        return self


class WorkflowJobSpec(ContractModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    schema_version: Literal[3] = 3
    kind: Literal[
        "analysis", "video_to_motion", "analysis_export", "preview_render", "retarget_export"
    ]
    plan_id: PlanId
    inputs: Annotated[list[JobSpecInput], Field(min_length=1, max_length=1000)]
    backend: str
    effective_parameters: dict[str, Any]
    output_policy: OutputPolicy = OutputPolicy.CREATE_NEW
    provenance: JobSpecProvenance
    created_at: AwareDatetime

    @model_validator(mode="after")
    def validate_workflow(self):
        if len({item.asset_id for item in self.inputs}) != len(self.inputs):
            raise ValueError("Duplicate workflow inputs")
        model, expected = {
            "analysis": (AnalysisParameters, "dataset_analysis"),
            "video_to_motion": (VideoParameters, "gvhmr"),
            "analysis_export": (AnalysisExportParameters, "analysis_export"),
            "preview_render": (PreviewRenderParameters, "mujoco"),
            "retarget_export": (RetargetExportParameters, "retarget_export"),
        }[self.kind]
        model.model_validate(self.effective_parameters)
        if self.backend != expected:
            raise ValueError("Workflow backend does not match its kind")
        return self


ExecutableJobSpec = JobSpecV2 | WorkflowJobSpec


def parse_job_spec(value: dict | str) -> ExecutableJobSpec:
    document = json.loads(value) if isinstance(value, str) else value
    model = WorkflowJobSpec if document.get("schema_version") == 3 else JobSpecV2
    return model.model_validate(document)


def workflow_payload(spec: WorkflowJobSpec) -> dict:
    return {
        "semantics": WORKFLOW_SEMANTICS,
        "spec": spec.model_dump(mode="json", exclude={"plan_id", "created_at"}),
    }


class WorkflowJobManifest(JobManifest):
    """Explicit manifest version; the existing v1/v2 retarget schemas stay unchanged."""

    schema_version: Literal["2.0"] = "2.0"
    job_spec: WorkflowJobSpec


class AnalysisSelectionRequest(ContractModel):
    job_id: str
    artifact_id: str
    tags: list[str] = Field(default_factory=list, max_length=64)
    clip_ids: list[str] = Field(default_factory=list, max_length=10000)
    include_errors: bool = False
    metric_ranges: dict[str, tuple[float | None, float | None]] = Field(default_factory=dict)
    subset_size: Annotated[int | None, Field(default=None, ge=1, le=10000)]
    alpha: Annotated[float, Field(ge=0, le=1)] = 0.99
    offset: Annotated[int, Field(ge=0)] = 0
    limit: Annotated[int, Field(ge=1, le=500)] = 100


class AnalysisExportParameters(AnalysisSelectionRequest):
    format: Literal["json", "csv", "robot_zip"] = "json"
    artifact_sha256: Sha256Hex | None = None


class AnalysisCompareRequest(ContractModel):
    left: AnalysisSelectionRequest
    right: AnalysisSelectionRequest


class RetargetExportParameters(TrajectoryExportOptions):
    job_id: str
    artifact_id: str
    artifact_sha256: Sha256Hex | None = None
    format: Literal["csv", "pkl"] = "csv"
