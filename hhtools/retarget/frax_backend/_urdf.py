"""Small URDF helpers shared by the FRAX model and collision code (no frax import)."""

from __future__ import annotations

import xml.etree.ElementTree as ET
from pathlib import Path

import numpy as np
from numpy.typing import NDArray

__all__ = ["origin_transform", "zero_pose_link_transforms"]


def origin_transform(joint: ET.Element) -> NDArray[np.float64]:
    """4x4 transform of a URDF joint's ``<origin>`` (parent link → joint frame)."""
    from scipy.spatial.transform import Rotation

    T = np.eye(4)
    origin = joint.find("origin")
    if origin is not None:
        T[:3, 3] = [float(x) for x in origin.get("xyz", "0 0 0").split()]
        rpy = [float(x) for x in origin.get("rpy", "0 0 0").split()]
        T[:3, :3] = Rotation.from_euler("xyz", rpy).as_matrix()
    return T


def zero_pose_link_transforms(urdf: Path | ET.Element) -> dict[str, NDArray[np.float64]]:
    """World transform of every link with all joints at zero and the root at identity."""
    root = ET.parse(urdf).getroot() if isinstance(urdf, Path | str) else urdf
    joint_of_child = {
        j.find("child").get("link"): j for j in root.findall("joint") if j.find("child") is not None
    }
    out: dict[str, NDArray[np.float64]] = {}

    def world(link: str, depth: int = 0) -> NDArray[np.float64]:
        if link in out:
            return out[link]
        joint = joint_of_child.get(link)
        if joint is None or depth > 512:
            T = np.eye(4)
        else:
            T = world(joint.find("parent").get("link"), depth + 1) @ origin_transform(joint)
        out[link] = T
        return T

    for link_el in root.findall("link"):
        world(link_el.get("name"))
    return out
