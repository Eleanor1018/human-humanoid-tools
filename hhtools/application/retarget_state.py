"""Portable full-resolution retarget state for later GUI and Agent exports."""

from __future__ import annotations

import io
import json

import numpy as np

from hhtools.retarget.retarget_result import RetargetedMotion

_EXPORT_METADATA = ("smpl_scale", "source_z_min", "source_terrain_z_offset", "solver_mode")


def publish_retarget_state(context, retargeted, *, yellow_foot_z=None, export_context=None):
    coordinates = np.asarray(retargeted.joint_q)
    if coordinates.ndim != 2 or not np.isfinite(coordinates).all():
        raise ValueError("Retarget state must contain finite frame-major joint coordinates")
    metadata = {
        key: value.item() if isinstance(value, np.generic) else value
        for key in _EXPORT_METADATA
        if (value := (getattr(retargeted, "meta", {}) or {}).get(key)) is not None
    }
    document = {
        "schema_version": 1,
        "name": str(retargeted.name),
        "sample_rate": float(retargeted.sample_rate),
        "root_coord_count": int(retargeted.root_coord_count),
        "dof_names": list(retargeted.dof_names),
        "meta": metadata,
        "yellow_foot_z": yellow_foot_z,
        "export_context": export_context or {},
    }
    payload = io.BytesIO()
    np.savez_compressed(
        payload,
        joint_q=coordinates,
        metadata=np.asarray(json.dumps(document, allow_nan=False)),
    )
    return context.publish_bytes(
        kind="retarget_state",
        payload=payload.getvalue(),
        format="npz",
        media_type="application/octet-stream",
        metadata={"num_frames": retargeted.num_frames, "sample_rate_hz": retargeted.sample_rate},
    )


def load_retarget_state(path):
    with np.load(path, allow_pickle=False) as archive:
        metadata = json.loads(str(archive["metadata"].item()))
        coordinates = np.asarray(archive["joint_q"])
    if metadata.pop("schema_version", None) != 1:
        raise ValueError("Unsupported retarget state version")
    if coordinates.ndim != 2 or not np.isfinite(coordinates).all():
        raise ValueError("Invalid retarget state coordinates")
    yellow_foot_z = metadata.pop("yellow_foot_z", None)
    export_context = metadata.pop("export_context", {})
    metadata["dof_names"] = tuple(metadata["dof_names"])
    motion = RetargetedMotion(joint_q=coordinates, **metadata)
    if coordinates.shape[1] != motion.root_coord_count + len(motion.dof_names):
        raise ValueError("Retarget state coordinates do not match its joints")
    return motion, yellow_foot_z, export_context
