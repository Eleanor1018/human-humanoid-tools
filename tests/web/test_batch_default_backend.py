from __future__ import annotations

import time
from pathlib import Path
from types import SimpleNamespace

from fastapi.testclient import TestClient

from hhtools.robot import registry as robot_registry
from hhtools.web import server
from hhtools.web.server import batch_runtime
from hhtools.web.server import state as server_state
from hhtools.web.server.routes import batch as batch_routes


def _app(tmp_path: Path, monkeypatch):
    def local_tmpdir(tag: str) -> Path:
        path = tmp_path / f"runtime-{tag}"
        path.mkdir(parents=True, exist_ok=True)
        return path

    monkeypatch.setattr(server_state, "_tmpdir", local_tmpdir)
    monkeypatch.setattr(server_state, "_robot_library_root", lambda: tmp_path / "robots")
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "config"))
    return server.create_app(
        source_root=tmp_path / "motions",
        save_dir=tmp_path / "save",
        cache_dir=tmp_path / "cache",
        job_history_dir=tmp_path / "job-history",
    )


def _entry(stem: str) -> dict:
    return {
        "stem": stem,
        "dataset": "d",
        "folder_label": "f",
        "sequence_id": stem,
        "source_path": f"/nowhere/{stem}.npz",
        "reference": "smpl",
    }


def _run_batch(tmp_path: Path, monkeypatch, body: dict):
    """Run a batch whose motions are fakes; return (solved_backends, chunk_stems, job)."""
    from hhtools.retarget import frax_backend
    from hhtools.retarget.newton_basic import batch_limits
    from hhtools.services import motion_library_links as links

    monkeypatch.setattr(frax_backend, "frax_available", lambda: False)
    monkeypatch.setattr(batch_limits, "clamp_gpu_batch_size", lambda _model, n: n)
    monkeypatch.setattr(robot_registry, "get", lambda _name: object())
    monkeypatch.setattr(batch_routes, "_request_human_height", lambda *_a: 1.7)
    monkeypatch.setattr(links, "library_entry_for_load", lambda **kw: SimpleNamespace(stem="x"))

    def fake_load(entry, *_a, **_k):
        scene = entry["stem"].startswith("scene")
        return SimpleNamespace(
            name=entry["stem"], terrain=object() if scene else None, objects=None
        )

    solved: list[tuple[str, str]] = []
    chunk_stems: list[str] = []

    def fake_single(_model, _robot, motion, _ref, backend, *_a, **_k):
        solved.append((motion.name, backend))
        raise RuntimeError("stop")

    def fake_chunk(loaded, *, failure_log, **_k):
        chunk_stems.extend(e["stem"] for e, _m, _en in loaded)
        return [], failure_log

    monkeypatch.setattr(batch_routes, "_load_batch_motion", fake_load)
    monkeypatch.setattr(batch_runtime, "_load_batch_motion", fake_load)
    monkeypatch.setattr(batch_runtime, "_retarget_single", fake_single)
    monkeypatch.setattr(batch_routes, "_retarget_newton_batch_chunk", fake_chunk)

    app = _app(tmp_path, monkeypatch)
    state = app.state.session_state
    state.robots["test_robot"] = object()
    with TestClient(app) as client:
        response = client.post("/api/batch/retarget", json={"robot": "test_robot", **body})
        job_id = response.json()["job_id"]
        deadline = time.monotonic() + 5.0
        while state.jobs[job_id].status in {"pending", "running"}:
            assert time.monotonic() < deadline, "batch job did not finish"
            time.sleep(0.005)
        job = state.jobs[job_id]
    assert job.status == "done", job.error
    return solved, chunk_stems, job


def test_default_batch_runs_scene_entry_on_scene_solver(tmp_path: Path, monkeypatch) -> None:
    solved, chunk_stems, _job = _run_batch(
        tmp_path,
        monkeypatch,
        {"entries": [_entry("plain_a"), _entry("scene_b")]},
    )

    assert solved == [("scene_b", "interaction_mesh")]
    assert chunk_stems == ["plain_a"]


def test_explicit_newton_batch_warns_for_scene_entry(tmp_path: Path, monkeypatch) -> None:
    solved, chunk_stems, job = _run_batch(
        tmp_path,
        monkeypatch,
        {"backend": "newton", "entries": [_entry("plain_a"), _entry("scene_b")]},
    )

    assert solved == []
    assert chunk_stems == ["plain_a", "scene_b"]
    warnings = job.result["warnings"]
    assert [w["stem"] for w in warnings] == ["scene_b"]
    assert "ignores the terrain" in warnings[0]["warning"]
