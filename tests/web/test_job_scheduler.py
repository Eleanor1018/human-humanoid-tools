from __future__ import annotations

import threading
import time
from functools import partial

import pytest

from hhtools.web.job_scheduler import (
    JobQueueFullError,
    JobScheduler,
    JobSchedulerClosedError,
)


def _wait_until(predicate, *, timeout: float = 2.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.005)
    raise AssertionError("condition was not reached before timeout")


def test_default_scheduler_starts_every_job_without_a_queue() -> None:
    scheduler = JobScheduler()
    release = threading.Event()
    lock = threading.Lock()
    started = 0

    def run() -> None:
        nonlocal started
        with lock:
            started += 1
        release.wait(timeout=2.0)

    for _ in range(4):
        scheduler.submit(run)

    _wait_until(lambda: started == 4)
    snapshot = scheduler.snapshot()
    assert snapshot.max_running_jobs == 0
    assert snapshot.running_jobs == 4
    assert snapshot.queued_jobs == 0

    release.set()
    assert scheduler.shutdown(wait=True, timeout=2.0)


def test_queue_limit_is_ignored_without_a_running_cap() -> None:
    scheduler = JobScheduler(max_running_jobs=0, max_queued_jobs=1)
    release = threading.Event()

    for _ in range(3):
        scheduler.submit(lambda: release.wait(timeout=2.0))

    _wait_until(lambda: scheduler.snapshot().running_jobs == 3)
    assert scheduler.snapshot().queued_jobs == 0
    release.set()
    assert scheduler.shutdown(wait=True, timeout=2.0)


def test_limited_scheduler_runs_fifo_and_reports_pending_jobs() -> None:
    scheduler = JobScheduler(max_running_jobs=1, max_queued_jobs=2)
    releases = [threading.Event() for _ in range(3)]
    started: list[int] = []
    lock = threading.Lock()

    def run(index: int) -> None:
        with lock:
            started.append(index)
        releases[index].wait(timeout=2.0)

    for index in range(3):
        scheduler.submit(partial(run, index))

    _wait_until(lambda: started == [0])
    assert scheduler.snapshot().queued_jobs == 2

    releases[0].set()
    _wait_until(lambda: started == [0, 1])
    releases[1].set()
    _wait_until(lambda: started == [0, 1, 2])
    releases[2].set()

    assert scheduler.shutdown(wait=True, timeout=2.0)


def test_bounded_queue_rejects_before_reserved_upload_work_starts() -> None:
    scheduler = JobScheduler(max_running_jobs=1, max_queued_jobs=1)
    first = scheduler.reserve()
    second = scheduler.reserve()

    with pytest.raises(JobQueueFullError, match="waiting limit: 1"):
        scheduler.reserve()

    first.cancel()
    replacement = scheduler.reserve()
    second.cancel()
    replacement.cancel()
    assert scheduler.shutdown(wait=True, timeout=1.0)


def test_zero_queue_limit_means_unbounded_waiting_when_running_is_limited() -> None:
    scheduler = JobScheduler(max_running_jobs=1, max_queued_jobs=0)
    release = threading.Event()

    scheduler.submit(lambda: release.wait(timeout=2.0))
    for _ in range(5):
        scheduler.submit(lambda: None)

    _wait_until(lambda: scheduler.snapshot().queued_jobs == 5)
    release.set()
    assert scheduler.shutdown(wait=True, timeout=2.0)


def test_shutdown_cancels_pending_and_rejects_new_work() -> None:
    scheduler = JobScheduler(max_running_jobs=1, max_queued_jobs=2)
    release = threading.Event()
    cancelled: list[str] = []

    scheduler.submit(lambda: release.wait(timeout=2.0))
    scheduler.submit(lambda: None, on_cancel=cancelled.append)
    scheduler.submit(lambda: None, on_cancel=cancelled.append)
    _wait_until(lambda: scheduler.snapshot().queued_jobs == 2)

    assert not scheduler.shutdown(wait=False)
    _wait_until(lambda: len(cancelled) == 2)
    assert len(cancelled) == 2
    assert all("尚未开始" in reason for reason in cancelled)
    with pytest.raises(JobSchedulerClosedError):
        scheduler.submit(lambda: None)

    release.set()
    assert scheduler.shutdown(wait=True, timeout=2.0)


def test_shutdown_timeout_includes_slow_pending_cancellation() -> None:
    scheduler = JobScheduler(max_running_jobs=1, max_queued_jobs=2)
    release = threading.Event()

    def slow_cancel(_reason: str) -> None:
        time.sleep(0.15)

    scheduler.submit(lambda: release.wait(timeout=2.0))
    scheduler.submit(lambda: None, on_cancel=slow_cancel)
    scheduler.submit(lambda: None, on_cancel=slow_cancel)
    _wait_until(lambda: scheduler.snapshot().queued_jobs == 2)

    started = time.monotonic()
    assert not scheduler.shutdown(wait=True, timeout=0.05)
    assert time.monotonic() - started < 0.2

    release.set()
    assert scheduler.shutdown(wait=True, timeout=1.0)


def test_repeated_thread_start_failures_drain_without_recursion(
    monkeypatch,
) -> None:
    scheduler = JobScheduler(max_running_jobs=1, max_queued_jobs=0)
    release = threading.Event()
    cancelled: list[str] = []
    scheduler.submit(lambda: release.wait(timeout=2.0))
    for _ in range(1_200):
        scheduler.submit(lambda: None, on_cancel=cancelled.append)
    _wait_until(lambda: scheduler.snapshot().queued_jobs == 1_200)

    def fail_start(_thread: threading.Thread) -> None:
        raise RuntimeError("simulated thread start failure")

    monkeypatch.setattr(threading.Thread, "start", fail_start)
    release.set()

    _wait_until(
        lambda: (
            scheduler.snapshot().running_jobs == 0
            and scheduler.snapshot().queued_jobs == 0
        ),
    )
    assert len(cancelled) == 1_200
    assert scheduler.shutdown(wait=True, timeout=1.0)


def test_thread_start_failure_cancellation_is_part_of_shutdown(
    monkeypatch,
) -> None:
    scheduler = JobScheduler(max_running_jobs=1, max_queued_jobs=0)
    release_running = threading.Event()
    cancel_started = threading.Event()
    release_cancel = threading.Event()

    scheduler.submit(lambda: release_running.wait(timeout=2.0))

    def slow_cancel(_reason: str) -> None:
        cancel_started.set()
        release_cancel.wait(timeout=2.0)

    scheduler.submit(lambda: None, on_cancel=slow_cancel)
    _wait_until(lambda: scheduler.snapshot().queued_jobs == 1)

    def fail_start(_thread: threading.Thread) -> None:
        raise RuntimeError("simulated promoted-thread start failure")

    monkeypatch.setattr(threading.Thread, "start", fail_start)
    release_running.set()
    assert cancel_started.wait(timeout=1.0)

    assert not scheduler.shutdown(wait=True, timeout=0.05)
    assert scheduler.snapshot().cancelling_jobs == 1

    release_cancel.set()
    assert scheduler.shutdown(wait=True, timeout=1.0)
