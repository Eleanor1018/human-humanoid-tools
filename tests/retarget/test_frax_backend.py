"""FRAX backend: robot model mapping, solver behaviour and batch orchestration."""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest

pytest.importorskip("frax")
pytest.importorskip("elastiqp")

from frax_toy_robot import write_toy_robot  # noqa: E402

from hhtools.retarget.frax_backend import FraxConfig  # noqa: E402
from hhtools.retarget.frax_backend.collision import collision_spec_for_robot  # noqa: E402
from hhtools.retarget.frax_backend.model import build_frax_robot_model  # noqa: E402
from hhtools.retarget.ik_pipeline import PipelineConfig, PreparedIKTargets  # noqa: E402


@pytest.fixture(scope="module")
def toy(tmp_path_factory):
    return write_toy_robot(tmp_path_factory.mktemp("robots") / "toy")


@pytest.fixture(scope="module")
def pipeline_factory(toy):
    from hhtools.retarget.frax_backend import FraxPipeline

    def make(**overrides) -> FraxPipeline:
        return FraxPipeline(
            toy,
            scaler_config=SimpleNamespace(source_body_quat=(0.0, 0.0, 0.0, 1.0)),
            pipeline_config=PipelineConfig(apply_feet_stabilizer=False),
            frax_config=FraxConfig(frame_bucket=64).with_overrides(**overrides),
        )

    return make


def _link_world(robot, link: str) -> np.ndarray:
    base = np.asarray(robot.urdf.get_transform(robot.base_link))
    return np.linalg.inv(base) @ np.asarray(robot.urdf.get_transform(link))


def test_model_matches_urdf_forward_kinematics(toy) -> None:
    model = build_frax_robot_model(toy)
    rng = np.random.default_rng(3)
    dof = toy.dof_names()
    for _ in range(3):
        values = rng.uniform(-0.6, 0.6, len(dof))
        values[[i for i, n in enumerate(dof) if "knee" in n]] = 0.4
        toy.apply_configuration({n: float(v) for n, v in zip(dof, values, strict=True)})
        joint_q = np.zeros(7 + len(dof))
        joint_q[6] = 1.0
        joint_q[7:] = values
        tfs = np.asarray(
            model.robot.joint_to_world_transforms(model.frax_q_from_joint_q(joint_q)[0])
        )
        # Includes links merged into their parent by fixed joints (head, hands).
        for link in ("torso", "head", "left_hand_link", "right_foot_link", "left_shin_link"):
            joint, offset = model.link_frame(link)
            np.testing.assert_allclose(tfs[joint] @ offset, _link_world(toy, link), atol=1e-9)
    toy.apply_configuration({n: 0.0 for n in dof})


def test_joint_q_round_trip_keeps_dof_order_and_quaternion_convention(toy) -> None:
    model = build_frax_robot_model(toy)
    rng = np.random.default_rng(0)
    joint_q = rng.normal(size=(4, 7 + len(toy.dof_names())))
    joint_q[:, 3:7] /= np.linalg.norm(joint_q[:, 3:7], axis=1, keepdims=True)
    q = model.frax_q_from_joint_q(joint_q)
    np.testing.assert_allclose(q[:, 3], joint_q[:, 6])  # frax stores w first
    back = model.joint_q_from_frax_q(q)
    np.testing.assert_allclose(back, joint_q.astype(np.float32), atol=1e-6)


def _entry_poses(pipeline, joint_q: np.ndarray) -> np.ndarray:
    """IK-target layout (xyz + xyzw per entry) of the robot at ``joint_q`` frames."""
    from scipy.spatial.transform import Rotation

    model = pipeline.frax_model
    entries = pipeline.ik_mapping.entries
    out = np.zeros((len(joint_q), len(entries), 7))
    for f, row in enumerate(joint_q):
        tfs = np.asarray(model.robot.joint_to_world_transforms(model.frax_q_from_joint_q(row)[0]))
        for i, e in enumerate(entries):
            jt, ot = model.link_frame(e.t_body_link)
            jr, orr = model.link_frame(e.r_body_link)
            point = tfs[jt] @ ot @ np.r_[np.asarray(e.t_offset), 1.0]
            out[f, i, :3] = point[:3]
            out[f, i, 3:] = Rotation.from_matrix((tfs[jr] @ orr)[:3, :3]).as_quat()
    return out


def _reachable_targets(pipeline, joint_traj: np.ndarray, root_z: float = 0.92) -> np.ndarray:
    """IK targets produced by a known joint trajectory with the root upright at ``root_z``."""
    joint_q = np.zeros((len(joint_traj), 7 + joint_traj.shape[1]))
    joint_q[:, 2], joint_q[:, 6] = root_z, 1.0
    joint_q[:, 7:] = joint_traj
    return _entry_poses(pipeline, joint_q)


def _prepared(targets: np.ndarray) -> PreparedIKTargets:
    return PreparedIKTargets(
        ik_targets=targets.astype(np.float32),
        solved_target_positions=targets[:, :, :3].astype(np.float32),
        source_root_quat=None,
        hand_ground_drop=None,
        n_init=0,
        n_stab=0,
        position_only=False,
        scaler=None,
    )


def _wave(pipeline, frames: int = 40) -> np.ndarray:
    dof = pipeline.robot.dof_names()
    t = np.linspace(0.0, 1.0, frames)[:, None]
    amp = np.array([0.4 if "shoulder" in n or "elbow" in n else 0.15 for n in dof])
    traj = amp * np.sin(2 * np.pi * t + np.arange(len(dof)))
    knees = [i for i, n in enumerate(dof) if "knee" in n]
    traj[:, knees] = 0.3 + 0.2 * np.sin(2 * np.pi * t)
    return traj


def _solve(pipeline, targets: np.ndarray, fps: float = 30.0) -> np.ndarray:
    motion = SimpleNamespace(framerate=fps, name="clip")
    job = pipeline._clip_job(motion, _prepared(targets), "")
    return pipeline._solve_clip(job)


def test_solver_tracks_reachable_targets_within_limits(pipeline_factory) -> None:
    pipeline = pipeline_factory(floor=False, self_collision=False)
    targets = _reachable_targets(pipeline, _wave(pipeline))
    joint_q = _solve(pipeline, targets)

    solved = _entry_poses(pipeline, joint_q.astype(float))
    err = np.linalg.norm(solved[:, :, :3] - targets[:, :, :3], axis=-1)
    assert float(err[1:].mean()) < 0.005
    assert float(err[1:].max()) < 0.03
    lower = np.array([j.limit_lower for j in pipeline.robot.actuated_joints])
    upper = np.array([j.limit_upper for j in pipeline.robot.actuated_joints])
    assert np.all(joint_q[:, 7:] >= lower - 1e-6) and np.all(joint_q[:, 7:] <= upper + 1e-6)
    stats = pipeline.frax_summary()
    assert stats["solver_frames"] == len(targets) and stats["padded_frames"] == 64
    assert stats["init_converged"] is True


def test_floor_constraint_keeps_soles_above_ground(pipeline_factory) -> None:
    pipeline = pipeline_factory(floor=True)
    model = pipeline.frax_model
    assert model.has_collision and model.floor_sphere_idxs
    targets = _reachable_targets(pipeline, np.tile(_wave(pipeline)[:1], (20, 1)))
    targets[:, :, 2] -= 0.15  # ask for the feet well below the floor
    joint_q = _solve(pipeline, targets)

    q = model.frax_q_from_joint_q(joint_q)
    radii = np.asarray(model.robot.flat_collision_radii)
    idx = np.asarray(model.floor_sphere_idxs)
    bottoms = [
        (np.asarray(model.robot.link_collision_positions(qi))[idx, 2] - radii[idx]).min()
        for qi in q[2:]
    ]
    assert min(bottoms) > -0.005
    assert "floor" in pipeline.frax_summary()["constraints"]


def test_self_collision_constraint_keeps_hands_apart(pipeline_factory) -> None:
    def min_gap(pipeline) -> float:
        targets = _reachable_targets(pipeline, np.tile(_wave(pipeline)[:1], (20, 1)))
        names = [e.canonical_name for e in pipeline.ik_mapping.entries]
        meet = 0.5 * (
            targets[:, names.index("left_wrist"), :3] + targets[:, names.index("right_wrist"), :3]
        )
        for side in ("left", "right"):  # ask both hands for the same point
            targets[:, names.index(f"{side}_wrist"), :3] = meet
        joint_q = _solve(pipeline, targets)
        model = pipeline.frax_model
        q = model.frax_q_from_joint_q(joint_q)
        return min(
            float(np.asarray(model.robot.self_collision_distances(qi)).min()) for qi in q[2:]
        )

    # floor=True keeps the sphere model (and its distance query) in both runs.
    assert min_gap(pipeline_factory(floor=True, self_collision=False)) < -0.02
    assert min_gap(pipeline_factory(floor=True, self_collision=True)) > -0.005


def test_position_only_and_glb_weights_follow_newton_rules(pipeline_factory) -> None:
    pipeline = pipeline_factory(floor=False)
    entries = pipeline.ik_mapping.entries
    prepared = _prepared(np.zeros((3, len(entries), 7)))
    names = [e.canonical_name for e in entries]

    _, w_rot = pipeline._objective_weights(entries, prepared, "glb")
    assert w_rot[0, names.index("chest")] == 0.0
    assert w_rot[0, names.index("hips")] == entries[names.index("hips")].r_weight

    prepared.position_only = True
    _, w_rot = pipeline._objective_weights(entries, prepared, "")
    assert w_rot[0, names.index("hips")] >= 5.0
    assert np.count_nonzero(w_rot[0]) == 1

    prepared.position_only = False
    prepared.hand_ground_drop = np.array([0.0, 0.05, 0.2], dtype=np.float32)
    w_pos, _ = pipeline._objective_weights(entries, prepared, "")
    hips = names.index("hips")
    base = entries[hips].t_weight
    # Newton blends the pelvis weight towards 3.0 over a 10 cm hands-on-ground drop.
    np.testing.assert_allclose(w_pos[:, hips], [base, 0.5 * base + 1.5, 3.0], rtol=1e-6)


def test_run_batch_solves_each_clip_like_run(pipeline_factory, monkeypatch) -> None:
    pipeline = pipeline_factory(floor=False, self_collision=False)
    wave = _wave(pipeline, 30)
    clips = {
        "a": _reachable_targets(pipeline, wave),
        "b": _reachable_targets(pipeline, wave[::-1][:23]),
    }
    motions = [
        SimpleNamespace(name="a", num_frames=30, framerate=30.0),
        SimpleNamespace(name="empty", num_frames=0, framerate=30.0),
        SimpleNamespace(name="b", num_frames=23, framerate=30.0),
    ]
    monkeypatch.setattr(pipeline, "_normalize_input_motion", lambda m: m)
    monkeypatch.setattr(pipeline, "_push_motion_ik_policy", lambda m: None)
    monkeypatch.setattr(pipeline, "_prepare_solver_targets", lambda m: _prepared(clips[m.name]))
    monkeypatch.setattr(pipeline, "_empty_result", lambda m: ("empty", m.name))
    monkeypatch.setattr(pipeline, "_finalize_solved_joint_q", lambda jq, m, p: (m.name, jq))
    progress: list[tuple[int, int]] = []

    results = pipeline.run_batch(motions, progress_callback=lambda d, t: progress.append((d, t)))

    assert [r[0] for r in results] == ["a", "empty", "b"]
    assert results[0][1].shape == (30, 7 + len(pipeline.robot.dof_names()))
    assert results[2][1].shape[0] == 23
    single = _solve(pipeline, clips["b"])
    np.testing.assert_allclose(results[2][1], single, atol=1e-4)
    assert progress[0] == (0, 3) and progress[-1] == (3, 3)


def test_collision_spec_for_toy_robot_has_soles_and_limb_pairs(toy) -> None:
    spec = collision_spec_for_robot(toy)
    assert spec.source == "auto"
    assert set(spec.sole_links) == {"left_foot_link", "right_foot_link"}
    assert len(spec.spheres["left_foot_link"]) == 4
    assert ("left_forearm_link", "pelvis") in spec.self_collision_pairs


def test_override_file_replaces_the_automatic_model(toy, tmp_path: Path) -> None:
    path = Path(toy.preset.root_dir) / "frax_collision.yaml"
    path.write_text(
        "collision_spheres:\n  pelvis:\n    - {center: [0, 0, 0], radius: 0.1}\n",
        encoding="utf-8",
    )
    try:
        spec = collision_spec_for_robot(toy)
    finally:
        path.unlink()
    assert spec.source == "file:frax_collision.yaml"
    assert list(spec.spheres) == ["pelvis"]


def test_robot_to_robot_runs_through_frax(toy) -> None:
    from hhtools.retarget import robot_to_robot as r2r

    dof = toy.dof_names()
    frames = 40
    joint_q = np.zeros((frames, 7 + len(dof)), dtype=np.float32)
    joint_q[:, 2], joint_q[:, 6] = 0.92, 1.0
    t = np.linspace(0.0, 1.0, frames)
    for i, name in enumerate(dof):
        joint_q[:, 7 + i] = (0.3 if "knee" in name else 0.0) + 0.2 * np.sin(2 * np.pi * t + i)
    motion = r2r.source_trajectory_to_motion(toy, joint_q, dof, framerate=30.0, name="toy")

    result = r2r.retarget_robot_to_robot(
        toy, toy, calibrated_joint_q={}, source_motion=motion, backend="frax"
    )

    assert result.joint_q.shape == joint_q.shape
    assert result.meta["execution_provenance"]["backend"] == "frax"
    # Same robot on both sides: the joints come back close to the source.
    assert float(np.abs(result.joint_q[:, 7:] - joint_q[:, 7:]).mean()) < 0.1
