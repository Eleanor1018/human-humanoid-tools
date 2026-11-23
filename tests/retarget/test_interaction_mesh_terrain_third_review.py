"""Third-round review of the interaction-mesh terrain work.

Spheres beside the outer rim of a flat field, rotated fields, the ground-plane filter's moment
arm, non-finite poses in the Z-snap, and MuJoCo's cell diagonal.
"""

from __future__ import annotations

from types import SimpleNamespace

import numpy as np
import pytest

mujoco = pytest.importorskip("mujoco")

from test_interaction_mesh_terrain_collision_limits import _pair, _query  # noqa: E402
from test_interaction_mesh_terrain_review import (  # noqa: E402
    _foot_scene,
    _pose,
    _scene,
    _terrain,
)

from hhtools.retarget.interaction_mesh import collision as co  # noqa: E402
from hhtools.retarget.interaction_mesh.terrain_clearance import foot_terrain_clearance  # noqa: E402


@pytest.mark.parametrize(
    ("x", "z"),
    [(-0.06, 0.04), (-0.02, 0.07)],  # the second is shallow after a 5 cm vertical lift
)
def test_sphere_beside_the_rim_of_a_flat_field_is_exact(tmp_path, x, z) -> None:
    """The nearest feature is the rim's top edge at x = 0; a vertical lift never reaches it."""
    model, data = _scene(tmp_path, _terrain(np.zeros((6, 6))))
    _pose(model, data, [x, 0.6, z])
    d, ft = _query(model, data)
    assert d == pytest.approx(np.hypot(min(x, 0.0), z) - 0.03, abs=1e-4)
    np.testing.assert_allclose(ft[:3], [0.0, 0.6, 0.0], atol=1e-4)  # terrain witness
    towards = np.array([0.0 - x, 0.0, -z]) / np.hypot(x, z)
    np.testing.assert_allclose(ft[3:], np.array([x, 0.6, z]) + 0.03 * towards, atol=1e-4)


def test_a_sphere_touching_a_slope_keeps_its_row_and_normal(tmp_path) -> None:
    """Rounding can put a touching sphere a hair inside; it still gets a row, along the slope."""
    hf = np.repeat((0.25 * np.arange(6))[:, None], 6, axis=1)  # z = x: a 45 degree ramp
    model, data = _scene(tmp_path, _terrain(hf))
    n = np.array([-1.0, 0.0, 1.0]) / np.sqrt(2.0)
    _pose(model, data, np.array([0.6, 0.6, 0.6]) + (0.03 - 1e-12) * n)
    h, r = _pair(model)
    tris, _, _ = co._hfield_facets_near(model, data, h, r, 0.05)
    got = co._sampled_gap(model, data, h, r, tris, 0.05)
    assert got is not None
    assert got[0] == 0.0
    v = got[1] - got[2]  # robot witness minus terrain witness
    np.testing.assert_allclose(v / np.linalg.norm(v), n, atol=1e-6)


def test_rotated_heightfield_is_rejected(tmp_path) -> None:
    model, data = _scene(tmp_path, _terrain(np.zeros((6, 6))))
    _pose(model, data, [0.6, 0.6, 0.05])
    hf = int(mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_GEOM, "hhtools_terrain_hf_geom"))
    data.geom_xmat[hf] = np.diag([-1.0, -1.0, 1.0]).ravel()
    with pytest.raises(ValueError, match="rotated"):
        _query(model, data)


def _plane_model():
    return SimpleNamespace(
        geom_bodyid=[0, 0, 1],
        geom_type=[
            int(mujoco.mjtGeom.mjGEOM_HFIELD),
            int(mujoco.mjtGeom.mjGEOM_PLANE),
            int(mujoco.mjtGeom.mjGEOM_BOX),
        ],
    )


def _rows(hf_x: float, plane_x: float):
    up = [np.array([0.0, 0.0, -1.0])] * 2  # scene geom first: robot-to-scene pair order
    records = [
        (g, 2, 0.01, np.array([x, 0.0, 0.0]), np.array([x, 0.0, 0.01]))
        for g, x in ((0, hf_x), (1, plane_x))
    ]
    return records, up


def test_plane_row_with_a_different_moment_arm_survives() -> None:
    """A toe on the heightfield (x = +0.10) does not stand in for a heel on the plane (-0.10)."""
    records, normals = _rows(0.10, -0.10)
    assert co._plane_rows_duplicated_by_hfield(_plane_model(), records, normals) == set()


def test_plane_row_with_the_same_contact_point_is_still_dropped() -> None:
    records, normals = _rows(0.10, 0.1005)
    assert co._plane_rows_duplicated_by_hfield(_plane_model(), records, normals) == {1}


def test_nonfinite_pose_does_not_abort_the_clearance(tmp_path) -> None:
    terrain = _terrain(np.zeros((5, 5)))
    model, data = _foot_scene(tmp_path, terrain, "0.03 0.02 0.01", 0.0)
    q = np.array(
        [
            [0.5, 0.5, 0.2, 0, 0, 0, 1],
            [np.nan, 0.5, 0.2, 0, 0, 0, 1],
            [0.6, 0.5, 0.3, 0, 0, 0, 1],
        ]
    )
    res = foot_terrain_clearance(model, data, q, terrain)
    bad = [1]
    good = [0, 2]
    assert np.isnan(res.vertical_clearance[bad]).all() and np.isnan(res.signed_distance[bad]).all()
    assert np.isfinite(res.vertical_clearance[good]).all()
    assert np.isfinite(res.signed_distance[good]).all()
    np.testing.assert_allclose(res.vertical_clearance[good], [0.19, 0.29], atol=2e-3)


def test_triangles_follow_mujoco_diagonal(tmp_path) -> None:
    """One raised node, so the two diagonals give different surfaces inside the cell.

    The cell is split along (i, j)-(i + 1, j + 1); the node at (x = dx, y = 0) is off that
    diagonal.  The other split would put the surface at ``h * (1 - y / dx)`` along the cell.
    """
    hf = np.zeros((2, 2))
    hf[1, 0] = 0.4
    model, data = _scene(tmp_path, _terrain(hf, dx=0.25))
    mujoco.mj_forward(model, data)
    hid = int(mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_GEOM, "hhtools_terrain_hf_geom"))
    tris = co._hfield_triangles(model, hid)[0].reshape(-1, 3, 3) + data.geom_xpos[hid]
    assert len(tris) == 2
    checked = 0
    for x, y in [(0.2, 0.05), (0.1, 0.15), (0.12, 0.02), (0.22, 0.2), (0.05, 0.2), (0.15, 0.1)]:
        z = None
        for t in tris:
            a, b, c = t[:, :2]
            m = np.array([b - a, c - a]).T
            u, v = np.linalg.solve(m, np.array([x, y]) - a)
            if u >= -1e-12 and v >= -1e-12 and u + v <= 1 + 1e-12:
                z = t[0, 2] + u * (t[1, 2] - t[0, 2]) + v * (t[2, 2] - t[0, 2])
        assert z is not None
        geomid = np.zeros(1, dtype=np.int32)
        dist = mujoco.mj_ray(
            model, data, np.array([x, y, 10.0]), np.array([0.0, 0.0, -1.0]), None, 1, 1, geomid
        )
        assert dist >= 0.0 and geomid[0] == hid
        assert z == pytest.approx(10.0 - dist, abs=1e-6)
        other = 0.4 * (1.0 - y / 0.25)
        checked += abs(z - other) > 0.02
    assert checked >= 3  # the other diagonal would have differed
