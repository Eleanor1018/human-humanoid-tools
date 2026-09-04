from __future__ import annotations

import json
from pathlib import Path

from hhtools.web import server
from hhtools.web.jobs.job_settings import (
    JobAdmissionSettings,
    JobAdmissionSettingsStore,
    updated_job_admission_settings,
)


def test_settings_store_round_trips_atomically(tmp_path: Path) -> None:
    path = tmp_path / "config" / "web-settings.json"
    store = JobAdmissionSettingsStore(path)

    store.save(JobAdmissionSettings(max_running_jobs=2, max_queued_jobs=32))

    assert store.load() == JobAdmissionSettings(max_running_jobs=2, max_queued_jobs=32)
    assert json.loads(path.read_text(encoding="utf-8")) == {
        "schema_version": 1,
        "max_running_jobs": 2,
        "max_queued_jobs": 32,
    }
    assert not list(path.parent.glob("*.tmp"))


def test_settings_store_falls_back_for_invalid_content(tmp_path: Path) -> None:
    path = tmp_path / "web-settings.json"
    path.write_text('{"schema_version": 1, "max_running_jobs": -1}', encoding="utf-8")
    fallback = JobAdmissionSettings(max_running_jobs=4, max_queued_jobs=8)

    assert JobAdmissionSettingsStore(path).load(fallback=fallback) == fallback


def test_settings_patch_is_partial_but_strict() -> None:
    current = JobAdmissionSettings(max_running_jobs=1, max_queued_jobs=16)

    assert updated_job_admission_settings(
        current,
        {"max_running_jobs": 2},
    ) == JobAdmissionSettings(max_running_jobs=2, max_queued_jobs=16)


def test_effective_settings_restore_saved_values_and_keep_explicit_overrides(
    tmp_path: Path,
) -> None:
    path = tmp_path / "web-settings.json"
    JobAdmissionSettingsStore(path).save(
        JobAdmissionSettings(max_running_jobs=2, max_queued_jobs=32),
    )

    restored, restored_path = server._effective_job_admission_settings(
        max_running_jobs=None,
        max_queued_jobs=None,
        job_settings_path=path,
    )
    overridden, _ = server._effective_job_admission_settings(
        max_running_jobs=8,
        max_queued_jobs=None,
        job_settings_path=path,
    )

    assert restored == JobAdmissionSettings(max_running_jobs=2, max_queued_jobs=32)
    assert restored_path == path
    assert overridden == JobAdmissionSettings(max_running_jobs=8, max_queued_jobs=32)
