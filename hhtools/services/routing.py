"""Pure routing rules shared by asset inspection and retarget preflight.

This module intentionally has no Web, solver, Torch, MuJoCo, Newton, or Warp
imports.  Dataset interpretation must have one source of truth so inspection,
preflight, CLI, REST, and MCP cannot silently select different references or
drop scene inputs by choosing an incompatible backend.
"""

from __future__ import annotations

from hhtools.contracts import AssetCategory

DATASET_REFERENCE: dict[str, str] = {
    "amass": "smpl",
    "motion_x": "smplx",
    "phuma": "smpl",
    "lafan": "lafan_bvh",
    "mocap": "mocap_bvh",
    "soma": "soma_bvh",
    "xsens_mocap": "xsens_mocap",
    "gvhmr": "gvhmr",
    "kungfu_athlete": "gvhmr",
    "omomo": "smplx",
    "omnicontact": "lafan_bvh",
    "meshmimic_holosoma": "smplx",
    "glb": "glb",
    "unified_npz": "smpl",
    "parc_ms": "smpl",
}

FORMAT_REFERENCE: dict[str, str] = {
    ".bvh": "lafan_bvh",
    ".csv": "smpl",
    ".glb": "glb",
    ".gltf": "glb",
    ".npy": "smplx",
    ".npz": "smpl",
    ".pickle": "smplx",
    ".pkl": "smplx",
    ".pt": "gvhmr",
    ".pth": "gvhmr",
}

OBJECT_DATASETS = frozenset({"omomo", "omnicontact"})
TERRAIN_DATASETS = frozenset({"meshmimic_holosoma", "parc_ms"})


def category_for_dataset(dataset: str) -> AssetCategory:
    """Return the workflow category for a normalized dataset identifier."""

    if dataset in OBJECT_DATASETS:
        return AssetCategory.OBJECT_INTERACTION
    if dataset in TERRAIN_DATASETS:
        return AssetCategory.TERRAIN_SCENE
    return AssetCategory.PLAIN_MOTION


def reference_for_dataset(dataset: str, suffix: str) -> str:
    """Return the canonical human reference used for calibration selection."""

    return DATASET_REFERENCE.get(dataset, FORMAT_REFERENCE.get(suffix.lower(), "smpl"))


#: Retarget backends that can solve each workflow category, recommended first.
_CATEGORY_BACKENDS: dict[AssetCategory, tuple[str, ...]] = {
    AssetCategory.PLAIN_MOTION: ("newton", "frax"),
    AssetCategory.OBJECT_INTERACTION: ("interaction_mesh",),
    AssetCategory.TERRAIN_SCENE: ("interaction_mesh",),
}


#: Backends the robot-to-robot workflow can execute; the first is the default.
R2R_BACKENDS: tuple[str, ...] = ("newton", "frax")


def compatible_backends_for_category(category: AssetCategory) -> tuple[str, ...]:
    """Return every backend that may solve ``category``; the first is recommended."""

    return _CATEGORY_BACKENDS.get(category, ())


def backend_for_category(category: AssetCategory) -> str:
    """Return the recommended retarget backend for ``category``."""

    if category is AssetCategory.PLAIN_MOTION:
        return "newton"
    if category in {AssetCategory.OBJECT_INTERACTION, AssetCategory.TERRAIN_SCENE}:
        return "interaction_mesh"
    raise ValueError(f"asset category {category.value!r} is not retargetable motion")


__all__ = [
    "DATASET_REFERENCE",
    "R2R_BACKENDS",
    "FORMAT_REFERENCE",
    "OBJECT_DATASETS",
    "TERRAIN_DATASETS",
    "backend_for_category",
    "compatible_backends_for_category",
    "category_for_dataset",
    "reference_for_dataset",
]
