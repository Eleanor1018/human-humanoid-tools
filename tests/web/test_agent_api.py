from __future__ import annotations

from pathlib import Path

import numpy as np
from fastapi import FastAPI
from fastapi.testclient import TestClient

from hhtools.contracts import (
    ApiError,
    AssetBundle,
    AssetCategory,
    AssetDetected,
    AssetFile,
    AssetFileRole,
    AssetInspection,
    AssetRegistrationRequest,
    AssetSearchResponse,
    CapabilityResponse,
    ErrorStage,
    InspectionStatus,
    SchedulerCapability,
)
from hhtools.robot.registry import clear_cache
from hhtools.services.assets import AssetServiceError
from hhtools.web import server
from hhtools.web.agent_api import router

_DIGEST = "a" * 64
_ASSET_ID = f"asset:sha256:{_DIGEST}"


def _asset_bundle() -> AssetBundle:
    return AssetBundle(
        asset_id=_ASSET_ID,
        kind="motion_bundle",
        category=AssetCategory.PLAIN_MOTION,
        display_name="Walk",
        primary_file="walk.npz",
        files=[
            AssetFile(
                role=AssetFileRole.MOTION,
                relative_path="walk.npz",
                sha256=_DIGEST,
                size_bytes=128,
            )
        ],
        detected=AssetDetected(
            dataset="unified_npz",
            reference="smpl",
            recommended_backend="newton",
        ),
    )


class _FakeCapabilities:
    def get_capabilities(self) -> CapabilityResponse:
        return CapabilityResponse(
            service_version="test",
            scheduler=SchedulerCapability(
                max_running_jobs=0,
                max_queued_jobs=0,
                mode="unlimited",
            ),
            supported_input_formats=["bvh"],
            supported_output_formats=["csv", "pkl"],
            features={"agent_rest": True},
        )


class _FakeAssets:
    allowed_root_ids = ("motion-library",)

    def register(self, request: AssetRegistrationRequest) -> AssetBundle:
        assert request.root_id == "motion-library"
        return _asset_bundle()

    def get(self, asset_id: str) -> AssetBundle:
        if asset_id != _ASSET_ID:
            raise AssetServiceError(
                ApiError(
                    code="ASSET_NOT_FOUND",
                    message="No registered asset has the requested id.",
                    stage=ErrorStage.ASSET_REGISTRATION,
                    details={"asset_id": asset_id},
                )
            )
        return _asset_bundle()

    def search(self, **filters) -> AssetSearchResponse:
        return AssetSearchResponse(
            assets=[_asset_bundle()],
            total=1,
            limit=int(filters["limit"]),
            offset=int(filters["offset"]),
        )

    def inspect(self, request) -> AssetInspection:
        assert request.asset_id == _ASSET_ID
        return AssetInspection(
            asset_id=_ASSET_ID,
            status=InspectionStatus.VALID,
            kind="motion_bundle",
            category=AssetCategory.PLAIN_MOTION,
            source_format="npz",
            dataset="unified_npz",
            reference_model="smpl",
            frame_count=3,
            frame_rate_hz=30.0,
        )


def _agent_app() -> FastAPI:
    app = FastAPI()
    app.state.agent_capabilities_service = _FakeCapabilities()
    app.state.agent_asset_service = _FakeAssets()
    app.include_router(router)
    return app


def test_agent_router_serializes_the_service_contract() -> None:
    response = TestClient(_agent_app()).get("/api/agent/v1/capabilities")

    assert response.status_code == 200
    assert response.json() == {
        "schema_version": "1.0",
        "service_name": "hhtools",
        "service_version": "test",
        "agent_api_version": "v1",
        "backends": [],
        "devices": [],
        "robots": [],
        "scheduler": {
            "max_running_jobs": 0,
            "max_queued_jobs": 0,
            "running": 0,
            "queued": 0,
            "reserved": 0,
            "mode": "unlimited",
            "closed": False,
        },
        "asset_root_ids": [],
        "supported_input_formats": ["bvh"],
        "supported_output_formats": ["csv", "pkl"],
        "features": {"agent_rest": True},
    }


def test_agent_asset_routes_serialize_versioned_contracts() -> None:
    client = TestClient(_agent_app())

    registered = client.post(
        "/api/agent/v1/assets",
        json={
            "schema_version": "1.0",
            "root_id": "motion-library",
            "relative_path": "walk.npz",
        },
    )
    searched = client.get("/api/agent/v1/assets?category=plain_motion&limit=20")
    fetched = client.get(f"/api/agent/v1/assets/{_ASSET_ID}")
    inspected = client.get(f"/api/agent/v1/assets/{_ASSET_ID}/inspect")

    assert registered.status_code == 201
    assert registered.json()["asset_id"] == _ASSET_ID
    assert searched.status_code == 200
    assert searched.json()["assets"][0]["schema_version"] == "1.0"
    assert searched.json()["limit"] == 20
    assert fetched.json()["detected"]["recommended_backend"] == "newton"
    assert inspected.status_code == 200
    assert inspected.json()["status"] == "valid"
    assert inspected.json()["frame_count"] == 3


def test_agent_asset_routes_use_structured_errors_for_input_and_service_failures() -> None:
    client = TestClient(_agent_app())

    invalid = client.post(
        "/api/agent/v1/assets",
        json={"root_id": "motion-library", "relative_path": "../secret.npz"},
    )
    missing = client.get(f"/api/agent/v1/assets/asset:sha256:{'0' * 64}")

    assert invalid.status_code == 422
    assert invalid.json()["schema_version"] == "1.0"
    assert invalid.json()["code"] == "INVALID_PARAMETER"
    assert invalid.json()["stage"] == "request"
    assert missing.status_code == 404
    assert missing.json()["code"] == "ASSET_NOT_FOUND"
    assert "detail" not in missing.json()


def test_full_web_app_registers_agent_api_before_the_static_root(
    tmp_path: Path,
    monkeypatch,
) -> None:
    def local_tmpdir(tag: str) -> Path:
        path = tmp_path / f"runtime-{tag}"
        path.mkdir(parents=True, exist_ok=True)
        return path

    monkeypatch.setattr(server, "_tmpdir", local_tmpdir)
    monkeypatch.setattr(server, "_robot_library_root", lambda: tmp_path / "robots")
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "config"))
    monkeypatch.setenv(
        "HHTOOLS_MOTION_LIBRARY_SETTINGS_PATH",
        str(tmp_path / "motion-library-settings.json"),
    )
    clear_cache()
    source_root = tmp_path / "motions"
    source_root.mkdir()
    positions = np.zeros((2, 1, 3), dtype=np.float32)
    quaternions = np.zeros((2, 1, 4), dtype=np.float32)
    quaternions[..., 3] = 1.0
    np.savez(
        source_root / "walk.npz",
        schema_version=np.array("1"),
        framerate=np.array(30.0),
        bone_names=np.array(["root"]),
        parent_indices=np.array([-1], dtype=np.int32),
        positions=positions,
        quaternions=quaternions,
    )
    app = server.create_app(
        source_root=source_root,
        save_dir=tmp_path / "save",
        cache_dir=tmp_path / "cache",
        job_history_dir=tmp_path / "history",
        job_settings_path=tmp_path / "job-settings.json",
    )

    with TestClient(app) as client:
        response = client.get("/api/agent/v1/capabilities")
        registered = client.post(
            "/api/agent/v1/assets",
            json={"root_id": "source", "relative_path": "walk.npz"},
        )
        inspected = client.get(
            f"/api/agent/v1/assets/{registered.json()['asset_id']}/inspect"
        )

    assert response.status_code == 200
    payload = response.json()
    assert payload["schema_version"] == "1.0"
    assert payload["scheduler"]["mode"] == "unlimited"
    assert payload["scheduler"]["max_running_jobs"] == 0
    assert payload["features"]["agent_rest"] is True
    assert payload["features"]["asset_registry"] is True
    assert payload["features"]["asset_inspection"] is True
    assert payload["asset_root_ids"] == ["motion-library", "source"]
    assert "source_root" not in payload
    assert "save_dir" not in payload
    assert registered.status_code == 201
    assert inspected.status_code == 200
    assert inspected.json()["status"] == "valid"
    assert str(tmp_path) not in registered.text
    assert str(tmp_path) not in inspected.text
    clear_cache()
