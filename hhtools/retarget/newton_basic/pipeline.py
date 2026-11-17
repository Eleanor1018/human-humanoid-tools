# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Portions adapted from soma-retargeter (Apache-2.0).
# See https://github.com/NVIDIA/SOMA-Retargeter and the project root NOTICE.
"""Newton-based IK retargeting pipeline (stage 2).

This is the hhtools port of ``soma_retargeter.pipelines.newton_pipeline`` —
the top-level orchestration that threads a human motion through the scaler,
feet stabilizer, Newton IK solver, joint limit clamper, and finally CSV
export.  The implementation walks the same flow as upstream but is re-cut to
consume hhtools' :class:`~hhtools.core.motion.Motion` /
:class:`~hhtools.robot.base.RobotModel` contracts, so there's no BVH / USD
dependency on the input side.

Flow per input motion:

    Motion --(scaler)--> (F, M, 7) effector targets
           --(feet stabilizer)--> (F, M, 7) constrained targets
           --(per-frame Newton IK)--> (F, joint_coord_count) joint_q
           --(joint limit clamper)--> same, hard-clipped to URDF limits
           --(velocity rate limiter)--> smoothed joint_q
           --> RetargetedMotion { joint_q, sample_rate, dof_names, ... }

We intentionally run one IK problem per frame (sequential) for clarity — the
upstream multi-env batching is reserved for batch export and is used when
``num_envs > 1`` on the :class:`NewtonRobotContext`.

**CUDA vs CPU:** when Warp's current device is CUDA and
:attr:`PipelineConfig.ik_use_cuda_graph` is ``True`` (default), the IK
``solver.step`` is recorded once with ``wp.ScopedCapture`` (same pattern as
soma-retargeter's ``NewtonPipeline`` when dynamic collision / temporal
objectives are off).  Each frame then updates objective targets from Python and
replays the graph with ``wp.capture_launch``.  On CPU, non-CUDA devices, or if
capture fails, the pipeline falls back to per-frame ``solver.step`` calls.
Disable the graph explicitly via ``PipelineConfig(ik_use_cuda_graph=False)``
when debugging.  Other mitigations for very large clips: lower
``ik_iterations`` in the viewer or cap ``max_frames`` for previews.
"""

from __future__ import annotations

import logging
import threading
from collections.abc import Callable
from contextlib import nullcontext
from dataclasses import replace
from typing import Iterable

import newton
import newton.ik as ik
import numpy as np
import warp as wp
from numpy.typing import NDArray

from hhtools.core.motion import Motion

# Solver-independent stages and knobs live in hhtools.retarget.ik_pipeline;
# the names below are re-exported for existing ``newton_basic.pipeline`` users.
from hhtools.retarget.ik_pipeline import (  # noqa: F401 — re-exports
    IKPipelineBase,
    PipelineConfig,
    ScaledMotionPreview,
    _compute_endpoint_offset,
    _compute_perframe_yaw,
    _default_ik_use_cuda_graph,
    _is_position_only,
)
from hhtools.retarget.newton_basic._warp_config import configure as configure_warp_cache
from hhtools.retarget.newton_basic.config import (
    FeetStabilizerConfig,
    ScalerConfig,
)
from hhtools.retarget.newton_basic.heading_align import align_effector_tensor_to_source_heading
from hhtools.retarget.newton_basic.robot_model import (  # noqa: F401 — re-export
    IKMapping,
    NewtonRobotContext,
    build_newton_model,
)
from hhtools.robot.loader import URDFRobotModel

__all__ = [
    "NewtonBasicPipeline",
    "PipelineConfig",
    "RetargetedMotion",
    "ScaledMotionPreview",
    "align_effector_tensor_to_source_heading",
    "is_newton_ik_prewarmed",
    "prewarm_newton_ik_for_robot",
]


_log = logging.getLogger(__name__)

# Warp / CUDA context is not safe across threads.  The lock serialises
# *concurrent* GPU sessions (background prewarm vs retarget worker), **not**
# clips inside :meth:`NewtonBasicPipeline.run_batch` — batch retarget builds
# one multi-env model (``num_envs=N``) and runs a single ``solver.step`` per
# frame for all N clips in parallel inside one lock acquisition.
_WARP_IK_LOCK = threading.Lock()
_cuda_graph_disabled_process = False




# ---------------------------------------------------------------------------
# Position-only motion helpers
# ---------------------------------------------------------------------------






def _warp_device_is_cuda() -> bool:
    try:
        return bool(wp.get_device().is_cuda)
    except Exception:  # pragma: no cover — no Warp context yet
        return False


def _cuda_graph_enabled(config: PipelineConfig) -> bool:
    if _cuda_graph_disabled_process:
        return False
    return bool(config.ik_use_cuda_graph and _warp_device_is_cuda())


def _disable_cuda_graph_globally(reason: str) -> None:
    global _cuda_graph_disabled_process
    if not _cuda_graph_disabled_process:
        _log.warning(
            "Disabling IK CUDA graphs for this process (%s). "
            "Set HHTOOLS_IK_USE_CUDA_GRAPH=0 to silence capture attempts.",
            reason,
        )
        _cuda_graph_disabled_process = True
    try:
        wp.synchronize()
    except Exception:  # pragma: no cover — driver edge cases
        pass


def _try_capture_ik_step(step_fn: Callable[[], None]) -> object | None:
    try:
        with wp.ScopedCapture() as cap:
            step_fn()
        return cap.graph
    except Exception as err:  # pragma: no cover — driver / Warp edge cases
        _log.warning("IK CUDA graph capture failed, using eager steps: %s", err)
        _disable_cuda_graph_globally(str(err))
        return None


def _run_ik_step(
    *,
    ik_graph: object | None,
    step_fn: Callable[[], None],
) -> object | None:
    """Replay a captured CUDA graph or fall back to an eager ``step_fn``."""
    if ik_graph is None:
        step_fn()
        return None
    try:
        wp.capture_launch(ik_graph)
        return ik_graph
    except Exception as err:  # pragma: no cover — stale / poisoned graphs
        _log.warning("IK CUDA graph replay failed, using eager steps: %s", err)
        _disable_cuda_graph_globally(str(err))
        step_fn()
        return None


def _warp_ik_guard():
    return _WARP_IK_LOCK if _warp_device_is_cuda() else nullcontext()


# ---------------------------------------------------------------------------
# Auto-endpoint offset helpers (toe / hand-end)
# ---------------------------------------------------------------------------




# --------------------------------------------------------------------------- configs




from hhtools.retarget.retarget_result import (  # noqa: E402,F401 — re-export
    IKTargetTrace,
    RetargetedMotion,
)

# --------------------------------------------------------------------------- pipeline


class NewtonBasicPipeline(IKPipelineBase):
    """End-to-end retargeting from ``Motion`` to robot ``joint_q``.

    Construction is eager — we build the Newton model and IK solver up-front
    so subsequent :meth:`run` calls reuse the compiled kernels.  Not
    thread-safe: call ``run`` from a single worker (the UI's preview thread
    is fine).

    Args:
        robot: Loaded :class:`URDFRobotModel` for the target robot.
        scaler_config: Stage-1 :class:`ScalerConfig`; its ``joint_scales``
            keys must match the ``ik_map`` keys on ``robot.yaml`` (or at
            least be a superset — extra scaler joints are ignored).
        feet_stabilizer_config: Optional :class:`FeetStabilizerConfig`.  If
            omitted the pipeline still runs, just without ground-contact
            enforcement.
        pipeline_config: Pipeline knobs; uses upstream G1 defaults when
            omitted.
        human_height: Pelvis-to-head height (metres) of the source subject.
            Mirrors ``soma-retargeter``'s ``human_height`` argument and
            drives the height-ratio correction inside
            :class:`HumanToRobotScaler`.
        configure_warp: Whether to auto-configure Warp's kernel cache
            location on first construction — set ``False`` in tests that
            manage Warp themselves.
    """

    def __init__(
        self,
        robot: URDFRobotModel,
        *,
        scaler_config: ScalerConfig,
        feet_stabilizer_config: FeetStabilizerConfig | None = None,
        pipeline_config: PipelineConfig | None = None,
        human_height: float = 1.7,
        configure_warp: bool = True,
        source_to_canonical: dict[str, str] | None = None,
    ) -> None:
        if configure_warp:
            configure_warp_cache()

        self._init_shared(
            robot,
            scaler_config=scaler_config,
            feet_stabilizer_config=feet_stabilizer_config,
            pipeline_config=pipeline_config,
            human_height=human_height,
            source_to_canonical=source_to_canonical,
        )

        self.ctx: NewtonRobotContext = build_newton_model(
            robot, num_envs=1
        )
        if self.ctx.ik_mapping is None or not self.ctx.ik_mapping.entries:
            raise ValueError(
                f"robot preset {robot.preset.name!r} has no usable ik_map. "
                f"warnings: {self.ctx.mapping_warnings}"
            )
        self._init_ik_mapping(self.ctx.ik_mapping)

    # ---- IKPipelineBase contract ---------------------------------------------

    @property
    def _root_coord_count(self) -> int:
        return self.ctx.root_coord_count

    @property
    def _joint_coord_count(self) -> int:
        return self.ctx.joint_coord_count

    @property
    def _ik_body_labels(self) -> list[str]:
        return self.ctx.body_labels

    @property
    def _used_mjcf(self) -> bool:
        return self.ctx.used_mjcf

    @classmethod
    def prewarm_for_robot(
        cls,
        robot: URDFRobotModel,
        *,
        pipeline_config: PipelineConfig | None = None,
        ik_iterations: int = 1,
        force: bool = False,
    ) -> bool:
        """JIT-compile Warp IK kernels (+ CUDA graph) for ``robot``.

        Safe to call from a background thread after the robot URDF loads.
        Subsequent :class:`NewtonBasicPipeline` instances for the same preset
        reuse the on-disk Warp cache and pay only solver setup cost.

        Returns ``True`` when a dummy solve ran, ``False`` when skipped.
        """
        return prewarm_newton_ik_for_robot(
            robot,
            pipeline_config=pipeline_config,
            ik_iterations=ik_iterations,
            force=force,
        )

    # ---------------------------------------------------------------- public API

    def _run_with_active_ik_map(
        self,
        motion: Motion,
        *,
        progress_callback: Callable[[int, int], None] | None = None,
    ) -> RetargetedMotion:
        prepared = self._prepare_solver_targets(motion)
        # Solve IK per frame (including any prepended init / appended stab
        # frames; see ``PipelineConfig.num_initialization_frames``).
        joint_q_all = self._solve_ik_sequence(
            prepared.ik_targets,
            progress_callback=progress_callback,
            force_disable_rotation_objectives=prepared.position_only,
            hand_ground_drop=prepared.hand_ground_drop,
        )
        return self._finalize_solved_joint_q(joint_q_all, motion, prepared)

    def run_many(self, motions: Iterable[Motion]) -> list[RetargetedMotion]:
        """Convenience wrapper around :meth:`run` for a batch of motions.

        .. deprecated::
            Prefer :meth:`run_batch` which solves all motions in a single
            GPU-parallel Newton step (multi-env layout) instead of looping
            sequentially.  ``run_many`` is kept for backward compatibility.
        """
        return [self.run(m) for m in motions]

    # ---------------------------------------------------------------- GPU-parallel batch

    def run_batch(
        self,
        motions: list[Motion],
        *,
        progress_callback: Callable[[int, int], None] | None = None,
    ) -> list[RetargetedMotion]:
        """Retarget multiple motions in GPU-parallel (multi-env Newton).

        All *N* motions are solved simultaneously: a single ``solver.step()``
        per frame advances all *N* environments at once, matching
        ``soma-retargeter``'s multi-env layout.  Throughput scales roughly
        linearly in *N* for moderate batch sizes (≤ 16 on most GPUs).

        The GPU device lock (see module-level ``_WARP_IK_LOCK``) is held once
        for the entire batched IK pass — it does **not** force clip-by-clip
        serial solves.  Only overlapping sessions (e.g. prewarm + retarget on
        different threads) are serialised.

        Shorter motions are padded to the longest clip's frame count (last
        frame repeated) so the solver processes a rectangular buffer;
        padding is stripped before output.

        Args:
            motions: One or more source :class:`~hhtools.core.motion.Motion`
                objects.  Different hierarchies within the same batch are
                fine — each motion gets its own scaler.
            progress_callback: ``fn(frame_done, max_frame)`` called once per
                frame across *all* envs.  The callback receives the global
                frame index (0-based), not per-motion counts.

        Returns:
            One :class:`RetargetedMotion` per input motion, in the same
            order.  Empty motions (0 frames) yield zero-row results.
        """
        if not motions:
            return []
        self._last_cuda_graph_requested = False
        self._last_cuda_graph_used = False
        motions = [self._ensure_z_up(m) for m in motions]
        if len(motions) == 1:
            return [self.run(motions[0], progress_callback=progress_callback)]

        # Same OmniContact+G1 head drop as :meth:`run` (shared IK width).
        from hhtools.robot.ik_map_policy import drop_head_targets_for_motion

        trigger = next(
            (
                m for m in motions
                if drop_head_targets_for_motion(self.robot.preset.name, m)
            ),
            None,
        )
        ik_restore = (
            self._push_motion_ik_policy(trigger) if trigger is not None else None
        )
        try:
            return self._run_batch_with_active_ik_map(
                motions, progress_callback=progress_callback,
            )
        finally:
            if ik_restore is not None:
                self.ik_mapping = ik_restore

    def _run_batch_with_active_ik_map(
        self,
        motions: list[Motion],
        *,
        progress_callback: Callable[[int, int], None] | None = None,
    ) -> list[RetargetedMotion]:
        entries = self.ik_mapping.entries
        M = len(entries)
        n_init = max(0, int(self.config.num_initialization_frames))
        n_stab = max(0, int(self.config.num_stabilization_frames))

        # --- 1. Pre-compute IK targets for each motion (CPU) ----------------
        all_targets: list[NDArray] = []
        real_frame_counts: list[int] = []  # original clip length (no padding)
        for m in motions:
            if m.num_frames == 0:
                all_targets.append(
                    np.zeros((0, M, 7), dtype=np.float32)
                )
                real_frame_counts.append(0)
                continue
            ik_tgt = self._build_ik_targets(m)
            all_targets.append(ik_tgt)
            real_frame_counts.append(m.num_frames)

        # Separate empty motions from non-empty ones.
        active: list[tuple[int, NDArray]] = [
            (i, t) for i, t in enumerate(all_targets) if t.shape[0] > 0
        ]
        if not active:
            return [
                self._empty_result(m) for m in motions
            ]

        active_idx = [i for i, _ in active]
        active_tgt = [t for _, t in active]
        N = len(active_tgt)
        max_frames = max(t.shape[0] for t in active_tgt)

        # --- 2. Pad to rectangular (N, max_frames, M, 7) -------------------
        padded = np.zeros((N, max_frames, M, 7), dtype=np.float32)
        padded_counts: list[int] = []
        for j, t in enumerate(active_tgt):
            F = t.shape[0]
            padded[j, :F] = t
            if F < max_frames:
                padded[j, F:] = t[-1:]
            padded_counts.append(F)

        # --- 3. Batched solve (GPU): single-robot model, N parallel problems
        # Newton's ``IKSolver`` takes a SINGLE-robot model plus ``n_problems=N``
        # and factorises one ``dof × dof`` Cholesky tile *per problem* in
        # parallel, so per-block shared memory is independent of N (this is
        # exactly soma-retargeter's layout, which batches ~100 clips at once).
        # Feeding an N-robot *merged* model here instead would make
        # ``model.joint_coord_count == N · dof`` and each Cholesky tile
        # ``(N · dof)²`` — blowing the per-block shared-memory budget and
        # forcing the clip-by-clip fallback.  We therefore reuse ``self.ctx``
        # (built with ``num_envs=1``) and let the solver replicate it N ways.
        any_pos_only = any(_is_position_only(motions[i]) for i in active_idx)
        per_env_jq = self._solve_ik_batch(
            self.ctx, padded, padded_counts,
            progress_callback=progress_callback,
            force_disable_rotation_objectives=any_pos_only,
        )

        # --- 4. Post-process per motion (CPU) -------------------------------
        # Source pelvis rotation column (for the source-relative root angular
        # velocity cap in ``_rate_limit``).  ``run`` derives this per clip; the
        # batch path must do the same or the cap collapses to the fixed floor
        # and genuine fast rotation (flips) gets over-clamped.
        _pelvis_col = next(
            (
                i
                for i, e in enumerate(entries)
                if e.canonical_name in ("hips", "pelvis")
            ),
            None,
        )
        results: list[RetargetedMotion | None] = [None] * len(motions)
        n_active = len(active_idx)
        for j, orig_idx in enumerate(active_idx):
            if progress_callback is not None:
                try:
                    # Keep the UI alive after IK finishes: post-IK foot clamps
                    # used to run silently for minutes on large batches while
                    # the status bar still read ``帧 N/N``.
                    progress_callback(max_frames + j, max_frames + n_active)
                except Exception:
                    pass
            m = motions[orig_idx]
            jq = per_env_jq[j]

            # Trim warm-up / stabilization padding.
            real_f = real_frame_counts[orig_idx]
            if n_init > 0 or n_stab > 0:
                jq = jq[n_init : n_init + real_f]
            else:
                jq = jq[:real_f]

            # Pelvis rotation target for the same real frames (strip the
            # init / stab padding baked into ``all_targets``).
            src_root_quat: NDArray | None = None
            if _pelvis_col is not None:
                tgt = all_targets[orig_idx]
                src_root_quat = tgt[
                    n_init : n_init + real_f, _pelvis_col, 3:7
                ].astype(np.float32, copy=True)

            results[orig_idx] = self._postprocess_joint_q(
                jq, m, source_root_quat=src_root_quat,
            )

        if progress_callback is not None:
            try:
                progress_callback(max_frames + n_active, max_frames + n_active)
            except Exception:
                pass

        # Fill empty-motion slots.
        for i, m in enumerate(motions):
            if results[i] is None:
                results[i] = self._empty_result(m)

        return results  # type: ignore[return-value]

    # ---------------------------------------------------------------- internals

    # ---- endpoint entry construction -----------------------------------------

    def execution_provenance(self) -> dict[str, object]:
        """Return facts observed from the Warp context used by the latest solve."""

        try:
            device = wp.get_device()
            device_name = str(device)
            device_kind = "cuda" if bool(device.is_cuda) else "cpu"
        except Exception:  # pragma: no cover - only possible before Warp initializes
            device_name = "unknown"
            device_kind = "unknown"
        graph_requested = bool(self._last_cuda_graph_requested)
        graph_used = bool(self._last_cuda_graph_used)
        fallback_used = bool(graph_requested and not graph_used)
        provenance: dict[str, object] = {
            "backend": "newton",
            "device": device_name,
            "device_kind": device_kind,
            "precision": "float32",
            "runtime": "warp",
            "runtime_version": str(getattr(wp, "__version__", "unknown")),
            "solver": f"newton-{getattr(newton, '__version__', 'unknown')}",
            "cuda_graph_requested": graph_requested,
            "cuda_graph_used": graph_used,
            "fallback_used": fallback_used,
        }
        if fallback_used:
            provenance["fallback_reason"] = "cuda_graph_unavailable_or_failed"
        return provenance

    def _build_ground_collision_objective(self, model) -> ik.IKObjective | None:
        weight = float(self.config.ground_collision_weight)
        bodies = list(self.config.ground_collision_bodies or ())
        if weight <= 0.0 or not bodies:
            return None
        from hhtools.retarget.newton_basic.ik_collision_objective import (
            IKObjectiveGroundCollision,
            resolve_ground_collision_bodies,
        )

        resolved = resolve_ground_collision_bodies(self.ctx.body_labels, bodies)
        if not resolved:
            _log.warning(
                "ground_collision_bodies configured but none match robot links %s",
                self.ctx.body_labels[:8],
            )
            return None
        return IKObjectiveGroundCollision(
            model,
            body_labels=self.ctx.body_labels,
            ground_bodies=resolved,
            weight=weight,
            ground_z=float(self.config.ground_collision_z),
        )

    # ---- core Newton IK solve --------------------------------------------------

    def _solve_ik_sequence(
        self,
        ik_targets: NDArray,
        *,
        progress_callback: Callable[[int, int], None] | None = None,
        force_disable_rotation_objectives: bool = False,
        hand_ground_drop: NDArray | None = None,
    ) -> NDArray:
        """Run the IK solver frame-by-frame and return ``(F, joint_coord_count)``.

        The IK state persists between frames (warm start from the previous
        solution), which both speeds things up and avoids root-pose
        discontinuities.

        When *force_disable_rotation_objectives* is ``True``, non-pelvis
        rotation objectives are zeroed regardless of the pipeline config.
        Used for position-only source data where the quaternion targets are
        meaningless constants.
        """
        with _warp_ik_guard():
            return self._solve_ik_sequence_inner(
                ik_targets,
                progress_callback=progress_callback,
                force_disable_rotation_objectives=force_disable_rotation_objectives,
                hand_ground_drop=hand_ground_drop,
            )

    def _solve_ik_sequence_inner(
        self,
        ik_targets: NDArray,
        *,
        progress_callback: Callable[[int, int], None] | None,
        force_disable_rotation_objectives: bool,
        hand_ground_drop: NDArray | None = None,
    ) -> NDArray:
        num_frames = ik_targets.shape[0]
        num_mapped = ik_targets.shape[1]

        model = self.ctx.model

        # Build per-objective ``target`` warp arrays; we mutate them in place
        # every frame via ``set_target_position`` / ``set_target_rotation``.
        entries = self.ik_mapping.entries
        pos_targets_np = np.zeros((num_mapped, 3), dtype=np.float32)
        rot_targets_np = np.zeros((num_mapped, 4), dtype=np.float32)
        rot_targets_np[:] = np.array([0.0, 0.0, 0.0, 1.0], dtype=np.float32)

        position_objectives: list[ik.IKObjectivePosition] = []
        from hhtools.robot.retarget_profile import effective_ik_t_weight

        preset = self.robot.preset
        for i, entry in enumerate(entries):
            pos_wp = wp.array(pos_targets_np[i : i + 1], dtype=wp.vec3)
            position_objectives.append(
                ik.IKObjectivePosition(
                    link_index=entry.t_body_index,
                    link_offset=wp.vec3(*entry.t_offset),
                    target_positions=pos_wp,
                    weight=effective_ik_t_weight(
                        entry.canonical_name, entry.t_weight, preset,
                        robot_model=self.robot,
                    ),
                )
            )

        _disable_rot = (
            force_disable_rotation_objectives
            or self.config.disable_rotation_objectives
        )
        rotation_objectives: list[ik.IKObjectiveRotation] = []
        for i, entry in enumerate(entries):
            rot_wp = wp.array(rot_targets_np[i : i + 1], dtype=wp.vec4)
            if _disable_rot:
                is_pelvis = entry.canonical_name in ("hips", "pelvis")
                # Boost pelvis rotation weight for position-only data where
                # heading tracking depends solely on this objective.
                weight = max(entry.r_weight, 5.0) if is_pelvis else 0.0
            else:
                weight = entry.r_weight
                # GLB spine maps to hips + chest; dual rotation objectives
                # over-twist the robot waist.  Track chest by position only.
                if (
                    self._active_motion_source_format == "glb"
                    and entry.canonical_name == "chest"
                ):
                    weight = 0.0
            rotation_objectives.append(
                ik.IKObjectiveRotation(
                    link_index=entry.r_body_index,
                    link_offset_rotation=wp.quat_identity(),
                    target_rotations=rot_wp,
                    weight=weight,
                )
            )

        objectives: list[ik.IKObjective] = [*position_objectives, *rotation_objectives]

        if self.config.joint_limit_weight > 0.0:
            objectives.append(
                ik.IKObjectiveJointLimit(
                    joint_limit_lower=model.joint_limit_lower,
                    joint_limit_upper=model.joint_limit_upper,
                    weight=self.config.joint_limit_weight,
                )
            )

        if self.config.smooth_joint_filter_weight > 0.0:
            # Deferred import so the verbose warp kernels only compile when
            # this optional objective is actually enabled.
            from hhtools.retarget.newton_basic.ik_objectives import IKSmoothJointFilter

            coord_masks = self._build_smooth_joint_filter_coord_masks(model)
            objectives.append(
                IKSmoothJointFilter(
                    joint_limit_lower=model.joint_limit_lower,
                    joint_limit_upper=model.joint_limit_upper,
                    weight=self.config.smooth_joint_filter_weight,
                    coord_masks=coord_masks,
                )
            )

        ground_collision_obj = self._build_ground_collision_objective(model)
        if ground_collision_obj is not None:
            objectives.append(ground_collision_obj)

        use_dynamic_ground = (
            ground_collision_obj is not None
            and self.config.ground_collision_dynamic_boost
        )
        _STANDING_ROOT_Z = 0.70
        _GROUND_ROOT_Z = 0.25
        _COLLISION_BOOST = 2.0
        pelvis_entry = next(
            (e for e in entries if e.canonical_name in ("hips", "pelvis")),
            None,
        )
        pelvis_i = entries.index(pelvis_entry) if pelvis_entry is not None else -1
        hips_default_weight = (
            float(entries[pelvis_i].t_weight) if pelvis_i >= 0 else 10.0
        )
        _HIPS_REDUCED_WEIGHT = 3.0

        solver = ik.IKSolver(
            model=model,
            n_problems=1,
            objectives=objectives,
            lambda_initial=0.1,
            jacobian_mode=ik.IKJacobianType.ANALYTIC,
        )

        joint_q = wp.empty(shape=(1, model.joint_coord_count), dtype=wp.float32)
        wp.copy(joint_q, model.joint_q)

        # First frame: seed the root at the scaled pelvis target.  The Newton
        # default is the URDF zero-pose which often has the pelvis at origin;
        # this prevents an aggressive first-frame root drift that otherwise
        # shows up as a single-frame "jump" in the CSV.
        if pelvis_entry is not None:
            jq = joint_q.numpy().copy()
            jq[0, 0:3] = ik_targets[0, pelvis_i, 0:3]
            jq[0, 3:7] = ik_targets[0, pelvis_i, 3:7]
            joint_q.assign(jq)

        out = np.empty((num_frames, model.joint_coord_count), dtype=np.float32)
        solver.reset()

        if progress_callback is not None:
            try:
                progress_callback(0, num_frames)
            except Exception:  # pragma: no cover
                pass

        ik_graph: object | None = None
        self._last_cuda_graph_requested = bool(
            num_frames > 0 and self.config.ik_use_cuda_graph and _warp_device_is_cuda()
        )
        if num_frames > 0 and _cuda_graph_enabled(self.config):

            def _ik_step_once() -> None:
                solver.step(
                    joint_q, joint_q, iterations=self.config.ik_iterations,
                )

            ik_graph = _try_capture_ik_step(_ik_step_once)

        for frame in range(num_frames):
            if use_dynamic_ground and pelvis_i >= 0:
                root_z = float(ik_targets[frame, pelvis_i, 2])
                groundedness = max(
                    0.0,
                    min(
                        1.0,
                        (_STANDING_ROOT_Z - root_z)
                        / max(_STANDING_ROOT_Z - _GROUND_ROOT_Z, 0.01),
                    ),
                )
                boost = 1.0 + _COLLISION_BOOST * groundedness
                ground_collision_obj.set_weight(
                    float(self.config.ground_collision_weight) * boost
                )

            if pelvis_i >= 0 and hand_ground_drop is not None and frame < len(hand_ground_drop):
                drop = float(hand_ground_drop[frame])
                if drop > 0.01:
                    blend = min(1.0, drop / 0.10)
                    position_objectives[pelvis_i].weight = (
                        hips_default_weight * (1.0 - blend)
                        + _HIPS_REDUCED_WEIGHT * blend
                    )
                else:
                    position_objectives[pelvis_i].weight = hips_default_weight

            for i in range(num_mapped):
                position_objectives[i].set_target_position(
                    0, wp.vec3(*ik_targets[frame, i, 0:3])
                )
                rotation_objectives[i].set_target_rotation(
                    0, wp.quat(*ik_targets[frame, i, 3:7])
                )

            def _ik_step_once() -> None:
                solver.step(
                    joint_q, joint_q, iterations=self.config.ik_iterations,
                )

            ik_graph = _run_ik_step(ik_graph=ik_graph, step_fn=_ik_step_once)
            out[frame] = joint_q.numpy()[0]
            if progress_callback is not None:
                try:
                    progress_callback(frame + 1, num_frames)
                except Exception:  # pragma: no cover — UI hooks shouldn't break IK
                    pass

        self._last_cuda_graph_used = ik_graph is not None
        return out

    # ---- multi-env batch solve ------------------------------------------------

    def _solve_ik_batch(
        self,
        ctx: NewtonRobotContext,
        padded_targets: NDArray,
        frame_counts: list[int],
        *,
        progress_callback: Callable[[int, int], None] | None = None,
        force_disable_rotation_objectives: bool = False,
    ) -> list[NDArray]:
        """Multi-env IK: one ``solver.step()`` per frame, *N* envs in parallel.

        Args:
            ctx: Newton context built with ``num_envs=1``.  The IK solver
                replicates this single-robot model into ``n_problems=N``
                independent problems internally; we must **not** pass a merged
                N-robot model or the per-problem Cholesky tile becomes
                ``(N · dof)²`` and exceeds the per-block shared-memory budget.
            padded_targets: ``(N, max_frames, M, 7)`` rectangular target buffer.
            frame_counts: Per-env real frame count (used to trim output).
            progress_callback: ``fn(frame_done, max_frames)``.
            force_disable_rotation_objectives: Zero non-pelvis rotation weights.

        Returns:
            List of ``(F_i, joint_coord_count)`` arrays, one per env.
        """
        with _warp_ik_guard():
            return self._solve_ik_batch_inner(
                ctx,
                padded_targets,
                frame_counts,
                progress_callback=progress_callback,
                force_disable_rotation_objectives=force_disable_rotation_objectives,
            )

    def _solve_ik_batch_inner(
        self,
        ctx: NewtonRobotContext,
        padded_targets: NDArray,
        frame_counts: list[int],
        *,
        progress_callback: Callable[[int, int], None] | None,
        force_disable_rotation_objectives: bool,
    ) -> list[NDArray]:
        N, max_frames, M, _ = padded_targets.shape
        model = ctx.model
        entries = self.ik_mapping.entries

        # --- Objectives (one array per objective, sized for N problems) ------
        position_objectives: list[ik.IKObjectivePosition] = []
        preset = self.robot.preset
        from hhtools.robot.retarget_profile import effective_ik_t_weight

        for entry in entries:
            pos_wp = wp.zeros(shape=N, dtype=wp.vec3)
            position_objectives.append(
                ik.IKObjectivePosition(
                    link_index=entry.t_body_index,
                    link_offset=wp.vec3(*entry.t_offset),
                    target_positions=pos_wp,
                    weight=effective_ik_t_weight(
                        entry.canonical_name, entry.t_weight, preset,
                        robot_model=self.robot,
                    ),
                )
            )

        _disable_rot = (
            force_disable_rotation_objectives
            or self.config.disable_rotation_objectives
        )
        rotation_objectives: list[ik.IKObjectiveRotation] = []
        for entry in entries:
            # Match single-env ``_solve_ik_sequence_inner``: Newton's
            # ``_update_rotation_target`` kernel expects ``vec4f``, not ``quatf``.
            rot_wp = wp.zeros(shape=N, dtype=wp.vec4)
            if _disable_rot:
                is_pelvis = entry.canonical_name in ("hips", "pelvis")
                weight = max(entry.r_weight, 5.0) if is_pelvis else 0.0
            else:
                weight = entry.r_weight
                if (
                    self._active_motion_source_format == "glb"
                    and entry.canonical_name == "chest"
                ):
                    weight = 0.0
            rotation_objectives.append(
                ik.IKObjectiveRotation(
                    link_index=entry.r_body_index,
                    link_offset_rotation=wp.quat_identity(),
                    target_rotations=rot_wp,
                    weight=weight,
                )
            )

        objectives: list[ik.IKObjective] = [
            *position_objectives, *rotation_objectives,
        ]
        if self.config.joint_limit_weight > 0.0:
            objectives.append(
                ik.IKObjectiveJointLimit(
                    joint_limit_lower=model.joint_limit_lower,
                    joint_limit_upper=model.joint_limit_upper,
                    weight=self.config.joint_limit_weight,
                )
            )
        if self.config.smooth_joint_filter_weight > 0.0:
            from hhtools.retarget.newton_basic.ik_objectives import (
                IKSmoothJointFilter,
            )
            coord_masks = self._build_smooth_joint_filter_coord_masks(model)
            objectives.append(
                IKSmoothJointFilter(
                    joint_limit_lower=model.joint_limit_lower,
                    joint_limit_upper=model.joint_limit_upper,
                    weight=self.config.smooth_joint_filter_weight,
                    coord_masks=coord_masks,
                )
            )

        solver = ik.IKSolver(
            model=model,
            n_problems=N,
            objectives=objectives,
            lambda_initial=0.1,
            jacobian_mode=ik.IKJacobianType.ANALYTIC,
        )

        joint_q = wp.empty(
            shape=(N, model.joint_coord_count), dtype=wp.float32,
        )
        # ``model`` is the single-robot context (``num_envs=1``), so its
        # ``joint_q`` holds one rest pose; broadcast it to all N problems.
        rest_np = model.joint_q.numpy().reshape(-1)
        joint_q.assign(
            np.broadcast_to(rest_np, (N, rest_np.shape[0])).astype(
                np.float32, copy=True
            )
        )

        # Seed pelvis per env from frame-0 targets.
        pelvis_entry = next(
            (e for e in entries if e.canonical_name in ("hips", "pelvis")),
            None,
        )
        if pelvis_entry is not None:
            jq_np = joint_q.numpy().copy()
            pidx = entries.index(pelvis_entry)
            for env in range(N):
                jq_np[env, 0:3] = padded_targets[env, 0, pidx, 0:3]
                jq_np[env, 3:7] = padded_targets[env, 0, pidx, 3:7]
            joint_q.assign(jq_np)

        out = np.empty(
            (N, max_frames, model.joint_coord_count), dtype=np.float32,
        )
        solver.reset()

        ik_graph: object | None = None
        self._last_cuda_graph_requested = bool(
            max_frames > 0 and self.config.ik_use_cuda_graph and _warp_device_is_cuda()
        )
        if max_frames > 0 and _cuda_graph_enabled(self.config):

            def _ik_batch_step_once() -> None:
                solver.step(
                    joint_q, joint_q, iterations=self.config.ik_iterations,
                )

            ik_graph = _try_capture_ik_step(_ik_batch_step_once)

        for frame in range(max_frames):
            for env in range(N):
                for i in range(M):
                    position_objectives[i].set_target_position(
                        env, wp.vec3(*padded_targets[env, frame, i, 0:3]),
                    )
                    rotation_objectives[i].set_target_rotation(
                        env, wp.quat(*padded_targets[env, frame, i, 3:7]),
                    )

            def _ik_batch_step_once() -> None:
                solver.step(
                    joint_q, joint_q, iterations=self.config.ik_iterations,
                )

            ik_graph = _run_ik_step(ik_graph=ik_graph, step_fn=_ik_batch_step_once)
            out[:, frame, :] = joint_q.numpy()

            if progress_callback is not None:
                try:
                    progress_callback(frame + 1, max_frames)
                except Exception:
                    pass

        self._last_cuda_graph_used = ik_graph is not None
        return [out[env, :frame_counts[env], :] for env in range(N)]

    # ---- smooth-joint-filter mask assembly ------------------------------------

    def _build_smooth_joint_filter_coord_masks(self, model) -> np.ndarray | None:
        """Expand the per-link mask dict into a per-coord mask array.

        Resolution order:

        1. :attr:`PipelineConfig.smooth_joint_filter_masks` if set
           (callers take full control; pipeline does NOT fall back to
           the preset when an empty dict is provided — empty means "no
           per-link preferences, regularise every coord uniformly").
        2. ``robot.preset.smooth_joint_filter_masks`` otherwise.
        3. ``None`` (uniform weight=1.0 on every coord) when neither
           source names any link.

        Newton's ``IKSmoothJointFilter`` expects ``(joint_coord_count,)``
        float32 values in ``[0, 1]``.  We look up each link name in
        ``model.body_label``, read its driving joint's ``joint_q_start``
        / ``joint_dof_dim`` from the model, and fill those coord slots
        with the mask value.  Coords not covered by any named link keep
        the default ``0.0`` (pass-through — the smoother skips them).

        This mirrors soma-retargeter's
        ``newton_utils.create_joint_coord_masks`` so mask values copied
        from the upstream config apply with identical semantics.
        """

        masks = self.config.smooth_joint_filter_masks
        if masks is None:
            masks = dict(self.ctx.preset.smooth_joint_filter_masks or {})
        if not masks and self.ctx.preset.urdf_path is not None and self.ctx.preset.ik_map:
            from hhtools.robot.kinematics import infer_smooth_joint_filter_masks

            masks = infer_smooth_joint_filter_masks(
                self.ctx.preset.urdf_path, dict(self.ctx.preset.ik_map),
            )
        if not masks:
            return None  # uniform weight — let IKSmoothJointFilter default
        try:
            joint_q_start = model.joint_q_start.numpy()
            joint_dof_dim = model.joint_dof_dim.numpy()
        except AttributeError:
            return None
        body_to_idx = {
            name: i for i, name in enumerate(self.ctx.body_labels)
        }
        out = np.zeros(model.joint_coord_count, dtype=np.float32)
        missing: list[str] = []
        for link_name, mask_value in masks.items():
            idx = body_to_idx.get(link_name)
            if idx is None:
                missing.append(link_name)
                continue
            start = int(joint_q_start[idx])
            dim = int(joint_dof_dim[idx][1])
            if start < 0 or dim <= 0:
                # ``start == -1`` / ``dim == 0`` means this body has no
                # driving joint (fixed / welded) — skip silently.
                continue
            out[start : start + dim] = float(mask_value)
        if missing:
            _log.warning(
                "smooth_joint_filter_masks references unknown links on "
                "robot %r (ignored): %s. Available link names: %s...",
                self.ctx.preset.name, missing, list(body_to_idx)[:8],
            )
        return out

    # ---- rate limiter ---------------------------------------------------------


# --------------------------------------------------------------------------- prewarm

_WARMED_ROBOT_PRESETS: set[str] = set()


def is_newton_ik_prewarmed(preset_name: str) -> bool:
    """True after :func:`prewarm_newton_ik_for_robot` succeeded for this preset."""
    return preset_name in _WARMED_ROBOT_PRESETS


def prewarm_newton_ik_for_robot(
    robot: URDFRobotModel,
    *,
    pipeline_config: PipelineConfig | None = None,
    ik_iterations: int = 1,
    force: bool = False,
) -> bool:
    """Run one dummy IK step so Warp kernels are compiled before the user clicks Retarget.

    The first :class:`NewtonBasicPipeline` solve in a fresh process triggers
    Warp JIT (often several seconds) plus an optional CUDA-graph capture.
    Calling this after the robot loads moves that cost off the critical path
    of the first retarget click.
    """
    preset_name = robot.preset.name
    if not force and preset_name in _WARMED_ROBOT_PRESETS:
        return False

    from hhtools.retarget.newton_basic.config import ScalerConfig

    stub_cfg = ScalerConfig(
        joint_scales={"hips": 1.0},
        root_joint="hips",
        model_height=1.3,
        human_height_assumption=1.7,
    )
    if pipeline_config is None:
        from hhtools.robot.retarget_profile import build_pipeline_config_for_preset

        pcfg = build_pipeline_config_for_preset(
            robot.preset,
            "lafan_bvh",
            ik_iterations=max(1, int(ik_iterations)),
        )
    else:
        pcfg = pipeline_config
    # Prewarm only JIT-compiles kernels — CUDA graph capture here races the
    # retarget worker on the same device and can poison subsequent launches.
    pcfg = replace(pcfg, ik_use_cuda_graph=False)
    try:
        pipe = NewtonBasicPipeline(
            robot,
            scaler_config=stub_cfg,
            pipeline_config=pcfg,
            human_height=1.7,
            configure_warp=True,
        )
        m = len(pipe.ik_mapping.entries)
        targets = np.zeros((1, m, 7), dtype=np.float32)
        targets[..., 6] = 1.0
        pipe._solve_ik_sequence(targets)
    except Exception as err:  # noqa: BLE001 — GPU optional in some builds
        _log.warning(
            "Newton IK prewarm failed for robot preset %r: %s",
            preset_name,
            err,
        )
        return False

    _WARMED_ROBOT_PRESETS.add(preset_name)
    _log.info("Newton IK prewarmed for robot preset %r", preset_name)
    return True
