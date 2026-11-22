"""Scene clips (terrain / objects) default to the FRAX scene solver in the application layer."""

from __future__ import annotations

import dataclasses
from types import SimpleNamespace

import numpy as np
import pytest

pytest.importorskip("frax")
pytest.importorskip("elastiqp")

# isort: off
from frax_toy_robot import write_toy_robot  # noqa: E402

from hhtools.application.retarget import _retarget_single  # noqa: E402
from hhtools.core.scene import SceneObject, TerrainHeightfield  # noqa: E402
from hhtools.retarget import frax_backend  # noqa: E402
from hhtools.retarget.calibration import (  # noqa: E402
    RobotRetargetCalibration,
    load_calibration,
    save_calibration,
)
from hhtools.robot.retarget_profile import build_scaler_config_for_robot  # noqa: E402

# isort: on

FLOOR = 0.2
DX = 0.05


@pytest.fixture(scope="module")
def toy(tmp_path_factory):
    model = write_toy_robot(tmp_path_factory.mktemp("robots_default") / "toy")
    save_calibration(
        RobotRetargetCalibration(
            robot=model.preset.name,
            reference="smpl",
            calibrated_joint_q={name: 0.0 for name in model.dof_names()},
            notes="default scene solver fixture",
        ),
        model.preset.root_dir / "retarget_calibration_smpl.yaml",
    )
    return model


def _walk(motion, *, frames=12, terrain=True, objects=()):
    pos = np.repeat(motion.positions[:1], frames, axis=0).copy()
    pos[:, :, 0] += 0.01 * np.arange(frames)[:, None]
    quat = np.repeat(motion.quaternions[:1], frames, axis=0)
    hf = np.full((80, 40), FLOOR, np.float32)
    ground = TerrainHeightfield(
        hf=hf,
        hf_maxmin=np.stack([hf, hf], axis=-1),
        min_point=np.array([-1.0, -1.0], np.float32),
        dx=DX,
    )
    return dataclasses.replace(
        motion,
        positions=pos,
        quaternions=quat,
        terrain=ground if terrain else None,
        objects=list(objects),
    )


def _box_on_wrist(motion):
    wrist = list(motion.hierarchy.bone_names).index("left_wrist")
    centre = motion.positions[:, wrist].copy()
    centre[:, 1] -= 0.02
    return SceneObject(
        name="box",
        positions=centre,
        quaternions=np.tile([0.0, 0.0, 0.0, 1.0], (len(centre), 1)),
        extents=np.full(3, 0.16),
        mesh_path="",
    )


def _run(toy, motion, backend, job=None):
    return _retarget_single(
        toy, toy.preset.name, motion, "smpl", backend, 24, 1.7, None, job, preset=toy.preset
    )


def test_frax_runs_a_terrain_clip_on_the_scene_solver(toy, synthetic_terrain_motion) -> None:
    result = _run(toy, _walk(synthetic_terrain_motion), "frax")
    assert result.meta["scene_solver"] == "frax"
    assert result.meta["terrain_grounded"] is True
    assert np.isfinite(result.joint_q).all()


def test_frax_runs_an_object_clip_on_the_scene_solver(toy, synthetic_terrain_motion) -> None:
    flat = _walk(synthetic_terrain_motion, terrain=False)
    motion = dataclasses.replace(flat, objects=[_box_on_wrist(flat)])
    result = _run(toy, motion, "frax")
    assert result.meta["scene_solver"] == "frax"
    assert result.meta["objects_grounded"] is True


def test_frax_keeps_plain_clips_on_the_flat_pipeline(toy, synthetic_terrain_motion) -> None:
    result = _run(toy, _walk(synthetic_terrain_motion, terrain=False), "frax")
    assert "scene_solver" not in result.meta
    assert "terrain_grounded" not in result.meta


def test_scaler_only_robot_runs_the_scene_solver(
    toy, synthetic_terrain_motion, monkeypatch, tmp_path
) -> None:
    """No calibration file, only a bundled scaler: the scaler builds the pipeline."""
    from hhtools.retarget import calibration as calibration_module
    from hhtools.robot import retarget_profile

    motion = _walk(synthetic_terrain_motion)
    scaler_cfg = build_scaler_config_for_robot(
        load_calibration(toy.preset.root_dir / "retarget_calibration_smpl.yaml"),
        toy,
        motion,
        human_height=1.7,
    )
    monkeypatch.setattr(calibration_module, "resolve_preset_calibration_file", lambda *a: None)
    monkeypatch.setattr(retarget_profile, "bundled_scaler_path", lambda *a: tmp_path / "x.yaml")
    monkeypatch.setattr(
        retarget_profile, "resolve_retarget_scaler_config", lambda *a, **k: scaler_cfg
    )
    result = _run(toy, motion, "frax")
    assert result.meta["scene_solver"] == "frax"
    assert result.meta["terrain_grounded"] is True


class _Job:
    """Minimal web job: records progress and can cancel from the progress setter."""

    def __init__(self, cancel_at: float | None = None) -> None:
        self.kind = "retarget"
        self.cancel_at = cancel_at
        self.values: list[float] = []
        self.message = ""

    @property
    def progress(self) -> float:
        return self.values[-1] if self.values else 0.0

    @progress.setter
    def progress(self, value: float) -> None:
        if self.cancel_at is not None and value >= self.cancel_at:
            raise RuntimeError("cancelled")
        self.values.append(value)


def test_scene_solver_progress_is_staged_and_cancellable(toy, synthetic_terrain_motion) -> None:
    motion = _walk(synthetic_terrain_motion)
    job = _Job()
    _run(toy, motion, "frax", job=job)
    assert job.values == sorted(job.values)
    assert job.values[0] < 0.1 and job.values[-1] >= 0.9
    # Raising from the progress hook (as the Agent's job bridge does) aborts the solve.
    with pytest.raises(RuntimeError, match="cancelled"):
        _run(toy, motion, "frax", job=_Job(cancel_at=0.35))


def test_default_scene_backend_follows_frax_availability(monkeypatch) -> None:
    monkeypatch.setattr(frax_backend, "missing_frax_dependencies", lambda: [])
    assert frax_backend.default_scene_backend() == "frax"
    assert frax_backend.default_backend_for_motion(True) == "frax"
    monkeypatch.setattr(frax_backend, "missing_frax_dependencies", lambda: ["frax"])
    assert frax_backend.default_scene_backend() == "interaction_mesh"
    assert frax_backend.default_backend_for_motion(True) == "interaction_mesh"
    assert frax_backend.default_backend_for_motion(False) == "newton"


def test_r2r_frax_backend_runs_the_scene_solver_for_scene_clips(
    monkeypatch, synthetic_terrain_motion
) -> None:
    from hhtools.retarget import robot_to_robot as r2r
    from hhtools.retarget.newton_basic import scaler as scaler_module

    seen: dict[str, object] = {}
    marker = object()

    class FakeScenePipeline:
        def __init__(self, robot, scaler, **kwargs) -> None:
            seen["scaler"] = scaler

        def run(self, motion, *, progress_callback=None):
            seen["motion"] = motion
            for args in (("precompute", 0, 10), ("build", 10, 10), ("mpc", 0, 10), ("mpc", 10, 10)):
                progress_callback(*args)
            return marker

    ticks: list[tuple[int, int]] = []
    monkeypatch.setattr(frax_backend, "FraxScenePipeline", FakeScenePipeline)
    monkeypatch.setattr(
        r2r,
        "_build_scaler_config",
        lambda *a: ("cfg", SimpleNamespace(height_m=1.7, joint_names=[])),
    )
    monkeypatch.setattr(scaler_module, "HumanToRobotScaler", lambda *a, **k: "scaler")
    monkeypatch.setattr(r2r, "align_retargeted_ankles_to_scaled_source", lambda *a, **k: a[3])

    out = r2r.retarget_robot_to_robot(
        SimpleNamespace(preset=SimpleNamespace(name="src")),
        SimpleNamespace(preset=SimpleNamespace(name="tgt")),
        calibrated_joint_q={},
        source_motion=synthetic_terrain_motion,
        backend="frax",
        progress_callback=lambda done, total: ticks.append((done, total)),
    )
    assert out is marker
    assert seen["scaler"] == "scaler" and seen["motion"] is synthetic_terrain_motion
    assert [d for d, _ in ticks] == sorted(d for d, _ in ticks)
    assert all(0 <= d < t for d, t in ticks)
    assert r2r.suggested_r2r_backend("mimic", has_scene=True) in ("frax", "interaction_mesh")
