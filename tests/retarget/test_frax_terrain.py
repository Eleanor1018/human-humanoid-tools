"""FRAX terrain building blocks: column grid, distance rows, terrain and foot-stick constraints."""

from __future__ import annotations

import numpy as np
import pytest

pytest.importorskip("frax")
pytest.importorskip("elastiqp")

# isort: off
from frax_toy_robot import write_toy_robot  # noqa: E402

from hhtools.retarget.frax_backend.terrain import (  # noqa: E402  (configures JAX before it loads)
    FootStickConstraint,
    TerrainConstraint,
    TerrainGrid,
    build_terrain_grid,
    column_distance_rows,
)
import jax  # noqa: E402
import jax.numpy as jnp  # noqa: E402
from frax.ik import DiffIKSolver, FloorConstraint, FrameTask, JointLimits  # noqa: E402

from hhtools.retarget.frax_backend.collision import collision_spec_for_robot  # noqa: E402
from hhtools.retarget.frax_backend.model import build_frax_robot_model  # noqa: E402

# isort: on

DT = 0.02
STAND_Z = 0.86  # root height that puts the toy robot's soles on z = 0


@pytest.fixture(scope="module")
def model(tmp_path_factory):
    toy = write_toy_robot(tmp_path_factory.mktemp("robots") / "toy")
    return build_frax_robot_model(toy, collision=collision_spec_for_robot(toy))


def _stand_q(model) -> np.ndarray:
    q = np.array(model.robot.default_configuration, dtype=np.float64)
    q[2] = STAND_Z
    return q


def _grid(heights, origin=(0.0, 0.0), dx=0.1, floor_z=0.0) -> TerrainGrid:
    return TerrainGrid(np.asarray(heights, float), np.asarray(origin, float), dx, floor_z)


# --- build_terrain_grid -------------------------------------------------------------------


def test_build_grid_pads_buckets_and_clamps_to_floor() -> None:
    hf = np.full((5, 7), 0.3)
    hf[0, 0] = -1.0  # below the floor plane
    hf[1, 1] = np.nan
    hf[2, 2] = np.inf
    grid = build_terrain_grid(hf, (1.0, -2.0), 0.05, floor_z=0.1, pad_cells=2, shape_bucket=16)
    assert grid.heights.shape == (16, 16)
    np.testing.assert_allclose(grid.origin, [1.0 - 0.1, -2.0 - 0.1])
    assert grid.dx == 0.05 and grid.floor_z == 0.1
    inner = grid.heights[2:7, 2:9]
    assert inner[0, 0] == 0.1 and inner[1, 1] == 0.1 and inner[2, 2] == 0.1
    assert inner[3, 3] == 0.3
    mask = np.ones(grid.heights.shape, bool)
    mask[2:7, 2:9] = False
    assert np.all(grid.heights[mask] == 0.1)  # padding, bucketing remainder
    assert grid.heights.dtype == np.float64

    plain = build_terrain_grid(hf, (0.0, 0.0), 0.05, pad_cells=1, shape_bucket=1)
    assert plain.heights.shape == (7, 9)
    exact = build_terrain_grid(np.zeros((30, 30)), (0.0, 0.0), 0.1, pad_cells=1, shape_bucket=32)
    assert exact.heights.shape == (32, 32)
    ref = grid.as_ref()
    assert (
        set(ref) == {"heights", "origin", "inv_dx", "floor_z"}
        and ref["floor_z"] == 0.1
        and ref["inv_dx"] == pytest.approx(20.0)
    )


@pytest.mark.parametrize(
    "kwargs",
    [
        {"hf": np.zeros(4), "dx": 0.1},
        {"hf": np.zeros((2, 2, 2)), "dx": 0.1},
        {"hf": np.zeros((3, 3)), "dx": 0.0},
        {"hf": np.zeros((3, 3)), "dx": -0.1},
        {"hf": np.zeros((0, 3)), "dx": 0.1},
    ],
)
def test_build_grid_rejects_bad_input(kwargs) -> None:
    with pytest.raises(ValueError):
        build_terrain_grid(kwargs["hf"], (0.0, 0.0), kwargs["dx"])


# --- column distance ----------------------------------------------------------------------


def _rows(grid: TerrainGrid, pts, window=20):
    out = column_distance_rows(grid.as_ref(), jnp.asarray(pts, dtype=jnp.float64), window)
    return tuple(np.asarray(x) for x in out)


def _box(top=0.6, n=24, lo=8, hi=16, dx=0.05) -> TerrainGrid:
    """Box of columns ``lo..hi-1`` (both axes) on a grid with the origin at 0."""
    hf = np.zeros((n, n))
    hf[lo:hi, lo:hi] = top
    return _grid(hf, origin=(0.0, 0.0), dx=dx)


def test_column_height_at_is_the_containing_column() -> None:
    grid = _grid([[0.1, 0.2, 0.3], [0.4, 0.5, 0.6]], origin=(1.0, 2.0), dx=0.1, floor_z=-0.2)
    xy = np.array([[1.0, 2.0], [1.04, 2.14], [1.06, 2.2], [0.96, 1.96], [0.94, 2.0], [1.0, 2.26]])
    np.testing.assert_allclose(grid.column_height_at(xy), [0.1, 0.2, 0.6, 0.1, -0.2, -0.2])


def _random_terrain(seed: int, n=9) -> TerrainGrid:
    rng = np.random.default_rng(seed)
    return _grid(rng.choice([0.0, 0.1, 0.3, 0.6], (n, n)), origin=(0.0, 0.0), dx=0.05)


def _random_points(grid: TerrainGrid, count: int, seed: int) -> np.ndarray:
    rng = np.random.default_rng(seed)
    lo = grid.origin - 0.1
    hi = grid.origin + grid.dx * np.asarray(grid.heights.shape) + 0.1
    xy = rng.uniform(lo, hi, (count, 2))
    return np.column_stack([xy, rng.uniform(0.0, 0.8, count)])


@pytest.mark.parametrize("seed", [0, 1, 2])
def test_rows_match_the_brute_force_distance(seed) -> None:
    grid = _random_terrain(seed)
    pts = _random_points(grid, 400, seed)
    d_s, _, d_w, _ = _rows(grid, pts)
    sd = grid.signed_distance(pts)
    inside = sd < 0.0
    assert inside.any() and (~inside).any()
    np.testing.assert_allclose(np.minimum(d_s, d_w)[~inside], sd[~inside], atol=1e-12)
    np.testing.assert_allclose(d_s[inside], sd[inside], atol=1e-12)
    assert (d_w[inside] == 1e3).all()


def _row_distances(grid: TerrainGrid, pts: np.ndarray, which: int) -> np.ndarray:
    return _rows(grid, pts)[2 * which]


@pytest.mark.parametrize("seed", [0, 1])
def test_row_directions_are_the_gradients_of_their_distances(seed) -> None:
    grid = _random_terrain(seed)
    pts = _random_points(grid, 300, seed + 10)
    normals = _rows(grid, pts)
    eps, wide = 1e-6, 1e-3
    axes = np.eye(3)
    for which in (0, 1):  # support, wall
        n = normals[2 * which + 1]
        d0 = _row_distances(grid, pts, which)
        fd = np.stack(
            [
                (
                    _row_distances(grid, pts + eps * axes[a], which)
                    - _row_distances(grid, pts - eps * axes[a], which)
                )
                / (2 * eps)
                for a in range(3)
            ],
            axis=1,
        )
        # Skip kinks: a smooth distance has the same slope at 1 um and 1 mm.
        lin = np.stack(
            [
                (
                    _row_distances(grid, pts + wide * axes[a], which)
                    - _row_distances(grid, pts - wide * axes[a], which)
                )
                / (2 * wide)
                for a in range(3)
            ],
            axis=1,
        )
        smooth = (np.abs(fd - lin).max(axis=1) < 1e-6) & (d0 < 1e2)
        assert smooth.sum() > (60 if which == 0 else 15)
        np.testing.assert_allclose(fd[smooth], n[smooth], atol=1e-6)


def test_hand_checked_box_cases() -> None:
    grid = _box()  # columns at x, y = 0.4 .. 0.75 (centres), faces at 0.375 and 0.775
    face = 0.375
    pts = np.array(
        [
            [0.55, 0.55, 0.9],  # above the top
            [0.3, 0.55, 0.3],  # beside the wall, below the top
            [0.3, 0.55, 0.9],  # beside the wall, above the top height
            [0.33, 0.33, 0.7],  # above and beside the edge (diagonal)
            [0.395, 0.55, 0.3],  # inside, 2 cm from the face
            [0.575, 0.575, 0.55],  # inside, far from faces, 5 cm under the top
            [5.0, 5.0, 0.4],  # far outside the grid
        ]
    )
    d_s, n_s, d_w, n_w = _rows(grid, pts, window=4)
    assert d_s[0] == pytest.approx(0.3) and np.allclose(n_s[0], [0, 0, 1]) and d_w[0] == 1e3
    assert d_s[1] == pytest.approx(0.3) and np.allclose(n_s[1], [0, 0, 1])  # floor
    assert d_w[1] == pytest.approx(face - 0.3) and np.allclose(n_w[1], [-1, 0, 0])
    assert d_w[2] == 1e3 or d_w[2] == pytest.approx(face - 0.3)
    assert d_s[2] == pytest.approx(np.hypot(face - 0.3, 0.3)) and np.isclose(
        np.linalg.norm(n_s[2]), 1.0
    )
    assert d_s[3] == pytest.approx(np.sqrt(2 * (face - 0.33) ** 2 + 0.1**2))
    np.testing.assert_allclose(n_s[3] * d_s[3], [-(face - 0.33), -(face - 0.33), 0.1], atol=1e-12)
    assert np.isclose(np.linalg.norm(n_s[3]), 1.0)
    assert d_s[4] == pytest.approx(-(0.395 - face)) and np.allclose(n_s[4], [-1, 0, 0])
    assert d_w[4] == 1e3 and not n_w[4].any()
    assert d_s[5] == pytest.approx(-0.05) and np.allclose(n_s[5], [0, 0, 1])
    assert d_s[6] == pytest.approx(0.4) and np.allclose(n_s[6], [0, 0, 1])
    assert d_w[6] == 1e3 and not n_w[6].any()
    assert grid.signed_distance(pts[4]) == pytest.approx(d_s[4])


def test_distance_is_continuous_along_a_path_over_the_wall() -> None:
    grid = _box()
    a, b = np.array([0.2, 0.55, 0.3]), np.array([0.6, 0.55, 1.3])  # beside, over the edge, on top
    steps = 2000
    path = a + (b - a) * np.linspace(0.0, 1.0, steps)[:, None]
    d_s, _, d_w, _ = _rows(grid, path)
    d = np.minimum(d_s, d_w)
    length = np.linalg.norm(b - a) / (steps - 1)
    assert d.min() > 0.0
    assert np.abs(np.diff(d)).max() <= length + 1e-12
    # The support row alone jumps when the wall appears: that is what the wall row is for.
    assert np.abs(np.diff(d_s)).max() > 5 * length


def test_rows_are_finite_on_boundaries_column_tops_and_far_away() -> None:
    grid = _random_terrain(5, n=7)
    dx = grid.dx
    rng = np.random.default_rng(0)
    nodes = grid.origin + dx * rng.integers(0, 7, (60, 2))
    xy_edge = nodes + dx * rng.choice([-0.5, 0.0, 0.5], (60, 2))  # on boundaries and centres
    z_top = grid.column_height_at(xy_edge)
    pts = np.concatenate(
        [
            np.column_stack([xy_edge, z_top]),
            np.column_stack([xy_edge, np.zeros(60)]),
            np.column_stack([xy_edge, rng.uniform(0, 1, 60)]),
            rng.uniform(-50, 50, (60, 3)),
            np.array([[1e6, -1e6, 0.0], [0.0, 0.0, 0.0], [-0.025, -0.025, 0.0]]),
        ]
    )
    for window in (1, 3, 30):
        for out in _rows(grid, pts, window):
            assert np.isfinite(out).all()
    grads = jax.vmap(
        jax.jacfwd(lambda p: jnp.concatenate(column_distance_rows(grid.as_ref(), p[None], 3)[::2]))
    )(jnp.asarray(pts))
    assert np.isfinite(np.asarray(grads)).all()


def test_window_limits_how_far_walls_are_seen() -> None:
    grid = _box()
    p = np.array([[0.375 - 0.3, 0.55, 0.3]])
    assert _rows(grid, p, window=2)[2][0] == 1e3  # wall 6 columns away
    assert _rows(grid, p, window=8)[2][0] == pytest.approx(0.3)


# --- TerrainConstraint --------------------------------------------------------------------


@pytest.mark.parametrize("max_rows", [None, 12])
def test_terrain_constraint_equals_floor_constraint_on_flat_grid(model, max_rows) -> None:
    robot = model.robot
    idxs = np.asarray(model.floor_sphere_idxs)
    n = len(idxs)
    opts = {"sphere_idxs": idxs, "gain": 40.0, "margin": 0.003}
    floor = FloorConstraint(robot, max_rows=max_rows, **opts)
    terrain = TerrainConstraint(robot, max_rows=max_rows, **opts)
    assert terrain.num_rows == (2 * n if max_rows is None else max_rows)
    ref = {"terrain": build_terrain_grid(np.zeros((40, 40)), (-1.0, -1.0), 0.05).as_ref()}
    rng = np.random.default_rng(1)
    for _ in range(3):
        q = _stand_q(model)
        q[7:] = np.clip(q[7:] + rng.uniform(-0.3, 0.3, q[7:].shape), 0.0, 1.2)
        q[2] = rng.uniform(0.7, 1.0)
        G0, h0 = (np.asarray(x) for x in floor.rows(jnp.asarray(q), ref))
        G1, h1 = (np.asarray(x) for x in terrain.rows(jnp.asarray(q), ref))
        active = h1 < 100.0  # the wall rows are inactive on a flat grid
        assert active.sum() == floor.num_rows  # kept rows are the same support rows
        np.testing.assert_array_equal(G1[~active], 0.0)
        order0, order1 = np.lexsort(np.c_[G0, h0].T), np.lexsort(np.c_[G1[active], h1[active]].T)
        np.testing.assert_allclose(G1[active][order1], G0[order0], atol=1e-12)
        np.testing.assert_allclose(h1[active][order1], h0[order0], atol=1e-12)


def _step_grid(top: float, face: float, dx: float = 0.02) -> TerrainGrid:
    """Terrain with a full-width block of height ``top`` whose x = ``face`` side is the wall."""
    n = 125
    hf = np.zeros((n, n))
    hf[round((face + 1.0) / dx + 0.5) :, :] = top  # columns whose footprint lies beyond ``face``
    return _grid(hf, origin=(-1.0, -1.0), dx=dx)


def _run(solver, q0, ref, steps, pos=None, substeps=1):
    """Scan ``steps`` frames of ``substeps`` solver steps; ``pos`` overrides ref["pos"]."""

    @jax.jit
    def scan(q0, pos):
        def body(state, p):
            r = {**ref, **({} if p is None else {"pos": p})}
            for _ in range(substeps):
                state, _, info = solver.step(state, r, DT)
            return state, (state.q, info.qp_converged)

        return jax.lax.scan(body, solver.init(q0), pos, length=steps)[1]

    qs, converged = scan(jnp.asarray(q0), pos)
    return np.asarray(qs), np.asarray(converged)


def _sphere_world(robot, qs):
    idx = np.arange(len(np.asarray(robot.flat_collision_radii)))
    return np.stack(
        [np.asarray(robot._link_collision_positions(robot.joint_to_world_transforms(q)))[idx]
         for q in jnp.asarray(qs)]
    )  # fmt: skip


def _sole_spheres(model, side: str | None = None) -> np.ndarray:
    """Flat indices of the sole spheres; ``side="left"`` keeps those with y > 0 when standing."""
    sole = np.asarray(model.sole_sphere_idxs)
    if side is None:
        return sole
    y = _sphere_world(model.robot, _stand_q(model)[None])[0, sole, 1]
    return sole[y > 0] if side == "left" else sole[y < 0]


def _sole_clearance(model, grid, qs) -> np.ndarray:
    """(T, S) true signed distance of every sole sphere's surface to the column terrain."""
    sole = _sole_spheres(model)
    pos = _sphere_world(model.robot, qs)[:, sole]
    radii = np.asarray(model.robot.flat_collision_radii)[sole]
    return grid.signed_distance(pos) - radii


def _foot_rig(model, grid, window, q0, max_rows=32):
    """Drive the left ankle to ``ref["pos"]`` while holding the foot flat and the pelvis upright.

    The orientation tasks stand in for the rest of a retarget's targets.  With the foot position
    alone, the floating base may rotate freely and a foot jammed into a corner ends up wherever
    floating-point details take it: two CI runs of the same code disagreed.
    """
    robot = model.robot
    foot, _ = model.link_frame("left_foot_link")
    base = robot.nv_floating - 1
    tfs = np.asarray(robot.joint_to_world_transforms(jnp.asarray(q0)))
    tasks = [
        FrameTask(robot, [foot], gain_pos=1 / DT, pos_key="pos", rot_key=None),
        FrameTask(robot, [foot], gain_rot=1 / DT, pos_key=None, rot_key="foot_rmat"),
        FrameTask(robot, [base], gain_rot=1 / DT, pos_key=None, rot_key="base_rmat"),
    ]
    constraints = [
        JointLimits(robot, v_max=None, v_min=None, gain=1 / DT),
        TerrainConstraint(
            robot,
            np.asarray(model.floor_sphere_idxs),
            max_rows=max_rows,
            gain=1 / DT,
            window=window,
        ),
    ]
    solver = DiffIKSolver(robot, tasks, constraints, regularization=0.1)
    ref = {
        "terrain": grid.as_ref(),
        "foot_rmat": tfs[foot][None, :3, :3],
        "base_rmat": tfs[base][None, :3, :3],
    }
    return solver, foot, ref


def _ankle(robot, foot, q) -> np.ndarray:
    return np.asarray(robot.joint_to_world_transforms(jnp.asarray(q)))[foot][:3, 3]


def _path(a, b, steps):
    return a + (b - a) * np.linspace(0.0, 1.0, steps)[:, None]


@pytest.mark.parametrize("per_frame", [0.01, 0.1])
@pytest.mark.parametrize("substeps", [1, 2])
def test_foot_driven_into_a_tall_wall_does_not_penetrate(model, per_frame, substeps) -> None:
    grid = _step_grid(0.6, 0.35)
    q0 = _stand_q(model)
    solver, foot, ref = _foot_rig(model, grid, 8, q0)
    a0 = _ankle(model.robot, foot, q0)
    goal = a0 + np.array([0.3, 0.0, 0.0])  # the toe would end 25 cm inside the wall
    n = int(np.ceil(0.3 / per_frame))
    pos = np.concatenate([_path(a0, goal, n), np.tile(goal, (15, 1))])[:, None]
    qs, converged = _run(solver, q0, ref, len(pos), pos, substeps)
    clearance = _sole_clearance(model, grid, qs)
    assert converged.all() and np.isfinite(qs).all()
    assert clearance.min() > -0.002
    assert clearance[-1].min() < 0.02  # the foot did reach the wall


@pytest.mark.parametrize("substeps", [1, 2])
def test_foot_driven_into_a_low_step_is_held_at_the_face(model, substeps) -> None:
    grid = _step_grid(0.15, 0.35)
    q0 = _stand_q(model)
    solver, foot, ref = _foot_rig(model, grid, 8, q0)
    a0 = _ankle(model.robot, foot, q0)
    goal = a0 + np.array([0.3, 0.0, 0.0])
    pos = np.concatenate([_path(a0, goal, 15), np.tile(goal, (20, 1))])[:, None]
    qs, converged = _run(solver, q0, ref, len(pos), pos, substeps)
    clearance = _sole_clearance(model, grid, qs)
    left = _sole_spheres(model, "left")
    sole = _sphere_world(model.robot, qs[-1:])[0, left]
    radius = np.asarray(model.robot.flat_collision_radii)[left]
    assert converged.all()
    assert clearance.min() > -0.002
    assert (sole[:, 0] + radius).max() < 0.35 + 0.002  # stopped at the face
    assert (sole[:, 2] - radius).max() < 0.01  # flat on the floor, not on the step


@pytest.mark.parametrize("substeps", [1, 2])
def test_foot_lifted_above_a_step_gets_onto_it(model, substeps) -> None:
    top = 0.15
    grid = _step_grid(top, 0.35)
    q0 = _stand_q(model)
    solver, foot, ref = _foot_rig(model, grid, 8, q0)
    a0 = _ankle(model.robot, foot, q0)
    up = a0 + np.array([0.0, 0.0, top + 0.02])  # 2 cm clearance over the edge
    over = up + np.array([0.3, 0.0, 0.0])
    goal = over - np.array([0.0, 0.0, 0.02])  # sole back on the step top
    pos = np.concatenate(
        [_path(a0, up, 10), _path(up, over, 15), _path(over, goal, 5), np.tile(goal, (15, 1))]
    )[:, None]
    qs, converged = _run(solver, q0, ref, len(pos), pos, substeps)
    clearance = _sole_clearance(model, grid, qs)
    err = np.linalg.norm(_ankle(model.robot, foot, qs[-1]) - goal)
    assert converged.all()
    assert clearance.min() > -0.002
    assert err <= 0.01


@pytest.mark.parametrize("substeps", [1, 2])
def test_spheres_inside_a_wall_leave_sideways(model, substeps) -> None:
    face = 0.35
    grid = _step_grid(0.6, face)
    q0 = _stand_q(model)
    q0[0] = face - 0.13  # toe sphere centres 1 cm inside the face: surfaces 2 cm inside
    assert _sole_clearance(model, grid, q0[None]).min() == pytest.approx(-0.02)
    solver, foot, ref = _foot_rig(model, grid, 8, q0)
    pos = np.tile(_ankle(model.robot, foot, q0), (10, 1))[:, None]
    qs, converged = _run(solver, q0, ref, 10, pos, substeps)
    clearance = _sole_clearance(model, grid, qs)
    sole = _sphere_world(model.robot, qs)[:, _sole_spheres(model)]
    assert converged.all()
    assert clearance[1].min() > -0.002  # outside after two frames
    assert sole[:, :, 2].max() < 0.02  # left through the face, not up the 60 cm wall


def test_flat_terrain_rows_have_inactive_walls(model) -> None:
    terrain = TerrainConstraint(model.robot, np.asarray(model.floor_sphere_idxs), window=3)
    assert terrain.num_rows == 2 * len(model.floor_sphere_idxs)
    ref = {"terrain": build_terrain_grid(np.zeros((40, 40)), (-1.0, -1.0), 0.05).as_ref()}
    q = jnp.asarray(_stand_q(model))
    G, h = terrain.rows(q, ref)
    h = np.asarray(h)
    assert (h > 100).sum() == len(h) // 2
    np.testing.assert_array_equal(np.asarray(G)[h > 100], 0.0)


# --- FootStickConstraint ------------------------------------------------------------------


def test_foot_stick_caps_horizontal_speed(model) -> None:
    robot = model.robot
    joints = [model.link_frame("left_foot_link")[0], model.link_frame("right_foot_link")[0]]
    offsets = np.tile(np.eye(4), (2, 1, 1))
    cap = 0.2
    task = FrameTask(robot, joints, gain_pos=1 / DT, pos_key="pos", rot_key=None, offsets=offsets)
    stick = FootStickConstraint(robot, joints, offsets, 1 / DT)
    assert stick.num_rows == 8
    assert stick.stick_key == "foot_speed_cap"
    q0 = jnp.asarray(_stand_q(model))
    feet0 = np.asarray(robot.joint_to_world_transforms(q0))[joints][:, :3, 3]
    target = feet0 + np.array([0.0, 0.1, 0.0])  # drag both feet 10 cm sideways

    G, h = stick.rows(q0, {"foot_speed_cap": jnp.array([cap, 1e3])})
    G, h = np.asarray(G), np.asarray(h)
    assert G.shape == (8, robot.nv) and np.abs(G).max() > 0.1
    np.testing.assert_array_equal(h[:4], cap)
    np.testing.assert_array_equal(h[4:], 1e3)
    np.testing.assert_allclose(G[:2], -G[2:4])  # +Jx, +Jy, -Jx, -Jy

    solver = DiffIKSolver(
        robot, [task], [JointLimits(robot, v_max=None, v_min=None, gain=1 / DT), stick],
        regularization=0.1,
    )  # fmt: skip
    pos = jnp.asarray(target)

    def feet(qs):
        return np.stack(
            [np.asarray(robot.joint_to_world_transforms(q))[joints][:, :3, 3] for q in qs]
        )

    # Per-point cap vector: only the capped point is constrained.
    ref = {"pos": pos, "foot_speed_cap": jnp.array([cap, 1e3])}
    qs, _ = _run(solver, np.asarray(q0), ref, 12)
    path = feet(jnp.asarray(np.vstack([np.asarray(q0)[None], qs])))
    step_xy = np.linalg.norm(np.diff(path[:, 0, :2], axis=0), axis=1)
    assert step_xy.max() <= cap * DT + 1e-4
    assert step_xy.sum() > 0.5 * cap * DT * 12  # the capped foot still creeps at the cap
    free = np.linalg.norm(path[-1, 1] - target[1])
    assert free < 0.01  # the uncapped foot reaches its target

    # Small cap on both: displacement per step stays within cap * dt.
    ref = {"pos": pos, "foot_speed_cap": jnp.full(2, cap)}
    qs, _ = _run(solver, np.asarray(q0), ref, 12)
    path = feet(jnp.asarray(np.vstack([np.asarray(q0)[None], qs])))
    step_xy = np.linalg.norm(np.diff(path[:, :, :2], axis=0), axis=-1)
    assert step_xy.max() <= cap * DT + 1e-4

    # Large cap: the points reach the target.
    qs, _ = _run(solver, np.asarray(q0), {"pos": pos, "foot_speed_cap": jnp.full(2, 1e3)}, 12)
    path = feet(jnp.asarray(qs))
    assert np.abs(path[-1] - target).max() < 0.01
