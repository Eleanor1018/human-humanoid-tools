"""Shared analysis/video execution over registered assets and durable job callbacks."""

from __future__ import annotations

import hashlib
import json
import math
import os
import shutil
import tempfile
from functools import lru_cache
from pathlib import Path

from hhtools.contracts import ApiError, ErrorStage, JobOutcome
from hhtools.contracts.workflows import WorkflowJobSpec
from hhtools.services.jobs import JobCancelledError, JobExecutionError, JobExecutionResult


@lru_cache(maxsize=64)
def _backend_file_digest(path: str, size: int, modified_ns: int) -> str:
    with Path(path).open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    after = Path(path).stat()
    if (after.st_size, after.st_mtime_ns) != (size, modified_ns):
        raise ValueError("Backend file changed while computing its identity")
    return digest


def workflow_configuration_identity(kind: str) -> str:
    variables = (
        "HHTOOLS_GVHMR_ROOT",
        "HHTOOLS_GVHMR_PYTHON",
        "HHTOOLS_GVHMR_IMAGE",
        "HHTOOLS_BODY_MODELS",
        "HHTOOLS_GVHMR_BODY_MODELS",
        "CUDA_VISIBLE_DEVICES",
    )
    identity = {name: os.environ.get(name) for name in variables}
    if kind == "video_to_motion":
        from hhtools.integrations.gvhmr import _PUBLIC_CHECKPOINTS, GvhmrConfig

        config = GvhmrConfig.from_environment()
        paths = [
            config.root / "inputs/checkpoints" / value for value in _PUBLIC_CHECKPOINTS.values()
        ]
        paths.extend(
            [
                config.body_models_root / "smplx/SMPLX_NEUTRAL.npz",
                config.root / "tools/demo/demo.py",
            ]
        )
        files = {}
        for path in paths:
            if path.is_file():
                stat = path.stat()
                files[str(path)] = _backend_file_digest(str(path), stat.st_size, stat.st_mtime_ns)
        identity["files"] = files
    return hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()


def workflow_availability(workflow: str) -> dict:
    if workflow == "analysis":
        return {"available": True, "backend": "dataset_analysis", "checkpoint_resume": False}
    from hhtools.integrations.gvhmr import GvhmrConfig, gvhmr_status

    config = GvhmrConfig.from_environment()
    readiness = gvhmr_status(config, probe_runtime=False)
    configured = all(readiness["checks"].values())
    return {
        "available": configured,
        "backend": "gvhmr",
        "runtime": config.runtime,
        "reason": None if configured else "GVHMR environment or licensed body models are missing.",
        "checkpoint_resume": False,
        "probe": "configuration_only",
    }


def analysis_configuration(overrides: dict) -> dict:
    from hhtools.analysis.config import load_config

    defaults = load_config()

    def check(values, template):
        for key, value in values.items():
            if key not in template:
                raise ValueError("Unknown analysis configuration field")
            baseline = template[key]
            if isinstance(baseline, dict):
                if not isinstance(value, dict):
                    raise ValueError("Invalid analysis configuration object")
                check(value, baseline)
            elif isinstance(value, (int, float)) and (not math.isfinite(value) or value < 0):
                raise ValueError("Analysis configuration numbers must be finite and nonnegative")
            elif not isinstance(value, type(baseline)):
                raise ValueError("Analysis configuration type mismatch")

    check(overrides, defaults)
    return load_config(overrides)


def _finite_document(value):
    if isinstance(value, dict):
        return {key: _finite_document(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_finite_document(item) for item in value]
    if isinstance(value, float) and not math.isfinite(value):
        return None
    return value


class ResourceWorkflowExecutor:
    def __init__(self, assets, plans, fallback, temporary_root: Path, *, paths=None, services=None):
        self.assets = assets
        self.plans = plans
        self.fallback = fallback
        self.temporary_root = Path(temporary_root)
        self.paths = paths
        self.services = services

    def _snapshot(self, spec, root: Path):
        snapshots = []
        for item in spec.inputs:
            bundle = self.assets.get(item.asset_id)
            destination = root / item.sha256
            for member in bundle.files:
                source = self.assets.resolve_file(
                    item.asset_id, member.relative_path, verify_hash=True
                )
                target = destination / member.relative_path
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(source, target)
                with target.open("rb") as stream:
                    if hashlib.file_digest(stream, "sha256").hexdigest() != member.sha256:
                        raise JobExecutionError(
                            ApiError(
                                code="ASSET_HASH_MISMATCH",
                                message="Input changed while preparing the worker.",
                                stage=ErrorStage.ASSET_REGISTRATION,
                            )
                        )
            snapshots.append((bundle, destination))
        return snapshots

    def __call__(self, spec, context):
        if not isinstance(spec, WorkflowJobSpec):
            return self.fallback(spec, context)
        self.plans.get_job_spec(spec.plan_id)
        context.raise_if_cancelled()
        self.temporary_root.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="workflow-", dir=self.temporary_root) as name:
            root = Path(name)
            if spec.kind == "preview_render":
                return self._render(spec, context, root)
            if spec.kind == "retarget_export":
                from hhtools.application.retarget_exports import export_retarget_state

                return export_retarget_state(self.services, spec.effective_parameters, context, root)
            snapshots = self._snapshot(spec, root / "inputs")
            if spec.kind == "analysis_export":
                return self._analysis_export(spec, context, snapshots, root)
            if spec.kind == "analysis":
                return self._analysis(spec, context, snapshots)
            return self._video(spec, context, snapshots, root)

    def _analysis_export(self, spec, context, snapshots, root):
        from hhtools.application.analysis_reports import AnalysisReports
        from hhtools.contracts.workflows import AnalysisExportParameters

        parameters = AnalysisExportParameters.model_validate(spec.effective_parameters)
        reports = AnalysisReports(self.services.resource_reports)
        selected = reports.selected(parameters)
        if parameters.format == "csv":
            context.publish_bytes(
                kind="dataset_manifest",
                payload=reports.csv(selected),
                format="csv",
                media_type="text/csv",
            )
        elif parameters.format == "robot_zip":
            from hhtools.analysis.dataset_analysis import export_robot_clips_zip

            roots = {bundle.asset_id: directory for bundle, directory in snapshots}
            rows = [
                {**clip, "source_path": str(roots[clip["asset_id"]] / clip["relative_path"])}
                for clip in selected
            ]
            path, _ = export_robot_clips_zip(
                rows, [clip["clip_id"] for clip in rows], root, allowed_roots=list(roots.values())
            )
            context.publish_file(
                kind="dataset_bundle", source=path, format="zip", media_type="application/zip"
            )
        else:
            context.publish_json(
                kind="dataset_manifest",
                document={
                    "schema_version": "1.0",
                    "source_job_id": parameters.job_id,
                    "source_artifact_id": parameters.artifact_id,
                    "source_sha256": parameters.artifact_sha256,
                    "selection": parameters.model_dump(mode="json"),
                    "clips": selected,
                },
            )
        return JobExecutionResult(
            outcome=JobOutcome.SUCCESS,
            summary={"selected_clips": len(selected)},
            execution_provenance={"executor": "resource_workflow", "backend": "analysis_export"},
        )

    def _render(self, spec, context, root):
        from PIL import Image

        from hhtools.application.preview_renderer import PreviewRenderer
        from hhtools.application.preview_scene import PreviewScene
        from hhtools.contracts.previews import PreviewRenderParameters

        parameters = PreviewRenderParameters.model_validate(spec.effective_parameters)
        scene = PreviewScene(self.paths, self.services, parameters.source)
        renderer = None
        frames = 1
        try:
            renderer = PreviewRenderer(scene, parameters.width, parameters.height)
            if parameters.start_frame >= scene.frame_count:
                raise ValueError("Start frame is outside the preview timeline")
            output = root / ("preview." + parameters.format)
            if parameters.format == "png":
                Image.fromarray(renderer.render(frame=parameters.start_frame)).save(output)
            else:
                import av

                frame_rate = (
                    (scene.frame_count - 1) / scene.duration
                    if scene.duration > 0
                    else parameters.fps
                )
                frames = max(
                    1,
                    min(
                        parameters.frames,
                        math.ceil(
                            (scene.frame_count - parameters.start_frame)
                            / max(frame_rate, 1)
                            * parameters.fps
                        ),
                    ),
                )
                with av.open(str(output), "w") as container:
                    stream = container.add_stream("libx264", rate=parameters.fps)
                    stream.width, stream.height = parameters.width, parameters.height
                    stream.pix_fmt = "yuv420p"
                    for index in range(frames):
                        context.raise_if_cancelled()
                        frame = parameters.start_frame + round(index * frame_rate / parameters.fps)
                        image = av.VideoFrame.from_ndarray(
                            renderer.render(frame=frame), format="rgb24"
                        )
                        for packet in stream.encode(image):
                            container.mux(packet)
                        context.report_progress(
                            phase="rendering", fraction=(index + 1) / frames * 0.95
                        )
                    for packet in stream.encode():
                        container.mux(packet)
            context.publish_file(
                kind="preview_image" if parameters.format == "png" else "preview_video",
                source=output,
                format=parameters.format,
                media_type="image/png" if parameters.format == "png" else "video/mp4",
                metadata={
                    "source": parameters.source.model_dump(mode="json"),
                    "width": parameters.width,
                    "height": parameters.height,
                    "frames": frames,
                    "start_frame": parameters.start_frame,
                    "fps": parameters.fps,
                    "evidence_level": "kinematic_playback",
                },
            )
            return JobExecutionResult(
                outcome=JobOutcome.SUCCESS,
                summary={"frames": frames},
                evaluation_summary="Kinematic preview; this is not a physics evaluation.",
                execution_provenance={"executor": "preview_renderer", "backend": "mujoco"},
            )
        finally:
            if renderer is not None:
                renderer.close()
            scene.close()

    def _analysis(self, spec, context, snapshots):
        from hhtools.analysis.collection import analyze_entries, build_summary
        from hhtools.services.dataset_catalog import build_analysis_entries

        entries = []
        sources = {}
        for bundle, root in snapshots:
            for entry in build_analysis_entries(root):
                relative = Path(entry["source_path"]).relative_to(root).as_posix()
                clip_id = f"{bundle.asset_id}:{relative}"
                entry["clip_id"] = clip_id
                sources[clip_id] = {"asset_id": bundle.asset_id, "relative_path": relative}
                entries.append(entry)
        if not entries:
            raise JobExecutionError(
                ApiError(
                    code="EMPTY_DATASET",
                    message="No supported motion clips were found.",
                    stage=ErrorStage.EXECUTION,
                )
            )

        def progress(fraction, _message):
            context.raise_if_cancelled()
            context.report_progress(
                phase="analyzing",
                fraction=min(fraction, 0.95),
                message="Computing motion metrics and dataset summary.",
            )

        cfg = spec.effective_parameters["metric_config"]
        clips = analyze_entries(
            entries,
            cfg=cfg,
            embedding_name=spec.effective_parameters["embedding"],
            workers=1,
            progress=progress,
        )
        records = []
        failures = 0
        for clip in clips:
            record = clip.to_dict()
            record.update(sources[clip.clip_id])
            record["source_path"] = record["relative_path"]
            if record.get("error"):
                failures += 1
                record["error"] = "ANALYSIS_FAILED"
            records.append(record)
        report = _finite_document(
            {
                "schema_version": "1.0",
                "job_id": context.job_id,
                "plan_id": spec.plan_id,
                "evaluator": "hhtools.analysis.v1",
                "parameters": spec.effective_parameters,
                "clips": records,
                "summary": build_summary(clips, cfg),
            }
        )
        context.publish_json(kind="analysis_report", document=report)
        outcome = JobOutcome.SUCCESS if failures == 0 else JobOutcome.PARTIAL
        if failures == len(clips):
            outcome = JobOutcome.REJECTED
        return JobExecutionResult(
            outcome=outcome,
            summary={"clip_count": len(clips), "failed_clips": failures},
            evaluation_summary="Motion metrics completed; review per-clip quality and failures.",
            evaluation_metrics={"clip_count": len(clips), "failed_clips": failures},
            execution_provenance={"executor": "resource_workflow", "backend": "dataset_analysis"},
        )

    def _video(self, spec, context, snapshots, root):
        from hhtools.application.motions import _load_motion_file, _load_via_adapter
        from hhtools.integrations.gvhmr import GvhmrConfig, run_gvhmr
        from hhtools.io.npz import save_npz
        from hhtools.services.upload_resolve import load_clip_at_path

        config = GvhmrConfig.from_environment()
        os.environ.setdefault("HHTOOLS_BODY_MODELS", str(config.body_models_root))
        for index, (bundle, source_root) in enumerate(snapshots):
            context.raise_if_cancelled()

            def progress(fraction, _message, item_index=index):
                context.raise_if_cancelled()
                context.report_progress(
                    phase="video_inference",
                    fraction=(item_index + fraction * 0.8) / len(snapshots),
                    message="Running the configured GVHMR backend.",
                )

            work = root / f"video-{index}"
            work.mkdir()
            video = work / Path(bundle.primary_file).name
            shutil.copyfile(source_root / bundle.primary_file, video)
            try:
                result = run_gvhmr(
                    video,
                    work,
                    config=config,
                    static_cam=spec.effective_parameters["static_camera"],
                    f_mm=spec.effective_parameters["focal_length_mm"],
                    progress=progress,
                    cancelled=lambda: context.cancellation_requested,
                )
            except InterruptedError as error:
                raise JobCancelledError() from error
            motion, _dataset = load_clip_at_path(
                result,
                "mimic",
                load_motion_file=_load_motion_file,
                load_via_adapter=_load_via_adapter,
            )
            output = work / "motion.npz"
            from hhtools.contracts.portability import validate_portable_json

            portable_metadata = {}
            for key, value in motion.meta.items():
                try:
                    validate_portable_json({key: value})
                except ValueError:
                    continue
                portable_metadata[key] = value
            motion.meta = portable_metadata
            save_npz(motion, output)
            context.publish_file(
                kind="motion",
                source=output,
                format="npz",
                media_type="application/octet-stream",
                metadata={"source_asset_id": bundle.asset_id},
            )
        return JobExecutionResult(
            outcome=JobOutcome.REVIEW_REQUIRED,
            summary={"video_count": len(snapshots)},
            evaluation_summary=(
                "GVHMR inference completed. Inspect estimated motion before retargeting."
            ),
            execution_provenance={"executor": "resource_workflow", "backend": "gvhmr"},
        )
