"""Column-terrain foot clearance used by the interaction-mesh terrain Z-snap."""

from __future__ import annotations

import numpy as np
import pytest

from hhtools.core.scene import TerrainHeightfield
from hhtools.retarget.interaction_mesh.terrain_clearance import (
    column_terrain_distance,
    foot_terrain_clearance,
    terrain_snap_offset,
)

BOX_TOP = 0.6
#: x of the box's side face: node 5 is centred on x = 0.5 and columns are 0.1 m wide.
WALL_X = 0.45


def _box_terrain() -> TerrainHeightfield:
    """10 x 10 nodes, dx = 0.1 m, flat ground at z = 0 for x < 0.45 and a 0.6 m box beyond."""
    hf = np.zeros((10, 10), dtype=np.float32)
    hf[5:, :] = BOX_TOP
    hf_maxmin = np.stack([hf, hf], axis=-1)
    return TerrainHeightfield(hf=hf, hf_maxmin=hf_maxmin, min_point=np.zeros(2), dx=0.1)


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


def test_snap_lowers_floating_clips_only() -> None:
    assert terrain_snap_offset(0.03, 0.05) == pytest.approx(0.05)
    assert terrain_snap_offset(-0.02, -0.3) == 0.0
    assert terrain_snap_offset(0.0, 0.0) == 0.0
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
