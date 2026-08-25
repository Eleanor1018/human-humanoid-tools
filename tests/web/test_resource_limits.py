from __future__ import annotations

import time
from pathlib import Path

from fastapi.testclient import TestClient

from hhtools.web import server


def _create_test_app(tmp_path: Path, monkeypatch, **limits):
    """Create an isolated app whose ephemeral roots are observable by tests."""

    def local_tmpdir(tag: str) -> Path:
        path = tmp_path / f"runtime-{tag}"
        path.mkdir(parents=True, exist_ok=True)
        return path

    monkeypatch.setattr(server, "_tmpdir", local_tmpdir)
    monkeypatch.setattr(server, "_robot_library_root", lambda: tmp_path / "robots")
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "config"))
    return server.create_app(
        source_root=tmp_path / "motions",
        save_dir=tmp_path / "save",
        cache_dir=tmp_path / "cache",
        **limits,
    )


def _upload_files(*items: tuple[str, bytes]):
    return [
        ("files", (name, payload, "application/octet-stream"))
        for name, payload in items
    ]


def test_upload_rejects_too_many_files(tmp_path: Path, monkeypatch) -> None:
    app = _create_test_app(
        tmp_path,
        monkeypatch,
        max_upload_files=1,
        max_upload_request_bytes=1024 * 1024,
    )

    with TestClient(app) as client:
        response = client.post(
            "/api/dataset/upload",
            files=_upload_files(("one.bin", b"1"), ("two.bin", b"2")),
        )

        assert response.status_code == 413
        assert not list(app.state.session_state.upload_root.rglob("*.bin"))


def test_oversized_file_does_not_publish_partial_upload(
    tmp_path: Path,
    monkeypatch,
) -> None:
    app = _create_test_app(
        tmp_path,
        monkeypatch,
        max_upload_file_bytes=8,
        max_upload_request_bytes=1024 * 1024,
    )

    with TestClient(app) as client:
        response = client.post(
            "/api/dataset/upload",
            files=_upload_files(("small.bin", b"1234"), ("large.bin", b"123456789")),
        )

        upload_root = app.state.session_state.upload_root
        assert response.status_code == 413
        assert not list(upload_root.rglob("*.bin"))
        assert not list(upload_root.rglob("*.upload"))


def test_valid_upload_is_streamed_and_published(tmp_path: Path, monkeypatch) -> None:
    app = _create_test_app(
        tmp_path,
        monkeypatch,
        max_upload_file_bytes=32,
        max_upload_request_bytes=1024 * 1024,
    )

    with TestClient(app) as client:
        response = client.post(
            "/api/dataset/upload",
            files=_upload_files(("nested/clip.bin", b"valid-data")),
        )

        written = list(app.state.session_state.upload_root.rglob("clip.bin"))
        assert response.status_code == 200
        assert len(written) == 1
        assert written[0].read_bytes() == b"valid-data"


def test_content_length_limit_rejects_before_route_handler(
    tmp_path: Path,
    monkeypatch,
) -> None:
    app = _create_test_app(
        tmp_path,
        monkeypatch,
        max_upload_request_bytes=128,
    )

    with TestClient(app) as client:
        response = client.post(
            "/api/dataset/upload",
            files=_upload_files(("clip.bin", b"small-payload")),
        )

        assert response.status_code == 413
        assert not list(app.state.session_state.upload_root.rglob("clip.bin"))


def test_running_job_limit_returns_429(tmp_path: Path, monkeypatch) -> None:
    app = _create_test_app(tmp_path, monkeypatch, max_running_jobs=1)
    state = app.state.session_state
    busy = server.Job(id="already-busy", kind="test")
    with state.job_lock:
        state.jobs[busy.id] = busy

    with TestClient(app) as client:
        response = client.post("/api/dataset/analyze", json={})

        assert response.status_code == 429
        assert response.json()["detail"] == "too many running jobs (limit: 1)"


def test_job_retention_prunes_oldest_artifact(tmp_path: Path, monkeypatch) -> None:
    app = _create_test_app(
        tmp_path,
        monkeypatch,
        max_retained_jobs=1,
        job_ttl_seconds=3600,
    )
    state = app.state.session_state
    now = time.monotonic()
    artifact = state.export_root / "old.zip"
    artifact.write_bytes(b"generated")
    old = server.Job(
        id="old-job",
        kind="test",
        status="done",
        result={"artifact_path": str(artifact)},
        created_at=now - 20,
        terminal_since=now - 20,
        last_accessed_at=now - 20,
    )
    latest = server.Job(
        id="latest-job",
        kind="test",
        status="done",
        created_at=now - 10,
        terminal_since=now - 10,
        last_accessed_at=now - 10,
    )
    with state.job_lock:
        state.jobs.update({old.id: old, latest.id: latest})

    with TestClient(app) as client:
        response = client.get(f"/api/job/{latest.id}")

        assert response.status_code == 200
        assert old.id not in state.jobs
        assert latest.id in state.jobs
        assert not artifact.exists()


def test_job_ttl_starts_when_worker_reaches_terminal_state(
    tmp_path: Path,
    monkeypatch,
) -> None:
    app = _create_test_app(tmp_path, monkeypatch, job_ttl_seconds=0.01)
    state = app.state.session_state
    expired = server.Job(id="expired-job", kind="test")
    expired.mark_terminal("done")
    expired.terminal_since = time.monotonic() - 1
    expired.last_accessed_at = expired.terminal_since
    with state.job_lock:
        state.jobs[expired.id] = expired

    with TestClient(app) as client:
        response = client.get(f"/api/job/{expired.id}")

        assert response.status_code == 404
        assert expired.id not in state.jobs


def test_lifespan_removes_session_owned_temp_files(tmp_path: Path, monkeypatch) -> None:
    app = _create_test_app(tmp_path, monkeypatch)
    state = app.state.session_state
    upload_file = state.upload_root / "pending.bin"
    export_file = state.export_root / "generated.zip"
    cache_file = state.cache.cache_dir / "generated.npz"
    upload_file.write_bytes(b"upload")
    export_file.write_bytes(b"export")
    cache_file.write_bytes(b"cache")
    state.cache.written.add(cache_file.name)

    with TestClient(app):
        assert upload_file.exists()
        assert export_file.exists()
        assert cache_file.exists()

    assert not state.upload_root.exists()
    assert not state.export_root.exists()
    assert not cache_file.exists()
