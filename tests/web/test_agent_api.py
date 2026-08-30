from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

from hhtools.contracts import CapabilityResponse, SchedulerCapability
from hhtools.robot.registry import clear_cache
from hhtools.web import server
from hhtools.web.agent_api import router


class _FakeCapabilities:
    def get_capabilities(self) -> CapabilityResponse:
        return CapabilityResponse(
            service_version="test",
            scheduler=SchedulerCapability(
                max_running_jobs=0,
                max_queued_jobs=0,
                mode="unlimited",
            ),
            supported_input_formats=["bvh"],
            supported_output_formats=["csv", "pkl"],
            features={"agent_rest": True},
        )


def test_agent_router_serializes_the_service_contract() -> None:
    app = FastAPI()
    app.state.agent_capabilities_service = _FakeCapabilities()
    app.include_router(router)

    response = TestClient(app).get("/api/agent/v1/capabilities")

    assert response.status_code == 200
    assert response.json() == {
        "schema_version": "1.0",
        "service_name": "hhtools",
        "service_version": "test",
        "agent_api_version": "v1",
        "backends": [],
        "devices": [],
        "robots": [],
        "scheduler": {
            "max_running_jobs": 0,
            "max_queued_jobs": 0,
            "running": 0,
            "queued": 0,
            "reserved": 0,
            "mode": "unlimited",
            "closed": False,
        },
        "supported_input_formats": ["bvh"],
        "supported_output_formats": ["csv", "pkl"],
        "features": {"agent_rest": True},
    }


def test_full_web_app_registers_agent_api_before_the_static_root(
    tmp_path: Path,
    monkeypatch,
) -> None:
    def local_tmpdir(tag: str) -> Path:
        path = tmp_path / f"runtime-{tag}"
        path.mkdir(parents=True, exist_ok=True)
        return path

    monkeypatch.setattr(server, "_tmpdir", local_tmpdir)
    monkeypatch.setattr(server, "_robot_library_root", lambda: tmp_path / "robots")
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "config"))
    monkeypatch.setenv(
        "HHTOOLS_MOTION_LIBRARY_SETTINGS_PATH",
        str(tmp_path / "motion-library-settings.json"),
    )
    clear_cache()
    app = server.create_app(
        source_root=tmp_path / "motions",
        save_dir=tmp_path / "save",
        cache_dir=tmp_path / "cache",
        job_history_dir=tmp_path / "history",
        job_settings_path=tmp_path / "job-settings.json",
    )

    with TestClient(app) as client:
        response = client.get("/api/agent/v1/capabilities")

    assert response.status_code == 200
    payload = response.json()
    assert payload["schema_version"] == "1.0"
    assert payload["scheduler"]["mode"] == "unlimited"
    assert payload["scheduler"]["max_running_jobs"] == 0
    assert payload["features"]["agent_rest"] is True
    assert "source_root" not in payload
    assert "save_dir" not in payload
    clear_cache()
