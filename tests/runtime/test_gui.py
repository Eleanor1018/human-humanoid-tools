"""GUI and machine clients operate on one workspace and one durable job store."""

import time

import numpy as np
from fastapi.testclient import TestClient

from hhtools.application.runtime import ApplicationPaths
from hhtools.contracts.runtime import RuntimeTokenRequest
from hhtools.io.npz import save_npz
from hhtools.runtime.server import create_runtime_app

PREFIX = "/api/runtime/v1"


def test_gui_analysis_uses_shared_jobs_and_survives_restart(tmp_path, synthetic_terrain_motion):
    paths = ApplicationPaths.isolated(tmp_path)
    app = create_runtime_app(paths)
    motion = synthetic_terrain_motion
    motion.terrain = None
    motion.meta = {}
    motion.positions = np.repeat(motion.positions, 30, axis=0)
    motion.quaternions = np.repeat(motion.quaternions, 30, axis=0)
    save_npz(motion, paths.source_root / "walk.npz")
    with TestClient(app, base_url="http://127.0.0.1", client=("127.0.0.1", 1234)) as client:
        assert client.get("/api/health").json()["motions_library_root"] == str(
            paths.motion_library_root
        )
        started = client.post("/api/dataset/analyze", json={"source": str(paths.source_root)})
        assert started.status_code == 200, started.text
        job_id = started.json()["job_id"]
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            response = client.get(f"/api/job/{job_id}")
            assert response.status_code == 200, response.text
            job = response.json()
            if job["status"] not in {"pending", "running"}:
                break
            time.sleep(0.1)
        assert job["status"] == "done", job
        assert len(job["result"]["clips"]) == 1
        assert client.get(PREFIX + f"/jobs/{job_id}").json()["state"] == "completed"
        assert client.get("/api/jobs").json()["jobs"][0]["id"] == job_id
        assert not app.state.application_runtime.state.job_history.list_records()
        assert job["result"]["runtime_report"]["job_id"] == job_id
        opened = client.post(f"/api/job/{job_id}/open")
        assert opened.status_code == 200, opened.text
        exported = client.post(
            "/api/dataset/export_manifest",
            json={
                "runtime_report": job["result"]["runtime_report"],
                "ids": [job["result"]["clips"][0]["clip_id"]],
                "format": "csv",
            },
        )
        assert exported.status_code == 200, exported.text
        assert "relative_path" in exported.text
    app = create_runtime_app(paths)
    with TestClient(app, base_url="http://127.0.0.1", client=("127.0.0.1", 1234)) as client:
        restored = client.get(f"/api/job/{job_id}").json()
        assert restored["result"]["clips"] == job["result"]["clips"]
        retry = client.post("/api/jobs/replay", json={"job_id": job_id})
        assert retry.status_code == 200, retry.text
        assert retry.json()["job_id"] != job_id


def test_gui_administration_and_session_credentials_are_scoped(tmp_path):
    app = create_runtime_app(ApplicationPaths.isolated(tmp_path))
    control = app.state.runtime_control
    reader = control.issue_token(RuntimeTokenRequest(subject="reader", scopes=["read"]))
    with TestClient(app, base_url="http://127.0.0.1", client=("127.0.0.1", 1234)) as client:
        headers = {"Authorization": "Bearer " + reader.token}
        assert client.get(PREFIX + "/gui-sessions", headers=headers).status_code == 403
        assert client.get("/api/robots", headers=headers).status_code == 403
        assert (
            client.get("/api/robots", cookies={"hhtools_gui_session": reader.token}).status_code
            == 401
        )
        token = control.issue_session_token("test-session")
        assert control.authenticate(token)["subject"] == "gui-session:test-session"
        assert all(
            record["subject"] != "gui-session:test-session" for record in control.list_tokens()
        )
        control.revoke_session_token("test-session")
        assert control.authenticate(token) is None
        assert client.get("/api/robots", cookies={"hhtools_gui_session": token}).status_code == 401
        response = client.post(PREFIX + "/gui-sessions", json={})
        assert response.json()["code"] == "GUI_ORIGIN_UNAVAILABLE"


def test_gui_settings_update_the_same_runtime_budget_and_library(tmp_path):
    paths = ApplicationPaths.isolated(tmp_path)
    app = create_runtime_app(paths)
    with TestClient(app, base_url="http://127.0.0.1", client=("127.0.0.1", 1234)) as client:
        response = client.patch("/api/settings/job-admission", json={"max_running_jobs": 3})
        assert response.status_code == 200, response.text
        assert client.get(PREFIX + "/budget").json()["max_running_jobs"] == 3
        selected = tmp_path / "another-library"
        response = client.patch("/api/settings/motion-library", json={"root": str(selected)})
        assert response.status_code == 200, response.text
        assert app.state.application_runtime.services.motion_library_root_provider() == selected
        assert client.get("/api/health").json()["motions_library_root"] == str(selected)
        response = client.patch("/api/settings/motion-library", json={"root": None})
        assert response.status_code == 200, response.text
        assert (
            app.state.application_runtime.services.motion_library_root_provider()
            == paths.motion_library_root
        )
