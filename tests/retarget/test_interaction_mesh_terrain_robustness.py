"""Non-finite terrain end to end, and sign-invariant pelvis-orientation tests."""

from __future__ import annotations

import dataclasses

import numpy as np
import pytest

from hhtools.core.scene import TerrainHeightfield
from hhtools.retarget.interaction_mesh.pipeline import InteractionMeshPipeline

mujoco = pytest.importorskip("mujoco")

from test_interaction_mesh_terrain_review import _run  # noqa: E402

# ---------------------------------------------------------------------------
# Non-finite terrain
# ---------------------------------------------------------------------------


def _with_terrain(motion, hf, **meta):
    hf = np.asarray(hf, dtype=np.float32)
    terrain = TerrainHeightfield(
        hf=hf,
        hf_maxmin=np.stack([hf, hf], axis=-1),
        min_point=np.array([-1.0, -1.0], dtype=np.float32),
        dx=0.5,
    )
    return dataclasses.replace(motion, terrain=terrain, meta={**motion.meta, **meta})


@pytest.mark.parametrize(
    "meta",
    [{}, {"dataset": "other", "split_terrain_grounding": True}],
    ids=["parc_ms", "split_offset"],
)
def test_pipeline_runs_to_finite_output_on_terrain_with_nan_and_inf(
    grounding_robot_pair, synthetic_terrain_motion, meta
) -> None:
    robot = grounding_robot_pair[1]
    hf = np.zeros((4, 4))
    hf[1, 1] = np.nan
    hf[2, 3] = -np.inf
    motion = _with_terrain(synthetic_terrain_motion, hf, **meta)
    result = _run(robot, motion, enable_collision=True)
    assert np.isfinite(result.joint_q).all()
    for key in ("terrain_floor_offset", "source_terrain_z_offset"):
        assert np.isfinite(float(result.meta[key])), key
    # The caller's terrain is not modified.
    assert np.isnan(motion.terrain.hf[1, 1]) and motion.terrain.hf[2, 3] == -np.inf


@pytest.mark.parametrize("bad", [np.nan, np.inf, -np.inf])
def test_pipeline_rejects_terrain_without_a_finite_cell(
    grounding_robot_pair, synthetic_terrain_motion, bad
) -> None:
    robot = grounding_robot_pair[1]
    motion = _with_terrain(synthetic_terrain_motion, np.full((4, 4), bad))
    with pytest.raises(ValueError, match="no finite cell"):
        _run(robot, motion, enable_collision=True)


def test_sanitised_terrain_is_solid_at_the_tallest_finite_height() -> None:
    from hhtools.retarget.interaction_mesh.collision import sanitize_terrain

    hf = np.array([[0.0, 0.2], [np.nan, -np.inf]])
    terrain = TerrainHeightfield(
        hf=hf.astype(np.float32),
        hf_maxmin=np.stack([hf, hf], axis=-1).astype(np.float32),
        min_point=np.zeros(2),
        dx=0.1,
    )
    fixed = sanitize_terrain(terrain)
    np.testing.assert_allclose(fixed.hf, [[0.0, 0.2], [0.2, 0.2]])
    assert np.isfinite(fixed.hf_maxmin).all()
    assert sanitize_terrain(fixed) is fixed  # nothing left to fix


# ---------------------------------------------------------------------------
# Pelvis orientation: q and -q are one rotation
# ---------------------------------------------------------------------------


def _motion_with_pelvis_quat(motion, quat):
    quats = np.zeros_like(motion.quaternions)
    quats[...] = quat
    return dataclasses.replace(motion, quaternions=quats)


@pytest.mark.parametrize(
    ("quat", "informative"),
    [
        ((0.0, 0.0, 0.0, 1.0), False),
        ((0.0, 0.0, 0.0, -1.0), False),
        ((0.0, 0.0, 0.002, -0.999998), False),
        ((0.0, 0.0, 0.7071068, 0.7071068), True),
        ((0.0, 0.0, -0.7071068, -0.7071068), True),
    ],
)
def test_pelvis_identity_check_ignores_the_quaternion_sign(
    synthetic_terrain_motion, quat, informative
) -> None:
    motion = _motion_with_pelvis_quat(synthetic_terrain_motion, quat)
    assert InteractionMeshPipeline._pelvis_orientations_are_informative(motion, 0, 1) is informative


@pytest.mark.parametrize("sign", [1.0, -1.0])
def test_identity_pelvis_never_locks_the_free_joint_whatever_its_sign(
    grounding_robot_pair, synthetic_terrain_motion, monkeypatch, sign
) -> None:
    from hhtools.retarget.interaction_mesh import mpc_loop

    calls = []
    real = mpc_loop._set_freejoint_quat_from_source

    def spy(qpos, model, source_quat, **kwargs):
        if source_quat is not None:
            calls.append(source_quat)
        return real(qpos, model, source_quat, **kwargs)

    monkeypatch.setattr(mpc_loop, "_set_freejoint_quat_from_source", spy)
    motion = _motion_with_pelvis_quat(synthetic_terrain_motion, (0.0, 0.0, 0.0, sign))
    result = _run(grounding_robot_pair[1], motion, enable_collision=False)
    assert np.isfinite(result.joint_q).all()
    assert not calls, "an identity source orientation locked the FREE joint"


def test_per_frame_identity_check_ignores_the_quaternion_sign() -> None:
    from hhtools.retarget.interaction_mesh.mpc_loop import quat_deviation_from_identity

    dev = quat_deviation_from_identity(
        np.array([[0, 0, 0, 1], [0, 0, 0, -1], [0, 0, 0.5, 0.866], [0, 0, -0.5, -0.866]], float)
    )
    assert dev[0] == dev[1] == 0.0
    assert dev[2] == dev[3] > 0.1
