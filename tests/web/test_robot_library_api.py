from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from hhtools.robot import registry
from hhtools.web import server


@pytest.fixture()
def robot_library_client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    robot_root = tmp_path / "robots"
    robot_root.mkdir()
    monkeypatch.setattr(server, "_robot_library_root", lambda: robot_root)
    app = server.create_app(
        source_root=tmp_path / "motions",
        save_dir=tmp_path / "save",
        cache_dir=tmp_path / "cache",
    )
    return TestClient(app)


def _preset(name: str, display_name: str, dof: int) -> SimpleNamespace:
    return SimpleNamespace(
        name=name,
        display_name=display_name,
        has_urdf=True,
        dof_order=tuple(f"joint_{index}" for index in range(dof)),
        root_dir=Path("robots") / name,
    )


def test_robot_list_marks_curated_models_as_builtin(
    robot_library_client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    g1 = _preset("g1_29dof", "G1 29dof", 29)
    custom = _preset("custom_bot", "Custom Bot", 12)
    monkeypatch.setattr(registry, "refresh", lambda: [g1, custom])
    monkeypatch.setattr(registry, "list_presets", lambda: [g1, custom])
    monkeypatch.setattr(registry, "is_user_installed", lambda *_args: True)

    response = robot_library_client.get("/api/robots")

    assert response.status_code == 200
    robots = {item["name"]: item for item in response.json()["robots"]}
    assert robots["g1_29dof"]["builtin"] is True
    assert robots["g1_29dof"]["deletable"] is False
    assert robots["custom_bot"]["builtin"] is False
    assert robots["custom_bot"]["deletable"] is True


def test_builtin_robot_cannot_be_deleted(
    robot_library_client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    g1 = _preset("g1_29dof", "G1 29dof", 29)
    monkeypatch.setattr(registry, "get", lambda _name: g1)

    response = robot_library_client.delete("/api/robot/g1_29dof")

    assert response.status_code == 403
    assert "built-in preset" in response.json()["detail"]
