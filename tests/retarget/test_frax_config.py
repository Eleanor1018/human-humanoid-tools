"""FRAX options and collision layout: pure Python, no frax / JAX import."""

from __future__ import annotations

import logging
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest
import yaml

from hhtools.retarget.frax_backend import FraxConfig, frax_config_for_preset
from hhtools.retarget.frax_backend.collision import (
    CollisionSpec,
    dump_collision_spec,
    load_collision_spec,
    to_frax_collision_data,
)
from hhtools.robot.base import RobotPreset


def _preset(tmp_path: Path, frax_block) -> RobotPreset:
    yaml_path = tmp_path / "robot.yaml"
    yaml_path.write_text(yaml.safe_dump({"retarget": {"frax": frax_block}}), encoding="utf-8")
    return RobotPreset(
        name="bot",
        display_name="Bot",
        root_dir=tmp_path,
        urdf_path=None,
        meta={"yaml_path": str(yaml_path)},
    )


def test_package_import_does_not_load_jax() -> None:
    code = (
        "import sys, hhtools.retarget.frax_backend as b; "
        "assert set(b.missing_frax_dependencies()) <= set(b.FRAX_DEPENDENCIES); "
        "assert 'jax' not in sys.modules and 'frax' not in sys.modules"
    )
    subprocess.run([sys.executable, "-c", code], check=True)


def test_yaml_block_overrides_defaults_and_cli_overrides_win(tmp_path: Path) -> None:
    preset = _preset(
        tmp_path,
        {
            "regularization": 0.05,
            "floor": False,
            "self_collision_rows": 32,
            "joint_damping": {"waist_yaw_joint": 1.0},
            "joint_limit_overrides": {"left_shoulder_roll_joint": [-0.2, 2.5]},
        },
    )
    config = frax_config_for_preset(preset, floor=True)

    assert config.regularization == 0.05
    assert config.floor is True  # keyword override beats the yaml
    assert config.self_collision_rows == 32
    assert config.joint_regularization == (("waist_yaw_joint", 1.0),)
    assert config.joint_limit_overrides == (("left_shoulder_roll_joint", -0.2, 2.5),)
    assert config.self_collision is True and config.midpoint_weight == 0.0
    hash(config)  # keys the compiled-solver cache


@pytest.mark.parametrize(
    ("block", "message"),
    [
        ({"regularization": -1}, "regularization"),
        ({"floor": "yes"}, "floor"),
        ({"frame_bucket": 0}, "frame_bucket"),
        ({"joint_limit_overrides": {"j": [1.0, 0.5]}}, "lower < upper"),
        ({"joint_regularization": ["j"]}, "joint_regularization"),
    ],
)
def test_invalid_yaml_values_name_the_key(tmp_path: Path, block, message: str) -> None:
    with pytest.raises(ValueError, match=message):
        frax_config_for_preset(_preset(tmp_path, block))


def test_unknown_yaml_keys_are_logged(tmp_path: Path, caplog) -> None:
    with caplog.at_level(logging.WARNING):
        config = frax_config_for_preset(_preset(tmp_path, {"regularisation": 0.2}))
    assert config == FraxConfig()
    assert "regularisation" in caplog.text


def test_with_overrides_rejects_unknown_options() -> None:
    with pytest.raises(ValueError, match="unknown FRAX option"):
        FraxConfig().with_overrides(gain=3.0)


def test_collision_yaml_round_trip(tmp_path: Path) -> None:
    spec = CollisionSpec(
        spheres={"pelvis": [((0.0, 0.0, -0.05), 0.08)], "foot": [((0.1, 0.0, -0.04), 0.01)]},
        self_collision_pairs=[("foot", "pelvis")],
        source="auto",
        sole_links=("foot",),
    )
    path = tmp_path / "frax_collision.yaml"
    path.write_text(dump_collision_spec(spec), encoding="utf-8")

    loaded = load_collision_spec(path)

    assert loaded.signature() == spec.signature()
    assert loaded.sole_links == ("foot",)
    assert loaded.source == "file:frax_collision.yaml"


def test_collision_yaml_rejects_bad_spheres(tmp_path: Path) -> None:
    path = tmp_path / "frax_collision.yaml"
    path.write_text("collision_spheres:\n  a:\n    - {center: [0, 0], radius: 0.1}\n", "utf-8")
    with pytest.raises(ValueError, match="invalid sphere center"):
        load_collision_spec(path)


def _translation(z: float) -> np.ndarray:
    T = np.eye(4)
    T[2, 3] = z
    return T


def test_layout_orders_spheres_by_joint_and_filters_floor_and_rest_contacts() -> None:
    # Joint 0: pelvis (root).  Joint 1: shin.  Joint 2: foot (sole at z = 0).
    spec = CollisionSpec(
        spheres={
            "foot": [((0.05, 0.0, 0.01), 0.01), ((-0.05, 0.0, 0.01), 0.01)],
            "shin": [((0.0, 0.0, 0.0), 0.05), ((0.0, 0.0, 0.3), 0.05)],
            "pelvis": [((0.0, 0.0, 0.0), 0.1)],
            "hand": [((0.0, 0.0, 0.0), 0.03)],
        },
        self_collision_pairs=[("foot", "shin"), ("hand", "pelvis"), ("hand", "shin")],
        sole_links=("foot",),
    )
    link_frames = {
        "pelvis": (0, np.eye(4)),
        "shin": (1, np.eye(4)),
        "foot": (2, np.eye(4)),
        "hand": (1, _translation(0.4)),  # merged into the shin joint by a fixed joint
    }
    zero_pose = {
        "pelvis": _translation(0.8),
        "shin": _translation(0.04),  # lowest shin sphere reaches 1 cm below the sole
        "foot": np.eye(4),
        "hand": _translation(0.5),
    }

    layout = to_frax_collision_data(spec, link_frames, 3, zero_pose=zero_pose)

    data = layout.collision_data
    assert [len(r) for r in data["radii"]] == [1, 3, 2]  # pelvis | shin + hand | foot
    np.testing.assert_allclose(data["positions"][1][2], (0.0, 0.0, 0.4))  # hand folded
    assert layout.num_spheres == 6
    # Flat order: 0 pelvis, 1-2 shin, 3 hand, 4-5 foot.  The low shin sphere (1)
    # would hold the foot up, so only it is left out of the floor constraint.
    assert layout.floor_sphere_idxs == (0, 2, 3, 4, 5)
    # The low shin sphere touches both foot spheres at rest (dropped); hand and
    # shin share a joint, so they are never paired.
    assert set(data["body_sc_pairs"]) == {(0, 3), (2, 4), (2, 5)}
    assert layout.num_self_collision_pairs == 3
    assert layout.skipped_rest_pairs == 2
    assert data["root_positions"] == () and len(data["body_sc_tols"]) == 3


def test_layout_skips_links_missing_from_the_robot(caplog) -> None:
    spec = CollisionSpec(spheres={"ghost": [((0.0, 0.0, 0.0), 0.1)]})
    with caplog.at_level(logging.WARNING):
        layout = to_frax_collision_data(spec, {}, 2)
    assert layout.num_spheres == 0 and layout.skipped_links == ("ghost",)
    assert "ghost" in caplog.text
