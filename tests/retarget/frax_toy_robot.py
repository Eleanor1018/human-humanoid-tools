"""A small primitive-geometry humanoid for the FRAX backend tests (no mesh files)."""

from __future__ import annotations

from pathlib import Path

_INERTIAL = (
    '<inertial><origin xyz="0 0 0"/><mass value="1.0"/>'
    '<inertia ixx="0.01" ixy="0" ixz="0" iyy="0.01" iyz="0" izz="0.01"/></inertial>'
)


def _link(name: str, geometry: str = "", origin: str = "0 0 0") -> str:
    collision = (
        f'<collision><origin xyz="{origin}"/><geometry>{geometry}</geometry></collision>'
        if geometry
        else ""
    )
    return f'<link name="{name}">{_INERTIAL}{collision}</link>'


def _joint(name, parent, child, xyz, *, kind="revolute", axis="0 1 0", lower=-1.5, upper=1.5):
    limit = (
        f'<limit lower="{lower}" upper="{upper}" effort="50" velocity="20"/>'
        if kind != "fixed"
        else ""
    )
    axis_el = f'<axis xyz="{axis}"/>' if kind != "fixed" else ""
    return (
        f'<joint name="{name}" type="{kind}"><parent link="{parent}"/><child link="{child}"/>'
        f'<origin xyz="{xyz}" rpy="0 0 0"/>{axis_el}{limit}</joint>'
    )


def toy_humanoid_urdf() -> str:
    parts = [
        _link("pelvis", '<box size="0.2 0.25 0.15"/>'),
        _link("torso", '<box size="0.2 0.3 0.3"/>', "0 0 0.2"),
        _link("head", '<sphere radius="0.08"/>'),
        _joint("waist_yaw_joint", "pelvis", "torso", "0 0 0.1", axis="0 0 1"),
        _joint("head_joint", "torso", "head", "0 0 0.45", kind="fixed"),
    ]
    for side, s in (("left", 1.0), ("right", -1.0)):
        parts += [
            _link(f"{side}_shoulder_link", '<sphere radius="0.04"/>'),
            _link(
                f"{side}_upper_arm_link", '<cylinder radius="0.04" length="0.25"/>', "0 0 -0.125"
            ),
            _link(f"{side}_forearm_link", '<cylinder radius="0.035" length="0.22"/>', "0 0 -0.11"),
            _link(f"{side}_hand_link", '<box size="0.06 0.06 0.06"/>'),
            _link(f"{side}_hip_link", '<sphere radius="0.05"/>'),
            _link(f"{side}_thigh_link", '<cylinder radius="0.06" length="0.35"/>', "0 0 -0.175"),
            _link(f"{side}_shin_link", '<cylinder radius="0.05" length="0.35"/>', "0 0 -0.175"),
            _link(f"{side}_foot_link", '<box size="0.2 0.08 0.04"/>', "0.04 0 -0.04"),
            _joint(
                f"{side}_shoulder_pitch_joint",
                "torso",
                f"{side}_shoulder_link",
                f"0 {0.2 * s} 0.35",
            ),
            _joint(
                f"{side}_shoulder_roll_joint",
                f"{side}_shoulder_link",
                f"{side}_upper_arm_link",
                "0 0 0",
                axis="1 0 0",
            ),
            _joint(
                f"{side}_elbow_joint", f"{side}_upper_arm_link", f"{side}_forearm_link", "0 0 -0.25"
            ),
            _joint(
                f"{side}_hand_joint",
                f"{side}_forearm_link",
                f"{side}_hand_link",
                "0 0 -0.22",
                kind="fixed",
            ),
            _joint(f"{side}_hip_pitch_joint", "pelvis", f"{side}_hip_link", f"0 {0.1 * s} -0.1"),
            _joint(
                f"{side}_hip_roll_joint",
                f"{side}_hip_link",
                f"{side}_thigh_link",
                "0 0 0",
                axis="1 0 0",
            ),
            _joint(
                f"{side}_knee_joint",
                f"{side}_thigh_link",
                f"{side}_shin_link",
                "0 0 -0.35",
                lower=0.0,
                upper=2.5,
            ),
            _joint(f"{side}_ankle_joint", f"{side}_shin_link", f"{side}_foot_link", "0 0 -0.35"),
        ]
    return '<?xml version="1.0"?>\n<robot name="toy">' + "".join(parts) + "</robot>\n"


DOF_ORDER = (
    "waist_yaw_joint",
    *(
        f"{side}_{j}_joint"
        for side in ("right", "left")  # deliberately not URDF order
        for j in (
            "shoulder_pitch",
            "shoulder_roll",
            "elbow",
            "hip_pitch",
            "hip_roll",
            "knee",
            "ankle",
        )
    ),
)

IK_MAP = {
    "hips": "pelvis",
    "chest": "torso",
    "head": "head",
    **{
        f"{side}_{slot}": f"{side}_{link}"
        for side in ("left", "right")
        for slot, link in (
            ("shoulder", "shoulder_link"),
            ("elbow", "forearm_link"),
            ("wrist", "hand_link"),
            ("hip", "thigh_link"),
            ("knee", "shin_link"),
            ("ankle", "foot_link"),
        )
    },
}


def write_toy_robot(root: Path):
    """Write the URDF under ``root`` and return a loaded ``URDFRobotModel``."""
    from hhtools.robot.base import RobotPreset
    from hhtools.robot.loader import load_robot

    root.mkdir(parents=True, exist_ok=True)
    urdf = root / "toy.urdf"
    urdf.write_text(toy_humanoid_urdf(), encoding="utf-8")
    preset = RobotPreset(
        name="toy",
        display_name="Toy",
        root_dir=root,
        urdf_path=urdf,
        ik_map=dict(IK_MAP),
        feet={"left_contact_link": "left_foot_link", "right_contact_link": "right_foot_link"},
        dof_order=DOF_ORDER,
    )
    return load_robot(preset)
