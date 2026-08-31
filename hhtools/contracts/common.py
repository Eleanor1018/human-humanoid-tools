"""Shared primitives for HHTools' public agent contracts.

The models in :mod:`hhtools.contracts` are transport-neutral.  REST, JSON CLI,
OpenAPI, and MCP adapters should serialize these models instead of defining
their own wire formats.
"""

from __future__ import annotations

from enum import StrEnum
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class ContractModel(BaseModel):
    """Base class that rejects misspelled or unsupported wire fields."""

    model_config = ConfigDict(
        extra="forbid",
        str_strip_whitespace=True,
        validate_assignment=True,
    )


class SchemaVersion(StrEnum):
    """Version of the transport-neutral HHTools agent schema."""

    V1 = "1.0"


MachineCode = Annotated[
    str,
    Field(
        min_length=1,
        max_length=128,
        pattern=r"^[A-Z][A-Z0-9_]*$",
        description="Stable, English, machine-readable code.",
    ),
]

Sha256Hex = Annotated[
    str,
    Field(pattern=r"^[0-9a-f]{64}$", description="Lower-case SHA-256 content digest."),
]
AssetId = Annotated[
    str,
    Field(pattern=r"^asset:sha256:[0-9a-f]{64}$", description="Content-addressed asset id."),
]
PlanId = Annotated[
    str,
    Field(pattern=r"^plan:sha256:[0-9a-f]{64}$", description="Content-addressed plan id."),
]
CalibrationId = Annotated[
    str,
    Field(pattern=r"^cal:sha256:[0-9a-f]{64}$", description="Content-addressed calibration id."),
]
ArtifactId = Annotated[
    str,
    Field(
        pattern=r"^artifact:[a-z][a-z0-9_-]*:[A-Za-z0-9._~-]+$",
        description="Artifact id with a stable kind namespace.",
    ),
]
ResourceUri = Annotated[
    str,
    Field(
        min_length=1,
        pattern=r"^(?:hhtools|https?)://[^\s]+$",
        description="Controlled HHTools resource or HTTP(S) URI.",
    ),
]


class NextAction(ContractModel):
    """An explicit recovery or continuation step for an agent or human."""

    actor: Literal["agent", "human", "system"]
    action: Annotated[
        str,
        Field(
            min_length=1,
            max_length=128,
            pattern=r"^[a-z][a-z0-9_]*$",
            description="Stable, English action identifier.",
        ),
    ]
    message: str | None = Field(
        default=None,
        description="Optional human-readable instruction.",
    )
    url: str | None = Field(
        default=None,
        description="Optional Web UI or documentation URL for this action.",
    )
    parameters: dict[str, Any] = Field(
        default_factory=dict,
        description="Structured parameters needed to perform the action.",
    )


class ErrorStage(StrEnum):
    """Stable stage in which an API error occurred."""

    REQUEST = "request"
    ASSET_REGISTRATION = "asset_registration"
    ASSET_INSPECTION = "asset_inspection"
    PREFLIGHT = "preflight"
    ADMISSION = "admission"
    EXECUTION = "execution"
    EVALUATION = "evaluation"
    ARTIFACT = "artifact"
    INTERNAL = "internal"


class ApiError(ContractModel):
    """Structured failure that an agent can inspect without parsing prose."""

    schema_version: SchemaVersion = SchemaVersion.V1
    code: MachineCode
    message: Annotated[
        str,
        Field(min_length=1, description="Human-readable, potentially localized explanation."),
    ]
    retryable: bool = False
    stage: ErrorStage
    details: dict[str, Any] = Field(
        default_factory=dict,
        description="Small structured context; large payloads belong in artifacts.",
    )
    next_action: NextAction | None = None
