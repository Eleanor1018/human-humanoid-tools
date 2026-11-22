"""``hhtools retarget run`` must not silently flatten terrain/object clips."""

from __future__ import annotations

import dataclasses
import sys
from pathlib import Path

import pytest
from click import unstyle
from typer.testing import CliRunner

from hhtools.cli import retarget


def _invoke(tmp_path: Path, *extra: str):
    clip = tmp_path / "clip.npz"
    clip.write_bytes(b"x")
    return CliRunner().invoke(
        retarget.app,
        ["run", str(clip), "--robot", "toy", "-o", str(tmp_path / "out.csv"), *extra],
        env={"COLUMNS": "200"},
    )


def test_scene_clip_without_frax_points_to_interaction_mesh(
    tmp_path, monkeypatch, synthetic_terrain_motion
) -> None:
    from hhtools.retarget import frax_backend

    monkeypatch.setattr(frax_backend, "frax_available", lambda: False)
    monkeypatch.setattr(retarget, "_load_input_motion", lambda path: synthetic_terrain_motion)

    result = _invoke(tmp_path)

    output = unstyle(result.output)
    assert result.exit_code == 2
    assert "hhtools retarget interaction-mesh run" in output
    assert not (tmp_path / "out.csv").exists()


def test_explicit_newton_on_scene_clip_warns_that_the_scene_is_ignored(
    tmp_path, monkeypatch, synthetic_terrain_motion
) -> None:
    pytest.importorskip("yourdfpy")
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "retarget"))
    from frax_toy_robot import write_toy_robot

    from hhtools.retarget import newton_basic
    from hhtools.retarget.calibration import RobotRetargetCalibration, save_calibration
    from hhtools.retarget.newton_basic import _warp_config
    from hhtools.robot import loader, registry

    toy = write_toy_robot(tmp_path / "robots" / "toy")
    save_calibration(
        RobotRetargetCalibration(
            robot=toy.preset.name,
            reference="smpl",
            calibrated_joint_q={name: 0.0 for name in toy.dof_names()},
            notes="cli newton warning fixture",
        ),
        toy.preset.root_dir / "retarget_calibration_smpl.yaml",
    )
    monkeypatch.setattr(registry, "get", lambda name: toy.preset)
    monkeypatch.setattr(loader, "load_robot", lambda preset, **kwargs: toy)
    monkeypatch.setattr(_warp_config, "configure", lambda *a, **k: None)
    motion = dataclasses.replace(synthetic_terrain_motion)
    monkeypatch.setattr(retarget, "_load_input_motion", lambda path: motion)

    class StubPipeline:
        def __init__(self, *args, **kwargs) -> None:
            pass

        def run(self, _motion):
            raise RuntimeError("stub solver")

    monkeypatch.setitem(newton_basic.__dict__, "NewtonBasicPipeline", StubPipeline)

    result = _invoke(tmp_path, "--backend", "newton")

    output = unstyle(result.output)
    assert "terrain/objects" in output
    assert "ignores" in output
