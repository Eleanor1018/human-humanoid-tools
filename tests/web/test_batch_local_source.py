from __future__ import annotations

import time
from pathlib import Path

from fastapi.testclient import TestClient

from hhtools.robot import registry as robot_registry
from hhtools.web import server
from hhtools.web.jobs.job_specs import build_job_spec, replay_capability
from hhtools.web.library import upload_resolve
from hhtools.web.server import library_runtime
from hhtools.web.server import state as server_state
from hhtools.web.server.routes import batch as batch_routes


def _create_test_app(tmp_path: Path, monkeypatch):
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


def test_local_batch_entries_keep_original_paths(tmp_path: Path, monkeypatch) -> None:
    source = tmp_path / "motions"
    source.mkdir()
    clip = source / "walk.npz"
    clip.write_bytes(b"motion")
    discovered = upload_resolve.UploadClipRef(
        path=clip,
        profile="mimic",
        clip_kind="",
        dataset="amass",
    )
    monkeypatch.setattr(
        upload_resolve,
        "enumerate_upload_clips",
        lambda root, profile: [discovered],
    )

    root, profile, entries = library_runtime._entries_for_batch_source(source, "AUTO")

    assert root == source.resolve()
    assert profile == "auto"
    assert entries[0]["source_path"] == str(clip.resolve())
    assert entries[0]["upload_drop"] == str(source.resolve())
    assert entries[0]["origin"] == "local"
    assert [path for path in tmp_path.rglob("*") if path.is_file()] == [clip]


def test_local_batch_directory_is_replayable(tmp_path: Path) -> None:
    source = tmp_path / "motions"
    source.mkdir()
    spec = build_job_spec(
        "batch",
        {
            "robot": "test_robot",
            "source": str(source),
            "profile": "auto",
            "entry_count": 10_000,
        },
    )

    assert replay_capability(spec) == {
        "available": True,
        "reason": None,
        "source_count": 10_000,
    }


def test_local_batch_history_keeps_source_not_entries(tmp_path: Path, monkeypatch) -> None:
    source = tmp_path / "motions"
    source.mkdir()
    app = _create_test_app(tmp_path, monkeypatch)
    state = app.state.session_state
    state.robots["test_robot"] = object()
    monkeypatch.setattr(robot_registry, "get", lambda _name: object())
    monkeypatch.setattr(batch_routes, "_request_human_height", lambda *_args: 1.7)
    monkeypatch.setattr(
        batch_routes,
        "_entries_for_batch_source",
        lambda _source, _profile: (source.resolve(), "auto", []),
    )

    with TestClient(app) as client:
        response = client.post(
            "/api/batch/retarget",
            json={
                "source": str(source),
                "profile": "auto",
                "robot": "test_robot",
                "backend": "interaction_mesh",
            },
        )
        assert response.status_code == 200
        job_id = response.json()["job_id"]
        deadline = time.monotonic() + 2.0
        while state.jobs[job_id].status in {"pending", "running"}:
            if time.monotonic() >= deadline:
                raise AssertionError("batch smoke job did not finish")
            time.sleep(0.005)

        request = state.jobs[job_id].request
        assert state.jobs[job_id].status == "done"
        assert request["source"] == str(source.resolve())
        assert request["profile"] == "auto"
        assert request["entry_count"] == 0
        assert "entries" not in request
