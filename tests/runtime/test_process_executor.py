"""Real process failure, timeout, cancellation, and stale publication boundaries."""

from __future__ import annotations

import json
import multiprocessing
import os
import threading
import time
from datetime import UTC, datetime

import pytest

from hhtools.application.process_executor import SupervisedExecutor
from hhtools.application.runtime import ApplicationPaths
from hhtools.contracts import JobSpecInput, JobSpecProvenance
from hhtools.contracts.runtime import RuntimeBudget
from hhtools.contracts.workflows import WorkflowJobSpec
from hhtools.services.artifacts import ArtifactStore
from hhtools.services.jobs import JobCancelledError, JobExecutionContext, JobExecutionError


def _crash(connection, *args):
    os._exit(7)


def _hang(connection, *args):
    if os.name == "posix":
        os.setsid()
    time.sleep(30)


def _stale(connection, paths, spec, job_id, generation, staging, cancelled):
    connection.send_bytes(
        json.dumps(
            {"job_id": job_id, "generation": "expired", "operation": "result", "result": {}}
        ).encode()
    )


def _context(tmp_path):
    spec = WorkflowJobSpec(
        kind="analysis",
        plan_id="plan:sha256:" + "a" * 64,
        inputs=[JobSpecInput(asset_id="asset:sha256:" + "b" * 64, sha256="b" * 64)],
        backend="dataset_analysis",
        effective_parameters={"embedding": "handcrafted", "metric_config": {}},
        provenance=JobSpecProvenance(
            hhtools_git_commit="a" * 40, hhtools_dirty=False, python="3.12"
        ),
        created_at=datetime.now(UTC),
    )
    event = threading.Event()
    context = JobExecutionContext(
        job_id="job:worker-test",
        spec=spec,
        artifact_store=ArtifactStore(tmp_path / "store"),
        cancellation_event=event,
        progress_callback=lambda *args: None,
    )
    return spec, context, event


@pytest.mark.parametrize(
    "worker,code",
    [(_crash, "WORKER_CRASHED"), (_stale, "WORKER_LEASE_EXPIRED"), (_hang, "WORKER_TIMEOUT")],
)
def test_failed_worker_is_reaped_and_cannot_publish(tmp_path, worker, code):
    spec, context, _ = _context(tmp_path)
    before = {child.pid for child in multiprocessing.active_children()}
    executor = SupervisedExecutor(
        ApplicationPaths.isolated(tmp_path / "runtime"),
        lambda: RuntimeBudget(max_job_seconds=1),
        worker_entrypoint=worker,
    )
    with pytest.raises(JobExecutionError) as error:
        executor(spec, context)
    assert error.value.error.code == code
    assert not context.published_artifacts()
    assert {child.pid for child in multiprocessing.active_children()} == before


def test_cancellation_waits_for_worker_exit(tmp_path):
    spec, context, event = _context(tmp_path)
    executor = SupervisedExecutor(
        ApplicationPaths.isolated(tmp_path / "runtime"),
        lambda: RuntimeBudget(max_job_seconds=20),
        worker_entrypoint=_hang,
    )
    timer = threading.Timer(0.5, event.set)
    timer.start()
    try:
        with pytest.raises(JobCancelledError):
            executor(spec, context)
    finally:
        timer.cancel()
    assert not multiprocessing.active_children()
