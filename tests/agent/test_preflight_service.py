from __future__ import annotations

import hashlib
from datetime import UTC, datetime
from pathlib import Path

import numpy as np
import pytest

from hhtools.contracts import (
    AssetRegistrationRequest,
    BackendCapability,
    CapabilityResponse,
    DeviceCapability,
    OutputPolicy,
    PreflightStatus,
    RetargetPreflightRequest,
    SchedulerCapability,
)
from hhtools.robot.registry import preset_from_dir
from hhtools.services.asset_service import AgentAssetService
from hhtools.services.assets import AssetRegistry
from hhtools.services.plans import PlanStore
from hhtools.services.preflight import PreflightService

NOW = datetime(2026, 8, 31, 2, 0, tzinfo=UTC)


def _write_motion(
    path: Path,
    *,
    frame_count: int = 48,
    frame_rate_hz: float = 30.0,
) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    positions = np.zeros((frame_count, 2, 3), dtype=np.float32)
    quaternions = np.zeros((frame_count, 2, 4), dtype=np.float32)
    quaternions[..., 3] = 1.0
    np.savez(
        path,
        schema_version=np.array("1"),
        name=np.array(path.stem),
        framerate=np.array(frame_rate_hz),
        up_axis=np.array("Z"),
        source_format=np.array("npz"),
        bone_names=np.array(["root", "joint"]),
        parent_indices=np.array([-1, 0], dtype=np.int32),
        positions=positions,
        quaternions=quaternions,
    )


def _write_robot(
    root: Path,
    *,
    scaler: bool = False,
    scaler_text: str | None = None,
) -> None:
    urdf = root / "urdf" / "robot.urdf"
    urdf.parent.mkdir(parents=True)
    scaler_block = ""
    if scaler:
        config = root / "config" / "smpl_scaler.yaml"
        config.parent.mkdir()
        config.write_text(
            scaler_text
            or (
                "human_height_assumption: 1.7\n"
                "model_height: 1.0\n"
                "joint_scales:\n"
                "  hips: 1.0\n"
                "joint_offsets: {}\n"
            ),
            encoding="utf-8",
        )
        scaler_block = (
            "retarget:\n  references:\n    smpl:\n      scaler_config: config/smpl_scaler.yaml\n"
        )
    (root / "robot.yaml").write_text(
        "name: test_robot\n"
        "display_name: Test Robot\n"
        "urdf: urdf/robot.urdf\n"
        "dof_order: [hip]\n"
        "ik_map:\n"
        "  hips: base\n"
        f"{scaler_block}",
        encoding="utf-8",
    )
    urdf.write_text(
        """<?xml version="1.0"?>
<robot name="test_robot">
  <link name="base"/>
  <link name="torso"/>
  <joint name="hip" type="revolute">
    <parent link="base"/>
    <child link="torso"/>
    <axis xyz="0 0 1"/>
    <limit lower="-1.0" upper="1.0" effort="10" velocity="2"/>
  </joint>
</robot>
""",
        encoding="utf-8",
    )


def _write_calibration(
    root: Path,
    *,
    value: float = 0.0,
    robot: str = "test_robot",
) -> str:
    path = root / "urdf" / "retarget_calibration_smpl.yaml"
    path.write_text(
        f"robot: {robot}\n"
        "reference: smpl\n"
        "calibrated_joint_q:\n"
        f"  hip: {value}\n"
        "notes: test fixture\n",
        encoding="utf-8",
    )
    return f"cal:sha256:{hashlib.sha256(path.read_bytes()).hexdigest()}"


def _capabilities(*, closed: bool = False) -> CapabilityResponse:
    return CapabilityResponse(
        service_version="test",
        backends=[
            BackendCapability(
                backend_id="newton",
                display_name="Newton IK",
                available=True,
                supported_categories=["plain_motion"],
                output_formats=["csv", "pkl"],
            ),
            BackendCapability(
                backend_id="interaction_mesh",
                display_name="Interaction Mesh",
                available=True,
                supported_categories=["object_interaction", "terrain_scene"],
                output_formats=["csv", "pkl"],
            ),
        ],
        devices=[
            DeviceCapability(
                device_id="cpu",
                kind="cpu",
                display_name="Test CPU",
                available=True,
            )
        ],
        scheduler=SchedulerCapability(
            max_running_jobs=0,
            max_queued_jobs=0,
            mode="unlimited",
            closed=closed,
        ),
        supported_output_formats=["csv", "pkl"],
        features={"preflight": True},
    )


def _setup(
    tmp_path: Path,
    *,
    calibration: bool = True,
    scaler: bool = False,
    calibration_value: float = 0.0,
    closed: bool = False,
    scaler_text: str | None = None,
    csv_motion: bool = False,
    corrupt_cached_preset: bool = False,
    calibration_robot: str = "test_robot",
    motion_frame_count: int = 48,
    motion_frame_rate_hz: float = 30.0,
) -> tuple[PreflightService, str, str, str | None]:
    motion_root = tmp_path / "motions"
    robot_root = tmp_path / "robots"
    robot = robot_root / "test_robot"
    motion_name = "walk.csv" if csv_motion else "walk.npz"
    if csv_motion:
        motion_root.mkdir(parents=True)
        (motion_root / motion_name).write_text(
            "time,value\n0,1\n1,2\n",
            encoding="utf-8",
        )
    else:
        _write_motion(
            motion_root / motion_name,
            frame_count=motion_frame_count,
            frame_rate_hz=motion_frame_rate_hz,
        )
    _write_robot(robot, scaler=scaler, scaler_text=scaler_text)
    calibration_id = (
        _write_calibration(
            robot,
            value=calibration_value,
            robot=calibration_robot,
        )
        if calibration
        else None
    )
    assets = AgentAssetService(
        AssetRegistry(
            tmp_path / "agent-state",
            {"motions": motion_root, "robots": robot_root},
        )
    )
    motion = assets.register(AssetRegistrationRequest(root_id="motions", relative_path=motion_name))
    robot_bundle = assets.register(
        AssetRegistrationRequest(
            root_id="robots",
            relative_path="test_robot",
            kind="robot_bundle",
        )
    )
    preset = preset_from_dir(robot)
    if corrupt_cached_preset:
        preset.dof_order = ("stale_joint",)
        preset.ik_map = {}
    service = PreflightService(
        assets,
        PlanStore(tmp_path / "plans"),
        capabilities_provider=lambda: _capabilities(closed=closed),
        robot_provider=lambda: [preset],
        clock=lambda: NOW,
        request_id_provider=lambda: "req_test",
    )
    return service, motion.asset_id, robot_bundle.asset_id, calibration_id


def _request(
    motion_id: str,
    robot_asset_id: str | None,
    **changes,
) -> RetargetPreflightRequest:
    values = {
        "motion_asset_id": motion_id,
        "robot_id": "test_robot",
        "robot_asset_id": robot_asset_id,
        "parameters": {"run_mode": "smoke"},
    }
    values.update(changes)
    return RetargetPreflightRequest(**values)


def test_ready_preflight_is_stable_portable_and_does_not_reserve_admission(
    tmp_path: Path,
) -> None:
    service, motion_id, robot_id, calibration_id = _setup(tmp_path)

    first = service.preflight_retarget(_request(motion_id, robot_id))
    second = service.preflight_retarget(_request(motion_id, robot_id))

    assert first.status is PreflightStatus.READY
    assert first.plan is not None
    assert second.plan == first.plan
    assert first.plan.plan_id == second.plan.plan_id
    assert first.plan.calibration_id == calibration_id
    assert first.plan.parameters == {
        "run_mode": "smoke",
        "limit_frames": 30,
        "human_height": 1.65,
        "retarget_fps": 30.0,
        "foot_clamp_anti_penetration": False,
        "reference": "smpl",
        "retarget_profile": "calibration",
        "ik_iterations": 24,
    }
    assert first.checks[-1].code == "JOB_ADMISSION"
    assert first.checks[-1].level.value == "warning"
    assert str(tmp_path) not in first.model_dump_json()


def test_preflight_rejects_output_policy_without_a_managed_alias(tmp_path: Path) -> None:
    service, motion_id, robot_id, _ = _setup(tmp_path)

    response = service.preflight_retarget(
        _request(
            motion_id,
            robot_id,
            output_policy=OutputPolicy.FAIL_IF_EXISTS,
        )
    )

    assert response.status is PreflightStatus.REJECTED
    assert response.error is not None
    assert response.error.code == "UNSUPPORTED_OUTPUT_POLICY"
    assert response.error.details == {"output_policy": "fail_if_exists"}


def test_preflight_reloads_manifest_bound_yaml_instead_of_mutable_cache(
    tmp_path: Path,
) -> None:
    service, motion_id, robot_id, _ = _setup(
        tmp_path,
        corrupt_cached_preset=True,
    )

    response = service.preflight_retarget(_request(motion_id, robot_id))

    assert response.status is PreflightStatus.READY
    assert response.plan is not None


def test_effective_parameter_change_changes_plan_identity(tmp_path: Path) -> None:
    service, motion_id, robot_id, _ = _setup(tmp_path)

    baseline = service.preflight_retarget(_request(motion_id, robot_id))
    changed = service.preflight_retarget(
        _request(
            motion_id,
            robot_id,
            parameters={"run_mode": "smoke", "ik_iterations": 32},
        )
    )

    assert baseline.plan is not None and changed.plan is not None
    assert baseline.plan.plan_id != changed.plan.plan_id


def test_calibration_content_change_changes_plan_identity(tmp_path: Path) -> None:
    service, motion_id, robot_id, _ = _setup(tmp_path)
    baseline = service.preflight_retarget(_request(motion_id, robot_id))
    _write_calibration(tmp_path / "robots" / "test_robot", value=0.5)

    # Calibration is executable robot configuration.  Updating it requires a
    # new content-addressed robot bundle before another plan can be issued.
    assets = service._asset_service  # noqa: SLF001 - integration fixture boundary
    updated_robot = assets.register(
        AssetRegistrationRequest(
            root_id="robots",
            relative_path="test_robot",
            kind="robot_bundle",
        )
    )

    changed = service.preflight_retarget(_request(motion_id, updated_robot.asset_id))

    assert baseline.plan is not None and changed.plan is not None
    assert baseline.plan.plan_id != changed.plan.plan_id
    assert baseline.plan.calibration_digest != changed.plan.calibration_digest


def test_preflight_preserves_actionable_asset_integrity_error_codes(
    tmp_path: Path,
) -> None:
    service, motion_id, robot_id, _ = _setup(tmp_path)
    (tmp_path / "motions" / "walk.npz").write_bytes(b"changed after registration")

    response = service.preflight_retarget(_request(motion_id, robot_id))

    assert response.status is PreflightStatus.REJECTED
    assert response.error is not None
    assert response.error.code == "ASSET_HASH_MISMATCH"
    assert response.error.stage.value == "preflight"


def test_generic_csv_requires_a_workflow_schema_before_execution(
    tmp_path: Path,
) -> None:
    service, motion_id, robot_id, _ = _setup(tmp_path, csv_motion=True)

    response = service.preflight_retarget(_request(motion_id, robot_id))

    assert response.status is PreflightStatus.REJECTED
    assert response.error is not None
    assert response.error.code == "CONTENT_REQUIRES_WORKFLOW_SCHEMA"


def test_missing_calibration_returns_human_action_instead_of_guessing(
    tmp_path: Path,
) -> None:
    service, motion_id, robot_id, _ = _setup(tmp_path, calibration=False)

    response = service.preflight_retarget(_request(motion_id, robot_id))

    assert response.status is PreflightStatus.HUMAN_ACTION_REQUIRED
    assert response.plan is None
    assert response.error is None
    assert response.required_actions[0].actor == "human"
    assert response.required_actions[0].action == "open_calibration_ui"
    assert "calibrate=smpl" in str(response.required_actions[0].url)


def test_newton_accepts_a_manifest_bound_scaler_without_manual_calibration(
    tmp_path: Path,
) -> None:
    service, motion_id, robot_id, _ = _setup(
        tmp_path,
        calibration=False,
        scaler=True,
    )

    response = service.preflight_retarget(_request(motion_id, robot_id))

    assert response.status is PreflightStatus.READY
    assert response.plan is not None
    assert response.plan.parameters["retarget_profile"] == "bundled_scaler"
    assert response.plan.parameters["human_height"] == 1.7
    assert response.plan.calibration_id is None
    assert response.plan.calibration_digest is None


def test_empty_or_semantically_invalid_scaler_cannot_make_preflight_ready(
    tmp_path: Path,
) -> None:
    service, motion_id, robot_id, _ = _setup(
        tmp_path,
        calibration=False,
        scaler=True,
        scaler_text=(
            "human_height_assumption: 1.7\n"
            "model_height: 1.0\n"
            "joint_scales: {}\n"
            "root_joint: missing\n"
        ),
    )

    response = service.preflight_retarget(_request(motion_id, robot_id))

    assert response.status is PreflightStatus.REJECTED
    assert response.error is not None
    assert response.error.code == "CALIBRATION_MISMATCH"


def test_robot_asset_is_required_and_backend_cannot_override_routing(
    tmp_path: Path,
) -> None:
    service, motion_id, robot_id, _ = _setup(tmp_path)

    missing_robot = service.preflight_retarget(_request(motion_id, None))
    wrong_backend = service.preflight_retarget(
        _request(motion_id, robot_id, backend="interaction_mesh")
    )

    assert missing_robot.status is PreflightStatus.REJECTED
    assert missing_robot.error is not None
    assert missing_robot.error.code == "ROBOT_ASSET_REQUIRED"
    assert missing_robot.error.next_action is not None
    assert missing_robot.error.next_action.action == "register_asset_bundle"
    assert set(missing_robot.error.next_action.parameters) == {"request"}
    registration = AssetRegistrationRequest.model_validate(
        missing_robot.error.next_action.parameters["request"]
    )
    assert registration.root_id == "robots"
    assert registration.relative_path == "test_robot"
    assert registration.kind is not None
    assert registration.kind.value == "robot_bundle"
    assert registration.category is not None
    assert registration.category.value == "robot_model"
    assert str(tmp_path) not in missing_robot.model_dump_json()
    registered = service._asset_service.register(  # noqa: SLF001 - convergence boundary
        registration
    )
    converged = service.preflight_retarget(_request(motion_id, registered.asset_id))
    assert converged.status is PreflightStatus.READY
    assert wrong_backend.status is PreflightStatus.REJECTED
    assert wrong_backend.error is not None
    assert wrong_backend.error.code == "BACKEND_INCOMPATIBLE"


def test_missing_robot_asset_validates_the_installed_preset_before_suggesting_registration(
    tmp_path: Path,
) -> None:
    service, motion_id, _robot_id, _ = _setup(tmp_path)

    response = service.preflight_retarget(_request(motion_id, None, robot_id="not-installed"))

    assert response.status is PreflightStatus.REJECTED
    assert response.error is not None
    assert response.error.code == "ROBOT_NOT_FOUND"
    assert response.error.next_action is None
    assert str(tmp_path) not in response.model_dump_json()


def test_robot_bundle_mismatch_reuses_its_portable_source_for_registration(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service, motion_id, robot_id, _ = _setup(tmp_path)
    from hhtools.services import preflight as preflight_module

    original_manifest_hashes = preflight_module._manifest_hashes

    def omit_calibration_binding(bundle, *, role=None):
        hashes = original_manifest_hashes(bundle, role=role)
        if role == "metadata":
            calibration_hashes = {
                item.sha256 for item in bundle.files if "retarget_calibration" in item.relative_path
            }
            return hashes - calibration_hashes
        return hashes

    monkeypatch.setattr(preflight_module, "_manifest_hashes", omit_calibration_binding)

    response = service.preflight_retarget(_request(motion_id, robot_id))

    assert response.status is PreflightStatus.REJECTED
    assert response.error is not None
    assert response.error.code == "ROBOT_BUNDLE_MISMATCH"
    assert response.error.next_action is not None
    assert response.error.next_action.action == "register_asset_bundle"
    assert set(response.error.next_action.parameters) == {"request"}
    registration = AssetRegistrationRequest.model_validate(
        response.error.next_action.parameters["request"]
    )
    assert registration.root_id == "robots"
    assert registration.relative_path == "test_robot"
    assert registration.kind is not None
    assert registration.kind.value == "robot_bundle"
    assert registration.category is not None
    assert registration.category.value == "robot_model"
    assert str(tmp_path) not in response.model_dump_json()
    monkeypatch.setattr(preflight_module, "_manifest_hashes", original_manifest_hashes)
    registered = service._asset_service.register(  # noqa: SLF001 - convergence boundary
        registration
    )
    converged = service.preflight_retarget(_request(motion_id, registered.asset_id))
    assert converged.status is PreflightStatus.READY


def test_robot_id_must_be_portable_and_is_not_reflected_in_errors(
    tmp_path: Path,
) -> None:
    service, motion_id, robot_id, _ = _setup(tmp_path)

    response = service.preflight_retarget(
        _request(motion_id, robot_id, robot_id="../private/robot")
    )

    assert response.status is PreflightStatus.REJECTED
    assert response.error is not None
    assert response.error.code == "INVALID_PARAMETER"
    assert response.error.details == {"parameter": "robot_id"}
    assert "../private/robot" not in response.model_dump_json()


@pytest.mark.parametrize(
    "parameters",
    [
        {"reference": "smpl"},
        {"run_mode": "full", "limit_frames": 10},
        {"ik_iterations": True},
        {"ik_iterations": 201},
        {"ik_iterations": 10**9},
        {"human_height": float("nan")},
        {"human_height": 100.0},
        {"retarget_fps": 0},
        {"retarget_fps": 1e308},
        {"foot_clamp_anti_penetration": 1},
    ],
)
def test_invalid_parameters_are_rejected_without_coercion(
    tmp_path: Path,
    parameters: dict[str, object],
) -> None:
    service, motion_id, robot_id, _ = _setup(tmp_path)

    response = service.preflight_retarget(_request(motion_id, robot_id, parameters=parameters))

    assert response.status is PreflightStatus.REJECTED
    assert response.error is not None
    assert response.error.code == "INVALID_PARAMETER"
    assert str(tmp_path) not in response.model_dump_json()


def test_source_fps_and_explicit_equal_fps_share_one_effective_plan(
    tmp_path: Path,
) -> None:
    service, motion_id, robot_id, _ = _setup(tmp_path)

    inherited = service.preflight_retarget(_request(motion_id, robot_id))
    explicit = service.preflight_retarget(
        _request(
            motion_id,
            robot_id,
            parameters={"run_mode": "smoke", "retarget_fps": 30.0},
        )
    )

    assert inherited.status is PreflightStatus.READY
    assert explicit.status is PreflightStatus.READY
    assert inherited.plan is not None and explicit.plan is not None
    assert inherited.plan.plan_id == explicit.plan.plan_id
    assert explicit.plan.parameters["retarget_fps"] == 30.0


def test_runtime_fps_tolerance_is_reflected_in_plan_identity(tmp_path: Path) -> None:
    service, motion_id, robot_id, _ = _setup(tmp_path)

    inherited = service.preflight_retarget(_request(motion_id, robot_id))
    within_tolerance = service.preflight_retarget(
        _request(
            motion_id,
            robot_id,
            parameters={"run_mode": "smoke", "retarget_fps": 30.0000005},
        )
    )
    outside_tolerance = service.preflight_retarget(
        _request(
            motion_id,
            robot_id,
            parameters={"run_mode": "smoke", "retarget_fps": 30.000002},
        )
    )

    assert inherited.plan is not None
    assert within_tolerance.plan is not None
    assert outside_tolerance.plan is not None
    assert inherited.plan.plan_id == within_tolerance.plan.plan_id
    assert inherited.plan.plan_id != outside_tolerance.plan.plan_id


def test_high_source_fps_is_allowed_when_explicit_request_is_a_noop(
    tmp_path: Path,
) -> None:
    service, motion_id, robot_id, _ = _setup(
        tmp_path,
        motion_frame_rate_hz=1_200.0,
    )

    inherited = service.preflight_retarget(_request(motion_id, robot_id))
    explicit = service.preflight_retarget(
        _request(
            motion_id,
            robot_id,
            parameters={"run_mode": "smoke", "retarget_fps": 1_200.0},
        )
    )

    assert inherited.status is PreflightStatus.READY
    assert explicit.status is PreflightStatus.READY
    assert inherited.plan is not None and explicit.plan is not None
    assert inherited.plan.plan_id == explicit.plan.plan_id


def test_resampling_that_exceeds_the_backend_frame_ceiling_is_rejected(
    tmp_path: Path,
) -> None:
    service, motion_id, robot_id, _ = _setup(
        tmp_path,
        motion_frame_count=5_000,
    )

    response = service.preflight_retarget(
        _request(
            motion_id,
            robot_id,
            parameters={"run_mode": "smoke", "retarget_fps": 1_000.0},
        )
    )

    assert response.status is PreflightStatus.REJECTED
    assert response.error is not None
    assert response.error.code == "INVALID_PARAMETER"
    assert response.error.details["maximum_frames"] == 100_000


def test_explicit_calibration_id_and_joint_limits_must_match(tmp_path: Path) -> None:
    service, motion_id, robot_id, _ = _setup(tmp_path)
    wrong_id = f"cal:sha256:{'0' * 64}"
    mismatch = service.preflight_retarget(_request(motion_id, robot_id, calibration_id=wrong_id))

    limited, limited_motion, limited_robot, _ = _setup(
        tmp_path / "limited",
        calibration_value=2.0,
    )
    out_of_range = limited.preflight_retarget(_request(limited_motion, limited_robot))

    assert mismatch.status is PreflightStatus.REJECTED
    assert mismatch.error is not None
    assert mismatch.error.code == "CALIBRATION_MISMATCH"
    assert out_of_range.status is PreflightStatus.REJECTED
    assert out_of_range.error is not None
    assert out_of_range.error.code == "CALIBRATION_MISMATCH"


def test_calibration_requires_an_exact_nonempty_robot_identity(tmp_path: Path) -> None:
    service, motion_id, robot_id, _ = _setup(
        tmp_path,
        calibration_robot="''",
    )

    response = service.preflight_retarget(_request(motion_id, robot_id))

    assert response.status is PreflightStatus.REJECTED
    assert response.error is not None
    assert response.error.code == "CALIBRATION_MISMATCH"


def test_malformed_legacy_calibration_is_not_reported_as_missing(tmp_path: Path) -> None:
    service, motion_id, robot_id, _ = _setup(tmp_path, calibration=False)
    legacy = tmp_path / "robots" / "test_robot" / "urdf" / "retarget_calibration.yaml"
    legacy.write_text("robot: [malformed", encoding="utf-8")

    response = service.preflight_retarget(_request(motion_id, robot_id))

    assert response.status is PreflightStatus.REJECTED
    assert response.error is not None
    assert response.error.code in {"CALIBRATION_MISMATCH", "ROBOT_METADATA_INVALID"}


def test_explicit_missing_calibration_id_is_a_mismatch_not_a_ui_action(
    tmp_path: Path,
) -> None:
    service, motion_id, robot_id, _ = _setup(tmp_path, calibration=False)

    response = service.preflight_retarget(
        _request(
            motion_id,
            robot_id,
            calibration_id=f"cal:sha256:{'0' * 64}",
        )
    )

    assert response.status is PreflightStatus.REJECTED
    assert response.error is not None
    assert response.error.code == "CALIBRATION_MISMATCH"
    assert response.required_actions == []


def test_calibration_changed_while_parsing_cannot_be_bound_to_a_plan(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service, motion_id, robot_id, _ = _setup(tmp_path)
    calibration = tmp_path / "robots" / "test_robot" / "urdf" / "retarget_calibration_smpl.yaml"
    from hhtools.services import preflight as preflight_module

    original_hash = preflight_module._sha256_file
    changed = False

    def mutate_after_first_hash(path: Path) -> str:
        nonlocal changed
        digest = original_hash(path)
        if path == calibration and not changed:
            changed = True
            calibration.write_text(
                calibration.read_text(encoding="utf-8").replace(
                    "hip: 0.0",
                    "hip: 0.5",
                ),
                encoding="utf-8",
            )
        return digest

    monkeypatch.setattr(preflight_module, "_sha256_file", mutate_after_first_hash)
    response = service.preflight_retarget(_request(motion_id, robot_id))

    assert response.status is PreflightStatus.REJECTED
    assert response.error is not None
    assert response.error.code == "CALIBRATION_MISMATCH"
    assert response.error.retryable is True


def test_closed_scheduler_rejects_without_creating_a_plan(tmp_path: Path) -> None:
    service, motion_id, robot_id, _ = _setup(tmp_path, closed=True)

    response = service.preflight_retarget(_request(motion_id, robot_id))

    assert response.status is PreflightStatus.REJECTED
    assert response.plan is None
    assert response.error is not None
    assert response.error.code == "SCHEDULER_CLOSED"
    assert response.error.retryable is True
