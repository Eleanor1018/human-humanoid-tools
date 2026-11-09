"""Grounding on robots whose URDF root link sits at foot level (Berkeley Humanoid Lite).

Covers the clip floor snap, the calibration's root height and the feet
stabilizer's ground contact, which all read the root / hips-slot link origin as
the pelvis.
"""

from __future__ import annotations

import numpy as np
import pytest

from hhtools.retarget.calibration.calibration import _estimate_robot_pelvis_height_at_q
from hhtools.retarget.clip_ground_snap import (
    measure_clip_min_foot_world_z,
    snap_joint_q_clip_floor,
)
from hhtools.retarget.newton_basic.config import FeetStabilizerConfig
from hhtools.retarget.newton_basic.feet_stabilizer import FeetStabilizer
from hhtools.robot.foot_geometry import pelvis_offset_in_root_frame, scene_min_mesh_z

_INERTIAL = (
    '<inertial><origin xyz="0 0 0"/><mass value="1.0"/>'
    '<inertia ixx="0.01" ixy="0" ixz="0" iyy="0.01" iyz="0" izz="0.01"/></inertial>'
)
_HIP_Z = 0.5
_TRUNK_TOP = 0.85


def _link(name: str, box: str = "", origin: str = "0 0 0") -> str:
    visual = (
        f'<visual name="{name}_visual"><origin xyz="{origin}"/>'
        f'<geometry><box size="{box}"/></geometry></visual>'
        if box
        else ""
    )
    return f'<link name="{name}">{_INERTIAL}{visual}</link>'


def _joint(name: str, parent: str, child: str, xyz: str, *, upper: float = 1.5) -> str:
    return (
        f'<joint name="{name}" type="revolute"><parent link="{parent}"/>'
        f'<child link="{child}"/><origin xyz="{xyz}" rpy="0 0 0"/><axis xyz="0 1 0"/>'
        f'<limit lower="-1.5" upper="{upper}" effort="50" velocity="20"/></joint>'
    )


def _foot_rooted_urdf() -> str:
    """Biped like Berkeley Humanoid Lite: the root ``base`` origin is at sole level.

    At the zero configuration the soles sit on z=0 (the root origin), the hip
    joints at z=0.5 and the trunk spans z=0.55..0.85.
    """
    parts = [_link("base", "0.2 0.3 0.3", "0 0 0.7")]
    for side, s in (("left", 1.0), ("right", -1.0)):
        parts += [
            _link(f"{side}_thigh_link"),
            _link(f"{side}_shin_link"),
            _link(f"{side}_foot_link", "0.15 0.08 0.04", "0.03 0 -0.03"),
            _joint(f"{side}_hip_joint", "base", f"{side}_thigh_link", f"0 {0.1 * s} {_HIP_Z}"),
            _joint(
                f"{side}_knee_joint",
                f"{side}_thigh_link",
                f"{side}_shin_link",
                "0 0 -0.25",
                upper=3.2,
            ),
            _joint(f"{side}_ankle_joint", f"{side}_shin_link", f"{side}_foot_link", "0 0 -0.2"),
        ]
    return '<?xml version="1.0"?>\n<robot name="footroot">' + "".join(parts) + "</robot>\n"


@pytest.fixture(scope="module")
def foot_rooted(tmp_path_factory):
    from hhtools.robot.base import RobotPreset
    from hhtools.robot.loader import load_robot

    root = tmp_path_factory.mktemp("robots") / "footroot"
    root.mkdir(parents=True)
    urdf = root / "footroot.urdf"
    urdf.write_text(_foot_rooted_urdf(), encoding="utf-8")
    ik_map = {"hips": "base"}
    for side in ("left", "right"):
        ik_map[f"{side}_hip"] = f"{side}_thigh_link"
        ik_map[f"{side}_knee"] = f"{side}_shin_link"
        ik_map[f"{side}_ankle"] = f"{side}_foot_link"
    preset = RobotPreset(
        name="footroot",
        display_name="Foot-rooted biped",
        root_dir=root,
        urdf_path=urdf,
        ik_map=ik_map,
        feet={"left_contact_link": "left_foot_link", "right_contact_link": "right_foot_link"},
        dof_order=tuple(
            f"{side}_{j}_joint" for side in ("left", "right") for j in ("hip", "knee", "ankle")
        ),
    )
    return load_robot(preset)


def _lowest_point_z(robot, row: np.ndarray) -> float:
    from hhtools.robot.foot_geometry import quat_xyzw_to_rotmat

    dof = robot.dof_names()
    robot.apply_configuration({n: float(row[7 + i]) for i, n in enumerate(dof)})
    return float(row[2]) + scene_min_mesh_z(robot.trimesh_scene(), quat_xyzw_to_rotmat(row[3:7]))


def test_pelvis_offset_points_at_the_hips_when_root_is_at_foot_level(foot_rooted) -> None:
    offset = pelvis_offset_in_root_frame(foot_rooted)
    assert offset is not None
    np.testing.assert_allclose(offset, [0.0, 0.0, _HIP_Z], atol=1e-9)


def test_pelvis_offset_is_none_for_pelvis_rooted_robots(tmp_path) -> None:
    from frax_toy_robot import write_toy_robot

    assert pelvis_offset_in_root_frame(write_toy_robot(tmp_path / "toy")) is None


def test_snap_keeps_standing_frames_on_the_floor_when_root_is_at_foot_level(
    foot_rooted,
) -> None:
    """Fall-and-get-up shape that sank Berkeley Humanoid Lite ~23 cm.

    The standing frames read "root above sole" ~0 because the root origin is at
    the soles, while an inverted frame with folded legs reads the root 0.5 m
    above its raised soles.  Measuring uprightness from the root origin picked
    that inverted frame as the snap reference and pushed the whole clip 0.35 m
    down.  Measured from the hips, the standing frames are the reference.
    """
    n_dof = len(foot_rooted.dof_names())
    standing = np.zeros((4, 7 + n_dof), dtype=np.float32)
    standing[:, 6] = 1.0
    # Headstand with both knees folded: 180 deg about X, trunk top on the floor.
    inverted = np.zeros((1, 7 + n_dof), dtype=np.float32)
    inverted[0, 2] = _TRUNK_TOP
    inverted[0, 3] = 1.0
    knee_cols = [7 + i for i, n in enumerate(foot_rooted.dof_names()) if "knee" in n]
    inverted[0, knee_cols] = np.pi
    clip = np.concatenate([standing, inverted, standing], axis=0)

    assert _lowest_point_z(foot_rooted, clip[0]) == pytest.approx(0.0, abs=1e-6)
    assert _lowest_point_z(foot_rooted, clip[4]) == pytest.approx(0.0, abs=1e-6)
    # The trap: the inverted frame's root origin sits >= 0.25 m above its soles.
    inverted_sole = measure_clip_min_foot_world_z(foot_rooted, inverted)
    assert inverted_sole == pytest.approx(0.35, abs=1e-3)
    assert _TRUNK_TOP - inverted_sole >= 0.25

    out, delta = snap_joint_q_clip_floor(foot_rooted, clip, root_coord_count=7)

    assert delta == pytest.approx(0.0, abs=1e-6)
    lowest = [_lowest_point_z(foot_rooted, row) for row in out]
    assert min(lowest) > -0.01
    assert lowest[0] == pytest.approx(0.0, abs=1e-6)


def test_calibrated_root_height_goes_negative_when_root_sits_below_the_soles(
    foot_rooted,
) -> None:
    """Bent knees lift the soles above a foot-level root origin.

    Berkeley Humanoid Lite's calibrated pose leaves its ``base`` ~4 cm below the
    soles.  This height used to be floored at 1 mm, which floated every IK
    target by the difference.
    """
    # Knees bent with the ankles counter-rotated so the soles stay flat.
    bend = {"knee": 0.8, "ankle": -0.8}
    q = {n: next((v for k, v in bend.items() if k in n), 0.0) for n in foot_rooted.dof_names()}
    foot_rooted.apply_configuration(q)
    lowest = scene_min_mesh_z(foot_rooted.trimesh_scene())
    assert lowest > 0.01

    height = _estimate_robot_pelvis_height_at_q(foot_rooted, q, "base")

    assert height == pytest.approx(-lowest, abs=1e-6)


def _stabilizer_frames(hips_z: float, feet_z: float, hips_quat=(0.0, 0.0, 0.0, 1.0)):
    eff = np.zeros((3, 3, 7), dtype=np.float32)
    eff[..., 6] = 1.0
    eff[:, 0, 2] = hips_z
    eff[:, 0, 3:7] = hips_quat
    eff[:, 1:, 2] = feet_z
    eff[:, 1, 1] = 0.1
    eff[:, 2, 1] = -0.1
    return eff


def test_stabilizer_grounds_floating_feet_when_hips_target_is_at_foot_level() -> None:
    """Frame-0 BHL targets: hips (``base``) at 0.007 m, ankles floating at 0.097 m.

    Uprightness compares the hips target with the feet.  With the hips target
    at foot level that never reads upright, so the ground contact never pulled
    floating targets down; measured from the hips it does.
    """
    names = ("hips", "left_ankle", "right_ankle")
    cfg = FeetStabilizerConfig(ground_contact_z=0.0, max_ground_correction=0.05)
    floating = _stabilizer_frames(0.007, 0.097)

    unchanged = FeetStabilizer(cfg, joint_names=names).apply(floating)
    np.testing.assert_allclose(unchanged[:, 1:, 2], 0.097, atol=1e-6)

    stab = FeetStabilizer(cfg, joint_names=names, pelvis_offset=np.array([0.0, 0.0, _HIP_Z]))
    grounded = stab.apply(floating)
    np.testing.assert_allclose(grounded[:, 1:, 2], 0.047, atol=1e-6)
    np.testing.assert_allclose(grounded[:, 0, 2], -0.043, atol=1e-6)

    # Upside down, the hips sit below the hips target: not upright, no pull-down.
    inverted = _stabilizer_frames(0.007, 0.097, hips_quat=(1.0, 0.0, 0.0, 0.0))
    np.testing.assert_allclose(stab.apply(inverted)[:, 1:, 2], 0.097, atol=1e-6)
