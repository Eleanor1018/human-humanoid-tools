"""Export deterministic JSON Schema snapshots for public agent contracts."""

from __future__ import annotations

import json
from pathlib import Path

from hhtools.contracts import (
    AgentJobView,
    ApiError,
    ArtifactDescriptor,
    AssetBundle,
    AssetInspection,
    AssetRegistrationRequest,
    AssetSearchResponse,
    CapabilityResponse,
    JobSpecV2,
    PreflightResponse,
    RetargetPreflightRequest,
)

SCHEMAS = {
    "agent-job-view": AgentJobView,
    "api-error": ApiError,
    "artifact": ArtifactDescriptor,
    "asset-bundle": AssetBundle,
    "asset-inspection": AssetInspection,
    "asset-registration-request": AssetRegistrationRequest,
    "asset-search-response": AssetSearchResponse,
    "capabilities": CapabilityResponse,
    "job-spec-v2": JobSpecV2,
    "preflight-response": PreflightResponse,
    "retarget-preflight-request": RetargetPreflightRequest,
}


def main() -> None:
    output_dir = Path(__file__).resolve().parents[1] / "docs" / "schemas" / "agent" / "v1"
    output_dir.mkdir(parents=True, exist_ok=True)
    for name, model in SCHEMAS.items():
        payload = model.model_json_schema()
        encoded = json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True)
        (output_dir / f"{name}.schema.json").write_text(encoded + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
