"""Dispatch immutable Agent jobs to their workflow-specific executor."""

from __future__ import annotations

from hhtools.contracts import JobSpecKind, JobSpecV2
from hhtools.services.jobs import JobExecutionContext, JobExecutionResult

from .h2r_job_executor import H2RJobExecutor
from .r2r_job_executor import R2RJobExecutor


class WorkflowJobExecutor:
    """One JobManager executor that preserves separate H2R and R2R adapters."""

    def __init__(self, h2r: H2RJobExecutor, r2r: R2RJobExecutor) -> None:
        self.h2r = h2r
        self.r2r = r2r

    def __call__(
        self,
        spec: JobSpecV2,
        context: JobExecutionContext,
    ) -> JobExecutionResult:
        if spec.kind is JobSpecKind.R2R_RETARGET:
            return self.r2r(spec, context)
        return self.h2r(spec, context)


__all__ = ["WorkflowJobExecutor"]
