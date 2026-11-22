from __future__ import annotations

import pytest

from hhtools.contracts import AssetCategory
from hhtools.services.routing import (
    R2R_BACKENDS,
    backend_for_category,
    category_for_dataset,
    compatible_backends_for_category,
    default_ik_backend,
    default_scene_backend,
    reference_for_dataset,
)


@pytest.mark.parametrize(
    ("dataset", "reference"),
    [
        ("amass", "smpl"),
        ("phuma", "smpl"),
        ("unified_npz", "smpl"),
        ("parc_ms", "smpl"),
        ("motion_x", "smplx"),
        ("omomo", "smplx"),
        ("meshmimic_holosoma", "smplx"),
        ("lafan", "lafan_bvh"),
        ("omnicontact", "lafan_bvh"),
        ("mocap", "mocap_bvh"),
        ("soma", "soma_bvh"),
        ("xsens_mocap", "xsens_mocap"),
        ("gvhmr", "gvhmr"),
        ("kungfu_athlete", "gvhmr"),
        ("glb", "glb"),
    ],
)
def test_dataset_reference_routing_is_centralized(dataset: str, reference: str) -> None:
    assert reference_for_dataset(dataset, ".npz") == reference


@pytest.mark.parametrize(
    ("dataset", "category", "backend"),
    [
        ("amass", AssetCategory.PLAIN_MOTION, "frax"),
        ("omomo", AssetCategory.OBJECT_INTERACTION, "frax"),
        ("parc_ms", AssetCategory.TERRAIN_SCENE, "frax"),
    ],
)
def test_dataset_category_selects_only_declared_compatible_backend(
    dataset: str,
    category: AssetCategory,
    backend: str,
    monkeypatch,
) -> None:
    from hhtools.retarget import frax_backend

    monkeypatch.setattr(frax_backend, "missing_frax_dependencies", lambda: [])
    detected = category_for_dataset(dataset)
    assert detected is category
    assert backend_for_category(detected) == backend


@pytest.mark.parametrize(
    "category", [AssetCategory.OBJECT_INTERACTION, AssetCategory.TERRAIN_SCENE]
)
def test_scene_clips_prefer_frax_and_fall_back_to_interaction_mesh(
    category: AssetCategory,
    monkeypatch,
) -> None:
    from hhtools.retarget import frax_backend

    assert compatible_backends_for_category(category) == ("frax", "interaction_mesh")
    monkeypatch.setattr(frax_backend, "missing_frax_dependencies", lambda: [])
    assert default_scene_backend() == "frax"
    assert backend_for_category(category) == "frax"
    monkeypatch.setattr(frax_backend, "missing_frax_dependencies", lambda: ["frax"])
    assert default_scene_backend() == "interaction_mesh"
    assert backend_for_category(category) == "interaction_mesh"
    # Plain motion is unaffected by the scene rule.
    assert compatible_backends_for_category(AssetCategory.PLAIN_MOTION) == ("frax", "newton")


def test_non_motion_category_has_no_silent_backend_fallback() -> None:
    with pytest.raises(ValueError, match="not retargetable motion"):
        backend_for_category(AssetCategory.ROBOT_MODEL)


def test_plain_motion_prefers_frax_and_keeps_newton_as_fallback() -> None:
    assert compatible_backends_for_category(AssetCategory.PLAIN_MOTION) == ("frax", "newton")
    assert R2R_BACKENDS == ("frax", "newton")


def test_default_ik_backend_falls_back_to_newton_without_frax(monkeypatch) -> None:
    from hhtools.retarget import frax_backend

    monkeypatch.setattr(frax_backend, "missing_frax_dependencies", lambda: [])
    assert default_ik_backend() == "frax"
    monkeypatch.setattr(frax_backend, "missing_frax_dependencies", lambda: ["frax"])
    assert default_ik_backend() == "newton"
