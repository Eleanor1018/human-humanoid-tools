"""Versioned Runtime discovery, access policy, and operation contracts."""

from __future__ import annotations

from typing import Annotated, Any, Literal

from pydantic import AwareDatetime, Field

from .common import ContractModel
from .jobs import AgentJobView

ScopeName = Literal["read", "write", "calibrate", "admin"]


class RuntimeIdentity(ContractModel):
    protocol_version: Literal["1.0"] = "1.0"
    runtime_id: str
    workspace_id: str
    generation: str
    version: str
    started_at: AwareDatetime
    mode: Literal["local", "remote"]
    persistent: bool = True
    endpoint: str | None = None
    checkpoint_resume: bool = False


class OperationDescriptor(ContractModel):
    name: str
    description: str
    method: str
    path: str
    scope: ScopeName
    execution: Literal["query", "command", "job", "session", "transfer"]
    availability: Literal["available", "unavailable", "degraded"] = "available"
    reason: str | None = None
    input_schema: dict[str, Any]
    output_schema: dict[str, Any]
    body_parameter: str | None = None
    path_parameters: list[str] = Field(default_factory=list)
    query_parameters: list[str] = Field(default_factory=list)


class RuntimeBudget(ContractModel):
    max_running_jobs: Annotated[int, Field(ge=0, strict=True)] = 2
    max_queued_jobs: Annotated[int, Field(ge=0, strict=True)] = 64
    max_batch_items: Annotated[int, Field(ge=0, strict=True)] = 1000
    max_batch_total_frames: Annotated[int, Field(ge=0, strict=True)] = 0
    max_job_seconds: Annotated[int, Field(ge=0, strict=True)] = 3600
    max_upload_bytes: Annotated[int, Field(ge=1, strict=True)] = 10 * 1024**3
    max_staging_bytes: Annotated[int, Field(ge=1, strict=True)] = 20 * 1024**3
    max_preview_sessions: Annotated[int, Field(ge=0, strict=True)] = 1
    max_retry_attempts: Annotated[int, Field(ge=1, le=100, strict=True)] = 3


class RuntimeShutdown(ContractModel):
    policy: Literal["drain", "cancel"] = "drain"


class RuntimeTokenRequest(ContractModel):
    subject: Annotated[str, Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")]
    scopes: Annotated[list[ScopeName], Field(min_length=1, max_length=4)]


class RuntimeTokenReceipt(ContractModel):
    token_id: str
    subject: str
    scopes: list[ScopeName]
    token: str


class RuntimeJobList(ContractModel):
    runtime_id: str
    workspace_id: str
    jobs: list[AgentJobView]
    offset: int
    limit: int
    total: int


class RuntimeEvent(ContractModel):
    cursor: int
    job_id: str
    revision: int
    state: str


class RuntimeEventPage(ContractModel):
    runtime_id: str
    workspace_id: str
    events: list[RuntimeEvent]
    cursor: int
    latest_cursor: int
    has_more: bool


class BackendConfiguration(ContractModel):
    gvhmr_root: str | None = None
    gvhmr_python: str | None = None
    body_models_root: str | None = None


class CleanupRequest(ContractModel):
    cleanup_id: str
