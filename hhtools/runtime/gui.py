"""The single HHTools GUI, projected from the same services used by machine clients."""

from __future__ import annotations

import json
import uuid
from contextlib import ExitStack, asynccontextmanager
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse, Response

from hhtools.contracts import AssetKind, JobSpecInput
from hhtools.contracts.calibration import (
    CalibrationProposalRequest,
    CalibrationSaveRequest,
    CalibrationStatusRequest,
    R2RCalibrationProposalRequest,
    R2RCalibrationSaveRequest,
    R2RCalibrationStatusRequest,
)
from hhtools.contracts.runtime import RuntimeBudget
from hhtools.contracts.workflows import AnalysisExportParameters, RetargetExportParameters
from hhtools.robot.registry import use_robot_presets
from hhtools.services.motion_library_links import use_motion_library


class GuiWorkspaceBoundary:
    def __init__(self, app, *, provider, robots):
        self.app = app
        self.provider = provider
        self.robots = robots

    async def __call__(self, scope, receive, send):
        with use_motion_library(self.provider), use_robot_presets(self.robots):
            await self.app(scope, receive, send)


def install_gui(app, runtime, control):
    jobs = app.state.gui_jobs
    services = runtime.services
    services.gui_control = control
    manager = services.agent_job_manager
    router = APIRouter(tags=["HHTools GUI"])
    model_resources = ExitStack()
    models = {}
    original_lifespan = app.router.lifespan_context

    @asynccontextmanager
    async def lifespan(application):
        try:
            async with original_lifespan(application):
                yield
        finally:
            model_resources.close()

    app.router.lifespan_context = lifespan

    def view_robot(identity):
        if identity.asset_id not in models:
            model = services.materialize_robot(identity, compile_mjcf=False)
            model_resources.callback(services.release_robot, model)
            models[identity.asset_id] = model
        return models[identity.asset_id]

    @router.patch("/api/settings/job-admission")
    def admission(body: dict):
        from .api import apply_budget

        allowed = {
            "max_running_jobs",
            "max_queued_jobs",
            "max_batch_items",
            "max_batch_total_frames",
        }
        if set(body) - allowed:
            raise HTTPException(422, "Unknown admission setting.")
        budget = RuntimeBudget.model_validate({**control.budget.model_dump(), **body})
        apply_budget(runtime, control, budget)
        return {
            **jobs.scheduler_payload(editable=True),
            "max_batch_items": budget.max_batch_items,
            "max_batch_total_frames": budget.max_batch_total_frames,
        }

    @router.get("/api/jobs")
    def list_jobs(limit: int = 50):
        stored, _ = services.agent_job_store.list_jobs(limit=max(1, min(limit, 100)))
        records = [jobs.record(jobs.get(item.job_id, include_result=False)) for item in stored]
        with runtime.state.job_lock:
            records.extend(jobs.record(job) for job in runtime.state.jobs.values())
        records.sort(key=lambda item: item["created_at"], reverse=True)
        return {
            "jobs": records[: max(1, min(limit, 100))],
            "persistence": "runtime",
            "session_only": False,
            "scheduler": jobs.scheduler_payload(),
        }

    @router.post("/api/job/{job_id}/cancel")
    def cancel(job_id: str):
        manager.cancel_job(job_id)
        return jobs.record(jobs.get(job_id))

    @router.post("/api/jobs/replay")
    def replay(body: dict):
        job_id = str(body.get("job_id") or body.get("source_job_id") or "")
        if not job_id:
            raise HTTPException(422, "Select a Runtime job to retry.")
        view = manager.retry_job(
            job_id,
            idempotency_key="gui-retry:" + uuid.uuid4().hex,
            max_attempts=control.budget.max_retry_attempts,
        )
        return {"job_id": view.job_id, "parent_job_id": job_id}

    @router.get("/api/job/{job_id}/config")
    def config(job_id: str):
        return services.agent_job_store.get_spec(job_id).model_dump(mode="json")

    @router.post("/api/job/{job_id}/open")
    def open_result(job_id: str):
        from hhtools.application.motions import _ground_motion_for_web
        from hhtools.io.scene_serialize import serialize_motion, serialize_robot

        job = jobs.get(job_id)
        if job is None or job.status != "done":
            raise HTTPException(422, "Select a completed job.")
        spec = services.agent_job_store.get_spec(job_id)
        payload = {"kind": job.kind, "result": job.result}
        if spec.kind == "analysis":
            return payload
        if spec.kind == "video_to_motion":
            from hhtools.services.motion_library_links import materialize_upload_tree

            stored = services.agent_job_store.get(job_id)
            artifact = next((item for item in stored.artifacts if item.kind == "motion"), None)
            if artifact is None:
                raise HTTPException(422, "No motion artifact was produced.")
            imported = services.runtime_uploads.import_artifact(
                services.resource_reports.artifact(job_id, artifact.artifact_id),
                AssetKind.MOTION_BUNDLE,
            )
            asset_id = imported["asset"]["asset_id"]
            source_path = services.agent_asset_service.resolve_primary(asset_id)
            folder = "gvhmr-" + job_id.rsplit(":", 1)[-1]
            with runtime.motion_library_publish_lock:
                library = services.motion_library_root_provider() / folder
                if not library.exists():
                    materialize_upload_tree(source_path.parent, folder)
            motion = services.load_motion_asset(asset_id)
            payload["motion"] = app.state.gui_motion_operations.register_motion(
                motion,
                "gvhmr",
                "runtime",
                library_entry={"source_path": str(source_path)},
                extra={"linked_folder": folder},
            )
            return payload
        if spec.kind not in {"retarget", "r2r_retarget"}:
            raise HTTPException(422, "This task has no interactive result.")
        target = view_robot(spec.robot)
        runtime.state.robots[spec.robot.robot_id] = target
        payload["robot"] = serialize_robot(target, name=spec.robot.robot_id)
        source_path = services.agent_asset_service.resolve_primary(spec.inputs[0].asset_id)
        if spec.source_robot is None:
            motion = services.load_motion_asset(spec.inputs[0].asset_id)
            payload["motion"] = app.state.gui_motion_operations.register_motion(
                motion, None, "runtime", library_entry={"source_path": str(source_path)}
            )
        else:
            source = view_robot(spec.source_robot)
            runtime.state.robots[spec.source_robot.robot_id] = source
            payload["source_robot"] = serialize_robot(source, name=spec.source_robot.robot_id)
            resolved = services.resolve_r2r_trajectory(spec.inputs[0].asset_id)
            prepared = services.prepare_r2r_source(
                resolved,
                source,
                source_fps=spec.effective_parameters.get("source_fps"),
                limit_frames=None,
                progress_callback=None,
            )
            token = uuid.uuid4().hex
            motion = _ground_motion_for_web(prepared.motion)
            runtime.state.r2r_sources[token] = {
                "motion": motion,
                "source_path": str(source_path),
                "source_robot": spec.source_robot.robot_id,
                "source_fps": prepared.source_fps,
                "playback": prepared.playback,
                "upload_profile": "mimic",
                "has_scene": False,
            }
            payload["source_result"] = {
                "token": token,
                "source_robot": spec.source_robot.robot_id,
                "num_frames": prepared.num_frames,
                "framerate": prepared.source_fps,
                "trajectory": job.result["source_trajectory"],
                "skeleton_preview": serialize_motion(motion),
            }
        return payload

    @router.get("/api/dataset/result")
    def analysis_result(source: str | None = None, embedding: str = "handcrafted"):
        root = Path(source or runtime.state.source_root).resolve()
        stored, _ = services.agent_job_store.list_jobs(limit=100)
        for item in stored:
            if (
                item.spec.kind != "analysis"
                or item.view.state != "completed"
                or item.spec.effective_parameters["embedding"] != embedding
            ):
                continue
            if all(
                services.agent_asset_service.resolve_primary(value.asset_id).is_relative_to(root)
                for value in item.spec.inputs
            ):
                return {"available": True, **jobs.result(item)}
        return {"available": False}

    def wait_result(view):
        while view.state in {"queued", "running"}:
            view = manager.wait_job(view.job_id, after_revision=view.progress.revision, timeout=1.0)
        if view.state != "completed":
            raise HTTPException(422, view.error.message if view.error else "Export cancelled.")
        return jobs.get(view.job_id)

    def analysis_export(body, format):
        reference = body.get("runtime_report") or {}
        parameters = AnalysisExportParameters(
            **reference, format=format, clip_ids=body.get("ids") or []
        )
        artifact = services.resource_reports.artifact(parameters.job_id, parameters.artifact_id)
        if artifact.descriptor.kind != "analysis_report":
            raise HTTPException(422, "Select an analysis report.")
        parameters = parameters.model_copy(update={"artifact_sha256": artifact.descriptor.sha256})
        plan = services.runtime_workflow_plans.create(
            "analysis_export",
            services.agent_job_store.get_spec(parameters.job_id).inputs,
            parameters.model_dump(mode="json"),
        )
        job = wait_result(
            manager.start_job(plan.plan_id, idempotency_key="gui-export:" + uuid.uuid4().hex)
        )
        return FileResponse(job.result["artifact_path"], filename=job.result["download_name"])

    @router.post("/api/dataset/export_manifest")
    def export_manifest(body: dict):
        return analysis_export(body, body.get("format", "json"))

    @router.post("/api/dataset/export_robot_zip")
    def export_robot_subset(body: dict):
        return analysis_export(body, "robot_zip")

    @router.get("/api/job/{job_id}/config/download")
    def download_config(job_id: str):
        return Response(
            json.dumps(config(job_id), indent=2),
            media_type="application/json",
            headers={"Content-Disposition": 'attachment; filename="hhtools-job.json"'},
        )

    @router.get("/api/export/{export_token}")
    def export(
        export_token: str,
        fps: float | None = None,
        fmt: str = "csv",
        csv_header: bool = True,
        t_start: float | None = None,
        t_end: float | None = None,
    ):
        stored = services.agent_job_store.get(export_token)
        artifact = next((item for item in stored.artifacts if item.kind == "retarget_state"), None)
        if artifact is None:
            raise HTTPException(422, "This task has no full-resolution trajectory for re-export.")
        parameters = RetargetExportParameters(
            job_id=export_token,
            artifact_id=artifact.artifact_id,
            artifact_sha256=artifact.sha256,
            format=fmt,
            fps=fps,
            csv_header=csv_header,
            t_start=t_start,
            t_end=t_end,
        )
        original = services.agent_job_store.get_spec(export_token)
        inputs = {item.asset_id: item for item in original.inputs}
        for robot in (getattr(original, "robot", None), getattr(original, "source_robot", None)):
            if robot is not None:
                inputs[robot.asset_id] = JobSpecInput(
                    asset_id=robot.asset_id, sha256=robot.config_sha256
                )
        plan = services.runtime_workflow_plans.create(
            "retarget_export", list(inputs.values()), parameters.model_dump(mode="json")
        )
        view = manager.start_job(plan.plan_id, idempotency_key="gui-export:" + uuid.uuid4().hex)
        job = wait_result(view)
        return FileResponse(job.result["artifact_path"], filename=job.result["download_name"])

    def calibration_identity(body):
        robot = jobs.robot_asset(body["robot"])
        record = runtime.state.motions.get(body.get("motion_token"), {})
        motion = (
            jobs.asset(record["source_path"], AssetKind.MOTION_BUNDLE)
            if record.get("source_path")
            else None
        )
        return dict(
            robot_id=body["robot"],
            robot_asset_id=robot.asset_id,
            reference=body["reference"],
            motion_asset_id=motion.asset_id if motion else None,
        )

    @router.get("/api/calibration/status")
    def status(robot: str, reference: str):
        response = services.agent_calibration_service.status(
            CalibrationStatusRequest(**calibration_identity(dict(robot=robot, reference=reference)))
        )
        return {
            "calibrated": response.state in {"valid", "bundled"},
            "bundled": response.state == "bundled",
            "path": response.calibration_id,
            "joint_q": response.joint_q,
        }

    @router.post("/api/calibration/propose")
    def propose(body: dict):
        response = services.agent_calibration_service.propose(
            CalibrationProposalRequest(
                **calibration_identity(body),
                joint_q_overrides=body.get("joint_q") or {},
                locked_joints=body.get("locked_joints") or [],
            )
        )
        validation = response.validation.model_dump(mode="json")
        validation.update(
            alignment_errors=[
                check.message for check in response.validation.checks if check.level == "error"
            ],
            alignment_warnings=[
                check.message for check in response.validation.checks if check.level == "warning"
            ],
        )
        return {
            "joint_q": response.candidate.joint_q,
            "validation": validation,
            "candidate_id": response.candidate.candidate_id,
        }

    @router.post("/api/calibration/save")
    def save(body: dict):
        pose = body.get("joint_q") or {}
        proposal = services.agent_calibration_service.propose(
            CalibrationProposalRequest(
                **calibration_identity(body), joint_q_overrides=pose, locked_joints=list(pose)
            )
        )
        receipt = services.agent_calibration_service.save(
            CalibrationSaveRequest(
                candidate_id=proposal.candidate.candidate_id, save_mode="validated_silent"
            )
        )
        return {
            "ok": True,
            "path": receipt.calibration_id,
            "receipt": receipt.model_dump(mode="json"),
        }

    def pair(body):
        source = jobs.robot_asset(body["source"])
        target = jobs.robot_asset(body["target"])
        return dict(
            source_robot_id=body["source"],
            source_robot_asset_id=source.asset_id,
            target_robot_id=body["target"],
            target_robot_asset_id=target.asset_id,
        )

    @router.get("/api/r2r/calibration/status")
    def r2r_status(source: str, target: str):
        response = services.agent_r2r_calibration_service.status(
            R2RCalibrationStatusRequest(**pair(dict(source=source, target=target)))
        )
        return {"calibrated": response.state == "valid", "joint_q": response.joint_q}

    @router.post("/api/r2r/calibration/save")
    def r2r_save(body: dict):
        pose = body.get("joint_q") or {}
        proposal = services.agent_r2r_calibration_service.propose(
            R2RCalibrationProposalRequest(
                **pair(body), joint_q_overrides=pose, locked_joints=list(pose)
            )
        )
        receipt = services.agent_r2r_calibration_service.save(
            R2RCalibrationSaveRequest(
                candidate_id=proposal.candidate.candidate_id, save_mode="validated_silent"
            )
        )
        return {
            "ok": True,
            "path": receipt.calibration_id,
            "receipt": receipt.model_dump(mode="json"),
        }

    replacements = {(route.path, method) for route in router.routes for method in route.methods}
    app.router.routes[:] = [
        route
        for route in app.routes
        if not any(
            (getattr(route, "path", ""), method) in replacements
            for method in getattr(route, "methods", [])
        )
    ]
    app.include_router(router)
    app.add_middleware(
        GuiWorkspaceBoundary,
        provider=services.motion_library_root_provider,
        robots=services.agent_robot_provider,
    )
