"""``hhtools retarget run`` must not silently flatten terrain/object clips."""

from __future__ import annotations

import dataclasses
import sys
from pathlib import Path

import pytest
from click import unstyle
from typer.testing import CliRunner

from hhtools.cli import retarget


def _invoke(tmp_path: Path, *extra: str, clips: tuple[str, ...] = ("clip.npz",)):
    paths = []
    for name in clips:
        clip = tmp_path / name
        clip.write_bytes(b"x")
        paths.append(str(clip))
    output = tmp_path / ("out.csv" if len(paths) == 1 else "out")
    return CliRunner().invoke(
        retarget.app,
        ["run", *paths, "--robot", "toy", "-o", str(output), *extra],
        env={"COLUMNS": "200"},
    )


def _install_toy_robot(tmp_path: Path, monkeypatch, loader, solver_runs: list):
    """A toy robot plus a stub Newton pipeline; the CLI guard itself is not mocked."""
    pytest.importorskip("yourdfpy")
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "retarget"))
    from frax_toy_robot import write_toy_robot

    from hhtools.retarget import frax_backend, newton_basic
    from hhtools.retarget.calibration import RobotRetargetCalibration, save_calibration
    from hhtools.retarget.newton_basic import _warp_config
    from hhtools.robot import loader as robot_loader
    from hhtools.robot import registry

    toy = write_toy_robot(tmp_path / "robots" / "toy")
    save_calibration(
        RobotRetargetCalibration(
            robot=toy.preset.name,
            reference="smpl",
            calibrated_joint_q={name: 0.0 for name in toy.dof_names()},
            notes="cli guard fixture",
        ),
        toy.preset.root_dir / "retarget_calibration_smpl.yaml",
    )
    monkeypatch.setattr(frax_backend, "frax_available", lambda: False)
    monkeypatch.setattr(registry, "get", lambda name: toy.preset)
    monkeypatch.setattr(robot_loader, "load_robot", lambda preset, **kwargs: toy)
    monkeypatch.setattr(_warp_config, "configure", lambda *a, **k: None)
    monkeypatch.setattr(retarget, "_load_input_motion", loader)

    class StubPipeline:
        def __init__(self, *args, **kwargs) -> None:
            pass

        def run(self, _motion):
            solver_runs.append(_motion.name)
            raise RuntimeError("stub solver")

    monkeypatch.setitem(newton_basic.__dict__, "NewtonBasicPipeline", StubPipeline)


def test_scene_clip_without_frax_points_to_interaction_mesh(
    tmp_path, monkeypatch, synthetic_terrain_motion
) -> None:
    solver_runs: list = []
    _install_toy_robot(tmp_path, monkeypatch, lambda path: synthetic_terrain_motion, solver_runs)

    result = _invoke(tmp_path)

    output = unstyle(result.output)
    assert result.exit_code == 2
    assert "hhtools retarget interaction-mesh run" in output
    assert solver_runs == []
    assert not (tmp_path / "out.csv").exists()


def test_guard_runs_when_the_scene_clip_is_solved_without_a_pre_scan(
    tmp_path, monkeypatch, synthetic_terrain_motion
) -> None:
    import dataclasses

    plain = dataclasses.replace(synthetic_terrain_motion, name="plain", terrain=None)
    loads: list[str] = []
    solver_runs: list = []

    def loader(path):
        loads.append(Path(path).name)
        return synthetic_terrain_motion if Path(path).name == "b_scene.npz" else plain

    _install_toy_robot(tmp_path, monkeypatch, loader, solver_runs)

    result = _invoke(tmp_path, clips=("a_plain.npz", "b_scene.npz"))

    assert result.exit_code == 2
    assert "hhtools retarget interaction-mesh run" in unstyle(result.output)
    # The plain clip was loaded and solved once; nothing was loaded twice.
    assert loads == ["a_plain.npz", "b_scene.npz"]
    assert solver_runs == ["plain"]


def test_explicit_newton_on_scene_clip_warns_that_the_scene_is_ignored(
    tmp_path, monkeypatch, synthetic_terrain_motion
) -> None:
    solver_runs: list = []
    motion = dataclasses.replace(synthetic_terrain_motion)
    _install_toy_robot(tmp_path, monkeypatch, lambda path: motion, solver_runs)

    result = _invoke(tmp_path, "--backend", "newton")

    output = unstyle(result.output)
    assert "terrain/objects" in output
    assert "ignores" in output
    assert result.exit_code != 2
