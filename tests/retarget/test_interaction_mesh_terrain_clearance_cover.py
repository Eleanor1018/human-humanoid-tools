"""The Z-snap's foot clearance bounds the whole foot surface, not only its samples."""

from __future__ import annotations

import numpy as np
import pytest

mujoco = pytest.importorskip("mujoco")

from test_interaction_mesh_terrain_review import (  # noqa: E402
    _foot_scene,
    _snap,
    _surface_z,
    _terrain,
)

from hhtools.retarget.interaction_mesh.terrain_clearance import (  # noqa: E402
    column_terrain_distance,
)


def _yawed_box_q(centre, yaw, tilt=(0.0, 0.0)):
    """joint_q row of a free body at ``centre`` rotated by yaw about z after a small x/y tilt."""
    cr, sr = np.cos(tilt[0] / 2), np.sin(tilt[0] / 2)
    cp, sp = np.cos(tilt[1] / 2), np.sin(tilt[1] / 2)
    cy, sy = np.cos(yaw / 2), np.sin(yaw / 2)
    # xyzw of Rz(yaw) * Ry(pitch) * Rx(roll)
    x = sr * cp * cy - cr * sp * sy
    y = cr * sp * cy + sr * cp * sy
    z = cr * cp * sy - sr * sp * cy
    w = cr * cp * cy + sr * sp * sy
    return np.array([*centre, x, y, z, w])


def _face_points(half, rot, centre, per_side=17):
    """Dense points on all six faces of a box in the world."""
    ax = np.linspace(-1.0, 1.0, per_side)
    pts = []
    for axis in range(3):
        u, v = [i for i in range(3) if i != axis]
        gu, gv = np.meshgrid(ax * half[u], ax * half[v])
        for sign in (-1.0, 1.0):
            face = np.zeros((gu.size, 3))
            face[:, axis] = sign * half[axis]
            face[:, u], face[:, v] = gu.ravel(), gv.ravel()
            pts.append(face)
    return centre + np.concatenate(pts) @ rot.T


def _rot_from_xyzw(q):
    x, y, z, w = q
    return np.array(
        [
            [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
            [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
            [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
        ]
    )


def _column_top(hf, dx, xy):
    """Tallest column whose footprint contains each xy (nodes at (i, j) * dx), floor 0."""
    top = np.zeros(len(xy))
    for i in range(hf.shape[0]):
        for j in range(hf.shape[1]):
            inside = (np.abs(xy[:, 0] - i * dx) <= 0.5 * dx + 1e-9) & (
                np.abs(xy[:, 1] - j * dx) <= 0.5 * dx + 1e-9
            )
            top = np.where(inside, np.maximum(top, hf[i, j]), top)
    return top


def test_snap_does_not_lower_a_tiny_yawed_sole_into_the_cell_between_its_samples(tmp_path) -> None:
    """Edges shorter than the sample spacing leave only the corners sampled; the raised node's
    ramp under the leading edge is higher than every corner's terrain."""
    hf = np.zeros((7, 7))
    hf[3, 3] = 0.6
    terrain = _terrain(hf, dx=0.1)
    half = (0.0085, 0.0085, 0.005)
    model, data = _foot_scene(tmp_path, terrain, " ".join(map(str, half)), ground_z=0.0)
    mujoco.mj_forward(model, data)
    centre = np.array([0.37723499, 0.37647733, 0.32274321])
    yaw = 0.8632600319428437
    q = _yawed_box_q(centre, yaw)
    offset = _snap(model, data, q[None], terrain, floor_z=0.0)

    pts = _face_points(half, _rot_from_xyzw(q[3:]), centre)
    surface = np.array([_surface_z(model, data, x, y) for x, y, _ in pts])
    clearance = (pts[:, 2] - surface).min()  # how far the sole can really come down
    assert clearance > 0.1
    assert offset <= clearance + 1e-6, f"lowered {offset:.4f} m, only {clearance:.4f} m is free"
    assert offset > 0.5 * clearance  # and the bound is not vacuous


def test_snap_over_flat_floor_still_lands_exactly(tmp_path) -> None:
    terrain = _terrain(np.zeros((7, 7)), dx=0.1)
    model, data = _foot_scene(tmp_path, terrain, "0.06 0.03 0.005", ground_z=0.0)
    for yaw in (0.0, 0.7):
        offset = _snap(
            model, data, _yawed_box_q([0.3, 0.3, 0.205], yaw)[None], terrain, floor_z=0.0
        )
        assert offset == pytest.approx(0.2, abs=1e-9)


@pytest.mark.parametrize("seed", range(3))
def test_snap_never_leaves_the_foot_surface_inside_the_terrain(tmp_path, seed) -> None:
    """Random yawed, slightly tilted boxes over random terrain: after the snap, a dense
    sampling of every face is outside the compiled surface and the columns."""
    rng = np.random.default_rng(seed)
    dx = 0.1
    hf = rng.choice([0.0, 0.0, 0.15, 0.3, 0.6], size=(8, 8)) + rng.uniform(0, 0.05, (8, 8))
    terrain = _terrain(hf, dx=dx)
    hf32 = np.asarray(terrain.hf, dtype=np.float64)
    half = tuple(rng.uniform(0.004, 0.05, 3) * [1.0, 1.0, 0.2])
    model, data = _foot_scene(tmp_path, terrain, " ".join(map(str, half)), ground_z=0.0)
    mujoco.mj_forward(model, data)
    snapped = 0
    for _ in range(40):
        xy = rng.uniform(0.2, 0.5, 2)
        q = _yawed_box_q(
            [*xy, rng.uniform(0.0, 0.9)], rng.uniform(0, np.pi), rng.uniform(-0.1, 0.1, 2)
        )
        offset = _snap(model, data, q[None], terrain, floor_z=0.0)
        if offset <= 0.0:
            continue
        snapped += 1
        pts = _face_points(half, _rot_from_xyzw(q[3:]), q[:3])
        pts[:, 2] -= offset
        columns = _column_top(hf32, dx, pts[:, :2])
        surface = np.array([_surface_z(model, data, x, y) for x, y, _ in pts])
        assert (pts[:, 2] - columns).min() >= -1e-6
        assert (pts[:, 2] - surface).min() >= -1e-6
    assert snapped >= 5


def test_signed_distance_is_the_column_metric_whatever_the_triangulation() -> None:
    # A z = 6x facet between node rows x = 0 and x = 0.1; a point inside the ramp but outside
    # every column, and one just above it.
    hf = np.zeros((4, 6))
    hf[1:, :] = 0.6
    terrain = _terrain(hf, dx=0.1)
    pts = np.array([[0.04, 0.25, 0.20], [0.04, 0.25, 0.26]])
    plain_d, plain_v = column_terrain_distance(pts, terrain, triangulation=None)
    tri_d, tri_v = column_terrain_distance(pts, terrain, triangulation="main")
    np.testing.assert_array_equal(tri_d, plain_d)
    # The triangle lowers the vertical clearance: 0.2 and 0.26 over the surface at 0.24.
    np.testing.assert_allclose(plain_v, [0.2, 0.26], atol=1e-6)
    np.testing.assert_allclose(tri_v, [-0.04, 0.02], atol=1e-6)
