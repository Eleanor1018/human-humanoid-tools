"""Read report bytes only through canonical job-to-artifact membership."""

from __future__ import annotations

import json

from .runtime_control import RuntimeServiceError


class ResourceReports:
    def __init__(self, jobs, artifacts):
        self.jobs = jobs
        self.artifacts = artifacts

    def artifact(self, job_id, artifact_id):
        job = self.jobs.get(job_id)
        if not any(item.artifact_id == artifact_id for item in job.artifacts):
            raise RuntimeServiceError(
                "ARTIFACT_NOT_FOUND", "Artifact is not published by this job."
            )
        stored = self.artifacts.get(artifact_id, verify=True)
        if stored.descriptor.job_id != job_id:
            raise RuntimeServiceError("ARTIFACT_NOT_FOUND", "Artifact belongs to another job.")
        return stored

    def analysis(self, job_id, artifact_id):
        stored = self.artifact(job_id, artifact_id)
        if stored.descriptor.kind != "analysis_report":
            raise RuntimeServiceError(
                "ARTIFACT_KIND_MISMATCH", "Select an analysis report artifact."
            )
        return json.loads(stored.path.read_text(encoding="utf-8"))
