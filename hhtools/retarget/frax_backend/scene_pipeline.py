"""FRAX scene retarget: terrain-aware differential IK on the interaction-mesh front half.

:class:`FraxScenePipeline` takes the scaled scene and robot contact points of
:class:`~hhtools.retarget.interaction_mesh.pipeline.InteractionMeshPipeline`
(:meth:`~InteractionMeshPipeline.prepare_scene_targets`) and solves the same kind of
tracking problem with the FRAX differential-IK QP instead of a Python SQP loop: position
targets for every point, the source pelvis orientation, joint limits, a heightfield
barrier for the collision spheres and foot sticking.  The whole clip is one compiled
``lax.scan``.  The output ``joint_q`` lives in the source world frame (uniformly scaled,
floor at z = 0), like the interaction-mesh result.
"""

from __future__ import annotations

import logging
import threading
import time
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass, field, fields, replace
from typing import Any

import numpy as np
from numpy.typing import NDArray

from hhtools.retarget.frax_backend._jax_env import configure_jax, import_frax

frax = import_frax()

import jax  # noqa: E402  (configured by import_frax)
import jax.numpy as jnp  # noqa: E402
from frax.ik import (  # noqa: E402
    DiffIKSolver,
    FloorConstraint,
    JointLimits,
    SelfCollisionConstraint,
    Task,
)

from hhtools.core.motion import Motion  # noqa: E402
from hhtools.retarget.frax_backend.config import FraxConfig, frax_config_for_preset  # noqa: E402
from hhtools.retarget.frax_backend.model import FraxRobotModel  # noqa: E402
from hhtools.retarget.frax_backend.pipeline import (  # noqa: E402
    _CACHE_LOCK,
    _FLOOR_MAX_ROWS,
    _actuated_limits,
    _execution_provenance,
    _frax_model_for,
    _frax_version,
    _pad_frames,
    _regularization,
    _rotation_matrices,
    _WeightedFrameTask,
)
from hhtools.retarget.frax_backend.terrain import (  # noqa: E402
    FootStickConstraint,
    TerrainConstraint,
    build_terrain_grid,
    column_distance_rows,
)
from hhtools.retarget.interaction_mesh.config import InteractionMeshPipelineConfig  # noqa: E402
from hhtools.retarget.interaction_mesh.mpc_loop import (  # noqa: E402
    RobotMpcPoint,
    _current_robot_point_positions,
    resolve_foot_mpc_points,
)
from hhtools.retarget.interaction_mesh.mujoco_scene import MujocoScene  # noqa: E402
from hhtools.retarget.interaction_mesh.pipeline import InteractionMeshPipeline  # noqa: E402
from hhtools.retarget.retarget_result import RetargetedMotion  # noqa: E402
from hhtools.robot.loader import URDFRobotModel  # noqa: E402

__all__ = ["FraxSceneConfig", "FraxScenePipeline"]

#: Largest disagreement (m) between a MuJoCo point and its frax joint-frame image.
_POINT_FRAME_TOLERANCE = 1e-6
#: Random configurations used to find the frax joint frame of each robot point.
_POINT_FRAME_SAMPLES = 3
#: Same near-identity test as the interaction-mesh SQP uses for the source pelvis quaternion.
_IDENTITY_QUAT_TOL = 0.01

#: Horizontal speed cap (m/s) of a foot that is not planted: never binding.
_FREE_FOOT_SPEED = 1e3

_MAX_CACHED_SCENE_SOLVERS = 16

_LOG = logging.getLogger(__name__)


@dataclass(frozen=True)
class FraxSceneConfig:
    """Scene-solve options of :class:`FraxScenePipeline` (frozen: part of the solver cache key).

    The terrain barrier is a local signed distance linearised at the current configuration; its
    obstacle rows see columns within ``terrain_reach`` (capped at 12 cells each side, so
    ``0.25 m`` at 1 cm cells sees only 12 cm), so one step per frame already holds a foot at a
    wall or step face (toy robot, up to 10 cm per frame: no sole sphere beyond 2 mm).
    ``substeps`` re-linearises within a frame: on the parkour clips 2 improved mean tracking by
    about 0.5 cm but made the joints jerkier and did not reduce penetration, so the default is 1.

    A foot is planted in a frame when its target moved less than
    ``foot_sticking_velocity_threshold`` in that frame; it is released in the first frame the
    target moves farther.  Holding it longer builds up a lag that is recovered in one frame
    (measured: a 3-frame release delay raised the largest joint acceleration by half).

    Attributes:
        position_weight: Multiplies ``sqrt(point.weight)`` of every tracked point; trades
            tracking against smoothness.  On the parkour clips 0.5 gave the joint
            accelerations of the interaction-mesh solver; 1.0 tracked 1.2 cm closer with
            1.5 times the acceleration.
        root_rotation_weight: Weight of the source pelvis orientation, when supplied.
        terrain_margin: Extra clearance kept between each terrain-constrained sphere's surface
            and the terrain (m).
        terrain_rows: Lowest-barrier *rows* kept per step, over all terrain-constrained spheres
            (each contributes ``ROWS_PER_SPHERE`` = 9: support plus up to 8 obstacle rows);
            a row dropped here is not enforced that step.
        terrain_reach: Horizontal distance (m) within which columns are seen, rounded up to
            cells and clipped to 2..12 cells each side; a sphere moving farther than that in one
            solver step could cross a wall unseen.
        foot_sticking: Hold planted feet in place horizontally.
        foot_sticking_tolerance: Allowed XY drift per frame of a planted foot (m).
        foot_sticking_velocity_threshold: Source foot XY move per frame below which the foot
            counts as planted (m).
        substeps: QP steps per frame, each re-linearised.
        terrain_snap: If every terrain-constrained sphere (feet, hands, knees, ...) stays clear
            of the terrain in every frame, lower the clip by the smallest straight-down
            clearance beyond ``terrain_margin`` (sphere surfaces stay ``terrain_margin`` from the
            terrain; Euclidean, not just vertical).  Never lifts: the terrain constraint already
            keeps the body out, so a sphere inside the terrain is a local violation that a
            global shift cannot fix.
        grid_bucket: ``build_terrain_grid(shape_bucket=...)``.
    """

    position_weight: float = 0.5
    root_rotation_weight: float = 5.0
    terrain_margin: float = 0.0
    terrain_rows: int = 32
    terrain_reach: float = 0.25
    foot_sticking: bool = True
    foot_sticking_tolerance: float = 1e-3
    foot_sticking_velocity_threshold: float = 0.01
    substeps: int = 1
    terrain_snap: bool = True
    grid_bucket: int = 64

    def __post_init__(self) -> None:
        if self.substeps < 1:
            raise ValueError(f"substeps must be >= 1, got {self.substeps}")

    def with_overrides(self, **overrides: Any) -> FraxSceneConfig:
        """Return a copy with ``overrides`` applied (unknown keys rejected)."""
        known = {f.name for f in fields(self)}
        unknown = sorted(set(overrides) - known)
        if unknown:
            raise ValueError(f"unknown FRAX scene option(s): {', '.join(unknown)}")
        return replace(self, **overrides)


# ---------------------------------------------------------------------------
# Robot points -> frax frames
# ---------------------------------------------------------------------------


def _frax_point_frames(
    model: FraxRobotModel, mj_model, robot_points: list[RobotMpcPoint]
) -> tuple[list[int], NDArray[np.float64]]:
    """Frax joint index and ``(4, 4)`` offset (identity rotation) of every robot point.

    MuJoCo body names need not be URDF link names and body frames need not equal URDF link
    frames, so the joint is found numerically: it is the one in whose frame the point's
    coordinates do not change across random actuated configurations.
    """
    import mujoco

    robot = model.robot
    if int(mj_model.jnt_type[0]) != int(mujoco.mjtJoint.mjJNT_FREE):
        raise ValueError("MuJoCo model's first joint is not a free joint")
    n_act = model.nv - model.nv_floating
    names = list(robot.joint_names[model.nv_floating :])
    jids = [mujoco.mj_name2id(mj_model, mujoco.mjtObj.mjOBJ_JOINT, n) for n in names]
    rng = np.random.default_rng(0)
    data = mujoco.MjData(mj_model)

    candidates = list(range(model.nv_floating - 1, model.nv))
    local = np.zeros((_POINT_FRAME_SAMPLES, len(candidates), len(robot_points), 3))
    for k in range(_POINT_FRAME_SAMPLES):
        values = rng.uniform(-0.4, 0.4, n_act)
        q = np.array(robot.default_configuration, dtype=np.float64)
        q[:7] = (0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0)
        data.qpos[:] = 0.0
        data.qpos[:7] = (0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0)
        for i, jid in enumerate(jids):
            if jid < 0:
                q[7 + i] = 0.0
            else:
                q[7 + i] = values[i]
                data.qpos[mj_model.jnt_qposadr[jid]] = values[i]
        mujoco.mj_forward(mj_model, data)
        world = _current_robot_point_positions(mj_model, data, robot_points)
        tfs = np.asarray(robot.joint_to_world_transforms(jnp.asarray(q)))[candidates]
        local[k] = np.einsum("jba,jpb->jpa", tfs[:, :3, :3], world[None] - tfs[:, None, :3, 3])

    deviation = np.abs(local - local[:1]).max(axis=(0, 3))  # (J, P)
    best = deviation.argmin(axis=0)
    joints: list[int] = []
    offsets = np.tile(np.eye(4), (len(robot_points), 1, 1))
    for p, point in enumerate(robot_points):
        if deviation[best[p], p] >= _POINT_FRAME_TOLERANCE:
            raise ValueError(
                f"robot point {point.body_name!r} ({point.semantic!r}) is not rigid in any "
                f"frax joint frame (best deviation {deviation[best[p], p]:.2e} m)"
            )
        joints.append(candidates[best[p]])
        offsets[p, :3, 3] = local[:, best[p], p].mean(axis=0)
    return joints, offsets


def _terrain_distance(grid, points: NDArray, window: int) -> NDArray[np.float64]:
    """Signed distance (m) of ``points`` (..., 3) to the terrain, as the solver's rows see it.

    Local (obstacles within ``window`` cells), so the cost is linear in the number of points;
    the brute-force :meth:`TerrainGrid.signed_distance` is points x columns.
    """
    flat = jnp.asarray(np.asarray(points, dtype=np.float64).reshape(-1, 3))
    d, _ = _distance_rows(grid.as_ref(), flat, window)
    return np.asarray(d).min(axis=1).reshape(np.shape(points)[:-1])


_distance_rows = jax.jit(column_distance_rows, static_argnums=2)


def _root_rotation_weights(quats_xyzw: NDArray, weight: float) -> NDArray[np.float64]:
    """Per-frame weight of the source pelvis orientation: ``weight``, or 0 for the whole clip.

    Position-only sources store identity rotations, which carry no orientation; a track with
    any real rotation is tracked in every frame, identity frames included.  ``q`` and ``-q``
    are the same rotation.
    """
    q = np.asarray(quats_xyzw, dtype=np.float64)
    identity = np.array([0.0, 0.0, 0.0, 1.0])
    off = np.minimum(np.abs(q - identity).max(axis=1), np.abs(q + identity).max(axis=1))
    informative = bool((off >= _IDENTITY_QUAT_TOL).any())
    return np.full(len(q), float(weight) if informative else 0.0)


def _terrain_snap_offset(min_clearance: float) -> float:
    """Downward root shift for the final terrain snap, given the lowest vertical clearance (m).

    Only a clip that floats everywhere is lowered.  A negative clearance is a local constraint
    violation (a foot grazing a wall, say); lifting the whole clip for it would make every
    other frame float.
    """
    return float(min_clearance) if np.isfinite(min_clearance) and min_clearance > 1e-4 else 0.0


def _returned_min_gap(grid, spheres: NDArray, radii: NDArray, drop: float, window: int) -> float:
    """Lowest terrain signed gap (m) of ``spheres`` (T, S, 3) after the clip is lowered by ``drop``.

    The distance is evaluated at the lowered centres: subtracting ``drop`` from a distance would
    be wrong whenever the nearest terrain feature is a side or an edge rather than the surface
    straight below.
    """
    lowered = np.array(spheres, dtype=np.float64)
    lowered[..., 2] -= drop
    return float((_terrain_distance(grid, lowered, window) - radii).min())


def _limit_edit_by_terrain(
    pre: NDArray,
    post: NDArray,
    gap_fn: Callable[[NDArray], NDArray],
    fps: float,
    *,
    root_coord_count: int = 7,
    tol: float = 1e-4,
    bisect_steps: int = 8,
) -> tuple[NDArray, int]:
    """Blend a post-IK joint edit ``pre -> post`` back where it creates terrain penetration.

    ``gap_fn(joint_q)`` returns the lowest terrain signed gap (m) over the constrained spheres of
    every frame, shape ``(T,)``.  A frame is *worse* when the edited gap is below
    ``min(pre gap, 0) - tol`` (the edit creates or deepens a penetration).  For those frames the
    largest ``alpha`` in [0, 1] of ``pre + alpha * (post - pre)`` that is not worse is found by
    bisection; the alphas are then smoothed over ~0.2 s with a centred min filter and a centred
    moving average (never above a frame's own limit) and re-checked, a frame still worse falling
    back to ``alpha = 0``.  Returns the blended joint_q and the number of limited frames.
    """
    from scipy.ndimage import minimum_filter1d, uniform_filter1d

    pre = np.asarray(pre, dtype=np.float32)
    post = np.asarray(post, dtype=np.float32)
    if pre.shape != post.shape or np.array_equal(pre, post):
        return post, 0
    cols = slice(int(root_coord_count), None)
    delta = post - pre

    def blend(alpha: NDArray) -> NDArray:
        out = post.copy()
        out[:, cols] = pre[:, cols] + alpha[:, None].astype(np.float32) * delta[:, cols]
        return out

    gap_pre = np.asarray(gap_fn(pre), dtype=np.float64)
    floor = np.minimum(gap_pre, 0.0) - tol

    def worse(alpha: NDArray) -> NDArray:
        return np.asarray(gap_fn(blend(alpha)), dtype=np.float64) < floor

    alpha = np.ones(len(pre))
    bad = worse(alpha)
    if not bad.any():
        return post, 0
    lo, hi = np.zeros(len(pre)), np.ones(len(pre))
    for _ in range(bisect_steps):
        mid = 0.5 * (lo + hi)
        ok = ~worse(mid)
        lo, hi = np.where(ok, mid, lo), np.where(ok, hi, mid)
    alpha = np.where(bad, lo, 1.0)
    width = 2 * max(1, int(round(0.1 * fps))) + 1
    alpha = minimum_filter1d(alpha, width, mode="nearest")
    alpha = uniform_filter1d(alpha, width, mode="nearest")
    alpha = np.minimum(alpha, 1.0)
    alpha[worse(alpha)] = 0.0
    return blend(alpha), int((alpha < 1.0 - 1e-6).sum())


def _point_key(points: list[RobotMpcPoint]) -> tuple:
    return tuple((p.body_name, tuple(float(x) for x in np.ravel(p.local_offset))) for p in points)


def _offset_key(offsets: NDArray) -> tuple:
    return tuple(np.round(np.asarray(offsets, dtype=float), 9).ravel().tolist())


def _fk_points(model: FraxRobotModel, q, joints, offsets) -> NDArray[np.float64]:
    """World positions of the frames ``(joints, offsets)`` at configuration ``q`` (NumPy)."""
    tfs = np.asarray(model.robot.joint_to_world_transforms(jnp.asarray(q)))[list(joints)]
    return np.einsum("pab,pb->pa", tfs[:, :3, :3], offsets[:, :3, 3]) + tfs[:, :3, 3]


def _rigid_fit(a: NDArray, b: NDArray) -> tuple[NDArray, NDArray]:
    """Kabsch: proper rotation ``R`` and ``t`` minimising ``sum ||R a_i + t - b_i||^2``."""
    ca, cb = a.mean(axis=0), b.mean(axis=0)
    U, _, Vt = np.linalg.svd((a - ca).T @ (b - cb))
    d = 1.0 if np.linalg.det(Vt.T @ U.T) >= 0.0 else -1.0
    R = Vt.T @ np.diag([1.0, 1.0, d]) @ U.T
    return R, cb - R @ ca


# ---------------------------------------------------------------------------
# Compiled solver
# ---------------------------------------------------------------------------


@dataclass
class _SceneSolver:
    """A configured scene solver for one (robot, points, config, frame rate)."""

    ik: DiffIKSolver
    solve: Callable[..., Any]
    constraints: tuple[str, ...]
    points_fn: Callable[[Any], Any]
    floor_fn: Callable[[Any], Any] | None
    compiled: dict[tuple, Any] = field(default_factory=dict)
    lock: threading.Lock = field(default_factory=threading.Lock)

    def compiled_for(self, frames, static, q0) -> tuple[Any, float]:
        """Compiled solve for these argument shapes, and its compile time (0 if cached)."""
        leaves, tree = jax.tree.flatten((frames, static, q0))
        key = (tree, tuple(x.shape for x in leaves))
        with self.lock:
            fn = self.compiled.get(key)
            if fn is not None:
                return fn, 0.0
            start = time.perf_counter()
            fn = self.solve.lower(frames, static, q0).compile()
            elapsed = time.perf_counter() - start
            self.compiled[key] = fn
            return fn, elapsed


_SCENE_SOLVER_CACHE: OrderedDict[tuple, _SceneSolver] = OrderedDict()


def _build_scene_solver(
    model: FraxRobotModel,
    frax_config: FraxConfig,
    scene_config: FraxSceneConfig,
    fps: float,
    point_joints: list[int],
    point_offsets: NDArray,
    foot_joints: list[int],
    foot_offsets: NDArray,
    *,
    has_terrain: bool,
    has_stick: bool,
    terrain_window: int,
) -> _SceneSolver:
    robot = model.robot
    gain = float(fps)
    dt = 1.0 / gain
    tasks: list[Task] = [
        _WeightedFrameTask(
            robot,
            point_joints,
            gain=gain,
            offsets=point_offsets,
            pos_key="pos",
            rot_key=None,
            w_key="w_pos",
        ),
        _WeightedFrameTask(
            robot,
            [model.nv_floating - 1],
            gain=gain,
            offsets=np.eye(4)[None],
            pos_key=None,
            rot_key="root_rmat",
            w_key="w_root",
        ),
    ]
    lower, upper = _actuated_limits(model, frax_config)
    v_max = None
    if frax_config.velocity_limits:
        urdf = np.asarray(robot.actuated_joint_max_velocities, dtype=float)
        # Each substep integrates over a whole frame, so the frame's travel is the sum.
        limit = np.where(urdf > 0.0, urdf, np.inf) / float(scene_config.substeps)
        v_max = limit if np.isfinite(limit).any() else None
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
    if has_terrain and model.has_collision and model.floor_sphere_idxs:
        constraints.append(
            TerrainConstraint(
                robot,
                sphere_idxs=np.asarray(model.floor_sphere_idxs),
                max_rows=int(scene_config.terrain_rows),
                gain=gain,
                margin=float(scene_config.terrain_margin),
                window=terrain_window,
            )
        )
        names.append("terrain")
    elif frax_config.floor and not has_terrain and model.has_collision and model.floor_sphere_idxs:
        constraints.append(
            FloorConstraint(
                robot,
                sphere_idxs=np.asarray(model.floor_sphere_idxs),
                max_rows=_FLOOR_MAX_ROWS,
                gain=gain,
                margin=float(frax_config.floor_margin),
            )
        )
        names.append("floor")
    if has_stick:
        constraints.append(
            FootStickConstraint(
                robot,
                foot_joints,
                foot_offsets,
                gain=gain,
            )
        )
        names.append("foot_stick")
    if frax_config.self_collision and model.has_self_collision:
        constraints.append(
            SelfCollisionConstraint(robot, max_rows=int(frax_config.self_collision_rows), gain=gain)
        )
        names.append("self_collision")

    solver = DiffIKSolver(
        robot,
        tasks,
        constraints,
        regularization=_regularization(model, frax_config),
        damping=float(frax_config.damping),
        solver_tol=float(frax_config.solver_tol),
    )
    max_iters = int(frax_config.converge_max_iters)
    substeps = int(scene_config.substeps)

    def solve(frames, static, q0):
        def ref_of(frame):
            return {**frame, **static}

        first = jax.tree.map(lambda x: x[0], frames)
        rest = jax.tree.map(lambda x: x[1:], frames)
        state, init_iters = solver.converge(
            solver.init(q0), ref_of(first), max_iters, dt, 1e-3 * fps
        )

        def body(state, frame):
            ref = ref_of(frame)
            for _ in range(substeps):  # each substep re-linearises at the new configuration
                state, _v, info = solver.step(state, ref, dt)
            return state, (state.q, info)

        _, (q, infos) = jax.lax.scan(body, state, rest)
        return jnp.concatenate([state.q[None], q]), infos, init_iters

    pj = np.asarray(point_joints)
    po = np.asarray(point_offsets, dtype=float)[:, :3, 3]

    def points(q):
        tfs = robot.joint_to_world_transforms(q)[pj]
        return jnp.einsum("pab,pb->pa", tfs[:, :3, :3], po) + tfs[:, :3, 3]

    floor_fn = None
    if model.has_collision and model.floor_sphere_idxs:
        floor = np.asarray(model.floor_sphere_idxs)

        def floor_fn(q):
            return robot._link_collision_positions(robot.joint_to_world_transforms(q))[floor]

        floor_fn = jax.jit(jax.vmap(floor_fn))

    return _SceneSolver(
        ik=solver,
        solve=jax.jit(solve),
        constraints=tuple(names),
        points_fn=jax.jit(jax.vmap(points)),
        floor_fn=floor_fn,
    )


# ---------------------------------------------------------------------------
# Pipeline
# ---------------------------------------------------------------------------


class FraxScenePipeline:
    """Terrain-aware FRAX retarget on the interaction-mesh front half.

    Args:
        robot: Loaded robot (with a MuJoCo model, as the interaction-mesh pipeline needs).
        scaler: Human-to-robot scaler.
        frax_config: Solver options; defaults to the robot's ``retarget.frax`` block.
        scene_config: Scene-solve options.
        front_config: Options of the composed interaction-mesh front half.
    """

    def __init__(
        self,
        robot: URDFRobotModel,
        scaler,
        *,
        frax_config: FraxConfig | None = None,
        scene_config: FraxSceneConfig | None = None,
        front_config: InteractionMeshPipelineConfig | None = None,
    ) -> None:
        self._jax_state = configure_jax()
        self.robot = robot
        self.front = InteractionMeshPipeline(
            robot=robot, scaler=scaler, cfg=front_config or InteractionMeshPipelineConfig()
        )
        self.frax_config = (
            frax_config if frax_config is not None else frax_config_for_preset(robot.preset)
        )
        self.scene_config = scene_config or FraxSceneConfig()
        # Collision spheres are needed for the terrain barrier even with the flat floor off.
        self.frax_model = _frax_model_for(robot, self.frax_config.with_overrides(floor=True))
        self._scene: MujocoScene | None = None
        self._point_frames: dict[tuple, tuple[list[int], NDArray]] = {}

    @classmethod
    def from_calibration(
        cls,
        robot: URDFRobotModel,
        motion: Motion,
        calibration_path: str,
        *,
        human_height: float = 1.7,
        frax_config: FraxConfig | None = None,
        scene_config: FraxSceneConfig | None = None,
        front_config: InteractionMeshPipelineConfig | None = None,
    ) -> FraxScenePipeline:
        front = InteractionMeshPipeline.from_calibration(
            robot, motion, calibration_path, human_height=human_height, cfg=front_config
        )
        return cls(
            robot,
            front.scaler,
            frax_config=frax_config,
            scene_config=scene_config,
            front_config=front.cfg,
        )

    def execution_provenance(self) -> dict[str, object]:
        return _execution_provenance(self._jax_state)

    # ---- helpers ---------------------------------------------------------------

    def _frames_for(self, scene: MujocoScene, points: list[RobotMpcPoint]):
        key = _point_key(points)
        cached = self._point_frames.get(key)
        if cached is None:
            cached = _frax_point_frames(self.frax_model, scene.model, points)
            self._point_frames[key] = cached
        return cached

    def _solver_for(
        self,
        fps,
        point_joints,
        point_offsets,
        foot_joints,
        foot_offsets,
        has_terrain,
        has_stick,
        terrain_window,
    ) -> _SceneSolver:
        model = self.frax_model
        key = (
            model.cache_key,
            self.frax_config,
            self.scene_config,
            round(float(fps), 6),
            tuple(point_joints),
            _offset_key(point_offsets),
            tuple(foot_joints),
            _offset_key(foot_offsets),
            has_terrain,
            has_stick,
            terrain_window,
        )
        with _CACHE_LOCK:
            solver = _SCENE_SOLVER_CACHE.get(key)
            if solver is not None:
                _SCENE_SOLVER_CACHE.move_to_end(key)
                return solver
            solver = _build_scene_solver(
                model,
                self.frax_config,
                self.scene_config,
                fps,
                point_joints,
                point_offsets,
                foot_joints,
                foot_offsets,
                has_terrain=has_terrain,
                has_stick=has_stick,
                terrain_window=terrain_window,
            )
            _SCENE_SOLVER_CACHE[key] = solver
            while len(_SCENE_SOLVER_CACHE) > _MAX_CACHED_SCENE_SOLVERS:
                _SCENE_SOLVER_CACHE.popitem(last=False)
        return solver

    def _empty_result(self, motion: Motion) -> RetargetedMotion:
        return RetargetedMotion(
            name=motion.name or "frax_scene",
            joint_q=np.zeros((0, 7 + len(self.robot.dof_names())), dtype=np.float32),
            sample_rate=float(motion.framerate),
            dof_names=self.robot.dof_names(),
            root_coord_count=7,
            meta={
                "robot": self.robot.preset.name,
                "retarget_backend": "frax",
                "execution_provenance": self.execution_provenance(),
            },
        )

    def _initial_q(self, points, joints, offsets, pos0, root_rmat0, w_root0) -> NDArray:
        """Frax ``q`` at the first frame: mid-range joints, root fitted to the first targets."""
        model = self.frax_model
        lower, upper = _actuated_limits(model, self.frax_config)
        joints0 = np.zeros(len(lower))
        outside = (joints0 < lower) | (joints0 > upper)
        joints0[outside] = 0.5 * (lower[outside] + upper[outside])
        q = np.array(model.robot.default_configuration, dtype=np.float64)
        q[:7] = (0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0)
        q[7:] = joints0
        a = _fk_points(model, q, joints, offsets)
        b = np.asarray(pos0, dtype=np.float64)
        if w_root0 > 0.0:
            R = np.asarray(root_rmat0, dtype=np.float64)
            t = b.mean(axis=0) - R @ a.mean(axis=0)
        else:
            R, t = _rigid_fit(a, b)
        from scipy.spatial.transform import Rotation

        x, y, z, w = Rotation.from_matrix(R).as_quat()
        q[:3] = t
        q[3:7] = (w, x, y, z)
        return q

    # ---- run -------------------------------------------------------------------

    def run(
        self,
        motion: Motion,
        *,
        progress_callback: Callable[[str, int, int], None] | None = None,
    ) -> RetargetedMotion:
        """Retarget ``motion`` (with its terrain, if any) in one compiled FRAX solve."""
        from hhtools.retarget.clip_ground_snap import snap_joint_q_clip_floor
        from hhtools.robot.retarget_profile import apply_upper_body_roll_narrowing_post_ik

        def stage(name: str, done: int, total: int) -> None:
            if progress_callback is None:
                return
            try:
                progress_callback(name, done, total)
            except Exception:  # pragma: no cover - UI hooks must not break the solve
                pass

        if motion.num_frames == 0:
            return self._empty_result(motion)

        model = self.frax_model
        cfg = self.scene_config
        n = int(motion.num_frames)
        stage("precompute", 0, n)
        if self._scene is None:
            self._scene = MujocoScene.from_robot(self.robot)
        scene = self._scene
        st = self.front.prepare_scene_targets(motion, mj_model=scene.model)
        stage("precompute", n, n)
        points = st.robot_points
        T, P = st.positions.shape[0], len(points)
        point_joints, point_offsets = self._frames_for(scene, points)
        fps = float(motion.framerate)

        # ---- terrain ----
        terrain = self.front.scaled_terrain(motion, st.z_min, st.smpl_scale)
        static: dict[str, Any] = {}
        grid = None
        window = 0
        targets = np.asarray(st.positions, dtype=np.float64)
        if terrain is not None:
            grid = build_terrain_grid(
                terrain.hf,
                terrain.min_point,
                terrain.dx,
                shape_bucket=int(cfg.grid_bucket),
            )
            static["terrain"] = grid.as_ref()
            window = int(np.clip(np.ceil(cfg.terrain_reach / grid.dx), 2, 12))

        # ---- per-frame reference data ----
        frames: dict[str, NDArray] = {
            "pos": targets,
            "w_pos": np.tile(
                cfg.position_weight * np.sqrt([float(p.weight) for p in points]), (T, 1)
            ),
        }
        quats = st.source_root_quat_xyzw
        if quats is not None and self.front.cfg.lock_root_orientation_to_source:
            quats = np.asarray(quats, dtype=np.float64)[:T]
            frames["root_rmat"] = _rotation_matrices(quats).reshape(T, 1, 3, 3)
            frames["w_root"] = _root_rotation_weights(quats, cfg.root_rotation_weight)[:, None]
        else:
            frames["root_rmat"] = np.tile(np.eye(3), (T, 1, 1, 1))
            frames["w_root"] = np.zeros((T, 1))

        left, right = resolve_foot_mpc_points(points, P)
        foot_idx = [next(i for i, p in enumerate(points) if p is pt) for pt in (left, right) if pt]
        has_stick = bool(cfg.foot_sticking and foot_idx)
        stick_frames = 0
        if has_stick:
            # Planted: the pinned point's own target barely moved in this frame.
            target_xy = targets[:, foot_idx, :2]
            planted = np.zeros((T, len(foot_idx)), dtype=bool)
            planted[1:] = (
                np.linalg.norm(np.diff(target_xy, axis=0), axis=-1)
                <= cfg.foot_sticking_velocity_threshold
            )
            stick_frames = int(planted.any(axis=1).sum())
            # Metres per frame -> solver speed (m/s per substep); free feet are uncapped.
            frames["foot_speed_cap"] = np.where(
                planted, cfg.foot_sticking_tolerance * fps / cfg.substeps, _FREE_FOOT_SPEED
            )

        bucket = max(1, int(self.frax_config.frame_bucket))
        padded_len = max(bucket, -(-T // bucket) * bucket)
        padded = _pad_frames(frames, padded_len)
        if has_stick:
            padded["foot_speed_cap"][T:] = _FREE_FOOT_SPEED

        foot_joints = [point_joints[i] for i in foot_idx] if has_stick else []
        foot_offsets = point_offsets[foot_idx] if has_stick else np.zeros((0, 4, 4))
        solver = self._solver_for(
            fps,
            point_joints,
            point_offsets,
            foot_joints,
            foot_offsets,
            grid is not None,
            has_stick,
            window,
        )
        q0 = self._initial_q(
            points,
            point_joints,
            point_offsets,
            frames["pos"][0],
            frames["root_rmat"][0, 0],
            float(frames["w_root"][0, 0]),
        )

        # ---- solve ----
        stage("mpc", 0, T)
        fn, compile_s = solver.compiled_for(padded, static, q0)
        start = time.perf_counter()
        q_all, infos, init_iters = fn(padded, static, q0)
        q_all = np.asarray(jax.block_until_ready(q_all))
        solve_s = time.perf_counter() - start
        q = q_all[:T]
        init_iters = int(init_iters)
        converged = np.asarray(infos.qp_converged)[: max(T - 1, 0)]
        qp_iters = np.asarray(infos.qp_iters)[: max(T - 1, 0)]
        stage("mpc", T, T)

        # ---- back half ----
        # Joint edits first, so the snap and the reported numbers describe the returned motion.
        joint_q = model.joint_q_from_frax_q(q)
        lower, upper = _actuated_limits(model, self.frax_config)
        dof_lo, dof_hi = lower[model.dof_to_frax], upper[model.dof_to_frax]
        joint_q[:, 7:] = np.clip(joint_q[:, 7:], dof_lo, dof_hi).astype(np.float32)
        dof_names = self.robot.dof_names()
        radii = np.asarray(model.robot.flat_collision_radii)[list(model.floor_sphere_idxs)]
        terrain_spheres = grid is not None and solver.floor_fn is not None

        def sphere_centres(jq: NDArray) -> NDArray:
            return np.asarray(solver.floor_fn(jnp.asarray(model.frax_q_from_joint_q(jq))))

        def min_gap_per_frame(jq: NDArray) -> NDArray:
            gap = _terrain_distance(grid, sphere_centres(jq), window) - radii
            return gap.min(axis=1)

        pre_edit = joint_q
        joint_q = apply_upper_body_roll_narrowing_post_ik(
            joint_q, dof_names, self.robot.preset, root_coord_count=7, robot_model=self.robot
        )
        # The narrowing edits shoulder joints without regard to their limits.
        joint_q[:, 7:] = np.clip(joint_q[:, 7:], dof_lo, dof_hi)
        limited_frames = 0
        if terrain_spheres:
            # The edit must not create or deepen a penetration the solve had avoided.
            joint_q, limited_frames = _limit_edit_by_terrain(
                pre_edit, joint_q, min_gap_per_frame, fps
            )
            if limited_frames:
                _LOG.info(
                    "FRAX shoulder edit limited in %d of %d frames to avoid terrain penetration",
                    limited_frames,
                    T,
                )
        q_out = jnp.asarray(model.frax_q_from_joint_q(joint_q))

        floor_offset = 0.0
        if terrain_spheres and cfg.terrain_snap:
            # The constraint keeps sphere centres r + margin from the terrain.
            margin = float(cfg.terrain_margin)
            spheres = np.asarray(solver.floor_fn(q_out))  # (T, S, 3)
            drop = float(grid.vertical_clearance(spheres, radii + margin).min())
            floor_offset = _terrain_snap_offset(drop)
            joint_q[:, 2] -= np.float32(floor_offset)
        signed_min_gap = float("nan")
        if terrain_spheres:
            # The gap of the returned motion: the snap only translates the root vertically.
            signed_min_gap = _returned_min_gap(
                grid, solver.floor_fn(q_out), radii, floor_offset, window
            )
        clip_floor_snap = 0.0
        if terrain is None and self.front.cfg.clip_floor_snap:
            joint_q, clip_floor_snap = snap_joint_q_clip_floor(
                self.robot, joint_q, root_coord_count=7, ground_z=0.0
            )
            floor_offset = clip_floor_snap

        robot_pts = np.array(solver.points_fn(q_out))
        robot_pts[..., 2] -= floor_offset  # the snaps only translate the root vertically
        err = np.linalg.norm(robot_pts - frames["pos"], axis=-1)  # (T, P)

        def group_mean(*keys: str) -> float:
            cols = [
                i for i, p in enumerate(points) if any(k in str(p.semantic).lower() for k in keys)
            ]
            return float(err[:, cols].mean()) if cols else float("nan")

        meta: dict[str, object] = {
            "retarget_backend": "frax",
            "scene_solver": "frax",
            "contact_points": P,
            "smpl_scale": float(st.smpl_scale),
            "source_z_min": float(st.z_min),
            "source_terrain_z_offset": self._terrain_z_offset(motion, st.z_min),
            "terrain_floor_offset": float(floor_offset),
            # Solved against the terrain, so the root height is absolute in its frame.
            "terrain_grounded": "terrain" in solver.constraints,
            "terrain_signed_min_gap": float(signed_min_gap),
            "clip_floor_snap_m": float(clip_floor_snap),
            "alignment_mean_m": float(err.mean()),
            "alignment_max_m": float(err.max()),
            "alignment_pelvis_m": group_mean("pelvis", "hips"),
            "alignment_wrist_m": group_mean("wrist"),
            "alignment_ankle_m": group_mean("ankle"),
            "execution_provenance": self.execution_provenance(),
            "frax": {
                "frax_version": _frax_version(),
                "regularization": self.frax_config.regularization,
                "constraints": list(solver.constraints),
                "collision_source": model.collision_source,
                "collision_spheres": model.num_collision_spheres,
                "floor_spheres": len(model.floor_sphere_idxs),
                "sole_spheres": len(model.sole_sphere_idxs),
                "self_collision_pairs": model.num_self_collision_pairs,
                "substeps": cfg.substeps,
                "terrain_grid_shape": None if grid is None else tuple(grid.heights.shape),
                "terrain_window": None if grid is None else window,
                "terrain_floor_z": None if grid is None else grid.floor_z,
                "compile_s": round(compile_s, 3),
                "solve_s": round(solve_s, 4),
                "solver_frames": T,
                "padded_frames": padded_len,
                "init_iterations": init_iters,
                "init_converged": init_iters < int(self.frax_config.converge_max_iters),
                "qp_converged_ratio": float(converged.mean()) if converged.size else 1.0,
                "qp_max_iterations": int(qp_iters.max(initial=0)),
                "stick_frames": stick_frames,
                "shoulder_edit_limited_frames": limited_frames,
                "foot_target_projection": st.foot_target_projection,
            },
        }
        return RetargetedMotion(
            name=motion.name or "frax_scene",
            joint_q=np.asarray(joint_q, dtype=np.float32),
            sample_rate=fps,
            dof_names=dof_names,
            root_coord_count=7,
            meta=meta,
        )

    @staticmethod
    def _terrain_z_offset(motion: Motion, z_min: float) -> float:
        if motion.terrain is None:
            return float("nan")
        from hhtools.core.grounding import terrain_heightfield_z_offset_world

        return float(terrain_heightfield_z_offset_world(motion, z_min))
