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
    assert "--solver must be 'osqp' or 'frax'" in output


def test_frax_solver_names_the_missing_extra(tmp_path, monkeypatch) -> None:
    from hhtools.retarget import frax_backend

    monkeypatch.setattr(frax_backend, "missing_frax_dependencies", lambda: ["jax"])
    exit_code, output = _run(tmp_path, "--solver", "frax")
    assert exit_code == 2
    assert "retarget-frax" in output
