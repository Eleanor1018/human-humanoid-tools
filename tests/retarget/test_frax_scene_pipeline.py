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
