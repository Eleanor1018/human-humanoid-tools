"""Human-to-robot calibration, preview, and retarget routes."""

from __future__ import annotations

import logging
import uuid
from collections.abc import Callable
from dataclasses import dataclass

from fastapi import HTTPException

from hhtools.web.server.export_runtime import _parse_optional_fps
from hhtools.web.server.motion_runtime import _motion_for_retarget
from hhtools.web.server.preview_runtime import (
    _align_scaled_preview_to_robot_playback,
    _compute_scaled_preview,
    _compute_scaled_scene,
)
from hhtools.web.server.retarget_runtime import _request_human_height, _retarget_single
from hhtools.web.server.state import Job, _snapshot_job_request

_log = logging.getLogger(__name__)


@dataclass(frozen=True, slots=True)
class H2RRouteOperations:
    run_retarget_job: Callable


def register_h2r_routes(app, *, state, jobs) -> H2RRouteOperations:
    _schedule_job = jobs.schedule

    @app.get("/api/calibration/references")
    def calibration_references() -> dict:
        from hhtools.retarget.calibration import list_reference_names

        return {"references": list(list_reference_names())}

    @app.get("/api/calibration/status")
    def calibration_status(robot: str, reference: str) -> dict:
        from hhtools.retarget.calibration import resolve_preset_calibration_file
        from hhtools.robot.registry import get as get_preset
        from hhtools.robot.retarget_profile import bundled_scaler_path

        try:
            preset = get_preset(robot)
        except Exception as err:  # noqa: BLE001
            raise HTTPException(status_code=404, detail=str(err)) from err
        if preset.urdf_path is None:
            return {"calibrated": False, "path": None}
        path = resolve_preset_calibration_file(preset, reference)
        bundled = bundled_scaler_path(preset, reference)
        joint_q: dict[str, float] | None = None
        if path is not None:
            from hhtools.retarget.calibration import load_calibration

            cal = load_calibration(path)
            joint_q = {str(k): float(v) for k, v in cal.calibrated_joint_q.items()}
        # Optional per-robot bundled scaler (``robot.yaml`` → ``scaler_config``)
        # also counts as ready; otherwise calibration is required.
        return {
            "calibrated": path is not None or bundled is not None,
            "bundled": bundled is not None,
            "path": str(path) if path else None,
            "joint_q": joint_q,
        }

    @app.post("/api/robot/fk_preview")
    async def robot_fk_preview(body: dict) -> dict:
        """Apply a calibration joint_q on the server and return link transforms."""
        import numpy as np

        from hhtools.web.analysis.calibration_session import joint_world_payload

        robot = body.get("robot")
        model = state.robots.get(robot)
        if model is None:
            raise HTTPException(status_code=404, detail="robot not loaded")
        joint_q = {str(k): float(v) for k, v in (body.get("joint_q") or {}).items()}
        try:
            model.apply_configuration(joint_q)
        except Exception as err:  # noqa: BLE001
            raise HTTPException(status_code=400, detail=str(err)) from err
        from hhtools.web.analysis.calibration_session import _robot_ground_offset_z

        ground_z = _robot_ground_offset_z(model)
        links = [link.name for link in model.links]
        link_T: dict[str, list[float]] = {}
        for link in links:
            try:
                T = model.urdf.get_transform(link)
                link_T[link] = np.asarray(T, dtype=np.float32).flatten().tolist()
            except Exception:
                link_T[link] = np.eye(4, dtype=np.float32).flatten().tolist()
        return {
            "links": links,
            "link_transforms": link_T,
            "joint_world": joint_world_payload(model),
            "ground_offset_z": round(ground_z, 5),
        }

    @app.post("/api/calibration/save")
    async def calibration_save(body: dict) -> dict:
        from hhtools.retarget.calibration import (
            RobotRetargetCalibration,
            derive_calibration_params,
            save_calibration_for_preset,
        )
        from hhtools.robot.registry import get as get_preset

        robot = body["robot"]
        reference = body["reference"]
        joint_q = {str(k): float(v) for k, v in body.get("joint_q", {}).items()}
        token = body.get("motion_token")
        model = state.robots.get(robot)
        motion = None
        if token:
            rec = state.motions.get(token)
            if rec is not None:
                motion = rec["motion"]
        try:
            preset = get_preset(robot)
            if model is None:
                from hhtools.robot.loader import load_robot

                model = load_robot(preset, compile_mjcf=False)
                state.robots[robot] = model
            cal = RobotRetargetCalibration(
                robot=robot,
                reference=reference,
                calibrated_joint_q=joint_q,
                notes="saved from web UI",
            )
            derived = derive_calibration_params(
                cal,
                model,
                reference_motion=motion,
            )
            path = save_calibration_for_preset(cal, preset, derived=derived)
            # Do not sync derived.scales into robot.yaml joint_scale_multipliers:
            # that global table is shared across references and would pollute
            # the next dataset's retarget (see active_joint_scale_overrides).
        except Exception as err:  # noqa: BLE001
            raise HTTPException(status_code=400, detail=f"calibration save failed: {err}") from err
        return {"ok": True, "path": str(path)}

    @app.post("/api/calibration/session")
    async def calibration_session(body: dict) -> dict:
        """Enter calibration mode: reference T-pose, joint limits, saved joint_q."""
        from hhtools.web.analysis.calibration_session import build_calibration_session

        robot = body.get("robot")
        reference = body.get("reference")
        token = body.get("motion_token")
        model = state.robots.get(robot)
        if model is None:
            raise HTTPException(status_code=404, detail="robot not loaded")
        motion = None
        if token:
            rec = state.motions.get(token)
            if rec is not None:
                motion = rec["motion"]
        try:
            return build_calibration_session(
                model,
                reference=str(reference),
                motion=motion,
            )
        except ValueError as err:
            raise HTTPException(status_code=400, detail=str(err)) from err
        except Exception as err:  # noqa: BLE001
            _log.exception("calibration session failed")
            raise HTTPException(status_code=500, detail=str(err)) from err

    # ----------------------------------------------------------------- retarget

    def _run_retarget_job(job: Job, body: dict) -> None:
        try:
            job.progress = 0.01
            job.message = "正在准备 retarget…"
            robot = body["robot"]
            token = body["motion_token"]
            reference = body.get("reference", "smpl")
            backend = body.get("backend", "newton")
            ik_iters = int(body.get("ik_iterations", 24))
            foot_clamp_anti_penetration = bool(body.get("foot_clamp_anti_penetration", False))
            from hhtools.robot.registry import get as _get_preset

            human_height = _request_human_height(body, _get_preset(robot), reference)
            limit_frames = body.get("limit_frames")
            retarget_fps = _parse_optional_fps(body.get("retarget_fps"))

            rec = state.motions.get(token)
            if rec is None:
                raise ValueError("motion token expired; reload the clip")
            source_entry = rec.get("library_entry")
            job.request = _snapshot_job_request(
                {
                    **job.request,
                    "source_path": rec.get("source_path"),
                    "source_entry": source_entry,
                    "robot": robot,
                    "reference": reference,
                    "backend": backend,
                    "ik_iterations": ik_iters,
                    "human_height": human_height,
                    "limit_frames": limit_frames,
                    "retarget_fps": retarget_fps,
                }
            )
            motion_src = rec["motion"]
            motion_source_fps = float(motion_src.framerate)
            motion, motion_retarget_fps = _motion_for_retarget(motion_src, retarget_fps)
            model = state.robots[robot]
            ret = _retarget_single(
                model,
                robot,
                motion,
                reference,
                backend,
                ik_iters,
                human_height,
                limit_frames,
                job,
                state=state,
                foot_clamp_anti_penetration=foot_clamp_anti_penetration,
            )
            from hhtools.web.output.serialize import serialize_robot_trajectory

            scaled = _compute_scaled_preview(
                model,
                robot,
                motion,
                reference,
                human_height,
            )
            traj = serialize_robot_trajectory(
                model,
                ret,
                scaled_preview=scaled,
            )
            scaled = _align_scaled_preview_to_robot_playback(
                model,
                ret,
                scaled,
                traj,
            )
            from hhtools.web.analysis.result_diagnostics import build_result_diagnostics

            diagnostics = build_result_diagnostics(
                traj,
                scaled,
                ik_map=model.preset.ik_map,
                feet=model.preset.feet,
            )
            scaled_scene = _compute_scaled_scene(
                model,
                robot,
                motion,
                reference,
                human_height,
            )
            from hhtools.web.output.serialize import _scaled_overlay_foot_z

            # Keep the retarget result + source motion in memory so the export
            # endpoint can render CSV or PKL at any target fps on demand.
            export_token = uuid.uuid4().hex[:10]
            state.motions[f"export::{export_token}"] = {
                "retargeted": ret,
                "robot": robot,
                "source_motion": motion,
                "backend": backend,
                "stem": motion.name or token,
                "has_scene": bool(motion.terrain is not None or motion.objects),
                "source_path": rec.get("source_path"),
                # Same yellow-foot Z the viewer used so CSV/PKL bake matches playback.
                "yellow_foot_z": _scaled_overlay_foot_z(scaled, 0),
            }
            job.result = {
                "trajectory": traj,
                "scaled_preview": scaled,
                "scaled_scene": scaled_scene,
                "diagnostics": diagnostics,
                "export_token": export_token,
                "stem": motion.name or token,
                "motion_source_fps": motion_source_fps,
                "retarget_fps": float(motion_retarget_fps),
                "source_fps": float(ret.sample_rate),
                "has_scene": bool(motion.terrain is not None or motion.objects),
                "num_frames": ret.num_frames,
            }
            job.progress = 1.0
            job.message = "done"
            job.mark_terminal("done")
        except Exception as err:  # noqa: BLE001
            _log.exception("retarget job failed")
            job.error = str(err)
            job.mark_terminal("error")

    @app.post("/api/retarget")
    async def retarget(body: dict) -> dict:
        job = _schedule_job("retarget", body, _run_retarget_job, args=(body,))
        return {"job_id": job.id}

    @app.post("/api/scaled_preview")
    async def scaled_preview(body: dict) -> dict:
        """Scaled effector skeleton (robot calibration applied, before IK)."""
        robot = body.get("robot")
        token = body.get("motion_token")
        reference = body.get("reference", "smpl")
        rec = state.motions.get(token)
        if rec is None:
            raise HTTPException(status_code=404, detail="motion token expired; reload the clip")
        model = state.robots.get(robot)
        if model is None:
            raise HTTPException(status_code=404, detail="robot not loaded")
        human_height = _request_human_height(body, model.preset, reference)
        try:
            motion = rec["motion"]
            preview = _compute_scaled_preview(
                model,
                robot,
                motion,
                reference,
                human_height,
            )
            scaled_scene = _compute_scaled_scene(
                model,
                robot,
                motion,
                reference,
                human_height,
            )
            return {"preview": preview, "scaled_scene": scaled_scene}
        except ValueError as err:
            raise HTTPException(status_code=400, detail=str(err)) from err
        except Exception as err:  # noqa: BLE001
            _log.exception("scaled preview failed")
            raise HTTPException(status_code=500, detail=str(err)) from err

    return H2RRouteOperations(run_retarget_job=_run_retarget_job)
