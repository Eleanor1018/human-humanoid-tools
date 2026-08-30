from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest

from hhtools.contracts import (
    AssetFileRole,
    AssetInspectionRequest,
    AssetRegistrationRequest,
    ErrorStage,
    InspectionStatus,
)
from hhtools.services.asset_service import AgentAssetService
from hhtools.services.assets import AssetRegistry, AssetServiceError


def _request(relative_path: str) -> AssetRegistrationRequest:
    return AssetRegistrationRequest(
        root_id="motion-library",
        relative_path=relative_path,
    )


def _write_unified_npz(path: Path, *, frame_count: int = 4) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    positions = np.zeros((frame_count, 2, 3), dtype=np.float32)
    quaternions = np.zeros((frame_count, 2, 4), dtype=np.float32)
    quaternions[..., 3] = 1.0
    np.savez(
        path,
        schema_version=np.array("1"),
        name=np.array(path.stem),
        framerate=np.array(30.0),
        up_axis=np.array("Z"),
        source_format=np.array("npz"),
        bone_names=np.array(["root", "joint"]),
        parent_indices=np.array([-1, 0], dtype=np.int32),
        positions=positions,
        quaternions=quaternions,
    )


def test_plain_npz_register_inspect_and_persist_without_host_paths(
    tmp_path: Path,
) -> None:
    library = tmp_path / "private-motion-library"
    primary = library / "bundle" / "nested" / "walk.npz"
    _write_unified_npz(primary)
    data_dir = tmp_path / "agent-state"
    service = AgentAssetService(
        AssetRegistry(data_dir, {"motion-library": library})
    )

    bundle = service.register(_request("bundle"))
    inspection = service.inspect(AssetInspectionRequest(asset_id=bundle.asset_id))

    assert bundle.primary_file == "nested/walk.npz"
    assert bundle.detected is not None
    assert bundle.detected.dataset == "unified_npz"
    assert bundle.detected.reference == "smpl"
    assert bundle.detected.recommended_backend == "newton"
    assert inspection.status is InspectionStatus.VALID
    assert inspection.frame_count == 4
    assert inspection.joint_count == 2

    reopened = AgentAssetService(
        AssetRegistry(data_dir, {"motion-library": lambda: library})
    )
    assert reopened.get(bundle.asset_id) == bundle
    assert reopened.search(dataset="unified_npz").assets == [bundle]
    assert reopened.inspect(
        AssetInspectionRequest(asset_id=bundle.asset_id)
    ).asset_id == bundle.asset_id
    serialized = f"{bundle.model_dump_json()} {inspection.model_dump_json()}"
    assert str(tmp_path) not in serialized
    assert service.allowed_root_ids == ("motion-library",)


def test_registration_translates_every_discovered_sidecar(tmp_path: Path) -> None:
    library = tmp_path / "library"
    bundle_dir = library / "OMOMO" / "sub10_largebox_000"
    bundle_dir.mkdir(parents=True)
    primary = bundle_dir / "sub10_largebox_000.pkl"
    primary.write_bytes(b"opaque pickle bytes are not executed during discovery")
    mesh = bundle_dir / "largebox_cleaned_simplified.obj"
    mesh.write_text("v 0 0 0\n", encoding="utf-8")
    service = AgentAssetService(
        AssetRegistry(tmp_path / "data", {"motion-library": library})
    )

    bundle = service.register(_request("OMOMO/sub10_largebox_000"))

    assert bundle.detected is not None
    assert bundle.detected.dataset == "omomo"
    assert {item.role for item in bundle.files} == {
        AssetFileRole.MOTION,
        AssetFileRole.OBJECT_MESH,
    }
    assert {item.relative_path for item in bundle.files} == {
        primary.name,
        mesh.name,
    }


def test_ambiguous_directory_has_only_relative_candidate_details(
    tmp_path: Path,
) -> None:
    library = tmp_path / "library"
    _write_unified_npz(library / "ambiguous" / "one.npz")
    _write_unified_npz(library / "ambiguous" / "nested" / "two.npz")
    service = AgentAssetService(
        AssetRegistry(tmp_path / "data", {"motion-library": library})
    )

    with pytest.raises(AssetServiceError) as captured:
        service.register(_request("ambiguous"))

    error = captured.value.api_error
    assert error.code == "BUNDLE_AMBIGUOUS"
    assert error.stage is ErrorStage.ASSET_REGISTRATION
    assert error.details == {"candidates": ["nested/two.npz", "one.npz"]}
    assert str(tmp_path) not in str(error.model_dump(mode="json"))


def test_registration_path_errors_are_preserved_without_host_paths(
    tmp_path: Path,
) -> None:
    library = tmp_path / "library"
    library.mkdir()
    outside = tmp_path / "outside.npz"
    _write_unified_npz(outside)
    service = AgentAssetService(
        AssetRegistry(tmp_path / "data", {"motion-library": library})
    )
    request = AssetRegistrationRequest.model_construct(
        root_id="motion-library",
        relative_path="../outside.npz",
        display_name=None,
        kind=None,
        category=None,
        recursive=True,
    )

    with pytest.raises(AssetServiceError) as captured:
        service.register(request)

    assert captured.value.code == "ASSET_OUTSIDE_ALLOWED_ROOT"
    assert str(tmp_path) not in str(captured.value.api_error.model_dump(mode="json"))


def test_inspection_reports_changed_content_as_a_hash_error(tmp_path: Path) -> None:
    library = tmp_path / "library"
    primary = library / "walk.npz"
    _write_unified_npz(primary)
    service = AgentAssetService(
        AssetRegistry(tmp_path / "data", {"motion-library": library})
    )
    bundle = service.register(_request("walk.npz"))
    primary.write_bytes(b"changed after registration")

    inspection = service.inspect(AssetInspectionRequest(asset_id=bundle.asset_id))

    assert inspection.status is InspectionStatus.INVALID
    assert "ASSET_HASH_MISMATCH" in {error.code for error in inspection.errors}
    assert str(tmp_path) not in str(inspection.model_dump(mode="json"))
