from __future__ import annotations

from fastapi.testclient import TestClient

from hhtools.web.server import create_app


def _client(tmp_path):
    app = create_app(
        source_root=tmp_path / "motions",
        save_dir=tmp_path / "save",
        cache_dir=tmp_path / "cache",
        desktop_session_secret="test-secret",
        desktop_allowed_host="127.0.0.1:43123",
        desktop_allowed_origin="http://127.0.0.1:43123",
    )
    return TestClient(app, base_url="http://127.0.0.1:43123")


def test_desktop_guard_requires_session_secret(tmp_path) -> None:
    with _client(tmp_path) as client:
        response = client.get("/api/health")

    assert response.status_code == 401


def test_desktop_guard_accepts_matching_session(tmp_path) -> None:
    with _client(tmp_path) as client:
        response = client.get(
            "/api/health",
            headers={
                "X-HHTools-Session": "test-secret",
                "Origin": "http://127.0.0.1:43123",
            },
        )

    assert response.status_code == 200
    assert response.json()["ok"] is True
    assert "frame-ancestors 'none'" in response.headers["content-security-policy"]
    assert response.headers["x-content-type-options"] == "nosniff"


def test_desktop_guard_rejects_wrong_origin(tmp_path) -> None:
    with _client(tmp_path) as client:
        response = client.get(
            "/api/health",
            headers={
                "X-HHTools-Session": "test-secret",
                "Origin": "https://example.com",
            },
        )

    assert response.status_code == 403
