"""Transport-neutral application services for HHTools clients.

The Web UI, JSON CLI, REST API, and MCP adapter must call this layer rather
than importing one another.  Solver and calibration algorithms stay in their
existing modules; services only discover capabilities and orchestrate them.
"""

from .artifacts import ArtifactStore, ArtifactStoreError, StoredArtifact
from .asset_service import AgentAssetService
from .assets import AssetRegistry, AssetServiceError
from .capabilities import CapabilitiesService
from .job_store import JobStore, JobStoreError, StoredJob, compute_request_fingerprint
from .jobs import (
    JobCancelledError,
    JobExecutionContext,
    JobExecutionError,
    JobExecutionResult,
    JobExecutor,
    JobManager,
    JobManagerError,
)
from .legacy_job_upgrade import (
    DynamicRootLocator,
    LegacyJobUpgradeError,
    LegacyJobUpgradeResult,
    LegacyJobUpgradeService,
    LegacyMigrationReceipt,
)
from .plans import PlanStore, PlanStoreError, compute_plan_id
from .preflight import PreflightService
from .retarget import RetargetService, RetargetServiceError
from .runtime_lease import AgentRuntimeLease, RuntimeLeaseError

__all__ = [
    "AgentAssetService",
    "AgentRuntimeLease",
    "AssetRegistry",
    "AssetServiceError",
    "ArtifactStore",
    "ArtifactStoreError",
    "CapabilitiesService",
    "JobCancelledError",
    "JobExecutionContext",
    "JobExecutionError",
    "JobExecutionResult",
    "JobExecutor",
    "JobManager",
    "JobManagerError",
    "JobStore",
    "JobStoreError",
    "DynamicRootLocator",
    "LegacyJobUpgradeError",
    "LegacyJobUpgradeResult",
    "LegacyJobUpgradeService",
    "LegacyMigrationReceipt",
    "PlanStore",
    "PlanStoreError",
    "PreflightService",
    "RetargetService",
    "RetargetServiceError",
    "RuntimeLeaseError",
    "StoredArtifact",
    "StoredJob",
    "compute_plan_id",
    "compute_request_fingerprint",
]
