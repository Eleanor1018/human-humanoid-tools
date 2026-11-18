"""``hhtools retarget interaction-mesh run --solver``: validation before any work starts."""

from __future__ import annotations

from typer.testing import CliRunner

from hhtools.cli import retarget


def _run(tmp_path, *extra: str):
    args = ["interaction-mesh", "run", str(tmp_path / "clip.npy"), "--robot", "rp1"]
    return CliRunner().invoke(retarget.app, [*args, "-o", str(tmp_path / "out.csv"), *extra])


def test_unknown_solver_is_rejected(tmp_path) -> None:
    result = _run(tmp_path, "--solver", "newton")
    assert result.exit_code == 2
    assert "--solver must be 'osqp' or 'frax'" in result.output


def test_frax_solver_names_the_missing_extra(tmp_path, monkeypatch) -> None:
    from hhtools.retarget import frax_backend

    monkeypatch.setattr(frax_backend, "missing_frax_dependencies", lambda: ["jax"])
    result = _run(tmp_path, "--solver", "frax")
    assert result.exit_code == 2
    assert "retarget-frax" in result.output
