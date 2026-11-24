"""Exports of scene retargets solved against their terrain or objects keep their root height."""

from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "retarget"))

from frax_toy_robot import toy_humanoid_urdf_with_visuals, write_toy_robot  # noqa: E402

from hhtools.core.scene import SceneObject, TerrainHeightfield  # noqa: E402
from hhtools.io.export_bundle import bake_export_root_z  # noqa: E402
from hhtools.retarget.retarget_result import RetargetedMotion  # noqa: E402
from hhtools.robot.foot_geometry import scene_min_mesh_z  # noqa: E402

TERRAIN_Z = -0.03  # the floor the solver put the sole on
ANKLE_Z = 0.2  # source ankle height (source units, before the floor shift)


@pytest.fixture(scope="module")
def robot(tmp_path_factory):
    return write_toy_robot(
        tmp_path_factory.mktemp("robots") / "toy", urdf=toy_humanoid_urdf_with_visuals()
    )


def _scene(robot, *, grounded: bool):
    """A one-frame terrain clip and a solver result with the mesh sole resting on the terrain.

    The source ankle sits ``ANKLE_Z - TERRAIN_Z`` above the terrain, like a real foot joint above
    its sole; aligning the robot sole to that joint is what lifted terrain exports.
    """
    hf = np.full((3, 3), TERRAIN_Z, dtype=np.float32)
    motion = SimpleNamespace(
        name="clip",
        hierarchy=SimpleNamespace(bone_names=("left_ankle",)),
        positions=np.array([[[0.0, 0.0, ANKLE_Z]]]),
        meta={},
        objects=[],
        terrain=TerrainHeightfield(hf, np.stack([hf, hf], -1), [-1.0, -1.0], 1.0),
    )
    sole = scene_min_mesh_z(robot.trimesh_scene())
    assert sole is not None
    q = np.zeros((1, 7 + len(robot.dof_names())), dtype=np.float32)
    q[0, 2], q[0, 6] = TERRAIN_Z - sole, 1.0
    meta = {"smpl_scale": 1.0, "source_z_min": 0.0, "source_terrain_z_offset": 0.0}
    if grounded:
        meta["terrain_grounded"] = True
    ret = RetargetedMotion("clip", q, 30.0, robot.dof_names(), meta=meta)
    return motion, ret


def test_terrain_grounded_result_is_exported_at_its_solved_height(robot) -> None:
    motion, ret = _scene(robot, grounded=True)
    joint_q, lift = bake_export_root_z(robot, ret, source_motion=motion)
    assert lift == 0.0
    np.testing.assert_array_equal(joint_q, ret.joint_q)


def test_result_without_terrain_grounding_keeps_the_overlay_alignment(robot) -> None:
    # Unchanged for solvers that ignore the terrain: the sole goes to the source foot joint.
    motion, ret = _scene(robot, grounded=False)
    _, lift = bake_export_root_z(robot, ret, source_motion=motion)
    assert lift == pytest.approx(ANKLE_Z - TERRAIN_Z, abs=1e-5)


def _object_scene(robot, *, grounded: bool):
    """A one-frame object clip on flat ground: the mesh sole on the floor, the ankle above it."""
    box = SceneObject("box", np.array([[0.3, 0.0, 0.5]]), np.array([[0.0, 0.0, 0.0, 1.0]]))
    motion = SimpleNamespace(
        name="clip",
        hierarchy=SimpleNamespace(bone_names=("left_ankle",)),
        positions=np.array([[[0.0, 0.0, ANKLE_Z]]]),
        meta={},
        objects=[box],
        terrain=None,
    )
    sole = scene_min_mesh_z(robot.trimesh_scene())
    assert sole is not None
    q = np.zeros((1, 7 + len(robot.dof_names())), dtype=np.float32)
    q[0, 2], q[0, 6] = -sole, 1.0
    meta = {"smpl_scale": 1.0, "source_z_min": 0.0}
    if grounded:
        meta["objects_grounded"] = True
    return motion, RetargetedMotion("clip", q, 30.0, robot.dof_names(), meta=meta)


def test_object_grounded_result_is_exported_at_its_solved_height(robot) -> None:
    # The object tracks are exported in the solver frame; moving the robot would move its
    # hands off the object it holds.
    motion, ret = _object_scene(robot, grounded=True)
    joint_q, lift = bake_export_root_z(robot, ret, source_motion=motion)
    assert lift == 0.0
    np.testing.assert_array_equal(joint_q, ret.joint_q)


def test_object_result_without_the_flag_keeps_the_overlay_alignment(robot) -> None:
    motion, ret = _object_scene(robot, grounded=False)
    _, lift = bake_export_root_z(robot, ret, source_motion=motion)
    assert lift == pytest.approx(ANKLE_Z, abs=1e-5)


def test_exported_terrain_carries_the_imputed_heights() -> None:
    # The solve replaces a non-finite height with the tallest finite one; the export must write
    # that surface, not a NaN where the solve saw solid ground.
    from hhtools.io.export_bundle import _scaled_terrain

    hf = np.array([[0.0, 0.1, 0.0], [0.0, np.nan, 0.3], [0.0, 0.0, 0.0]], dtype=np.float32)
    motion = SimpleNamespace(
        terrain=TerrainHeightfield(hf, np.stack([hf, hf], -1), [-1.0, -1.0], 1.0)
    )
    out = _scaled_terrain(motion, 0.5, 0.1)
    assert np.isfinite(out.hf).all() and np.isfinite(out.hf_maxmin).all()
    assert out.hf[1, 1] == pytest.approx((0.3 - 0.1) * 0.5)


@pytest.mark.parametrize("flag", ["terrain_grounded", "objects_grounded"])
@pytest.mark.parametrize("ground_follow", [False, True])
def test_viewer_playback_does_not_lift_a_scene_grounded_result(
    robot, flag: str, ground_follow: bool
) -> None:
    """Playback shows a scene-solved result as solved, like the export (no mesh_z_lift)."""
    from hhtools.io.scene_serialize import serialize_robot_trajectory

    motion, ret = _scene(robot, grounded=True)
    ret.meta.pop("terrain_grounded", None)
    ret.meta[flag] = True
    yellow = np.array([[0.0, 0.0, 1.0]])
    scaled = {"frames": [{"left_ankle": yellow[0].tolist()}]}
    grounded = serialize_robot_trajectory(
        robot, ret, scaled_preview=scaled, ground_follow=ground_follow
    )
    assert {frame["mesh_z_lift"] for frame in grounded["frames"]} == {0.0}

    plain_meta = {k: v for k, v in ret.meta.items() if k != flag}
    plain = RetargetedMotion("clip", ret.joint_q, 30.0, robot.dof_names(), meta=plain_meta)
    if ground_follow:
        return  # control below uses the constant lift only
    lifted = serialize_robot_trajectory(robot, plain, ground_follow=False)
    assert any(abs(frame["mesh_z_lift"]) > 1e-6 for frame in lifted["frames"])
