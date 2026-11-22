"""FraxScenePipeline: robot-point frames, terrain tracking, foot sticking, solver cache."""

from __future__ import annotations

import dataclasses

import numpy as np
import pytest

pytest.importorskip("frax")
pytest.importorskip("elastiqp")

# isort: off
from frax_toy_robot import write_toy_robot  # noqa: E402

from hhtools.retarget.frax_backend.scene_pipeline import (  # noqa: E402  (configures JAX first)
    FraxSceneConfig,
    FraxScenePipeline,
    _frax_point_frames,
    _fk_points,
)
import jax  # noqa: E402
import jax.numpy as jnp  # noqa: E402

from hhtools.core.scene import TerrainHeightfield  # noqa: E402
from hhtools.retarget.calibration import RobotRetargetCalibration, save_calibration  # noqa: E402
from hhtools.retarget.frax_backend.collision import collision_spec_for_robot  # noqa: E402
from hhtools.retarget.frax_backend.config import frax_config_for_preset  # noqa: E402
from hhtools.retarget.frax_backend.model import build_frax_robot_model  # noqa: E402
from hhtools.retarget.frax_backend.terrain import build_terrain_grid  # noqa: E402
from hhtools.retarget.frax_backend.pipeline import _actuated_limits  # noqa: E402
from hhtools.retarget.interaction_mesh.mujoco_scene import MujocoScene  # noqa: E402

# isort: on

#: Source height of the terrain floor: the synthetic skeleton's ankles stand at z = 0.2.
FLOOR = 0.2
DX = 0.05
UPPER_BODY = ("spine", "chest", "neck", "head", "shoulder", "elbow", "wrist")


@pytest.fixture(scope="module")
def toy(tmp_path_factory):
    return write_toy_robot(tmp_path_factory.mktemp("robots") / "toy")


@pytest.fixture(scope="module")
def calibration(toy) -> str:
    path = toy.preset.root_dir / "retarget_calibration_smpl.yaml"
    save_calibration(
        RobotRetargetCalibration(
            robot=toy.preset.name,
            reference="smpl",
            calibrated_joint_q={name: 0.0 for name in toy.dof_names()},
            notes="self-contained scene pipeline fixture",
        ),
        path,
    )
    return str(path)


@pytest.fixture
def base_motion(synthetic_terrain_motion):
    return synthetic_terrain_motion


def _terrain(platform=None, nx=80, ny=40) -> TerrainHeightfield:
    hf = np.full((nx, ny), FLOOR, np.float32)
    if platform is not None:
        x0, x1, height = platform
        xs = -1.0 + DX * np.arange(nx)
        hf[(xs >= x0) & (xs <= x1)] = FLOOR + height
    return TerrainHeightfield(
        hf=hf,
        hf_maxmin=np.stack([hf, hf], axis=-1),
        min_point=np.array([-1.0, -1.0], np.float32),
        dx=DX,
    )


def _walk(motion, *, frames=40, step=0.02, platform=None, terrain=True):
    """The skeleton translated ``step`` m per frame along +x (rigid)."""
    pos = np.repeat(motion.positions[:1], frames, axis=0).copy()
    pos[:, :, 0] += step * np.arange(frames)[:, None]
    quat = np.repeat(motion.quaternions[:1], frames, axis=0)
    return dataclasses.replace(
        motion,
        positions=pos,
        quaternions=quat,
        terrain=_terrain(platform) if terrain else None,
    )


def _pipeline(toy, motion, calibration, *, frax=None, **scene) -> FraxScenePipeline:
    return FraxScenePipeline.from_calibration(
        toy,
        motion,
        calibration,
        frax_config=frax,
        scene_config=FraxSceneConfig(**scene),
    )


def _sole_gap(pipe, result, motion) -> np.ndarray:
    """``(T, S)`` true signed distance of every sole sphere's surface to the (scaled) terrain."""
    model = pipe.frax_model
    terrain = pipe.front.scaled_terrain(motion, FLOOR, result.meta["smpl_scale"])
    grid = build_terrain_grid(terrain.hf, terrain.min_point, terrain.dx, shape_bucket=1)
    robot = model.robot
    sole = np.asarray(model.sole_sphere_idxs)
    spheres = jax.vmap(
        lambda q: robot._link_collision_positions(robot.joint_to_world_transforms(q))[sole]
    )(jnp.asarray(model.frax_q_from_joint_q(result.joint_q)))
    spheres = np.asarray(spheres)
    radii = np.asarray(robot.flat_collision_radii)[sole]
    return grid.signed_distance(spheres) - radii


# --- sole spheres ---------------------------------------------------------------------------


def test_sole_sphere_idxs_are_the_sole_link_spheres(toy) -> None:
    spec = collision_spec_for_robot(toy)
    model = build_frax_robot_model(toy, collision=spec)
    assert spec.sole_links
    assert len(model.sole_sphere_idxs) == 8  # two feet, four corner spheres each
    assert set(model.sole_sphere_idxs) <= set(model.floor_sphere_idxs)
    # Spheres are laid out joint by joint; the sole spheres sit on the foot links' joints.
    robot = model.robot
    radii = np.asarray(robot.flat_collision_radii)[list(model.sole_sphere_idxs)]
    np.testing.assert_allclose(radii, radii[0])
    kinematic = build_frax_robot_model(toy)
    assert kinematic.sole_sphere_idxs == ()


# --- robot points -> frax frames ------------------------------------------------------------


def test_point_frames_reproduce_mujoco_points(toy, calibration, base_motion) -> None:
    import mujoco

    from hhtools.retarget.interaction_mesh.mpc_loop import _current_robot_point_positions

    pipe = _pipeline(toy, base_motion, calibration)
    scene = MujocoScene.from_robot(toy)
    points = pipe.front.prepare_scene_targets(base_motion, mj_model=scene.model).robot_points
    joints, offsets = _frax_point_frames(pipe.frax_model, scene.model, points)
    assert len(joints) == len(points) and offsets.shape == (len(points), 4, 4)
    np.testing.assert_array_equal(offsets[:, :3, :3], np.tile(np.eye(3), (len(points), 1, 1)))

    model = pipe.frax_model
    names = list(model.robot.joint_names[model.nv_floating :])
    rng = np.random.default_rng(7)
    data = mujoco.MjData(scene.model)
    for _ in range(4):
        q = np.array(model.robot.default_configuration, dtype=np.float64)
        q[:3] = rng.uniform(-0.5, 0.5, 3)
        quat = rng.normal(size=4)
        q[3:7] = quat / np.linalg.norm(quat)  # wxyz
        q[7:] = rng.uniform(-0.8, 0.8, len(names))
        data.qpos[:] = 0.0
        data.qpos[:7] = q[:7]
        for i, name in enumerate(names):
            jid = mujoco.mj_name2id(scene.model, mujoco.mjtObj.mjOBJ_JOINT, name)
            if jid >= 0:
                data.qpos[scene.model.jnt_qposadr[jid]] = q[7 + i]
        mujoco.mj_forward(scene.model, data)
        expected = _current_robot_point_positions(scene.model, data, points)
        np.testing.assert_allclose(_fk_points(model, q, joints, offsets), expected, atol=1e-5)


# --- tracking -------------------------------------------------------------------------------


def test_flat_terrain_walk_tracks_and_stays_in_limits(toy, calibration, base_motion) -> None:
    motion = _walk(base_motion)
    pipe = _pipeline(toy, motion, calibration)
    result = pipe.run(motion)
    meta = result.meta

    assert result.joint_q.shape == (40, 7 + len(toy.dof_names()))
    assert result.joint_q.dtype == np.float32
    assert np.isfinite(result.joint_q).all()
    assert meta["retarget_backend"] == "frax" and meta["scene_solver"] == "frax"
    assert meta["terrain_grounded"] is True  # exports keep the solved root height
    assert meta["execution_provenance"]["runtime"] == "jax"
    assert meta["frax"]["constraints"] == [
        "joint_limits",
        "terrain",
        "foot_stick",
        "self_collision",
    ]
    assert meta["frax"]["qp_converged_ratio"] == 1.0
    # The toy's proportions differ from the skeleton's (arms cannot reach the wrists):
    # measured mean 0.139 m, pelvis 0.057 m.  Guard against regressions, not accuracy.
    assert meta["alignment_mean_m"] < 0.18
    assert meta["alignment_pelvis_m"] < 0.08

    lower, upper = _actuated_limits(pipe.frax_model, pipe.frax_config)
    dof = result.joint_q[:, 7:]
    order = pipe.frax_model.dof_to_frax
    assert (dof >= lower[order] - 1e-5).all() and (dof <= upper[order] + 1e-5).all()

    # The final Z shift puts the lowest sole sphere on the terrain.
    gap = _sole_gap(pipe, result, motion)
    assert abs(gap.min()) < 2e-3


def test_platform_in_the_path_is_not_penetrated(toy, calibration, base_motion) -> None:
    # The source feet stay at floor height and walk into the platform's face.
    motion = _walk(base_motion, platform=(0.3, 0.9, 0.03))
    gaps = {}
    for substeps in (1, 2):
        pipe = _pipeline(toy, motion, calibration, substeps=substeps, terrain_snap=False)
        result = pipe.run(motion)
        assert np.isfinite(result.joint_q).all()
        gaps[substeps] = float(_sole_gap(pipe, result, motion).min())
        assert 2 <= result.meta["frax"]["terrain_window"] <= 12
    # Measured at the default position weight 0.5: -8.6 mm (1 substep), -5.6 mm (2); with no
    # terrain rows the soles go 30 mm into the platform.  The QP satisfies every terrain row;
    # the residue is the step's linearisation error at the face.
    assert gaps[1] >= -0.010
    assert gaps[2] >= -0.010


def test_terrain_below_the_lowest_joint_is_not_raised(toy, calibration, base_motion) -> None:
    # z = 0 is the source's lowest joint (the ankles); the floor they stand on is 3 cm lower.
    sunk = 0.03
    terrain = _terrain()
    terrain = TerrainHeightfield(
        hf=terrain.hf - sunk,
        hf_maxmin=terrain.hf_maxmin - sunk,
        min_point=terrain.min_point,
        dx=terrain.dx,
    )
    motion = dataclasses.replace(_walk(base_motion), terrain=terrain)
    pipe = _pipeline(toy, motion, calibration)
    result = pipe.run(motion)
    floor_z = result.meta["frax"]["terrain_floor_z"]
    assert floor_z == pytest.approx(-sunk * result.meta["smpl_scale"], abs=1e-6)
    gap = _sole_gap(pipe, result, motion).min(axis=1)  # lowest sole per frame
    # A floor plane at z = 0 held the soles 3 cm above this terrain.
    assert np.median(gap) < 0.005
    assert gap.min() > -0.002


def _left_foot_xy(pipe, motion, result) -> np.ndarray:
    """``(T, 2)`` XY of the robot's left foot point along ``result``."""
    scene = MujocoScene.from_robot(pipe.robot)
    st = pipe.front.prepare_scene_targets(motion, mj_model=scene.model)
    joints, offsets = pipe._frames_for(scene, st.robot_points)
    foot = next(i for i, p in enumerate(st.robot_points) if p.semantic == "left_ankle")
    q = pipe.frax_model.frax_q_from_joint_q(result.joint_q)
    return np.stack(
        [
            _fk_points(pipe.frax_model, qq, [joints[foot]], offsets[foot : foot + 1])[0, :2]
            for qq in q
        ]
    )


# --- foot sticking --------------------------------------------------------------------------


def test_foot_sticking_pins_planted_feet(toy, calibration, base_motion) -> None:
    frames = 30
    pos = np.repeat(base_motion.positions[:1], frames, axis=0).copy()
    names = list(base_motion.hierarchy.bone_names)
    sway = 0.04 * np.sin(2 * np.pi * np.arange(frames) / frames)
    for j, name in enumerate(names):
        if name == "hips" or any(key in name for key in UPPER_BODY):
            pos[:, j, 0] += sway
            pos[:, j, 1] += 0.5 * sway
    motion = dataclasses.replace(
        base_motion,
        positions=pos,
        quaternions=np.repeat(base_motion.quaternions[:1], frames, axis=0),
        terrain=_terrain(),
    )
    tolerance = 1e-3
    pipe = _pipeline(toy, motion, calibration, foot_sticking_tolerance=tolerance)
    result = pipe.run(motion)
    assert result.meta["frax"]["stick_frames"] >= frames - 2
    assert "foot_stick" in result.meta["frax"]["constraints"]

    xy = _left_foot_xy(pipe, motion, result)
    drift = np.linalg.norm(np.diff(xy, axis=0), axis=1)
    # Planted from frame 1 on; allow numerical slack on top of the per-frame tolerance.
    assert drift[1:].max() <= tolerance + 5e-4

    free = _pipeline(toy, motion, calibration, foot_sticking=False)
    assert "foot_stick" not in free.run(motion).meta["frax"]["constraints"]


def test_foot_is_released_in_the_frame_its_target_starts_moving(
    toy, calibration, base_motion
) -> None:
    hold, moving, speed = 12, 16, 0.03
    frames = hold + moving
    pos = np.repeat(base_motion.positions[:1], frames, axis=0).copy()
    pos[hold:, :, 0] += speed * np.arange(1, moving + 1)[:, None]
    motion = dataclasses.replace(
        base_motion,
        positions=pos,
        quaternions=np.repeat(base_motion.quaternions[:1], frames, axis=0),
        terrain=_terrain(),
    )
    pipe = _pipeline(toy, motion, calibration)
    result = pipe.run(motion)
    # Frames 1 .. hold-1 are planted (frame 0 has no previous frame); none after that.
    assert result.meta["frax"]["stick_frames"] == hold - 1
    step = np.linalg.norm(np.diff(_left_foot_xy(pipe, motion, result), axis=0), axis=1)
    assert step[: hold - 1].max() <= 1e-3 + 5e-4
    # No lag builds up: the foot moves with its target from the first moving frame on.
    assert step[hold - 1] > 0.5 * speed
    assert step[hold - 1 :].max() <= 1.5 * speed


def test_terrain_snap_lowers_a_floating_clip_but_never_lifts() -> None:
    from hhtools.retarget.frax_backend.scene_pipeline import _terrain_snap_offset

    assert _terrain_snap_offset(0.03) == pytest.approx(0.03)
    assert _terrain_snap_offset(5e-5) == 0.0
    # A sole 20 cm "below" a box top beside its wall is 3 cm inside it: still no lift.
    assert _terrain_snap_offset(-0.03) == 0.0
    assert _terrain_snap_offset(float("nan")) == 0.0


def test_root_rotation_weight_is_decided_per_clip_and_ignores_the_sign() -> None:
    from hhtools.retarget.frax_backend.scene_pipeline import _root_rotation_weights

    turned = np.array([0.0, 0.0, np.sin(0.2), np.cos(0.2)])
    # A real rotation track: identity frames are orientations to track too.
    quats = np.array([[0, 0, 0, 1.0], [0, 0, 0, -1.0], turned, -turned])
    np.testing.assert_array_equal(_root_rotation_weights(quats, 5.0), [5.0] * 4)
    # A position-only source: identity everywhere, either sign.
    flat = np.array([[0, 0, 0, 1.0], [0, 0, 0, -1.0], [0, 0, 0, 1.0]])
    np.testing.assert_array_equal(_root_rotation_weights(flat, 5.0), [0.0] * 3)


def test_reported_numbers_describe_the_returned_motion(
    toy, calibration, base_motion, monkeypatch
) -> None:
    # Alignment and the terrain gap are measured after the post-solve joint edits.
    import hhtools.robot.retarget_profile as profile

    def bend(joint_q, dof_names, *args, **kwargs):  # stands in for the shoulder narrowing
        out = np.array(joint_q, copy=True)
        out[:, 7:] += 0.2
        return out

    monkeypatch.setattr(profile, "apply_upper_body_roll_narrowing_post_ik", bend)
    motion = _walk(base_motion, platform=(0.3, 0.9, 0.03))
    pipe = _pipeline(toy, motion, calibration)
    result = pipe.run(motion)
    model = pipe.frax_model
    st = pipe.front.prepare_scene_targets(motion, mj_model=MujocoScene.from_robot(toy).model)
    joints, offsets = pipe._frames_for(MujocoScene.from_robot(toy), st.robot_points)
    q = model.frax_q_from_joint_q(result.joint_q)
    pts = np.stack([_fk_points(model, qq, joints, offsets) for qq in q])
    err = np.linalg.norm(pts - st.positions, axis=-1)
    assert result.meta["alignment_mean_m"] == pytest.approx(err.mean(), abs=1e-5)
    radii = np.asarray(model.robot.flat_collision_radii)[list(model.floor_sphere_idxs)]
    spheres = jax.vmap(
        lambda qq: model.robot._link_collision_positions(model.robot.joint_to_world_transforms(qq))
    )(jnp.asarray(q))[:, np.asarray(model.floor_sphere_idxs)]
    terrain = pipe.front.scaled_terrain(motion, FLOOR, result.meta["smpl_scale"])
    grid = build_terrain_grid(terrain.hf, terrain.min_point, terrain.dx, shape_bucket=1)
    gap = (grid.signed_distance(np.asarray(spheres)) - radii).min()
    assert result.meta["terrain_signed_min_gap"] == pytest.approx(gap, abs=1e-5)


def test_returned_gap_is_measured_at_the_lowered_spheres() -> None:
    from hhtools.retarget.frax_backend.scene_pipeline import _returned_min_gap

    # A 1 cm sphere 20 cm above the floor, its centre 2 cm from a tall wall (below the top): the
    # wall is 1 cm from its surface, outside its vertical sweep.  Lowering by 19 cm lands it on
    # the floor with the wall still clear, a gap of 0 (not 1 cm - 19 cm).
    hf = np.zeros((40, 40))
    hf[20:, :] = 0.5
    grid = build_terrain_grid(hf, (0.0, 0.0), 0.01, floor_z=0.0, shape_bucket=1)
    face = 19.5 * 0.01
    spheres = np.array([[[face - 0.02, 0.2, 0.20]]])
    radii = np.array([0.01])
    assert _returned_min_gap(grid, spheres, radii, 0.0, 4) == pytest.approx(0.01, abs=1e-9)
    assert _returned_min_gap(grid, spheres, radii, 0.19, 4) == pytest.approx(0.0, abs=1e-9)


def test_shoulder_edit_is_limited_where_it_creates_penetration() -> None:
    from hhtools.retarget.frax_backend.scene_pipeline import _limit_edit_by_terrain

    T, fps = 40, 30.0
    pre = np.zeros((T, 9), np.float32)
    post = pre.copy()
    post[:, 7] = 1.0  # the edit
    touched = np.zeros(T)
    touched[15:20] = 1.0  # frames where the edited joint drives a sphere into the terrain

    def gap_fn(jq):
        return 0.02 - 0.05 * jq[:, 7] * touched  # alpha > ~0.4 penetrates in those frames

    out, limited = _limit_edit_by_terrain(pre, post, gap_fn, fps)
    assert limited > 0
    assert (gap_fn(out) >= -1e-4 - 1e-6).all()
    assert out[15:20, 7].max() <= 0.41
    assert out[0, 7] == 1.0 and out[-1, 7] == 1.0  # far from the problem the edit is intact
    assert (out[:, 7] >= 0.0).all() and (out[:, 7] <= 1.0).all()
    # Smoothed in time: no frame is ever raised above the limit of its own, and neighbours ramp.
    assert 0.0 < out[12, 7] < 1.0 or 0.0 < out[22, 7] < 1.0
    # A harmless edit (nothing touches the terrain) passes through untouched.
    same, none = _limit_edit_by_terrain(pre, post, lambda jq: np.full(T, 0.5), fps)
    assert none == 0 and np.array_equal(same, post)
    # A penetration that already existed is not made worse, but is not "fixed" either.
    deep, _ = _limit_edit_by_terrain(pre, post, lambda jq: -0.03 + 0.0 * jq[:, 7], fps)
    assert np.array_equal(deep, post)


def test_terrain_snap_keeps_the_margin(toy, calibration, base_motion) -> None:
    motion = _walk(base_motion)
    margin = 0.01
    pipe = _pipeline(toy, motion, calibration, terrain_margin=margin)
    result = pipe.run(motion)
    gap = _sole_gap(pipe, result, motion)
    assert gap.min() == pytest.approx(margin, abs=2e-3)
    assert "shoulder_edit_limited_frames" in result.meta["frax"]


# --- flat floor, cache ----------------------------------------------------------------------


def test_motion_without_terrain_uses_the_flat_floor(toy, calibration, base_motion) -> None:
    motion = _walk(base_motion, terrain=False)
    result = _pipeline(toy, motion, calibration).run(motion)
    constraints = result.meta["frax"]["constraints"]
    assert "floor" in constraints and "terrain" not in constraints
    assert result.meta["frax"]["terrain_grid_shape"] is None
    assert result.meta["frax"]["terrain_window"] is None
    assert np.isnan(result.meta["terrain_signed_min_gap"])
    assert np.isnan(result.meta["source_terrain_z_offset"])
    assert result.meta["terrain_grounded"] is False
    assert np.isfinite(result.joint_q).all()


def test_second_run_of_the_same_shapes_does_not_recompile(toy, calibration, base_motion) -> None:
    motion = _walk(base_motion, frames=20)
    pipe = _pipeline(toy, motion, calibration)
    pipe.run(motion)
    again = pipe.run(_walk(base_motion, frames=25, step=0.015))  # same padded bucket
    assert again.meta["frax"]["compile_s"] == 0
    assert again.joint_q.shape[0] == 25
    other = _pipeline(toy, motion, calibration, frax=frax_config_for_preset(toy.preset))
    assert other.run(motion).meta["frax"]["compile_s"] == 0


def test_progress_callback_reports_stages_and_swallows_errors(
    toy, calibration, base_motion
) -> None:
    motion = _walk(base_motion, frames=10)
    pipe = _pipeline(toy, motion, calibration)
    seen = []
    pipe.run(motion, progress_callback=lambda *a: seen.append(a))
    assert [s for s, *_ in seen] == ["precompute", "precompute", "mpc", "mpc"]

    def boom(*_a):
        raise RuntimeError("ui")

    assert pipe.run(motion, progress_callback=boom).num_frames == 10


def test_scene_config_overrides_are_validated() -> None:
    assert FraxSceneConfig().with_overrides(substeps=3).substeps == 3
    with pytest.raises(ValueError):
        FraxSceneConfig().with_overrides(nope=1)
    with pytest.raises(ValueError):
        FraxSceneConfig(substeps=0)
    assert FraxSceneConfig().terrain_reach == 0.25
    assert FraxSceneConfig().substeps == 1
