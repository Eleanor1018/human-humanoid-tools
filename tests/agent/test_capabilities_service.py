from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

from hhtools.contracts import DeviceCapability, SchedulerMode
from hhtools.robot import registry as robot_registry
from hhtools.robot.base import RobotPreset
from hhtools.services import capabilities as capabilities_module
from hhtools.services.capabilities import CapabilitiesService


def _cpu_devices() -> list[DeviceCapability]:
    return [
        DeviceCapability(
            device_id="cpu",
            kind="cpu",
            display_name="Test CPU",
            available=True,
        )
    ]


def _cuda_devices() -> list[DeviceCapability]:
    return [
        *_cpu_devices(),
        DeviceCapability(
            device_id="cuda:0",
            kind="cuda",
            display_name="NVIDIA Test GPU",
            available=True,
            total_memory_bytes=24 * 1024**3,
            free_memory_bytes=20 * 1024**3,
            compute_capability="8.9",
        ),
    ]


def test_capabilities_report_unlimited_defaults_and_backend_specific_dependencies(
    monkeypatch,
) -> None:
    monkeypatch.setattr(capabilities_module.platform, "system", lambda: "Windows")
    interaction_dependencies = {"mujoco", "osqp", "scipy", "yourdfpy"}
    monkeypatch.setattr(
        capabilities_module,
        "_module_available",
        lambda name: name in interaction_dependencies,
    )
    service = CapabilitiesService(robot_provider=lambda: [], device_probe=_cpu_devices)

    response = service.get_capabilities()

    assert response.scheduler.mode is SchedulerMode.UNLIMITED
    assert response.scheduler.max_running_jobs == 0
    assert response.scheduler.max_queued_jobs == 0
    assert response.supported_output_formats == ["csv", "pkl"]
    assert response.features == {
        "agent_rest": True,
        "asset_inspection": False,
        "asset_registry": False,
        "artifact_store": False,
        "idempotent_jobs": False,
        "job_cancellation": False,
        "job_execution": False,
        "job_retry": False,
        "job_spec_v2": True,
        "json_cli": True,
        "mcp": False,
        "persistent_jobs": False,
        "preflight": False,
        "revision_polling": False,
    }
    backends = {backend.backend_id: backend for backend in response.backends}
    assert backends["interaction_mesh"].available is True
    assert backends["interaction_mesh"].limits["requires_cuda"] is False
    assert backends["newton"].available is False
    assert "newton, warp" in (backends["newton"].unavailable_reason or "")
    assert backends["newton"].features["cpu_fallback"] is True
    assert backends["newton"].features["cuda_graph"] is False


def test_capabilities_normalize_live_scheduler_and_available_gpu_backends(
    monkeypatch,
) -> None:
    snapshot = SimpleNamespace(
        max_running_jobs=2,
        max_queued_jobs=8,
        running_jobs=1,
        queued_jobs=3,
        reserved_jobs=1,
        closed=False,
    )
    monkeypatch.setattr(capabilities_module.platform, "system", lambda: "Linux")
    monkeypatch.setattr(capabilities_module, "_module_available", lambda _name: True)
    monkeypatch.setattr(capabilities_module, "_module_version", lambda _name: "test-version")
    service = CapabilitiesService(
        scheduler_snapshot=lambda: snapshot,
        robot_provider=lambda: [],
        device_probe=_cuda_devices,
        asset_root_provider=lambda: ["source", "motion-library", "source"],
    )

    response = service.get_capabilities()

    assert response.scheduler.mode is SchedulerMode.LIMITED
    assert response.scheduler.running == 1
    assert response.scheduler.queued == 3
    assert response.scheduler.reserved == 1
    assert response.asset_root_ids == ["motion-library", "source"]
    assert response.features["asset_registry"] is True
    assert response.features["asset_inspection"] is True
    assert {backend.backend_id for backend in response.backends if backend.available} == {
        "interaction_mesh",
        "newton",
    }
    newton = next(backend for backend in response.backends if backend.backend_id == "newton")
    assert [category.value for category in newton.supported_categories] == ["plain_motion"]


def test_scheduler_reports_effective_unlimited_mode_when_queue_limit_is_ignored() -> None:
    snapshot = SimpleNamespace(
        max_running_jobs=0,
        max_queued_jobs=8,
        running_jobs=12,
        queued_jobs=0,
        reserved_jobs=0,
        closed=False,
    )
    response = CapabilitiesService(
        scheduler_snapshot=lambda: snapshot,
        robot_provider=lambda: [],
        device_probe=_cpu_devices,
    ).get_capabilities()

    assert response.scheduler.mode is SchedulerMode.UNLIMITED
    assert response.scheduler.max_queued_jobs == 8


def test_job_features_distinguish_durable_services_from_trusted_execution() -> None:
    durable_only = CapabilitiesService(
        robot_provider=lambda: [],
        device_probe=_cpu_devices,
        artifact_store_available=True,
        job_manager_available=True,
        job_execution_available=False,
    ).get_capabilities()

    assert durable_only.features["artifact_store"] is True
    assert durable_only.features["persistent_jobs"] is True
    assert durable_only.features["idempotent_jobs"] is True
    assert durable_only.features["revision_polling"] is True
    assert durable_only.features["job_execution"] is False
    assert durable_only.features["job_cancellation"] is False
    assert durable_only.features["job_retry"] is False

    executable = CapabilitiesService(
        robot_provider=lambda: [],
        device_probe=_cpu_devices,
        artifact_store_available=True,
        job_manager_available=True,
        job_execution_available=True,
    ).get_capabilities()

    assert executable.features["job_execution"] is True
    assert executable.features["job_cancellation"] is True
    assert executable.features["job_retry"] is True


def test_robot_capabilities_explain_missing_retarget_inputs(
    tmp_path: Path,
    monkeypatch,
) -> None:
    ready_dir = tmp_path / "ready"
    ready_dir.mkdir()
    ready_urdf = ready_dir / "robot.urdf"
    ready_urdf.write_text("<robot name='ready'/>", encoding="utf-8")
    ready = RobotPreset(
        name="ready_robot",
        display_name="Ready Robot",
        root_dir=ready_dir,
        urdf_path=ready_urdf,
        ik_map={"hips": "pelvis"},
        dof_order=("hip_joint",),
    )
    incomplete = RobotPreset(
        name="incomplete_robot",
        display_name="Incomplete Robot",
        root_dir=tmp_path / "incomplete",
        urdf_path=None,
    )
    monkeypatch.setattr(
        capabilities_module,
        "_reference_readiness",
        lambda preset: (["smpl"], ["smplx"]) if preset.name == "ready_robot" else ([], []),
    )
    service = CapabilitiesService(
        robot_provider=lambda: [ready, incomplete],
        device_probe=_cpu_devices,
    )

    robots = {robot.robot_id: robot for robot in service.get_capabilities().robots}

    assert robots["ready_robot"].available is True
    assert robots["ready_robot"].calibrated_references == ["smpl"]
    assert robots["ready_robot"].scaler_references == ["smplx"]
    assert robots["incomplete_robot"].available is False
    assert robots["incomplete_robot"].has_urdf is False
    assert robots["incomplete_robot"].has_ik_mapping is False
    assert robots["incomplete_robot"].unavailable_reason == (
        "URDF is missing; IK mapping is missing; DOF order is missing"
    )
    payload = service.get_capabilities().model_dump(mode="json")
    assert str(tmp_path) not in str(payload)


def test_readonly_robot_discovery_does_not_scaffold_orphan_urdf(
    tmp_path: Path,
    monkeypatch,
) -> None:
    robots_root = tmp_path / "robots"
    orphan = robots_root / "orphan"
    orphan.mkdir(parents=True)
    (orphan / "robot.urdf").write_text("<robot name='orphan'/>", encoding="utf-8")
    monkeypatch.setattr(robot_registry, "_CACHE", None)
    monkeypatch.setattr(robot_registry, "_discovery_roots", lambda: [robots_root])

    assert robot_registry.list_presets_readonly() == []
    assert not (orphan / "robot.yaml").exists()


def test_reference_readiness_separates_valid_calibration_from_contained_scaler(
    tmp_path: Path,
) -> None:
    root = tmp_path / "robot"
    description = root / "description"
    description.mkdir(parents=True)
    urdf = description / "robot.urdf"
    urdf.write_text("<robot name='ready'/>", encoding="utf-8")
    (description / "retarget_calibration_smpl.yaml").write_text(
        "robot: ready\nreference: smpl\ncalibrated_joint_q:\n  hip_joint: 0.0\n",
        encoding="utf-8",
    )
    (root / "scaler.yaml").write_text("joint_scales: {}\n", encoding="utf-8")
    outside_scaler = tmp_path / "outside.yaml"
    outside_scaler.write_text("joint_scales: {}\n", encoding="utf-8")
    preset = RobotPreset(
        name="ready",
        display_name="Ready",
        root_dir=root,
        urdf_path=urdf,
        ik_map={"hips": "pelvis"},
        dof_order=("hip_joint",),
        meta={
            "retarget": {
                "references": {
                    "smplx": {"scaler_config": "scaler.yaml"},
                    "gvhmr": {"scaler_config": "../outside.yaml"},
                }
            }
        },
    )

    calibrated, scalers = capabilities_module._reference_readiness(preset)

    assert calibrated == ["smpl"]
    assert scalers == ["smplx"]
