"""FRAX object barrier: signed distance fields, distance rows, constraint, pipeline, guards."""

from __future__ import annotations

import dataclasses

import numpy as np
import pytest

pytest.importorskip("frax")
pytest.importorskip("elastiqp")

# isort: off
from frax_toy_robot import write_toy_robot  # noqa: E402

from hhtools.retarget.frax_backend.objects import (  # noqa: E402  (configures JAX first)
    ObjectConstraint,
    ObjectSDF,
    build_object_sdf,
    object_distance_rows,
    object_grid_pad,
)
from hhtools.retarget.frax_backend.scene_pipeline import (  # noqa: E402
    FraxSceneConfig,
    FraxScenePipeline,
    _limit_edit_by_terrain,
    _limit_root_shift,
    _object_gap_fn,
)
import jax  # noqa: E402
import jax.numpy as jnp  # noqa: E402
from frax.ik import DiffIKSolver, FrameTask, JointLimits  # noqa: E402
from scipy.spatial.transform import Rotation  # noqa: E402

from hhtools.core.scene import SceneObject  # noqa: E402
from hhtools.retarget.calibration import RobotRetargetCalibration, save_calibration  # noqa: E402
from hhtools.retarget.frax_backend.collision import collision_spec_for_robot  # noqa: E402
from hhtools.retarget.frax_backend.model import build_frax_robot_model  # noqa: E402

# isort: on

DT = 0.02
STAND_Z = 0.86  # root height that puts the toy robot's soles on z = 0


# --- helpers --------------------------------------------------------------------------------


def _box_sd(points: np.ndarray, half) -> np.ndarray:
    q = np.abs(points) - np.asarray(half)
    return np.linalg.norm(np.maximum(q, 0.0), axis=-1) + np.minimum(q.max(axis=-1), 0.0)


def _write_box_obj(path, size, offset=(0.0, 0.0, 0.0)):
    sx, sy, sz = (0.5 * s for s in size)
    v = np.array([[x, y, z] for x in (-sx, sx) for y in (-sy, sy) for z in (-sz, sz)]) + offset
    # Outward-wound triangles of the cube with corner index = 4 * ix + 2 * iy + iz.
    f = [
        (0, 1, 3), (0, 3, 2),  # -x
        (4, 6, 7), (4, 7, 5),  # +x
        (0, 4, 5), (0, 5, 1),  # -y
        (2, 3, 7), (2, 7, 6),  # +y
        (0, 2, 6), (0, 6, 4),  # -z
        (1, 5, 7), (1, 7, 3),  # +z
    ]  # fmt: skip
    lines = [f"v {a} {b} {c}" for a, b, c in v] + [f"f {a + 1} {b + 1} {c + 1}" for a, b, c in f]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return str(path)


def _object(mesh_path="", extents=(0.3, 0.2, 0.1), scale=1.0, frames=1, pos=(0, 0, 0)):
    quats = np.tile([0.0, 0.0, 0.0, 1.0], (frames, 1))
    return SceneObject(
        name="box",
        positions=np.tile(pos, (frames, 1)),
        quaternions=quats,
        extents=np.asarray(extents),
        mesh_path=mesh_path,
        scale=scale,
    )


def _random_points(sdf, count, seed):
    rng = np.random.default_rng(seed)
    lo = sdf.origin
    hi = sdf.origin + sdf.dx * (np.asarray(sdf.values.shape) - 1)
    return rng.uniform(lo, hi, (count, 3))


# --- signed distance fields -----------------------------------------------------------------


@pytest.mark.parametrize("offset", [(0.0, 0.0, 0.0), (0.03, -0.02, 0.05)])
def test_mesh_sdf_matches_the_analytic_box(tmp_path, offset) -> None:
    size = np.array([0.36, 0.24, 0.12])
    # Mesh vertices are centred on their mean, so an offset box is the same box.
    obj = _object(_write_box_obj(tmp_path / "box.obj", size, offset), scale=1.0)
    # Trilinear interpolation of an exact field cuts the kinks along box edges by up to 2.7 mm
    # at 1 cm cells (checked on the analytic field), so the 2 mm bound needs 5 mm cells.
    sdf = build_object_sdf(obj, 1.0, dx=0.005)
    pts = _random_points(sdf, 4000, 0)
    truth = _box_sd(pts, size / 2)
    got = sdf.signed_distance(pts)
    near = np.abs(truth) < 0.03
    assert near.sum() > 100
    assert np.abs(got - truth)[near].max() <= 2e-3
    clear = np.abs(truth) > 5e-3
    assert (np.sign(got[clear]) == np.sign(truth[clear])).all()

    # Default 1 cm cells: within 3 mm near the surface, within a cell elsewhere.
    sdf = build_object_sdf(obj, 1.0)
    pts = _random_points(sdf, 4000, 5)
    truth = _box_sd(pts, size / 2)
    err = np.abs(sdf.signed_distance(pts) - truth)
    near = np.abs(truth) < 0.03
    assert err[near].max() <= 3e-3
    assert err[~near].max() <= sdf.dx
    clear = np.abs(truth) > 5e-3
    assert (np.sign(sdf.signed_distance(pts))[clear] == np.sign(truth[clear])).all()


def test_mesh_sdf_follows_object_and_human_scale(tmp_path) -> None:
    size = np.array([0.4, 0.4, 0.2])
    obj = _object(_write_box_obj(tmp_path / "box.obj", size), scale=0.5)
    sdf = build_object_sdf(obj, 0.8, dx=0.005)  # mesh scaled by 0.5 * 0.8
    pts = _random_points(sdf, 1000, 1)
    truth = _box_sd(pts, size * 0.4 / 2)
    near = (truth > 0.0) & (truth < 0.03)  # inside, the thin box has a medial ridge
    err = sdf.signed_distance(pts) - truth
    assert near.sum() > 50 and np.abs(err[near]).max() <= 2e-3


@pytest.mark.parametrize("mesh", ["", "missing.obj"])
def test_box_fallback_equals_the_analytic_sdf(tmp_path, mesh) -> None:
    extents = np.array([0.3, 0.2, 0.1])
    path = "" if not mesh else str(tmp_path / mesh)
    # ``extents`` are metres: only the human scale applies, never ``obj.scale`` (mesh vertices).
    sdf = build_object_sdf(_object(path, extents=extents, scale=2.0), 0.5)
    half = extents * 0.5 / 2
    pts = _random_points(sdf, 2000, 2)
    # Exact at the nodes; trilinear between them is within a fraction of a cell.
    nodes = sdf.origin + sdf.dx * np.stack(
        np.unravel_index(np.arange(sdf.values.size), sdf.values.shape), axis=-1
    )
    np.testing.assert_allclose(sdf.values.reshape(-1), _box_sd(nodes, half), atol=1e-6)
    assert np.abs(sdf.signed_distance(pts) - _box_sd(pts, half)).max() <= sdf.dx


def test_sdf_cache_returns_the_same_object(tmp_path) -> None:
    obj = _object(_write_box_obj(tmp_path / "c.obj", (0.2, 0.2, 0.2)))
    assert build_object_sdf(obj, 1.0) is build_object_sdf(obj, 1.0)
    assert build_object_sdf(obj, 1.0) is not build_object_sdf(obj, 0.9)


def _write_mesh(path, mesh):
    mesh.export(str(path))
    return str(path)


def test_missing_omnicontact_mesh_keeps_the_metric_box(tmp_path) -> None:
    """The adapter stores metric extents (0.30 m) and keeps 0.01 as the mesh-vertex scale."""
    obj = _object(str(tmp_path / "gone.obj"), extents=(0.3, 0.3, 0.3), scale=0.01)
    sdf = build_object_sdf(obj, 0.8, dx=0.01)
    half = 0.15 * 0.8
    np.testing.assert_allclose(sdf.signed_distance([[0.10, 0.0, 0.0]]), [0.10 - half], atol=1e-6)
    np.testing.assert_allclose(sdf.signed_distance([[0.14, 0.0, 0.0]]), [0.14 - half], atol=1e-6)


def test_sphere_overlapping_a_box_corner_outside_the_default_halo(tmp_path) -> None:
    """A 15 cm sphere whose centre is past an 8 cm halo still intersects the box."""
    obj = _object(extents=(0.25, 0.25, 0.25))
    centre = np.array([[0.125 + 0.12, 0.125 + 0.08, 0.011]])
    radius = 0.15
    true_gap = np.hypot(0.12, 0.08) - radius
    assert true_gap < -0.005
    pos, rot = np.zeros(3), np.eye(3)

    narrow = build_object_sdf(obj, 1.0, dx=0.005, pad=0.08)
    d, _ = object_distance_rows(narrow.as_ref(), centre, pos, rot)
    assert float(d[0]) - radius > 0.0  # the halo cuts the field short: wrongly clear

    pad = object_grid_pad(radius, 0.01)
    assert pad == pytest.approx(0.19)
    wide = build_object_sdf(obj, 1.0, dx=0.005, pad=pad)
    d, _ = object_distance_rows(wide.as_ref(), centre, pos, rot)
    assert float(d[0]) - radius == pytest.approx(true_gap, abs=2e-3)
    assert float(d[0]) - radius < 0.0
    assert object_grid_pad(0.02, 0.01) == 0.08  # small spheres keep the old halo


def test_pipeline_pads_the_field_by_the_sphere_reach(toy, calibration, synthetic_terrain_motion):
    motion = _carry_motion(synthetic_terrain_motion)
    pipe = _pipeline(toy, motion, calibration)
    result = pipe.run(motion)
    radii = np.asarray(pipe.frax_model.robot.flat_collision_radii)
    pad = object_grid_pad(radii.max(), FraxSceneConfig().object_margin)
    expected = build_object_sdf(
        motion.objects[0], result.meta["smpl_scale"], dx=FraxSceneConfig().object_grid_dx, pad=pad
    )
    assert result.meta["frax"]["object_sdf_shapes"] == [tuple(expected.values.shape)]
    assert pad > 0.08


def test_replaced_mesh_with_the_same_mtime_is_rebuilt(tmp_path) -> None:
    import os

    path = tmp_path / "m.obj"
    _write_box_obj(path, (0.2, 0.2, 0.2))
    mtime = path.stat().st_mtime_ns
    first = build_object_sdf(_object(str(path)), 1.0)
    other = tmp_path / "new.obj"
    _write_box_obj(other, (0.4, 0.4, 0.4))
    other.write_text(other.read_text() + "# a longer file\n", encoding="utf-8")
    os.replace(other, path)
    os.utime(path, ns=(mtime, mtime))
    assert path.stat().st_mtime_ns == mtime
    second = build_object_sdf(_object(str(path)), 1.0)
    assert second is not first
    assert float(second.signed_distance([[0.15, 0.0, 0.0]])[0]) == pytest.approx(-0.05, abs=3e-3)


def test_hollow_box_reads_the_cavity_as_outside(tmp_path) -> None:
    import trimesh

    outer = trimesh.creation.box((0.24, 0.24, 0.24))
    inner = trimesh.creation.box((0.16, 0.16, 0.16))
    inner.invert()  # a correctly oriented cavity
    shell = trimesh.util.concatenate([outer, inner])
    assert shell.is_watertight
    sdf = build_object_sdf(_object(_write_mesh(tmp_path / "shell.obj", shell)), 1.0, dx=0.005)
    # 5 mm inside the air cavity: the nearest surface is the inner wall.
    got = sdf.signed_distance([[0.075, 0.0, 0.0], [0.085, 0.0, 0.0], [0.115, 0.0, 0.0]])
    np.testing.assert_allclose(got, [0.005, -0.005, -0.005], atol=2e-3)
    # The outside of the shell is unchanged.
    np.testing.assert_allclose(sdf.signed_distance([[0.13, 0.0, 0.0]]), [0.01], atol=2e-3)


def test_disjoint_watertight_solids_of_opposite_winding(tmp_path) -> None:
    import trimesh

    big = trimesh.creation.box((0.12, 0.12, 0.12))
    big.apply_translation([-0.10, 0.0, 0.0])
    small = trimesh.creation.box((0.06, 0.06, 0.06))
    small.apply_translation([0.10, 0.0, 0.0])
    small.invert()  # consistent inside its own shell, opposite to the other component
    both = trimesh.util.concatenate([big, small])
    assert both.is_watertight and both.is_winding_consistent
    sdf = build_object_sdf(_object(_write_mesh(tmp_path / "two.obj", both)), 1.0, dx=0.005)
    # 5 mm inside / outside the face of the smaller solid, and inside the larger one.
    got = sdf.signed_distance([[0.125, 0.0, 0.0], [0.135, 0.0, 0.0], [-0.055, 0.0, 0.0]])
    np.testing.assert_allclose(got, [-0.005, 0.005, -0.015], atol=2e-3)


def test_flat_gradient_exits_through_the_nearest_face() -> None:
    """On the medial plane of a thin off-centre slab the trilinear gradient is zero."""
    dx = 0.01
    origin = np.array([-0.2, -0.2, -0.04])
    pts = np.moveaxis(np.indices((41, 41, 10)), 0, -1) * dx + origin
    q = np.abs(pts - [0.0, 0.0, 0.005]) - [0.15, 0.15, 0.015]
    field = np.linalg.norm(np.maximum(q, 0.0), axis=-1) + np.minimum(q.max(axis=-1), 0.0)
    sdf = ObjectSDF(field.astype(np.float32), origin, dx)
    p = np.array([[0.08, 0.0, 0.002], [-0.08, 0.05, 0.008]])  # inside the medial cell
    d, n = jax.jit(lambda c: object_distance_rows(sdf.as_ref(), c, np.zeros(3), np.eye(3)))(
        jnp.asarray(p)
    )
    assert (np.asarray(d) < 0.0).all()
    np.testing.assert_allclose(np.linalg.norm(np.asarray(n), axis=-1), 1.0, atol=1e-9)
    assert (np.abs(np.asarray(n)[:, 2]) > 0.99).all()
    # Stepping along the chosen direction raises the field.
    step = sdf.signed_distance(p + 0.01 * np.asarray(n))
    assert (step > np.asarray(d)).all()


# --- distance rows ----------------------------------------------------------------------------


def _pose():
    rot = Rotation.from_euler("xyz", [0.3, -0.5, 0.9]).as_matrix()
    return np.array([0.4, -0.2, 0.7]), rot


def test_distance_rows_of_a_rotated_translated_box() -> None:
    half = np.array([0.15, 0.1, 0.07])
    sdf = build_object_sdf(_object(extents=2 * half), 1.0, dx=0.005)  # see the mesh test
    pos, rot = _pose()
    rng = np.random.default_rng(3)
    local = rng.uniform(-0.25, 0.25, (3000, 3))
    truth = _box_sd(local, half)
    world = pos + local @ rot.T
    d, n = object_distance_rows(sdf.as_ref(), jnp.asarray(world), pos, rot)
    d, n = np.asarray(d), np.asarray(n)
    near = np.abs(truth) < 0.03
    assert near.sum() > 200
    assert np.abs(d - truth)[near].max() <= 2e-3
    np.testing.assert_allclose(np.linalg.norm(n, axis=-1), 1.0, atol=1e-9)

    # Normals against the finite-difference gradient of the true distance, outside, where the
    # distance is smooth.
    eps = 1e-5
    outside = (truth > 0.03) & (truth < 0.1)
    grad = np.stack(
        [
            (_box_sd(local + eps * e, half) - _box_sd(local - eps * e, half)) / (2 * eps)
            for e in np.eye(3)
        ],
        axis=-1,
    )
    grad_world = grad @ rot.T
    grad_world /= np.linalg.norm(grad_world, axis=-1, keepdims=True)
    cos = np.clip((n * grad_world).sum(axis=-1), -1.0, 1.0)
    assert outside.sum() > 200
    assert np.degrees(np.arccos(cos[outside])).max() <= 5.0


def test_far_points_read_far_and_rows_stay_finite() -> None:
    sdf = build_object_sdf(_object(extents=(0.2, 0.2, 0.2)), 1.0)
    pos, rot = _pose()
    far = np.array([[3.0, 0.0, 0.0], [0.0, -4.0, 2.0]])
    d, n = object_distance_rows(sdf.as_ref(), far, pos, rot)
    r = np.linalg.norm(far - pos, axis=-1)  # the box lies within 0.1 * sqrt(3) of its centre
    assert (np.asarray(d) > r - 0.174 - 0.02).all() and (np.asarray(d) < r + 0.02).all()
    # At the box centre every gradient direction is degenerate or at least finite and unit.
    d0, n0 = object_distance_rows(sdf.as_ref(), pos[None], pos, rot)
    assert np.isfinite(np.asarray(d0)).all()
    np.testing.assert_allclose(np.linalg.norm(np.asarray(n0), axis=-1), 1.0, atol=1e-9)
    assert np.isfinite(np.asarray(n)).all()


def test_rows_jit_and_vmap() -> None:
    sdf = build_object_sdf(_object(extents=(0.2, 0.2, 0.2)), 1.0).as_ref()
    pos, rot = _pose()
    pts = np.random.default_rng(4).uniform(-0.3, 0.3, (5, 7, 3))
    f = jax.jit(jax.vmap(lambda c: object_distance_rows(sdf, c, pos, rot)))
    d, n = f(jnp.asarray(pts))
    assert d.shape == (5, 7) and n.shape == (5, 7, 3)


# --- constraint in a differential IK -----------------------------------------------------------


@pytest.fixture(scope="module")
def model(tmp_path_factory):
    toy = write_toy_robot(tmp_path_factory.mktemp("robots") / "toy")
    return build_frax_robot_model(toy, collision=collision_spec_for_robot(toy))


def _stand_q(model) -> np.ndarray:
    q = np.array(model.robot.default_configuration, dtype=np.float64)
    q[2] = STAND_Z
    return q


def _spheres(robot, qs) -> np.ndarray:
    return np.stack(
        [np.asarray(robot._link_collision_positions(robot.joint_to_world_transforms(q)))
         for q in jnp.asarray(qs)]
    )  # fmt: skip


def _hand_rig(model, sdf, q0, max_rows=32):
    robot = model.robot
    hand, _ = model.link_frame("left_hand_link")
    base = robot.nv_floating - 1
    tfs = np.asarray(robot.joint_to_world_transforms(jnp.asarray(q0)))
    tasks = [
        FrameTask(robot, [hand], gain_pos=1 / DT, pos_key="pos", rot_key=None),
        FrameTask(robot, [base], gain_rot=1 / DT, pos_key=None, rot_key="base_rmat"),
    ]
    constraints = [
        JointLimits(robot, v_max=None, v_min=None, gain=1 / DT),
        ObjectConstraint(robot, index=0, max_rows=max_rows, gain=1 / DT),
    ]
    solver = DiffIKSolver(robot, tasks, constraints, regularization=0.1)
    static = {"object_sdf_0": sdf.as_ref(), "base_rmat": tfs[base][None, :3, :3]}
    return solver, hand, static


def _object_gap(model, sdf, qs, pos, rot) -> np.ndarray:
    """(T, S) ``d - r`` of every sphere against the object, from the analytic-grid lookup."""
    radii = np.asarray(model.robot.flat_collision_radii)
    centres = _spheres(model.robot, qs)
    out = np.empty(centres.shape[:2])
    for t in range(len(qs)):
        local = (centres[t] - pos[t]) @ rot[t]
        out[t] = sdf.signed_distance(local) - radii
    return out


def _run_hand(model, half, box_path, target, steps):
    q0 = _stand_q(model)
    sdf = build_object_sdf(_object(extents=2 * np.asarray(half)), 1.0)
    solver, hand, static = _hand_rig(model, sdf, q0)
    pos = np.broadcast_to(box_path, (steps, 3)) if np.ndim(box_path) == 1 else box_path
    rot = np.tile(np.eye(3), (steps, 1, 1))
    frames = {
        "pos": jnp.asarray(np.tile(target, (steps, 1))[:, None]),
        "object_pos": jnp.asarray(pos[:, None]),
        "object_rot": jnp.asarray(rot[:, None]),
    }

    @jax.jit
    def scan(q0, frames):
        def body(state, frame):
            state, _, info = solver.step(state, {**frame, **static}, DT)
            return state, (state.q, info.qp_converged)

        return jax.lax.scan(body, solver.init(q0), frames)[1]

    qs, converged = scan(jnp.asarray(q0), frames)
    return sdf, np.asarray(qs), np.asarray(converged), pos, rot, hand


def _hand0(model):
    robot = model.robot
    hand, _ = model.link_frame("left_hand_link")
    return np.asarray(robot.joint_to_world_transforms(jnp.asarray(_stand_q(model))))[hand][:3, 3]


def test_hand_driven_into_a_box_does_not_penetrate(model) -> None:
    hand0 = _hand0(model)
    centre = hand0 + np.array([0.0, 0.22, 0.1])  # beside the hand; the target is its centre
    half = (0.1, 0.1, 0.1)
    sdf, qs, converged, pos, rot, hand = _run_hand(model, half, centre, centre, 40)
    gap = _object_gap(model, sdf, qs, pos, rot)
    assert converged.all() and np.isfinite(qs).all()
    assert gap.min() > -0.002
    # The hand did go to the box (touching it), not away.
    assert gap[-1].min() < 0.01


def test_hand_pushed_by_a_box_moving_towards_it(model) -> None:
    hand0 = _hand0(model)
    steps = 60
    end = hand0 + np.array([0.0, 0.05, 0.0])  # the box face ends 3 cm inside the hand
    path = end + np.array([0.0, 0.4, 0.0]) * np.linspace(1.0, 0.0, steps)[:, None]  # 7 mm/frame
    sdf, qs, converged, pos, rot, hand = _run_hand(model, (0.08, 0.08, 0.08), path, hand0, steps)
    gap = _object_gap(model, sdf, qs, pos, rot)
    assert converged.all() and np.isfinite(qs).all()
    assert gap.min() > -0.002
    assert gap[-1].min() < 0.005  # the box really did arrive
    tfs = np.asarray(model.robot.joint_to_world_transforms(jnp.asarray(qs[-1])))
    assert hand0[1] - tfs[hand][1, 3] > 0.03  # and pushed the hand back


def test_spheres_inside_the_box_leave(model) -> None:
    hand0 = _hand0(model)
    sdf = build_object_sdf(_object(extents=(0.3, 0.3, 0.3)), 1.0)
    solver, hand, static = _hand_rig(model, sdf, _stand_q(model))
    pos = np.tile(hand0 + np.array([0.0, 0.0, 0.0]), (30, 1))
    rot = np.tile(np.eye(3), (30, 1, 1))
    frames = {
        "pos": jnp.asarray(np.tile(hand0, (30, 1))[:, None]),
        "object_pos": jnp.asarray(pos[:, None]),
        "object_rot": jnp.asarray(rot[:, None]),
    }

    @jax.jit
    def scan(q0, frames):
        def body(state, frame):
            state, _, _ = solver.step(state, {**frame, **static}, DT)
            return state, state.q

        return jax.lax.scan(body, solver.init(q0), frames)[1]

    qs = np.asarray(scan(jnp.asarray(_stand_q(model)), frames))
    gap = _object_gap(model, sdf, qs, pos, rot)
    assert gap[0].min() < -0.01  # starts inside
    assert gap[-1].min() > -0.002  # and gets out


# --- pipeline ---------------------------------------------------------------------------------


@pytest.fixture(scope="module")
def toy(tmp_path_factory):
    return write_toy_robot(tmp_path_factory.mktemp("robots_pipe") / "toy")


@pytest.fixture(scope="module")
def calibration(toy) -> str:
    path = toy.preset.root_dir / "retarget_calibration_smpl.yaml"
    save_calibration(
        RobotRetargetCalibration(
            robot=toy.preset.name,
            reference="smpl",
            calibrated_joint_q={name: 0.0 for name in toy.dof_names()},
            notes="self-contained object pipeline fixture",
        ),
        path,
    )
    return str(path)


def _carry_motion(base, *, frames=30, step=0.01, mesh_path="", box=0.16):
    """The skeleton walking +x with a box held on the left wrist target (inside it)."""
    pos = np.repeat(base.positions[:1], frames, axis=0).copy()
    pos[:, :, 0] += step * np.arange(frames)[:, None]
    quat = np.repeat(base.quaternions[:1], frames, axis=0)
    wrist = list(base.hierarchy.bone_names).index("left_wrist")
    centre = pos[:, wrist].copy()
    centre[:, 1] -= 0.02  # the box reaches a little towards the body
    obj = SceneObject(
        name="box",
        positions=centre,
        quaternions=np.tile([0.0, 0.0, 0.0, 1.0], (frames, 1)),
        extents=np.full(3, box),
        mesh_path=mesh_path,
    )
    return dataclasses.replace(base, positions=pos, quaternions=quat, terrain=None, objects=[obj])


def _pipeline(toy, motion, calibration, **scene) -> FraxScenePipeline:
    return FraxScenePipeline.from_calibration(
        toy, motion, calibration, scene_config=FraxSceneConfig(**scene)
    )


def _returned_gap(pipe, motion, result) -> np.ndarray:
    """(T, S) analytic ``d - r`` of the returned motion's spheres against the carried box."""
    meta = result.meta
    scale, z_min = meta["smpl_scale"], meta["source_z_min"]
    obj = motion.objects[0]
    pos = (obj.positions - np.array([0.0, 0.0, z_min])) * scale
    half = obj.extents * scale / 2.0
    robot = pipe.frax_model.robot
    radii = np.asarray(robot.flat_collision_radii)
    q = pipe.frax_model.frax_q_from_joint_q(result.joint_q)
    centres = _spheres(robot, q)
    rot = Rotation.from_quat(obj.quaternions).as_matrix()
    return np.stack([_box_sd((centres[t] - pos[t]) @ rot[t], half) - radii for t in range(len(q))])


def test_pipeline_keeps_the_robot_out_of_the_carried_box(
    toy, calibration, synthetic_terrain_motion
):
    motion = _carry_motion(synthetic_terrain_motion)
    pipe = _pipeline(toy, motion, calibration)
    result = pipe.run(motion)
    meta = result.meta
    gap = _returned_gap(pipe, motion, result)
    assert np.isfinite(result.joint_q).all()
    assert gap.min() > -0.002
    assert meta["objects_grounded"] is True
    assert "objects" in meta["frax"]["constraints"] and meta["frax"]["objects"] == 1
    assert meta["object_signed_min_gap"] == pytest.approx(gap.min(), abs=1.5e-3)
    assert meta["frax"]["qp_converged_ratio"] == 1.0

    # The same clip with the barrier off puts the hand deep inside the box.
    off = _pipeline(toy, motion, calibration, objects=False)
    off_result = off.run(motion)
    assert _returned_gap(off, motion, off_result).min() < -0.02
    assert off_result.meta["objects_grounded"] is False
    assert np.isnan(off_result.meta["object_signed_min_gap"])
    assert "objects" not in off_result.meta["frax"]["constraints"]


def test_pipeline_with_a_mesh_object(toy, calibration, synthetic_terrain_motion, tmp_path):
    mesh = _write_box_obj(tmp_path / "carry.obj", (1.0, 1.0, 1.0))
    motion = _carry_motion(synthetic_terrain_motion, mesh_path=mesh)
    motion.objects[0].scale = 0.16
    pipe = _pipeline(toy, motion, calibration)
    result = pipe.run(motion)
    assert _returned_gap(pipe, motion, result).min() > -0.004


def test_clip_without_objects_is_unchanged(toy, calibration, synthetic_terrain_motion):
    plain = dataclasses.replace(_carry_motion(synthetic_terrain_motion), objects=[])
    a = _pipeline(toy, plain, calibration).run(plain)
    b = _pipeline(toy, plain, calibration, objects=False).run(plain)
    np.testing.assert_array_equal(a.joint_q, b.joint_q)
    assert "objects" not in a.meta["frax"]["constraints"]
    assert a.meta["objects_grounded"] is False and np.isnan(a.meta["object_signed_min_gap"])


def test_shoulder_edit_is_guarded_for_object_clips(
    toy, calibration, synthetic_terrain_motion, monkeypatch
):
    """An upper-body edit that pushes a hand into the object is blended back."""
    import hhtools.robot.retarget_profile as profile
    from hhtools.retarget.frax_backend import scene_pipeline

    motion = _carry_motion(synthetic_terrain_motion)
    dofs = list(toy.dof_names())
    cols = [7 + dofs.index(f"left_{j}_joint") for j in ("shoulder_pitch", "shoulder_roll")]

    def results(sign, guarded):
        def edit(joint_q, *args, **kwargs):
            out = np.array(joint_q, copy=True)
            out[:, cols[1]] += sign * 0.5
            return out

        monkeypatch.setattr(profile, "apply_upper_body_roll_narrowing_post_ik", edit)
        if not guarded:
            monkeypatch.setattr(
                scene_pipeline, "_limit_edit_by_terrain", lambda pre, post, gap_fn, fps: (post, 0)
            )
        pipe = _pipeline(toy, motion, calibration)
        result = pipe.run(motion)
        monkeypatch.undo()
        return _returned_gap(pipe, motion, result).min(), result

    worst_unguarded = min(results(sign, False)[0] for sign in (1.0, -1.0))
    assert worst_unguarded < -0.004  # the edit does push a hand into the box
    for sign in (1.0, -1.0):
        gap, result = results(sign, True)
        assert gap > -0.002
    assert any(
        results(sign, True)[1].meta["frax"]["shoulder_edit_limited_frames"] > 0
        for sign in (1.0, -1.0)
    )


# --- back-half guards -------------------------------------------------------------------------


def test_floor_snap_is_reduced_to_avoid_object_penetration() -> None:
    T = 6
    jq = np.zeros((T, 10), np.float32)
    jq[:, 2] = 0.12

    def gap(q):  # the hands are 7 cm above an object below; lowering the root approaches it
        return q[:, 2] - 0.05

    shift, reduced = _limit_root_shift(jq, 0.10, gap)
    moved = jq.copy()
    moved[:, 2] -= 0.10
    assert gap(moved).min() < -0.02  # without the guard the full snap penetrates
    assert reduced
    assert 0.0 < shift < 0.10
    moved = jq.copy()
    moved[:, 2] -= shift
    assert gap(moved).min() >= -1e-4 - 1e-6
    assert shift == pytest.approx(0.07, abs=2e-3)


def test_floor_snap_is_kept_when_it_is_harmless() -> None:
    jq = np.zeros((4, 9), np.float32)
    jq[:, 2] = 0.2
    shift, reduced = _limit_root_shift(jq, 0.05, lambda q: q[:, 2] - 0.0)
    assert shift == 0.05 and not reduced
    # A frame already inside the object is no obstacle to a snap that does not deepen it.
    shift, reduced = _limit_root_shift(jq, 0.05, lambda q: np.full(len(q), -0.01))
    assert shift == 0.05 and not reduced
    assert _limit_root_shift(jq, 0.0, lambda q: q[:, 2]) == (0.0, False)


def test_shoulder_edit_limiter_uses_object_gaps() -> None:
    T, nq = 12, 10
    pre = np.zeros((T, nq), np.float32)
    post = pre.copy()
    post[:, 8] = 0.3  # the edit swings a shoulder joint into the object

    def gap(q):
        return 0.04 - 0.2 * q[:, 8]  # 4 cm clear before, 2 cm inside after the full edit

    assert gap(post).min() < -0.01  # unguarded: penetrates
    blended, limited = _limit_edit_by_terrain(pre, post, gap, 30.0)
    assert limited > 0
    assert gap(blended).min() >= -1e-4 - 1e-6
    assert blended[:, 8].max() > 0.0  # but part of the edit survives


def _masking_gaps():
    """Two radius-1 cm spheres and a 25 cm box: ``(gap_fn, q0)``.

    Sphere 0 sits 16 mm inside the box side and stays there; sphere 1 is 10 mm clear above the
    top.  ``q[:, 2]`` moves both spheres (the root), ``q[:, 7]`` lowers sphere 1 only (an arm).
    """
    box = _object(extents=(0.25, 0.25, 0.25))
    sdf = build_object_sdf(box, 1.0, dx=0.005)
    gaps = _object_gap_fn([sdf], np.zeros((1, 1, 3)), np.eye(3)[None, None], np.full(2, 0.01))

    def gap(q):
        centres = np.array([[[0.119, 0.0, 0.03], [0.0, 0.0, 0.145]]], dtype=np.float64)
        centres = np.repeat(centres, len(q), axis=0)
        centres[:, :, 2] += np.asarray(q)[:, 2:3]
        centres[:, 1, 2] -= np.asarray(q)[:, 7]
        return gaps(centres)

    return gap, np.zeros((1, 8), np.float32)


def test_object_gaps_are_per_sphere() -> None:
    gap, q = _masking_gaps()
    g = gap(q)
    assert g.shape == (1, 2)
    np.testing.assert_allclose(g[0], [-0.016, 0.010], atol=2e-3)


def test_root_shift_is_not_masked_by_a_deeper_existing_penetration() -> None:
    gap, q = _masking_gaps()
    shift, reduced = _limit_root_shift(q, 0.020, gap)
    assert reduced
    assert shift <= 0.0101 + 1e-4  # sphere 1 may use its 10 mm of clearance, not more


def test_shoulder_edit_is_not_masked_by_a_deeper_existing_penetration() -> None:
    gap, q = _masking_gaps()
    post = q.copy()
    post[:, 7] = 0.020
    out, limited = _limit_edit_by_terrain(q, post, gap, 30.0)
    assert limited == 1
    assert 0.0 < out[0, 7] <= 0.0101 + 1e-4


def test_guards_compare_pairs_not_the_minimum_across_constraints() -> None:
    """A terrain pair that already penetrates deeply must not hide an object pair."""
    pre = np.zeros((4, 8), np.float32)
    post = pre.copy()
    post[:, 7] = 0.04

    def gaps(q):  # columns: a deep terrain penetration (constant), an object gap that shrinks
        return np.stack([np.full(len(q), -0.05), 0.02 - q[:, 7]], axis=1)

    out, limited = _limit_edit_by_terrain(pre, post, gaps, 30.0)
    assert limited > 0
    assert gaps(out)[:, 1].min() >= -1e-4 - 1e-6
    shift, reduced = _limit_root_shift(
        pre, 0.04, lambda q: np.stack([np.full(len(q), -0.05), 0.02 + q[:, 2]], axis=1)
    )
    assert reduced and shift == pytest.approx(0.02, abs=5e-4)


def test_snap_cannot_move_a_hand_through_a_shelf() -> None:
    q = np.zeros((1, 7), np.float32)
    q[0, 2] = 0.025

    def gap(p):  # slab spanning [-5, +5] mm, sphere radius 10 mm
        return np.abs(p[:, 2]) - 0.005 - 0.010

    assert gap(np.asarray(q) - np.array([0, 0, 0.05, 0, 0, 0, 0], np.float32)).min() > 0.0
    shift, reduced = _limit_root_shift(q, 0.050, gap)
    assert reduced
    assert shift == pytest.approx(0.010, abs=5e-4)


def test_object_constraint_defaults_to_every_sphere(model) -> None:
    c = ObjectConstraint(model.robot, 0)
    assert len(c.sphere_idxs) == len(np.asarray(model.robot.flat_collision_radii))
    assert c.num_rows == len(c.sphere_idxs)
    capped = ObjectConstraint(model.robot, 0, max_rows=8)
    assert capped.num_rows == 8
