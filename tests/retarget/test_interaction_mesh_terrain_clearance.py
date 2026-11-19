"""Column-terrain foot clearance used by the interaction-mesh terrain Z-snap."""

from __future__ import annotations

import numpy as np
import pytest

from hhtools.core.scene import TerrainHeightfield
from hhtools.retarget.interaction_mesh.terrain_clearance import (
    FootTerrainClearance,
    column_terrain_distance,
    foot_terrain_clearance,
    geom_sample_points,
    terrain_snap_offset,
)

BOX_TOP = 0.6
#: x of the box's side face: node 5 is centred on x = 0.5 and columns are 0.1 m wide.
WALL_X = 0.45


def _grid(hf, dx: float) -> TerrainHeightfield:
    hf = np.asarray(hf, dtype=np.float32)
    return TerrainHeightfield(
        hf=hf, hf_maxmin=np.stack([hf, hf], axis=-1), min_point=np.zeros(2), dx=dx
    )


def _box_terrain() -> TerrainHeightfield:
    """10 x 10 nodes, dx = 0.1 m, flat ground at z = 0 for x < 0.45 and a 0.6 m box beyond."""
    hf = np.zeros((10, 10))
    hf[5:, :] = BOX_TOP
    return _grid(hf, 0.1)


@pytest.mark.parametrize(
    ("point", "signed", "vertical"),
    [
        # Beside the box, below its top: the horizontal gap to the side, not "under the top".
        ((WALL_X - 0.03, 0.5, 0.3), 0.03, 0.3),
        # Diagonally off the box's top edge.
        ((WALL_X - 0.03, 0.5, BOX_TOP + 0.04), 0.05, BOX_TOP + 0.04),
        # Above the box top and above the ground far from the box.
        ((0.7, 0.5, BOX_TOP + 0.05), 0.05, 0.05),
        ((0.1, 0.5, 0.04), 0.04, 0.04),
        # Inside the box: the shorter way out, sideways near the side, upwards near the top.
        ((WALL_X + 0.03, 0.5, 0.3), -0.03, -0.3),
        ((0.8, 0.5, BOX_TOP - 0.02), -0.02, -0.02),
        # Off the heightfield the ground plane is the only terrain.
        ((-0.3, 0.5, 0.05), 0.05, 0.05),
        ((-0.3, 0.5, -0.02), -0.02, -0.02),
    ],
)
def test_column_distance_measures_each_point_at_its_own_xy(point, signed, vertical) -> None:
    d, v = column_terrain_distance(np.array([point]), _box_terrain())
    assert d[0] == pytest.approx(signed, abs=1e-6)
    assert v[0] == pytest.approx(vertical, abs=1e-6)


def test_column_distance_is_exact_within_max_distance_and_clipped_beyond() -> None:
    point = np.array([[0.2, 0.5, 0.5]])  # 0.25 m from the box side, 0.5 m above the ground
    near, _ = column_terrain_distance(point, _box_terrain(), max_distance=0.1)
    far, _ = column_terrain_distance(point, _box_terrain(), max_distance=0.3)
    assert near[0] == pytest.approx(0.1)
    assert far[0] == pytest.approx(0.25)


def _brute_force_distance(points, terrain, floor_z=0.0):
    """Signed distance to the column terrain, searching every column (reference)."""
    pad = 3
    heights = np.pad(
        np.maximum(terrain.hf.astype(np.float64), floor_z), pad, constant_values=floor_z
    )
    origin = terrain.min_point.astype(np.float64) - pad * terrain.dx
    xs = origin[0] + terrain.dx * np.arange(heights.shape[0])
    ys = origin[1] + terrain.dx * np.arange(heights.shape[1])
    lx = np.maximum(np.abs(points[:, 0, None] - xs) - 0.5 * terrain.dx, 0.0)
    ly = np.maximum(np.abs(points[:, 1, None] - ys) - 0.5 * terrain.dx, 0.0)
    rho = np.hypot(lx[:, :, None], ly[:, None, :])
    s = points[:, 2, None, None] - heights
    under = np.where(rho == 0.0, heights, floor_z).max(axis=(1, 2))  # top of the column below
    d_out = np.minimum(points[:, 2] - floor_z, np.hypot(rho, np.maximum(s, 0.0)).min(axis=(1, 2)))
    d_in = np.minimum(under - points[:, 2], np.hypot(rho, np.maximum(-s, 0.0)).min(axis=(1, 2)))
    return np.where(points[:, 2] < under, -d_in, d_out)


def test_column_distance_matches_a_search_over_every_column() -> None:
    rng = np.random.default_rng(0)
    hf = rng.choice([0.0, 0.2, 0.45, 0.7], size=(8, 6)).astype(np.float32)
    terrain = TerrainHeightfield(
        hf=hf,
        hf_maxmin=np.stack([hf, hf], axis=-1),
        min_point=np.array([0.3, -0.2]),
        dx=0.1,
    )
    points = rng.uniform([-0.1, -0.6, -0.05], [1.4, 0.8, 0.8], size=(4000, 3))
    reach = 0.15
    got, _ = column_terrain_distance(points, terrain, max_distance=reach)
    want = np.clip(_brute_force_distance(points, terrain), -reach, reach)
    np.testing.assert_allclose(got, want, atol=1e-9)


def test_point_on_a_shared_footprint_edge_is_over_the_higher_column() -> None:
    # dx = 1 is exact in binary, so these points lie exactly on footprint boundaries.
    face = _grid([[0.0], [1.0]], 1.0)  # columns at x = 0 (0 m) and x = 1 (1 m) meet at x = 0.5
    for reach in (0.1, 1.5):  # the padding, and with it how the tie rounds, depends on reach
        d, v = column_terrain_distance(np.array([[0.5, 0.0, 1.05]]), face, max_distance=reach)
        assert v[0] == pytest.approx(0.05)
        assert d[0] == pytest.approx(0.05)
        assert terrain_snap_offset(d[0], v[0]) == pytest.approx(0.05)
    corner = _grid([[0.0, 0.0], [0.0, 1.0]], 1.0)  # four cells meet at (0.5, 0.5)
    d, v = column_terrain_distance(np.array([[0.5, 0.5, 1.05], [0.5, 0.5, 0.5]]), corner)
    np.testing.assert_allclose(v, [0.05, -0.5])
    np.testing.assert_allclose(d, [0.05, 0.0], atol=1e-12)  # on the tall column's edge


def test_unmeasurable_points_and_frames_block_the_snap() -> None:
    pts = np.array([[np.nan, 0.5, 0.3], [0.1, 0.5, 0.04]])
    d, v = column_terrain_distance(pts, _box_terrain())
    assert np.isnan(d[0]) and np.isnan(v[0])
    assert d[1] == pytest.approx(0.04) and v[1] == pytest.approx(0.04)
    c = FootTerrainClearance(np.array([0.05, np.nan]), np.array([0.05, np.nan]))
    assert terrain_snap_offset(c.min_signed_distance, c.min_vertical_clearance) == 0.0


def test_cells_without_a_height_count_as_solid() -> None:
    terrain = _box_terrain()
    terrain.hf[1, 5] = np.nan  # the cell under (0.1, 0.5)
    d, v = column_terrain_distance(np.array([[0.1, 0.5, 0.5]]), terrain)
    assert v[0] == -np.inf
    assert d[0] == pytest.approx(-0.05)  # sideways out to a neighbouring floor column


def test_snap_lowers_floating_clips_only() -> None:
    assert terrain_snap_offset(0.03, 0.05) == pytest.approx(0.05)
    assert terrain_snap_offset(-0.02, -0.3) == 0.0
    assert terrain_snap_offset(0.0, 0.0) == 0.0
    assert terrain_snap_offset(0.02, -0.03) == 0.0  # inconsistent inputs never lift
    assert terrain_snap_offset(float("nan"), float("nan")) == 0.0


_FOOT_MJCF = """
<mujoco>
  <worldbody>
    <body name="left_foot">
      <freejoint/>
      <geom type="box" size="0.05 0.03 0.01" pos="-0.12 0 0" contype="1" conaffinity="1"/>
    </body>
  </worldbody>
</mujoco>
"""


def test_foot_beside_a_box_with_its_origin_over_the_box_is_clear() -> None:
    """Body origin over the box, sole box geom beside it: neither penetrating nor lifted."""
    mujoco = pytest.importorskip("mujoco")
    model = mujoco.MjModel.from_xml_string(_FOOT_MJCF)
    data = mujoco.MjData(model)
    # Root over the box (x = 0.5); the geom spans x in [0.33, 0.43], 2 cm short of the side.
    # Sole bottom 3 cm above the ground in frame 0 and 5 cm in frame 1.
    joint_q = np.array(
        [[0.5, 0.5, 0.04, 0.0, 0.0, 0.0, 1.0], [0.5, 0.5, 0.06, 0.0, 0.0, 0.0, 1.0]],
    )
    c = foot_terrain_clearance(model, data, joint_q, _box_terrain())
    np.testing.assert_allclose(c.vertical_clearance, [0.03, 0.05], atol=1e-6)
    np.testing.assert_allclose(c.signed_distance, [0.02, 0.02], atol=1e-6)
    assert terrain_snap_offset(c.min_signed_distance, c.min_vertical_clearance) == pytest.approx(
        0.03
    )

    # Shift the foot 3 cm into the box side in frame 1: no snap at all, in either direction.
    joint_q[1, 0] += 0.03
    c = foot_terrain_clearance(model, data, joint_q, _box_terrain())
    assert c.signed_distance[1] == pytest.approx(-0.01, abs=1e-6)
    assert terrain_snap_offset(c.min_signed_distance, c.min_vertical_clearance) == 0.0


_HINGED_FOOT_MJCF = """
<mujoco>
  <worldbody>
    <body name="pelvis">
      <freejoint/>
      <inertial pos="0 0 0" mass="1" diaginertia="0.1 0.1 0.1"/>
      <body name="left_ankle_link">
        <joint name="ankle_pitch" type="hinge" axis="0 1 0"/>
        <geom type="box" size="0.05 0.03 0.01" pos="-0.12 0 0"/>
      </body>
    </body>
  </worldbody>
</mujoco>
"""


def test_root_rotation_and_hinges_reach_the_foot_points() -> None:
    """Expected values worked out by hand for a yawed root and a pitched ankle."""
    mujoco = pytest.importorskip("mujoco")
    model = mujoco.MjModel.from_xml_string(_HINGED_FOOT_MJCF)
    data = mujoco.MjData(model)
    s = np.sqrt(0.5)
    # Root at (0.4, 0.5, 0.2) yawed 90 deg (quat xyzw), ankle at 0 and at +90 deg.
    joint_q = np.array(
        [
            [0.4, 0.5, 0.2, 0.0, 0.0, s, s, 0.0],
            [0.4, 0.5, 0.2, 0.0, 0.0, s, s, 0.5 * np.pi],
        ]
    )
    c = foot_terrain_clearance(model, data, joint_q, _box_terrain())
    # Frame 0: box centre (0.4, 0.38, 0.2), world half-extents (0.03, 0.05, 0.01).
    # Frame 1: the ankle turns the box upright, centre (0.4, 0.5, 0.32), half-extents
    # (0.03, 0.01, 0.05).  In both frames it ends at x = 0.43, 2 cm short of the box side.
    np.testing.assert_allclose(c.vertical_clearance, [0.19, 0.27], atol=1e-6)
    np.testing.assert_allclose(c.signed_distance, [0.02, 0.02], atol=1e-6)


_MESH_SOLE_MJCF = """
<mujoco>
  <asset>
    <mesh name="dummy" vertex="0 0 0  0.1 0 0  0 0.1 0  0 0 0.1"/>
    <mesh name="sole" vertex="-0.1 -0.05 0  0.1 -0.05 0  0.1 0.05 0  -0.1 0.05 0
                              -0.1 -0.05 0.02  0.1 -0.05 0.02  0.1 0.05 0.02  -0.1 0.05 0.02"/>
  </asset>
  <worldbody>
    <body name="pelvis">
      <freejoint/>
      <geom type="mesh" mesh="dummy" contype="0" conaffinity="0"/>
      <body name="left_foot">
        <geom type="mesh" mesh="sole"/>
      </body>
    </body>
  </worldbody>
</mujoco>
"""


def test_flat_mesh_sole_over_a_narrow_column_is_not_lowered_through_it() -> None:
    """Every hull vertex of the sole is over the floor; only face samples see the column."""
    mujoco = pytest.importorskip("mujoco")
    model = mujoco.MjModel.from_xml_string(_MESH_SOLE_MJCF)
    data = mujoco.MjData(model)
    foot_body = model.body("left_foot").id
    foot_geom = next(g for g in range(model.ngeom) if model.geom_bodyid[g] == foot_body)
    assert int(model.mesh_vertadr[model.geom_dataid[foot_geom]]) > 0  # mesh-local offsets
    hf = np.zeros((20, 20))
    hf[10, 10] = 0.1  # a 5 cm wide, 10 cm tall column at (0.5, 0.5)
    terrain = _grid(hf, 0.05)
    # Sole spans x in [0.4, 0.6], y in [0.45, 0.55], bottom at z = 0.15.
    joint_q = np.array([[0.5, 0.5, 0.15, 0.0, 0.0, 0.0, 1.0]])
    c = foot_terrain_clearance(model, data, joint_q, terrain)
    assert c.vertical_clearance[0] == pytest.approx(0.05, abs=1e-6)
    assert c.signed_distance[0] == pytest.approx(0.05, abs=1e-6)
    assert terrain_snap_offset(c.min_signed_distance, c.min_vertical_clearance) == pytest.approx(
        0.05, abs=1e-6
    )


_PRIMITIVES_MJCF = """
<mujoco>
  <worldbody>
    <body name="left_foot">
      <geom name="sphere" type="sphere" size="0.1"/>
      <geom name="capsule" type="capsule" size="0.02 0.1"/>
      <geom name="cylinder" type="cylinder" size="0.05 0.03"/>
    </body>
  </worldbody>
</mujoco>
"""


def _random_rotations(n: int) -> np.ndarray:
    q = np.random.default_rng(1).normal(size=(n, 4))
    q /= np.linalg.norm(q, axis=1, keepdims=True)
    w, x, y, z = q.T
    return np.stack(
        [
            np.stack([1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)], -1),
            np.stack([2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)], -1),
            np.stack([2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)], -1),
        ],
        axis=1,
    )


def test_primitive_samples_lie_on_the_surface_and_reach_its_lowest_point() -> None:
    mujoco = pytest.importorskip("mujoco")
    model = mujoco.MjModel.from_xml_string(_PRIMITIVES_MJCF)
    rots = _random_rotations(200)
    tol = 1e-3 + 1e-9

    sphere = geom_sample_points(model, model.geom("sphere").id)
    np.testing.assert_allclose(np.linalg.norm(sphere, axis=1), 0.1)
    low = (sphere @ rots.transpose(0, 2, 1))[..., 2].min(axis=1)  # lowest sample per rotation
    assert np.all(low <= -0.1 + tol)

    capsule = geom_sample_points(model, model.geom("capsule").id)
    axial = np.clip(capsule[:, 2], -0.1, 0.1)
    to_axis = np.linalg.norm(capsule - np.stack([0 * axial, 0 * axial, axial], 1), axis=1)
    np.testing.assert_allclose(to_axis, 0.02)  # on the surface, none inside
    low = (capsule @ rots.transpose(0, 2, 1))[..., 2].min(axis=1)
    lowest = -(0.1 * np.abs(rots[:, 2, 2]) + 0.02)
    assert np.all(low <= lowest + tol)

    cylinder = geom_sample_points(model, model.geom("cylinder").id)
    low = (cylinder @ rots.transpose(0, 2, 1))[..., 2].min(axis=1)
    a_z = rots[:, 2, 2]  # world z component of the cylinder axis
    lowest = -(0.03 * np.abs(a_z) + 0.05 * np.sqrt(1.0 - a_z**2))
    assert np.all(low <= lowest + tol)
    assert np.all(low >= lowest - 1e-9)
