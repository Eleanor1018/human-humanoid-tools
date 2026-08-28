from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from hhtools.integrations import gvhmr
from hhtools.web import server


def _create_test_app(tmp_path: Path, monkeypatch):
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
    )


def _status(*, ready: bool) -> dict:
    missing = [] if ready else ["licensed SMPL-X neutral model"]
    return {
        "ready": ready,
        "checks": {"smplx_neutral": ready},
        "missing": missing,
        "root": "C:/GVHMR",
        "body_models_root": "C:/GVHMR/inputs/checkpoints/body_models",
        "image": "hhtools-gvhmr:cu128",
        "uses_official_weights": True,
        "training_enabled": False,
    }


def test_video_to_motion_status_is_exposed(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(gvhmr, "gvhmr_status", lambda: _status(ready=False))
    app = _create_test_app(tmp_path, monkeypatch)

    with TestClient(app) as client:
        response = client.get("/api/video-to-motion/status")

    assert response.status_code == 200
    assert response.json()["ready"] is False
    assert response.json()["training_enabled"] is False


def test_video_upload_fails_before_storage_when_runtime_is_missing(
    tmp_path: Path,
    monkeypatch,
) -> None:
    monkeypatch.setattr(gvhmr, "gvhmr_status", lambda: _status(ready=False))
    app = _create_test_app(tmp_path, monkeypatch)

    with TestClient(app) as client:
        response = client.post(
            "/api/video-to-motion/upload",
            files=[("files", ("clip.mp4", b"video", "video/mp4"))],
        )

    assert response.status_code == 503
    assert "SMPL-X" in response.json()["detail"]
    assert not list(app.state.session_state.upload_root.rglob("clip.mp4"))


def test_video_upload_rejects_non_video_extension(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(gvhmr, "gvhmr_status", lambda: _status(ready=True))
    app = _create_test_app(tmp_path, monkeypatch)

    with TestClient(app) as client:
        response = client.post(
            "/api/video-to-motion/upload",
            files=[("files", ("clip.txt", b"not-video", "text/plain"))],
        )

    assert response.status_code == 400
    assert not list(app.state.session_state.upload_root.rglob("clip.txt"))
