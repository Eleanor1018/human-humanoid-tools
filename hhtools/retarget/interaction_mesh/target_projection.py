"""Move foot position targets out of the terrain before a scene solve (NumPy only).

The per-point targets of a scene retarget are the scaled source joints plus contact points built
from the *robot's* toe / heel offsets and the source foot frame.  When the actor stands against a
box, those foot targets can lie inside it (centimetres deep), while the solvers keep the robot's
foot out of the box: the foot waits on the box edge until the target leaves the solid and the
knee then catches up in a single frame.  :func:`project_foot_targets` rigidly moves all of one
foot's contact targets by the smallest translation that clears them, and ramps that shift in and
out in time so the targets do not jump.

The terrain is read as in the FRAX solver: ``hf[ix, iy]`` is the top of a square column of side
``dx`` centred at ``min_point + (ix, iy) * dx``, over a floor plane at ``min(0, lowest finite
cell)`` outside and below the grid.  Non-finite cells become the floor, as in
``frax_backend.terrain.build_terrain_grid``, so this and the FRAX solver see the same terrain.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from numpy.lib.stride_tricks import sliding_window_view
from numpy.typing import NDArray

from hhtools.core.scene import TerrainHeightfield

__all__ = ["column_signed_distance", "project_foot_targets"]

#: Points per chunk of the windowed distance (memory bound: chunk * (2 window + 1)^2 floats).
_CHUNK = 20000


@dataclass(frozen=True)
class _Columns:
    heights: NDArray[np.float64]  # padded (nx + 2 pad, ny + 2 pad)
    origin: NDArray[np.float64]  # world XY of padded node (0, 0)
    dx: float
    floor_z: float
    pad: int
    shape: tuple[int, int]  # unpadded grid shape


def _columns(terrain: TerrainHeightfield, pad: int) -> _Columns:
    hf = np.asarray(terrain.hf, dtype=np.float64)
    finite = hf[np.isfinite(hf)]
    floor_z = min(0.0, float(finite.min())) if finite.size else 0.0
    heights = np.where(np.isfinite(hf), np.maximum(hf, floor_z), floor_z)
    heights = np.pad(heights, pad, constant_values=floor_z)
    dx = float(terrain.dx)
    origin = np.asarray(terrain.min_point, dtype=np.float64).reshape(2) - pad * dx
    return _Columns(heights, origin, dx, floor_z, pad, (int(hf.shape[0]), int(hf.shape[1])))


def _signed_distance(cols: _Columns, pts: NDArray[np.float64], window: int) -> NDArray:
    out = np.empty(len(pts))
    half = 0.5 * cols.dx
    rng = np.arange(-window, window + 1)
    hp = cols.heights
    for start in range(0, len(pts), _CHUNK):
        p = pts[start : start + _CHUNK]
        f = (p[:, :2] - cols.origin) / cols.dx
        c = np.clip(np.round(f).astype(np.int64), window, np.asarray(hp.shape) - 1 - window)
        ix = c[:, 0, None] + rng  # (n, K)
        iy = c[:, 1, None] + rng
        xk = cols.origin[0] + cols.dx * ix
        yk = cols.origin[1] + cols.dx * iy
        lx = np.maximum(np.abs(p[:, 0, None] - xk) - half, 0.0)
        ly = np.maximum(np.abs(p[:, 1, None] - yk) - half, 0.0)
        rho2 = lx[:, :, None] ** 2 + ly[:, None, :] ** 2  # (n, K, K)
        s = p[:, 2, None, None] - hp[ix[:, :, None], iy[:, None, :]]
        to_solid = np.sqrt(rho2 + np.maximum(s, 0.0) ** 2).min(axis=(1, 2))
        d_out = np.minimum(to_solid, p[:, 2] - cols.floor_z)
        d_in = -np.sqrt(rho2 + np.maximum(-s, 0.0) ** 2).min(axis=(1, 2))
        own = hp[c[:, 0], c[:, 1]]
        out[start : start + _CHUNK] = np.where(p[:, 2] < own, d_in, d_out)
    return out


def column_signed_distance(
    points: NDArray, terrain: TerrainHeightfield, *, window: int = 12
) -> NDArray[np.float64]:
    """Signed distance (m) from ``points`` (..., 3) to the column terrain; negative inside.

    Outside the columns: the distance to the nearest column or the floor plane.  Inside: minus
    the shortest way out -- straight up, sideways into a column lower than the point, or off
    the grid.  Only columns within ``window`` cells of the point's column are searched, so the
    value is exact whenever the true distance is below about ``(window - 1) * dx`` (beyond that
    it is an over-estimate of the distance outside and of the exit length inside).
    """
    pts = np.asarray(points, dtype=np.float64)
    batch = pts.shape[:-1]
    cols = _columns(terrain, window + 1)
    return _signed_distance(cols, pts.reshape(-1, 3), window).reshape(batch)


# --------------------------------------------------------------------------- foot groups

_SIDES = ("left", "right")
_FOOT_PARTS = ("ankle", "foot", "toe", "heel")


def _foot_groups(robot_points) -> dict[str, list[int]]:
    """Per side, indices of the ankle / foot / toe / heel points (semantic root before ``:``)."""
    groups: dict[str, list[int]] = {}
    for side in _SIDES:
        roots = {f"{side}_{part}" for part in _FOOT_PARTS}
        idx = [
            i
            for i, p in enumerate(robot_points)
            if str(getattr(p, "semantic", "")).split(":", 1)[0].strip().lower() in roots
        ]
        if idx:
            groups[side] = idx
    return groups


_DIRS = np.array(
    [[np.cos(a), np.sin(a), 0.0] for a in np.arange(8) * np.pi / 4] + [[0.0, 0.0, 1.0]]
)


def _min_signed(cols, group_pos: NDArray, window: int) -> NDArray:
    """Smallest signed distance over the points of each group, ``group_pos`` (n, k, 3)."""
    n, k = group_pos.shape[:2]
    return _signed_distance(cols, group_pos.reshape(-1, 3), window).reshape(n, k).min(axis=1)


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


def _max_jump(shift: NDArray) -> float:
    if len(shift) < 2:
        return 0.0
    return float(np.linalg.norm(np.diff(shift, axis=0), axis=1).max())


def project_foot_targets(
    positions: NDArray,
    robot_points,
    terrain: TerrainHeightfield,
    *,
    trigger: float = 0.005,
    clearance: float = 0.002,
    max_shift: float = 0.4,
    step: float = 0.0025,
    ramp_s: float = 0.2,
    fps: float,
) -> tuple[NDArray, dict]:
    """Move each foot's contact targets out of the terrain; returns ``(positions, info)``.

    Per frame and side, if any point of the foot group (ankle, toe, heel of that side) is more
    than ``trigger`` inside the terrain, the whole group is translated rigidly by the smallest
    ``s * d`` (``d``: 8 horizontal directions at 45 degrees or +z, ``s`` on a ``step`` grid up
    to ``max_shift``) that leaves every point at signed distance >= ``clearance``.  Frames with
    no such shift are left alone and counted.  The per-frame shifts are then ramped (max filter
    plus moving average of ``ramp_s`` seconds, per component and sign, an envelope never below
    the raw value) so the targets do not jump.  Every frame the ramp changed is re-checked: one
    whose raw shift cleared it must still be at signed distance >= ``clearance``, any other
    must not be deeper than unshifted; a frame failing that gets its raw shift back.
    Other limbs' points are never moved.

    ``info[side]``: ``frames_shifted``, ``frames_uncleared``, ``max_shift_m``,
    ``max_jump_raw_m`` and ``max_jump_ramped_m`` (largest frame-to-frame change of the target
    caused by the shift before / after the ramp), ``frames_ramp_fallback``.
    """
    pos = np.array(positions, copy=True)
    work = np.asarray(positions, dtype=np.float64)
    info: dict[str, dict] = {}
    groups = _foot_groups(robot_points)
    if not groups or len(work) == 0:
        return pos, info

    window = max(2, int(np.ceil(clearance / terrain.dx)) + 1)
    cols = _columns(terrain, window + 1)
    steps = np.arange(int(np.floor(max_shift / step + 1e-9)) + 1) * step
    width = 2 * int(round(ramp_s * float(fps) / 2.0)) + 1
    n_frames = len(work)

    for side, idx in groups.items():
        g = work[:, idx]  # (T, k, 3)
        d0 = _min_signed(cols, g, window)
        bad = np.flatnonzero(d0 < -trigger)
        raw = np.zeros((n_frames, 3))
        uncleared = 0
        for f in bad:
            cand = g[f][None, None] + steps[None, :, None, None] * _DIRS[:, None, None, :]
            dd = _min_signed(cols, cand.reshape(-1, len(idx), 3), window).reshape(
                len(_DIRS), len(steps)
            )
            ok = dd >= clearance
            first = np.where(ok.any(axis=1), ok.argmax(axis=1), len(steps))
            k = int(np.argmin(first))
            if first[k] < len(steps):
                raw[f] = steps[first[k]] * _DIRS[k]
            else:
                uncleared += 1

        shift = raw
        fallback = 0
        if bad.size and width > 1:
            ramped = _ramp(raw, width)
            changed = np.flatnonzero(np.any(ramped != raw, axis=1))
            if changed.size:
                d_ramp = _min_signed(cols, g[changed] + ramped[changed, None, :], window)
                cleared_raw = np.any(raw[changed] != 0.0, axis=1)
                d_unshifted = d0[changed]
                # A frame whose raw shift cleared it must still be clear; any other frame
                # (clear, or not clearable) must not end deeper than it was unshifted.
                need = np.where(cleared_raw, clearance, np.minimum(d_unshifted, 0.0))
                revert = d_ramp < need - 1e-9
                ramped[changed[revert]] = raw[changed[revert]]
                fallback = int(revert.sum())
            shift = ramped

        pos[:, idx] = (g + shift[:, None, :]).astype(pos.dtype)
        info[side] = {
            "frames_shifted": int(np.any(shift != 0.0, axis=1).sum()),
            "frames_uncleared": int(uncleared),
            "max_shift_m": float(np.linalg.norm(shift, axis=1).max()),
            "max_jump_raw_m": _max_jump(raw),
            "max_jump_ramped_m": _max_jump(shift),
            "frames_ramp_fallback": fallback,
        }
    return pos, info
