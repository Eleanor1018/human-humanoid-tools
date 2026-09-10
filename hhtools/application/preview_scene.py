"""Build identical resource-bound scene data for client playback and offscreen rendering."""

from __future__ import annotations

import base64
import json
from pathlib import Path
from types import SimpleNamespace

from hhtools.contracts import AssetKind
from hhtools.contracts.previews import PreviewSource
from hhtools.services.artifacts import ArtifactStore
from hhtools.services.job_store import JobStore
from hhtools.services.runtime_control import RuntimeServiceError


class PreviewScene:
    def __init__(self, paths, services, source: PreviewSource):
        from hhtools.io.scene_serialize import (
            object_mesh_glb,
            serialize_motion,
            serialize_robot,
            serialize_robot_trajectory,
        )

        self.services = services
        self.robot_model = None
        self.data = {
            "motion": None,
            "robot": None,
            "robot_trajectory": None,
            "source": source.model_dump(mode="json"),
            "coordinates": {
                "up_axis": "z",
                "length_unit": "metre",
                "angle_unit": "radian",
                "quaternion_order": "xyzw",
                "matrix_order": "row_major",
            },
            "evidence_level": "kinematic_playback",
        }
        assets = services.agent_asset_service
        robot_identity = None
        raw_motion = None
        mesh_asset_id = source.asset_id
        r2r_source = None
        if source.asset_id:
            bundle = assets.get(source.asset_id)
            if bundle.kind is AssetKind.ROBOT_BUNDLE:
                robot_identity = SimpleNamespace(
                    asset_id=bundle.asset_id, robot_id=bundle.metadata["robot_name"]
                )
            elif bundle.kind is AssetKind.ROBOT_TRAJECTORY_BUNDLE:
                r2r_source = services.resolve_r2r_trajectory(bundle.asset_id)
                if source.robot_asset_id:
                    matches = [assets.get(source.robot_asset_id)]
                else:
                    matches = [
                        item
                        for item in assets.search(kind=AssetKind.ROBOT_BUNDLE, limit=500).assets
                        if item.metadata.get("robot_name") == r2r_source.source_robot_id
                    ]
                if (
                    len(matches) != 1
                    or matches[0].metadata.get("robot_name") != r2r_source.source_robot_id
                ):
                    raise RuntimeServiceError(
                        "ROBOT_ASSET_REQUIRED",
                        "Select the exact registered source robot for this trajectory.",
                    )
                robot_identity = SimpleNamespace(
                    asset_id=matches[0].asset_id, robot_id=r2r_source.source_robot_id
                )
                self.data["source"]["robot_asset_id"] = matches[0].asset_id
            elif bundle.kind is AssetKind.MOTION_BUNDLE and source.member is None:
                motion = services.load_motion_asset(bundle.asset_id)
                raw_motion = motion
                self.data["motion"] = serialize_motion(motion, max_frames=600)
            else:
                from hhtools.application.motions import _load_motion_file, _load_via_adapter
                from hhtools.services.upload_resolve import load_clip_at_path

                path = assets.resolve_file(bundle.asset_id, source.member or bundle.primary_file)
                motion, _ = load_clip_at_path(
                    path,
                    "mimic",
                    load_motion_file=_load_motion_file,
                    load_via_adapter=_load_via_adapter,
                )
                raw_motion = motion
                self.data["motion"] = serialize_motion(motion, max_frames=600)
        else:
            data_dir = paths.save_dir / ".hhtools-agent"
            jobs = JobStore(data_dir, read_only=True)
            artifacts = ArtifactStore(data_dir, read_only=True)
            stored_job = jobs.get(source.job_id)
            candidates = [
                item
                for item in stored_job.artifacts
                if (
                    item.artifact_id == source.artifact_id
                    if source.artifact_id
                    else item.kind == "preview"
                )
            ]
            if not candidates:
                raise RuntimeServiceError(
                    "PREVIEW_NOT_FOUND", "No preview artifact matches this job."
                )
            artifact = artifacts.get(candidates[0].artifact_id, verify=True)
            if artifact.descriptor.kind == "preview":
                preview = json.loads(artifact.path.read_text())
                self.data["motion"] = preview.get("scaled_preview")
                environment = preview.get("scaled_scene")
                if environment:
                    self.data["motion"] = {**(self.data["motion"] or {}), **environment}
                    mesh_asset_id = stored_job.spec.inputs[0].asset_id
                    raw_motion = services.load_motion_asset(mesh_asset_id)
                self.data["robot_trajectory"] = preview.get("trajectory") or preview.get(
                    "target_trajectory"
                )
                robot_identity = stored_job.spec.robot
            elif artifact.descriptor.kind == "motion":
                from hhtools.io.npz import load_npz

                self.data["motion"] = serialize_motion(load_npz(artifact.path), max_frames=600)
            else:
                raise RuntimeServiceError(
                    "PREVIEW_UNSUPPORTED", "This artifact has no motion preview."
                )
        if robot_identity is not None:
            self.robot_model = services.materialize_robot(robot_identity, compile_mjcf=True)
            self.data["robot"] = serialize_robot(
                self.robot_model, name=self.robot_model.preset.name
            )
            if r2r_source is not None:
                prepared = services.prepare_r2r_source(
                    r2r_source,
                    self.robot_model,
                    source_fps=None,
                    limit_frames=None,
                    progress_callback=lambda *_: None,
                )
                self.data["robot_trajectory"] = serialize_robot_trajectory(
                    self.robot_model, prepared.playback, max_frames=600, ground_follow=False
                )
        motion = self.data["motion"]
        if raw_motion is not None and motion and motion.get("objects"):
            allowed_meshes = set()
            if mesh_asset_id:
                mesh_bundle = assets.get(mesh_asset_id)
                allowed_meshes = {
                    assets.resolve_file(mesh_asset_id, item.relative_path).resolve()
                    for item in mesh_bundle.files
                }
            for index, item in enumerate(motion["objects"]):
                original = raw_motion.objects[item.get("source_index", index)]
                if original.mesh_path and Path(original.mesh_path).resolve() not in allowed_meshes:
                    raise RuntimeServiceError(
                        "SCENE_MESH_OUTSIDE_BUNDLE",
                        "A scene mesh is not part of its registered bundle.",
                    )
                glb = object_mesh_glb(original, scale=item.get("scale"))
                item["glb_base64"] = base64.b64encode(glb).decode() if glb else None
                item["geometry_detail"] = "mesh" if glb else "bounds"
        if motion:
            motion.pop("token", None)
            motion.pop("meta", None)
        timeline = self.data["robot_trajectory"] or motion or {}
        self.frame_count = len(timeline.get("frames") or timeline.get("positions") or [None])
        self.duration = float(timeline.get("playback_duration") or timeline.get("duration") or 0)
        self.data["frame_count"] = self.frame_count
        self.data["duration_seconds"] = self.duration

    def close(self):
        if self.robot_model is not None:
            self.services.release_robot(self.robot_model)
