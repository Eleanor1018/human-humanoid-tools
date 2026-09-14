"""Adapt the existing GUI to persistent workflow jobs, retaining only view caches locally."""

from __future__ import annotations

import json
import os
import shutil
import time
import uuid
from contextvars import copy_context
from pathlib import Path

from fastapi import HTTPException

from hhtools.application.state import Job
from hhtools.contracts import AssetKind, R2RPreflightRequest, RetargetPreflightRequest
from hhtools.contracts.batch import BatchPreflightRequest
from hhtools.contracts.workflows import WorkflowPreflightRequest
from hhtools.services.assets import AssetServiceError
from hhtools.services.job_store import JobStoreError
from hhtools.services.motion_library_links import use_motion_library

from .job_runtime import WebJobRuntime

_WORKFLOWS = {
    "retarget",
    "r2r_retarget",
    "batch",
    "r2r_batch",
    "dataset_analyze",
    "video_to_motion",
}
_STATES = {
    "queued": "pending",
    "running": "running",
    "completed": "done",
    "failed": "error",
    "cancelled": "cancelled",
}


class RuntimeGuiJobs(WebJobRuntime):
    runtime = None

    @property
    def services(self):
        return self.runtime.services

    def persist(self, job):
        # Loading a viewport is session state; only workflow jobs enter durable history.
        pass

    def persist_terminal(self, job, status):
        pass

    def settings_editable(self, request):
        return "admin" in getattr(request.state, "runtime_principal", {}).get("scopes", [])

    def asset(self, source, kind):
        """Register a GUI-selected source, snapshotting temporary/out-of-root bundles."""
        assets = self.services.agent_asset_service
        path = Path(source).expanduser().resolve(strict=True)
        try:
            hint = assets.registration_hint(path, kind=kind)
        except AssetServiceError as error:
            if error.code not in {"ASSET_OUTSIDE_ALLOWED_ROOT", "ASSET_ROOT_UNREPRESENTABLE"}:
                raise
            if kind == AssetKind.ROBOT_BUNDLE:
                from hhtools.services.robot_asset_inspection import discover_robot_bundle

                files = [item.path for item in discover_robot_bundle(path).files]
            elif kind in {AssetKind.MOTION_BUNDLE, AssetKind.ROBOT_TRAJECTORY_BUNDLE}:
                if kind == AssetKind.MOTION_BUNDLE:
                    from hhtools.services.asset_inspection import discover_primary

                    discovered = discover_primary(path)
                else:
                    from hhtools.services.r2r_asset_inspection import discover_r2r_trajectory

                    discovered = discover_r2r_trajectory(path)
                files = [
                    discovered.primary_path,
                    *(p for group in discovered.sidecars.values() for p in group),
                ]
            elif kind == AssetKind.VIDEO:
                files = [path]
            else:
                raise HTTPException(
                    422, "Import this dataset into the workspace Motion Library first."
                ) from error
            files = list(dict.fromkeys(Path(item).resolve(strict=True) for item in files))
            if len(files) > 4096 or sum(item.stat().st_size for item in files) > 8 * 1024**3:
                raise HTTPException(413, "Asset bundle exceeds the GUI import limit.") from error
            base = (
                path
                if path.is_dir()
                else Path(os.path.commonpath([str(item.parent) for item in files]))
            )
            destination = self.runtime.paths.asset_roots["runtime"] / "gui" / uuid.uuid4().hex
            destination.mkdir(parents=True)
            try:
                for item in files:
                    target = destination / item.relative_to(base)
                    target.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copyfile(item, target)
                path = destination if path.is_dir() else destination / path.relative_to(base)
                hint = assets.registration_hint(path, kind=kind)
            except BaseException:
                shutil.rmtree(destination, ignore_errors=True)
                raise
        bundle = assets.register(hint)
        # These routes require an operator. Importing a file is their explicit execution intent.
        control = self.services.gui_control
        control.trust_asset(bundle.asset_id)
        return bundle

    def robot_asset(self, name):
        model = self.state.robots.get(name)
        if model is not None:
            preset = model.preset
            if getattr(model, "_agent_asset_workspace", None) is not None and (
                asset_id := (preset.meta or {}).get("_agent_asset_id")
            ):
                return self.services.agent_asset_service.get(asset_id)
        else:
            preset = next(
                (item for item in self.services.agent_robot_provider() if item.name == name), None
            )
            if preset is None:
                raise HTTPException(404, "Robot is not installed in this workspace.")
        return self.asset(preset.root_dir, AssetKind.ROBOT_BUNDLE)

    @staticmethod
    def ready(response):
        if response.plan is None:
            detail = (
                response.error.message
                if response.error
                else "; ".join(
                    check.message for check in response.checks if str(check.level) != "info"
                )
            )
            raise HTTPException(
                422, detail or "Preflight requires calibration or a valid input asset."
            )
        return response.plan

    def single_plan(self, kind, body, *, source_path=None):
        parameters = {
            key: body[key]
            for key in ("ik_iterations", "retarget_fps", "limit_frames")
            if body.get(key) is not None
        }
        parameters["run_mode"] = "smoke" if body.get("limit_frames") else "full"
        if body.get("backend") == "interaction_mesh":
            parameters.pop("ik_iterations", None)
        export = {
            key: body[key]
            for key in ("t_start", "t_end", "csv_header")
            if body.get(key) is not None
        }
        if body.get("export_fps", body.get("fps")) is not None:
            export["fps"] = body.get("export_fps", body.get("fps"))
        if export:
            parameters["export"] = export
        if kind == "retarget":
            record = self.state.motions.get(body.get("motion_token"), {})
            source_path = source_path or record.get("source_path") or body.get("source_path")
            if not source_path:
                raise HTTPException(422, "Reload the motion from a saved file before submitting.")
            motion = self.asset(source_path, AssetKind.MOTION_BUNDLE)
            robot = self.robot_asset(body["robot"])
            parameters.update(
                {
                    key: body[key]
                    for key in ("reference", "human_height", "foot_clamp_anti_penetration")
                    if body.get(key) is not None
                }
            )
            response = self.services.agent_preflight_service.preflight_retarget(
                RetargetPreflightRequest(
                    motion_asset_id=motion.asset_id,
                    robot_id=body["robot"],
                    robot_asset_id=robot.asset_id,
                    backend=body.get("backend", "newton"),
                    output_format=body.get("format", "csv"),
                    parameters=parameters,
                )
            )
        else:
            record = self.state.r2r_sources.get(body.get("source_token"), {})
            source_path = source_path or record.get("source_path") or body.get("source_path")
            if not source_path:
                raise HTTPException(
                    422, "Reload the robot trajectory from a saved file before submitting."
                )
            trajectory = self.asset(source_path, AssetKind.ROBOT_TRAJECTORY_BUNDLE)
            source_name = body.get("source_robot") or body.get("source")
            target_name = body.get("target_robot") or body.get("target")
            source = self.robot_asset(source_name)
            target = self.robot_asset(target_name)
            if record.get("source_fps") or body.get("source_fps"):
                parameters["source_fps"] = body.get("source_fps") or record["source_fps"]
            response = self.services.agent_r2r_preflight_service.preflight_r2r(
                R2RPreflightRequest(
                    trajectory_asset_id=trajectory.asset_id,
                    source_robot_id=source_name,
                    source_robot_asset_id=source.asset_id,
                    target_robot_id=target_name,
                    target_robot_asset_id=target.asset_id,
                    backend=body.get("backend", "newton"),
                    output_format=body.get("format", "csv"),
                    parameters=parameters,
                )
            )
        return self.ready(response)

    def schedule(
        self,
        kind,
        request=None,
        target=None,
        *,
        args=(),
        kwargs=None,
        parent_job_id=None,
        reservation=None,
    ):
        if kind not in _WORKFLOWS:
            context = copy_context()

            def prepare(job, *positional, **named):
                with use_motion_library(self.services.motion_library_root_provider):
                    return target(job, *positional, **named)

            return super().schedule(
                kind,
                request,
                lambda *a, **kw: context.run(prepare, *a, **kw),
                args=args,
                kwargs=kwargs,
                parent_job_id=parent_job_id,
                reservation=reservation,
            )
        if reservation is not None:
            reservation.cancel()
        body = request or {}
        if kind in {"retarget", "r2r_retarget"}:
            plan = self.single_plan(kind, body)
        elif kind in {"batch", "r2r_batch"}:
            entries = body.get("entries") or []
            if not entries and kind == "batch" and body.get("source"):
                from hhtools.services.motion_library import scan_library

                entries = [
                    dict(source_path=str(entry.source_path))
                    for entry in scan_library(Path(body["source"]))
                ]
            if not entries:
                raise HTTPException(422, "Select batch input clips.")
            plans = [
                self.single_plan(
                    "retarget" if kind == "batch" else "r2r_retarget",
                    {**body, **entry},
                    source_path=entry["source_path"],
                ).plan_id
                for entry in entries
            ]
            plan = self.ready(
                self.services.agent_batch_preflight_service.preflight_batch(
                    BatchPreflightRequest(
                        workflow="h2r" if kind == "batch" else "r2r",
                        item_plan_ids=plans,
                    )
                )
            )
        else:
            if kind == "video_to_motion":
                bundle = self.asset(args[1], AssetKind.VIDEO)
                asset_ids = [bundle.asset_id]
                workflow = "video_to_motion"
                parameters = {
                    "static_camera": body.get("static_cam", True),
                    "focal_length_mm": body.get("f_mm"),
                }
            else:
                from hhtools.services.dataset_catalog import build_analysis_entries

                entries = build_analysis_entries(Path(body.get("source") or self.state.source_root))
                if not entries or len(entries) > 1000:
                    raise HTTPException(422, "Select between 1 and 1000 analysis clips.")
                asset_ids = list(
                    dict.fromkeys(
                        self.asset(
                            entry["source_path"],
                            AssetKind.ROBOT_TRAJECTORY_BUNDLE
                            if entry.get("dataset") == "robot"
                            else AssetKind.MOTION_BUNDLE,
                        ).asset_id
                        for entry in entries
                    )
                )
                workflow = "analysis"
                parameters = {"embedding": body.get("embedding", "handcrafted")}
            plan = self.services.runtime_workflow_plans.preflight(
                WorkflowPreflightRequest(
                    workflow=workflow, asset_ids=asset_ids, parameters=parameters
                )
            )
        view = self.services.agent_job_manager.start_job(
            plan.plan_id, idempotency_key="gui:" + uuid.uuid4().hex, parent_job_id=parent_job_id
        )
        return self.get(view.job_id)

    def result(self, stored, *, include_preview=True):
        result = dict(stored.view.summary)
        if stored.spec.kind == "batch_retarget":
            result.update(
                clip_count=result.get("succeeded_items", 0), written=[], errors=[], failures=[]
            )
        for artifact in stored.artifacts:
            if include_preview and artifact.kind in {"preview", "analysis_report", "batch_report"}:
                file = self.services.resource_reports.artifact(stored.job_id, artifact.artifact_id)
                document = json.loads(file.path.read_text(encoding="utf-8"))
                if artifact.kind == "analysis_report":
                    document["meta"] = {
                        "embedding": document["parameters"]["embedding"],
                        "source_root": str(self.state.source_root),
                    }
                    document["runtime_report"] = {
                        "job_id": stored.job_id,
                        "artifact_id": artifact.artifact_id,
                    }
                    for clip in document["clips"]:
                        clip["source_path"] = str(
                            self.services.agent_asset_service.resolve_file(
                                clip["asset_id"], clip["relative_path"]
                            )
                        )
                result.update(document)
                if artifact.kind == "batch_report":
                    result["written"] = [
                        item["input_asset_id"]
                        for item in document["items"]
                        if item["state"] == "completed"
                    ]
                    result["errors"] = [
                        item["error"]["message"]
                        for item in document["items"]
                        if item["state"] == "failed"
                    ]
            elif include_preview and artifact.kind == "manifest":
                file = self.services.resource_reports.artifact(stored.job_id, artifact.artifact_id)
                result["execution_provenance"] = json.loads(
                    file.path.read_text(encoding="utf-8")
                ).get("execution_provenance", {})
        if "target_trajectory" in result:
            result["trajectory"] = result["target_trajectory"]
        download = next(
            (item for item in stored.artifacts if item.kind == "batch_archive"), None
        ) or next(
            (
                item
                for item in stored.artifacts
                if item.kind
                in {"retargeted_motion", "dataset_manifest", "dataset_bundle", "motion"}
            ),
            None,
        )
        if download is not None:
            file = self.services.agent_artifact_store.get(
                download.artifact_id, verify=include_preview
            )
            result.update(
                artifact_path=str(file.path),
                download_name=download.metadata.get("filename")
                or f"{result.get('stem', 'hhtools-result')}.{download.format}",
            )
        result["export_token"] = stored.job_id
        return result

    def get(self, job_id, *, include_result=True):
        local = super().get(job_id)
        if local is not None:
            return local
        try:
            stored = self.services.agent_job_store.get(job_id)
        except JobStoreError as error:
            if error.code == "JOB_NOT_FOUND":
                return None
            raise
        spec = self.services.agent_job_store.get_spec(job_id)
        kind = str(spec.kind)
        if kind == "analysis":
            kind = "dataset_analyze"
        elif kind == "batch_retarget":
            kind = "r2r_batch" if spec.effective_parameters.get("workflow") == "r2r" else "batch"
        request = dict(spec.effective_parameters)
        robot = getattr(spec, "robot", None)
        if robot is not None:
            request["robot"] = robot.robot_id
        view = stored.view
        return Job(
            id=job_id,
            kind=kind,
            request=request,
            status=_STATES[view.state],
            progress=view.progress.fraction,
            message=view.progress.message or view.progress.phase,
            error=view.error.message if view.error else None,
            result=self.result(stored, include_preview=include_result)
            if view.state == "completed"
            else None,
            parent_job_id=view.parent_job_id,
            created_wall_time=view.submitted_at.timestamp(),
            finished_wall_time=view.completed_at.timestamp() if view.completed_at else None,
        )

    def record(self, job):
        if job.id in self.state.jobs:
            return super().record(job)
        view = self.services.agent_job_store.get(job.id).view
        summary = self.result_summary(job)
        if job.kind in {"batch", "r2r_batch"}:
            summary.update(
                success_count=view.summary.get("succeeded_items", 0),
                failure_count=view.summary.get("failed_items", 0),
            )
        return {
            "id": job.id,
            "kind": job.kind,
            "status": job.status,
            "outcome": view.outcome,
            "progress": job.progress,
            "clip_progress": job.clip_progress,
            "message": job.message,
            "error": job.error,
            "created_at": job.created_wall_time,
            "finished_at": job.finished_wall_time,
            "duration_seconds": (job.finished_wall_time or time.time()) - job.created_wall_time,
            "parameters": self.parameter_summary(job),
            "result_summary": summary,
            "can_download": self.can_download(job),
            "can_cancel": job.status in {"pending", "running"},
            "can_retry": job.status in {"done", "error", "cancelled"}
            and view.attempt < self.services.gui_control.budget.max_retry_attempts,
            "can_retry_failed": False,
            "can_copy_cli": False,
            "can_open": job.status == "done"
            and job.kind in {"retarget", "r2r_retarget", "dataset_analyze", "video_to_motion"},
            "parent_job_id": job.parent_job_id,
            "scope": "runtime",
        }
