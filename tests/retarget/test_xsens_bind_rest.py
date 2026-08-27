# SPDX-FileCopyrightText: Copyright (c) 2026 hhtools contributors
# SPDX-License-Identifier: Apache-2.0
"""Xsens / 100STYLE rest must be bind T-pose, not the bundled hang frame 0."""

from __future__ import annotations

import numpy as np

from hhtools.io.bvh import load_bvh
from hhtools.retarget.calibration.reference import load_reference_pose
from hhtools.retarget.newton_basic.rest_pose import (
    bundled_reference_bvh_path,
    rest_pose_from_bundled_reference,
    rest_pose_from_motion_bind,
)


def _arm_drop(positions, names, side: str) -> float:
    """Shoulder-to-wrist drop along +Z (positive = wrist below shoulder)."""
    sh = positions[names.index(f"{side}Shoulder")]
    wr = positions[names.index(f"{side}Wrist")]
    return float(sh[2] - wr[2])


def test_bundled_xsens_frame0_is_arms_down_but_bind_is_tpose() -> None:
    path = bundled_reference_bvh_path("xsens_mocap")
    assert path is not None
    motion = load_bvh(path)
    names = list(motion.hierarchy.bone_names)

    hang_l = _arm_drop(motion.positions[0], names, "Left")
    hang_r = _arm_drop(motion.positions[0], names, "Right")
    assert hang_l > 0.4
    assert hang_r > 0.4

    bind = rest_pose_from_motion_bind(motion)
    bind_names = list(bind.bone_names)
    bind_l = _arm_drop(bind.positions, bind_names, "Left")
    bind_r = _arm_drop(bind.positions, bind_names, "Right")
    assert abs(bind_l) < 0.15
    assert abs(bind_r) < 0.15


def _torso_pitch_deg(positions, names, chest: str = "Chest4", hips: str = "Hips") -> float:
    hips_p = positions[names.index(hips)]
    chest_p = positions[names.index(chest)]
    v = chest_p - hips_p
    return float(np.degrees(np.arctan2(float(v[0]), float(v[2]))))


def test_bundled_xsens_rest_and_calibration_reference_use_tpose() -> None:
    rest = rest_pose_from_bundled_reference("xsens_mocap")
    names = list(rest.bone_names)
    assert abs(_arm_drop(rest.positions, names, "Left")) < 0.15
    assert rest.source.startswith("bundled_reference:xsens_mocap")
    assert abs(_torso_pitch_deg(rest.positions, names)) < 3.0

    ref = load_reference_pose("xsens_mocap")
    ref_names = list(ref.joint_names)
    left = float(
        ref.positions[ref_names.index("LeftShoulder"), 2]
        - ref.positions[ref_names.index("LeftWrist"), 2]
    )
    assert abs(left) < 0.15


def test_xsens_bind_rest_strips_frame0_root_pitch() -> None:
    """Clip frame-0 pitch must not leak into the scaler rest T-pose."""
    from dataclasses import replace as dc_replace

    from hhtools.core.math import quaternion as Q

    path = bundled_reference_bvh_path("xsens_mocap")
    assert path is not None
    motion = load_bvh(path)
    q_pitch = Q.from_axis_angle(
        np.array([[0.0, 1.0, 0.0]], dtype=np.float32) * np.deg2rad(16.0)
    )
    q0 = np.asarray(motion.quaternions, dtype=np.float32).copy()
    q_b = np.broadcast_to(q_pitch, q0[0].shape)
    q0[0] = Q.normalize(Q.multiply(q_b, q0[0]))
    p0 = np.asarray(motion.positions, dtype=np.float32).copy()
    hips = p0[0, 0].copy()
    p0[0] = hips + Q.rotate(q_b, p0[0] - hips)
    pitched = dc_replace(motion, quaternions=q0, positions=p0)

    bind = rest_pose_from_motion_bind(pitched)
    names = list(bind.bone_names)
    assert abs(_torso_pitch_deg(bind.positions, names)) < 3.0
    assert abs(_arm_drop(bind.positions, names, "Left")) < 0.15

    format_rest = rest_pose_from_bundled_reference("xsens_mocap")
    assert format_rest.bone_names == bind.bone_names
    assert np.allclose(format_rest.positions, bind.positions, atol=2e-3)
