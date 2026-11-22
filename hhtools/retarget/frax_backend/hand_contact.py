"""Hand-object contact for the FRAX scene retarget.

Two pieces that make a robot hand hold a prop instead of hovering near it:

* :func:`hand_surface_points` samples points on the collision geometry of every hand/wrist body
  (farthest-point sampling), so the object barrier can act on the hand's actual surface instead
  of on the collision spheres, which underfill the hand meshes at their edges.
* :func:`project_hand_targets` moves the tracked targets of a hand onto the object's surface
  while the source hand is in contact with it (within a few centimetres, or inside), ramped in and
  out so the targets do not jump.  The source wrist targets of a carried object are at the
  human's proportions, so at the robot's they are a little outside or inside the object.
"""

from __future__ import annotations

import numpy as np
from numpy.lib.stride_tricks import sliding_window_view
from numpy.typing import NDArray

from hhtools.retarget.frax_backend.collision import _body_points
from hhtools.retarget.frax_backend.objects import ObjectSDF
from hhtools.retarget.interaction_mesh.mpc_loop import RobotMpcPoint

__all__ = [
    "HAND_TAGS",
    "contact_mask",
    "farthest_point_sample",
    "hand_body_joints",
    "hand_surface_points",
    "hand_target_groups",
    "project_hand_targets",
]

#: A body or semantic is a hand when its (lower-case) name contains one of these.
HAND_TAGS = ("hand", "wrist", "palm", "finger", "thumb")
#: Newton steps of the surface projection of a target (the field is exact in free space).
_PROJECT_STEPS = 3


def _support_directions() -> NDArray[np.float64]:
    """The 26 unit directions to the faces, edges and corners of a cube."""
    d = np.array([v for v in np.ndindex(3, 3, 3) if v != (1, 1, 1)], dtype=np.float64) - 1.0
    return d / np.linalg.norm(d, axis=1, keepdims=True)


def farthest_point_sample(points: NDArray, count: int) -> NDArray[np.float64]:
    """``count`` points of ``points`` (n, 3) spread out by farthest-point sampling.

    The sampling starts from the extreme points (the support point of the set in each of 26
    directions, farthest-point ordered), so the corners and edges that touch an object first
    are in the sample, then fills up with the point farthest from those chosen.  Deterministic:
    duplicates are dropped and ties go to the lower index.  Fewer than ``count`` distinct
    points are all kept.
    """
    pts = np.asarray(points, dtype=np.float64).reshape(-1, 3)
    _, first = np.unique(np.round(pts, 8), axis=0, return_index=True)
    pts = pts[np.sort(first)]
    if len(pts) <= count:
        return pts
    seeds = list(dict.fromkeys(int(i) for i in np.argmax(pts @ _support_directions().T, axis=0)))
    chosen: list[int] = []
    nearest = np.full(len(pts), np.inf)
    centre = np.linalg.norm(pts - pts.mean(axis=0), axis=1)
    while len(chosen) < count:
        if seeds:
            key = centre[seeds] if not chosen else nearest[seeds]
            pick = seeds.pop(int(np.argmax(key)))
        else:
            pick = int(np.argmax(nearest))
        chosen.append(pick)
        nearest = np.minimum(nearest, np.linalg.norm(pts - pts[pick], axis=1))
    return pts[chosen]


def hand_surface_points(mj_model, count: int = 24) -> list[RobotMpcPoint]:
    """Surface points of the collision geometry of every hand body of ``mj_model``.

    A body is a hand when its name contains one of :data:`HAND_TAGS`.  Per body, ``count``
    points are farthest-point sampled from the vertices of its mesh geoms and surface samples of
    its primitive geoms (the colliding ones, or all if none collides), in the body's frame.
    """
    import mujoco

    out: list[RobotMpcPoint] = []
    for bid in range(1, int(mj_model.nbody)):
        name = mujoco.mj_id2name(mj_model, mujoco.mjtObj.mjOBJ_BODY, bid) or ""
        if not any(tag in name.lower() for tag in HAND_TAGS):
            continue
        pts = _body_points(mj_model, name)
        if pts.shape[0] == 0:
            continue
        for p in farthest_point_sample(pts, count):
            out.append(RobotMpcPoint(body_name=name, local_offset=p, semantic="hand_surface"))
    return out


def hand_body_joints(points: list[RobotMpcPoint], joints: list[int]) -> tuple[int, ...]:
    """The frax joint of every hand body: the joint most of its surface points sit on.

    A point on a joint's rotation axis does not move with it, so it can map to the parent joint
    as well; the majority is the body's own joint.
    """
    votes: dict[str, dict[int, int]] = {}
    for p, j in zip(points, joints, strict=True):
        per = votes.setdefault(p.body_name, {})
        per[int(j)] = per.get(int(j), 0) + 1
    return tuple(sorted({max(per, key=lambda j: (per[j], -j)) for per in votes.values()}))


def hand_target_groups(points: list[RobotMpcPoint]) -> dict[str, tuple[list[int], int]]:
    """Tracked hand points by hand: ``{name: (indices, reference index)}``.

    The name is the semantic's text before ``:`` (``left_wrist`` for ``left_wrist`` and
    ``left_wrist:hand_tip``); a hand is a name that contains one of :data:`HAND_TAGS`.  The
    reference point (the one that lands on the surface) is the ``tip`` point, else the first.
    """
    groups: dict[str, list[int]] = {}
    for i, p in enumerate(points):
        name = str(p.semantic).split(":")[0].lower()
        if name and any(tag in name for tag in HAND_TAGS):
            groups.setdefault(name, []).append(i)
    out: dict[str, tuple[list[int], int]] = {}
    for name, idx in groups.items():
        tips = [
            i
            for i in idx
            if ":" in str(points[i].semantic) and "tip" in str(points[i].semantic).split(":", 1)[1]
        ]
        out[name] = (idx, tips[0] if tips else idx[0])
    return out


def contact_mask(
    distance: NDArray, enter: float, leave: float, min_frames: int = 1
) -> NDArray[np.bool_]:
    """Contact episodes of a signed-distance track, with hysteresis.

    Contact starts when ``distance <= enter`` and lasts until ``distance > leave``; episodes
    shorter than ``min_frames`` are dropped.
    """
    d = np.asarray(distance, dtype=np.float64)
    on = np.zeros(len(d), dtype=bool)
    state = False
    for t, value in enumerate(d):
        state = bool(value <= (leave if state else enter))
        on[t] = state
    if min_frames > 1 and on.any():
        edges = np.diff(np.concatenate([[0], on.astype(np.int8), [0]]))
        for a, b in zip(np.flatnonzero(edges == 1), np.flatnonzero(edges == -1), strict=True):
            if b - a < min_frames:
                on[a:b] = False
    return on


def _ramp(shift: NDArray, width: int) -> NDArray:
    """Per component and sign: centred max filter then centred moving average (>= raw)."""
    half = width // 2
    out = np.zeros_like(shift)
    for sign in (1.0, -1.0):
        part = np.maximum(sign * shift, 0.0)
        padded = np.pad(part, ((half, half), (0, 0)), mode="edge")
        dil = sliding_window_view(padded, width, axis=0).max(axis=-1)
        padded = np.pad(dil, ((half, half), (0, 0)), mode="edge")
        out += sign * sliding_window_view(padded, width, axis=0).mean(axis=-1)
    return out


def _nearest_object(
    sdfs: list[ObjectSDF], pos: NDArray, rot: NDArray, p: NDArray
) -> tuple[NDArray, NDArray, NDArray]:
    """Per frame, signed distance (T,), world unit normal (T, 3) and index (T,) of the nearest
    of the posed objects to the points ``p`` (T, 3)."""
    n_frames = len(p)
    best_d = np.full(n_frames, np.inf)
    best_n = np.zeros((n_frames, 3))
    best_k = np.zeros(n_frames, dtype=int)
    for k, sdf in enumerate(sdfs):
        local = np.einsum("tji,tj->ti", rot[:, k], p - pos[:, k])
        d, n_local = sdf.distance_and_normal(local)
        n_world = np.einsum("tij,tj->ti", rot[:, k], n_local)
        closer = d < best_d
        best_d = np.where(closer, d, best_d)
        best_n = np.where(closer[:, None], n_world, best_n)
        best_k = np.where(closer, k, best_k)
    return best_d, best_n, best_k


def _surface_shift(
    sdfs: list[ObjectSDF],
    pos: NDArray,
    rot: NDArray,
    p: NDArray,
    frames: NDArray,
    objects: NDArray,
    want: float,
) -> NDArray:
    """Shift (len(frames), 3) that puts ``p[frames]`` at signed distance ``want`` (m, positive
    outside) from its object's surface."""
    shift = np.zeros((len(frames), 3))
    for _ in range(_PROJECT_STEPS):
        for k, sdf in enumerate(sdfs):
            sel = objects == k
            if not sel.any():
                continue
            f = frames[sel]
            local = np.einsum("tji,tj->ti", rot[f, k], p[f] + shift[sel] - pos[f, k])
            d, n_local = sdf.distance_and_normal(local)
            n_world = np.einsum("tij,tj->ti", rot[f, k], n_local)
            shift[sel] += (want - d)[:, None] * n_world
    return shift


def project_hand_targets(
    targets: NDArray,
    points: list[RobotMpcPoint],
    sdfs: list[ObjectSDF],
    obj_pos: NDArray,
    obj_rot: NDArray,
    *,
    depth: float,
    contact_distance: float = 0.03,
    release_distance: float = 0.05,
    min_frames: int = 3,
    ramp_s: float = 0.15,
    push_out: bool = False,
    fps: float,
) -> tuple[NDArray, dict[str, dict[str, float | int]]]:
    """Move the targets of each hand onto the surface of the object it touches.

    ``targets`` (T, P, 3) are the tracked point targets, ``obj_pos`` (T, K, 3) and ``obj_rot``
    (T, K, 3, 3) the poses of the objects ``sdfs``, all in the solver frame.  Per hand (see
    :func:`hand_target_groups`) the reference target is in contact in the frames where it is
    inside, or within ``contact_distance`` of, the nearest object, with hysteresis (it leaves
    at ``release_distance``) and episodes of at least ``min_frames``.  In those frames the whole
    hand (all its points, rigidly) is translated along the field gradient so that the reference
    target lies ``depth`` inside the surface (negative: outside).  A reference target already
    deeper than that stays where it is (it presses the hand against the object), unless
    ``push_out``.  The per-frame translation is then ramped over
    ``ramp_s`` seconds (:func:`_ramp`), so the targets do not jump.

    Returns the new targets and, per hand, ``contact_frames`` (frames in contact),
    ``shifted_frames`` (frames moved, ramp included), ``max_correction_m`` (largest translation
    applied) and ``max_jump_m`` (largest frame-to-frame change of the translation).
    """
    out = np.array(targets, dtype=np.float64, copy=True)
    info: dict[str, dict[str, float | int]] = {}
    n_frames = len(out)
    if not sdfs or n_frames == 0:
        return out, info
    width = 2 * int(round(ramp_s * float(fps) / 2.0)) + 1
    frames_all = np.arange(n_frames)
    for name, (idx, ref) in hand_target_groups(points).items():
        tip = np.asarray(targets[:, ref], dtype=np.float64)
        d, _, which = _nearest_object(sdfs, obj_pos, obj_rot, tip)
        on = contact_mask(d, contact_distance, release_distance, min_frames)
        raw = np.zeros((n_frames, 3))
        move = on if push_out else on & (d > -depth)
        if move.any():
            frames = frames_all[move]
            raw[move] = _surface_shift(sdfs, obj_pos, obj_rot, tip, frames, which[move], -depth)
        shift = _ramp(raw, width) if move.any() and width > 1 else raw
        out[:, idx] += shift[:, None, :]
        moved = np.any(shift != 0.0, axis=1)
        info[name] = {
            "contact_frames": int(on.sum()),
            "shifted_frames": int(moved.sum()),
            "max_correction_m": float(np.linalg.norm(shift, axis=1).max()),
            "max_jump_m": (
                float(np.linalg.norm(np.diff(shift, axis=0), axis=1).max()) if n_frames > 1 else 0.0
            ),
        }
    return out, info
