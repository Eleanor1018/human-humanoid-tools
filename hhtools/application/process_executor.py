"""Supervised execution with read-only worker stores and controller-only publication."""

from __future__ import annotations

import hashlib
import json
import multiprocessing
import os
import signal
import sys
import tempfile
import time
import uuid
from dataclasses import asdict
from pathlib import Path

from hhtools.contracts import ApiError, ArtifactDescriptor, ErrorStage, JobOutcome, NextAction
from hhtools.contracts.workflows import parse_job_spec
from hhtools.services.artifacts import StoredArtifact
from hhtools.services.jobs import JobCancelledError, JobExecutionError, JobExecutionResult

_IPC_LIMIT = 8 * 1024**2


def _send(connection, document):
    connection.send_bytes(json.dumps(document, allow_nan=False).encode())


def _receive(connection):
    return json.loads(connection.recv_bytes(_IPC_LIMIT))


class _WorkerContext:
    def __init__(
        self,
        connection,
        job_id,
        spec,
        generation,
        staging,
        cancelled,
        *,
        metadata=None,
        artifacts=None,
        progress=None,
    ):
        self.connection = connection
        self.job_id = job_id
        self.spec = spec
        self.generation = generation
        self.staging = staging
        self.cancelled = cancelled
        self.metadata = metadata or {}
        self.artifacts = artifacts if artifacts is not None else []
        self.progress = progress

    @property
    def cancellation_requested(self):
        return self.cancelled.is_set()

    def raise_if_cancelled(self):
        if self.cancellation_requested:
            raise JobCancelledError()

    def _request(self, operation, **arguments):
        self.raise_if_cancelled()
        _send(
            self.connection,
            {
                "generation": self.generation,
                "job_id": self.job_id,
                "operation": operation,
                **arguments,
            },
        )
        response = _receive(self.connection)
        if response.get("error"):
            raise JobExecutionError(ApiError.model_validate(response["error"]))
        return response

    def report_progress(self, **values):
        from hhtools.contracts import JobProgress

        poll_after_ms = values.pop("poll_after_ms", 1000)
        if self.progress is not None:
            return self.progress(JobProgress(**values), poll_after_ms)
        return self._request("progress", values=values, poll_after_ms=poll_after_ms)

    def publish_bytes(self, *, kind, payload, format=None, media_type=None, metadata=None):
        path = self.staging / f"{uuid.uuid4().hex}.output"
        path.write_bytes(payload)
        return self.publish_file(
            kind=kind, source=path, format=format, media_type=media_type, metadata=metadata
        )

    def publish_json(self, *, kind, document, metadata=None):
        return self.publish_bytes(
            kind=kind,
            payload=json.dumps(document, allow_nan=False).encode(),
            format="json",
            media_type="application/json",
            metadata=metadata,
        )

    def publish_file(self, *, kind, source, format=None, media_type=None, metadata=None):
        path = Path(source).resolve(strict=True)
        relative = path.relative_to(self.staging).as_posix()
        with path.open("rb") as stream:
            digest = hashlib.file_digest(stream, "sha256").hexdigest()
        document = self._request(
            "publish",
            relative_path=relative,
            sha256=digest,
            size_bytes=path.stat().st_size,
            kind=kind,
            format=format,
            media_type=media_type,
            metadata={**(metadata or {}), **self.metadata},
        )
        descriptor = ArtifactDescriptor.model_validate(document)
        self.artifacts.append(descriptor)
        return descriptor

    def published_artifacts(self):
        return tuple(self.artifacts)

    def get_published_artifact(self, artifact_id):
        document = self._request("artifact", artifact_id=artifact_id)
        return StoredArtifact(
            descriptor=ArtifactDescriptor.model_validate(document["descriptor"]),
            path=Path(document["path"]),
        )

    def for_child(self, spec, *, progress_callback, artifact_metadata):
        return _WorkerContext(
            self.connection,
            self.job_id,
            spec,
            self.generation,
            self.staging,
            self.cancelled,
            metadata={**self.metadata, **artifact_metadata},
            artifacts=self.artifacts,
            progress=progress_callback,
        )


def _worker_main(connection, paths, spec_document, job_id, generation, staging, cancelled):
    state = None
    try:
        os.environ.setdefault("MUJOCO_GL", "egl")
        if os.name == "posix":
            os.setsid()
            os.environ["HHTOOLS_SUPERVISED_WORKER"] = "1"
        if sys.platform == "linux":
            import ctypes

            parent_pid = os.getppid()
            signal.signal(signal.SIGTERM, lambda *_: cancelled.set())
            ctypes.CDLL(None).prctl(1, signal.SIGTERM)
            if os.getppid() != parent_pid:
                cancelled.set()
        from hhtools.application.state import _cleanup_session_state
        from hhtools.application.worker_resources import build_worker_services
        from hhtools.application.workflows import (
            ResourceWorkflowExecutor,
            analysis_configuration,
            workflow_availability,
            workflow_configuration_identity,
        )
        from hhtools.services.workflow_plans import WorkflowPlanService

        spec = parse_job_spec(spec_document)
        state, services = build_worker_services(paths, staging)
        plans = WorkflowPlanService(
            services.agent_plan_store,
            services.agent_asset_service,
            services.agent_retarget_service,
            availability=workflow_availability,
            analysis_config=analysis_configuration,
            artifact_resolver=services.resource_reports.artifact,
            backend_identity=workflow_configuration_identity,
        )
        executor = ResourceWorkflowExecutor(
            services.agent_asset_service,
            plans,
            services.agent_executor,
            staging,
            paths=paths,
            services=services,
        )
        context = _WorkerContext(connection, job_id, spec, generation, staging, cancelled)
        result = executor(spec, context)
        document = asdict(result)
        document["failures"] = [
            item.model_dump(mode="json") if hasattr(item, "model_dump") else item
            for item in result.failures
        ]
        if result.next_action is not None:
            document["next_action"] = result.next_action.model_dump(mode="json")
        _send(
            connection,
            {"generation": generation, "job_id": job_id, "operation": "result", "result": document},
        )
    except JobCancelledError:
        _send(connection, {"generation": generation, "job_id": job_id, "operation": "cancelled"})
    except BaseException as error:
        public = getattr(error, "api_error", None) or getattr(error, "error", None)
        if not isinstance(public, ApiError):
            public = ApiError(
                code="WORKER_FAILED",
                message="The isolated backend stopped before completion.",
                stage=ErrorStage.EXECUTION,
                details={"exception_type": type(error).__name__},
            )
        _send(
            connection,
            {
                "generation": generation,
                "job_id": job_id,
                "operation": "error",
                "error": public.model_dump(mode="json"),
            },
        )
    finally:
        if state is not None:
            _cleanup_session_state(state)
        connection.close()


class SupervisedExecutor:
    """Only the parent receives publication requests and writes authoritative stores."""

    def __init__(self, paths, budget_provider, *, worker_entrypoint=_worker_main):
        self.paths = paths
        self.budget_provider = budget_provider
        self.worker_entrypoint = worker_entrypoint

    @staticmethod
    def _stop(process):
        if process.is_alive():
            process.terminate()
            process.join(3)
        if process.is_alive():
            if os.name == "posix":
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            else:
                process.kill()
            process.join()

    def __call__(self, spec, context):
        spawn = multiprocessing.get_context("spawn")
        budget = self.budget_provider()
        root = self.paths.save_dir / ".hhtools-agent" / "workers"
        root.mkdir(parents=True, exist_ok=True)
        generation = uuid.uuid4().hex
        with tempfile.TemporaryDirectory(prefix=generation + "-", dir=root) as name:
            staging = Path(name).resolve()
            parent, child = spawn.Pipe()
            cancelled = spawn.Event()
            process = spawn.Process(
                target=self.worker_entrypoint,
                args=(
                    child,
                    self.paths,
                    spec.model_dump(mode="json"),
                    context.job_id,
                    generation,
                    staging,
                    cancelled,
                ),
            )
            process.start()
            child.close()
            started = time.monotonic()
            cancel_started = None
            last_disk_check = started
            result = None
            try:
                while True:
                    now = time.monotonic()
                    if context.cancellation_requested:
                        cancelled.set()
                        cancel_started = cancel_started or now
                        if now - cancel_started > 3:
                            raise JobCancelledError()
                    if budget.max_job_seconds and now - started > budget.max_job_seconds:
                        cancelled.set()
                        raise JobExecutionError(
                            ApiError(
                                code="WORKER_TIMEOUT",
                                message="The worker exceeded its execution budget.",
                                stage=ErrorStage.EXECUTION,
                                retryable=True,
                            )
                        )
                    if now - last_disk_check >= 0.5:
                        last_disk_check = now
                        used = 0
                        for path in root.rglob("*"):
                            try:
                                if path.is_file():
                                    used += path.stat().st_size
                            except FileNotFoundError:
                                continue
                        if used > budget.max_staging_bytes:
                            raise JobExecutionError(
                                ApiError(
                                    code="WORKER_DISK_BUDGET_EXCEEDED",
                                    message="Worker staging exceeded its disk budget.",
                                    stage=ErrorStage.EXECUTION,
                                )
                            )
                    if not parent.poll(0.1):
                        if not process.is_alive():
                            raise JobExecutionError(
                                ApiError(
                                    code="WORKER_CRASHED",
                                    message="The worker exited without a result.",
                                    stage=ErrorStage.EXECUTION,
                                    retryable=True,
                                )
                            )
                        continue
                    try:
                        message = _receive(parent)
                    except EOFError as error:
                        raise JobExecutionError(
                            ApiError(
                                code="WORKER_CRASHED",
                                message="The worker connection closed.",
                                stage=ErrorStage.EXECUTION,
                                retryable=True,
                            )
                        ) from error
                    if (
                        message.get("generation") != generation
                        or message.get("job_id") != context.job_id
                    ):
                        raise JobExecutionError(
                            ApiError(
                                code="WORKER_LEASE_EXPIRED",
                                message="Worker publication identity does not match its lease.",
                                stage=ErrorStage.EXECUTION,
                            )
                        )
                    operation = message.get("operation")
                    if operation == "result":
                        if message["result"].get("next_action") is not None:
                            message["result"]["next_action"] = NextAction.model_validate(
                                message["result"]["next_action"]
                            )
                        result = JobExecutionResult(
                            **{
                                **message["result"],
                                "outcome": JobOutcome(message["result"]["outcome"]),
                            }
                        )
                        break
                    if operation == "error":
                        raise JobExecutionError(ApiError.model_validate(message["error"]))
                    if operation == "cancelled":
                        raise JobCancelledError()
                    if operation == "progress":
                        context.report_progress(
                            **message["values"], poll_after_ms=message["poll_after_ms"]
                        )
                        _send(parent, {})
                    elif operation == "publish":
                        path = (staging / message["relative_path"]).resolve(strict=True)
                        path.relative_to(staging)
                        if not path.is_file() or path.stat().st_size > budget.max_staging_bytes:
                            raise ValueError("Invalid worker output")
                        with path.open("rb") as stream:
                            digest = hashlib.file_digest(stream, "sha256").hexdigest()
                        if (
                            digest != message["sha256"]
                            or path.stat().st_size != message["size_bytes"]
                        ):
                            raise ValueError("Worker output changed before publication")
                        context.raise_if_cancelled()
                        descriptor = context.publish_file(
                            kind=message["kind"],
                            source=path,
                            format=message["format"],
                            media_type=message["media_type"],
                            metadata=message["metadata"],
                        )
                        _send(parent, descriptor.model_dump(mode="json"))
                    elif operation == "artifact":
                        stored = context.get_published_artifact(message["artifact_id"])
                        _send(
                            parent,
                            {
                                "descriptor": stored.descriptor.model_dump(mode="json"),
                                "path": str(stored.path),
                            },
                        )
                    else:
                        raise ValueError("Unknown worker operation")
                process.join(3)
                if process.is_alive() or process.exitcode != 0:
                    raise JobExecutionError(
                        ApiError(
                            code="WORKER_CLEANUP_FAILED",
                            message="The worker did not finish its cleanup.",
                            stage=ErrorStage.EXECUTION,
                        )
                    )
                context.raise_if_cancelled()
                return result
            finally:
                cancelled.set()
                self._stop(process)
                parent.close()
                process.close()
