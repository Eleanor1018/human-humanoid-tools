"""FRAX differential-IK retarget backend.

Same front and back halves as the Newton backend (:mod:`hhtools.retarget.ik_pipeline`):
scaled, floor-referenced IK targets go in; clamped, heading-aligned,
grounded ``joint_q`` comes out.  Only the solve differs:

* **Newton** runs ``ik_iterations`` Levenberg-Marquardt iterations per frame
  with soft joint-limit and ground penalties (Warp, float32).
* **FRAX** converges once on the first frame, then takes one differential-IK
  QP step per frame (frax + ElastiQP, JAX, float64).  Joint limits, the floor
  and (optionally) self-collision are inequality constraints, relaxed only
  when no feasible step exists.  A whole clip is one compiled ``lax.scan``,
  and batches spread clips over the CPU cores.

Objectives mirror Newton's: per-link position and rotation targets with the
same weights (including the position-only, GLB-chest and hands-on-ground
rules) and the same pull-to-midpoint joint filter.
"""

from __future__ import annotations

import hashlib
import logging
import threading
import time
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np
from numpy.typing import NDArray

from hhtools.retarget.frax_backend._jax_env import configure_jax, import_frax

frax = import_frax()

import jax  # noqa: E402  (configured by import_frax)
import jax.numpy as jnp  # noqa: E402
from frax.ik import (  # noqa: E402
    DEFAULT_PENALTY,
    DiffIKSolver,
    FloorConstraint,
    FrameTask,
    GlobalIKSolver,
    InequalityConstraint,
    JointLimits,
    OfflineRetargeter,
    Retargeter,
    SelfCollisionConstraint,
    Task,
)
from frax.utils.rotation_utils import rmat_to_quat_wxyz  # noqa: E402

from hhtools.core.motion import Motion  # noqa: E402
from hhtools.retarget.frax_backend.collision import collision_spec_for_robot  # noqa: E402
from hhtools.retarget.frax_backend.config import FraxConfig, frax_config_for_preset  # noqa: E402
from hhtools.retarget.frax_backend.model import FraxRobotModel, build_frax_robot_model  # noqa: E402
from hhtools.retarget.ik_mapping import IKMapping, IKMappingEntry, resolve_ik_map  # noqa: E402
from hhtools.retarget.ik_pipeline import (  # noqa: E402
    IKPipelineBase,
    PipelineConfig,
    PreparedIKTargets,
)
from hhtools.retarget.newton_basic.config import FeetStabilizerConfig, ScalerConfig  # noqa: E402
from hhtools.retarget.retarget_result import RetargetedMotion  # noqa: E402
from hhtools.robot.loader import URDFRobotModel  # noqa: E402

_log = logging.getLogger(__name__)

__all__ = ["FraxPipeline"]

#: Pelvis position weight while the hands carry the body (Newton's value).
_HIPS_REDUCED_WEIGHT = 3.0
#: Newton's position-only rule: the pelvis keeps at least this rotation weight.
_POSITION_ONLY_PELVIS_ROT_WEIGHT = 5.0
#: Floor rows kept per step (the lowest spheres).
_FLOOR_MAX_ROWS = 32


def _root_speed_directions() -> NDArray:
    """The 26 unit vectors towards the faces, edges and corners of a cube."""
    grid = np.array(
        [(x, y, z) for x in (-1, 0, 1) for y in (-1, 0, 1) for z in (-1, 0, 1) if x or y or z],
        dtype=float,
    )
    return grid / np.linalg.norm(grid, axis=1, keepdims=True)


#: ``{w : n_k . w <= 1}`` over :func:`_root_speed_directions` reaches at most
#: this far from the origin (its inradius is 1).
_ROOT_SPEED_POLYTOPE_RADIUS = 1.1281


# ---------------------------------------------------------------------------
# Tasks
# ---------------------------------------------------------------------------


@jax.tree_util.register_static
class _WeightedFrameTask(FrameTask):
    """Position-only or rotation-only :class:`FrameTask` with per-step weights.

    Weights come from ``ref[w_key]`` (one per frame), so motion-specific
    weighting (position-only sources, GLB chest, hands on the ground) changes
    no compiled code.
    """

    def __init__(self, robot, joints, *, gain: float, offsets, pos_key, rot_key, w_key: str):
        super().__init__(
            robot,
            joints,
            gain_pos=gain,
            gain_rot=gain,
            weight_pos=1.0,
            weight_rot=1.0,
            pos_key=pos_key,
            rot_key=rot_key,
            offsets=offsets,
        )
        assert (pos_key is None) != (rot_key is None)
        self.w_key = w_key

    def linearize(self, q, ref):
        J, v_des, _ = super().linearize(q, ref)
        return J, v_des, jnp.repeat(ref[self.w_key], 3)


@jax.tree_util.register_static
class _SmoothJointFilterTask(Task):
    """Newton's ``IKSmoothJointFilter``: pull joints towards mid-range near their limits.

    Same residual ``(q - c) * s(q - c)`` and the same simplified identity
    Jacobian, so a full step at ``gain = 1 / dt`` matches one Gauss-Newton
    step of the Newton objective.
    """

    def __init__(self, robot, lower, upper, mask, weight: float, gain: float):
        self.robot = robot
        lower = np.asarray(lower, dtype=float)
        upper = np.asarray(upper, dtype=float)
        mask = np.asarray(mask, dtype=float)
        keep = np.flatnonzero((mask > 0) & np.isfinite(lower) & np.isfinite(upper))
        self.idxs = robot.nv_floating + keep
        self.q_idxs = robot.nq_floating + keep
        self.J = np.eye(robot.nv)[self.idxs]
        self.centre = 0.5 * (lower[keep] + upper[keep])
        self.lo = lower[keep] + 1.02 - self.centre
        self.hi = upper[keep] - 1.02 - self.centre
        self.weight = float(weight) * mask[keep]
        self.gain = float(gain)
        self.num_rows = len(keep)

    def linearize(self, q, ref):
        x = q[self.q_idxs] - self.centre
        inside = (self.lo < x) & (x <= self.hi)
        diff = jnp.maximum(jnp.where(x <= self.lo, self.lo - x, x - self.hi), 0.0)
        s = jnp.where(inside, 0.0, 1.0 - jnp.exp(-(diff**6.5)))
        return self.J, -self.gain * x * s, self.weight


@jax.tree_util.register_static
class _RootAngularSpeedLimit(InequalityConstraint):
    """Keep the floating base's angular speed under ``ref[cap_key]`` (rad/s).

    The shared finalizer caps the root's rotation per frame (see
    :meth:`IKPipelineBase._root_angular_speed_caps`).  A linear QP cannot
    bound a norm, so the ball is replaced by the 26-sided polytope
    ``n_k . w <= cap / R``, which lies inside it: the root then never turns
    faster than the finalizer allows, and at worst 11% slower.
    """

    def __init__(
        self,
        robot,
        gain: float,
        cap_key: str = "root_cap",
        penalty: float = DEFAULT_PENALTY,
    ):
        self.robot = robot
        directions = _root_speed_directions()
        self.G = np.zeros((len(directions), robot.nv))
        self.G[:, 3:6] = directions  # frax floating-base velocity: (linear, angular)
        self.num_rows = len(directions)
        self.cap_key = cap_key
        self.penalty = penalty
        # Not used by ``rows``: frax reads every term's gain to size the
        # first-frame convergence step.
        self.gain = float(gain)

    def rows(self, q, ref):
        cap = ref[self.cap_key] / _ROOT_SPEED_POLYTOPE_RADIUS
        return self.G, jnp.full((self.num_rows,), cap)


# ---------------------------------------------------------------------------
# Caches (process-wide: compiled solvers outlive pipeline instances)
# ---------------------------------------------------------------------------

# Keys are content-based (URDF bytes, DOF order, collision model, options), so
# Agent jobs that materialize the same robot into fresh temporary folders reuse
# one model and solver.  Both caches are LRU-bounded.
_CACHE_LOCK = threading.RLock()
_MODEL_CACHE: OrderedDict[tuple, FraxRobotModel] = OrderedDict()
_SOLVER_CACHE: OrderedDict[tuple, _Solver] = OrderedDict()
_MAX_CACHED_MODELS = 8
_MAX_CACHED_SOLVERS = 16


def _file_digest(path: Path | None) -> str:
    if path is None:
        return ""
    try:
        return hashlib.sha256(Path(path).read_bytes()).hexdigest()
    except OSError:
        return ""


def _frax_model_for(robot: URDFRobotModel, config: FraxConfig) -> FraxRobotModel:
    """Build (or reuse) the frax model, with collision spheres when a constraint needs them.

    The key covers everything the model depends on: the URDF content, the
    exported DOF order (``dof_to_frax``) and the collision model.
    """
    preset = robot.preset
    spec = collision_spec_for_robot(robot) if (config.floor or config.self_collision) else None
    key = (
        _file_digest(preset.urdf_path),
        tuple(robot.dof_names()),
        None if spec is None else (spec.source, spec.signature()),
    )
    with _CACHE_LOCK:
        model = _MODEL_CACHE.get(key)
        if model is not None:
            _MODEL_CACHE.move_to_end(key)
            return model
        model = build_frax_robot_model(robot, collision=spec)
        model.cache_key = key
        _MODEL_CACHE[key] = model
        while len(_MODEL_CACHE) > _MAX_CACHED_MODELS:
            _MODEL_CACHE.popitem(last=False)
    return model


@dataclass
class _Solver:
    """A configured frax retargeter for one (robot, ik_map, config, frame rate)."""

    model: FraxRobotModel
    retargeter: Retargeter
    dt: float
    num_entries: int
    pelvis_index: int | None
    constraints: tuple[str, ...]
    single: Callable[..., Any]
    compiled: dict[tuple, Any] = field(default_factory=dict)
    compile_seconds: float = 0.0
    offline: OfflineRetargeter | None = None
    lock: threading.Lock = field(default_factory=threading.Lock)

    def compiled_for(self, frames: dict[str, NDArray]) -> tuple[Any, float]:
        """Compiled single-clip solve for these array shapes, and its compile time (0 if cached)."""
        leaves, tree = jax.tree.flatten(frames)
        key = (tree, tuple(x.shape for x in leaves))
        with self.lock:
            fn = self.compiled.get(key)
            if fn is not None:
                return fn, 0.0
            start = time.perf_counter()
            fn = self.single.lower(frames).compile()
            elapsed = time.perf_counter() - start
            self.compiled[key] = fn
            self.compile_seconds += elapsed
            return fn, elapsed

    def offline_retargeter(self, bucket: int) -> OfflineRetargeter:
        with self.lock:
            if self.offline is None:
                self.offline = OfflineRetargeter(
                    self.retargeter, self.dt, bucket=bucket, devices="all"
                )
            return self.offline


def _frame_offsets(model: FraxRobotModel, links, offsets) -> tuple[list[int], NDArray]:
    joints, transforms = [], []
    for link, offset in zip(links, offsets, strict=True):
        joint, T = model.link_frame(link)
        T = T.copy()
        T[:3, 3] = T[:3, 3] + T[:3, :3] @ np.asarray(offset, dtype=float)
        joints.append(joint)
        transforms.append(T)
    return joints, np.stack(transforms)


def _smooth_joint_mask(pipeline: FraxPipeline, model: FraxRobotModel) -> NDArray | None:
    """Per-actuated-joint (frax order) mask, resolved like Newton's coord masks."""
    preset = pipeline.robot.preset
    masks = pipeline.config.smooth_joint_filter_masks
    if masks is None:
        masks = dict(preset.smooth_joint_filter_masks or {})
    if not masks and preset.urdf_path is not None and preset.ik_map:
        from hhtools.robot.kinematics import infer_smooth_joint_filter_masks

        masks = infer_smooth_joint_filter_masks(preset.urdf_path, dict(preset.ik_map))
    n_act = model.nv - model.nv_floating
    if not masks:
        return np.ones(n_act)
    out = np.zeros(n_act)
    for link, value in masks.items():
        frame = model.link_frames.get(str(link))
        if frame is None:
            continue
        joint, T = frame
        # Only a joint's own child link drives it (fixed-attached links do not).
        if joint >= model.nv_floating and model.joint_link.get(joint) == str(link):
            out[joint - model.nv_floating] = float(value)
    return out


def _actuated_limits(model: FraxRobotModel, config: FraxConfig) -> tuple[NDArray, NDArray]:
    lower = np.asarray(model.robot.actuated_joint_lower_limits, dtype=float).copy()
    upper = np.asarray(model.robot.actuated_joint_upper_limits, dtype=float).copy()
    names = list(model.robot.joint_names[model.nv_floating :])
    for name, lo, hi in config.joint_limit_overrides:
        if name not in names:
            raise ValueError(f"retarget.frax.joint_limit_overrides: unknown joint {name!r}")
        k = names.index(name)
        lower[k], upper[k] = max(lower[k], lo), min(upper[k], hi)
        if lower[k] >= upper[k]:
            raise ValueError(
                f"retarget.frax.joint_limit_overrides.{name} lies outside the URDF limits"
            )
    # Joints outside dof_order are not exported; hold them where playback FK puts them.
    frozen = list(model.frozen_joints)
    lower[frozen] = 0.0
    upper[frozen] = 0.0
    return lower, upper


def _velocity_limit(pipeline: FraxPipeline, model: FraxRobotModel) -> NDArray | None:
    """Per-joint speed bound (rad/s) for the QP; ``None`` when unbounded.

    ``PipelineConfig.max_joint_velocity`` is the cap the shared finalizer
    enforces by clipping each joint's per-frame change.  Clipping after the
    solve moves joints without rechecking the feet, so FRAX's floor contact
    is lost and the clip floor snap then lifts the whole clip.  Bounding the
    speed inside the QP lets the other joints compensate; the finalizer's
    clip is then a no-op that stays as a safety net.  ``velocity_limits``
    adds the URDF limits on top.
    """
    n = model.nv - model.nv_floating
    cap = float(pipeline.config.max_joint_velocity)
    limit = np.full(n, cap if cap > 0.0 else np.inf)
    if pipeline.frax_config.velocity_limits:
        urdf = np.asarray(model.robot.actuated_joint_max_velocities, dtype=float)
        limit = np.minimum(limit, np.where(urdf > 0.0, urdf, np.inf))
    if not np.isfinite(limit).any():
        return None
    return limit


def _regularization(model: FraxRobotModel, config: FraxConfig) -> NDArray:
    reg = np.full(model.nv, float(config.regularization))
    index = model.robot.joint_name_to_index
    for name, value in config.joint_regularization:
        if name not in index:
            raise ValueError(f"retarget.frax.joint_regularization: unknown joint {name!r}")
        reg[index[name]] = float(value)
    return reg


def _build_solver(
    pipeline: FraxPipeline,
    model: FraxRobotModel,
    entries: tuple[IKMappingEntry, ...],
    fps: float,
    smooth_weight: float,
    smooth_mask: NDArray | None,
) -> _Solver:
    config = pipeline.frax_config
    robot = model.robot
    gain = float(fps)
    t_joints, t_offsets = _frame_offsets(
        model, [e.t_body_link for e in entries], [e.t_offset for e in entries]
    )
    r_joints, r_offsets = _frame_offsets(
        model, [e.r_body_link for e in entries], [(0.0, 0.0, 0.0)] * len(entries)
    )
    tasks: list[Task] = [
        _WeightedFrameTask(
            robot,
            t_joints,
            gain=gain,
            offsets=t_offsets,
            pos_key="pos",
            rot_key=None,
            w_key="w_pos",
        ),
        _WeightedFrameTask(
            robot,
            r_joints,
            gain=gain,
            offsets=r_offsets,
            pos_key=None,
            rot_key="rmat",
            w_key="w_rot",
        ),
    ]
    lower, upper = _actuated_limits(model, config)
    if smooth_weight > 0.0 and smooth_mask is not None:
        smooth = _SmoothJointFilterTask(robot, lower, upper, smooth_mask, smooth_weight, gain)
        if smooth.num_rows:
            tasks.append(smooth)

    # Constraint gains of 1/dt let a joint (or sphere) reach its limit within
    # one frame without overshooting (frax: keep gain * dt <= 1).
    v_max = _velocity_limit(pipeline, model)
    constraints: list[Any] = [
        JointLimits(
            robot,
            q_min=lower,
            q_max=upper,
            v_max=v_max,
            v_min=None if v_max is None else -v_max,
            gain=gain,
        )
    ]
    names = ["joint_limits" + ("" if v_max is None else "+velocity")]
    if float(pipeline.config.max_joint_velocity) > 0.0:
        # Same condition as the finalizer's rate limit, same per-frame cap.
        constraints.append(_RootAngularSpeedLimit(robot, gain))
        names.append("root_angular_speed")
    if config.floor and model.has_collision and model.floor_sphere_idxs:
        constraints.append(
            FloorConstraint(
                robot,
                sphere_idxs=np.asarray(model.floor_sphere_idxs),
                max_rows=_FLOOR_MAX_ROWS,
                gain=gain,
                margin=float(config.floor_margin),
            )
        )
        names.append("floor")
    if config.self_collision and model.has_self_collision:
        constraints.append(
            SelfCollisionConstraint(robot, max_rows=int(config.self_collision_rows), gain=gain)
        )
        names.append("self_collision")

    solver = DiffIKSolver(
        robot,
        tasks,
        constraints,
        regularization=_regularization(model, config),
        damping=float(config.damping),
        solver_tol=float(config.solver_tol),
    )

    pelvis = next(
        (i for i, e in enumerate(entries) if e.canonical_name in ("hips", "pelvis")), None
    )
    q_default = np.asarray(robot.default_configuration, dtype=float).copy()
    q_default[:3] = 0.0
    q_default[3:7] = (1.0, 0.0, 0.0, 0.0)
    joints0 = np.zeros(len(lower))
    outside = (joints0 < lower) | (joints0 > upper)
    joints0[outside] = 0.5 * (lower[outside] + upper[outside])
    q_default[robot.nq_floating :] = joints0

    def initial_q(frame):
        q = jnp.asarray(q_default)
        if pelvis is None:
            return q.at[:3].set(jnp.mean(frame["pos"], axis=0))
        q = q.at[:3].set(frame["pos"][pelvis])
        return q.at[3:7].set(rmat_to_quat_wxyz(frame["rmat"][pelvis]))

    global_ik = (
        GlobalIKSolver(solver, num_samples=int(config.global_ik_samples))
        if config.global_ik_init
        else None
    )
    retargeter = Retargeter(
        solver,
        lambda frame: frame,
        initial_q,
        converge_max_iters=int(config.converge_max_iters),
        global_ik_init=global_ik,
    )
    dt = 1.0 / float(fps)
    return _Solver(
        model=model,
        retargeter=retargeter,
        dt=dt,
        num_entries=len(entries),
        pelvis_index=pelvis,
        constraints=tuple(names),
        single=jax.jit(lambda frames: retargeter.retarget_clip(frames, dt)),
    )


def _smooth_settings(pipeline: FraxPipeline, model: FraxRobotModel) -> tuple[float, NDArray | None]:
    """Weight and per-joint mask of the mid-range filter (``(0, None)`` when off)."""
    config = pipeline.frax_config
    weight = (
        float(pipeline.config.smooth_joint_filter_weight)
        if config.midpoint_weight is None
        else float(config.midpoint_weight)
    )
    if weight <= 0.0:
        return 0.0, None
    return weight, _smooth_joint_mask(pipeline, model)


def _solver_for(pipeline: FraxPipeline, entries: tuple[IKMappingEntry, ...], fps: float) -> _Solver:
    model = pipeline.frax_model
    smooth_weight, smooth_mask = _smooth_settings(pipeline, model)
    key = (
        model.cache_key,
        pipeline.frax_config,
        round(float(pipeline.config.max_joint_velocity), 9),
        round(float(fps), 6),
        tuple(
            (
                e.canonical_name,
                e.t_body_link,
                e.r_body_link,
                tuple(round(float(x), 9) for x in e.t_offset),
            )
            for e in entries
        ),
        smooth_weight,
        None if smooth_mask is None else tuple(round(float(x), 9) for x in smooth_mask),
    )
    with _CACHE_LOCK:
        solver = _SOLVER_CACHE.get(key)
        if solver is not None:
            _SOLVER_CACHE.move_to_end(key)
            return solver
        solver = _build_solver(pipeline, model, entries, fps, smooth_weight, smooth_mask)
        _SOLVER_CACHE[key] = solver
        while len(_SOLVER_CACHE) > _MAX_CACHED_SOLVERS:
            _SOLVER_CACHE.popitem(last=False)
    return solver


def _rotation_matrices(quat_xyzw: NDArray) -> NDArray:
    from scipy.spatial.transform import Rotation

    q = np.asarray(quat_xyzw, dtype=float).reshape(-1, 4).copy()
    norms = np.linalg.norm(q, axis=1)
    bad = ~np.isfinite(norms) | (norms < 1e-9)
    q[bad] = (0.0, 0.0, 0.0, 1.0)
    return Rotation.from_quat(q).as_matrix().reshape(*quat_xyzw.shape[:-1], 3, 3)


def _pad_frames(frames: dict[str, NDArray], length: int) -> dict[str, NDArray]:
    n = next(iter(frames.values())).shape[0]
    if n >= length:
        return frames
    return {
        k: np.concatenate([v, np.repeat(v[-1:], length - n, axis=0)]) for k, v in frames.items()
    }


@dataclass
class _ClipJob:
    """One clip between the shared front half and the shared back half."""

    motion: Motion
    prepared: PreparedIKTargets
    ik_mapping: IKMapping
    source_format: str
    frames: dict[str, NDArray]


class FraxPipeline(IKPipelineBase):
    """Human → robot retarget with the FRAX differential-IK solver.

    Drop-in alternative to
    :class:`~hhtools.retarget.newton_basic.pipeline.NewtonBasicPipeline`:
    same constructor arguments plus ``frax_config``, same ``run`` /
    ``run_batch`` / ``scale_only`` results.  ``PipelineConfig.ik_iterations``,
    ``joint_limit_weight`` and the ground-collision options are Newton-only;
    FRAX enforces joint limits and the floor as constraints instead.

    Args:
        robot: Loaded robot.
        scaler_config / feet_stabilizer_config / pipeline_config /
            human_height / source_to_canonical: As for the Newton pipeline.
        frax_config: Solver options.  Defaults to the robot's
            ``retarget.frax`` block in ``robot.yaml``.
    """

    def __init__(
        self,
        robot: URDFRobotModel,
        *,
        scaler_config: ScalerConfig,
        feet_stabilizer_config: FeetStabilizerConfig | None = None,
        pipeline_config: PipelineConfig | None = None,
        human_height: float = 1.7,
        source_to_canonical: dict[str, str] | None = None,
        frax_config: FraxConfig | None = None,
    ) -> None:
        self._jax_state = configure_jax()
        self._init_shared(
            robot,
            scaler_config=scaler_config,
            feet_stabilizer_config=feet_stabilizer_config,
            pipeline_config=pipeline_config,
            human_height=human_height,
            source_to_canonical=source_to_canonical,
        )
        self.frax_config = (
            frax_config if frax_config is not None else frax_config_for_preset(robot.preset)
        )
        self._body_labels = [link.name for link in robot.links]
        mapping = resolve_ik_map(robot.preset, self._body_labels)
        if not mapping.entries:
            raise ValueError(f"robot preset {robot.preset.name!r} has no usable ik_map")
        self.frax_model = _frax_model_for(robot, self.frax_config)
        self._init_ik_mapping(mapping)
        used = {e.t_body_link for e in self.ik_mapping.entries}
        used |= {e.r_body_link for e in self.ik_mapping.entries}
        missing = sorted(used - set(self.frax_model.link_frames))
        if missing:
            raise ValueError(
                f"robot {robot.preset.name!r}: ik_map links not in the URDF: {missing}"
            )
        self._last_stats: dict[str, object] = {}

    # ---- IKPipelineBase contract ---------------------------------------------

    @property
    def _root_coord_count(self) -> int:
        return 7

    @property
    def _joint_coord_count(self) -> int:
        return 7 + len(self.robot.dof_names())

    @property
    def _ik_body_labels(self) -> list[str]:
        return self._body_labels

    @property
    def _used_mjcf(self) -> bool:
        return False

    def execution_provenance(self) -> dict[str, object]:
        state = self._jax_state
        platform = str(state.get("platform", "unknown"))
        return {
            "backend": "frax",
            "device": str(state.get("device", "unknown")),
            "device_kind": platform if platform in ("cpu", "cuda") else "unknown",
            "precision": "float64" if state.get("x64") else "float32",
            "runtime": "jax",
            "runtime_version": str(state.get("jax_version", "unknown")),
            "solver": f"frax-{_frax_version()}",
            "cuda_graph_requested": False,
            "cuda_graph_used": False,
            "fallback_used": False,
        }

    def _result_meta(self, *, clip_floor_snap_m: float) -> dict[str, object]:
        meta = super()._result_meta(clip_floor_snap_m=clip_floor_snap_m)
        meta.pop("ik_iterations", None)
        meta["frax"] = self.frax_summary()
        return meta

    def frax_summary(self) -> dict[str, object]:
        """Solver settings and the latest solve's timings, for ``RetargetedMotion.meta``."""
        model = self.frax_model
        cfg = self.frax_config
        return {
            "frax_version": _frax_version(),
            "regularization": cfg.regularization,
            "constraints": list(self._last_stats.get("constraints", ())),
            "collision_source": model.collision_source,
            "collision_spheres": model.num_collision_spheres,
            "floor_spheres": len(model.floor_sphere_idxs),
            "self_collision_pairs": model.num_self_collision_pairs,
            "global_ik_init": cfg.global_ik_init,
            "cpu_devices": int(self._jax_state.get("device_count", 1)),
            **{k: v for k, v in self._last_stats.items() if k != "constraints"},
        }

    # ---- solve -----------------------------------------------------------------

    def _objective_weights(
        self,
        entries: tuple[IKMappingEntry, ...],
        prepared: PreparedIKTargets,
        source_format: str,
    ) -> tuple[NDArray, NDArray]:
        """Per-frame ``(T, M)`` position and rotation weights, with Newton's rules."""
        from hhtools.robot.retarget_profile import effective_ik_t_weight

        preset = self.robot.preset
        T = prepared.ik_targets.shape[0]
        w_pos = np.asarray(
            [
                effective_ik_t_weight(e.canonical_name, e.t_weight, preset, robot_model=self.robot)
                for e in entries
            ],
            dtype=float,
        )
        disable_rot = prepared.position_only or self.config.disable_rotation_objectives
        w_rot = np.zeros(len(entries))
        for i, e in enumerate(entries):
            is_pelvis = e.canonical_name in ("hips", "pelvis")
            if disable_rot:
                # Position-only sources: heading tracking rests on the pelvis.
                w_rot[i] = max(e.r_weight, _POSITION_ONLY_PELVIS_ROT_WEIGHT) if is_pelvis else 0.0
            elif source_format == "glb" and e.canonical_name == "chest":
                # GLB spine maps to hips + chest; two rotation targets over-twist the waist.
                w_rot[i] = 0.0
            else:
                w_rot[i] = e.r_weight
        W_pos = np.tile(w_pos, (T, 1))
        W_rot = np.tile(w_rot, (T, 1))
        pelvis = next(
            (i for i, e in enumerate(entries) if e.canonical_name in ("hips", "pelvis")), None
        )
        drop = prepared.hand_ground_drop
        if pelvis is not None and drop is not None and len(drop):
            n = min(len(drop), T)
            d = np.asarray(drop[:n], dtype=float)
            blend = np.clip(d / 0.10, 0.0, 1.0)
            # Let the hands carry the body: loosen the pelvis position target.
            W_pos[:n, pelvis] = np.where(
                d > 0.01,
                w_pos[pelvis] * (1.0 - blend) + _HIPS_REDUCED_WEIGHT * blend,
                w_pos[pelvis],
            )
        return W_pos, W_rot

    def _clip_job(
        self, motion: Motion, prepared: PreparedIKTargets, source_format: str
    ) -> _ClipJob:
        entries = self.ik_mapping.entries
        targets = np.asarray(prepared.ik_targets, dtype=float)
        W_pos, W_rot = self._objective_weights(entries, prepared, source_format)
        frames = {
            "pos": np.ascontiguousarray(targets[:, :, 0:3]),
            "rmat": _rotation_matrices(targets[:, :, 3:7]),
            "w_pos": W_pos,
            "w_rot": W_rot,
            "root_cap": self._root_caps(motion, prepared, targets.shape[0]),
        }
        return _ClipJob(
            motion=motion,
            prepared=prepared,
            ik_mapping=self.ik_mapping,
            source_format=source_format,
            frames=frames,
        )

    def _root_caps(self, motion: Motion, prepared: PreparedIKTargets, n: int) -> NDArray:
        """``(n,)`` root angular speed cap (rad/s) into each solver frame.

        The finalizer's per-frame caps on the real frames; its fixed floor on
        the warm-up and stabilisation frames, which repeat the first and last
        targets.
        """
        caps = np.full(n, self._root_angular_speed_floor(), dtype=float)
        n_init = int(prepared.n_init)
        real = n - n_init - int(prepared.n_stab)
        if real > 1:
            caps[n_init + 1 : n_init + real] = self._root_angular_speed_caps(
                real, float(motion.framerate), prepared.source_root_quat
            )
        return caps

    def _padded_length(self, n: int) -> int:
        bucket = max(1, int(self.frax_config.frame_bucket))
        return max(bucket, -(-n // bucket) * bucket)

    def _solve_clip(
        self,
        job: _ClipJob,
        progress_callback: Callable[[int, int], None] | None = None,
    ) -> NDArray:
        frames = job.frames
        n = frames["pos"].shape[0]
        _notify(progress_callback, 0, n)
        solver = _solver_for(self, job.ik_mapping.entries, job.motion.framerate)
        padded = _pad_frames(frames, self._padded_length(n))
        fn, compile_s = solver.compiled_for(padded)
        start = time.perf_counter()
        q, infos, init_iters = fn(padded)
        q = np.asarray(jax.block_until_ready(q))[:n]
        solve_s = time.perf_counter() - start
        converged = np.asarray(infos.qp_converged)[: max(n - 1, 0)]
        init_iters = int(init_iters)
        self._last_stats = {
            "constraints": solver.constraints,
            "compile_s": round(compile_s, 3),
            "solve_s": round(solve_s, 4),
            "solver_frames": n,
            "padded_frames": int(padded["pos"].shape[0]),
            "init_iterations": init_iters,
            "init_converged": init_iters < int(self.frax_config.converge_max_iters),
            "qp_converged_ratio": float(converged.mean()) if converged.size else 1.0,
            "qp_max_iterations": int(np.asarray(infos.qp_iters)[: max(n - 1, 0)].max(initial=0)),
        }
        _notify(progress_callback, n, n)
        return self.frax_model.joint_q_from_frax_q(q)

    def _run_with_active_ik_map(
        self,
        motion: Motion,
        *,
        progress_callback: Callable[[int, int], None] | None = None,
    ) -> RetargetedMotion:
        prepared = self._prepare_solver_targets(motion)
        job = self._clip_job(motion, prepared, self._active_motion_source_format)
        joint_q_all = self._solve_clip(job, progress_callback)
        return self._finalize_solved_joint_q(joint_q_all, motion, prepared)

    def run_many(self, motions) -> list[RetargetedMotion]:
        """Retarget motions one at a time (see :meth:`run_batch` for the parallel path)."""
        return [self.run(m) for m in motions]

    def run_batch(
        self,
        motions: list[Motion],
        *,
        progress_callback: Callable[[int, int], None] | None = None,
    ) -> list[RetargetedMotion]:
        """Retarget several motions, spreading clips across the CPU devices.

        Each clip gets the same front half, solve and back half as :meth:`run`
        (unlike the Newton batch path, hands-on-ground weighting and the
        per-clip IK policy are kept).  ``progress_callback(done, total)``
        counts clips.
        """
        if not motions:
            return []
        if len(motions) == 1:
            return [self.run(motions[0], progress_callback=progress_callback)]

        total = len(motions)
        results: list[RetargetedMotion | None] = [None] * total
        jobs: list[tuple[int, _ClipJob]] = []
        _notify(progress_callback, 0, total)
        for i, raw in enumerate(motions):
            motion = self._normalize_input_motion(raw)
            source_format = str(getattr(motion, "source_format", "") or "").lower()
            if motion.num_frames == 0:
                results[i] = self._empty_result(motion)
                continue
            self._active_motion_source_format = source_format
            restore = self._push_motion_ik_policy(motion)
            try:
                prepared = self._prepare_solver_targets(motion)
                jobs.append((i, self._clip_job(motion, prepared, source_format)))
            finally:
                if restore is not None:
                    self.ik_mapping = restore

        groups: dict[tuple, list[tuple[int, _ClipJob]]] = {}
        for i, job in jobs:
            key = (
                tuple(e.canonical_name for e in job.ik_mapping.entries),
                round(job.motion.framerate, 6),
            )
            groups.setdefault(key, []).append((i, job))

        done = total - len(jobs)
        for members in groups.values():
            first = members[0][1]
            solver = _solver_for(self, first.ik_mapping.entries, first.motion.framerate)
            offline = solver.offline_retargeter(int(self.frax_config.frame_bucket))
            compile_before = offline.compile_time
            start = time.perf_counter()
            qs = offline([job.frames for _, job in members])
            solve_s = time.perf_counter() - start
            compile_s = offline.compile_time - compile_before
            for (i, job), q in zip(members, qs, strict=True):
                self._last_stats = {
                    "constraints": solver.constraints,
                    "compile_s": round(compile_s, 3),
                    "batch_solve_s": round(solve_s - compile_s, 4),
                    "batch_clips": len(members),
                    "solver_frames": int(job.frames["pos"].shape[0]),
                }
                saved_mapping, saved_format = self.ik_mapping, self._active_motion_source_format
                self.ik_mapping, self._active_motion_source_format = (
                    job.ik_mapping,
                    job.source_format,
                )
                try:
                    results[i] = self._finalize_solved_joint_q(
                        self.frax_model.joint_q_from_frax_q(q), job.motion, job.prepared
                    )
                finally:
                    self.ik_mapping, self._active_motion_source_format = saved_mapping, saved_format
                done += 1
                _notify(progress_callback, done, total)
        return [
            r if r is not None else self._empty_result(m)
            for r, m in zip(results, motions, strict=True)
        ]


def _notify(callback: Callable[[int, int], None] | None, done: int, total: int) -> None:
    if callback is None:
        return
    try:
        callback(done, total)
    except Exception:  # pragma: no cover - UI hooks must not break the solve
        pass


def _frax_version() -> str:
    from importlib.metadata import PackageNotFoundError, version

    try:
        return version("frax")
    except PackageNotFoundError:  # pragma: no cover
        return "unknown"
