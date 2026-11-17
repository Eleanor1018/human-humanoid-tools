# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Portions adapted from soma-retargeter (Apache-2.0).
# See https://github.com/NVIDIA/SOMA-Retargeter and the project root NOTICE.
"""Newton-model construction from hhtools robot presets.

The stage-2 IK pipeline consumes Newton :class:`newton.Model` objects rather
than URDF text.  This module bridges the two worlds:

* :func:`build_newton_model` — take a :class:`URDFRobotModel` and produce a
  ``newton.ModelBuilder`` + compiled :class:`newton.Model`.  We prefer the
  URDF→MJCF path because MuJoCo's parser catches model errors that
  :mod:`yourdfpy` accepts (and Newton's own MJCF loader has been the primary
  validation target in soma-retargeter upstream).  Raw URDF is used as a
  fallback for presets where ``compile_mjcf`` failed.
* :func:`resolve_ik_map` — translate ``robot.yaml``'s ``ik_map`` +
  ``weights`` (flat-string form) into the nested form the pipeline needs
  (``canonical_joint -> (t_body, r_body, t_weight, r_weight, t_offset)``).
  This is also where we surface mismatches between the yaml and the URDF
  (e.g. ``ik_map`` pointing at a link that doesn't exist) with a clear error.

The resolved mapping is opaque to the upper layers except for its
:class:`IKMapping` dataclass; the pipeline consumes it verbatim.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from pathlib import Path

import newton
import warp as wp

# The ik_map types and resolver are solver-independent and live in
# :mod:`hhtools.retarget.ik_mapping`; they are re-exported here so existing
# ``newton_basic.robot_model`` imports keep working.
from hhtools.retarget.ik_mapping import (
    IKMapping,
    IKMappingEntry,
    _leaf,
    floating_base_safe_urdf,
    resolve_ik_map,
)
from hhtools.robot.base import RobotPreset
from hhtools.robot.loader import URDFRobotModel

_log = logging.getLogger(__name__)


__all__ = [
    "IKMapping",
    "IKMappingEntry",
    "NewtonRobotContext",
    "build_newton_model",
    "resolve_ik_map",
]


# --------------------------------------------------------------------------- Newton model


@dataclass
class NewtonRobotContext:
    """Everything the IK pipeline needs from a loaded robot.

    Lifetime: built once per ``(robot, num_envs)`` pair and cached on the
    pipeline object.  The ``builder`` is retained so we can re-run
    :func:`finalize` for a different env count without re-parsing MJCF.
    """

    preset: RobotPreset
    builder: newton.ModelBuilder
    model: newton.Model
    body_labels: list[str]  # leaf names, one per body index in env 0
    body_label_fq: list[str]  # full "env/name" labels
    num_bodies_per_env: int
    num_envs: int
    joint_dof_count: int
    joint_coord_count: int
    # The base joint of the articulation is a free (6-DoF) root joint by
    # default; ``root_coord_count == 7`` means (tx, ty, tz, qx, qy, qz, qw),
    # same layout as our CSV schema.  We surface it so the pipeline /
    # post-processor can slice it out cleanly.
    root_coord_count: int
    mjcf_path: Path | None = None
    used_mjcf: bool = False
    ik_mapping: IKMapping | None = None
    mapping_warnings: tuple[str, ...] = field(default_factory=tuple)


_floating_base_safe_urdf = floating_base_safe_urdf


def build_newton_model(
    robot: URDFRobotModel,
    *,
    num_envs: int = 1,
    prefer_mjcf: bool = False,
    add_ground_plane: bool = True,
) -> NewtonRobotContext:
    """Build a :class:`newton.Model` from a :class:`URDFRobotModel`.

    The caller usually wants ``num_envs=1`` for CLI batch retarget; the IK
    pipeline may pass ``num_envs=len(input_motions)`` if it wants to solve a
    batch in parallel (matches soma's multi-env layout).

    Args:
        robot: Loaded robot with either a compiled MJCF (preferred) or a URDF
            on disk.
        num_envs: Number of replicas of the robot to build into the model —
            one per independent IK problem.
        prefer_mjcf: Deprecated/ignored for body construction — the IK model is
            now always built from the URDF (floating base, no fixed-joint
            collapse) when one is on disk, with MJCF used only as a fallback.
            Kept for backwards compatibility of call sites.
        add_ground_plane: Whether to add a ground plane to the builder (useful
            for collision / rendering; unused by the IK objectives we ship).
    """
    preset = robot.preset
    single_builder = newton.ModelBuilder()

    up_axis = {"X": newton.Axis.X, "Y": newton.Axis.Y, "Z": newton.Axis.Z}.get(
        preset.up_axis, newton.Axis.Z
    )
    urdf_ok = preset.urdf_path is not None and preset.urdf_path.is_file()
    used_mjcf = False
    mjcf_path: Path | None = None

    def _load_urdf(builder: "newton.ModelBuilder") -> None:
        safe_urdf = _floating_base_safe_urdf(preset.urdf_path)
        try:
            builder.add_urdf(
                str(safe_urdf),
                up_axis=up_axis,
                floating=True,
                collapse_fixed_joints=False,
                enable_self_collisions=False,
            )
        finally:
            if safe_urdf != preset.urdf_path:
                try:
                    safe_urdf.unlink()
                except OSError:
                    pass

    # The Newton IK model has two hard requirements that the URDF path satisfies
    # and the MJCF path does NOT for arbitrary humanoids:
    #
    #   1. A *floating base* so the retarget can move the robot's root.  MuJoCo's
    #      URDF→MJCF importer welds the URDF root link to the world (fixed base),
    #      which silently breaks root-motion retargeting.
    #   2. Every URDF link addressable as a body so the ``ik_map`` resolves
    #      regardless of link-naming conventions.  The MJCF importer collapses
    #      fixed-joint children (``base_link`` / ``torso_link`` /
    #      ``*_end_effector_link`` … disappear into their parent), so a perfectly
    #      valid ik_map slot like ``hips -> base_link`` becomes unresolvable —
    #      the "robot preset has no usable ik_map" failure on novel humanoids.
    #
    # ``add_urdf(floating=True, collapse_fixed_joints=False)`` keeps both, so we
    # load the URDF directly and only fall back to MJCF when no URDF is on disk
    # (or it fails to parse).  ``prefer_mjcf`` is retained for backwards
    # compatibility but now only forces MJCF when a URDF is unavailable.
    loaded = False
    if urdf_ok:
        try:
            _load_urdf(single_builder)
            loaded = True
        except Exception:
            single_builder = newton.ModelBuilder()
            loaded = False

    if not loaded and robot.mjcf_xml:
        mjcf_path = robot.write_mjcf()
        try:
            single_builder.add_mjcf(str(mjcf_path))
            used_mjcf = True
            loaded = True
        except Exception:
            single_builder = newton.ModelBuilder()
            used_mjcf = False
            loaded = False

    if not loaded:
        if not urdf_ok:
            raise FileNotFoundError(
                f"preset {preset.name!r} has no URDF or MJCF we can load"
            )
        _load_urdf(single_builder)

    # ---- replicate for num_envs ------------------------------------------------
    num_bodies_per_env = single_builder.body_count
    joint_dof_count = single_builder.joint_dof_count
    joint_coord_count = single_builder.joint_coord_count

    multi_builder = newton.ModelBuilder()
    for _ in range(max(1, num_envs)):
        multi_builder.add_builder(single_builder, xform=wp.transform_identity())
    if add_ground_plane:
        multi_builder.add_ground_plane()

    model = multi_builder.finalize(requires_grad=True)

    # Newton's body_label holds ``env<i>/body_name`` entries; we want the leaf
    # names for the *first* env to resolve ``ik_map`` slots against.  The
    # soma upstream uses the same convention.
    all_labels = list(model.body_label)
    # Some Newton builds have 1 extra body for the ground plane — drop any
    # label that isn't part of an articulation by slicing to exactly the
    # expected per-env slice.  We only need env-0 links for mapping.
    env0_fq = all_labels[:num_bodies_per_env]
    env0_leaf = [_leaf(n) for n in env0_fq]

    mapping_warnings: list[str] = []
    ik_mapping: IKMapping | None = None
    try:
        ik_mapping = resolve_ik_map(preset, env0_leaf)
    except KeyError as err:
        # Don't fail model build — the UI wants to render the robot even if
        # the ik_map is malformed.  The pipeline will refuse to run later.
        mapping_warnings.append(str(err))

    return NewtonRobotContext(
        preset=preset,
        builder=single_builder,
        model=model,
        body_labels=env0_leaf,
        body_label_fq=env0_fq,
        num_bodies_per_env=num_bodies_per_env,
        num_envs=max(1, num_envs),
        joint_dof_count=joint_dof_count,
        joint_coord_count=joint_coord_count,
        # Newton floating-base root joint puts 7 coords (xyz + xyzw) first.
        root_coord_count=7,
        mjcf_path=mjcf_path,
        used_mjcf=used_mjcf,
        ik_mapping=ik_mapping,
        mapping_warnings=tuple(mapping_warnings),
    )
