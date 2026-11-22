"""Heightfield pair distance away from a single planar facet, and ground-plane rows.

Second-round review of the interaction-mesh terrain work: the gap to a heightfield used to be
right only when the geom sat over one planar facet, and the ground-plane filter could drop the
only floor row.
"""

from __future__ import annotations

import numpy as np
import pytest

mujoco = pytest.importorskip("mujoco")

from test_interaction_mesh_terrain_review import _pose, _scene, _terrain  # noqa: E402

from hhtools.retarget.interaction_mesh import collision as co  # noqa: E402


def _pair(model) -> tuple[int, int]:
    return tuple(
        int(mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_GEOM, name))
        for name in ("hhtools_terrain_hf_geom", "probe_geom")
    )


def _angle_deg(a, b) -> float:
    a, b = np.asarray(a, dtype=float), np.asarray(b, dtype=float)
    c = float(a @ b / (np.linalg.norm(a) * np.linalg.norm(b)))
    return float(np.degrees(np.arccos(np.clip(c, -1.0, 1.0))))


def _query(model, data, threshold=0.05):
    h, r = _pair(model)
    ft = np.zeros(6)
    d = co._hfield_pair_distance(model, data, h, r, threshold, ft)
    return d, ft


def test_gap_to_facet_outside_the_xy_footprint(tmp_path) -> None:
    """The nearest facet is a ramp the sphere's footprint does not overlap."""
    hf = np.zeros((6, 8))
    hf[3:] = 0.6  # x = 0 .. 0.1 rises as z = 6 x; flat on either side
    model, data = _scene(tmp_path, _terrain(hf, dx=0.1, min_point=(-0.2, 0.0)))
    normal = np.array([-6.0, 0.0, 1.0]) / np.sqrt(37.0)
    foot = np.array([0.02, 0.32, 0.12])
    _pose(model, data, foot + 0.07 * normal)  # radius 0.03: true gap 0.04
    d, ft = _query(model, data)
    assert d == pytest.approx(0.04, abs=1e-3)
    assert _angle_deg(ft[3:] - ft[:3], d * normal) < 3.0
    # The terrain witness lies on the real surface.
    assert ft[2] == pytest.approx(6.0 * ft[0], abs=2e-3)  # ft[:3] is the terrain witness


def test_retry_does_not_certify_a_stale_estimate_next_to_a_descending_facet(tmp_path) -> None:
    """4.8 cm above a plateau, with a 45 degree facet inside the bounding box but not under it."""
    hf = np.full((8, 8), 0.25)
    hf[5:] = 0.0  # plateau to x = 1.0, then a 45 degree drop to x = 1.25
    model, data = _scene(tmp_path, _terrain(hf, dx=0.25), size="0.15")
    _pose(model, data, [0.87, 1.20, 0.25 + 0.048 + 0.15])
    d, ft = _query(model, data)
    assert d == pytest.approx(0.048, abs=1e-3)
    assert _angle_deg(ft[3:] - ft[:3], [0, 0, 1]) < 3.0


@pytest.mark.parametrize("gap", [0.04, 0.02])
def test_sphere_gap_on_a_sloped_facet(tmp_path, gap) -> None:
    hf = np.zeros((12, 12))
    hf += 0.25 * np.arange(12)[:, None]  # z = x: 45 degrees
    model, data = _scene(tmp_path, _terrain(hf))
    normal = np.array([-1.0, 0.0, 1.0]) / np.sqrt(2.0)
    foot = np.array([1.375, 1.375, 1.375])
    _pose(model, data, foot + (gap + 0.03) * normal)
    d, ft = _query(model, data)
    assert d == pytest.approx(gap, abs=1e-3)
    assert _angle_deg(ft[3:] - ft[:3], normal) < 3.0
    assert ft[2] == pytest.approx(ft[0], abs=2e-3)  # terrain witness (ft[:3]) on z = x


def test_box_gap_on_a_sloped_facet(tmp_path) -> None:
    """A box tilted to lie flat on a 30 degree facet, lifted off it by 3 cm."""
    slope = np.tan(np.radians(30.0))
    hf = np.zeros((12, 12)) + slope * 0.25 * np.arange(12)[:, None]
    model, data = _scene(tmp_path, _terrain(hf), gtype="box", size="0.04 0.03 0.02")
    normal = np.array([-slope, 0.0, 1.0]) / np.hypot(slope, 1.0)
    foot = np.array([1.375, 1.375, slope * 1.375])
    # Box z axis along the facet normal: rotation about y by the slope angle.
    ang = np.radians(-30.0)
    quat = np.array([np.cos(ang / 2), 0.0, np.sin(ang / 2), 0.0])
    centre = foot + (0.02 + 0.03) * normal
    qpos = np.zeros(model.nq)
    qpos[:3], qpos[3:7] = centre, quat
    data.qpos[:] = qpos
    mujoco.mj_forward(model, data)
    d, ft = _query(model, data)
    assert d == pytest.approx(0.03, abs=1.5e-3)
    assert _angle_deg(ft[3:] - ft[:3], normal) < 3.0


# ---------------------------------------------------------------------------
# Ground plane rows
# ---------------------------------------------------------------------------


def test_plane_row_survives_when_the_heightfield_is_far_above_it(tmp_path) -> None:
    """Terrain minimum +1 m puts the hfield base at +0.5 m: the plane is the only floor."""
    hf = np.ones((8, 8))
    hf[-1, -1] = 1.2
    model, data = _scene(tmp_path, _terrain(hf), ground_z=0.0)
    q = _pose(model, data, [0.6, 0.6, 0.025])  # 5 mm into the plane
    rows, rhs = co.compute_nonpenetration_constraints(model, data, q, threshold=0.05, tolerance=0.0)
    assert len(rows) == 1
    assert rhs[0] == pytest.approx(0.005, abs=1e-4)
    np.testing.assert_allclose(rows[0][:3], [0.0, 0.0, 1.0], atol=1e-4)
