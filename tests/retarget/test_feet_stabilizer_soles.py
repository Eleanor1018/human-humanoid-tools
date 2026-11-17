"""The feet stabilizer grounds soles, not ankle origins."""

from __future__ import annotations

import numpy as np
import pytest
from frax_toy_robot import toy_humanoid_urdf_with_visuals, write_toy_robot
from scipy.spatial.transform import Rotation

from hhtools.retarget.newton_basic.config import FeetStabilizerConfig
from hhtools.retarget.newton_basic.feet_stabilizer import FeetStabilizer
from hhtools.robot.foot_geometry import foot_sole_points_in_ankle_frames

_NAMES = ("hips", "left_ankle", "right_ankle")
_ANKLE_ABOVE_SOLE = 0.05


def _foot_box(depth: float = _ANKLE_ABOVE_SOLE) -> np.ndarray:
    """Corners of a 20 x 8 cm sole ``depth`` below the ankle, toe forward."""
    return np.array(
        [[x, y, z] for x in (-0.06, 0.14) for y in (-0.04, 0.04) for z in (-depth, 0.0)]
    )


def _frames(feet_z: float, foot_quat=(0.0, 0.0, 0.0, 1.0)) -> np.ndarray:
    eff = np.zeros((3, 3, 7), dtype=np.float32)
    eff[..., 6] = 1.0
    eff[:, 0, 2] = 0.9
    eff[:, 1:, 2] = feet_z
    eff[:, 1:, 3:7] = foot_quat
    eff[:, 1, 1] = 0.1
    eff[:, 2, 1] = -0.1
    return eff


def _stabilizer(sole_points=None) -> FeetStabilizer:
    cfg = FeetStabilizerConfig(ground_contact_z=0.0, max_ground_correction=0.05)
    return FeetStabilizer(cfg, joint_names=_NAMES, sole_points=sole_points)


def test_grounded_targets_stay_where_they_are() -> None:
    """Ankles at the robot's ankle height already put the soles on the floor."""
    soles = {"left": _foot_box(), "right": _foot_box()}
    grounded = _frames(_ANKLE_ABOVE_SOLE)

    np.testing.assert_allclose(_stabilizer(soles).apply(grounded), grounded, atol=1e-6)
    # Comparing ankle origins with the floor pulled these targets 5 cm down.
    lowered = _stabilizer().apply(grounded)
    np.testing.assert_allclose(lowered[:, 1:, 2], 0.0, atol=1e-6)


def test_floating_targets_are_lowered_until_the_soles_touch() -> None:
    soles = {"left": _foot_box(), "right": _foot_box()}
    out = _stabilizer(soles).apply(_frames(0.08))
    np.testing.assert_allclose(out[:, 1:, 2], _ANKLE_ABOVE_SOLE, atol=1e-6)
    np.testing.assert_allclose(out[:, 0, 2], 0.9 - 0.03, atol=1e-6)


def test_a_tilted_foot_is_grounded_by_its_lowest_point() -> None:
    """Toe down 20 degrees: the toe reaches the floor before the heel does."""
    soles = {"left": _foot_box(), "right": _foot_box()}
    toe_down = Rotation.from_euler("y", 20, degrees=True)
    lowest = (toe_down.apply(_foot_box())[:, 2]).min()
    out = _stabilizer(soles).apply(_frames(0.13, tuple(toe_down.as_quat())))
    np.testing.assert_allclose(out[:, 1:, 2], -lowest, atol=1e-5)
    assert -lowest > _ANKLE_ABOVE_SOLE


def test_a_foot_without_points_falls_back_to_its_ankle() -> None:
    """Only the left foot has points; the right ankle reads as its own sole."""
    out = _stabilizer({"left": _foot_box()}).apply(_frames(0.08))
    # The right "sole" (its ankle, 8 cm) is higher than the left sole (3 cm).
    np.testing.assert_allclose(out[:, 1:, 2], _ANKLE_ABOVE_SOLE, atol=1e-6)


@pytest.fixture(scope="module")
def toy_with_visuals(tmp_path_factory):
    return write_toy_robot(
        tmp_path_factory.mktemp("robots") / "toy_visual",
        urdf=toy_humanoid_urdf_with_visuals(),
        name="toy_visual",
    )


def test_sole_points_come_from_the_foot_meshes(toy_with_visuals) -> None:
    """Toy foot: a 4 cm box centred 4 cm below the ankle, so the sole is 6 cm down."""
    points = foot_sole_points_in_ankle_frames(toy_with_visuals)
    assert set(points) == {"left", "right"}
    for side_points in points.values():
        assert side_points[:, 2].min() == pytest.approx(-0.06, abs=1e-6)
        assert side_points[:, 0].max() == pytest.approx(0.14, abs=1e-6)
