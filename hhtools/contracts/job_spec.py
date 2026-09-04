"""Auditable JobSpec v2 contract.

JobSpec v1 remains implemented in :mod:`hhtools.web.jobs.job_specs`; this module
does not reinterpret or rewrite it.  A v1 replay must register its assets and
run preflight before a truthful v2 spec can be created.
"""

from __future__ import annotations

from enum import StrEnum
from typing import Annotated, Any, Literal

from pydantic import AwareDatetime, ConfigDict, Field, model_validator

from .common import AssetId, CalibrationId, ContractModel, PlanId, Sha256Hex
from .preflight import OutputPolicy


class JobSpecKind(StrEnum):
    RETARGET = "retarget"
    BATCH_RETARGET = "batch_retarget"


class JobSpecInput(ContractModel):
    """Content-bound input reference used by an executable job."""

    asset_id: AssetId
    sha256: Sha256Hex


class JobSpecRobot(ContractModel):
    """Robot identity and exact configuration used by the job."""

    robot_id: Annotated[str, Field(min_length=1, max_length=256)]
    asset_id: AssetId
    config_sha256: Sha256Hex


class JobSpecCalibration(ContractModel):
    """Exact calibration selected by preflight."""

    calibration_id: CalibrationId
    sha256: Sha256Hex


class JobSpecProvenance(ContractModel):
    """Code, dependency, and execution-device identity for reproduction."""

    hhtools_git_commit: Annotated[str, Field(min_length=1, max_length=128)]
    hhtools_dirty: bool
    python: Annotated[str, Field(min_length=1, max_length=128)]
    pytorch: str | None = None
    cuda: str | None = None
    newton: str | None = None
    device: str | None = None
    platform: str | None = None
    dependencies: dict[str, str] = Field(default_factory=dict)


class JobSpecV2(ContractModel):
    """Immutable, preflight-resolved execution identity for a retarget job."""

    model_config = ConfigDict(
        extra="forbid",
        str_strip_whitespace=True,
        validate_assignment=True,
        frozen=True,
    )

    schema_version: Literal[2] = 2
    kind: JobSpecKind
    plan_id: PlanId
    inputs: Annotated[list[JobSpecInput], Field(min_length=1)]
    robot: JobSpecRobot
    calibration: JobSpecCalibration | None
    backend: Annotated[str, Field(min_length=1, max_length=128)]
    effective_parameters: dict[str, Any] = Field(default_factory=dict)
    output_policy: OutputPolicy
    provenance: JobSpecProvenance
    created_at: AwareDatetime

    @model_validator(mode="after")
    def validate_unique_inputs(self) -> JobSpecV2:
        asset_ids = [item.asset_id for item in self.inputs]
        if len(asset_ids) != len(set(asset_ids)):
            raise ValueError("JobSpec v2 inputs must not contain duplicate asset ids")
        return self
