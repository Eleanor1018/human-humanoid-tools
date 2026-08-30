"""Read-only capability discovery for humans, automation, and AI agents.

Capability discovery must stay cheap and side-effect free: in particular it
does not import either retarget pipeline or initialise Warp.  Optional package
availability is therefore probed with :mod:`importlib`, while device discovery
uses Torch only when it is already installable in the current environment.
"""

from __future__ import annotations

import importlib.util
import platform
from collections.abc import Callable, Iterable
from importlib import metadata
from typing import TYPE_CHECKING, Any

from hhtools._version import __version__
from hhtools.contracts import (
    AssetCategory,
    BackendCapability,
    CapabilityResponse,
    DeviceCapability,
    RobotCapability,
    SchedulerCapability,
    SchedulerMode,
)

if TYPE_CHECKING:
    from hhtools.robot.base import RobotPreset


_INPUT_FORMATS = (
    "bvh",
    "csv",
    "glb",
    "gltf",
    "npy",
    "npz",
    "pickle",
    "pkl",
    "pt",
    "pth",
)
_OUTPUT_FORMATS = ("csv", "pkl")
_CALIBRATION_REFERENCES = (
    "smpl",
    "smplx",
    "gvhmr",
    "soma_bvh",
    "lafan_bvh",
    "mocap_bvh",
    "xsens_mocap",
    "glb",
)

# Distribution names are not always the same as import names.  The first
# installed distribution in each tuple supplies the optional version string.
_DISTRIBUTIONS: dict[str, tuple[str, ...]] = {
    "mujoco": ("mujoco",),
    "newton": ("newton", "newton-python"),
    "osqp": ("osqp",),
    "torch": ("torch",),
    "warp": ("warp-lang", "warp"),
}


def _module_available(module_name: str) -> bool:
    """Return whether an optional module is importable without importing it."""

    try:
        return importlib.util.find_spec(module_name) is not None
    except (ImportError, ModuleNotFoundError, ValueError):
        return False


def _module_version(module_name: str) -> str | None:
    for distribution in _DISTRIBUTIONS.get(module_name, (module_name,)):
        try:
            return metadata.version(distribution)
        except metadata.PackageNotFoundError:
            continue
    return None


def _cpu_name() -> str:
    return platform.processor().strip() or platform.machine().strip() or "CPU"


def _detect_devices() -> list[DeviceCapability]:
    """Return compact CPU/CUDA/MPS facts without importing a retarget backend."""

    devices = [
        DeviceCapability(
            device_id="cpu",
            kind="cpu",
            display_name=_cpu_name(),
            available=True,
            metadata={"platform": platform.system().lower()},
        )
    ]
    try:
        import torch
    except (ImportError, OSError, RuntimeError):
        return devices

    torch_version = str(getattr(torch, "__version__", "unknown"))
    torch_runtime = getattr(getattr(torch, "version", None), "cuda", None)
    cuda = getattr(torch, "cuda", None)
    try:
        cuda_available = bool(cuda is not None and cuda.is_available())
    except (AttributeError, RuntimeError):
        cuda_available = False

    if cuda_available and cuda is not None:
        try:
            count = int(cuda.device_count())
        except (AttributeError, RuntimeError, TypeError, ValueError):
            count = 0
        for index in range(count):
            try:
                props = cuda.get_device_properties(index)
                name = str(getattr(props, "name", f"CUDA device {index}"))
                total_memory = int(getattr(props, "total_memory", 0)) or None
                major = getattr(props, "major", None)
                minor = getattr(props, "minor", None)
                compute_capability = (
                    f"{int(major)}.{int(minor)}"
                    if major is not None and minor is not None
                    else None
                )
            except (AttributeError, RuntimeError, TypeError, ValueError):
                name = f"CUDA device {index}"
                total_memory = None
                compute_capability = None

            free_memory: int | None = None
            try:
                free_memory = int(cuda.mem_get_info(index)[0])
            except (AttributeError, RuntimeError, TypeError, ValueError):
                pass

            devices.append(
                DeviceCapability(
                    device_id=f"cuda:{index}",
                    kind="cuda",
                    display_name=name,
                    available=True,
                    total_memory_bytes=total_memory,
                    free_memory_bytes=free_memory,
                    compute_capability=compute_capability,
                    metadata={
                        "torch": torch_version,
                        "cuda_runtime": str(torch_runtime) if torch_runtime else None,
                    },
                )
            )

    mps = getattr(getattr(torch, "backends", None), "mps", None)
    try:
        mps_available = bool(mps is not None and mps.is_available())
    except (AttributeError, RuntimeError):
        mps_available = False
    if mps_available:
        devices.append(
            DeviceCapability(
                device_id="mps",
                kind="mps",
                display_name="Apple Metal Performance Shaders",
                available=True,
                metadata={"torch": torch_version},
            )
        )
    return devices


def _scheduler_capability(snapshot: object | None) -> SchedulerCapability:
    """Normalize a Web scheduler snapshot without depending on its class."""

    def value(name: str, default: int | bool = 0) -> Any:
        if snapshot is None:
            return default
        if isinstance(snapshot, dict):
            return snapshot.get(name, default)
        return getattr(snapshot, name, default)

    max_running = int(value("max_running_jobs"))
    max_queued = int(value("max_queued_jobs"))
    if max_running == 0 and max_queued == 0:
        mode = SchedulerMode.UNLIMITED
    elif max_running > 0 and max_queued > 0:
        mode = SchedulerMode.LIMITED
    else:
        mode = SchedulerMode.MIXED
    return SchedulerCapability(
        max_running_jobs=max_running,
        max_queued_jobs=max_queued,
        running=int(value("running_jobs")),
        queued=int(value("queued_jobs")),
        reserved=int(value("reserved_jobs")),
        mode=mode,
        closed=bool(value("closed", False)),
    )


def _calibrated_references(preset: RobotPreset) -> list[str]:
    """List references with either a saved calibration or declared scaler."""

    from hhtools.retarget.calibration import resolve_calibration_file
    from hhtools.robot.retarget_profile import bundled_scaler_path

    calibrated: list[str] = []
    for reference in _CALIBRATION_REFERENCES:
        try:
            calibration = resolve_calibration_file(preset.root_dir, reference)
            scaler = bundled_scaler_path(preset, reference)
        except (OSError, TypeError, ValueError):
            continue
        if calibration is not None or scaler is not None:
            calibrated.append(reference)
    return calibrated


def _robot_capabilities(presets: Iterable[RobotPreset]) -> list[RobotCapability]:
    robots: list[RobotCapability] = []
    for preset in sorted(presets, key=lambda item: item.name):
        has_urdf = bool(preset.has_urdf)
        has_ik_mapping = bool(preset.ik_map)
        has_dof_order = bool(preset.dof_order)
        unavailable: list[str] = []
        if not has_urdf:
            unavailable.append("URDF is missing")
        if not has_ik_mapping:
            unavailable.append("IK mapping is missing")
        if not has_dof_order:
            unavailable.append("DOF order is missing")
        robots.append(
            RobotCapability(
                robot_id=preset.name,
                display_name=preset.display_name or preset.name,
                available=not unavailable,
                has_urdf=has_urdf,
                has_ik_mapping=has_ik_mapping,
                dof_count=len(preset.dof_order) if preset.dof_order else None,
                supported_references=list(_CALIBRATION_REFERENCES),
                calibrated_references=_calibrated_references(preset),
                unavailable_reason="; ".join(unavailable) if unavailable else None,
            )
        )
    return robots


def _backend_capabilities(devices: list[DeviceCapability]) -> list[BackendCapability]:
    cuda_available = any(device.kind.value == "cuda" and device.available for device in devices)
    linux = platform.system().lower() == "linux"

    definitions = (
        (
            "newton",
            "Newton IK",
            ("torch", "newton", "warp"),
            [AssetCategory.PLAIN_MOTION],
            {"batch": True, "scene_geometry": False, "cuda_graph": True},
        ),
        (
            "interaction_mesh",
            "Interaction-Mesh MPC",
            ("torch", "newton", "warp", "mujoco", "osqp"),
            [AssetCategory.OBJECT_INTERACTION, AssetCategory.TERRAIN_SCENE],
            {"batch": False, "scene_geometry": True, "mpc": True},
        ),
    )
    capabilities: list[BackendCapability] = []
    for backend_id, display_name, dependencies, categories, features in definitions:
        missing = [name for name in dependencies if not _module_available(name)]
        reasons: list[str] = []
        if not linux:
            reasons.append("retargeting requires Linux")
        if not cuda_available:
            reasons.append("retargeting requires an NVIDIA CUDA device")
        if missing:
            reasons.append(f"missing dependencies: {', '.join(missing)}")
        capabilities.append(
            BackendCapability(
                backend_id=backend_id,
                display_name=display_name,
                available=not reasons,
                version=_module_version("newton" if backend_id == "newton" else "mujoco"),
                supported_categories=categories,
                output_formats=list(_OUTPUT_FORMATS),
                unavailable_reason="; ".join(reasons) if reasons else None,
                features=features,
                limits={"requires_linux": True, "requires_cuda": True},
            )
        )
    return capabilities


class CapabilitiesService:
    """Build one truthful snapshot from optional runtime providers."""

    def __init__(
        self,
        *,
        scheduler_snapshot: Callable[[], object] | None = None,
        robot_provider: Callable[[], Iterable[RobotPreset]] | None = None,
        device_probe: Callable[[], list[DeviceCapability]] = _detect_devices,
    ) -> None:
        if robot_provider is None:
            from hhtools.robot.registry import list_presets

            robot_provider = list_presets
        self._scheduler_snapshot = scheduler_snapshot
        self._robot_provider = robot_provider
        self._device_probe = device_probe

    def get_capabilities(self) -> CapabilityResponse:
        """Return a compact snapshot; no solver, queue slot, or asset is created."""

        snapshot = self._scheduler_snapshot() if self._scheduler_snapshot is not None else None
        devices = self._device_probe()
        return CapabilityResponse(
            service_version=__version__,
            backends=_backend_capabilities(devices),
            devices=devices,
            robots=_robot_capabilities(self._robot_provider()),
            scheduler=_scheduler_capability(snapshot),
            supported_input_formats=list(_INPUT_FORMATS),
            supported_output_formats=list(_OUTPUT_FORMATS),
            features={
                "agent_rest": True,
                "asset_registry": False,
                "job_spec_v2": True,
                "json_cli": False,
                "mcp": False,
                "preflight": False,
            },
        )


__all__ = ["CapabilitiesService"]
