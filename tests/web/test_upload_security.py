from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from hhtools.web import server
from hhtools.web.motion_library_links import _safe_folder_name


@pytest.fixture()
def web_client(tmp_path: Path, monkeypatch) -> TestClient:
    def local_tmpdir(tag: str) -> Path:
        path = tmp_path / f"runtime-{tag}"
        path.mkdir(parents=True, exist_ok=True)
        return path

    monkeypatch.setattr(server, "_tmpdir", local_tmpdir)
    monkeypatch.setattr(server, "_robot_library_root", lambda: tmp_path / "robots")
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "config"))
    app = server.create_app(
        source_root=tmp_path / "motions",
        save_dir=tmp_path / "save",
        cache_dir=tmp_path / "cache",
    )
    return TestClient(app)


@pytest.mark.parametrize(
    "filename",
    [
        "../escaped.bin",
        "..\\escaped.bin",
        "/escaped.bin",
        "C:\\escaped.bin",
    ],
)
def test_upload_relative_path_rejects_escape_forms(filename: str) -> None:
    with pytest.raises(ValueError):
        server._safe_upload_relative_path(filename)


@pytest.mark.parametrize(
    ("url", "data"),
    [
        ("/api/dataset/upload", {}),
        ("/api/basket/upload", {}),
        ("/api/motion/upload", {}),
        ("/api/robot/upload", {"name": "safe-robot"}),
        ("/api/r2r/source/upload", {"source_robot": "unit-test"}),
        ("/api/r2r/basket/upload", {}),
    ],
)
def test_all_upload_routes_reject_parent_directory_escape(
    web_client: TestClient,
    tmp_path: Path,
    url: str,
    data: dict[str, str],
) -> None:
    response = web_client.post(
        url,
        data=data,
        files={"files": ("../escaped.bin", b"outside", "application/octet-stream")},
    )

    assert response.status_code == 400
    assert not list(tmp_path.rglob("escaped.bin"))


def test_robot_upload_rejects_escaping_robot_name(
    web_client: TestClient,
    tmp_path: Path,
) -> None:
    response = web_client.post(
        "/api/robot/upload",
        data={"name": "../escaped-robot"},
        files={"files": ("robot.urdf", b"<robot/>", "application/xml")},
    )

    assert response.status_code == 400
    assert not (tmp_path / "escaped-robot").exists()


def test_invalid_motion_upload_returns_400(web_client: TestClient) -> None:
    response = web_client.post(
        "/api/motion/upload",
        params={"library_folder_label": "invalid-motion-test"},
        files={
            "files": (
                "readme.definitely-not-motion",
                b"not a motion clip",
                "application/octet-stream",
            )
        },
    )

    assert response.status_code == 400
    assert "未找到可识别的动作文件" in response.json()["detail"]


def test_motion_library_label_is_one_directory_name() -> None:
    label = _safe_folder_name("nested/../../escaped-library")

    assert "/" not in label
    assert "\\" not in label
    assert Path(label).name == label
