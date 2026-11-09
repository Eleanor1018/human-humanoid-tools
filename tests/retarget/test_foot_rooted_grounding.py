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
from hhtools.robot.foot_geometry import pelvis_offset_in_link_frame, scene_min_mesh_z

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


def _biped_urdf(hip_z: float) -> str:
    """Biped whose root ``base`` origin sits ``hip_z`` below the hip joints.

    ``hip_z=_HIP_Z`` is rooted at foot level like Berkeley Humanoid Lite: at
    the zero configuration the soles sit on z=0 (the root origin), the hip
    joints at z=0.5 and the trunk spans z=0.55..0.85.  ``hip_z=0`` is the same
    body rooted at the hips.
    """
    parts = [_link("base", "0.2 0.3 0.3", f"0 0 {hip_z + 0.2}")]
    for side, s in (("left", 1.0), ("right", -1.0)):
        parts += [
            _link(f"{side}_thigh_link"),
            _link(f"{side}_shin_link"),
            _link(f"{side}_foot_link", "0.15 0.08 0.04", "0.03 0 -0.03"),
            _joint(f"{side}_hip_joint", "base", f"{side}_thigh_link", f"0 {0.1 * s} {hip_z}"),
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


def _load_biped(root, hip_z: float):
    from hhtools.robot.base import RobotPreset
    from hhtools.robot.loader import load_robot

    root.mkdir(parents=True)
    urdf = root / "biped.urdf"
    urdf.write_text(_biped_urdf(hip_z), encoding="utf-8")
    ik_map = {"hips": "base"}
    for side in ("left", "right"):
        ik_map[f"{side}_hip"] = f"{side}_thigh_link"
        ik_map[f"{side}_knee"] = f"{side}_shin_link"
        ik_map[f"{side}_ankle"] = f"{side}_foot_link"
    preset = RobotPreset(
        name=root.name,
        display_name=root.name,
        root_dir=root,
        urdf_path=urdf,
        ik_map=ik_map,
        feet={"left_contact_link": "left_foot_link", "right_contact_link": "right_foot_link"},
        dof_order=tuple(
            f"{side}_{j}_joint" for side in ("left", "right") for j in ("hip", "knee", "ankle")
        ),
    )
    return load_robot(preset)


@pytest.fixture(scope="module")
def foot_rooted(tmp_path_factory):
    return _load_biped(tmp_path_factory.mktemp("robots") / "footroot", _HIP_Z)


@pytest.fixture(scope="module")
def hip_rooted(tmp_path_factory):
    return _load_biped(tmp_path_factory.mktemp("robots") / "hiproot", 0.0)


def _lowest_point_z(robot, row: np.ndarray) -> float:
    from hhtools.robot.foot_geometry import quat_xyzw_to_rotmat

    dof = robot.dof_names()
    robot.apply_configuration({n: float(row[7 + i]) for i, n in enumerate(dof)})
    return float(row[2]) + scene_min_mesh_z(robot.trimesh_scene(), quat_xyzw_to_rotmat(row[3:7]))


def test_pelvis_offset_points_at_the_hips_when_root_is_at_foot_level(foot_rooted) -> None:
    offset = pelvis_offset_in_link_frame(foot_rooted)
    assert offset is not None
    np.testing.assert_allclose(offset, [0.0, 0.0, _HIP_Z], atol=1e-9)


def test_pelvis_offset_is_none_for_pelvis_rooted_robots(tmp_path, hip_rooted) -> None:
    from frax_toy_robot import write_toy_robot

    assert pelvis_offset_in_link_frame(write_toy_robot(tmp_path / "toy")) is None
    assert pelvis_offset_in_link_frame(hip_rooted) is None


def _scaler_config(robot):
    from hhtools.retarget.calibration.calibration import (
        RobotRetargetCalibration,
        _reference_pose_for_calibration,
        build_scaler_config_soma_style,
    )
    from hhtools.retarget.newton_basic.rest_pose import rest_pose_from_reference

    cal = RobotRetargetCalibration(
        robot=robot.preset.name, reference="smplx", calibrated_joint_q={}
    )
    rest = rest_pose_from_reference(_reference_pose_for_calibration("smplx"))
    return build_scaler_config_soma_style(cal, robot, rest)


def test_calibration_anchors_at_the_hips_when_root_is_at_foot_level(
    foot_rooted, hip_rooted
) -> None:
    """Rooting the same body at its feet must not change its calibration.

    Measured from Berkeley Humanoid Lite's foot-level ``base``, its hip scale
    came out 5.1 with a 0.69 m offset and its ankle scale 0.13.  Anchored at
    the hips, only the root link's own offset (anchor -> ``base``) differs.
    """
    feet, hips = _scaler_config(foot_rooted), _scaler_config(hip_rooted)
    root = feet.root_joint

    assert feet.joint_scales == pytest.approx(hips.joint_scales, abs=1e-5)
    for name, (t_offset, _q) in hips.joint_offsets.items():
        if name != root:
            np.testing.assert_allclose(feet.joint_offsets[name][0], t_offset, atol=1e-5)
    np.testing.assert_allclose(feet.joint_offsets[root][0], [0.0, 0.0, -_HIP_Z], atol=1e-5)
    np.testing.assert_allclose(hips.joint_offsets.get(root, ((0, 0, 0), ()))[0], 0.0, atol=1e-6)
    assert feet.robot_pelvis_height == pytest.approx(_HIP_Z, abs=1e-6)
    assert feet.robot_pelvis_height == pytest.approx(hips.robot_pelvis_height, abs=1e-6)
    assert feet.root_z_offset == pytest.approx(hips.root_z_offset, abs=1e-6)


def test_newton_hips_ground_capsule_starts_at_the_hips(foot_rooted, hip_rooted) -> None:
    """A pelvis capsule from the foot-level ``base`` held BHL ~0.13 m in the air."""
    from hhtools.retarget.newton_basic.ground_collision_bodies import (
        build_ground_collision_bodies_from_ik_map,
    )

    def hips_capsule(robot):
        bodies = build_ground_collision_bodies_from_ik_map(
            dict(robot.preset.ik_map), robot.preset.urdf_path
        )
        return next(b for b in bodies if b["body"] == "base")["capsule"]

    feet, hips = hips_capsule(foot_rooted), hips_capsule(hip_rooted)

    assert hips[0] == [0.0, 0.0, 0.0]
    np.testing.assert_allclose(feet[0], [0.0, 0.0, _HIP_Z], atol=1e-9)
    np.testing.assert_allclose(
        np.subtract(feet[1], feet[0]), np.subtract(hips[1], hips[0]), atol=1e-9
    )
    assert feet[2] == hips[2]


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
