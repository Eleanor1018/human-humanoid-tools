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

import dataclasses
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
from hhtools.retarget.frax_backend.hand_contact import (  # noqa: E402
    hand_body_joints,
    hand_surface_points,
    project_hand_targets,
)
from hhtools.retarget.frax_backend.model import FraxRobotModel  # noqa: E402
from hhtools.retarget.frax_backend.objects import (  # noqa: E402
    ObjectConstraint,
    ObjectSDF,
    build_object_sdf,
    object_distance_rows,
    object_grid_pad,
)
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
        objects: Keep every collision sphere out of the clip's interaction objects
            (``motion.objects``: boxes, chairs, ...) with a signed-distance barrier
            (:class:`~hhtools.retarget.frax_backend.objects.ObjectConstraint`).  The source
            wrist targets of a carried object lie inside it at the robot's proportions; without
            this the hands go several centimetres into it.
        object_margin: Clearance kept between a sphere's surface and an object (m).  The
            spheres underfill the collision meshes at their edges (on rp1 the wrist and elbow
            meshes reach 7-16 mm past them), so with 0 the hand spheres touch the object while
            the hand mesh is up to 1.3 cm inside it.  On the 4 bundled object clips 1 cm brought
            the worst mesh penetration from 10 to 3.6 mm (mean) and the share of contact frames
            with the hand mesh between 10 mm off and 5 mm into the object from 67% to 82%,
            for 0.4 cm more hand tracking error; 0.5 cm and 0.75 cm were in between.
        object_rows: Lowest-barrier rows kept per step *per object* (one row per sphere); a row
            dropped here is not enforced that step.
        object_grid_dx: Cell size (m) of the object signed distance fields.
        object_hand_points: Also keep ``object_points_per_body`` sampled surface points of every
            hand/wrist collision geometry (:func:`~hhtools.retarget.frax_backend.hand_contact.
            hand_surface_points`) ``object_point_margin`` out of the objects, and give the
            collision spheres of those bodies the margin ``object_hand_sphere_margin`` (the
            points cover the mesh the spheres underfill) instead of ``object_margin``.
        object_point_margin: Clearance kept between a hand surface point and an object (m).
        object_points_per_body: Surface points sampled per hand body.
        object_hand_sphere_margin: Clearance of the hand spheres when the hand points are on (m).
        object_snap_tolerance: How far inside an object (m) a final root snap (terrain snap,
            clip floor snap) may leave any robot-object pair; a pair that already penetrated by
            more must not get deeper.  A clear pair may approach the object freely up to that
            depth (requiring it to stay as far as before would block any snap that brings a
            hand closer to an object, however far away it starts).  With the hand points
            resting on an object at 0 margin, lifting a clip 1 cm out of the floor moves a point on
            a carried box's side about 0.1 mm deeper; a 0.1 mm tolerance blocked that lift and left
            the feet 5-9 mm in the floor on the OmniContact carries.
        object_contact_targets: While a source hand touches an object (its reference target, the
            ``hand_tip`` point, inside or within ``object_contact_distance`` of the surface;
            leaves at ``object_contact_release``, episodes of at least
            ``object_contact_min_frames``), move that hand's targets (rigidly, along the field
            gradient) so the reference target lies ``object_contact_depth`` inside the surface,
            ramped in and out over ``object_contact_ramp_s`` seconds.  A target already deeper
            is left where it is (it presses the hand against the object) unless
            ``object_contact_push_out``.  The hand tip of rp1 lies about 2 cm beyond the hand
            mesh, so a tip on the surface leaves the mesh that far off.
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
    objects: bool = True
    object_margin: float = 0.01
    object_rows: int = 32
    object_grid_dx: float = 0.01
    object_hand_points: bool = True
    object_point_margin: float = 0.0
    object_points_per_body: int = 24
    object_hand_sphere_margin: float = 0.0
    object_contact_targets: bool = False
    object_contact_depth: float = 0.0
    object_contact_push_out: bool = False
    object_contact_distance: float = 0.03
    object_contact_release: float = 0.05
    object_contact_min_frames: int = 3
    object_contact_ramp_s: float = 0.15
    object_snap_tolerance: float = 0.002

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


def _sphere_joints(robot) -> NDArray[np.int64]:
    """Frax joint index of every flat collision sphere."""
    per_joint = int(np.asarray(robot.padded_collision_positions).shape[1])
    return np.asarray(robot.collision_slice_indices) // per_joint


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

    ``gap_fn(joint_q)`` returns the signed gaps (m) of the constrained pairs, shape ``(T, N)``
    (one column per sphere and obstacle; ``(T,)`` is one pair).  Pairs are compared one by one,
    never through a per-frame minimum, so a penetration that already existed cannot hide a new
    one in another sphere or another constraint.  A frame is *worse* when any pair's edited gap
    is below ``min(that pair's gap before, 0) - tol`` (the edit creates or deepens a
    penetration).  The floor is zero, not the clearance margin: the margin only compensates for
    the sphere model and a pair may legitimately sit inside it.  For worse frames the
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
    floor = np.where(np.isnan(gap_pre), -tol, np.minimum(gap_pre, 0.0) - tol)

    def worse(alpha: NDArray) -> NDArray:
        gap = np.asarray(gap_fn(blend(alpha)), dtype=np.float64)
        # A NaN gap is a violation where the pair had a finite baseline, else ignored.
        below = (gap < floor) | (np.isnan(gap) & ~np.isnan(gap_pre))
        return below.reshape(len(below), -1).any(axis=1)

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


def _flat_floor_gaps(centres: NDArray, radii: NDArray) -> NDArray:
    """Signed gap (m) of sphere ``centres`` (T, S, 3) of ``radii`` (S,) to the plane ``z = 0``."""
    return np.asarray(centres, dtype=np.float64)[..., 2] - np.asarray(radii, dtype=np.float64)


def _object_gap_fn(
    sdfs: list[ObjectSDF], pos: NDArray, rot: NDArray, radii: NDArray
) -> Callable[..., NDArray]:
    """``gap(centres, points=None)``: ``d - r`` (m) of every sphere and ``d`` of every point.

    ``centres`` is ``(T, S, 3)`` world sphere centres and ``points`` (optional) ``(T, P, 3)``
    world hand surface points; ``pos`` (T, K, 3) and ``rot`` (T, K, 3, 3) are the object poses
    of those frames.  Negative means penetration.  The columns, per object the spheres then the
    points, ``(T, K * (S + P))``, are the pairs the guards compare one by one; the per-frame
    minimum is for reporting.
    """
    refs = [s.as_ref() for s in sdfs]
    pos_j, rot_j = jnp.asarray(pos), jnp.asarray(rot)
    radii_j = jnp.asarray(radii)

    @jax.jit
    def gap(centres, points):
        def frame(c, pt, p, r):
            parts = []
            for k, ref in enumerate(refs):
                parts.append(object_distance_rows(ref, c, p[k], r[k])[0] - radii_j)
                if pt is not None:
                    parts.append(object_distance_rows(ref, pt, p[k], r[k])[0])
            return jnp.concatenate(parts)

        return jax.vmap(frame)(jnp.asarray(centres), points, pos_j, rot_j)

    def call(centres, points=None):
        pts = None if points is None else jnp.asarray(points)
        return np.asarray(gap(centres, pts))

    return call


def _limit_root_shift(
    joint_q: NDArray,
    shift: float,
    gap_fn: Callable[[NDArray], NDArray],
    *,
    z_index: int = 2,
    tol: float = 1e-4,
    eps: float = 5e-5,
    pen_step: float = 0.002,
    max_iter: int = 500,
) -> tuple[float, bool]:
    """Largest certified clear prefix of a vertical root shift ``shift`` (m), by advancement.

    ``gap_fn(joint_q)`` gives the signed gaps of the pairs (``(T, N)``, or ``(T,)``).  A pair is
    *violated* when its gap is below ``min(its gap before, 0) - tol`` (its *floor*): pairs are
    compared one by one, so an existing penetration cannot hide a new one, and the floor is zero
    rather than the clearance margin.  The motion is a pure vertical translation and every gap is
    a distance, hence (about) 1-Lipschitz in the shift: from a fraction where all pairs are
    clear, the shift can advance by the smallest slack ``gap - floor`` (metres, taken at 90 %
    for numerical safety) without any pair reaching its floor, so no violation can hide between
    samples however thin the obstacle.  This repeats until the full shift is reached or the
    slack falls below ``eps``, with at most ``max_iter`` samples; the last certified fraction is
    returned, never a larger one.  A pair that already penetrates or has no finite baseline has
    no such certificate (its slack is only ``tol``): it is sampled at steps of at least
    ``pen_step`` instead.  A NaN gap is a violation when the pair's baseline was finite; a NaN
    baseline floors the pair at ``-tol`` and its NaN gaps are ignored.  Returns the shift to
    apply and whether it was reduced.
    """
    if shift == 0.0:
        return 0.0, False
    jq = np.asarray(joint_q, dtype=np.float32)
    base = np.asarray(gap_fn(jq), dtype=np.float64)
    floor = np.where(np.isnan(base), -tol, np.minimum(base, 0.0) - tol)
    certified = base >= 0.0  # False for penetrating and NaN pairs
    size = abs(float(shift))

    def check(fraction: float) -> tuple[bool, float]:
        moved = jq.copy()
        moved[:, z_index] -= np.float32(fraction * shift)
        gap = np.asarray(gap_fn(moved), dtype=np.float64)
        bad = (gap < floor) | (np.isnan(gap) & ~np.isnan(base))
        slack = np.where(np.isnan(gap), np.inf, gap - floor)
        advance = np.where(certified, slack, np.maximum(slack, pen_step))
        return bool(bad.any()), float(advance.min())

    good, fraction = 0.0, 0.0
    for _ in range(int(max_iter)):
        bad, advance = check(fraction)
        if bad:
            break
        good = fraction
        if fraction >= 1.0:
            return float(shift), False
        if advance < eps:
            break
        fraction = min(1.0, fraction + 0.9 * advance / size)
    return float(good * shift), True


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
    sphere_fn: Callable[[Any], Any] | None = None  # all collision spheres, (T, S, 3)
    hand_points_fn: Callable[[Any], Any] | None = None  # hand surface points, (T, H, 3)
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
    n_objects: int = 0,
    hand_joints: list[int] | None = None,
    hand_offsets: NDArray | None = None,
    hand_sphere_joints: tuple[int, ...] = (),
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
    hand_joints = list(hand_joints or [])
    if n_objects and model.has_collision:
        hand_kwargs: dict[str, Any] = {}
        if hand_joints:
            # The hand points cover the hand meshes: their spheres need no extra clearance.
            hand_kwargs = {
                "sphere_margins": np.where(
                    np.isin(_sphere_joints(robot), hand_sphere_joints),
                    float(scene_config.object_hand_sphere_margin),
                    float(scene_config.object_margin),
                ),
                "point_joints": hand_joints,
                "point_offsets": hand_offsets,
                "point_margin": float(scene_config.object_point_margin),
            }
        for k in range(n_objects):
            constraints.append(
                ObjectConstraint(
                    robot,
                    index=k,
                    max_rows=int(scene_config.object_rows),
                    gain=gain,
                    margin=float(scene_config.object_margin),
                    **hand_kwargs,
                )
            )
        names.append("objects")
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

    sphere_fn = None
    if model.has_collision:

        def sphere_fn(q):
            return robot._link_collision_positions(robot.joint_to_world_transforms(q))

        sphere_fn = jax.jit(jax.vmap(sphere_fn))

    hand_points_fn = None
    if hand_joints:
        hj = np.asarray(hand_joints)
        ho = np.asarray(hand_offsets, dtype=float)[:, :3, 3]

        def hand_points(q):
            tfs = robot.joint_to_world_transforms(q)[hj]
            return jnp.einsum("pab,pb->pa", tfs[:, :3, :3], ho) + tfs[:, :3, 3]

        hand_points_fn = jax.jit(jax.vmap(hand_points))

    return _SceneSolver(
        ik=solver,
        solve=jax.jit(solve),
        constraints=tuple(names),
        points_fn=jax.jit(jax.vmap(points)),
        floor_fn=floor_fn,
        sphere_fn=sphere_fn,
        hand_points_fn=hand_points_fn,
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
        # FRAX collides with the terrain columns, so its foot targets only need to clear those
        # (not the interpolated surface that the interaction-mesh solver uses).
        self.front = InteractionMeshPipeline(
            robot=robot,
            scaler=scaler,
            cfg=dataclasses.replace(
                front_config or InteractionMeshPipelineConfig(),
                terrain_foot_target_surface="columns",
            ),
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
        n_objects=0,
        hand_joints=(),
        hand_offsets=None,
        hand_sphere_joints=(),
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
            n_objects,
            tuple(hand_joints),
            () if not len(hand_joints) else _offset_key(hand_offsets),
            tuple(hand_sphere_joints),
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
                n_objects=n_objects,
                hand_joints=list(hand_joints),
                hand_offsets=hand_offsets,
                hand_sphere_joints=tuple(hand_sphere_joints),
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
        """Retarget ``motion`` (with its terrain, if any) in one compiled FRAX solve.

        ``progress_callback(stage, done, total)`` is called for the stages
        ``precompute`` (front half), ``build`` (terrain grid, object SDFs,
        solver build), ``mpc`` (the compiled scan, reported as 0/T then T/T)
        and ``post`` (back half).  An exception raised by the callback aborts
        the run, but only where the callback is called: before the front half,
        before building, before the solve, after the solve and before the
        back half.  It cannot interrupt the compiled scan (or its first-time
        compilation) once that has started; the solve of the bundled clips
        takes a few seconds.
        """
        from hhtools.retarget.clip_ground_snap import snap_joint_q_clip_floor
        from hhtools.robot.retarget_profile import apply_upper_body_roll_narrowing_post_ik

        def stage(name: str, done: int, total: int) -> None:
            # Exceptions propagate on purpose: callers cancel a run by raising
            # from the callback (e.g. ``JobCancelledError``).  Cancellation is
            # therefore honoured at these stage boundaries only, not inside
            # the compiled scan.
            if progress_callback is not None:
                progress_callback(name, done, total)

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
        stage("build", 0, n)
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

        # ---- objects ----
        object_sdfs: list[ObjectSDF] = []
        object_build_s: list[float] = []
        object_pos = object_rot = None
        if cfg.objects and motion.objects and model.has_collision:
            build_start = time.perf_counter()
            pad = object_grid_pad(
                float(np.max(np.asarray(model.robot.flat_collision_radii))),
                float(cfg.object_margin),
            )
            for k, ob in enumerate(motion.objects):
                tic = time.perf_counter()
                sdf = build_object_sdf(ob, st.smpl_scale, dx=float(cfg.object_grid_dx), pad=pad)
                object_build_s.append(round(time.perf_counter() - tic, 3))
                object_sdfs.append(sdf)
                static[f"object_sdf_{k}"] = sdf.as_ref()
            _LOG.info(
                "FRAX object SDFs: %d object(s) in %.2fs",
                len(object_sdfs),
                time.perf_counter() - build_start,
            )
            # The solver frame of the front half: (p - [0, 0, z_min]) * smpl_scale.
            shift = np.array([0.0, 0.0, float(st.z_min)])
            tracks = []
            for k, ob in enumerate(motion.objects):
                p = np.asarray(ob.positions, dtype=np.float64)
                q = np.asarray(ob.quaternions, dtype=np.float64)
                if not (np.isfinite(p).all() and np.isfinite(q).all()):
                    raise ValueError(
                        f"object {k} ({getattr(ob, 'name', '')!r}) has non-finite positions or "
                        "quaternions; fix or drop the object track before retargeting"
                    )
                idx = np.minimum(np.arange(T), len(p) - 1)
                tracks.append(((p[idx] - shift) * float(st.smpl_scale), q[idx]))
            object_pos = np.stack([t[0] for t in tracks], axis=1)  # (T, K, 3)
            object_rot = np.stack(
                [_rotation_matrices(t[1]) for t in tracks], axis=1
            )  # (T, K, 3, 3)

        hand_joints: list[int] = []
        hand_offsets = np.zeros((0, 4, 4))
        hand_sphere_joints: tuple[int, ...] = ()
        object_contact: dict[str, dict] | None = None
        if object_sdfs:
            if cfg.object_hand_points:
                hand_points = hand_surface_points(scene.model, int(cfg.object_points_per_body))
                if hand_points:
                    hand_joints, hand_offsets = self._frames_for(scene, hand_points)
                    hand_sphere_joints = hand_body_joints(hand_points, hand_joints)
            if cfg.object_contact_targets:
                targets, object_contact = project_hand_targets(
                    targets,
                    points,
                    object_sdfs,
                    object_pos,
                    object_rot,
                    depth=float(cfg.object_contact_depth),
                    push_out=bool(cfg.object_contact_push_out),
                    contact_distance=float(cfg.object_contact_distance),
                    release_distance=float(cfg.object_contact_release),
                    min_frames=int(cfg.object_contact_min_frames),
                    ramp_s=float(cfg.object_contact_ramp_s),
                    fps=fps,
                )

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

        if object_sdfs:
            frames["object_pos"] = object_pos
            frames["object_rot"] = object_rot

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
            len(object_sdfs),
            hand_joints,
            hand_offsets,
            hand_sphere_joints,
        )
        q0 = self._initial_q(
            points,
            point_joints,
            point_offsets,
            frames["pos"][0],
            frames["root_rmat"][0, 0],
            float(frames["w_root"][0, 0]),
        )

        stage("build", n, n)

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
        stage("post", 0, T)
        # Joint edits first, so the snap and the reported numbers describe the returned motion.
        joint_q = model.joint_q_from_frax_q(q)
        lower, upper = _actuated_limits(model, self.frax_config)
        dof_lo, dof_hi = lower[model.dof_to_frax], upper[model.dof_to_frax]
        joint_q[:, 7:] = np.clip(joint_q[:, 7:], dof_lo, dof_hi).astype(np.float32)
        dof_names = self.robot.dof_names()
        radii = np.asarray(model.robot.flat_collision_radii)[list(model.floor_sphere_idxs)]
        terrain_spheres = grid is not None and solver.floor_fn is not None
        flat_floor_spheres = (
            grid is None and "floor" in solver.constraints and solver.floor_fn is not None
        )

        def sphere_centres(jq: NDArray) -> NDArray:
            return np.asarray(solver.floor_fn(jnp.asarray(model.frax_q_from_joint_q(jq))))

        def terrain_gaps(jq: NDArray) -> NDArray:
            """Signed gap of every (frame, sphere) to the terrain, ``(T, S)``."""
            return _terrain_distance(grid, sphere_centres(jq), window) - radii

        object_gaps = None
        object_gap_per_frame = None
        if object_sdfs:
            all_radii = np.asarray(model.robot.flat_collision_radii)
            object_gap = _object_gap_fn(object_sdfs, object_pos, object_rot, all_radii)

            def object_gaps(jq: NDArray) -> NDArray:
                """Signed gap of every (frame, object, sphere), ``(T, K * S)``."""
                q_frax = jnp.asarray(model.frax_q_from_joint_q(jq))
                hand = solver.hand_points_fn(q_frax) if hand_joints else None
                return object_gap(solver.sphere_fn(q_frax), hand)

            def object_gap_per_frame(jq: NDArray) -> NDArray:
                return object_gaps(jq).min(axis=1)

        def guard_gaps(jq: NDArray) -> NDArray:
            """Every floor, terrain and object pair, side by side (compared one by one)."""
            parts = []
            if terrain_spheres:
                parts.append(terrain_gaps(jq))
            if flat_floor_spheres:
                parts.append(_flat_floor_gaps(sphere_centres(jq), radii))
            if object_gaps is not None:
                parts.append(object_gaps(jq))
            return np.concatenate(parts, axis=1)

        pre_edit = joint_q
        joint_q = apply_upper_body_roll_narrowing_post_ik(
            joint_q, dof_names, self.robot.preset, root_coord_count=7, robot_model=self.robot
        )
        # The narrowing edits shoulder joints without regard to their limits.
        joint_q[:, 7:] = np.clip(joint_q[:, 7:], dof_lo, dof_hi)
        limited_frames = 0
        if terrain_spheres or object_gap_per_frame is not None:
            # The edit must not create or deepen a penetration the solve had avoided.
            joint_q, limited_frames = _limit_edit_by_terrain(pre_edit, joint_q, guard_gaps, fps)
            if limited_frames:
                _LOG.info(
                    "FRAX shoulder edit limited in %d of %d frames (terrain/object penetration)",
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
            if object_gap_per_frame is not None:
                floor_offset, reduced = _limit_root_shift(
                    joint_q, floor_offset, object_gaps, tol=float(cfg.object_snap_tolerance)
                )
                if reduced:
                    _LOG.info(
                        "FRAX terrain snap reduced to %.4f m to avoid object penetration",
                        floor_offset,
                    )
            joint_q[:, 2] -= np.float32(floor_offset)
        signed_min_gap = float("nan")
        if terrain_spheres:
            # The gap of the returned motion: the snap only translates the root vertically.
            signed_min_gap = _returned_min_gap(
                grid, solver.floor_fn(q_out), radii, floor_offset, window
            )
        clip_floor_snap = 0.0
        if terrain is None and self.front.cfg.clip_floor_snap:
            unsnapped = joint_q
            joint_q, clip_floor_snap = snap_joint_q_clip_floor(
                self.robot, joint_q, root_coord_count=7, ground_z=0.0
            )
            if object_gap_per_frame is not None and clip_floor_snap != 0.0:
                # The snap must not create or deepen object penetration.
                clip_floor_snap, reduced = _limit_root_shift(
                    unsnapped, clip_floor_snap, object_gaps, tol=float(cfg.object_snap_tolerance)
                )
                if reduced:
                    _LOG.info(
                        "FRAX clip floor snap reduced to %.4f m to avoid object penetration",
                        clip_floor_snap,
                    )
                    joint_q = np.array(unsnapped, dtype=np.float32, copy=True)
                    joint_q[:, 2] -= np.float32(clip_floor_snap)
            floor_offset = clip_floor_snap
        object_min_gap = float("nan")
        if object_gap_per_frame is not None:
            object_min_gap = float(object_gap_per_frame(joint_q).min())

        robot_pts = np.array(solver.points_fn(q_out))
        robot_pts[..., 2] -= floor_offset  # the snaps only translate the root vertically
        # ``alignment_*``: against the solver targets (foot targets moved out of the terrain and
        # hand targets moved onto objects when those ran); ``alignment_source_*``: against the
        # scaled source before either (``st.source_positions``, the yellow overlay).
        err = np.linalg.norm(robot_pts - frames["pos"], axis=-1)  # (T, P)
        err_source = np.linalg.norm(
            robot_pts - np.asarray(st.source_positions, dtype=robot_pts.dtype), axis=-1
        )

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
            # Solved against the objects, so the root height is absolute in their frame.
            "objects_grounded": "objects" in solver.constraints,
            "object_signed_min_gap": object_min_gap,
            "clip_floor_snap_m": float(clip_floor_snap),
            "alignment_mean_m": float(err.mean()),
            "alignment_max_m": float(err.max()),
            "alignment_pelvis_m": group_mean("pelvis", "hips"),
            "alignment_wrist_m": group_mean("wrist"),
            "alignment_ankle_m": group_mean("ankle"),
            "alignment_source_mean_m": float(err_source.mean()),
            "alignment_source_max_m": float(err_source.max()),
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
                "objects": len(object_sdfs),
                "object_rows": int(cfg.object_rows) if object_sdfs else 0,
                "object_sdf_shapes": [tuple(s.values.shape) for s in object_sdfs],
                "object_sdf_build_s": object_build_s,
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
        if object_sdfs:
            meta["frax"]["object_hand_points"] = len(hand_joints)
            meta["frax"]["object_contact"] = object_contact or {}
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
