"""Export an immutable solved trajectory without running IK a second time."""

from __future__ import annotations

from pathlib import Path

from hhtools.contracts import JobOutcome
from hhtools.contracts.workflows import RetargetExportParameters
from hhtools.services.jobs import JobExecutionResult
from hhtools.services.runtime_control import RuntimeServiceError


def export_retarget_state(services, parameters, context, output_root):
    from hhtools.application.export import _write_export, _write_r2r_export
    from hhtools.application.motions import _ground_motion_for_web, _motion_for_retarget
    from hhtools.application.retarget_state import load_retarget_state

    parameters = RetargetExportParameters.model_validate(parameters)
    stored = services.resource_reports.artifact(parameters.job_id, parameters.artifact_id)
    if stored.descriptor.kind != "retarget_state":
        raise RuntimeServiceError("ARTIFACT_KIND_MISMATCH", "Select a full retarget state.")
    source_spec = services.resource_reports.jobs.get_spec(parameters.job_id)
    if source_spec.kind not in {"retarget", "r2r_retarget"}:
        raise RuntimeServiceError("EXPORT_UNSUPPORTED", "Select a single retarget job.")
    retargeted, yellow_foot_z, saved = load_retarget_state(stored.path)
    target = source = None
    options = {
        "stem": retargeted.name,
        "fps": parameters.fps,
        "fmt": parameters.format,
        "csv_header": parameters.csv_header,
        "t_start": parameters.t_start,
        "t_end": parameters.t_end,
        "yellow_foot_z": yellow_foot_z,
    }
    try:
        target = services.materialize_robot(source_spec.robot, compile_mjcf=True)
        context.raise_if_cancelled()
        if source_spec.source_robot:
            source = services.materialize_robot(source_spec.source_robot, compile_mjcf=False)
            resolved = services.resolve_r2r_trajectory(source_spec.inputs[0].asset_id)
            prepared = services.prepare_r2r_source(
                resolved,
                source,
                source_fps=source_spec.effective_parameters.get("source_fps"),
                limit_frames=source_spec.effective_parameters.get("limit_frames"),
                progress_callback=lambda *_: context.raise_if_cancelled(),
            )
            motion, _ = _motion_for_retarget(
                prepared.motion, source_spec.effective_parameters.get("retarget_fps")
            )
            exported = _write_r2r_export(
                retargeted,
                target,
                motion,
                output_root,
                source_model=source,
                calibrated_joint_q=saved["calibration_joint_q"],
                entry={
                    "source_path": str(resolved.source_path),
                    "upload_profile": "mimic",
                    "has_scene": False,
                },
                **options,
            )
        else:
            motion = services.load_motion_asset(source_spec.inputs[0].asset_id)
            motion = _ground_motion_for_web(motion)
            motion, _ = _motion_for_retarget(
                motion, source_spec.effective_parameters.get("retarget_fps")
            )
            if parameters.format == "pkl" and getattr(motion, "objects", None):
                raise RuntimeServiceError(
                    "UNSUPPORTED_PORTABLE_EXPORT", "Use CSV bundles for object-interaction motion."
                )
            exported = _write_export(
                retargeted,
                target,
                motion,
                output_root,
                backend=source_spec.backend,
                source_path=services.agent_asset_service.resolve_primary(
                    source_spec.inputs[0].asset_id
                ),
                **options,
            )
        context.raise_if_cancelled()
        exported = Path(exported)
        context.publish_file(
            kind="retargeted_motion",
            source=exported,
            format=exported.suffix.lstrip("."),
            media_type={".csv": "text/csv", ".zip": "application/zip"}.get(
                exported.suffix, "application/octet-stream"
            ),
            metadata={"filename": exported.name, "source_job_id": parameters.job_id},
        )
        return JobExecutionResult(
            outcome=JobOutcome.SUCCESS,
            summary={
                "source_job_id": parameters.job_id,
                "output_format": parameters.format,
                "solver_rerun": False,
            },
            execution_provenance={"executor": "retarget_state_export"},
        )
    finally:
        if source is not None:
            services.release_robot(source)
        if target is not None:
            services.release_robot(target)
