"""Real asset and analysis flows use the existing persistent job and artifact stores."""

from __future__ import annotations

import hashlib
import json
import time

import numpy as np
import pytest
from fastapi.testclient import TestClient

from hhtools.application.runtime import ApplicationPaths
from hhtools.io.npz import save_npz
from hhtools.runtime.server import create_runtime_app

PREFIX = "/api/runtime/v1"


def test_analysis_comparison_rejects_changed_metric_definitions():
    from types import SimpleNamespace
    from hhtools.application.analysis_reports import AnalysisReports
    from hhtools.contracts.workflows import AnalysisSelectionRequest
    from hhtools.services.runtime_control import RuntimeServiceError

    documents = {
        "a": {"evaluator": "v1", "parameters": {"metric_config": {"weight": 1}}, "clips": []},
        "b": {"evaluator": "v1", "parameters": {"metric_config": {"weight": 2}}, "clips": []},
    }
    reports = AnalysisReports(SimpleNamespace(analysis=lambda job_id, _: documents[job_id]))
    with pytest.raises(RuntimeServiceError) as error:
        reports.compare(
            AnalysisSelectionRequest(job_id="a", artifact_id="a"),
            AnalysisSelectionRequest(job_id="b", artifact_id="b"),
        )
    assert error.value.api_error.code == "EVALUATION_INCOMPATIBLE"


@pytest.fixture
def app_client(tmp_path):
    app = create_runtime_app(ApplicationPaths.isolated(tmp_path))
    with TestClient(app, base_url="http://127.0.0.1", client=("127.0.0.1", 1234)) as client:
        yield app, client


def _wait(client, job_id):
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        job = client.get(PREFIX + f"/jobs/{job_id}").json()
        if job["state"] not in {"queued", "running"}:
            return job
        time.sleep(0.05)
    pytest.fail("Job did not finish")


def test_analysis_plan_job_report_survives_clients_and_retries(
    app_client, synthetic_terrain_motion
):
    app, client = app_client
    root = app.state.application_runtime.paths.source_root
    motion = synthetic_terrain_motion
    motion.terrain = None
    motion.meta = {}
    motion.positions = np.repeat(motion.positions, 30, axis=0)
    motion.quaternions = np.repeat(motion.quaternions, 30, axis=0)
    save_npz(motion, root / "walk.npz")
    registered = client.post(
        "/api/agent/v1/assets", json={"root_id": "source", "relative_path": "walk.npz"}
    )
    assert registered.status_code == 201, registered.text
    asset = registered.json()
    request = {"workflow": "analysis", "asset_ids": [asset["asset_id"]]}
    response = client.post(PREFIX + "/workflows/preflight", json=request)
    assert response.status_code == 200, response.text
    plan = response.json()
    assert plan["schema_version"] == 3
    assert client.post(PREFIX + "/workflows/preflight", json=request).json() == plan
    submission = {"plan_id": plan["plan_id"], "idempotency_key": "analysis-1"}
    response = client.post(PREFIX + "/jobs", json=submission)
    assert response.status_code == 200, response.text
    job_id = response.json()["job_id"]
    job = _wait(client, job_id)
    assert job["state"] == "completed", job
    assert job["outcome"] == "success", job
    assert client.post(PREFIX + "/jobs", json=submission).json()["job_id"] == job_id
    artifact = next(item for item in job["artifacts"] if item["kind"] == "analysis_report")
    report = client.get(
        PREFIX + f"/jobs/{job_id}/artifacts/{artifact['artifact_id']}/content"
    ).json()
    assert len(report["clips"]) == 1
    assert report["clips"][0]["asset_id"] == asset["asset_id"]
    assert str(root) not in json.dumps(report)
    selected = client.post(
        PREFIX + "/analysis/select", json={"job_id": job_id, "artifact_id": artifact["artifact_id"]}
    )
    assert selected.status_code == 200, selected.text
    assert selected.json()["total"] == 1
    events = client.get(PREFIX + "/events").json()
    assert events["events"][-1]["state"] == "completed"
    manifest = next(item for item in job["artifacts"] if item["kind"] == "manifest")
    document = client.get(
        PREFIX + f"/jobs/{job_id}/artifacts/{manifest['artifact_id']}/content"
    ).json()
    assert document["schema_version"] == "2.0"
    assert document["job_spec"]["schema_version"] == 3
    export_plan = client.post(
        PREFIX + "/workflows/analysis-export/preflight",
        json={
            "job_id": job_id,
            "artifact_id": artifact["artifact_id"],
            "format": "csv",
        },
    )
    assert export_plan.status_code == 200, export_plan.text
    export = client.post(
        PREFIX + "/jobs",
        json={
            "plan_id": export_plan.json()["plan_id"],
            "idempotency_key": "export-1",
        },
    ).json()
    exported = _wait(client, export["job_id"])
    assert exported["state"] == "completed", exported
    assert any(
        item["kind"] == "dataset_manifest" and item["format"] == "csv"
        for item in exported["artifacts"]
    )


def test_upload_incomplete_hash_mismatch_and_idempotent_chunks(app_client):
    app, client = app_client
    content = b"video-content-for-integrity-test"
    session = client.post(
        PREFIX + "/uploads",
        json={
            "kind": "video",
            "entry_point": "clip.mp4",
            "files": [
                {
                    "relative_path": "clip.mp4",
                    "role": "video",
                    "size_bytes": len(content),
                    "sha256": hashlib.sha256(content).hexdigest(),
                },
            ],
        },
    ).json()
    upload_id = session["upload_id"]
    path = PREFIX + f"/uploads/{upload_id}"
    assert client.post(path + "/complete").json()["code"] == "UPLOAD_INCOMPLETE"
    first = client.put(path + "/content?member=clip.mp4&offset=0", content=content[:10])
    assert first.json()["offset"] == 10
    assert (
        client.put(path + "/content?member=clip.mp4&offset=0", content=content[:10]).json()[
            "offset"
        ]
        == 10
    )
    assert client.get(path).json()["files"][0]["offset"] == 10
    assert (
        client.put(path + "/content?member=../escape&offset=0", content=b"bad").status_code == 404
    )
    client.put(path + "/content?member=clip.mp4&offset=10", content=content[10:])
    asset = client.post(path + "/complete")
    assert asset.status_code == 200, asset.text
    assert asset.json()["kind"] == "video"
    assert client.post(path + "/complete").json()["asset_id"] == asset.json()["asset_id"]
    assert client.delete(path).json()["code"] == "ASSET_RETAINED"


def test_cleanup_plan_is_invalidated_by_upload_progress(app_client):
    _, client = app_client
    session = client.post(
        PREFIX + "/uploads",
        json={
            "kind": "video",
            "entry_point": "clip.mp4",
            "files": [
                {
                    "relative_path": "clip.mp4",
                    "role": "video",
                    "size_bytes": 3,
                    "sha256": hashlib.sha256(b"abc").hexdigest(),
                },
            ],
        },
    ).json()
    plan = client.get(PREFIX + "/admin/cleanup").json()
    client.put(
        PREFIX + f"/uploads/{session['upload_id']}/content?member=clip.mp4&offset=0", content=b"a"
    )
    result = client.post(PREFIX + "/admin/cleanup", json={"cleanup_id": plan["cleanup_id"]})
    assert result.json()["code"] == "CLEANUP_PLAN_STALE"
    plan = client.get(PREFIX + "/admin/cleanup").json()
    assert (
        client.post(PREFIX + "/admin/cleanup", json={"cleanup_id": plan["cleanup_id"]}).json()[
            "removed_uploads"
        ]
        == 1
    )


def test_uploaded_pickle_requires_content_scoped_admin_trust(app_client, tmp_path):
    import pickle

    app, client = app_client
    marker = tmp_path / "must-not-execute"

    class Payload:
        def __reduce__(self):
            return eval, (f"__import__('pathlib').Path({str(marker)!r}).touch()",)

    payload = pickle.dumps(Payload())
    request = {
        "kind": "dataset_bundle",
        "files": [
            {
                "relative_path": "motion.pkl",
                "role": "motion",
                "size_bytes": len(payload),
                "sha256": hashlib.sha256(payload).hexdigest(),
            }
        ],
    }
    session = client.post(PREFIX + "/uploads", json=request).json()
    path = PREFIX + f"/uploads/{session['upload_id']}"
    client.put(path + "/content?member=motion.pkl&offset=0", content=payload)
    asset = client.post(path + "/complete").json()
    result = client.post(
        PREFIX + "/workflows/preflight",
        json={"workflow": "analysis", "asset_ids": [asset["asset_id"]]},
    )
    assert result.json()["code"] == "INPUT_TRUST_REQUIRED"
    assert not marker.exists()
    from hhtools.contracts.runtime import RuntimeTokenRequest

    token = app.state.runtime_control.issue_token(
        RuntimeTokenRequest(subject="writer", scopes=["read", "write"])
    )
    assert (
        client.post(
            PREFIX + f"/admin/assets/{asset['asset_id']}/trust",
            headers={"Authorization": "Bearer " + token.token},
        ).status_code
        == 403
    )
