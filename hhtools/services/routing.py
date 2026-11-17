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


#: Plain-motion IK backends in order of preference.  FRAX is the default;
#: Newton is the fallback when the optional FRAX dependencies are missing.
IK_BACKENDS: tuple[str, ...] = ("frax", "newton")

#: Retarget backends that can solve each workflow category, recommended first.
_CATEGORY_BACKENDS: dict[AssetCategory, tuple[str, ...]] = {
    AssetCategory.PLAIN_MOTION: IK_BACKENDS,
    AssetCategory.OBJECT_INTERACTION: ("interaction_mesh",),
    AssetCategory.TERRAIN_SCENE: ("interaction_mesh",),
}


#: Backends the robot-to-robot workflow can execute; the first is the default.
R2R_BACKENDS: tuple[str, ...] = IK_BACKENDS


def compatible_backends_for_category(category: AssetCategory) -> tuple[str, ...]:
    """Return every backend that may solve ``category``; the first is recommended."""

    return _CATEGORY_BACKENDS.get(category, ())


def backend_for_category(category: AssetCategory) -> str:
    """Return the recommended retarget backend for ``category``.

    This is a static preference, independent of what is installed, so it is
    safe to persist as asset metadata.  Use :func:`default_ik_backend` to pick
    the plain-motion backend that can actually run in this install.
    """

    backends = compatible_backends_for_category(category)
    if not backends:
        raise ValueError(f"asset category {category.value!r} is not retargetable motion")
    return backends[0]


def default_ik_backend() -> str:
    """Plain-motion IK backend to run when the caller names none.

    FRAX when its optional dependencies are installed, otherwise Newton; see
    :func:`hhtools.retarget.frax_backend.default_ik_backend`.  Only import
    specs are probed; no solver is imported.
    """

    from hhtools.retarget.frax_backend import default_ik_backend as _default

    return _default()


__all__ = [
    "DATASET_REFERENCE",
    "FORMAT_REFERENCE",
    "IK_BACKENDS",
    "OBJECT_DATASETS",
    "R2R_BACKENDS",
    "TERRAIN_DATASETS",
    "backend_for_category",
    "category_for_dataset",
    "compatible_backends_for_category",
    "default_ik_backend",
    "reference_for_dataset",
]
