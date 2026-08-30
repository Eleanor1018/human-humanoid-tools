"""Compact job and artifact contracts for polling agents."""

from __future__ import annotations

from enum import StrEnum
from typing import Annotated, Any

from pydantic import AliasChoices, AwareDatetime, Field, model_validator

from .capabilities import SchedulerMode
from .common import (
    ApiError,
    ArtifactId,
    ContractModel,
    NextAction,
    ResourceUri,
    SchemaVersion,
    Sha256Hex,
)


class JobState(StrEnum):
    """Execution lifecycle, independent from output quality."""

    QUEUED = "queued"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


class JobOutcome(StrEnum):
    """Semantic result of a completed job."""

    SUCCESS = "success"
    PARTIAL = "partial"
    REVIEW_REQUIRED = "review_required"
    REJECTED = "rejected"


class JobProgress(ContractModel):
    """Small monotonic progress snapshot suitable for frequent polling."""

    phase: Annotated[str, Field(min_length=1, max_length=128)] = "queued"
    fraction: Annotated[float, Field(ge=0.0, le=1.0)] = 0.0
    revision: Annotated[int, Field(ge=0)] = 0
    completed_items: Annotated[int | None, Field(default=None, ge=0)]
    total_items: Annotated[int | None, Field(default=None, ge=0)]
    message: str | None = None
    updated_at: AwareDatetime | None = None
    eta_seconds: Annotated[float | None, Field(default=None, ge=0)]

    @model_validator(mode="after")
    def validate_item_counts(self) -> JobProgress:
        if self.completed_items is not None and self.total_items is None:
            raise ValueError("total_items is required when completed_items is provided")
        if (
            self.completed_items is not None
            and self.total_items is not None
            and self.completed_items > self.total_items
        ):
            raise ValueError("completed_items cannot exceed total_items")
        return self


class ArtifactDescriptor(ContractModel):
    """Metadata and URI for a job output; binary data is never embedded."""

    schema_version: SchemaVersion = SchemaVersion.V1
    artifact_id: ArtifactId
    job_id: Annotated[str, Field(min_length=1, max_length=256)]
    kind: Annotated[str, Field(min_length=1, max_length=128)]
    format: Annotated[str | None, Field(default=None, min_length=1, max_length=32)]
    resource_uri: Annotated[
        ResourceUri,
        Field(
            min_length=1,
            validation_alias=AliasChoices("resource_uri", "uri"),
            description="Resolvable artifact URI, for example hhtools:// or https://.",
        ),
    ]
    media_type: str | None = None
    size_bytes: Annotated[int | None, Field(default=None, ge=0)]
    sha256: Sha256Hex | None = None
    created_at: AwareDatetime | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)

    @property
    def uri(self) -> str:
        """Read-only compatibility accessor; JSON always uses ``resource_uri``."""

        return self.resource_uri


class JobQueueView(ContractModel):
    """Queue position and admission settings captured with a job snapshot."""

    position: Annotated[int | None, Field(default=None, ge=1)]
    max_running_jobs: Annotated[int, Field(ge=0)] = 0
    max_queued_jobs: Annotated[int, Field(ge=0)] = 0
    mode: SchedulerMode


class AgentJobView(ContractModel):
    """Compact default job view; large arrays live behind artifact URIs."""

    schema_version: SchemaVersion = SchemaVersion.V1
    job_id: Annotated[str, Field(min_length=1, max_length=256)]
    state: JobState
    outcome: JobOutcome | None = None
    progress: JobProgress
    summary: dict[str, Any] = Field(
        default_factory=dict,
        description="Small input/backend/robot summary, never trajectory arrays.",
    )
    queue: JobQueueView | None = None
    artifacts: list[ArtifactDescriptor] = Field(default_factory=list)
    error: ApiError | None = None
    next_action: NextAction | None = None
    submitted_at: AwareDatetime
    started_at: AwareDatetime | None = None
    completed_at: AwareDatetime | None = None
    poll_after_ms: Annotated[int | None, Field(default=None, ge=0, le=300_000)]

    @model_validator(mode="after")
    def validate_lifecycle(self) -> AgentJobView:
        terminal = {JobState.COMPLETED, JobState.FAILED, JobState.CANCELLED}
        if self.outcome is not None and self.state is not JobState.COMPLETED:
            raise ValueError("outcome is only valid for completed jobs")
        if self.state is JobState.COMPLETED and self.outcome is None:
            raise ValueError("completed jobs must include an outcome")
        if self.state is JobState.FAILED and self.error is None:
            raise ValueError("failed jobs must include an error")
        if self.state not in terminal and self.completed_at is not None:
            raise ValueError("non-terminal jobs cannot include completed_at")
        if self.started_at is not None and self.started_at < self.submitted_at:
            raise ValueError("started_at cannot precede submitted_at")
        if self.completed_at is not None:
            baseline = self.started_at or self.submitted_at
            if self.completed_at < baseline:
                raise ValueError("completed_at cannot precede the job start")
        return self
