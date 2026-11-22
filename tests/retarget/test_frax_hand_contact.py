"""FRAX hand-object contact: hand surface points, point rows, contact-phase hand targets."""

from __future__ import annotations

import dataclasses
import re

import numpy as np
import pytest

pytest.importorskip("frax")
pytest.importorskip("elastiqp")

# isort: off
from frax_toy_robot import toy_humanoid_urdf, write_toy_robot  # noqa: E402

from hhtools.retarget.frax_backend.hand_contact import (  # noqa: E402  (configures JAX first)
    contact_mask,
    farthest_point_sample,
    hand_body_joints,
    hand_surface_points,
    hand_target_groups,
    project_hand_targets,
)
from hhtools.retarget.frax_backend.objects import (  # noqa: E402
    ObjectConstraint,
    build_object_sdf,
)
from hhtools.retarget.frax_backend.scene_pipeline import (  # noqa: E402
    FraxSceneConfig,
    FraxScenePipeline,
    _fk_points,
    _frax_point_frames,
)
import jax  # noqa: E402
import jax.numpy as jnp  # noqa: E402
from frax.ik import DiffIKSolver, FrameTask, JointLimits  # noqa: E402
from scipy.spatial.transform import Rotation  # noqa: E402

from hhtools.core.scene import SceneObject  # noqa: E402
from hhtools.retarget.calibration import RobotRetargetCalibration, save_calibration  # noqa: E402
from hhtools.retarget.frax_backend.collision import collision_spec_for_robot  # noqa: E402
from hhtools.retarget.frax_backend.model import build_frax_robot_model  # noqa: E402
from hhtools.retarget.interaction_mesh.mpc_loop import RobotMpcPoint  # noqa: E402
from hhtools.retarget.interaction_mesh.mujoco_scene import MujocoScene  # noqa: E402

# isort: on

DT = 0.02
HAND_HALF = 0.03  # the toy hand is a 6 cm cube
BOX_HALF = 0.1


# --- helpers --------------------------------------------------------------------------------


def _box_sd(points: np.ndarray, half) -> np.ndarray:
    q = np.abs(points) - np.asarray(half)
    return np.linalg.norm(np.maximum(q, 0.0), axis=-1) + np.minimum(q.max(axis=-1), 0.0)


def _toy_urdf_with_hand_joints() -> str:
    """The toy humanoid whose hand links hang on (frozen: not in ``dof_order``) revolute joints,
    so each hand is a MuJoCo body of its own (a fixed joint would fuse it into the forearm)."""
    return re.sub(
        r'(<joint name="(?:left|right)_hand_joint" type=")fixed(">.*?)</joint>',
        r'\1revolute\2<axis xyz="0 1 0"/><limit lower="-1.5" upper="1.5" effort="50" '
        r'velocity="20"/></joint>',
        toy_humanoid_urdf(),
        flags=re.S,
    )


@pytest.fixture(scope="module")
def toy_hand(tmp_path_factory):
    root = tmp_path_factory.mktemp("robots_hand") / "toy_hand"
    return write_toy_robot(root, urdf=_toy_urdf_with_hand_joints(), name="toy_hand")


@pytest.fixture(scope="module")
def calibration(toy_hand) -> str:
    path = toy_hand.preset.root_dir / "retarget_calibration_smpl.yaml"
    save_calibration(
        RobotRetargetCalibration(
            robot=toy_hand.preset.name,
            reference="smpl",
            calibrated_joint_q={name: 0.0 for name in toy_hand.dof_names()},
            notes="self-contained hand contact fixture",
        ),
        path,
    )
    return str(path)


@pytest.fixture(scope="module")
def scene(toy_hand):
    return MujocoScene.from_robot(toy_hand)


# --- surface points ---------------------------------------------------------------------------


def test_farthest_point_sample_is_deterministic_and_spread() -> None:
    rng = np.random.default_rng(3)
    pts = rng.normal(size=(500, 3))
    a = farthest_point_sample(pts, 24)
    np.testing.assert_array_equal(a, farthest_point_sample(pts.copy(), 24))
    assert a.shape == (24, 3)
    assert len({tuple(p) for p in a}) == 24
    # Spread: every sample is farther from the others than a random pick would be.
    dist = np.linalg.norm(a[:, None] - a[None], axis=-1) + np.eye(24) * 9.0
    assert dist.min() > 0.8
    # Fewer distinct points than asked: all of them, once.
    assert len(farthest_point_sample(np.repeat(pts[:5], 3, axis=0), 24)) == 5


def test_hand_points_lie_on_a_primitive_hand_surface(scene) -> None:
    points = hand_surface_points(scene.model, 24)
    assert {p.body_name for p in points} == {"left_hand_link", "right_hand_link"}
    assert len(points) == 48
    again = hand_surface_points(scene.model, 24)
    for p, q in zip(points, again, strict=True):
        assert p.body_name == q.body_name
        np.testing.assert_array_equal(p.local_offset, q.local_offset)
    local = np.stack([p.local_offset for p in points if p.body_name == "left_hand_link"])
    np.testing.assert_allclose(np.abs(local).max(axis=1), HAND_HALF, atol=1e-9)  # on the cube
    # Spread over the cube: all eight corners, and every one of its six faces holds several.
    assert (np.abs(local) > HAND_HALF - 1e-9).all(axis=1).sum() == 8
    for axis in range(3):
        for sign in (-1.0, 1.0):
            assert (np.isclose(local[:, axis], sign * HAND_HALF)).sum() >= 4


def test_hand_points_of_a_robot_without_hand_bodies(tmp_path) -> None:
    """The stock toy fuses its hands into the forearms: there is nothing to sample."""
    plain = write_toy_robot(tmp_path / "plain", name="toy_plain")
    assert hand_surface_points(MujocoScene.from_robot(plain).model, 24) == []


def test_hand_points_lie_on_a_mesh_hand_surface() -> None:
    """Mesh vertices, in the body frame, however MuJoCo recentres the mesh."""
    import mujoco
    import trimesh

    offset = np.array([0.03, 0.01, -0.02])
    half = np.array([0.04, 0.03, 0.02])
    box = trimesh.creation.box(extents=2 * half)
    box.apply_translation(offset)
    xml = (
        '<mujoco><asset><mesh name="hand" file="hand.obj"/></asset><worldbody>'
        '<body name="left_hand"><freejoint/>'
        '<geom type="mesh" mesh="hand" contype="1" conaffinity="1"/>'
        "</body></worldbody></mujoco>"
    )
    obj = trimesh.exchange.obj.export_obj(box).encode()
    model = mujoco.MjModel.from_xml_string(xml, assets={"hand.obj": obj})
    points = hand_surface_points(model, 24)
    assert len(points) == 8  # a box mesh has eight distinct vertices
    local = np.stack([p.local_offset for p in points])
    dist = trimesh.proximity.closest_point(box, local)[1]
    assert dist.max() < 1e-6


def test_mapped_frames_reproduce_mujoco_world_positions(toy_hand, scene) -> None:
    import mujoco

    from hhtools.retarget.frax_backend.pipeline import _frax_model_for
    from hhtools.retarget.interaction_mesh.mpc_loop import _current_robot_point_positions

    model = _frax_model_for(toy_hand, _cfg(toy_hand))
    points = hand_surface_points(scene.model, 24)
    joints, offsets = _frax_point_frames(model, scene.model, points)
    rng = np.random.default_rng(11)
    data = mujoco.MjData(scene.model)
    robot = model.robot
    q = np.array(robot.default_configuration, dtype=np.float64)
    q[:3] = (0.1, -0.2, 0.9)
    quat_xyzw = Rotation.from_rotvec([0.3, -0.5, 0.7]).as_quat()
    q[3:7] = (quat_xyzw[3], *quat_xyzw[:3])
    names = list(robot.joint_names[model.nv_floating :])
    values = rng.uniform(-0.9, 0.9, len(names))
    q[7:] = values
    data.qpos[:7] = q[:7]
    for name, value in zip(names, values, strict=True):
        jid = mujoco.mj_name2id(scene.model, mujoco.mjtObj.mjOBJ_JOINT, name)
        data.qpos[scene.model.jnt_qposadr[jid]] = value
    mujoco.mj_forward(scene.model, data)
    world = _current_robot_point_positions(scene.model, data, points)
    np.testing.assert_allclose(_fk_points(model, q, joints, offsets), world, atol=1e-6)
    hands = {model.link_frame(f"{side}_hand_link")[0] for side in ("left", "right")}
    assert hands <= set(joints) and hand_body_joints(points, joints) == tuple(sorted(hands))


def _cfg(toy_hand):
    from hhtools.retarget.frax_backend.config import frax_config_for_preset

    return frax_config_for_preset(toy_hand.preset).with_overrides(floor=True)


# --- the barrier on hand points ---------------------------------------------------------------


@pytest.fixture(scope="module")
def hand_model(toy_hand):
    """The toy with an *inscribed* sphere on each hand: the 6 cm cube's edges stick out 1.2 cm."""
    spec = collision_spec_for_robot(toy_hand)
    for side in ("left", "right"):
        spec.spheres[f"{side}_hand_link"] = [((0.0, 0.0, 0.0), HAND_HALF)]
    return build_frax_robot_model(toy_hand, collision=spec)


def _hand_cube_gap(model, qs, obj_pos, obj_rot) -> np.ndarray:
    """(T,) smallest distance of the left hand cube's surface to the box, from dense samples."""
    hand, _ = model.link_frame("left_hand_link")
    g = np.linspace(-HAND_HALF, HAND_HALF, 13)
    u, v = (a.ravel() for a in np.meshgrid(g, g))
    ones = np.full_like(u, HAND_HALF)
    local = np.vstack(
        [np.c_[s * ones, u, v] for s in (-1, 1)]
        + [np.c_[u, s * ones, v] for s in (-1, 1)]
        + [np.c_[u, v, s * ones] for s in (-1, 1)]
    )
    out = []
    for q in qs:
        tf = np.asarray(model.robot.joint_to_world_transforms(jnp.asarray(q)))[hand]
        world = local @ tf[:3, :3].T + tf[:3, 3]
        out.append(_box_sd((world - obj_pos) @ obj_rot, BOX_HALF).min())
    return np.asarray(out)


def _run_hand_into_box(model, hand_points, steps=130):
    """Push the box into the left hand and return the hand cube's gap to it per step."""
    robot = model.robot
    hand, _ = model.link_frame("left_hand_link")
    q0 = np.array(robot.default_configuration, dtype=np.float64)
    q0[2] = 0.86
    tfs = np.asarray(robot.joint_to_world_transforms(jnp.asarray(q0)))
    hand0 = tfs[hand][:3, 3]
    # A box tilted 45 degrees about x whose face normal (0, -1, -1) / sqrt(2) looks at the hand.
    # Its face moves in from 12 cm to 1 cm from the hand's centre: the cube's edge along x
    # (4.2 cm from its centre) meets it first and the box then pushes the hand back.
    rot = Rotation.from_euler("x", 45, degrees=True).as_matrix()
    toward = np.array([0.0, 1.0, 1.0]) / np.sqrt(2.0)
    face = np.concatenate([np.linspace(0.12, 0.01, 50), np.full(steps - 50, 0.01)])
    centres = hand0 + toward * (face + BOX_HALF)[:, None]
    sdf = build_object_sdf(
        SceneObject(
            name="box",
            positions=np.zeros((1, 3)),
            quaternions=np.array([[0.0, 0.0, 0.0, 1.0]]),
            extents=np.full(3, 2 * BOX_HALF),
        ),
        1.0,
    )
    kwargs = {}
    if hand_points is not None:
        kwargs = {
            "sphere_margins": np.zeros(len(robot.flat_collision_radii)),
            "point_joints": [hand] * len(hand_points),
            "point_offsets": hand_points,
            "point_margin": 0.003,
        }
    base = robot.nv_floating - 1
    solver = DiffIKSolver(
        robot,
        [
            FrameTask(robot, [hand], gain_pos=1 / DT, pos_key="pos", rot_key=None),
            FrameTask(robot, [base], gain_rot=1 / DT, pos_key=None, rot_key="base"),
        ],
        [
            JointLimits(robot, v_max=None, v_min=None, gain=1 / DT),
            ObjectConstraint(robot, index=0, max_rows=32, gain=1 / DT, **kwargs),
        ],
        regularization=0.1,
    )
    static = {"object_sdf_0": sdf.as_ref()}
    frames = {
        "pos": jnp.asarray(np.tile(hand0, (steps, 1, 1))),
        "base": jnp.asarray(np.tile(tfs[base][:3, :3], (steps, 1, 1, 1))),
        "object_pos": jnp.asarray(centres[:, None]),
        "object_rot": jnp.asarray(np.tile(rot, (steps, 1, 1, 1))),
    }

    @jax.jit
    def scan(q0, frames):
        def body(state, frame):
            state, _, _ = solver.step(state, {**frame, **static}, DT)
            return state, state.q

        return jax.lax.scan(body, solver.init(q0), frames)[1]

    qs = np.asarray(scan(jnp.asarray(q0), frames))
    return np.array(
        [_hand_cube_gap(model, qs[t : t + 1], centres[t], rot)[0] for t in range(steps)]
    )


def _cube_points(model, scene_model):
    hand, _ = model.link_frame("left_hand_link")
    points = [p for p in hand_surface_points(scene_model, 24) if p.body_name == "left_hand_link"]
    offsets = np.tile(np.eye(4), (len(points), 1, 1))
    offsets[:, :3, 3] = np.stack([p.local_offset for p in points])
    return hand, offsets


def test_hand_points_stop_the_hand_mesh_at_the_point_margin(hand_model, scene) -> None:
    _, offsets = _cube_points(hand_model, scene.model)
    with_points = _run_hand_into_box(hand_model, offsets)
    spheres_only = _run_hand_into_box(hand_model, None)
    # The mesh settles 3 mm from the box (the point margin) ...
    assert with_points[-1] == pytest.approx(0.003, abs=0.0015)
    assert with_points.min() > 0.0
    # ... while the inscribed sphere (margin 0) lets the cube's edge into the box.
    assert spheres_only.min() < -0.003


def test_constraint_rows_cover_spheres_and_points(hand_model, scene) -> None:
    hand, offsets = _cube_points(hand_model, scene.model)
    robot = hand_model.robot
    n_spheres = len(robot.flat_collision_radii)
    sdf = build_object_sdf(
        SceneObject(
            name="box",
            positions=np.zeros((1, 3)),
            quaternions=np.array([[0.0, 0.0, 0.0, 1.0]]),
            extents=np.full(3, 2 * BOX_HALF),
        ),
        1.0,
    )
    q = np.array(robot.default_configuration, dtype=np.float64)
    q[2] = 0.86
    ref = {
        "object_sdf_0": sdf.as_ref(),
        "object_pos": jnp.asarray(np.zeros((1, 3))),
        "object_rot": jnp.asarray(np.eye(3)[None]),
    }
    kw = {"point_joints": [hand] * len(offsets), "point_offsets": offsets, "point_margin": 0.003}
    every = ObjectConstraint(robot, index=0, **kw)
    assert every.num_rows == n_spheres + len(offsets)
    G, h = every.rows(jnp.asarray(q), ref)
    assert G.shape == (n_spheres + len(offsets), robot.nv) and h.shape == (
        n_spheres + len(offsets),
    )
    pruned = ObjectConstraint(robot, index=0, max_rows=10, **kw)
    assert pruned.num_rows == 10
    G2, h2 = pruned.rows(jnp.asarray(q), ref)
    assert G2.shape == (10, robot.nv)
    # The pruned rows are the 10 lowest-barrier ones of the full set.
    np.testing.assert_allclose(np.sort(np.asarray(h2)), np.sort(np.asarray(h))[:10], atol=1e-12)
    # Without points the rows are the sphere rows only.
    assert ObjectConstraint(robot, index=0).num_rows == n_spheres


# --- contact-phase targets --------------------------------------------------------------------


def _hand_points() -> list[RobotMpcPoint]:
    zero = np.zeros(3)
    return [
        RobotMpcPoint("hips", zero, semantic="hips"),
        RobotMpcPoint("left_hand_link", zero, semantic="left_wrist"),
        RobotMpcPoint("left_hand_link", np.array([0.1, 0.0, 0.0]), semantic="left_wrist:hand_tip"),
        RobotMpcPoint("right_hand_link", zero, semantic="right_wrist"),
    ]


def _box_world(frames: int):
    sdf = build_object_sdf(
        SceneObject(
            name="box",
            positions=np.zeros((1, 3)),
            quaternions=np.array([[0.0, 0.0, 0.0, 1.0]]),
            extents=np.full(3, 2 * BOX_HALF),
        ),
        1.0,
    )
    return [sdf], np.zeros((frames, 1, 3)), np.tile(np.eye(3), (frames, 1, 1, 1))


def _targets(tip_x: np.ndarray) -> np.ndarray:
    """(T, 4, 3): hips far away, left wrist 10 cm behind the tip, right hand far away."""
    frames = len(tip_x)
    out = np.zeros((frames, 4, 3))
    out[:, 0] = (2.0, 2.0, 2.0)
    out[:, 2, 0] = tip_x
    out[:, 1, 0] = tip_x - 0.1
    out[:, 3] = (-2.0, 0.0, 0.0)
    return out


def test_hand_groups_follow_the_semantic() -> None:
    groups = hand_target_groups(_hand_points())
    assert groups == {"left_wrist": ([1, 2], 2), "right_wrist": ([3], 3)}


def test_a_target_2cm_off_the_face_lands_on_it_and_one_6cm_off_is_untouched() -> None:
    sdfs, pos, rot = _box_world(30)
    near = _targets(np.full(30, BOX_HALF + 0.02))
    out, info = project_hand_targets(near, _hand_points(), sdfs, pos, rot, depth=-0.003, fps=30.0)
    assert out[15, 2, 0] == pytest.approx(BOX_HALF + 0.003, abs=1.5e-3)
    # The whole hand moves rigidly: the wrist point keeps its offset from the tip.
    np.testing.assert_allclose(out[:, 2] - out[:, 1], near[:, 2] - near[:, 1], atol=1e-12)
    np.testing.assert_array_equal(out[:, [0, 3]], near[:, [0, 3]])  # other points untouched
    assert info["left_wrist"]["contact_frames"] == 30
    assert info["left_wrist"]["max_correction_m"] == pytest.approx(0.017, abs=2e-3)
    assert info["right_wrist"]["contact_frames"] == 0

    far = _targets(np.full(30, BOX_HALF + 0.06))
    out_far, info_far = project_hand_targets(
        far, _hand_points(), sdfs, pos, rot, depth=-0.003, fps=30.0
    )
    np.testing.assert_array_equal(out_far, far)
    assert info_far["left_wrist"]["contact_frames"] == 0
    assert info_far["left_wrist"]["max_correction_m"] == 0.0


def test_a_target_already_inside_keeps_pressing_unless_pushed_out() -> None:
    sdfs, pos, rot = _box_world(30)
    inside = _targets(np.full(30, BOX_HALF - 0.04))
    kwargs = {"depth": -0.003, "fps": 30.0}
    kept, info = project_hand_targets(inside, _hand_points(), sdfs, pos, rot, **kwargs)
    np.testing.assert_array_equal(kept, inside)  # deeper than wanted: it presses the hand on
    assert info["left_wrist"]["contact_frames"] == 30
    out, _ = project_hand_targets(inside, _hand_points(), sdfs, pos, rot, push_out=True, **kwargs)
    assert out[15, 2, 0] == pytest.approx(BOX_HALF + 0.003, abs=1.5e-3)
    assert np.abs(out[15, 2, 1:]).max() < 1e-6  # along the field gradient: straight out


def test_the_target_can_be_placed_inside_the_surface() -> None:
    """``depth`` is how far inside the face the reference target is put: 2 cm off -> 1 cm in."""
    sdfs, pos, rot = _box_world(30)
    near = _targets(np.full(30, BOX_HALF + 0.02))
    out, info = project_hand_targets(near, _hand_points(), sdfs, pos, rot, depth=0.01, fps=30.0)
    assert out[15, 2, 0] == pytest.approx(BOX_HALF - 0.01, abs=1.5e-3)
    assert info["left_wrist"]["max_correction_m"] == pytest.approx(0.03, abs=2e-3)


def test_the_ramp_limits_the_jump_of_the_target() -> None:
    sdfs, pos, rot = _box_world(60)
    x = np.full(60, BOX_HALF + 0.2)
    x[20:40] = BOX_HALF + 0.02  # a contact episode
    pts = _hand_points()
    hard, info_hard = project_hand_targets(
        _targets(x), pts, sdfs, pos, rot, depth=-0.003, ramp_s=0.0, fps=30.0
    )
    soft, info_soft = project_hand_targets(
        _targets(x), pts, sdfs, pos, rot, depth=-0.003, ramp_s=0.15, fps=30.0
    )
    assert info_hard["left_wrist"]["max_jump_m"] == pytest.approx(0.017, abs=2e-3)
    assert info_soft["left_wrist"]["max_jump_m"] < 0.5 * info_hard["left_wrist"]["max_jump_m"]
    # The ramp reaches before and after the episode, never below the raw correction inside it.
    moved = np.abs(soft[:, 2, 0] - _targets(x)[:, 2, 0]) > 0
    assert moved[18] and moved[41] and not moved[5] and not moved[55]
    assert (
        info_soft["left_wrist"]["max_correction_m"] >= info_hard["left_wrist"]["max_correction_m"]
    )


def test_contact_has_hysteresis_and_a_minimum_length() -> None:
    d = np.array([0.04, 0.025, 0.04, 0.049, 0.06, 0.04, 0.025, 0.04, 0.2, 0.01, 0.2])
    on = contact_mask(d, 0.03, 0.05, min_frames=1)
    # Enters at 3 cm, stays up to 5 cm, leaves above it and needs 3 cm to enter again.
    assert on.tolist() == [False, True, True, True, False, False, True, True, False, True, False]
    # Episodes shorter than three frames are dropped: (1, 2, 3) stays, the single frames go.
    long_only = contact_mask(d, 0.03, 0.05, min_frames=3)
    assert long_only.tolist() == [False, True, True, True] + [False] * 7

    sdfs, pos, rot = _box_world(len(d))
    x = BOX_HALF + d
    out, info = project_hand_targets(
        _targets(x), _hand_points(), sdfs, pos, rot, depth=-0.003,
        min_frames=3, ramp_s=0.0, fps=30.0,
    )  # fmt: skip
    moved = np.abs(out[:, 2, 0] - x) > 1e-6
    assert moved.tolist() == long_only.tolist()
    assert info["left_wrist"]["contact_frames"] == 3


# --- pipeline ---------------------------------------------------------------------------------


def _carry_motion(base, *, frames=30, step=0.01, box=0.16):
    """The skeleton walking +x with a box held on the left wrist target (inside it)."""
    pos = np.repeat(base.positions[:1], frames, axis=0).copy()
    pos[:, :, 0] += step * np.arange(frames)[:, None]
    quat = np.repeat(base.quaternions[:1], frames, axis=0)
    wrist = list(base.hierarchy.bone_names).index("left_wrist")
    centre = pos[:, wrist].copy()
    centre[:, 1] -= 0.02
    obj = SceneObject(
        name="box",
        positions=centre,
        quaternions=np.tile([0.0, 0.0, 0.0, 1.0], (frames, 1)),
        extents=np.full(3, box),
    )
    return dataclasses.replace(base, positions=pos, quaternions=quat, terrain=None, objects=[obj])


def _pipeline(toy_hand, motion, calibration, **scene) -> FraxScenePipeline:
    return FraxScenePipeline.from_calibration(
        toy_hand, motion, calibration, scene_config=FraxSceneConfig(**scene)
    )


def _hand_point_gaps(pipe, scene, motion, result) -> np.ndarray:
    """(T, P) analytic distance of every hand surface point of the returned motion to the box."""
    meta = result.meta
    scale, z_min = meta["smpl_scale"], meta["source_z_min"]
    obj = motion.objects[0]
    pos = (obj.positions - np.array([0.0, 0.0, z_min])) * scale
    half = obj.extents * scale / 2.0
    points = hand_surface_points(scene.model, pipe.scene_config.object_points_per_body)
    joints, offsets = _frax_point_frames(pipe.frax_model, scene.model, points)
    q = pipe.frax_model.frax_q_from_joint_q(result.joint_q)
    world = np.stack([_fk_points(pipe.frax_model, qq, joints, offsets) for qq in q])
    return np.stack([_box_sd(world[t] - pos[t], half) for t in range(len(q))])


def test_pipeline_keeps_hand_points_out_of_the_carried_box(
    toy_hand, calibration, scene, synthetic_terrain_motion
):
    motion = _carry_motion(synthetic_terrain_motion)
    pipe = _pipeline(toy_hand, motion, calibration, object_contact_targets=True)
    result = pipe.run(motion)
    frax_meta = result.meta["frax"]
    assert np.isfinite(result.joint_q).all()
    assert frax_meta["object_hand_points"] == 48
    contact = frax_meta["object_contact"]
    assert set(contact) == {"left_wrist", "right_wrist"}
    assert contact["left_wrist"]["contact_frames"] == len(motion.positions)
    assert contact["left_wrist"]["max_correction_m"] == 0.0  # the target is inside: it presses on
    assert contact["right_wrist"]["contact_frames"] == 0
    gaps = _hand_point_gaps(pipe, scene, motion, result)
    assert gaps.min() > -0.002  # no hand point inside the object
    assert result.meta["object_signed_min_gap"] <= gaps.min() + 1e-4  # the guards see the points
    assert frax_meta["qp_converged_ratio"] == 1.0

    # Without the points the hand surface itself is not kept out of the box.
    off = _pipeline(
        toy_hand, motion, calibration, object_hand_points=False, object_contact_targets=False
    )
    off_result = off.run(motion)
    assert off_result.meta["frax"]["object_hand_points"] == 0
    assert off_result.meta["frax"]["object_contact"] == {}


def _tip_gap(pipe, scene, motion, result) -> np.ndarray:
    """(T,) analytic distance of the robot's left hand-tip point to the box."""
    meta = result.meta
    scale, z_min = meta["smpl_scale"], meta["source_z_min"]
    obj = motion.objects[0]
    pos = (obj.positions - np.array([0.0, 0.0, z_min])) * scale
    half = obj.extents * scale / 2.0
    st = pipe.front.prepare_scene_targets(motion, mj_model=scene.model)
    tip = [p for p in st.robot_points if p.semantic == "left_wrist:hand_tip"]
    joints, offsets = _frax_point_frames(pipe.frax_model, scene.model, tip)
    q = pipe.frax_model.frax_q_from_joint_q(result.joint_q)
    world = np.stack([_fk_points(pipe.frax_model, qq, joints, offsets)[0] for qq in q])
    return np.array([_box_sd(world[t] - pos[t], half) for t in range(len(q))])


def test_contact_targets_pull_the_hand_onto_the_surface(
    toy_hand, calibration, scene, synthetic_terrain_motion
):
    """A box face 7 cm from the left hand-tip target: only with contact targets does the tip go
    to it."""
    base = _carry_motion(synthetic_terrain_motion)
    plain = dataclasses.replace(base, objects=[])
    probe = _pipeline(toy_hand, plain, calibration)
    st = probe.front.prepare_scene_targets(plain, mj_model=scene.model)
    tip = next(i for i, p in enumerate(st.robot_points) if p.semantic == "left_wrist:hand_tip")
    scale, z_min = float(st.smpl_scale), float(st.z_min)
    box = 0.2  # metres at the source's scale
    # The box's -y face is 7 cm from the tip target (solver frame), the box on the +y side.
    centre = st.positions[:, tip] + np.array([0.0, 0.07 + 0.5 * box * scale, 0.0])
    obj = dataclasses.replace(
        base.objects[0],
        positions=centre / scale + np.array([0.0, 0.0, z_min]),
        extents=np.full(3, box),
    )
    motion = dataclasses.replace(base, objects=[obj])
    wide = {"object_contact_distance": 0.08, "object_contact_release": 0.1}
    on = _pipeline(toy_hand, motion, calibration, object_contact_targets=True, **wide)
    off = _pipeline(toy_hand, motion, calibration, object_contact_targets=False, **wide)
    result_on = on.run(motion)
    result_off = off.run(motion)
    contact = result_on.meta["frax"]["object_contact"]["left_wrist"]
    assert contact["contact_frames"] == len(motion.positions)
    assert contact["max_correction_m"] == pytest.approx(0.067, abs=0.005)
    tip_on = _tip_gap(on, scene, motion, result_on)
    tip_off = _tip_gap(off, scene, motion, result_off)
    mesh_on = _hand_point_gaps(on, scene, motion, result_on).min(axis=1)
    mesh_off = _hand_point_gaps(off, scene, motion, result_off).min(axis=1)
    assert mesh_on.min() > -0.002 and mesh_off.min() > -0.002
    # The hand mesh ends up near the face the source hand touched, the tip 4 cm or more closer ...
    assert mesh_on[10:].mean() < 0.03
    assert tip_on[10:].mean() < tip_off[10:].mean() - 0.04
    # ... instead of staying where the (robot-proportion) source target left it.
    assert mesh_off[10:].mean() > 0.04


def test_clip_without_objects_is_unchanged_by_the_hand_options(
    toy_hand, calibration, synthetic_terrain_motion
):
    plain = dataclasses.replace(_carry_motion(synthetic_terrain_motion), objects=[])
    a = _pipeline(toy_hand, plain, calibration).run(plain)
    b = _pipeline(
        toy_hand, plain, calibration, object_hand_points=False, object_contact_targets=False
    ).run(plain)
    c = _pipeline(toy_hand, plain, calibration, objects=False).run(plain)
    np.testing.assert_array_equal(a.joint_q, b.joint_q)
    np.testing.assert_array_equal(a.joint_q, c.joint_q)
    assert "object_contact" not in a.meta["frax"] and "object_hand_points" not in a.meta["frax"]
    assert a.meta["frax"]["constraints"] == c.meta["frax"]["constraints"]
