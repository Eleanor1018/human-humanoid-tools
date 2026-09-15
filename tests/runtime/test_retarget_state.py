import numpy as np
import pytest

from hhtools.application.retarget_state import load_retarget_state, publish_retarget_state
from hhtools.retarget.retarget_result import RetargetedMotion


def test_full_trajectory_preserves_precision_and_export_context(tmp_path):
    coordinates = np.arange(360 * 9, dtype=np.float64).reshape(360, 9) / 123.4567
    motion = RetargetedMotion(
        name="walk",
        joint_q=coordinates,
        sample_rate=60,
        dof_names=("knee", "ankle"),
        root_coord_count=7,
        meta={"smpl_scale": np.float64(1.23456), "execution_provenance": {"ignored": True}},
    )
    path = tmp_path / "state.npz"

    class Context:
        def publish_bytes(self, **arguments):
            assert arguments["kind"] == "retarget_state"
            path.write_bytes(arguments["payload"])

    publish_retarget_state(
        Context(), motion, yellow_foot_z=0.15, export_context={"calibration_joint_q": {"knee": 0.3}}
    )
    restored, foot_z, context = load_retarget_state(path)
    np.testing.assert_array_equal(restored.joint_q, coordinates)
    assert restored.sample_rate == 60
    assert restored.meta == {"smpl_scale": 1.23456}
    assert foot_z == 0.15
    assert context["calibration_joint_q"]["knee"] == 0.3
    motion.joint_q[0, 0] = np.nan
    with pytest.raises(ValueError, match="finite"):
        publish_retarget_state(Context(), motion)
