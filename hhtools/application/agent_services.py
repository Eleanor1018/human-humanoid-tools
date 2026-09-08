"""Agent service assembly for the shared local application runtime."""

from __future__ import annotations

import hashlib
import logging
import shutil
import tempfile
import threading
from collections.abc import Callable
from pathlib import Path, PurePosixPath
from types import SimpleNamespace
from typing import Any

from hhtools.application.export import _write_export
from hhtools.application.motions import (
    _ground_motion_for_web,
    _load_motion_file,
    _motion_for_retarget,
)
from hhtools.application.previews import (
    _align_scaled_preview_to_robot_playback,
    _compute_scaled_preview,
    _compute_scaled_scene,
)
from hhtools.application.retarget import _retarget_single

_log = logging.getLogger(__name__)


def assemble_agent_services(
    *,
    state,
    scheduler,
    motion_library_root_provider,
    workspace_robot_root: Path,
    agent_mcp_available: bool,
    agent_rest_available: bool,
    agent_json_cli_available: bool,
) -> SimpleNamespace:
    services = SimpleNamespace()

    # Agent-facing REST is a thin, versioned adapter over transport-neutral
    # services.  Capability discovery receives only the scheduler's read-only
    # snapshot function: it cannot reserve a queue slot or touch solver state.
    from hhtools.agent.h2r_job_executor import (
        H2RExecutorBindings,
        H2RJobExecutor,
        H2RPreview,
        ResolvedMotion,
    )
    from hhtools.contracts import (
        ApiError,
        AssetCategory,
        AssetFileRole,
        AssetInspectionRequest,
        AssetKind,
        ErrorStage,
        InspectionStatus,
        JobSpecV2,
        NextAction,
    )
    from hhtools.services import (
        MAX_AVAILABLE_ASSET_CANDIDATES,
        AgentAssetService,
        ArtifactExportService,
        ArtifactStore,
        AssetRegistry,
        AssetServiceError,
        AvailableAssetCandidate,
        AvailableAssetCatalogLimitError,
        AvailableAssetCatalogService,
        AvailableAssetProvider,
        CapabilitiesService,
        DynamicRootLocator,
        JobManager,
        JobStore,
        LegacyJobUpgradeService,
        PlanStore,
        PreflightService,
        RetargetService,
        RetargetServiceError,
        classify_catalog_robot_trajectory,
        is_catalog_motion_sidecar,
        iter_bounded_catalog_files,
        require_bounded_catalog_root,
    )

    agent_motion_roots: dict[str, Path | Callable[[], Path]] = {
        "motion-library": motion_library_root_provider,
        "source": state.source_root,
    }
    agent_robot_roots: dict[str, Path | Callable[[], Path]] = {
        "robot-library": state.robot_root,
    }
    if workspace_robot_root.is_dir() and any(
        not child.name.startswith(("_", ".")) and not child.is_symlink() and child.is_dir()
        for child in workspace_robot_root.iterdir()
    ):
        agent_robot_roots["workspace-robots"] = workspace_robot_root
    services.agent_legacy_root_locator = DynamicRootLocator(
        motion_roots=agent_motion_roots,
        robot_roots=agent_robot_roots,
    )
    agent_data_dir = state.save_dir / ".hhtools-agent"
    agent_asset_registry = AssetRegistry(
        agent_data_dir,
        services.agent_legacy_root_locator.registry_root_providers(),
    )
    services.agent_asset_service = AgentAssetService(agent_asset_registry)

    def _resolved_catalog_root(provider: Path | Callable[[], Path]) -> Path:
        value = provider() if callable(provider) else provider
        root = Path(value).resolve(strict=True)
        if not root.is_dir():
            raise NotADirectoryError("configured catalog root is not a directory")
        return root

    def _motion_catalog_provider(
        provider: Path | Callable[[], Path],
    ) -> AvailableAssetProvider:
        def available() -> list[AvailableAssetCandidate]:
            from hhtools.services.asset_inspection import (
                SUPPORTED_MOTION_PRIMARY_EXTENSIONS,
                MotionAssetDiscoveryError,
                discover_primary,
            )

            root = _resolved_catalog_root(provider)
            candidates: list[AvailableAssetCandidate] = []
            for path in iter_bounded_catalog_files(
                root,
                extensions=SUPPORTED_MOTION_PRIMARY_EXTENSIONS,
            ):
                relative = path.relative_to(root)
                if is_catalog_motion_sidecar(path):
                    continue
                robot_trajectory = classify_catalog_robot_trajectory(
                    path,
                    relative_path=PurePosixPath(relative.as_posix()),
                )
                if robot_trajectory is not False:
                    continue
                try:
                    discovered = discover_primary(path)
                except (MotionAssetDiscoveryError, OSError, TypeError, ValueError):
                    continue
                folder = relative.parent.name if relative.parent != Path(".") else ""
                stem = path.stem
                display_name = f"{folder} · {stem}" if folder else stem
                required_paths = tuple(
                    required_path
                    for paths in discovered.sidecars.values()
                    for required_path in paths
                )
                candidates.append(
                    AvailableAssetCandidate(
                        path=path,
                        display_name=display_name,
                        kind=AssetKind.MOTION_BUNDLE,
                        category=discovered.category,
                        dataset=discovered.dataset,
                        reference=discovered.reference,
                        required_paths=required_paths,
                    )
                )
                if len(candidates) > MAX_AVAILABLE_ASSET_CANDIDATES:
                    raise AvailableAssetCatalogLimitError
            return candidates

        return available

    def _robot_catalog_provider(
        provider: Path | Callable[[], Path],
    ) -> AvailableAssetProvider:
        def available() -> list[AvailableAssetCandidate]:
            from hhtools.robot.registry import list_presets_in_root_readonly
            from hhtools.services.robot_asset_inspection import (
                RobotAssetDiscoveryError,
                discover_robot_bundle,
            )

            root = _resolved_catalog_root(provider)
            require_bounded_catalog_root(root)
            candidates: list[AvailableAssetCandidate] = []
            for preset in list_presets_in_root_readonly(root):
                try:
                    preset_root = preset.root_dir.resolve(strict=True)
                    preset_root.relative_to(root)
                    # Use the same discovery boundary as registration so every
                    # advertised directory is a complete, unambiguous bundle.
                    discovery = discover_robot_bundle(preset_root)
                except (OSError, RobotAssetDiscoveryError, RuntimeError, ValueError):
                    continue
                candidates.append(
                    AvailableAssetCandidate(
                        path=preset_root,
                        display_name=preset.display_name or preset.name,
                        kind=AssetKind.ROBOT_BUNDLE,
                        category=AssetCategory.ROBOT_MODEL,
                        required_paths=tuple(item.path for item in discovery.files),
                    )
                )
                if len(candidates) > MAX_AVAILABLE_ASSET_CANDIDATES:
                    raise AvailableAssetCatalogLimitError
            return candidates

        return available

    catalog_providers: dict[str, AvailableAssetProvider] = {
        root_id: _motion_catalog_provider(provider)
        for root_id, provider in agent_motion_roots.items()
    }
    catalog_providers.update(
        {
            root_id: _robot_catalog_provider(provider)
            for root_id, provider in agent_robot_roots.items()
        }
    )
    services.agent_available_asset_catalog_service = AvailableAssetCatalogService(
        agent_asset_registry,
        catalog_providers,
        preferred_root_ids=(
            "motion-library",
            "robot-library",
            "source",
            "workspace-robots",
        ),
    )
    services.agent_plan_store = PlanStore(agent_data_dir)
    services.agent_retarget_service = RetargetService(
        services.agent_plan_store,
        services.agent_asset_service,
    )
    services.agent_artifact_store = ArtifactStore(agent_data_dir)
    services.agent_job_store = JobStore(agent_data_dir)

    # The production Agent executor is intentionally a set of thin bindings to
    # the existing H2R Web path.  These closures perform no IK/calibration math;
    # they keep the old loader, solver, preview, diagnostics, and exporter as
    # the single implementation while JobManager owns lifecycle semantics.
    agent_robot_load_lock = threading.Lock()
    agent_preview_max_frames = 600

    def _agent_validate_spec(spec: JobSpecV2) -> None:
        current = services.agent_retarget_service.get_job_spec(spec.plan_id)
        if current.model_dump(mode="json") == spec.model_dump(mode="json"):
            return
        raise RetargetServiceError(
            ApiError(
                code="PLAN_STALE",
                message="The persisted JobSpec no longer matches the immutable plan.",
                stage=ErrorStage.PREFLIGHT,
                details={"plan_id": spec.plan_id},
                next_action=NextAction(
                    actor="agent",
                    action="run_preflight",
                    message="Run retarget preflight again before retrying the job.",
                    parameters={"plan_id": spec.plan_id},
                ),
            )
        )

    def _agent_resolve_motion(asset_id: str) -> ResolvedMotion:
        bundle = services.agent_asset_service.get(asset_id)
        dataset = bundle.detected.dataset if bundle.detected is not None else None
        if not isinstance(dataset, str) or not dataset:
            raise ValueError("the verified motion bundle has no dataset routing identity")
        return ResolvedMotion(
            asset_id=bundle.asset_id,
            category=bundle.category,
            dataset=dataset,
            source_path=services.agent_asset_service.resolve_primary(asset_id),
            stem=Path(bundle.primary_file).stem,
        )

    def _agent_load_motion(resolved: ResolvedMotion) -> Any:
        from hhtools.services.upload_resolve import (
            _load_intermimic,
            _load_meshmimic,
            _load_via_dataset_adapter,
        )

        path = resolved.source_path
        dataset = resolved.dataset
        suffix = path.suffix.casefold()
        if dataset in {"omomo", "omnicontact"}:
            motion, loaded_dataset = _load_intermimic(path)
        elif dataset == "parc_ms":
            motion, loaded_dataset = _load_meshmimic(
                "npz" if suffix == ".npz" else "pkl",
                path,
            )
        elif dataset in {
            "amass",
            "gvhmr",
            "kungfu_athlete",
            "meshmimic_holosoma",
            "motion_x",
            "phuma",
            "unified_npz",
        } and suffix not in {".bvh", ".csv", ".glb", ".gltf"}:
            motion, loaded_dataset = _load_via_dataset_adapter(path, dataset)
        elif dataset in {
            "amass",
            "glb",
            "lafan",
            "mocap",
            "soma",
            "xsens_mocap",
        }:
            motion = _load_motion_file(path)
            loaded_dataset = dataset
        else:
            raise ValueError("the verified motion dataset has no production loader")
        if loaded_dataset != dataset:
            raise ValueError("the motion loader returned a different dataset identity")
        return motion

    def _agent_get_robot_model(spec: JobSpecV2) -> Any:
        bundle = services.agent_asset_service.get(spec.robot.asset_id)
        inspection = services.agent_asset_service.inspect(
            AssetInspectionRequest(
                asset_id=bundle.asset_id,
                verify_hashes=True,
                parse_content=True,
            )
        )
        if inspection.status is InspectionStatus.INVALID:
            if inspection.errors:
                raise AssetServiceError(inspection.errors[0])
            raise AssetServiceError(
                ApiError(
                    code="ASSET_INSPECTION_FAILED",
                    message="The robot bundle is not safe to materialize.",
                    stage=ErrorStage.ASSET_INSPECTION,
                    details={"asset_id": bundle.asset_id},
                )
            )
        yaml_files = [
            item
            for item in bundle.files
            if item.role is AssetFileRole.METADATA
            and (
                Path(item.relative_path).name == "robot.yaml"
                or (
                    Path(item.relative_path).name.startswith("robot.")
                    and Path(item.relative_path).suffix.casefold() == ".yaml"
                )
            )
        ]
        from hhtools.robot.loader import load_robot
        from hhtools.robot.registry import preset_from_yaml

        # Legacy robot loading intentionally repairs URDF/MuJoCo compatibility
        # files in place.  Agent assets are content-addressed, so materialize
        # the exact manifest into a per-job writable workspace and confine all
        # loader plus Interaction-Mesh fallback writes to that snapshot.
        workspace_parent = agent_data_dir / "temporary" / "robots"
        workspace_parent.mkdir(parents=True, exist_ok=True)
        workspace = tempfile.TemporaryDirectory(
            prefix="agent-robot-",
            dir=workspace_parent,
        )
        workspace_root = Path(workspace.name).resolve(strict=True)
        try:
            bundle_root = (workspace_root / spec.robot.robot_id).resolve()
            bundle_root.relative_to(workspace_root)
            bundle_root.mkdir(parents=True, exist_ok=False)
            for item in bundle.files:
                source = services.agent_asset_service.resolve_file(
                    bundle.asset_id,
                    item.relative_path,
                )
                target = bundle_root.joinpath(*PurePosixPath(item.relative_path).parts).resolve()
                target.relative_to(bundle_root)
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(source, target)
                with target.open("rb") as stream:
                    copied_sha256 = hashlib.file_digest(stream, "sha256").hexdigest()
                if copied_sha256 != item.sha256 or target.stat().st_size != item.size_bytes:
                    raise ValueError("the robot workspace copy does not match its asset manifest")

            matching = []
            for item in yaml_files:
                yaml_path = bundle_root.joinpath(*PurePosixPath(item.relative_path).parts).resolve()
                yaml_path.relative_to(bundle_root)
                preset = preset_from_yaml(yaml_path)
                if preset.name == spec.robot.robot_id:
                    if preset.urdf_path is None:
                        raise ValueError("the robot snapshot has no declared URDF")
                    resolved_urdf = preset.urdf_path.resolve(strict=True)
                    resolved_urdf.relative_to(bundle_root)
                    if not resolved_urdf.is_file():
                        raise ValueError("the robot snapshot URDF is not a file")
                    for search_path in preset.mesh_search_paths:
                        resolved_search = search_path.resolve(strict=True)
                        resolved_search.relative_to(bundle_root)
                        if not resolved_search.is_dir():
                            raise ValueError("a robot mesh search path is not a snapshot directory")
                    metadata_yaml = Path(preset.meta["yaml_path"]).resolve(strict=True)
                    metadata_yaml.relative_to(bundle_root)
                    matching.append(preset)
            if len(matching) != 1:
                raise ValueError("the robot bundle does not contain one exact matching preset")

            # This content identity is consumed only by internal
            # geometry/scaler caches.  It is never serialized and leaves
            # legacy Web presets intact.
            matching[0].meta["_agent_asset_id"] = spec.robot.asset_id
            with agent_robot_load_lock:
                model = load_robot(matching[0], compile_mjcf=True)
            model._agent_asset_workspace = workspace
            return model
        except Exception:
            try:
                workspace.cleanup()
            except OSError:
                _log.warning("failed to clean Agent robot workspace", exc_info=True)
            raise

    def _agent_release_robot_model(model: Any) -> None:
        workspace = getattr(model, "_agent_asset_workspace", None)
        model._agent_asset_workspace = None
        if workspace is not None:
            workspace.cleanup()

    def _agent_run_retarget(
        model: Any,
        robot_id: str,
        motion: Any,
        reference: str,
        backend: str,
        ik_iterations: int,
        human_height: float,
        limit_frames: int | None,
        progress_job: Any,
        *,
        foot_clamp_anti_penetration: bool,
    ) -> Any:
        return _retarget_single(
            model,
            robot_id,
            motion,
            reference,
            backend,
            ik_iterations,
            human_height,
            limit_frames,
            progress_job,
            state=None,
            foot_clamp_anti_penetration=foot_clamp_anti_penetration,
            preset=model.preset,
        )

    def _agent_build_preview(
        model: Any,
        robot_id: str,
        motion: Any,
        reference: str,
        human_height: float,
        retargeted: Any,
    ) -> H2RPreview:
        from hhtools.analysis.result_diagnostics import build_result_diagnostics
        from hhtools.io.scene_serialize import (
            _scaled_overlay_foot_z,
            serialize_robot_trajectory,
        )

        scaled = _compute_scaled_preview(
            model,
            robot_id,
            motion,
            reference,
            human_height,
            max_frames=agent_preview_max_frames,
        )
        trajectory = serialize_robot_trajectory(
            model,
            retargeted,
            scaled_preview=scaled,
            max_frames=agent_preview_max_frames,
        )
        scaled = _align_scaled_preview_to_robot_playback(
            model,
            retargeted,
            scaled,
            trajectory,
        )
        diagnostics = build_result_diagnostics(
            trajectory,
            scaled,
            ik_map=model.preset.ik_map,
            feet=model.preset.feet,
        )
        scaled_scene = _compute_scaled_scene(
            model,
            robot_id,
            motion,
            reference,
            human_height,
            max_frames=agent_preview_max_frames,
        )
        return H2RPreview(
            document={
                "trajectory": trajectory,
                "scaled_preview": scaled,
                "scaled_scene": scaled_scene,
                "diagnostics": diagnostics,
            },
            diagnostics=diagnostics,
            yellow_foot_z=_scaled_overlay_foot_z(scaled, 0),
        )

    def _agent_write_export(
        retargeted: Any,
        model: Any,
        source_motion: Any,
        output_root: Path,
        *,
        stem: str,
        output_format: str,
        backend: str,
        source_path: Path,
        yellow_foot_z: float | None,
    ) -> Path:
        return Path(
            _write_export(
                retargeted,
                model,
                source_motion,
                output_root,
                stem=stem,
                fps=None,
                fmt=output_format,
                backend=backend,
                csv_header=True,
                source_path=source_path,
                yellow_foot_z=yellow_foot_z,
            )
        )

    agent_executor = H2RJobExecutor(
        H2RExecutorBindings(
            validate_spec=_agent_validate_spec,
            resolve_motion=_agent_resolve_motion,
            load_motion=_agent_load_motion,
            ground_motion=_ground_motion_for_web,
            prepare_motion=_motion_for_retarget,
            get_robot_model=_agent_get_robot_model,
            run_retarget=_agent_run_retarget,
            build_preview=_agent_build_preview,
            write_export=_agent_write_export,
            release_robot_model=_agent_release_robot_model,
        ),
        temporary_root=agent_data_dir / "temporary",
    )
    services.agent_job_manager = JobManager(
        services.agent_job_store,
        services.agent_artifact_store,
        services.agent_retarget_service,
        scheduler,
        executor=agent_executor,
    )
    services.agent_artifact_export_service = ArtifactExportService(
        services.agent_job_manager,
        state.save_dir / "agent-exports",
    )
    services.agent_capabilities_service = CapabilitiesService(
        scheduler_snapshot=scheduler.snapshot,
        asset_root_provider=lambda: services.agent_asset_service.allowed_root_ids,
        available_asset_catalog_available=True,
        preflight_available=True,
        artifact_store_available=True,
        job_manager_available=True,
        job_execution_available=services.agent_job_manager.execution_available,
        mcp_available=agent_mcp_available,
        agent_rest_available=agent_rest_available,
        json_cli_available=agent_json_cli_available,
    )
    services.agent_preflight_service = PreflightService(
        services.agent_asset_service,
        services.agent_plan_store,
        capabilities_provider=services.agent_capabilities_service.get_capabilities,
    )
    # Phase 4's REST/JSON-CLI adapters call this exact transport-neutral
    # service instance; they do not reimplement path migration or construct
    # JobSpec v2 directly.
    services.agent_legacy_job_upgrade_service = LegacyJobUpgradeService(
        services.agent_asset_service,
        services.agent_preflight_service,
        services.agent_retarget_service,
        services.agent_legacy_root_locator,
    )
    return services
