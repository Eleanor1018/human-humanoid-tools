"""Terrain collision geometry used by the interaction-mesh SQP's non-penetration rows.

Each test pins one property the SQP relies on: the compiled MuJoCo ``<hfield>`` sits where
``TerrainHeightfield.hf`` says, the ground plane never rises above the terrain, and the signed
distance to the heightfield is the real gap.
"""

from __future__ import annotations

import numpy as np
import pytest

mujoco = pytest.importorskip("mujoco")

from hhtools.core.scene import TerrainHeightfield  # noqa: E402
from hhtools.retarget.interaction_mesh.collision import (  # noqa: E402
    build_collision_model_with_hfield,
    compute_nonpenetration_constraints,
)

_PROBE_XML = """
<mujoco model="probe">
  <worldbody>
    <body name="probe" pos="0 0 2">
      <freejoint/>
      <geom name="probe_geom" type="{gtype}" size="{size}" contype="1" conaffinity="1"/>
    </body>
  </worldbody>
</mujoco>
"""


def _terrain(hf: np.ndarray, *, min_point=(0.0, 0.0), dx: float = 0.25) -> TerrainHeightfield:
    hf = np.asarray(hf, dtype=np.float32)
    return TerrainHeightfield(
        hf=hf,
        hf_maxmin=np.stack([hf, hf], axis=-1),
        min_point=np.asarray(min_point, dtype=np.float32),
        dx=dx,
    )


def _probe_scene(tmp_path, terrain, *, gtype="sphere", size="0.03", add_ground=False):
    xml = _PROBE_XML.format(gtype=gtype, size=size)
    base = mujoco.MjModel.from_xml_string(xml)
    model, tmp_files = build_collision_model_with_hfield(
        base, tmp_path, terrain, base_xml=xml, add_ground=add_ground,
    )
    for path in tmp_files:
        path.unlink(missing_ok=True)
    return model, mujoco.MjData(model)


def _geom_id(model, name: str) -> int:
    return int(mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_GEOM, name))


def _surface_z(model, data, hf_geom: int, x: float, y: float) -> float:
    depth = mujoco.mj_rayHfield(
        model, data, hf_geom, np.array([x, y, 10.0]), np.array([0.0, 0.0, -1.0]),
    )
    assert depth >= 0.0, f"ray at ({x:.3f}, {y:.3f}) missed the heightfield"
    return 10.0 - depth


def test_hfield_surface_matches_hf_index_layout(tmp_path) -> None:
    # Non-square grid with a single tall node: a transposed or stretched upload
    # moves the tall node and the grid's extent.
    hf = np.zeros((5, 8), dtype=np.float32)
    hf[1, 6] = 0.6
    terrain = _terrain(hf, min_point=(1.0, -0.5), dx=0.25)
    model, data = _probe_scene(tmp_path, terrain)
    mujoco.mj_forward(model, data)
    hf_geom = _geom_id(model, "hhtools_terrain_hf_geom")

    for ix in range(hf.shape[0]):
        for iy in range(hf.shape[1]):
            x = 1.0 + ix * 0.25
            y = -0.5 + iy * 0.25
            assert _surface_z(model, data, hf_geom, x, y) == pytest.approx(
                float(hf[ix, iy]), abs=1e-4,
            ), (ix, iy)


def _place_probe(model, data, z: float, xy=(0.6, 0.6)) -> np.ndarray:
    qpos = np.zeros(model.nq)
    qpos[:3] = (xy[0], xy[1], z)
    qpos[3] = 1.0
    data.qpos[:] = qpos
    mujoco.mj_forward(model, data)
    return qpos


@pytest.mark.parametrize(
    ("gtype", "size", "half_height"),
    [("sphere", "0.03", 0.03), ("box", "0.1 0.05 0.02", 0.02)],
)
@pytest.mark.parametrize("gap", [-0.02, -0.005, 0.0, 0.01, 0.03, 0.045])
def test_hfield_nonpenetration_row_uses_the_real_gap(
    tmp_path, gtype, size, half_height, gap,
) -> None:
    # Flat floor at z = -0.04 with one tall node far from the probe (so the
    # elevation range is non-zero, like any real terrain).
    hf = np.full((12, 12), -0.04, dtype=np.float32)
    hf[11, 11] = 0.5
    model, data = _probe_scene(tmp_path, _terrain(hf), gtype=gtype, size=size)
    qpos = _place_probe(model, data, -0.04 + half_height + gap)

    rows, rhs = compute_nonpenetration_constraints(
        model, data, qpos, threshold=0.05, tolerance=0.002,
    )

    assert len(rows) == 1
    # rhs = -phi - tol, so phi is the signed gap between probe and floor.
    assert -rhs[0] - 0.002 == pytest.approx(gap, abs=1e-3)
    # Lifting the probe opens the gap one-for-one.
    assert rows[0][2] == pytest.approx(1.0, abs=1e-3)


def test_hfield_nonpenetration_ignores_gaps_beyond_threshold(tmp_path) -> None:
    hf = np.full((12, 12), -0.04, dtype=np.float32)
    hf[11, 11] = 0.5
    model, data = _probe_scene(tmp_path, _terrain(hf))
    qpos = _place_probe(model, data, -0.04 + 0.03 + 0.08)

    rows, _ = compute_nonpenetration_constraints(model, data, qpos, threshold=0.05)

    assert rows == []


def test_collision_ground_z_never_rises_above_the_heightfield() -> None:
    from hhtools.retarget.interaction_mesh.collision import collision_ground_z

    assert collision_ground_z(None) == 0.0
    floor = np.full((4, 4), -0.038, dtype=np.float32)
    floor[1, 2] = 0.5
    assert collision_ground_z(_terrain(floor)) == pytest.approx(-0.038)
    assert collision_ground_z(_terrain(np.full((4, 4), 0.2, dtype=np.float32))) == 0.0


def _save_zero_calibration(model) -> str:
    from hhtools.retarget.calibration import RobotRetargetCalibration, save_calibration

    path = model.preset.root_dir / "retarget_calibration_smpl.yaml"
    save_calibration(
        RobotRetargetCalibration(
            robot=model.preset.name,
            reference="smpl",
            calibrated_joint_q={name: 0.0 for name in model.dof_names()},
            notes="terrain collision fixture",
        ),
        path,
    )
    return str(path)


def test_collision_scene_ground_plane_stays_below_the_terrain(
    grounding_robot_pair,
    synthetic_terrain_motion,
) -> None:
    from hhtools.core.grounding import terrain_heightfield_z_offset_world
    from hhtools.retarget.interaction_mesh.mujoco_scene import MujocoScene
    from hhtools.retarget.interaction_mesh.pipeline import InteractionMeshPipeline

    robot = grounding_robot_pair[1]
    motion = synthetic_terrain_motion
    pipe = InteractionMeshPipeline.from_calibration(robot, motion, _save_zero_calibration(robot))
    scene = MujocoScene.from_robot(robot)
    _, _, z_min, scale, _ = pipe.precompute_laplacian_targets(motion, mj_model=scene.model)
    model, _, tmp_files = pipe._build_hard_collision_scene(
        motion, scene.model, z_min, scale, base_xml=scene.mjcf_xml,
    )
    try:
        terrain = motion.terrain.scaled(
            float(scale), z_offset=float(terrain_heightfield_z_offset_world(motion, z_min)),
        )
        # The fixture grounds z = 0 at the lowest joint (the ankles), so the
        # terrain floor ends up below z = 0, as on parc_ms clips.
        assert float(terrain.hf.min()) < 0.0
        plane = _geom_id(model, "hhtools_ground")
        assert float(model.geom_pos[plane][2]) <= float(terrain.hf.min()) + 1e-6
    finally:
        for path in tmp_files:
            path.unlink(missing_ok=True)
