from __future__ import annotations

import numpy as np
import pytest

from hhtools.retarget.calibration import RobotRetargetCalibration, save_calibration
from hhtools.retarget.interaction_mesh.mujoco_scene import MujocoScene
from hhtools.retarget.interaction_mesh.pipeline import InteractionMeshPipeline, SceneTargets


def _pipeline(model, motion) -> InteractionMeshPipeline:
    calibration_path = model.preset.root_dir / "retarget_calibration_smpl.yaml"
    save_calibration(
        RobotRetargetCalibration(
            robot=model.preset.name,
            reference="smpl",
            calibrated_joint_q={name: 0.0 for name in model.dof_names()},
            notes="self-contained scene-targets fixture",
        ),
        calibration_path,
    )
    return InteractionMeshPipeline.from_calibration(
        model,
        motion,
        str(calibration_path),
        human_height=1.7,
    )


def _multi_frame(motion, frames: int = 3, *, yaw: bool = False):
    motion.positions = np.repeat(motion.positions[:1], frames, axis=0)
    quats = np.repeat(motion.quaternions[:1], frames, axis=0).copy()
    if yaw:
        for f in range(frames):
            half = 0.2 * f / 2.0
            quats[f, 0] = (0.0, 0.0, np.sin(half), np.cos(half))
    motion.quaternions = quats
    return motion


def _assert_agree(pipe, motion, model) -> SceneTargets:
    mj_model = MujocoScene.from_robot(model).model
    scene = pipe.prepare_scene_targets(motion, mj_model=mj_model)
    targets, links, z_min, smpl_scale, points = pipe.precompute_laplacian_targets(
        motion,
        mj_model=mj_model,
    )
    assert scene.positions.dtype == np.float32
    assert scene.positions.shape[0] == len(targets)
    for f, t in enumerate(targets):
        np.testing.assert_array_equal(
            scene.positions[f],
            t.source_vertices[: t.n_human_vertices],
        )
    assert scene.robot_links == links
    assert scene.z_min == z_min
    assert scene.smpl_scale == smpl_scale
    assert len(scene.robot_points) == len(points)
    for a, b in zip(scene.robot_points, points, strict=True):
        assert a.body_name == b.body_name
        np.testing.assert_array_equal(a.local_offset, b.local_offset)
        assert a.semantic == b.semantic
        assert a.source_index == b.source_index
        assert getattr(a, "weight", 1.0) == getattr(b, "weight", 1.0)
    quats = scene.source_root_quat_xyzw
    for f, t in enumerate(targets):
        if quats is None:
            assert t.source_root_quat_xyzw is None
        else:
            assert quats.shape == (len(targets), 4)
            assert t.source_root_quat_xyzw == pytest.approx(tuple(quats[f]), abs=0.0)
    return scene


def test_prepare_scene_targets_matches_precompute_identity_quats(
    grounding_robot_pair,
    synthetic_terrain_motion,
) -> None:
    model = grounding_robot_pair[1]
    motion = _multi_frame(synthetic_terrain_motion)
    scene = _assert_agree(_pipeline(model, motion), motion, model)
    # Position-only (identity) pelvis orientation must not be locked.
    assert scene.source_root_quat_xyzw is None


def test_prepare_scene_targets_matches_precompute_with_source_quats(
    grounding_robot_pair,
    synthetic_terrain_motion,
) -> None:
    model = grounding_robot_pair[1]
    motion = _multi_frame(synthetic_terrain_motion, yaw=True)
    scene = _assert_agree(_pipeline(model, motion), motion, model)
    assert scene.source_root_quat_xyzw is not None
    assert scene.source_root_quat_xyzw.dtype == np.float64


def test_scaled_terrain_none_without_terrain(
    grounding_robot_pair,
    synthetic_terrain_motion,
) -> None:
    model = grounding_robot_pair[1]
    pipe = _pipeline(model, synthetic_terrain_motion)
    synthetic_terrain_motion.terrain = None
    assert pipe.scaled_terrain(synthetic_terrain_motion, 0.0, 1.0) is None


def test_scaled_terrain_scales_grid(grounding_robot_pair, synthetic_terrain_motion) -> None:
    model = grounding_robot_pair[1]
    motion = synthetic_terrain_motion
    pipe = _pipeline(model, motion)
    source = motion.terrain
    scaled = pipe.scaled_terrain(motion, 0.0, 1.2)
    assert scaled is not None
    assert scaled.dx == pytest.approx(source.dx * 1.2)
    np.testing.assert_allclose(scaled.min_point, np.asarray(source.min_point) * 1.2, rtol=1e-6)
