"""Regression tests for the interaction-mesh terrain review findings."""

from __future__ import annotations

import numpy as np
import pytest

from hhtools.retarget.calibration import RobotRetargetCalibration, save_calibration
from hhtools.retarget.interaction_mesh.config import InteractionMeshPipelineConfig
from hhtools.retarget.interaction_mesh.pipeline import InteractionMeshPipeline


def _calibration(model) -> str:
    path = model.preset.root_dir / "retarget_calibration_smpl.yaml"
    save_calibration(
        RobotRetargetCalibration(
            robot=model.preset.name,
            reference="smpl",
            calibrated_joint_q={name: 0.0 for name in model.dof_names()},
            notes="terrain review fixture",
        ),
        path,
    )
    return str(path)


def _run(robot, motion, **cfg):
    pipe = InteractionMeshPipeline.from_calibration(
        robot,
        motion,
        _calibration(robot),
        cfg=InteractionMeshPipelineConfig(**cfg),
    )
    return pipe.run(motion)


def test_terrain_clip_without_a_collision_model_keeps_its_root_height(
    grounding_robot_pair,
    synthetic_terrain_motion,
) -> None:
    robot = grounding_robot_pair[1]
    motion = synthetic_terrain_motion
    assert motion.terrain is not None
    baseline = _run(robot, motion, enable_collision=False, clip_floor_snap=False)
    snapped = _run(robot, motion, enable_collision=False, clip_floor_snap=True)
    assert snapped.meta["terrain_floor_offset"] == 0.0
    np.testing.assert_array_equal(snapped.joint_q[:, 2], baseline.joint_q[:, 2])


# ---------------------------------------------------------------------------
# Compiled-model helpers
# ---------------------------------------------------------------------------

mujoco = pytest.importorskip("mujoco")

from hhtools.core.scene import TerrainHeightfield  # noqa: E402
from hhtools.retarget.interaction_mesh.collision import (  # noqa: E402
    build_collision_model_with_hfield,
    compute_nonpenetration_constraints,
)
from hhtools.retarget.interaction_mesh.terrain_clearance import (  # noqa: E402
    column_terrain_distance,
    foot_terrain_clearance,
    terrain_snap_offset,
)


def _terrain(hf, *, min_point=(0.0, 0.0), dx=0.25) -> TerrainHeightfield:
    hf = np.asarray(hf, dtype=np.float32)
    return TerrainHeightfield(
        hf=hf,
        hf_maxmin=np.stack([hf, hf], axis=-1),
        min_point=np.asarray(min_point, dtype=np.float32),
        dx=dx,
    )


_PROBE_XML = """
<mujoco model="probe">
  <worldbody>
    <body name="{body}" pos="0 0 2">
      <freejoint/>
      <geom name="probe_geom" type="{gtype}" size="{size}" contype="1" conaffinity="1"/>
    </body>
  </worldbody>
</mujoco>
"""


def _scene(tmp_path, terrain, *, gtype="sphere", size="0.03", body="probe", ground_z=None):
    xml = _PROBE_XML.format(gtype=gtype, size=size, body=body)
    base = mujoco.MjModel.from_xml_string(xml)
    model, tmp_files = build_collision_model_with_hfield(
        base,
        tmp_path,
        terrain,
        base_xml=xml,
        add_ground=ground_z is not None,
        ground_z=0.0 if ground_z is None else ground_z,
    )
    for path in tmp_files:
        path.unlink(missing_ok=True)
    return model, mujoco.MjData(model)


def _surface_z(model, data, x: float, y: float) -> float:
    gid = int(mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_GEOM, "hhtools_terrain_hf_geom"))
    depth = mujoco.mj_rayHfield(
        model,
        data,
        gid,
        np.array([x, y, 10.0]),
        np.array([0.0, 0.0, -1.0]),
    )
    assert depth >= 0.0
    return 10.0 - depth


def _pose(model, data, xyz) -> np.ndarray:
    qpos = np.zeros(model.nq)
    qpos[:3] = xyz
    qpos[3] = 1.0
    data.qpos[:] = qpos
    mujoco.mj_forward(model, data)
    return qpos


# ---------------------------------------------------------------------------
# Finding 1: signed distance and witness on sloped facets
# ---------------------------------------------------------------------------

_DX = 0.25


def _ramp(slope: float) -> TerrainHeightfield:
    """z = slope * x - 1 on a 12 x 12 grid: every triangle is one plane."""
    heights = slope * _DX * np.arange(12)[:, None] - 1.0 + np.zeros((12, 12))
    return _terrain(heights, dx=_DX)


@pytest.mark.parametrize("slope", [1.0, 0.5])
@pytest.mark.parametrize("gap", [0.04, 0.03, 0.01, -0.01])
def test_ramp_distance_and_normal_are_exact(tmp_path, slope, gap) -> None:
    model, data = _scene(tmp_path, _ramp(slope))
    normal = np.array([-slope, 0.0, 1.0]) / np.hypot(slope, 1.0)
    x0 = 1.375  # mid-cell: well away from every ridge
    foot = np.array([x0, 1.375, slope * x0 - 1.0])
    qpos = _pose(model, data, foot + (gap + 0.03) * normal)

    rows, rhs = compute_nonpenetration_constraints(
        model,
        data,
        qpos,
        threshold=0.05,
        tolerance=0.002,
    )

    assert len(rows) == 1, f"gap {gap}: row dropped"
    assert -rhs[0] - 0.002 == pytest.approx(gap, abs=1e-3)
    np.testing.assert_allclose(rows[0][:3], normal, atol=2e-3)


# ---------------------------------------------------------------------------
# Findings 2 and 4: the Z-snap against the compiled surface, and fine grids
# ---------------------------------------------------------------------------

_FOOT_XML = """
<mujoco model="foot_probe">
  <worldbody>
    <body name="left_foot" pos="0 0 2">
      <freejoint/>
      <geom name="sole" type="box" size="{size}" contype="1" conaffinity="1"/>
    </body>
  </worldbody>
</mujoco>
"""


def _foot_scene(tmp_path, terrain, size, ground_z):
    xml = _FOOT_XML.format(size=size)
    base = mujoco.MjModel.from_xml_string(xml)
    model, tmp_files = build_collision_model_with_hfield(
        base,
        tmp_path,
        terrain,
        base_xml=xml,
        add_ground=True,
        ground_z=ground_z,
    )
    for path in tmp_files:
        path.unlink(missing_ok=True)
    return model, mujoco.MjData(model)


def _snap(model, data, joint_q, terrain, floor_z):
    c = foot_terrain_clearance(model, data, joint_q, terrain, floor_z=floor_z)
    return terrain_snap_offset(c.min_signed_distance, c.min_vertical_clearance)


def test_snap_does_not_sink_a_foot_into_the_ramp_between_nodes(tmp_path) -> None:
    # Node rows x = 0 and x = 0.10 are 0 and 0.60 high.  At x = 0.04 the column top is 0 but
    # the compiled surface is at 0.24.  A level sole over x = 0.02..0.04 with its bottom at
    # 0.27 may only come down 3 cm.
    hf = np.zeros((4, 6))
    hf[1:, :] = 0.6
    terrain = _terrain(hf, dx=0.1)
    model, data = _foot_scene(tmp_path, terrain, "0.01 0.03 0.005", ground_z=0.0)
    mujoco.mj_forward(model, data)
    assert _surface_z(model, data, 0.04, 0.25) == pytest.approx(0.24, abs=1e-3)

    joint_q = np.array([[0.03, 0.25, 0.275, 0.0, 0.0, 0.0, 1.0]])
    offset = _snap(model, data, joint_q, terrain, floor_z=0.0)

    lowered = 0.275 - offset  # sole centre height after the snap
    for x in np.linspace(0.02, 0.04, 9):
        assert lowered - 0.005 >= _surface_z(model, data, x, 0.25) - 1e-3, x
    assert offset == pytest.approx(0.03, abs=2e-3)


def test_snap_over_a_ramp_cell_matches_the_compiled_triangles(tmp_path) -> None:
    # A single raised node makes every touching cell non-planar, so the diagonal matters.
    hf = np.zeros((5, 5))
    hf[2, 2] = 0.4
    terrain = _terrain(hf, dx=0.1)
    model, data = _foot_scene(tmp_path, terrain, "0.01 0.01 0.005", ground_z=0.0)
    mujoco.mj_forward(model, data)
    rng = np.random.default_rng(3)
    for x, y in rng.uniform(0.05, 0.35, size=(25, 2)):
        joint_q = np.array([[x, y, 0.6, 0.0, 0.0, 0.0, 1.0]])
        offset = _snap(model, data, joint_q, terrain, floor_z=0.0)
        surface = max(
            _surface_z(model, data, x + dx, y + dy)
            for dx in (-0.01, 0.0, 0.01)
            for dy in (-0.01, 0.0, 0.01)
        )
        assert 0.6 - offset - 0.005 >= surface - 1e-3, (x, y)


def test_snap_sees_a_column_narrower_than_the_old_sample_spacing(tmp_path) -> None:
    # dx = 1 cm: a one-node column 10 cm tall under a 4 cm sole whose old 2 cm sample
    # grid (x = 0.1925, 0.2125, 0.2325) straddles it.
    hf = np.zeros((40, 40))
    hf[20, 20] = 0.1
    terrain = _terrain(hf, dx=0.01)
    model, data = _foot_scene(tmp_path, terrain, "0.02 0.02 0.005", ground_z=0.0)
    joint_q = np.array([[0.2125, 0.2, 0.155, 0.0, 0.0, 0.0, 1.0]])  # sole bottom at 0.15

    offset = _snap(model, data, joint_q, terrain, floor_z=0.0)

    assert offset == pytest.approx(0.05, abs=1e-3)


# ---------------------------------------------------------------------------
# Finding 5: shared footprint edges at dx = 0.1
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("dx", [0.1, 0.3, 0.7, 0.05])
@pytest.mark.parametrize("reach", [0.1, 0.5])
def test_point_on_a_shared_edge_is_over_the_higher_column_for_any_dx(dx, reach) -> None:
    terrain = _terrain([[0.0], [0.6]], dx=dx, min_point=(0.0, 0.0))
    edge = 0.5 * dx
    _, v = column_terrain_distance(
        np.array([[edge, 0.0, 0.65]]),
        terrain,
        max_distance=reach,
    )
    assert v[0] == pytest.approx(0.05, abs=1e-5)


# ---------------------------------------------------------------------------
# Finding 6: no duplicate ground-plane row inside the heightfield footprint
# ---------------------------------------------------------------------------


def test_floor_contact_inside_the_grid_gets_one_row_not_two(tmp_path) -> None:
    hf = np.full((12, 12), -0.04)
    hf[11, 11] = 0.5
    terrain = _terrain(hf)
    model, data = _scene(tmp_path, terrain, ground_z=-0.04)
    qpos = _pose(model, data, (0.6, 0.6, -0.04 + 0.03 - 0.01))  # 1 cm into the floor
    rows, rhs = compute_nonpenetration_constraints(model, data, qpos, threshold=0.05)
    assert len(rows) == 1
    assert -rhs[0] - 0.002 == pytest.approx(-0.01, abs=1e-3)

    # Off the grid only the ground plane exists, and it still constrains the foot.
    qpos = _pose(model, data, (5.0, 5.0, -0.04 + 0.03 - 0.01))
    rows, rhs = compute_nonpenetration_constraints(model, data, qpos, threshold=0.05)
    assert len(rows) == 1
    assert -rhs[0] - 0.002 == pytest.approx(-0.01, abs=1e-3)


# ---------------------------------------------------------------------------
# Finding 8: non-finite cells
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("bad", [np.nan, -np.inf, np.inf])
def test_clearance_treats_every_non_finite_cell_as_solid(bad) -> None:
    hf = np.zeros((10, 10))
    hf[5:, :] = 0.6
    hf[1, 5] = bad
    d, v = column_terrain_distance(np.array([[0.1, 0.5, 0.5]]), _terrain(hf, dx=0.1))
    assert v[0] == -np.inf
    assert d[0] < 0.0


@pytest.mark.parametrize("bad", [np.nan, -np.inf, np.inf])
def test_collision_scene_survives_non_finite_cells(tmp_path, bad) -> None:
    hf = np.zeros((12, 12))
    hf[3, 4] = bad
    hf[8, 8] = 0.3
    model, data = _scene(tmp_path, _terrain(hf))
    mujoco.mj_forward(model, data)
    # Node (4, 4) is an ordinary floor node; the cell without a height is solid, so the
    # upload puts it at the tallest finite height.
    assert _surface_z(model, data, 1.0, 1.0) == pytest.approx(0.0, abs=1e-4)
    assert _surface_z(model, data, 0.75, 1.0) == pytest.approx(0.3, abs=1e-4)


# ---------------------------------------------------------------------------
# Finding 7: foot-sticking reads the selected point's own source vertex
# ---------------------------------------------------------------------------


def test_foot_sticking_fallback_reads_the_selected_point_not_its_twin() -> None:
    from hhtools.retarget.interaction_mesh.mpc_loop import (
        FrameLaplacianTarget,
        RobotMpcPoint,
        extract_foot_sticking_sequences,
    )

    def point(body, semantic):
        return RobotMpcPoint(body_name=body, local_offset=np.zeros(3), semantic=semantic)

    # After a fixed-joint merge the knee and the ankle sit on one body at offset zero.
    pts = [
        point("pelvis", "pelvis"),
        point("left_ankle_roll_link", "left_knee"),
        point("left_ankle_roll_link", "left_ankle"),
        point("right_ankle_roll_link", "right_knee"),
        point("right_ankle_roll_link", "right_ankle"),
    ]
    nh = len(pts)
    frames = 4
    verts = np.zeros((frames, nh, 3), dtype=np.float32)
    t = np.arange(frames, dtype=np.float32)
    verts[:, 1, 0] = 0.05 * t  # left knee swings, left ankle (vertex 2) is planted
    verts[:, 4, 0] = 0.05 * t  # right ankle swings, right knee (vertex 3) is still
    targets = [
        FrameLaplacianTarget(
            adj_list=[[] for _ in range(nh)],
            target_laplacian=np.zeros((nh, 3), dtype=np.float32),
            source_vertices=verts[f],
            n_human_vertices=nh,
        )
        for f in range(frames)
    ]

    seq = extract_foot_sticking_sequences(targets, pts, velocity_threshold=0.01)

    assert [row["L_Foot"] for row in seq] == [False, True, True, True]
    assert not any(row["R_Foot"] for row in seq)
