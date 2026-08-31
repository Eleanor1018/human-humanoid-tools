"""Canonical registry for the public Agent JSON Schema surface.

Schema export and MCP resource discovery both use this registry so a new
contract cannot silently appear in one transport but not the other.
"""

from __future__ import annotations

from types import MappingProxyType

from pydantic import BaseModel

from .artifacts import EvaluationReport, FailureReport, JobManifest
from .assets import (
    AssetBundle,
    AssetInspection,
    AssetRegistrationRequest,
    AssetSearchResponse,
)
from .capabilities import CapabilityResponse, RobotListResponse
from .common import ApiError
from .job_spec import JobSpecV2
from .jobs import (
    AgentJobView,
    ArtifactDescriptor,
    ArtifactListResponse,
    JobRetryRequest,
    JobStartRequest,
)
from .migration import (
    LegacyJobUpgradeRequest,
    LegacyJobUpgradeResponse,
    LegacyMigrationReceipt,
)
from .preflight import PreflightResponse, RetargetPreflightRequest

PUBLIC_AGENT_SCHEMAS: MappingProxyType[str, type[BaseModel]] = MappingProxyType(
    {
        "agent-job-view": AgentJobView,
        "api-error": ApiError,
        "artifact": ArtifactDescriptor,
        "artifact-list-response": ArtifactListResponse,
        "asset-bundle": AssetBundle,
        "asset-inspection": AssetInspection,
        "asset-registration-request": AssetRegistrationRequest,
        "asset-search-response": AssetSearchResponse,
        "capabilities": CapabilityResponse,
        "evaluation-report": EvaluationReport,
        "failure-report": FailureReport,
        "job-manifest": JobManifest,
        "job-retry-request": JobRetryRequest,
        "job-start-request": JobStartRequest,
        "job-spec-v2": JobSpecV2,
        "legacy-job-upgrade-request": LegacyJobUpgradeRequest,
        "legacy-job-upgrade-response": LegacyJobUpgradeResponse,
        "legacy-migration-receipt": LegacyMigrationReceipt,
        "preflight-response": PreflightResponse,
        "retarget-preflight-request": RetargetPreflightRequest,
        "robot-list-response": RobotListResponse,
    }
)


__all__ = ["PUBLIC_AGENT_SCHEMAS"]
