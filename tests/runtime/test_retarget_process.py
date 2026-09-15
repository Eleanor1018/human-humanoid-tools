"""Exercise the existing calibration/retarget engine through the resident worker boundary."""

from __future__ import annotations

import shutil
import time
from pathlib import Path

import pytest
import yaml
from fastapi.testclient import TestClient

from hhtools.application.runtime import ApplicationPaths
from hhtools.contracts.runtime import RuntimeBudget
from hhtools.io.npz import save_npz
from hhtools.runtime.server import create_runtime_app


@pytest.mark.skipif(
    not Path("/dev/nvidia0").exists(), reason="requires a real GPU retarget backend"
)
def test_calibration_and_h2r_run_in_supervised_process(
    tmp_path, monkeypatch, grounding_robot_pair, synthetic_terrain_motion
):
    _, model = grounding_robot_pair
    paths = ApplicationPaths.isolated(tmp_path)
    robot = paths.robot_root / model.preset.name
    robot.mkdir(parents=True)
    shutil.copy2(model.preset.urdf_path, robot / "robot.urdf")
    (robot / "robot.yaml").write_text(
        yaml.safe_dump(
            {
                "name": model.preset.name,
                "display_name": model.preset.display_name,
                "urdf": "robot.urdf",
                "dof_order": list(model.dof_names()),
                "ik_map": dict(model.preset.ik_map),
                "feet": dict(model.preset.feet),
            }
        )
    )
    monkeypatch.setenv("HHTOOLS_ROBOT_DIR", str(paths.robot_root))
    motion = synthetic_terrain_motion
    motion.terrain = None
    motion.meta = {"dataset": "unified_npz"}
    paths.source_root.mkdir(parents=True)
    save_npz(motion, paths.source_root / "motion.npz")
    app = create_runtime_app(paths)
    app.state.runtime_control.save_budget(RuntimeBudget(max_job_seconds=50))
    with TestClient(app, base_url="http://127.0.0.1", client=("127.0.0.1", 1234)) as client:
        root = "/api/agent/v1"
        robot_asset = client.post(
            root + "/assets",
            json={
                "root_id": "robot-library",
                "relative_path": model.preset.name,
                "kind": "robot_bundle",
            },
        ).json()
        motion_asset = client.post(
            root + "/assets", json={"root_id": "source", "relative_path": "motion.npz"}
        ).json()
        identity = {
            "robot_id": model.preset.name,
            "robot_asset_id": robot_asset["asset_id"],
            "reference": "smpl",
        }
        proposal = client.post(root + "/calibrations/proposals", json=identity)
        assert proposal.status_code == 200, proposal.text
        candidate_id = proposal.json()["candidate"]["candidate_id"]
        saved = client.post(
            root + "/calibrations/save",
            json={"candidate_id": candidate_id, "save_mode": "validated_silent"},
        )
        assert saved.status_code == 200, saved.text
        preflight = client.post(
            root + "/preflight/retarget",
            json={
                "motion_asset_id": motion_asset["asset_id"],
                "robot_id": model.preset.name,
                "robot_asset_id": robot_asset["asset_id"],
                "backend": "newton",
                "parameters": {"run_mode": "smoke", "limit_frames": 1},
            },
        ).json()
        assert preflight["status"] == "ready", preflight
        submitted = client.post(
            "/api/runtime/v1/jobs",
            json={"plan_id": preflight["plan"]["plan_id"], "idempotency_key": "supervised-h2r"},
        )
        assert submitted.status_code == 200, submitted.text
        job = submitted.json()
        deadline = time.monotonic() + 60
        while job["state"] in {"queued", "running"} and time.monotonic() < deadline:
            time.sleep(0.05)
            job = client.get("/api/runtime/v1/jobs/" + job["job_id"]).json()
        assert job["state"] == "completed", job
        assert {"preview", "retarget_state", "retargeted_motion", "evaluation_report", "manifest"} <= {
            item["kind"] for item in job["artifacts"]
        }
        opened = client.post(f"/api/job/{job['job_id']}/open")
        assert opened.status_code == 200, opened.text
        assert opened.json()["result"]["trajectory"]["frames"]
        assert opened.json()["motion"]["token"]
        exported = client.get(f"/api/export/{job['job_id']}?fmt=pkl&fps=30")
        assert exported.status_code == 200, exported.text[:300]
        assert exported.content
        gui_jobs = client.get("/api/jobs").json()["jobs"]
        assert any(item["kind"] == "retarget_export" and item["status"] == "done" for item in gui_jobs)
        batch = client.post(
            root + "/preflight/batch",
            json={"workflow": "h2r", "item_plan_ids": [preflight["plan"]["plan_id"]]},
        ).json()
        assert batch["status"] == "ready", batch
        job = client.post(
            "/api/runtime/v1/jobs",
            json={"plan_id": batch["plan"]["plan_id"], "idempotency_key": "supervised-batch"},
        ).json()
        deadline = time.monotonic() + 60
        while job["state"] in {"queued", "running"} and time.monotonic() < deadline:
            time.sleep(0.05)
            job = client.get("/api/runtime/v1/jobs/" + job["job_id"]).json()
        assert job["state"] == "completed", job
        assert any(item["kind"] == "batch_archive" for item in job["artifacts"])
