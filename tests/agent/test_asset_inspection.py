from __future__ import annotations

import hashlib
import pickle
from pathlib import Path

import numpy as np
import pytest

from hhtools.contracts import (
    AssetBundle,
    AssetCategory,
    AssetDetected,
    AssetFile,
    AssetFileRole,
    AssetKind,
    InspectionStatus,
)
from hhtools.services import asset_inspection as asset_inspection_module
from hhtools.services.asset_inspection import (
    MotionAssetDiscoveryError,
    MotionAssetInspector,
    discover_primary,
)


def _digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _asset_id(seed: str) -> str:
    return f"asset:sha256:{hashlib.sha256(seed.encode()).hexdigest()}"


def _manifest_file(
    root: Path,
    relative_path: str,
    role: AssetFileRole,
    *,
    required: bool = True,
    missing_hash: str | None = None,
) -> AssetFile:
    path = root.joinpath(*relative_path.split("/"))
    return AssetFile(
        role=role,
        relative_path=relative_path,
        sha256=_digest(path) if path.is_file() else (missing_hash or "0" * 64),
        size_bytes=path.stat().st_size if path.is_file() else 0,
        required=required,
    )


def _bundle(
    root: Path,
    *,
    primary: str,
    category: AssetCategory,
    dataset: str,
    files: list[tuple[str, AssetFileRole]],
) -> AssetBundle:
    return AssetBundle(
        asset_id=_asset_id(primary),
        kind=AssetKind.MOTION_BUNDLE,
        category=category,
        display_name=Path(primary).stem,
        primary_file=primary,
        files=[_manifest_file(root, path, role) for path, role in files],
        detected=AssetDetected(dataset=dataset),
    )


def _write_unified_npz(
    path: Path,
    *,
    positions: np.ndarray | None = None,
    framerate: float = 30.0,
) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    pos = (
        np.asarray(positions, dtype=np.float32)
        if positions is not None
        else np.zeros((3, 2, 3), dtype=np.float32)
    )
    quat = np.zeros((pos.shape[0], pos.shape[1], 4), dtype=np.float32)
    quat[..., 3] = 1.0
    np.savez(
        path,
        schema_version=np.array("1"),
        name=np.array(path.stem),
        framerate=np.array(framerate),
        up_axis=np.array("Z"),
        source_format=np.array("npz"),
        bone_names=np.array([f"joint_{index}" for index in range(pos.shape[1])]),
        parent_indices=np.array([-1, *range(max(0, pos.shape[1] - 1))], dtype=np.int32),
        positions=pos,
        quaternions=quat,
    )


def test_plain_motion_inspection_reads_lightweight_npz_metadata(tmp_path: Path) -> None:
    primary = "unified_npz/walk.npz"
    _write_unified_npz(tmp_path / primary)
    bundle = _bundle(
        tmp_path,
        primary=primary,
        category=AssetCategory.PLAIN_MOTION,
        dataset="unified_npz",
        files=[(primary, AssetFileRole.MOTION)],
    )

    inspection = MotionAssetInspector().inspect(bundle, tmp_path)

    assert inspection.status is InspectionStatus.VALID
    assert inspection.dataset == "unified_npz"
    assert inspection.reference_model == "smpl"
    assert inspection.frame_count == 3
    assert inspection.frame_rate_hz == 30.0
    assert inspection.duration_seconds == pytest.approx(2 / 30)
    assert inspection.joint_count == 2
    assert inspection.has_object is False
    assert inspection.has_terrain is False
    assert inspection.metadata["recommended_backend"] == "newton"
    assert str(tmp_path) not in str(inspection.model_dump(mode="json"))


def test_object_interaction_requires_and_discovers_object_mesh(tmp_path: Path) -> None:
    primary = tmp_path / "OMOMO" / "sub10_largebox_000" / "sub10_largebox_000.pkl"
    primary.parent.mkdir(parents=True)
    with primary.open("wb") as handle:
        pickle.dump({"motion": [[0.0]], "seq_name": primary.stem}, handle)
    mesh = primary.parent / "largebox_cleaned_simplified.obj"
    mesh.write_text("v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n", encoding="utf-8")
    primary_relative = primary.relative_to(tmp_path).as_posix()
    mesh_relative = mesh.relative_to(tmp_path).as_posix()
    bundle = _bundle(
        tmp_path,
        primary=primary_relative,
        category=AssetCategory.OBJECT_INTERACTION,
        dataset="omomo",
        files=[
            (primary_relative, AssetFileRole.MOTION),
            (mesh_relative, AssetFileRole.OBJECT_MESH),
        ],
    )

    discovery = discover_primary(primary.parent)
    inspection = MotionAssetInspector().inspect(bundle, tmp_path)

    assert discovery.primary_path == primary.resolve()
    assert discovery.category is AssetCategory.OBJECT_INTERACTION
    assert discovery.sidecars[AssetFileRole.OBJECT_MESH] == (mesh.resolve(),)
    assert inspection.status is InspectionStatus.VALID_WITH_WARNINGS
    assert inspection.dataset == "omomo"
    assert inspection.reference_model == "smplx"
    assert inspection.has_object is True
    assert inspection.metadata["recommended_backend"] == "interaction_mesh"
    assert inspection.metadata["pickle_executed"] is False
    assert inspection.metadata["content_parsed"] is False
    assert (
        inspection.metadata["content_validation_code"]
        == "CONTENT_REQUIRES_ISOLATED_VALIDATION"
    )


def test_terrain_scene_inspection_keeps_terrain_sidecar_bound_to_bundle(
    tmp_path: Path,
) -> None:
    primary = tmp_path / "parc_ms" / "parkour_1" / "parkour_1.pkl"
    primary.parent.mkdir(parents=True)
    with primary.open("wb") as handle:
        pickle.dump({"motion_data": {}, "terrain_data": {}}, handle)
    terrain = primary.parent / "parkour_1_terrain.obj"
    terrain.write_text("v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n", encoding="utf-8")
    primary_relative = primary.relative_to(tmp_path).as_posix()
    terrain_relative = terrain.relative_to(tmp_path).as_posix()
    bundle = _bundle(
        tmp_path,
        primary=primary_relative,
        category=AssetCategory.TERRAIN_SCENE,
        dataset="parc_ms",
        files=[
            (primary_relative, AssetFileRole.MOTION),
            (terrain_relative, AssetFileRole.TERRAIN_MESH),
        ],
    )

    discovery = discover_primary(primary.parent)
    inspection = MotionAssetInspector().inspect(bundle, tmp_path)

    assert discovery.dataset == "parc_ms"
    assert discovery.reference == "smpl"
    assert discovery.sidecars[AssetFileRole.TERRAIN_MESH] == (terrain.resolve(),)
    assert inspection.status is InspectionStatus.VALID_WITH_WARNINGS
    assert inspection.category is AssetCategory.TERRAIN_SCENE
    assert inspection.has_terrain is True
    assert inspection.metadata["recommended_backend"] == "interaction_mesh"


def test_missing_required_object_sidecar_returns_stable_bundle_error(tmp_path: Path) -> None:
    primary = tmp_path / "OMOMO" / "sub10_largebox_000" / "sub10_largebox_000.pkl"
    primary.parent.mkdir(parents=True)
    with primary.open("wb") as handle:
        pickle.dump({"motion": [[0.0]]}, handle)
    primary_relative = primary.relative_to(tmp_path).as_posix()
    mesh_relative = f"{primary.parent.relative_to(tmp_path).as_posix()}/largebox.obj"
    bundle = _bundle(
        tmp_path,
        primary=primary_relative,
        category=AssetCategory.OBJECT_INTERACTION,
        dataset="omomo",
        files=[
            (primary_relative, AssetFileRole.MOTION),
            (mesh_relative, AssetFileRole.OBJECT_MESH),
        ],
    )

    inspection = MotionAssetInspector().inspect(bundle, tmp_path)

    assert inspection.status is InspectionStatus.INVALID
    assert "BUNDLE_INCOMPLETE" in {error.code for error in inspection.errors}
    assert all(
        str(tmp_path) not in str(error.model_dump(mode="json")) for error in inspection.errors
    )


def test_parc_requires_an_actual_terrain_mesh_not_an_other_sidecar(tmp_path: Path) -> None:
    primary = tmp_path / "parc_ms" / "parkour_1" / "parkour_1.pkl"
    primary.parent.mkdir(parents=True)
    with primary.open("wb") as handle:
        pickle.dump({"motion_data": {}, "terrain_data": {}}, handle)
    other = primary.with_suffix(".npz")
    _write_unified_npz(other)
    primary_relative = primary.relative_to(tmp_path).as_posix()
    other_relative = other.relative_to(tmp_path).as_posix()
    bundle = _bundle(
        tmp_path,
        primary=primary_relative,
        category=AssetCategory.TERRAIN_SCENE,
        dataset="parc_ms",
        files=[
            (primary_relative, AssetFileRole.MOTION),
            (other_relative, AssetFileRole.OTHER),
        ],
    )

    inspection = MotionAssetInspector().inspect(bundle, tmp_path)

    assert inspection.status is InspectionStatus.INVALID
    assert inspection.has_terrain is False
    assert any(
        error.code == "BUNDLE_INCOMPLETE"
        and error.details.get("missing_roles") == [AssetFileRole.TERRAIN_MESH.value]
        for error in inspection.errors
    )


def test_corrupt_motion_content_returns_parse_error_without_exception_text(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    primary = tmp_path / "unified_npz" / "broken.npz"
    primary.parent.mkdir(parents=True)
    primary.write_bytes(b"not a zip archive")
    relative = primary.relative_to(tmp_path).as_posix()
    bundle = _bundle(
        tmp_path,
        primary=relative,
        category=AssetCategory.PLAIN_MOTION,
        dataset="unified_npz",
        files=[(relative, AssetFileRole.MOTION)],
    )
    numpy_load = np.load

    def safe_numpy_load(*args, **kwargs):
        assert kwargs.get("allow_pickle", False) is not True
        return numpy_load(*args, **kwargs)

    monkeypatch.setattr(asset_inspection_module.np, "load", safe_numpy_load)

    inspection = MotionAssetInspector().inspect(bundle, tmp_path)

    assert inspection.status is InspectionStatus.INVALID
    error = next(error for error in inspection.errors if error.code == "MOTION_PARSE_FAILED")
    assert error.details["exception_type"] == "ValueError"
    assert str(tmp_path) not in str(error.model_dump(mode="json"))


def test_nonfinite_motion_values_have_a_distinct_machine_code(tmp_path: Path) -> None:
    primary = tmp_path / "unified_npz" / "nan.npz"
    positions = np.zeros((2, 2, 3), dtype=np.float32)
    positions[1, 0, 2] = np.nan
    _write_unified_npz(primary, positions=positions)
    relative = primary.relative_to(tmp_path).as_posix()
    bundle = _bundle(
        tmp_path,
        primary=relative,
        category=AssetCategory.PLAIN_MOTION,
        dataset="unified_npz",
        files=[(relative, AssetFileRole.MOTION)],
    )

    inspection = MotionAssetInspector().inspect(bundle, tmp_path)

    assert inspection.status is InspectionStatus.INVALID
    assert "MOTION_NONFINITE_VALUES" in {error.code for error in inspection.errors}


def test_content_routing_truth_rejects_declared_dataset_reference_mismatch(
    tmp_path: Path,
) -> None:
    primary = tmp_path / "unified_npz" / "walk.npz"
    _write_unified_npz(primary)
    relative = primary.relative_to(tmp_path).as_posix()
    bundle = _bundle(
        tmp_path,
        primary=relative,
        category=AssetCategory.PLAIN_MOTION,
        dataset="motion_x",
        files=[(relative, AssetFileRole.MOTION)],
    ).model_copy(
        update={
            "detected": AssetDetected(
                dataset="motion_x",
                reference="smplx",
                recommended_backend="interaction_mesh",
            )
        }
    )

    inspection = MotionAssetInspector().inspect(bundle, tmp_path)

    assert inspection.status is InspectionStatus.INVALID
    assert inspection.dataset == "unified_npz"
    assert inspection.reference_model == "smpl"
    mismatch = next(
        error for error in inspection.errors if error.code == "BUNDLE_METADATA_MISMATCH"
    )
    assert set(mismatch.details["mismatches"]) == {
        "dataset",
        "reference",
        "recommended_backend",
    }


def test_directory_discovery_rejects_multiple_logical_clips(tmp_path: Path) -> None:
    _write_unified_npz(tmp_path / "unified_npz" / "one.npz")
    _write_unified_npz(tmp_path / "unified_npz" / "two.npz")

    with pytest.raises(MotionAssetDiscoveryError) as caught:
        discover_primary(tmp_path / "unified_npz")

    assert caught.value.code == "BUNDLE_AMBIGUOUS"
    assert caught.value.candidates == ("one.npz", "two.npz")
