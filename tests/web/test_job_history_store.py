from __future__ import annotations

from pathlib import Path

from hhtools.web.job_history import JobHistoryStore


def test_store_persists_records_and_adopts_artifacts(tmp_path: Path) -> None:
    store = JobHistoryStore(tmp_path / "history", max_records=4)
    generated = tmp_path / "runtime" / "result.zip"
    generated.parent.mkdir()
    generated.write_bytes(b"artifact")

    adopted = store.adopt_artifact("job-one", generated, download_name="motion.zip")
    store.put(
        {
            "id": "job-one",
            "kind": "batch",
            "status": "done",
            "created_at": 10.0,
            "finished_at": 12.0,
            "artifact_path": str(adopted),
        }
    )

    reopened = JobHistoryStore(tmp_path / "history", max_records=4)
    record = reopened.get("job-one")

    assert generated.exists() is False
    assert record is not None
    assert reopened.artifact_path(record) == adopted
    assert adopted.read_bytes() == b"artifact"


def test_store_marks_interrupted_jobs_as_errors(tmp_path: Path) -> None:
    root = tmp_path / "history"
    store = JobHistoryStore(root, max_records=4)
    store.put(
        {
            "id": "interrupted",
            "kind": "retarget",
            "status": "running",
            "created_at": 10.0,
            "finished_at": None,
        }
    )

    recovered = JobHistoryStore(root, max_records=4).get("interrupted")

    assert recovered is not None
    assert recovered["status"] == "error"
    assert "重启" in recovered["error"]
