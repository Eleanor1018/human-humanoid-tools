"""``hhtools retarget interaction-mesh run --solver``: validation before any work starts."""

from __future__ import annotations

from click import unstyle
from typer.testing import CliRunner

from hhtools.cli import retarget


def _run(tmp_path, *extra: str) -> tuple[int, str]:
    args = ["interaction-mesh", "run", str(tmp_path / "clip.npy"), "--robot", "rp1"]
    # A wide terminal keeps Rich from wrapping the message inside the error panel.
    result = CliRunner().invoke(
        retarget.app, [*args, "-o", str(tmp_path / "out.csv"), *extra], env={"COLUMNS": "200"}
    )
    return result.exit_code, unstyle(result.output)


def test_unknown_solver_is_rejected(tmp_path) -> None:
    exit_code, output = _run(tmp_path, "--solver", "newton")
    assert exit_code == 2
    assert "--solver must be 'auto', 'osqp' or 'frax'" in output


def test_frax_solver_names_the_missing_extra(tmp_path, monkeypatch) -> None:
    from hhtools.retarget import frax_backend

    monkeypatch.setattr(frax_backend, "missing_frax_dependencies", lambda: ["jax"])
    exit_code, output = _run(tmp_path, "--solver", "frax")
    assert exit_code == 2
    assert "retarget-frax" in output


def test_auto_solver_runs_the_frax_scene_solver_and_labels_the_csv(
    tmp_path, monkeypatch, synthetic_terrain_motion
) -> None:
    """``--solver auto`` (the default) solves on FRAX when installed, and the CSV says so."""
    import dataclasses
    import sys
    from pathlib import Path

    import pytest

    pytest.importorskip("frax")
    pytest.importorskip("elastiqp")
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "retarget"))
    from frax_toy_robot import write_toy_robot

    from hhtools.retarget.calibration import RobotRetargetCalibration, save_calibration
    from hhtools.robot import loader, registry

    toy = write_toy_robot(tmp_path / "robots" / "toy")
    save_calibration(
        RobotRetargetCalibration(
            robot=toy.preset.name,
            reference="smpl",
            calibrated_joint_q={name: 0.0 for name in toy.dof_names()},
            notes="cli auto solver fixture",
        ),
        toy.preset.root_dir / "retarget_calibration_smpl.yaml",
    )
    monkeypatch.setattr(registry, "get", lambda name: toy.preset)
    monkeypatch.setattr(loader, "load_robot", lambda preset, **kwargs: toy)
    motion = dataclasses.replace(
        synthetic_terrain_motion,
        positions=synthetic_terrain_motion.positions[:1].repeat(6, axis=0),
        quaternions=synthetic_terrain_motion.quaternions[:1].repeat(6, axis=0),
    )
    clip = tmp_path / "clip.npy"
    clip.write_bytes(b"x")
    monkeypatch.setattr(retarget, "_load_motion_any", lambda path: motion)

    def run(*extra: str) -> str:
        out = tmp_path / f"out{len(extra)}.csv"
        result = CliRunner().invoke(
            retarget.app,
            ["interaction-mesh", "run", str(clip), "--robot", "toy", "-o", str(out), *extra],
        )
        assert result.exit_code == 0, result.output
        return out.read_text()

    from hhtools.retarget import frax_backend

    monkeypatch.setattr(frax_backend, "missing_frax_dependencies", lambda: [])
    default_csv = run()
    assert "retarget_backend,frax" in default_csv or "retarget_backend: frax" in default_csv
    assert "scene_solver" in default_csv

    explicit_csv = run("--solver", "frax")
    assert "scene_solver" in explicit_csv
