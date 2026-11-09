# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Portions adapted from soma-retargeter (Apache-2.0).
# See https://github.com/NVIDIA/SOMA-Retargeter and the project root NOTICE.
"""Solver-independent front and back halves of the IK retarget pipelines.

Every IK backend runs the same three stages::

    Motion --(scaler, feet stabilizer, canonical rename, lateral narrowing)-->
           (F, M, 7) IK targets                                  [front half]
           --(backend IK solve)--> (F, coord) joint_q             [backend]
           --(clamp, rate limit, heading undo, foot clamps,
              clip floor snap, roll narrowing)--> RetargetedMotion [back half]

:class:`IKPipelineBase` owns the front and back halves so the Newton and FRAX
backends share calibration, ``robot.yaml`` semantics, the yellow overlay,
exports and result diagnostics, and differ only in the solve.  This module
must not import Newton, Warp or JAX.

Subclass contract:

* set ``self.ik_mapping`` through :meth:`IKPipelineBase._init_ik_mapping`;
* provide ``_root_coord_count``, ``_joint_coord_count``, ``_ik_body_labels``
  (addressable link names) and ``_used_mjcf``;
* implement :meth:`execution_provenance` and ``_run_with_active_ik_map``.
"""

from __future__ import annotations

import logging
import os
from collections.abc import Callable
from dataclasses import dataclass, field

import numpy as np
from numpy.typing import NDArray

from hhtools.core.math import quaternion as Q
from hhtools.core.motion import Motion
from hhtools.retarget.ik_mapping import IKMapping, IKMappingEntry
from hhtools.retarget.newton_basic.config import (
    FeetStabilizerConfig,
    ScalerConfig,
)
from hhtools.retarget.newton_basic.feet_stabilizer import FeetStabilizer
from hhtools.retarget.newton_basic.heading_align import align_effector_tensor_to_source_heading
from hhtools.retarget.newton_basic.human_aliases import (
    effectors_to_canonical_table,
    is_smpl_like,
)
from hhtools.retarget.newton_basic.joint_limit_clamper import JointLimitClamper
from hhtools.retarget.newton_basic.scaler import HumanToRobotScaler
from hhtools.retarget.retarget_result import IKTargetTrace, RetargetedMotion
from hhtools.robot.loader import URDFRobotModel

__all__ = [
    "IKPipelineBase",
    "PipelineConfig",
    "PreparedIKTargets",
    "ScaledMotionPreview",
]

_log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Shared helpers and configuration
# ---------------------------------------------------------------------------


def _default_ik_use_cuda_graph() -> bool:
    raw = os.environ.get("HHTOOLS_IK_USE_CUDA_GRAPH", "1").strip().lower()
    return raw not in ("0", "false", "no", "off")


def _is_position_only(motion: Motion) -> bool:
    """True when the source motion carries no meaningful quaternion data.

    Holosoma and similar position-only mocap rigs fill ``quaternions`` with
    xyzw identity ``[0, 0, 0, 1]``.  Detecting this lets the pipeline
    avoid using the (constant) quaternion targets that would otherwise pin
    the robot to a fixed heading.
    """
    q = np.asarray(motion.quaternions, dtype=np.float32)
    identity = np.zeros(4, dtype=np.float32)
    identity[3] = 1.0
    return float(np.abs(q - identity[None, None, :]).max()) < 0.05


def _compute_perframe_yaw(
    ik_targets: NDArray,
    entries,
) -> NDArray | None:
    """Derive per-frame Z-axis yaw quaternion from the shoulder/hip axis.

    Returns ``(F, 4)`` xyzw quaternions or ``None`` when the required
    landmarks cannot be found in *entries*.

    Uses both shoulder and hip axes when available, averaging them for
    robustness against arm-swing noise.
    """
    shoulder_l = shoulder_r = hip_l = hip_r = None
    for i, e in enumerate(entries):
        if e.canonical_name == "left_shoulder":
            shoulder_l = i
        elif e.canonical_name == "right_shoulder":
            shoulder_r = i
        elif e.canonical_name == "left_hip":
            hip_l = i
        elif e.canonical_name == "right_hip":
            hip_r = i

    pairs: list[tuple[int, int]] = []
    if shoulder_l is not None and shoulder_r is not None:
        pairs.append((shoulder_l, shoulder_r))
    if hip_l is not None and hip_r is not None:
        pairs.append((hip_l, hip_r))
    if not pairs:
        return None

    F = ik_targets.shape[0]
    up = np.array([[0.0, 0.0, 1.0]], dtype=np.float32)
    all_angles: list[NDArray] = []

    for l_idx, r_idx in pairs:
        p_l = ik_targets[:, l_idx, :3].copy()
        p_r = ik_targets[:, r_idx, :3].copy()
        lr = p_l - p_r
        lr[:, 2] = 0.0
        fwd = np.cross(lr, np.broadcast_to(up, (F, 3)))
        fwd[:, 2] = 0.0
        fwd_norm = np.linalg.norm(fwd, axis=1, keepdims=True)
        fwd = fwd / np.maximum(fwd_norm, 1e-6)
        all_angles.append(np.arctan2(fwd[:, 1], fwd[:, 0]))

    if len(all_angles) == 2:
        # Average shoulder and hip yaw via unit-vector mean to handle
        # the ±π wrap-around correctly.
        cx = np.cos(all_angles[0]) + np.cos(all_angles[1])
        sy = np.sin(all_angles[0]) + np.sin(all_angles[1])
        angles = np.arctan2(sy, cx).astype(np.float32)
    else:
        angles = all_angles[0].astype(np.float32)

    # Temporal smoothing: 3-frame causal moving average to reduce
    # high-frequency jitter from position noise while preserving
    # intentional heading changes.
    if F >= 3:
        padded = np.pad(angles, 1, mode="edge")
        kernel = np.ones(3, dtype=np.float32) / 3.0
        angles = np.convolve(padded, kernel, mode="valid").astype(np.float32)

    yaw_q = np.zeros((F, 4), dtype=np.float32)
    yaw_q[:, 2] = np.sin(angles / 2)  # z (xyzw)
    yaw_q[:, 3] = np.cos(angles / 2)  # w
    return yaw_q


def _compute_endpoint_offset(
    mj_model,
    link_name: str,
    endpoint_type: str,
) -> tuple[float, float, float] | None:
    """Derive a toe-tip or hand-end local offset from MuJoCo collision geometry.

    Re-uses the collision analysis from
    :func:`~hhtools.retarget.interaction_mesh.contact_points.build_contact_mpc_points`
    but returns a single ``(x, y, z)`` offset in the link's body frame.

    * ``endpoint_type="toe"``:  most forward (+X) sole-level point.
    * ``endpoint_type="hand_end"``:  farthest collision point from the link
      origin (maximises reach).

    Returns ``None`` when the link has no usable collision geometry.
    """
    from hhtools.retarget.interaction_mesh.contact_points import (
        _body_collision_offsets,
        _pick_extreme,
    )

    pts = _body_collision_offsets(mj_model, link_name)
    if pts.shape[0] == 0:
        return None

    if endpoint_type == "toe":
        z_low = float(np.min(pts[:, 2]))
        sole = pts[pts[:, 2] <= z_low + 0.03]
        use = sole if sole.shape[0] >= 2 else pts
        tip = _pick_extreme(use, 0, 1.0)
    else:
        tip = pts[int(np.argmax(np.linalg.norm(pts, axis=1)))].copy()

    off = (float(tip[0]), float(tip[1]), float(tip[2]))
    if np.linalg.norm(tip) < 1e-4:
        return None
    return off


@dataclass
class PipelineConfig:
    """Knobs for :class:`NewtonBasicPipeline`.

    Attributes:
        ik_iterations: Newton IK Levenberg-Marquardt iterations per frame.
            Defaults mirror the upstream G1 config; lower values (~8) trade
            accuracy for speed in preview modes.
        joint_limit_weight: Weight of the hard-margin
            :class:`newton.ik.IKObjectiveJointLimit` added to the solver.
        smooth_joint_filter_weight: Weight of the soft
            :class:`IKSmoothJointFilter` (midpoint pull).  Set to 0 to
            disable.  Default ``5.5`` matches upstream soma-retargeter
            RP1 / G1 configs — the joint-filter regularises the
            redundant yaw / outer-gimbal DOFs that hhtools' shoulder and
            hip ik_map targets (roll_link, the middle of the gimbal)
            leave in the null space.  With weight 0 the solver picks any
            pose in that null space and non-rest clips stabilise at
            wildly rotated postures (e.g. RP1 hip_yaw pegged at 43° on
            a stand-still pickup clip).
        smooth_joint_filter_masks: Optional override for the per-link
            mask dict used by :class:`IKSmoothJointFilter`.  When
            ``None``, the pipeline falls back to
            ``robot.preset.smooth_joint_filter_masks`` from the robot
            yaml (set on RP1 & G1 to match the soma mask schedule).
            When an empty dict is explicitly passed, every joint coord
            is regularised uniformly (weight=1.0 on all coords).
        max_joint_velocity: If > 0, rate-limit non-root DOFs between
            successive frames (radians / second).  Keeps CSVs physically
            playable on a real robot.
        max_root_angular_velocity: Rate-limit for the floating-base root's
            4-component quaternion tail (radians / second).  Uses the same
            cap as ``max_joint_velocity`` when unset.
        apply_feet_stabilizer: Whether to apply :class:`FeetStabilizer`
            constraints to the scaled effectors before IK.  Disabled by
            default because the stage-1 defaults don't configure foot-plant
            thresholds — users that want ground-contact enforcement should
            pass a fully-populated :class:`FeetStabilizerConfig`.
        ik_use_cuda_graph: When ``True`` and the Warp device is CUDA, record
            one IK ``step`` CUDA graph (soma-style) and replay it each frame
            after ``set_target_*``.  Ignored on CPU; capture errors log a
            warning and fall back to eager ``step``.
    """

    ik_iterations: int = 24
    joint_limit_weight: float = 10.0
    smooth_joint_filter_weight: float = 5.5
    smooth_joint_filter_masks: dict[str, float] | None = None
    max_joint_velocity: float = 0.0
    max_root_angular_velocity: float = 0.0
    # Multiplier on the *source* root angular speed used as the per-frame
    # root-rotation rate cap (in addition to ``max_root_angular_velocity``
    # as a floor).  Per-frame Newton IK has no temporal coupling, so near
    # singular / redundant trunk poses (somersaults, cartwheels) the LM
    # solver can hop to a different null-space branch and teleport the
    # floating-base orientation for a single frame even though the source
    # root barely rotated.  Capping the solved root's frame-to-frame
    # rotation at ``max(max_root_angular_velocity, source_speed * mult)``
    # removes those artefact spikes while leaving genuine fast rotation
    # (the actual flip, where the source is also spinning) untouched.
    # ``0`` disables the source-relative cap (legacy fixed-cap behaviour).
    root_angular_velocity_source_multiplier: float = 1.5
    apply_feet_stabilizer: bool = False
    # Warm-up frames prepended to the IK target sequence.  Every prepended
    # frame is a copy of the clip's **frame 0** effector target, so the
    # solver (which warm-starts from its previous joint_q every frame)
    # gets ``num_initialization_frames`` extra passes on a static pose
    # before the real motion begins.  This is the pattern soma-retargeter
    # uses to hide the "first frame looks weird because IK hasn't
    # converged yet" artefact: by the time the solver hits motion
    # frame 0 for real, it's already had N passes to settle into a
    # steady-state configuration close to the target.  Trimmed from
    # :class:`RetargetedMotion` output so the user sees exactly the
    # input duration back — the initialization is purely internal.
    #
    # Default 0 keeps the behaviour identical to previous hhtools
    # releases; set to ~16–32 for production retargets (soma uses 20).
    num_initialization_frames: int = 0
    # Stabilization frames appended after the last real motion frame,
    # same mechanism as ``num_initialization_frames``.  Useful when the
    # clip ends on a sharp pose change (jump landings, stops) and the
    # solver needs a few more passes to converge the final pose.
    # Trimmed from output like the init frames.
    num_stabilization_frames: int = 0
    # Escape-hatch knob: when ``True``, every ``IKObjectiveRotation``
    # *except* the one attached to the pelvis (canonical ``hips``) is
    # constructed with weight 0 so the solver only chases position
    # targets for the rest of the body; the pelvis is additionally
    # swapped for a world-Z-yaw-only target when
    # :attr:`pelvis_yaw_only_rotation_target` is also set.  Default
    # ``False`` — the soma-style scaler (see
    # :func:`hhtools.retarget.calibration.calibration.build_scaler_config_soma_style`)
    # emits body-frame-aligned quaternion targets (``q_out = q_source
    # * q_offset``) so full rotation objectives are the right default
    # again.  The knob is retained for two reasons:
    #  1. users running legacy ``scale_anchor="origin"`` configs hand-
    #     authored before the soma-style builder emitted ``"root"`` may
    #     still want to disable rotation objectives if those configs
    #     carry only positional offsets.
    #  2. A/B experiments comparing position-only vs. full objectives
    #     on hard clips (e.g. cartwheels where rotation overshoot is
    #     worse than position-only drift).
    disable_rotation_objectives: bool = False
    # Companion to :attr:`disable_rotation_objectives`.  When both are
    # ``True``, the pelvis rotation target is replaced with the world-
    # Z yaw extracted from the source root quaternion, keeping the
    # robot upright and only tracking heading.  Default ``False`` —
    # disabled together with the parent knob under the soma-style
    # builder.
    pelvis_yaw_only_rotation_target: bool = False
    # Ground-plane capsule collision (soma ``IKObjectiveGroundCollision``).
    ground_collision_weight: float = 0.0
    ground_collision_z: float = 0.0
    ground_collision_bodies: tuple[dict, ...] = ()
    ground_collision_dynamic_boost: bool = True
    # When ``False``, skip **all** post-IK foot contact polish (height lift,
    # anti-float, and lateral mesh/ankle clearance).  Batch CSV export of
    # root + DOF only should leave this off — those clamps dominate wall
    # time after GPU IK and are irrelevant if the consumer never uses mesh.
    post_ik_foot_clamps: bool = True
    # After IK (and optional foot clamps): one global root-Z shift so the
    # clip-wide minimum foot **sole** sits on flat ground ``z=0``.  Independent
    # of ``post_ik_foot_clamps`` — keep this on by default so raw CSV exports
    # still touch the floor even when per-frame polish is disabled.
    clip_floor_snap: bool = True
    # Post-IK ``_clamp_solved_foot_heights`` anti-float: when ``False``, only
    # lift the root if solved ankles penetrate the ground plane (soma-style
    # ``_clamp_foot_positions`` lift path).  Xsens mocap clips at high fps
    # oscillate solved ankle height during gait; the rate-limited anti-float
    # correction then pumps root Z and looks like vertical bobbing.
    foot_clamp_anti_float: bool = True
    # When ``False``, skip the ground-penetration *upward* lift entirely:
    # ``_clamp_solved_foot_heights`` no longer raises the floating base when
    # solved ankles dip below the ground plane.  Removes every root-Z bump from
    # that path (useful when the user wants the raw IK trajectory and handles
    # grounding downstream) at the cost of letting feet clip through the floor
    # during fast / inverted motion.  Default ``True`` keeps feet grounded; the
    # rate limiter (``foot_clamp_max_lift_rate``) already removes the spikes
    # without sacrificing ground contact, so prefer that unless you explicitly
    # want no vertical correction at all.
    foot_clamp_anti_penetration: bool = True
    # Max per-frame upward root lift (metres) the ground-penetration path of
    # ``_clamp_solved_foot_heights`` may apply.  The lift used to be unbounded:
    # during flips / cartwheels the "lowest ankle" estimate swings frame to
    # frame, so a single frame could push the whole floating base up by several
    # centimetres and drop it back the next frame — read as the robot suddenly
    # jumping up/down in Z.  Spreading the correction over a few frames removes
    # the teleport while still clearing real penetration (verified: min ankle
    # clearance unchanged).  ``0`` restores the old unbounded immediate lift.
    foot_clamp_max_lift_rate: float = 0.02
    ik_use_cuda_graph: bool = field(default_factory=_default_ik_use_cuda_graph)


@dataclass(frozen=True)
class ScaledMotionPreview:
    """Pre-IK effector preview: the scaler's world-space target trajectory.

    Attributes:
        joint_names: Canonical joint names, in the same order as
            :attr:`NewtonRobotContext.ik_mapping.entries` — so frame-i slice
            ``transforms[i, k, :]`` corresponds to the *k*-th entry of the
            robot's ik_map.
        transforms: ``(F, M, 7)`` array of ``(x, y, z, qx, qy, qz, qw)``
            effector targets in world space, after scaler + (optional) feet
            stabilizer + canonical rename.  ``NaN`` columns flag ik_map
            entries that the scaler didn't populate (mismatch between
            ``scaler.joint_scales`` and ``robot.ik_map``).
        source_seg_src / source_seg_dst / source_transforms: optional dense
            skeleton preview — same heading alignment as ``transforms``, but
            one row per :class:`~hhtools.retarget.newton_basic.scaler.HumanToRobotScaler`
            joint in ``source_joint_names`` order, wired with motion-hierarchy
            parent indices so the yellow overlay matches high-DOF mocap rigs.
        source_bead_indices: optional index list for which ``source_transforms`` rows
            get joint beads in the yellow overlay (fingers / toes culled for clarity).
    """

    joint_names: tuple[str, ...]
    transforms: NDArray
    source_joint_names: tuple[str, ...] | None = None
    source_seg_src: NDArray | None = None
    source_seg_dst: NDArray | None = None
    source_transforms: NDArray | None = None
    source_bead_indices: NDArray | None = None

    @property
    def num_frames(self) -> int:
        return int(self.transforms.shape[0])


@dataclass
class PreparedIKTargets:
    """Front-half output handed to a backend solve.

    Attributes:
        ik_targets: ``(n_init + F + n_stab, M, 7)`` solver-frame targets
            (xyz + xyzw) in ``ik_mapping.entries`` order, including warm-up
            and stabilisation padding.
        solved_target_positions: ``(F, M, 3)`` real-frame position targets,
            recorded for result diagnostics.
        source_root_quat: ``(F, 4)`` source pelvis rotation for the
            source-relative root angular-velocity cap, or ``None``.
        hand_ground_drop: Per-frame hands-on-ground drop aligned with
            ``ik_targets`` (padding included), or ``None``.
        n_init / n_stab: Warm-up / stabilisation padding frame counts.
        position_only: Source carries no meaningful quaternions; non-pelvis
            rotation objectives should be disabled.
        scaler: Scaler used to build the targets.
    """

    ik_targets: NDArray
    solved_target_positions: NDArray
    source_root_quat: NDArray | None
    hand_ground_drop: NDArray | None
    n_init: int
    n_stab: int
    position_only: bool
    scaler: HumanToRobotScaler


# ---------------------------------------------------------------------------
# Shared pipeline
# ---------------------------------------------------------------------------


class IKPipelineBase:
    """Front and back halves shared by every IK retarget backend.

    See the module docstring for the subclass contract.  Not thread-safe:
    call ``run`` from a single worker.
    """

    _root_coord_count: int
    _joint_coord_count: int
    _ik_body_labels: list[str]
    _used_mjcf: bool

    def _init_shared(
        self,
        robot: URDFRobotModel,
        *,
        scaler_config: ScalerConfig,
        feet_stabilizer_config: FeetStabilizerConfig | None,
        pipeline_config: PipelineConfig | None,
        human_height: float,
        source_to_canonical: dict[str, str] | None,
    ) -> None:
        self.robot = robot
        self.scaler_config = scaler_config
        self.feet_stabilizer_config = feet_stabilizer_config
        self.config = pipeline_config or PipelineConfig()
        self.human_height = float(human_height)
        self._active_motion_source_format: str = ""
        self._last_cuda_graph_requested = False
        self._last_cuda_graph_used = False
        # Optional explicit source-joint → canonical rename.  When ``None``
        # we auto-detect SMPL-family rigs at ``run`` time.
        self._source_to_canonical_override = source_to_canonical

    def _init_ik_mapping(self, ik_mapping: IKMapping) -> None:
        """Validate the ik_map, add endpoint objectives and build caches.

        Requires ``_ik_body_labels`` (endpoint child links are looked up
        there) to be available.
        """
        robot = self.robot
        if robot.preset.urdf_path is not None and robot.preset.ik_map:
            from hhtools.robot.kinematics import require_valid_ik_map

            require_valid_ik_map(
                robot.preset.urdf_path,
                dict(robot.preset.ik_map),
                robot_name=robot.preset.name,
            )
        self.ik_mapping: IKMapping = ik_mapping

        # Auto-add endpoint objectives (toe, hand-end) so the IK solver
        # tracks the robot's physical extremities, preventing foot
        # penetration and improving hand reach accuracy.
        self._endpoint_entries: tuple[IKMappingEntry, ...] = ()
        _extra = self._build_endpoint_entries()
        if _extra:
            self._endpoint_entries = tuple(_extra)
            self.ik_mapping = IKMapping(
                entries=self.ik_mapping.entries + self._endpoint_entries,
            )
            _log.info(
                "Auto-augmented IK with %d endpoint objectives: %s",
                len(_extra),
                [e.canonical_name for e in _extra],
            )

        # Cache the scaler lazily — we can't build it until we see a source
        # motion (scaler needs the hierarchy).  See :meth:`_build_scaler`.
        self._scaler_by_hierarchy: dict[int, HumanToRobotScaler] = {}
        self._feet_stab_by_hierarchy: dict[int, FeetStabilizer] = {}

        self.clamper = JointLimitClamper.from_robot(robot)
        self._ndof_actuated = len(robot.actuated_joints)

    def execution_provenance(self) -> dict[str, object]:  # pragma: no cover - abstract
        raise NotImplementedError

    def _run_with_active_ik_map(
        self,
        motion: Motion,
        *,
        progress_callback: Callable[[int, int], None] | None = None,
    ) -> RetargetedMotion:  # pragma: no cover - abstract
        raise NotImplementedError

    def _result_meta(self, *, clip_floor_snap_m: float) -> dict[str, object]:
        """``RetargetedMotion.meta`` for a single-clip solve."""
        return {
            "robot": self.robot.preset.name,
            "num_mapped_joints": len(self.ik_mapping.entries),
            "used_mjcf": self._used_mjcf,
            "ik_iterations": self.config.ik_iterations,
            "human_height": self.human_height,
            "clip_floor_snap_m": float(clip_floor_snap_m),
            "execution_provenance": self.execution_provenance(),
        }

    def _effectors_to_canonical_map(
        self,
        scaler: HumanToRobotScaler,
        targets: NDArray,
    ) -> dict[str, NDArray]:
        """Single choke-point: scaler rows → canonical keys (``run`` / batch / preview)."""

        return effectors_to_canonical_table(
            scaler.joint_names,
            targets,
            source_to_canonical=self._source_to_canonical_override,
        )

    def scale_only(self, motion: Motion) -> "ScaledMotionPreview":
        """Run stages 1-3 (scaler → stabilizer → canonical rename) only.

        Returns the world-space effector trajectory aligned with the robot's
        ik_map, *before* IK.  Useful for previewing "what the robot's
        effectors would chase" without paying for the Newton solve — the UI
        uses this to draw a scaled-human skeleton next to the robot so the
        user can eyeball the target envelope.
        """
        self._last_cuda_graph_requested = False
        self._last_cuda_graph_used = False
        motion = self._ensure_z_up(motion)
        if motion.num_frames == 0:
            return ScaledMotionPreview(
                joint_names=tuple(e.canonical_name for e in self.ik_mapping.entries),
                transforms=np.zeros(
                    (0, len(self.ik_mapping.entries), 7), dtype=np.float32
                ),
            )
        scaler = self._build_scaler(motion)
        scaled = scaler.apply(motion)
        targets = scaled.transforms  # (F, M_scaler, 7)
        if self.config.apply_feet_stabilizer and self.feet_stabilizer_config is not None:
            stab = self._build_feet_stabilizer(scaler.joint_names)
            targets = stab.apply(targets)

        canonical_to_target = self._effectors_to_canonical_map(scaler, targets)
        canonical_to_target = self._augment_canonical_targets(
            motion, scaler, targets, canonical_to_target,
        )

        # Preserve ik_map order so downstream users can index alongside
        # ``ik_mapping.entries``.  Missing canonical joints (ik_map references
        # something the scaler didn't produce) become NaN — the previewer can
        # skip or highlight those instead of crashing.
        names_list = [e.canonical_name for e in self.ik_mapping.entries]
        F = targets.shape[0]
        out = np.full((F, len(names_list), 7), np.nan, dtype=np.float32)
        for i, canon in enumerate(names_list):
            tgt = canonical_to_target.get(canon)
            if tgt is not None:
                out[:, i, :] = tgt

        names = tuple(names_list)
        out = self._align_preview_to_source_heading(out)
        return ScaledMotionPreview(joint_names=names, transforms=out)

    @staticmethod
    def _ensure_z_up(motion: Motion) -> Motion:
        """Convert to Z-up if needed; log a warning on mismatch."""
        if motion.up_axis == "Z":
            return motion
        from hhtools.core.coord import to_up_axis
        _log.warning(
            "Motion %r has up_axis=%r; converting to Z-up before retarget.",
            motion.name, motion.up_axis,
        )
        return to_up_axis(motion, "Z")

    @staticmethod
    def _floor_normalize_motion(motion: Motion) -> Motion:
        """Subtract the retarget source floor so IK targets match the overlay.

        Uses :func:`~hhtools.core.grounding.retarget_source_floor_z_world` so
        lie→stand clips (fingertips below feet while lying) do not elevate
        standing foot targets.  Fully prone clips still snap on the all-joint
        minimum.  Terrain/object clips keep the all-joint floor so they stay
        co-aligned with heightfield / prop geometry.
        """
        from dataclasses import replace

        from hhtools.core.grounding import (
            human_source_floor_z_world,
            retarget_source_floor_z_world,
        )

        if motion.terrain is not None or motion.objects:
            z_min = float(human_source_floor_z_world(motion))
        else:
            z_min = float(retarget_source_floor_z_world(motion))
        if abs(z_min) < 1e-6:
            return motion
        pos = np.asarray(motion.positions, dtype=np.float32).copy()
        pos[:, :, 2] -= np.float32(z_min)
        return replace(motion, positions=pos)

    def run(
        self,
        motion: Motion,
        *,
        progress_callback: Callable[[int, int], None] | None = None,
    ) -> RetargetedMotion:
        """Retarget a single ``Motion`` to the target robot.

        Args:
            motion: Source human motion.
            progress_callback: Optional ``fn(frame_done, frame_total)`` invoked
                after each per-frame IK solve.  Exceptions raised by the
                callback are swallowed so a buggy UI doesn't abort the solve.
        """
        motion = self._normalize_input_motion(motion)
        self._active_motion_source_format = str(
            getattr(motion, "source_format", "") or "",
        ).lower()
        if motion.num_frames == 0:
            return RetargetedMotion(
                name=motion.name,
                joint_q=np.zeros((0, self._joint_coord_count), dtype=np.float32),
                sample_rate=motion.framerate,
                dof_names=self.robot.dof_names(),
                meta={
                    "robot": self.robot.preset.name,
                    "execution_provenance": self.execution_provenance(),
                },
            )

        ik_map_restore = self._push_motion_ik_policy(motion)
        try:
            return self._run_with_active_ik_map(
                motion, progress_callback=progress_callback,
            )
        finally:
            if ik_map_restore is not None:
                self.ik_mapping = ik_map_restore

    def _normalize_input_motion(self, motion: Motion) -> Motion:
        """Z-up, MOCAP BVH clip normalisation and floor reference, as ``run`` applies them."""
        motion = self._ensure_z_up(motion)
        from hhtools.retarget.newton_basic.rest_pose import normalize_mocap_bvh_clip

        motion = normalize_mocap_bvh_clip(motion)
        return self._floor_normalize_motion(motion)

    def _push_motion_ik_policy(self, motion: Motion):
        """Drop head/neck IK entries for OmniContact→G1; return prior mapping."""
        from hhtools.retarget.ik_mapping import IKMapping
        from hhtools.robot.ik_map_policy import drop_head_targets_for_motion

        if not drop_head_targets_for_motion(self.robot.preset.name, motion):
            return None
        kept = tuple(
            e for e in self.ik_mapping.entries
            if e.canonical_name not in ("head", "neck")
        )
        if not kept or len(kept) == len(self.ik_mapping.entries):
            return None
        saved = self.ik_mapping
        self.ik_mapping = IKMapping(entries=kept)
        _log.info(
            "OmniContact+G1: dropped head/neck IK targets (%d → %d entries)",
            len(saved.entries), len(kept),
        )
        return saved

    def _ik_target_trace(self, target_positions: NDArray) -> IKTargetTrace:
        """Express solver-frame position targets in the output ``joint_q`` heading.

        Applies the same heading undo as :meth:`_align_root_to_source_heading`.
        Post-IK grounding (foot clamps, clip floor snap) is deliberately *not*
        applied: targets are already floor-referenced, so those root shifts
        are part of the result being evaluated.
        """
        entries = self.ik_mapping.entries
        F, M = target_positions.shape[:2]
        transforms = np.zeros((F, M, 7), dtype=np.float32)
        transforms[:, :, 0:3] = target_positions
        transforms[:, :, 6] = 1.0
        aligned = self._align_preview_to_source_heading(transforms)[:, :, 0:3]
        return IKTargetTrace(
            canonical_names=tuple(e.canonical_name for e in entries),
            t_body_links=tuple(e.t_body_link for e in entries),
            link_offsets=np.asarray([e.t_offset for e in entries], dtype=np.float32).reshape(M, 3),
            positions=np.ascontiguousarray(aligned, dtype=np.float32),
        )

    def _empty_result(self, m: Motion) -> RetargetedMotion:
        return RetargetedMotion(
            name=m.name,
            joint_q=np.zeros(
                (0, self._joint_coord_count), dtype=np.float32
            ),
            sample_rate=m.framerate,
            dof_names=self.robot.dof_names(),
            meta={
                "robot": self.robot.preset.name,
                "execution_provenance": self.execution_provenance(),
            },
        )

    def _build_ik_targets(self, motion: Motion) -> NDArray:
        """Scale a single motion and return padded IK targets ``(F', M, 7)``.

        Applies the scaler, optional feet stabiliser, canonical rename, and
        warm-up / stabilisation padding.  The returned array's frame count
        includes ``num_initialization_frames + real_frames +
        num_stabilization_frames``.

        For position-only source data the pelvis rotation column is
        replaced with per-frame yaw derived from shoulder/hip positions
        (same logic as :meth:`run`, step 3c).
        """
        entries = self.ik_mapping.entries
        scaler = self._build_scaler(motion)
        scaled = scaler.apply(motion)
        targets = scaled.transforms  # (F, M_scaler, 7)

        if self.config.apply_feet_stabilizer and self.feet_stabilizer_config is not None:
            stab = self._build_feet_stabilizer(scaler.joint_names)
            targets = stab.apply(targets)

        canonical_to_target = self._effectors_to_canonical_map(scaler, targets)
        canonical_to_target = self._augment_canonical_targets(
            motion, scaler, targets, canonical_to_target,
        )

        missing = [
            e.canonical_name
            for e in entries
            if e.canonical_name not in canonical_to_target
        ]
        if missing:
            raise KeyError(
                f"robot ik_map references canonical joints not produced by "
                f"the scaler: {missing}. Source joint names: "
                f"{list(scaler.joint_names)}."
            )

        ik_targets = np.stack(
            [canonical_to_target[e.canonical_name] for e in entries],
            axis=1,
        ).astype(np.float32, copy=False)

        from hhtools.robot.retarget_profile import apply_upper_body_lateral_ik_narrowing

        ik_targets = apply_upper_body_lateral_ik_narrowing(
            ik_targets, entries, self.robot.preset,
            robot_model=self.robot,
        )

        # Warm-up / stabilisation padding.
        n_init = max(0, int(self.config.num_initialization_frames))
        n_stab = max(0, int(self.config.num_stabilization_frames))
        if n_init > 0 or n_stab > 0:
            init_block = (
                np.repeat(ik_targets[:1], n_init, axis=0) if n_init > 0
                else ik_targets[:0]
            )
            stab_block = (
                np.repeat(ik_targets[-1:], n_stab, axis=0) if n_stab > 0
                else ik_targets[:0]
            )
            ik_targets = np.concatenate(
                [init_block, ik_targets, stab_block], axis=0
            )

        # Position-only heading injection (batch path).
        if _is_position_only(motion):
            pelvis_idx = next(
                (i for i, e in enumerate(entries) if e.canonical_name in ("hips", "pelvis")),
                None,
            )
            yaw_q = _compute_perframe_yaw(ik_targets, entries)
            if pelvis_idx is not None and yaw_q is not None:
                ik_targets[:, pelvis_idx, 3:7] = yaw_q

        return ik_targets

    def _augment_canonical_targets(
        self,
        motion: Motion,
        scaler: HumanToRobotScaler,
        targets: NDArray,
        canonical_to_target: dict[str, NDArray],
    ) -> dict[str, NDArray]:
        """Add toe / hand-end targets for auto-detected endpoint objectives.

        * **Toe** (``left_foot`` / ``right_foot``):  Most motion formats
          already produce this canonical via the scaler; when absent (reduced
          skeletons like parc_ms), we fall back to the ankle target so the
          objective degrades gracefully to a redundant ankle constraint.
        * **Hand-end** (``left_hand_end`` / ``right_hand_end``):  Always
          synthesized by extrapolating from the wrist along the elbow→wrist
          direction by the robot's physical hand length (from URDF geometry).
        """
        if not self._endpoint_entries:
            return canonical_to_target

        for entry in self._endpoint_entries:
            canon = entry.canonical_name
            if canon in canonical_to_target:
                continue

            if canon in ("left_foot", "right_foot"):
                side = "left" if canon.startswith("left") else "right"
                fallback = canonical_to_target.get(f"{side}_ankle")
                if fallback is not None:
                    canonical_to_target[canon] = fallback.copy()

            elif canon in ("left_hand_end", "right_hand_end"):
                side = "left" if canon.startswith("left") else "right"
                wrist_tgt = canonical_to_target.get(f"{side}_wrist")
                if wrist_tgt is None:
                    continue
                hand_end_tgt = wrist_tgt.copy()
                try:
                    from hhtools.retarget.anatomy import scaled_hand_tip_positions_world

                    tips = scaled_hand_tip_positions_world(motion, scaler, side)
                except Exception:
                    tips = None
                if tips is not None and tips.shape[0] == wrist_tgt.shape[0]:
                    hand_end_tgt[:, :3] = tips
                else:
                    elbow_tgt = canonical_to_target.get(f"{side}_elbow")
                    if elbow_tgt is not None:
                        direction = wrist_tgt[:, :3] - elbow_tgt[:, :3]
                        norms = np.linalg.norm(direction, axis=1, keepdims=True)
                        direction = direction / np.maximum(norms, 1e-6)
                        hand_len = float(np.linalg.norm(entry.t_offset))
                        hand_end_tgt[:, :3] = wrist_tgt[:, :3] + direction * hand_len
                canonical_to_target[canon] = hand_end_tgt

        return canonical_to_target

    _ENDPOINT_SPECS: list[tuple[str, str, str]] = [
        # (parent_canonical, new_canonical, endpoint_type)
        ("left_ankle",  "left_foot",       "toe"),
        ("right_ankle", "right_foot",      "toe"),
        ("left_wrist",  "left_hand_end",   "hand_end"),
        ("right_wrist", "right_hand_end",  "hand_end"),
    ]

    def _build_endpoint_entries(self) -> list[IKMappingEntry]:
        """Auto-detect toe / hand-end offsets and create supplementary IK entries.

        For each ankle/wrist entry in the existing ``ik_map``:

        1. If the URDF has a child link *and* it appears in the Newton body
           list, target that child link directly (zero offset).
        2. Otherwise derive a local offset from MuJoCo collision geometry
           (same analysis as :func:`build_contact_mpc_points`) and attach it
           to the parent (ankle/wrist) link.
        3. Skip silently when no usable geometry is available.
        """
        existing = {e.canonical_name for e in self.ik_mapping.entries}
        mj_model = self.robot.mujoco_model
        extra: list[IKMappingEntry] = []
        body_set = set(self._ik_body_labels)

        for parent_canon, new_canon, etype in self._ENDPOINT_SPECS:
            if new_canon in existing:
                continue
            parent = next(
                (e for e in self.ik_mapping.entries if e.canonical_name == parent_canon),
                None,
            )
            if parent is None:
                continue

            child_link = self._find_urdf_child_link(parent.t_body_link)
            if child_link and child_link in body_set:
                child_idx = self._ik_body_labels.index(child_link)
                extra.append(IKMappingEntry(
                    canonical_name=new_canon,
                    t_body_link=child_link,
                    r_body_link=child_link,
                    t_body_index=child_idx,
                    r_body_index=child_idx,
                    t_weight=1.0 if etype == "toe" else 0.5,
                    r_weight=0.0,
                ))
                continue

            if mj_model is None:
                continue
            offset = _compute_endpoint_offset(mj_model, parent.t_body_link, etype)
            if offset is None:
                continue
            extra.append(IKMappingEntry(
                canonical_name=new_canon,
                t_body_link=parent.t_body_link,
                r_body_link=parent.r_body_link,
                t_body_index=parent.t_body_index,
                r_body_index=parent.r_body_index,
                t_weight=1.0 if etype == "toe" else 0.5,
                r_weight=0.0,
                t_offset=offset,
            ))

        return extra

    def _find_urdf_child_link(self, link_name: str) -> str | None:
        """Return the first child link of *link_name* in the URDF, or ``None``."""
        link_info = next((lk for lk in self.robot.links if lk.name == link_name), None)
        if link_info is None or not link_info.child_joint_names:
            return None
        for jname in link_info.child_joint_names:
            joint = next((j for j in self.robot.joints if j.name == jname), None)
            if joint is not None:
                return joint.child_link
        return None

    def _postprocess_joint_q(
        self,
        joint_q_all: NDArray,
        motion: Motion,
        *,
        source_root_quat: NDArray | None = None,
    ) -> RetargetedMotion:
        """Clamp, rate-limit, align and wrap a raw ``(F, coord)`` array.

        ``source_root_quat`` is the per-frame source pelvis rotation (real
        frames, ``(F, 4)`` xyzw) used to make the root angular-velocity cap
        source-relative — without it the cap collapses to the fixed floor and
        genuine fast rotation (flips) gets clamped.  See :meth:`_rate_limit`.
        """
        root7 = joint_q_all[:, : self._root_coord_count]
        dof = joint_q_all[:, self._root_coord_count :]
        n_clamp = min(dof.shape[1], self._ndof_actuated)
        if n_clamp > 0:
            dof[:, :n_clamp] = self.clamper.apply(dof[:, :n_clamp])

        if self.config.max_joint_velocity > 0.0:
            joint_q_all = self._rate_limit(
                root7=root7, dof=dof, framerate=motion.framerate,
                source_root_quat=source_root_quat,
            )
        else:
            joint_q_all = np.concatenate([root7, dof], axis=1)

        csv_width = self._root_coord_count + self._ndof_actuated
        jq_out = joint_q_all[:, :csv_width].astype(np.float32, copy=False)
        jq_out = self._align_root_to_source_heading(jq_out)
        jq_out = self._rescale_root_displacement(jq_out)
        if self.config.post_ik_foot_clamps:
            jq_out = self._clamp_solved_foot_heights(jq_out)
            jq_out = self._clamp_solved_foot_lateral(jq_out)

        clip_floor_snap_m = 0.0
        if bool(getattr(self.config, "clip_floor_snap", True)):
            from hhtools.retarget.clip_ground_snap import snap_joint_q_clip_floor

            jq_out, clip_floor_snap_m = snap_joint_q_clip_floor(
                self.robot,
                jq_out,
                root_coord_count=self._root_coord_count,
                ground_z=0.0,
            )

        from hhtools.robot.retarget_profile import apply_upper_body_roll_narrowing_post_ik

        jq_out = apply_upper_body_roll_narrowing_post_ik(
            jq_out,
            self.robot.dof_names(),
            self.robot.preset,
            root_coord_count=self._root_coord_count,
            robot_model=self.robot,
        )

        return RetargetedMotion(
            name=motion.name,
            joint_q=jq_out,
            sample_rate=motion.framerate,
            dof_names=self.robot.dof_names(),
            root_coord_count=self._root_coord_count,
            meta={
                "robot": self.robot.preset.name,
                "num_mapped_joints": len(self.ik_mapping.entries),
                "used_mjcf": self._used_mjcf,
                "ik_iterations": self.config.ik_iterations,
                "clip_floor_snap_m": float(clip_floor_snap_m),
                "human_height": self.human_height,
                "execution_provenance": self.execution_provenance(),
            },
        )

    def _inverse_body_quat(self) -> NDArray | None:
        """Return ``conj(source_body_quat)`` or ``None`` if it's identity."""
        sbq = np.asarray(self.scaler_config.source_body_quat, dtype=np.float32)
        if np.allclose(sbq, [0, 0, 0, 1], atol=1e-7):
            return None
        return Q.conjugate(sbq[None, :])[0]

    def _align_root_to_source_heading(self, joint_q: NDArray) -> NDArray:
        """Counter-rotate the floating-base root so it faces the source heading.

        The IK solver runs in the robot's canonical frame (+X forward),
        but downstream consumers (viewer, CSV export) expect the robot to
        move in the same direction as the original human motion.  Applying
        ``conj(source_body_quat)`` to the root position and quaternion
        undoes the heading alignment that the scaler applied, while
        keeping actuated-joint angles unchanged (they live in joint-local
        frames and are unaffected by a global yaw rotation).
        """
        inv_q = self._inverse_body_quat()
        if inv_q is None:
            return joint_q
        F = joint_q.shape[0]
        q_bc = np.broadcast_to(inv_q[None, :], (F, 4))
        out = joint_q.copy()
        out[:, :3] = Q.rotate(q_bc, joint_q[:, :3]).astype(np.float32)
        out[:, 3:7] = Q.multiply(q_bc, joint_q[:, 3:7]).astype(np.float32)
        return out

    def _align_preview_to_source_heading(self, transforms: NDArray) -> NDArray:
        """Counter-rotate preview positions and quaternions to source heading.

        Same idea as :meth:`_align_root_to_source_heading` but for the
        ``(F, M, 7)`` scaled-effector tensor used by the preview skeleton.
        """
        return align_effector_tensor_to_source_heading(
            transforms,
            source_body_quat=np.asarray(self.scaler_config.source_body_quat, dtype=np.float32),
        )

    def _rescale_root_displacement(self, joint_q: NDArray) -> NDArray:
        """Compatibility no-op for root displacement scaling.

        World trajectory scaling now happens in
        :class:`HumanToRobotScaler`, before IK, so the yellow preview,
        effector targets, and final robot root all share the same shortened
        displacement.  Kept as a separate method because older call sites and
        tests refer to this stage in the pipeline.
        """
        return joint_q

    def _clamp_solved_foot_heights(self, joint_q: NDArray) -> NDArray:
        """Post-IK safety clamp mirroring soma ``_clamp_foot_positions``.

        Lifts the floating base when solved ankles, knees, or mesh geometry sit
        below the ground plane.  Anti-floating still uses ankles only so kneeling
        poses are not pulled downward when feet leave the floor.
        """
        from hhtools.robot.foot_geometry import (
            ground_contact_zs,
            lowest_ankle_z,
            quat_xyzw_to_rotmat,
        )

        ik_map = dict(self.robot.preset.ik_map) if self.robot.preset.ik_map else {}
        if not ik_map:
            return joint_q

        # ``_MIN_ANKLE_Z`` is a *link-origin* threshold: an ankle / knee origin
        # sits ``_FOOT_COLLISION_OFFSET`` above the floor when the foot is
        # planted.  Mesh geometry needs ``_GROUND_CLEARANCE`` alone — holding the
        # sole itself at ``_MIN_ANKLE_Z`` floated every robot by
        # ``_MIN_ANKLE_Z`` minus its real sole depth (~5 cm on g1 / rp1).
        _FOOT_COLLISION_OFFSET = 0.05
        _GROUND_CLEARANCE = 0.01
        _MIN_ANKLE_Z = _FOOT_COLLISION_OFFSET + _GROUND_CLEARANCE
        _FLOAT_TOL = 0.015
        _UPRIGHT_BLEND_RANGE = 0.30
        _MAX_FLOAT_CORRECTION = 0.05
        _MAX_CORRECTION_RATE = 0.008

        out = joint_q.astype(np.float32, copy=True)
        dof_names = self.robot.dof_names()
        n_dof = min(out.shape[1] - self._root_coord_count, len(dof_names))
        if n_dof <= 0:
            return out

        rest_cfg = {dof_names[i]: 0.0 for i in range(n_dof)}
        self.robot.apply_configuration(rest_cfg)
        root_rot0 = quat_xyzw_to_rotmat(out[0, 3:7])
        rest_ankle = lowest_ankle_z(self.robot, ik_map, root_rot0)
        rest_foot_z = float(rest_ankle) if rest_ankle is not None else 0.0

        # Signed root-Z correction carried across frames
        # base up to clear ground penetration, negative pushes it down to kill
        # float).  Both directions are rate-limited so neither can teleport the
        # whole body in a single frame: the unbounded penetration lift was the
        # source of the "robot suddenly jumps up/down in Z" artefact on flips,
        # where the lowest-ankle estimate swings rapidly frame to frame.
        #
        # The limit applies to *changes* only.  The first corrected frame seeds
        # the carry with its own target, because a standing clip on a robot whose
        # feet are thicker than the source's needs the same offset on every frame
        # — ramping it in from zero left the opening frames lower than the rest,
        # and ``snap_joint_q_clip_floor`` then grounded those and left the body
        # of the clip floating by the ramp height.
        _max_lift_rate = float(self.config.foot_clamp_max_lift_rate)
        rate_up = _max_lift_rate if _max_lift_rate > 0.0 else float("inf")
        rate_down = _MAX_CORRECTION_RATE
        prev_correction = 0.0
        seeded = False
        for f in range(out.shape[0]):
            cfg = {
                dof_names[i]: float(out[f, self._root_coord_count + i])
                for i in range(n_dof)
            }
            self.robot.apply_configuration(cfg)
            root_rot = quat_xyzw_to_rotmat(out[f, 3:7])
            ankle_z = lowest_ankle_z(self.robot, ik_map, root_rot)
            # Full-body ``trimesh_scene`` min-Z is only needed for the
            # penetration lift.  When the user disables that path (batch CSV
            # export often does), skip mesh entirely — otherwise a 77-clip
            # GPU batch appears "stuck" at 帧 N/N while post-IK walks every
            # vertex of every visual STL for tens of thousands of frames.
            limb_z, mesh_z = ground_contact_zs(
                self.robot,
                ik_map,
                root_rot,
                include_mesh=bool(self.config.foot_clamp_anti_penetration),
            )
            if limb_z is None and mesh_z is None and ankle_z is None:
                continue
            root_z = float(out[f, 2])
            if mesh_z is not None:
                # Real contact surface: only the clearance margin is required.
                world_contact_z = root_z + float(mesh_z)
                min_contact_z = _GROUND_CLEARANCE
            else:
                # Mesh-free fallback: the link origin carries the foot-thickness
                # proxy, so it must clear the floor by ``_MIN_ANKLE_Z``.
                proxy_z = limb_z if limb_z is not None else ankle_z
                world_contact_z = root_z + float(proxy_z)
                min_contact_z = _MIN_ANKLE_Z

            if world_contact_z < min_contact_z and self.config.foot_clamp_anti_penetration:
                # Ground penetration: desired *upward* lift (>0).
                desired = min_contact_z - world_contact_z
            elif (
                self.config.foot_clamp_anti_float
                and ankle_z is not None
                and float(ankle_z) > rest_foot_z + _FLOAT_TOL
            ):
                # Floating foot: desired *downward* correction (<0).
                uprightness = max(
                    0.0,
                    min(
                        1.0,
                        (root_z - (root_z + float(ankle_z))) / _UPRIGHT_BLEND_RANGE,
                    ),
                )
                desired = -min(
                    (float(ankle_z) - rest_foot_z - _FLOAT_TOL) * uprightness,
                    _MAX_FLOAT_CORRECTION,
                )
            else:
                desired = 0.0

            if seeded:
                delta = max(-rate_down, min(rate_up, desired - prev_correction))
                prev_correction += delta
            else:
                prev_correction = desired
                seeded = True
            out[f, 2] += np.float32(prev_correction)
        return out

    def _clamp_solved_foot_lateral(self, joint_q: NDArray) -> NDArray:
        """Post-IK hip abduction spread when solved foot meshes overlap."""
        min_clearance = self._resolved_foot_lateral_clearance_m()
        if min_clearance <= 0.0 or joint_q.shape[0] == 0:
            return joint_q

        from hhtools.robot.foot_geometry import clamp_joint_q_foot_lateral_clearance

        feet_cfg = self.feet_stabilizer_config
        ankle_prefilter = 0.0
        if feet_cfg is not None and float(feet_cfg.min_lateral_separation) > 0.0:
            min_lat = float(feet_cfg.min_lateral_separation)
            ankle_prefilter = min_lat + max(0.03, min_lat * 0.3)

        # Batch CSV exports that disable penetration correction also skip the
        # per-frame foot-*mesh* lateral sweep (ankle laterality only).  Mesh
        # gap checks transform visual STL vertices every frame and dominate
        # wall time after GPU IK has already finished.
        use_mesh = bool(self.config.foot_clamp_anti_penetration)

        dof_names = self.robot.dof_names()
        out = joint_q.astype(np.float32, copy=True)
        for f in range(out.shape[0]):
            out[f] = clamp_joint_q_foot_lateral_clearance(
                self.robot,
                out[f],
                dof_names,
                root_coord_count=self._root_coord_count,
                min_clearance_m=min_clearance,
                ankle_prefilter_m=ankle_prefilter if ankle_prefilter > 0.0 else None,
                use_mesh=use_mesh,
            )
        return out

    #: Default inner foot-mesh clearance (m) applied to every robot when its
    #: config does not specify one.  The post-IK clamp this drives is purely
    #: mesh-gated (a no-op unless the solved foot meshes actually
    #: interpenetrate), so a small positive default is safe universally and
    #: protects narrow-hip / wide-foot robots out of the box.
    _DEFAULT_FOOT_LATERAL_CLEARANCE_M: float = 0.02

    def _resolved_foot_lateral_clearance_m(self) -> float:
        """Target inner foot-mesh clearance from feet stabilizer / robot geometry."""
        feet_cfg = self.feet_stabilizer_config
        if feet_cfg is None:
            # No feet config at all → fall back to the universal default so
            # the mesh-aware clamp still protects every robot.
            return float(self._DEFAULT_FOOT_LATERAL_CLEARANCE_M)
        # An explicit value (including 0.0 to disable) is always respected.
        return float(feet_cfg.min_foot_clearance)

    def _build_scaler(self, motion: Motion) -> HumanToRobotScaler:
        key = id(motion.hierarchy)
        cached = self._scaler_by_hierarchy.get(key)
        if cached is not None:
            return cached
        from hhtools.retarget.calibration.calibration import effective_retarget_human_height

        traj_h: float | None = None
        if str(getattr(motion, "source_format", "")).lower() == "glb":
            traj_h = effective_retarget_human_height(
                self.human_height, motion, self.scaler_config,
            )
        scaler = HumanToRobotScaler(
            motion.hierarchy,
            self.scaler_config,
            human_height=self.human_height,
            trajectory_human_height=traj_h,
        )
        self._scaler_by_hierarchy[key] = scaler
        return scaler

    def _build_feet_stabilizer(
        self, joint_names: tuple[str, ...]
    ) -> FeetStabilizer:
        key = hash(joint_names)
        cached = self._feet_stab_by_hierarchy.get(key)
        if cached is not None:
            return cached
        assert self.feet_stabilizer_config is not None
        from hhtools.robot.foot_geometry import pelvis_offset_in_root_frame

        stab = FeetStabilizer(
            self.feet_stabilizer_config,
            joint_names=joint_names,
            pelvis_offset=pelvis_offset_in_root_frame(self.robot),
        )
        self._feet_stab_by_hierarchy[key] = stab
        return stab

    def _rate_limit(
        self,
        *,
        root7: NDArray,
        dof: NDArray,
        framerate: float,
        source_root_quat: NDArray | None = None,
    ) -> NDArray:
        """Rate-limit per-frame root rotation and actuated-DOF deltas.

        The actuated DOFs are clipped to ``max_joint_velocity`` (component
        delta).  The floating-base root **rotation** is clamped with a
        proper SLERP step so the cap is an actual angular speed (radians /
        second), not a per-component quaternion delta — the old component
        clip neither bounded angular velocity nor renormalised the result.

        The root cap is source-relative:
        ``max(max_root_angular_velocity, source_speed * mult)``.  Per-frame
        IK has no temporal coupling, so near singular trunk poses the LM
        solver can teleport the root orientation for a single frame while
        the source root is barely moving (verified on the gymnastics BVH:
        source ~0.9 rad/s, solved root ~43 rad/s).  Tracking the source
        speed kills those artefacts while leaving the genuine flip — where
        the source itself spins fast — untouched.  Position deltas are left
        alone (a moving subject legitimately translates metres per second).
        """
        dt = 1.0 / max(framerate, 1.0)
        max_dq = self.config.max_joint_velocity * dt
        floor_root = (
            self.config.max_root_angular_velocity
            if self.config.max_root_angular_velocity > 0.0
            else self.config.max_joint_velocity
        )
        mult = float(self.config.root_angular_velocity_source_multiplier)

        # Per-frame source root angular speed (rad/s); 0 when unavailable so
        # the cap collapses to the fixed ``floor_root``.
        src_speed: NDArray | None = None
        if source_root_quat is not None and source_root_quat.shape[0] == root7.shape[0]:
            qs = Q.normalize(source_root_quat.astype(np.float32))
            dots = np.abs(np.sum(qs[1:] * qs[:-1], axis=1)).clip(0.0, 1.0)
            src_speed = (2.0 * np.arccos(dots)) / dt  # (F-1,)

        solved_q = Q.normalize(root7[:, 3:7].astype(np.float32))

        out = np.empty((root7.shape[0], root7.shape[1] + dof.shape[1]), dtype=np.float32)
        out[0, : root7.shape[1]] = root7[0]
        out[0, 3:7] = solved_q[0]
        out[0, root7.shape[1] :] = dof[0]

        for frame in range(1, root7.shape[0]):
            prev = out[frame - 1]
            # Position columns (0..3): unclipped.
            out[frame, 0:3] = root7[frame, 0:3]

            # Root quat (3..7): SLERP-clamp to the source-relative cap.
            prev_q = prev[3:7]
            cur_q = solved_q[frame]
            cap = floor_root
            if src_speed is not None and mult > 0.0:
                cap = max(floor_root, float(src_speed[frame - 1]) * mult)
            max_ang = cap * dt
            dot = float(np.dot(prev_q, cur_q))
            target_q = -cur_q if dot < 0.0 else cur_q
            ang = 2.0 * float(np.arccos(min(abs(dot), 1.0)))
            if max_ang > 0.0 and ang > max_ang and ang > 1e-6:
                out[frame, 3:7] = Q.slerp(prev_q, target_q, max_ang / ang)
            else:
                out[frame, 3:7] = Q.normalize(target_q)

            # DOFs (7..): clip delta.
            dq = np.clip(dof[frame] - prev[7:], -max_dq, max_dq)
            out[frame, 7:] = prev[7:] + dq
        return out

    # ---------------------------------------------------------------- shared run stages

    def _prepare_solver_targets(self, motion: Motion) -> PreparedIKTargets:
        """Front half of a single-clip solve: scaled, padded IK targets."""
        # 1. Scale source motion into effector targets.
        scaler = self._build_scaler(motion)
        scaled = scaler.apply(motion)

        # 2. Optional feet stabilizer.
        targets = scaled.transforms  # (F, M, 7)
        hand_ground_drop: np.ndarray | None = None
        if self.config.apply_feet_stabilizer and self.feet_stabilizer_config is not None:
            stab = self._build_feet_stabilizer(scaler.joint_names)
            targets = stab.apply(targets)
            if stab.hand_ground_drop_per_frame.size:
                hand_ground_drop = stab.hand_ground_drop_per_frame.astype(
                    np.float32, copy=False,
                )

        # 3. Translate scaler-native joint names (often SMPL-X: pelvis /
        # spine1 / …) to the canonical hhtools names that robot.yaml ik_map
        # is authored against (hips / spine / …).
        canonical_to_target = self._effectors_to_canonical_map(scaler, targets)
        canonical_to_target = self._augment_canonical_targets(
            motion, scaler, targets, canonical_to_target,
        )

        missing = [
            e.canonical_name
            for e in self.ik_mapping.entries
            if e.canonical_name not in canonical_to_target
        ]
        if missing:
            raise KeyError(
                f"robot ik_map references canonical joints not produced by "
                f"the scaler: {missing}. Source joint names: "
                f"{list(scaler.joint_names)}. Consider passing "
                f"source_to_canonical={{...}} to the retarget pipeline or "
                f"editing robot.yaml."
            )
        # (F, M_mapped, 7) aligned with ik_mapping.entries order.
        ik_targets = np.stack(
            [canonical_to_target[e.canonical_name] for e in self.ik_mapping.entries],
            axis=1,
        ).astype(np.float32, copy=False)

        from hhtools.robot.retarget_profile import apply_upper_body_lateral_ik_narrowing

        ik_targets = apply_upper_body_lateral_ik_narrowing(
            ik_targets, self.ik_mapping.entries, self.robot.preset,
            robot_model=self.robot,
        )
        # Real-frame position targets exactly as the solver will see them
        # (later steps only touch rotation columns or pad), kept for
        # result diagnostics.
        solved_target_positions = ik_targets[:, :, 0:3].astype(np.float32, copy=True)

        _pelvis_col = next(
            (
                i
                for i, e in enumerate(self.ik_mapping.entries)
                if e.canonical_name in ("hips", "pelvis")
            ),
            None,
        )

        # Source-derived root rotation target (real frames, pre-padding).
        # Frame-to-frame angular velocity is heading-invariant, so this is a
        # valid reference for the rate limiter even though it runs before
        # ``_align_root_to_source_heading``.  Used to cap solved-root spikes
        # relative to how fast the source root actually rotates.
        source_root_quat = (
            ik_targets[:, _pelvis_col, 3:7].astype(np.float32, copy=True)
            if _pelvis_col is not None
            else None
        )

        # 3a. Prepend / append warm-up frames so the IK solver can settle
        # before the real motion starts (and after it ends).  See
        # :attr:`PipelineConfig.num_initialization_frames` for the
        # rationale.  We track the padding explicitly so we can trim
        # output to the original duration at the end.
        n_init = max(0, int(self.config.num_initialization_frames))
        n_stab = max(0, int(self.config.num_stabilization_frames))
        if n_init > 0 or n_stab > 0:
            init_block = np.repeat(
                ik_targets[:1], n_init, axis=0
            ) if n_init > 0 else ik_targets[:0]
            stab_block = np.repeat(
                ik_targets[-1:], n_stab, axis=0
            ) if n_stab > 0 else ik_targets[:0]
            ik_targets = np.concatenate(
                [init_block, ik_targets, stab_block], axis=0
            )

        # 3b. Optional escape hatch for legacy / experimental configs:
        # replace the pelvis rotation target with a world-Z yaw-only
        # quaternion so the robot stays upright while tracking subject
        # heading.  Off by default; only runs when both
        # ``disable_rotation_objectives`` and
        # ``pelvis_yaw_only_rotation_target`` are set on the
        # PipelineConfig.  Non-pelvis rotation weights are zeroed by the
        # backend solve via the same flag.
        if (
            self.config.disable_rotation_objectives
            and self.config.pelvis_yaw_only_rotation_target
        ):
            # Local import keeps the pipeline module importable even if
            # the calibration package isn't installed (e.g. headless
            # test harnesses that stub it out).
            from hhtools.retarget.calibration.calibration import _extract_yaw_quat

            pelvis_idx = next(
                (
                    i
                    for i, e in enumerate(self.ik_mapping.entries)
                    if e.canonical_name in ("hips", "pelvis")
                ),
                None,
            )
            if pelvis_idx is not None:
                fwd_body = (
                    np.array([0.0, 0.0, 1.0], dtype=np.float32)
                    if is_smpl_like(scaler.joint_names)
                    else np.array([1.0, 0.0, 0.0], dtype=np.float32)
                )
                pelvis_q_src = ik_targets[:, pelvis_idx, 3:7].copy()
                yaw_q = np.zeros_like(pelvis_q_src)
                for f in range(pelvis_q_src.shape[0]):
                    yaw_q[f] = _extract_yaw_quat(pelvis_q_src[f], fwd_body)
                ik_targets[:, pelvis_idx, 3:7] = yaw_q

        # 3c. Position-only source data (e.g. holosoma): all source
        # quaternions are identity, so the scaler produced constant
        # rotation targets that would pin the robot to its initial
        # heading.  Replace the pelvis rotation target with a per-frame
        # yaw derived from the shoulder/hip axis and zero non-pelvis
        # rotation weights so the solver is guided by positions alone.
        _pos_only = _is_position_only(motion)
        if _pos_only:
            _log.info(
                "Position-only source detected — computing per-frame "
                "heading from shoulder/hip positions."
            )
            pelvis_idx = next(
                (
                    i
                    for i, e in enumerate(self.ik_mapping.entries)
                    if e.canonical_name in ("hips", "pelvis")
                ),
                None,
            )
            yaw_q = _compute_perframe_yaw(ik_targets, self.ik_mapping.entries)
            if pelvis_idx is not None and yaw_q is not None:
                ik_targets[:, pelvis_idx, 3:7] = yaw_q

        # 4. Align the hands-on-ground drop with the padded target sequence.
        drop_for_ik = hand_ground_drop
        if drop_for_ik is not None and (n_init > 0 or n_stab > 0):
            padded = np.zeros(ik_targets.shape[0], dtype=np.float32)
            n_drop = min(int(drop_for_ik.shape[0]), int(ik_targets.shape[0]) - n_init - n_stab)
            if n_drop > 0:
                padded[n_init : n_init + n_drop] = drop_for_ik[:n_drop]
            drop_for_ik = padded

        return PreparedIKTargets(
            ik_targets=ik_targets,
            solved_target_positions=solved_target_positions,
            source_root_quat=source_root_quat,
            hand_ground_drop=drop_for_ik,
            n_init=n_init,
            n_stab=n_stab,
            position_only=_pos_only,
            scaler=scaler,
        )

    def _finalize_solved_joint_q(
        self,
        joint_q_all: NDArray,
        motion: Motion,
        prepared: PreparedIKTargets,
    ) -> RetargetedMotion:
        """Back half of a single-clip solve: trim, clamp, ground and wrap."""
        n_init, n_stab = prepared.n_init, prepared.n_stab
        # 4b. Trim warm-up frames so the user sees exactly the original
        # motion duration back.  The solver state carries over between
        # frames so the first "real" output frame benefits from n_init
        # prior IK iterations on the same target.
        if n_init > 0 or n_stab > 0:
            end = joint_q_all.shape[0] - n_stab if n_stab > 0 else joint_q_all.shape[0]
            joint_q_all = joint_q_all[n_init:end]

        # 5. Hard-clip DOFs to URDF limits.
        # Our clamper works on the actuated-DOF slice (past the 7-coord root).
        root7 = joint_q_all[:, : self._root_coord_count]
        dof = joint_q_all[:, self._root_coord_count :]
        # Newton may add extra coords past the declared actuated count for
        # mimic / constrained joints; we only clamp the first N columns
        # that correspond to the robot's actuated joints.
        n_clamp = min(dof.shape[1], self._ndof_actuated)
        if n_clamp > 0:
            dof[:, :n_clamp] = self.clamper.apply(dof[:, :n_clamp])

        # 6. Optional per-frame velocity rate limiter.
        if self.config.max_joint_velocity > 0.0:
            joint_q_all = self._rate_limit(
                root7=root7, dof=dof, framerate=motion.framerate,
                source_root_quat=prepared.source_root_quat,
            )
        else:
            joint_q_all = np.concatenate([root7, dof], axis=1)

        # 7. Truncate to the CSV-exportable width (root + actuated).
        csv_width = self._root_coord_count + self._ndof_actuated
        joint_q_out = joint_q_all[:, :csv_width].astype(np.float32, copy=False)

        # 8. Align output heading with source: inverse-rotate the root so
        #    the robot moves in the same direction as the source skeleton.
        joint_q_out = self._align_root_to_source_heading(joint_q_out)

        # 9. Root displacement is already scaled inside HumanToRobotScaler so
        #    IK targets and final floating-base motion stay consistent.
        joint_q_out = self._rescale_root_displacement(joint_q_out)
        if self.config.post_ik_foot_clamps:
            joint_q_out = self._clamp_solved_foot_heights(joint_q_out)
            joint_q_out = self._clamp_solved_foot_lateral(joint_q_out)

        clip_floor_snap_m = 0.0
        if bool(getattr(self.config, "clip_floor_snap", True)):
            from hhtools.retarget.clip_ground_snap import snap_joint_q_clip_floor

            joint_q_out, clip_floor_snap_m = snap_joint_q_clip_floor(
                self.robot,
                joint_q_out,
                root_coord_count=self._root_coord_count,
                ground_z=0.0,
            )

        from hhtools.robot.retarget_profile import apply_upper_body_roll_narrowing_post_ik

        joint_q_out = apply_upper_body_roll_narrowing_post_ik(
            joint_q_out,
            self.robot.dof_names(),
            self.robot.preset,
            root_coord_count=self._root_coord_count,
            robot_model=self.robot,
        )

        return RetargetedMotion(
            name=motion.name,
            joint_q=joint_q_out,
            sample_rate=motion.framerate,
            dof_names=self.robot.dof_names(),
            root_coord_count=self._root_coord_count,
            meta=self._result_meta(clip_floor_snap_m=clip_floor_snap_m),
            ik_targets=self._ik_target_trace(prepared.solved_target_positions),
        )
