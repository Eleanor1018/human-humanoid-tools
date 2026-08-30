"""Retarget preflight request, check, and immutable plan contracts."""

from __future__ import annotations

from enum import StrEnum
from typing import Annotated, Any

from pydantic import AwareDatetime, ConfigDict, Field, model_validator

from .common import (
    ApiError,
    AssetId,
    CalibrationId,
    ContractModel,
    MachineCode,
    NextAction,
    PlanId,
    SchemaVersion,
    Sha256Hex,
)


class OutputPolicy(StrEnum):
    CREATE_NEW = "create_new"
    FAIL_IF_EXISTS = "fail_if_exists"
    OVERWRITE = "overwrite"


class PreflightCheckLevel(StrEnum):
    PASS = "pass"
    WARNING = "warning"
    ERROR = "error"


# Compatibility import name used by early service prototypes.  The serialized
# contract is the documented ``level`` field and values above.
PreflightCheckStatus = PreflightCheckLevel


class PreflightStatus(StrEnum):
    READY = "ready"
    HUMAN_ACTION_REQUIRED = "human_action_required"
    REJECTED = "rejected"


class RetargetPreflightRequest(ContractModel):
    """User intent that the service resolves into an immutable plan."""

    schema_version: SchemaVersion = SchemaVersion.V1
    motion_asset_id: AssetId
    robot_id: Annotated[str, Field(min_length=1, max_length=256)]
    backend: str | None = Field(
        default=None,
        description="Backend id, or null to request a recommendation.",
    )
    calibration_id: CalibrationId | None = None
    output_format: Annotated[str, Field(min_length=1, max_length=32)] = "csv"
    output_policy: OutputPolicy = OutputPolicy.CREATE_NEW
    parameters: dict[str, Any] = Field(
        default_factory=dict,
        description="Backend-independent and namespaced backend parameters.",
    )


class PreflightCheck(ContractModel):
    """One deterministic precondition evaluated by the service."""

    code: MachineCode
    level: PreflightCheckLevel
    message: Annotated[str, Field(min_length=1)]
    details: dict[str, Any] = Field(default_factory=dict)
    next_action: NextAction | None = None


class RetargetPlan(ContractModel):
    """Fully resolved, content-bound plan accepted by ``start_retarget``."""

    model_config = ConfigDict(
        extra="forbid",
        str_strip_whitespace=True,
        validate_assignment=True,
        frozen=True,
    )

    schema_version: SchemaVersion = SchemaVersion.V1
    plan_id: PlanId
    created_at: AwareDatetime
    expires_at: AwareDatetime | None = None
    motion_asset_id: AssetId
    robot_id: Annotated[str, Field(min_length=1, max_length=256)]
    backend: Annotated[str, Field(min_length=1, max_length=128)]
    calibration_id: CalibrationId | None = None
    output_format: Annotated[str, Field(min_length=1, max_length=32)]
    output_policy: OutputPolicy
    parameters: dict[str, Any] = Field(default_factory=dict)
    input_digest: Sha256Hex
    robot_digest: Sha256Hex
    calibration_digest: Sha256Hex | None = None

    @model_validator(mode="after")
    def validate_expiry(self) -> RetargetPlan:
        if self.expires_at is not None and self.expires_at <= self.created_at:
            raise ValueError("expires_at must be later than created_at")
        return self


class PreflightResponse(ContractModel):
    """Preflight result; only ``ready`` responses expose a runnable plan."""

    schema_version: SchemaVersion = SchemaVersion.V1
    request_id: Annotated[str, Field(min_length=1, max_length=256)]
    status: PreflightStatus
    plan: RetargetPlan | None = None
    checks: list[PreflightCheck] = Field(default_factory=list)
    recommended_backend: str | None = None
    required_actions: list[NextAction] = Field(default_factory=list)
    error: ApiError | None = None

    @model_validator(mode="after")
    def validate_response_state(self) -> PreflightResponse:
        if self.status is PreflightStatus.READY:
            if self.plan is None:
                raise ValueError("ready preflight responses must include a plan")
            if self.error is not None or self.required_actions:
                raise ValueError(
                    "ready preflight responses cannot include errors or required actions"
                )
        else:
            if self.plan is not None:
                raise ValueError("non-ready preflight responses cannot include a plan")
            if self.status is PreflightStatus.HUMAN_ACTION_REQUIRED and not self.required_actions:
                raise ValueError("human_action_required responses must include a required action")
            if self.status is PreflightStatus.REJECTED and self.error is None:
                raise ValueError("rejected preflight responses must include an error")
        return self
