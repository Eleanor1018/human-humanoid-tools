"""hhtools robot preset → ``frax.Robot`` adapter.

Bridges three conventions:

* **Frames.**  ``ik_map`` names URDF links; frax tracks joint frames and
  merges links attached by fixed joints into their parent.  Every link is
  expressed as ``(frax joint index, T_joint_link)``; the root link maps to the
  floating base frame.
* **Joint order.**  hhtools ``joint_q`` columns follow ``robot.dof_names()``
  (``robot.yaml`` ``dof_order``); frax orders joints by the kinematic tree.
* **Root quaternion.**  hhtools stores ``xyzw``, frax ``wxyz``.
"""

from __future__ import annotations

import logging
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from numpy.typing import NDArray

from hhtools.retarget.frax_backend._urdf import origin_transform, zero_pose_link_transforms
from hhtools.retarget.ik_mapping import floating_base_safe_urdf
from hhtools.robot.loader import URDFRobotModel

_log = logging.getLogger(__name__)

__all__ = ["FraxRobotModel", "build_frax_robot_model"]


@dataclass
class FraxRobotModel:
    """A ``frax.Robot`` plus the hhtools ↔ frax mappings for one preset."""

    robot: object  # frax.Robot
    preset_name: str
    dof_names: tuple[str, ...]
    #: frax actuated-joint index for every hhtools DOF column.
    dof_to_frax: NDArray[np.int64]
    #: link name → (frax joint index, link frame expressed in that joint frame).
    link_frames: dict[str, tuple[int, NDArray[np.float64]]]
    #: frax joint index → its child link (the link whose frame it is).
    joint_link: dict[int, str]
    has_collision: bool
    has_self_collision: bool
    collision_source: str
    #: Flat collision-sphere indices used by the floor constraint.
    floor_sphere_idxs: tuple[int, ...] = ()
    num_collision_spheres: int = 0
    num_self_collision_pairs: int = 0
    #: Content key the pipeline's model cache stored this model under.
    cache_key: tuple = ()
    #: frax actuated-joint indices left out of ``dof_order``.  They are not
    #: exported, so the solver holds them at 0, where playback FK puts them.
    frozen_joints: tuple[int, ...] = ()

    @property
    def nq(self) -> int:
        return int(self.robot.nq)

    @property
    def nv(self) -> int:
        return int(self.robot.nv)

    @property
    def nv_floating(self) -> int:
        return int(self.robot.nv_floating)

    def link_frame(self, link: str) -> tuple[int, NDArray[np.float64]]:
        try:
            return self.link_frames[link]
        except KeyError as err:
            raise KeyError(f"link {link!r} is not part of robot {self.preset_name!r}") from err

    def frax_q_from_joint_q(self, joint_q: NDArray) -> NDArray[np.float64]:
        """hhtools ``(F, 7 + ndof)`` (xyzw root) → frax ``(F, nq)`` (wxyz root)."""
        jq = np.atleast_2d(np.asarray(joint_q, dtype=np.float64))
        q = np.tile(
            np.asarray(self.robot.default_configuration, dtype=np.float64), (jq.shape[0], 1)
        )
        q[:, 0:3] = jq[:, 0:3]
        q[:, 3] = jq[:, 6]
        q[:, 4:7] = jq[:, 3:6]
        q[:, 7 + self.dof_to_frax] = jq[:, 7 : 7 + len(self.dof_names)]
        return q

    def joint_q_from_frax_q(self, q: NDArray) -> NDArray[np.float32]:
        """frax ``(F, nq)`` → hhtools ``(F, 7 + ndof)`` in ``dof_names`` order."""
        qq = np.atleast_2d(np.asarray(q, dtype=np.float64))
        out = np.empty((qq.shape[0], 7 + len(self.dof_names)), dtype=np.float64)
        out[:, 0:3] = qq[:, 0:3]
        out[:, 3:6] = qq[:, 4:7]
        out[:, 6] = qq[:, 3]
        out[:, 7:] = qq[:, 7 + self.dof_to_frax]
        return out.astype(np.float32)


def _link_frames(
    urdf_root: ET.Element,
    joint_name_to_index: dict[str, int],
    floating_index: int,
) -> tuple[dict[str, tuple[int, NDArray[np.float64]]], dict[int, str]]:
    joint_of_child = {
        j.find("child").get("link"): j
        for j in urdf_root.findall("joint")
        if j.find("child") is not None
    }
    frames: dict[str, tuple[int, NDArray[np.float64]]] = {}
    joint_link: dict[int, str] = {}
    for link_el in urdf_root.findall("link"):
        name = link_el.get("name")
        T = np.eye(4)
        cur = name
        while True:
            joint = joint_of_child.get(cur)
            if joint is None:  # root link → floating base frame
                index = floating_index
                break
            if joint.get("type") != "fixed" and joint.get("name") in joint_name_to_index:
                index = joint_name_to_index[joint.get("name")]
                break
            T = origin_transform(joint) @ T
            cur = joint.find("parent").get("link")
        frames[name] = (index, T)
        if index == floating_index and joint_of_child.get(name) is None:
            joint_link[index] = name
    for child, joint in joint_of_child.items():
        if joint.get("type") != "fixed" and joint.get("name") in joint_name_to_index:
            joint_link[joint_name_to_index[joint.get("name")]] = child
    return frames, joint_link


def build_frax_robot_model(
    robot: URDFRobotModel,
    *,
    collision=None,
) -> FraxRobotModel:
    """Build the frax model for ``robot``.

    Args:
        robot: Loaded hhtools robot.
        collision: Optional :class:`~hhtools.retarget.frax_backend.collision.CollisionSpec`.
            Its spheres are attached to the same joint frames the IK tasks use.
    """
    from hhtools.retarget.frax_backend._jax_env import import_frax

    frax = import_frax()
    preset = robot.preset
    if preset.urdf_path is None or not Path(preset.urdf_path).is_file():
        raise FileNotFoundError(f"robot {preset.name!r} has no URDF on disk")

    urdf_path = Path(preset.urdf_path)
    safe = floating_base_safe_urdf(urdf_path)
    try:
        kinematic = frax.Robot(str(safe), floating_base="quaternion")
        urdf_root = ET.parse(safe).getroot()
        index = dict(kinematic.joint_name_to_index)
        floating_index = int(kinematic.nv_floating) - 1
        frames, joint_link = _link_frames(urdf_root, index, floating_index)

        layout = None
        if collision is not None and collision.spheres:
            from hhtools.retarget.frax_backend.collision import to_frax_collision_data

            layout = to_frax_collision_data(
                collision,
                frames,
                int(kinematic.nv),
                zero_pose=zero_pose_link_transforms(urdf_root),
            )
        model = (
            kinematic
            if layout is None or layout.num_spheres == 0
            else frax.Robot(
                str(safe), collision_data=layout.collision_data, floating_base="quaternion"
            )
        )
    finally:
        if safe != urdf_path:
            try:
                safe.unlink()
            except OSError:
                pass

    frax_actuated = list(model.joint_names[model.nv_floating :])
    dof_names = tuple(robot.dof_names())
    missing = [name for name in dof_names if name not in frax_actuated]
    if missing:
        raise ValueError(
            f"robot {preset.name!r}: frax could not model DOF(s) {missing} "
            "(frax supports revolute, prismatic and fixed joints)"
        )
    dof_to_frax = np.asarray([frax_actuated.index(name) for name in dof_names], dtype=np.int64)
    exported = set(int(i) for i in dof_to_frax)
    frozen = tuple(i for i in range(len(frax_actuated)) if i not in exported)
    if frozen:
        _log.info(
            "robot %r: holding joints outside dof_order at 0 in FRAX: %s",
            preset.name,
            [frax_actuated[i] for i in frozen],
        )
    return FraxRobotModel(
        robot=model,
        preset_name=preset.name,
        dof_names=dof_names,
        dof_to_frax=dof_to_frax,
        link_frames=frames,
        joint_link=joint_link,
        has_collision=bool(model.has_collision_data),
        has_self_collision=bool(model.has_collision_data and model.has_sc_data),
        frozen_joints=frozen,
        collision_source=collision.source if model is not kinematic else "none",
        floor_sphere_idxs=layout.floor_sphere_idxs if model is not kinematic else (),
        num_collision_spheres=layout.num_spheres if model is not kinematic else 0,
        num_self_collision_pairs=layout.num_self_collision_pairs if model is not kinematic else 0,
    )
