from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

from hhtools.contracts import DeviceCapability, SchedulerMode
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


def test_capabilities_report_unlimited_defaults_and_runtime_requirements(
    monkeypatch,
) -> None:
    monkeypatch.setattr(capabilities_module.platform, "system", lambda: "Windows")
    monkeypatch.setattr(capabilities_module, "_module_available", lambda _name: True)
    service = CapabilitiesService(robot_provider=lambda: [], device_probe=_cpu_devices)

    response = service.get_capabilities()

    assert response.scheduler.mode is SchedulerMode.UNLIMITED
    assert response.scheduler.max_running_jobs == 0
    assert response.scheduler.max_queued_jobs == 0
    assert response.supported_output_formats == ["csv", "pkl"]
    assert response.features == {
        "agent_rest": True,
        "asset_registry": False,
        "job_spec_v2": True,
        "json_cli": False,
        "mcp": False,
        "preflight": False,
    }
    assert all(not backend.available for backend in response.backends)
    assert all(
        "requires Linux" in (backend.unavailable_reason or "") for backend in response.backends
    )


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
    )

    response = service.get_capabilities()

    assert response.scheduler.mode is SchedulerMode.LIMITED
    assert response.scheduler.running == 1
    assert response.scheduler.queued == 3
    assert response.scheduler.reserved == 1
    assert {backend.backend_id for backend in response.backends if backend.available} == {
        "interaction_mesh",
        "newton",
    }
    newton = next(backend for backend in response.backends if backend.backend_id == "newton")
    assert [category.value for category in newton.supported_categories] == ["plain_motion"]


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
        "_calibrated_references",
        lambda preset: ["smpl"] if preset.name == "ready_robot" else [],
    )
    service = CapabilitiesService(
        robot_provider=lambda: [ready, incomplete],
        device_probe=_cpu_devices,
    )

    robots = {robot.robot_id: robot for robot in service.get_capabilities().robots}

    assert robots["ready_robot"].available is True
    assert robots["ready_robot"].calibrated_references == ["smpl"]
    assert robots["incomplete_robot"].available is False
    assert robots["incomplete_robot"].has_urdf is False
    assert robots["incomplete_robot"].has_ik_mapping is False
    assert robots["incomplete_robot"].unavailable_reason == (
        "URDF is missing; IK mapping is missing; DOF order is missing"
    )
    payload = service.get_capabilities().model_dump(mode="json")
    assert str(tmp_path) not in str(payload)
