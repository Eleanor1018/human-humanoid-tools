# SPDX-FileCopyrightText: Copyright (c) 2026 hhtools contributors
# SPDX-License-Identifier: Apache-2.0
"""Foot-to-terrain clearance for the final Z-snap of the interaction-mesh pipeline.

The terrain is read as columns: heightfield node ``(i, j)`` is a solid column of footprint
``dx`` x ``dx`` centred on world XY ``min_point + (i, j) * dx`` that reaches from minus infinity
up to ``hf[i, j]``, and the collision scene's ground plane at ``floor_z`` is solid below
everything.  Every collision point is measured at its own XY, so a toe beside a tall box and
below its top is a few centimetres from the box side, not deep under the box top.

Between nodes, MuJoCo's compiled ``<hfield>`` is a triangulated surface through the node heights,
not columns: the ramp between a low and a high node row is higher than the low column beside it.
When the collision model has such an hfield, the downward shift is also limited by that surface
(:func:`compiled_hfield_triangulation`), so the lowered foot never ends inside what the SQP collided
with.

Pure NumPy apart from the MuJoCo forward kinematics in :func:`foot_terrain_clearance`.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np
from numpy.typing import NDArray

from hhtools.core.scene import TerrainHeightfield

__all__ = [
    "FootTerrainClearance",
    "column_terrain_distance",
    "compiled_hfield_triangulation",
    "foot_terrain_clearance",
    "GeomSamples",
    "geom_sample_cover",
    "geom_sample_points",
    "terrain_rect_bound",
    "terrain_sample_spacing",
    "terrain_snap_offset",
]

#: Body-name tags that mark a foot body.
FOOT_BODY_TAGS = ("foot", "ankle", "toe")
#: Largest spacing (m) between sample points on flat parts of a foot geom (see
#: :func:`terrain_sample_spacing`).
_SAMPLE_SPACING = 0.02
#: Finest sample spacing (m), however small the terrain cells are.
_MIN_SAMPLE_SPACING = 0.002
#: Largest gap (m) between a curved primitive surface and its lowest sample point.
_CURVE_TOLERANCE = 1e-3
#: Most foot points (frames x points) measured against the terrain in one batch.
_MAX_CHUNK_POINTS = 400_000
#: Gaps at or below this (m) count as contact, so the clip is not lowered.
_SNAP_TOLERANCE = 1e-4


def terrain_sample_spacing(terrain: TerrainHeightfield) -> float:
    """Spacing (m) of foot sample points for ``terrain``: at most half a cell.

    Any column one cell wide then lies under at least one sample of a flat sole.  Cells finer
    than twice :data:`_MIN_SAMPLE_SPACING` keep that minimum spacing to bound the sample count.
    """
    return float(np.clip(0.5 * float(terrain.dx), _MIN_SAMPLE_SPACING, _SAMPLE_SPACING))


def _surface_height(
    xy: NDArray[np.float64], terrain: TerrainHeightfield, triangulation: str
) -> NDArray[np.float64]:
    """Height of the node-interpolated surface at ``xy`` (n, 2); ``-inf`` off the grid.

    ``triangulation`` is the diagonal each cell is split along: ``"main"`` joins nodes
    ``(i, j)`` and ``(i + 1, j + 1)``, ``"anti"`` joins ``(i + 1, j)`` and ``(i, j + 1)``, and
    ``"both"`` is the higher of the two.  A cell with a non-finite corner is ``+inf``.
    """
    hf = np.asarray(terrain.hf, dtype=np.float64)
    nx, ny = hf.shape
    dx = float(terrain.dx)
    out = np.full(len(xy), -np.inf)
    if nx < 2 or ny < 2:
        return out
    origin = np.asarray(terrain.min_point, dtype=np.float64).reshape(2)
    u = (xy[:, 0] - origin[0]) / dx
    v = (xy[:, 1] - origin[1]) / dx
    tol = 1e-6
    on = (u >= -tol) & (u <= nx - 1 + tol) & (v >= -tol) & (v <= ny - 1 + tol)
    i = np.clip(np.floor(u), 0, nx - 2).astype(np.int64)
    j = np.clip(np.floor(v), 0, ny - 2).astype(np.int64)
    fu = np.clip(u - i, 0.0, 1.0)
    fv = np.clip(v - j, 0.0, 1.0)
    corners = [hf[i, j], hf[i + 1, j], hf[i, j + 1], hf[i + 1, j + 1]]
    solid = ~np.all([np.isfinite(c) for c in corners], axis=0)
    h00, h10, h01, h11 = (np.where(solid, 0.0, c) for c in corners)
    main = np.where(
        fu >= fv,
        h00 + fu * (h10 - h00) + fv * (h11 - h10),
        h00 + fv * (h01 - h00) + fu * (h11 - h01),
    )
    anti = np.where(
        fu + fv <= 1.0,
        h00 + fu * (h10 - h00) + fv * (h01 - h00),
        h11 + (1.0 - fu) * (h01 - h11) + (1.0 - fv) * (h10 - h11),
    )
    surface = {"main": main, "anti": anti, "both": np.maximum(main, anti)}[triangulation]
    return np.where(on, np.where(solid, np.inf, surface), out)


def compiled_hfield_triangulation(model, data, terrain: TerrainHeightfield) -> str | None:
    """Diagonal MuJoCo splits the cells of ``model``'s ``<hfield>`` along, or ``None``.

    ``None`` means the model has no heightfield geom, so there is no compiled surface to respect.
    Otherwise this casts rays down onto the compiled surface at the centres of the cells whose two
    triangulations differ most, and returns ``"main"`` or ``"anti"`` (see :func:`_surface_height`)
    when every ray agrees with one of them, else ``"both"`` (the conservative higher surface).
    A terrain whose cells are all planar has no preference and gets ``"main"``.
    """
    import mujoco

    gids = np.flatnonzero(np.asarray(model.geom_type) == int(mujoco.mjtGeom.mjGEOM_HFIELD))
    if gids.size == 0:
        return None
    gid = int(gids[0])
    mujoco.mj_kinematics(model, data)
    hf = np.asarray(terrain.hf, dtype=np.float64)
    if min(hf.shape) < 2:
        return "main"
    ok = np.isfinite(hf)
    ok = ok[:-1, :-1] & ok[1:, :-1] & ok[:-1, 1:] & ok[1:, 1:]
    h = np.where(np.isfinite(hf), hf, 0.0)
    diff = np.abs((h[:-1, :-1] + h[1:, 1:]) - (h[1:, :-1] + h[:-1, 1:])) * 0.5
    diff = np.where(ok, diff, 0.0)
    flat = np.argsort(diff, axis=None)[::-1][:6]
    cells = np.stack(np.unravel_index(flat, diff.shape), axis=1)
    cells = cells[diff[cells[:, 0], cells[:, 1]] > 1e-3]
    if not len(cells):
        return "main"
    origin = np.asarray(terrain.min_point, dtype=np.float64).reshape(2)
    top = float(data.geom_xpos[gid][2] + model.hfield_size[int(model.geom_dataid[gid])][2]) + 1.0
    votes = set()
    for i, j in cells:
        x = origin[0] + (i + 0.5) * float(terrain.dx)
        y = origin[1] + (j + 0.5) * float(terrain.dx)
        depth = mujoco.mj_rayHfield(
            model, data, gid, np.array([x, y, top]), np.array([0.0, 0.0, -1.0])
        )
        if depth < 0.0:
            return "both"
        z = top - depth
        main, anti = 0.5 * (h[i, j] + h[i + 1, j + 1]), 0.5 * (h[i + 1, j] + h[i, j + 1])
        tol = 0.1 * abs(main - anti) + 1e-6
        if abs(z - main) <= tol and abs(z - main) < abs(z - anti):
            votes.add("main")
        elif abs(z - anti) <= tol:
            votes.add("anti")
        else:
            return "both"
    return votes.pop() if len(votes) == 1 else "both"


def column_terrain_distance(
    points: NDArray,
    terrain: TerrainHeightfield,
    *,
    floor_z: float = 0.0,
    max_distance: float = 0.1,
    triangulation: str | None = None,
) -> tuple[NDArray[np.float64], NDArray[np.float64]]:
    """Signed distance and vertical clearance of world ``points`` (..., 3) to the column terrain.

    Returns ``(signed_distance, vertical_clearance)``, both shaped like ``points[..., 0]``:

    * ``signed_distance``: the column metric.  Outside the columns, the distance to the nearest
      column or the floor; inside, minus the shortest way out into free space, straight up or
      sideways past a lower column.  A point beside a tall column and below its top is therefore
      at the horizontal gap to the column's side.  Exact within ``max_distance`` and clipped to
      ``[-max_distance, max_distance]`` beyond it (only columns that close are searched).  It
      does not depend on ``triangulation``.
    * ``vertical_clearance``: height of the point above the highest column whose footprint
      contains its XY (``floor_z`` outside the grid), i.e. how far it can move straight down
      before it meets the terrain.  Negative inside the terrain.  With ``triangulation`` it is
      also capped by the compiled surface, so it can be negative where ``signed_distance`` is
      positive (a point inside a ramp, outside every column).

    Cells without a finite height (NaN or +/-inf) count as solid of unbounded height, so unknown
    terrain never reads as free space.  Points with a non-finite coordinate get NaN in both
    outputs.

    ``triangulation`` (``"main"``, ``"anti"`` or ``"both"``, see :func:`_surface_height`) adds the
    surface between nodes to the terrain that ``vertical_clearance`` is measured against: the
    interpolated surface of the compiled hfield can only be higher than the column beside it, so
    it reduces ``vertical_clearance``, never raises it.  The signed distance ignores it.  ``None``
    reads the terrain as columns only.
    """
    pts = np.asarray(points, dtype=np.float64)
    batch = pts.shape[:-1]
    pts = pts.reshape(-1, 3)
    finite = np.all(np.isfinite(pts), axis=1)
    pts = np.where(finite[:, None], pts, 0.0)
    floor_z = float(floor_z)
    dx = float(terrain.dx)
    reach = max(float(max_distance), 0.0)
    w = max(int(math.ceil(reach / dx)), 1)
    # Floor columns around the grid so the search never leaves the array and points near the
    # border can step out sideways onto the floor.
    hf = np.asarray(terrain.hf, dtype=np.float64)
    heights = np.pad(
        np.maximum(np.where(np.isfinite(hf), hf, np.inf), floor_z), w + 1, constant_values=floor_z
    )
    origin = np.asarray(terrain.min_point, dtype=np.float64).reshape(2) - (w + 1) * dx
    shape = np.asarray(heights.shape)

    idx = np.clip(np.round((pts[:, :2] - origin) / dx), 0, shape - 1).astype(np.int64)
    half = 0.5 * dx

    def gaps(p, i, j):
        """Horizontal gap of points ``p`` to the footprints of columns ``(i, j)``, per axis."""
        ii = np.clip(i, 0, shape[0] - 1)
        jj = np.clip(j, 0, shape[1] - 1)
        lx = np.maximum(np.abs(p[:, 0] - (origin[0] + ii * dx)) - half, 0.0)
        ly = np.maximum(np.abs(p[:, 1] - (origin[1] + jj * dx)) - half, 0.0)
        return lx, ly, heights[ii, jj]

    # Top of the highest column whose footprint contains the XY.  A point on a shared edge or
    # corner lies over every column touching it, all of them the nearest node or a neighbour.
    # Node centres are reconstructed in floating point, so a point exactly on a shared edge can
    # miss the footprint by rounding error; ``tol`` counts that as inside.
    tol = 1e-6 * dx
    z = pts[:, 2]
    under = np.full(len(pts), floor_z)
    for di in (-1, 0, 1):
        for dj in (-1, 0, 1):
            lx, ly, h = gaps(pts, idx[:, 0] + di, idx[:, 1] + dj)
            under = np.maximum(under, np.where((lx <= tol) & (ly <= tol), h, -np.inf))
    columns_under = under  # the signed metric below reads the terrain as columns only
    if triangulation is not None:
        under = np.maximum(under, _surface_height(pts[:, :2], terrain, triangulation))
    vertical = z - under

    # Only points with some column top (or the floor) less than ``reach`` below them can be
    # closer than ``reach``; every other point is clipped to ``reach`` anyway.
    win = 2 * w + 1
    wmax = np.lib.stride_tricks.sliding_window_view(
        np.pad(heights, w, constant_values=floor_z), (win, win)
    ).max(axis=(-2, -1))
    near = finite & (z - reach < wmax[idx[:, 0], idx[:, 1]])
    in_columns = (z - columns_under) < 0.0
    signed = np.where(finite, reach, np.nan)
    flat = heights.ravel()
    for inside in (False, True):
        sel = np.flatnonzero(near & (in_columns == inside))
        if not sel.size:
            continue
        p, zn = pts[sel], z[sel]
        # Window columns along x and rows along y: flat index part and squared horizontal gap.
        cols, rows = [], []
        for d in range(-w, w + 1):
            ii = np.clip(idx[sel, 0] + d, 0, shape[0] - 1)
            jj = np.clip(idx[sel, 1] + d, 0, shape[1] - 1)
            lx = np.maximum(np.abs(p[:, 0] - (origin[0] + ii * dx)) - half, 0.0)
            ly = np.maximum(np.abs(p[:, 1] - (origin[1] + jj * dx)) - half, 0.0)
            cols.append((ii * shape[1], lx * lx))
            rows.append((jj, ly * ly))
        # Squared distance to the nearest column's solid (outside), or to the free space above
        # some column top (inside).
        best = np.full(len(sel), np.inf)
        for base, lx2 in cols:
            for jj, ly2 in rows:
                s = zn - flat.take(base + jj)  # height above this column's top
                s = np.maximum(-s if inside else s, 0.0)
                best = np.minimum(best, lx2 + ly2 + s * s)
        if inside:  # straight up is always a way out
            signed[sel] = -np.minimum(columns_under[sel] - zn, np.sqrt(best))
        else:  # or the floor plane
            signed[sel] = np.minimum(zn - floor_z, np.sqrt(best))
    signed = np.clip(signed, -reach, reach)
    vertical = np.where(finite, vertical, np.nan)
    return signed.reshape(batch), vertical.reshape(batch)


def _cell_planes(h00, h10, h01, h11, triangulation: str):
    """``(a0, gu, gv, kind)`` per triangle of the cells: ``z = a0 + gu * fu + gv * fv``.

    ``(fu, fv)`` are the fractions across the cell along x and y.  ``kind`` tells which part of
    the cell the triangle covers, see :func:`_clip_to_triangle`.
    """
    main = [
        (h00, h10 - h00, h11 - h10, "main_low"),  # fu >= fv
        (h00, h11 - h01, h01 - h00, "main_high"),  # fv >= fu
    ]
    anti = [
        (h00, h10 - h00, h01 - h00, "anti_low"),  # fu + fv <= 1
        (h01 + h10 - h11, h11 - h01, h11 - h10, "anti_high"),  # fu + fv >= 1
    ]
    return {"main": main, "anti": anti, "both": main + anti}[triangulation]


def _clip_to_triangle(u0, u1, v0, v1, kind: str):
    """Bounding box of the rectangle ``[u0, u1] x [v0, v1]`` cut to a half of the unit cell."""
    if kind == "main_low":
        lo_u, hi_u, lo_v, hi_v = np.maximum(u0, v0), u1, v0, np.minimum(v1, u1)
    elif kind == "main_high":
        lo_u, hi_u, lo_v, hi_v = u0, np.minimum(u1, v1), np.maximum(v0, u0), v1
    elif kind == "anti_low":
        lo_u, hi_u, lo_v, hi_v = u0, np.minimum(u1, 1.0 - v0), v0, np.minimum(v1, 1.0 - u0)
    else:
        lo_u, hi_u, lo_v, hi_v = np.maximum(u0, 1.0 - v1), u1, np.maximum(v0, 1.0 - u1), v1
    return lo_u, hi_u, lo_v, hi_v


def terrain_rect_bound(
    x_lo: NDArray,
    x_hi: NDArray,
    y_lo: NDArray,
    y_hi: NDArray,
    terrain: TerrainHeightfield,
    *,
    floor_z: float = 0.0,
    triangulation: str | None = None,
) -> NDArray[np.float64]:
    """Upper bound of the terrain height over each rectangle ``[x_lo, x_hi] x [y_lo, y_hi]``.

    The terrain is the union of the column of every node (:func:`column_terrain_distance`), the
    floor at ``floor_z`` and, with ``triangulation``, the compiled triangle surface.  The bound
    is the tallest column whose footprint overlaps the rectangle, and, per triangle the rectangle
    overlaps, the plane of that triangle at the bounding box of the overlap (exact for a plane
    over a box, and for a rectangle inside one triangle).  A cell with no finite height gives
    ``inf``.  Never below the true maximum over the rectangle.
    """
    x_lo, x_hi, y_lo, y_hi = (
        np.asarray(a, dtype=np.float64).reshape(-1) for a in (x_lo, x_hi, y_lo, y_hi)
    )
    floor_z = float(floor_z)
    dx = float(terrain.dx)
    hf = np.asarray(terrain.hf, dtype=np.float64)
    nx, ny = hf.shape
    origin = np.asarray(terrain.min_point, dtype=np.float64).reshape(2)
    out = np.full(len(x_lo), floor_z)
    if not len(x_lo):
        return out
    span = int(math.ceil(float(max((x_hi - x_lo).max(), (y_hi - y_lo).max())) / dx)) + 1
    if span > 24:  # a rectangle that wide: the tallest thing anywhere is the only affordable bound
        top = float(np.max(np.where(np.isfinite(hf), hf, np.inf)))
        return np.full(len(x_lo), max(top, floor_z))
    ux0, ux1 = (x_lo - origin[0]) / dx, (x_hi - origin[0]) / dx
    uy0, uy1 = (y_lo - origin[1]) / dx, (y_hi - origin[1]) / dx

    # Columns: node i covers [i - 1/2, i + 1/2] (in cells); the footprint tolerance counts a
    # touching rectangle as overlapping, which can only raise the bound.
    tol = 1e-6
    heights = np.maximum(np.where(np.isfinite(hf), hf, np.inf), floor_z)
    i_lo = np.ceil(ux0 - 0.5 - tol).astype(np.int64)
    j_lo = np.ceil(uy0 - 0.5 - tol).astype(np.int64)
    i_hi = np.floor(ux1 + 0.5 + tol).astype(np.int64)
    j_hi = np.floor(uy1 + 0.5 + tol).astype(np.int64)
    for di in range(span + 1):
        ii = i_lo + di
        for dj in range(span + 1):
            jj = j_lo + dj
            ok = (ii <= i_hi) & (jj <= j_hi) & (ii >= 0) & (ii < nx) & (jj >= 0) & (jj < ny)
            h = heights[np.clip(ii, 0, nx - 1), np.clip(jj, 0, ny - 1)]
            out = np.maximum(out, np.where(ok, h, -np.inf))

    if triangulation is not None and nx >= 2 and ny >= 2:
        c_lo = np.floor(ux0 - tol).astype(np.int64)
        d_lo = np.floor(uy0 - tol).astype(np.int64)
        for di in range(span + 1):
            ci = c_lo + di
            for dj in range(span + 1):
                cj = d_lo + dj
                ok = (ci >= 0) & (ci <= nx - 2) & (cj >= 0) & (cj <= ny - 2)
                ok &= (ci <= np.floor(ux1 + tol)) & (cj <= np.floor(uy1 + tol))
                if not ok.any():
                    continue
                i, j = np.clip(ci, 0, nx - 2), np.clip(cj, 0, ny - 2)
                corners = [hf[i, j], hf[i + 1, j], hf[i, j + 1], hf[i + 1, j + 1]]
                finite = np.all([np.isfinite(c) for c in corners], axis=0)
                h00, h10, h01, h11 = (np.where(finite, c, 0.0) for c in corners)
                u0, u1 = np.maximum(ux0 - ci, 0.0), np.minimum(ux1 - ci, 1.0)
                v0, v1 = np.maximum(uy0 - cj, 0.0), np.minimum(uy1 - cj, 1.0)
                for a0, gu, gv, kind in _cell_planes(h00, h10, h01, h11, triangulation):
                    lu, hu, lv, hv = _clip_to_triangle(u0, u1, v0, v1, kind)
                    live = ok & (lu <= hu + tol) & (lv <= hv + tol)
                    uc, vc = 0.5 * (lu + hu), 0.5 * (lv + hv)
                    top = (
                        a0 + gu * uc + gv * vc
                        + np.abs(gu) * 0.5 * np.maximum(hu - lu, 0.0)
                        + np.abs(gv) * 0.5 * np.maximum(hv - lv, 0.0)
                    )
                    top = np.where(finite, top, np.inf)
                    out = np.maximum(out, np.where(live, top, -np.inf))
    return out


def _neighbourhood_top(
    cx: NDArray, cy: NDArray, half_extent: float, terrain: TerrainHeightfield, floor_z: float
) -> NDArray[np.float64]:
    """Cheap upper bound of the terrain height near points ``(cx, cy)``: the tallest node or floor
    within ``half_extent`` plus a cell in every direction.  Between nodes the compiled surface
    never exceeds the tallest of the cell's four nodes, so this also bounds the surface."""
    hf = np.asarray(terrain.hf, dtype=np.float64)
    dx = float(terrain.dx)
    w = int(math.ceil(half_extent / dx)) + 2
    if w > 24:
        top = float(np.max(np.where(np.isfinite(hf), hf, np.inf)))
        return np.full(cx.shape, max(top, floor_z))
    heights = np.pad(
        np.maximum(np.where(np.isfinite(hf), hf, np.inf), floor_z), w + 1, constant_values=floor_z
    )
    win = 2 * w + 1
    wmax = np.lib.stride_tricks.sliding_window_view(heights, (win, win)).max(axis=(-2, -1))
    # wmax[a, b] covers padded nodes a .. a + 2w, i.e. window centred on padded node a + w.
    origin = np.asarray(terrain.min_point, dtype=np.float64).reshape(2)
    i = np.round((cx - origin[0]) / dx).astype(np.int64) + 1  # padded index - w, plus the pad
    j = np.round((cy - origin[1]) / dx).astype(np.int64) + 1
    i = np.clip(i, 0, wmax.shape[0] - 1)
    j = np.clip(j, 0, wmax.shape[1] - 1)
    return wmax[i, j]


def _tilt_drop(
    radius: NDArray, curvature: NDArray, nz: NDArray, cap: NDArray | float
) -> NDArray[np.float64]:
    """How far below a sample a ball cell of ``radius`` along the surface can reach.

    A surface tilted ``psi`` from horizontal (``sin psi = sqrt(1 - nz**2)``) drops
    ``radius * sin(psi)`` over ``radius`` of surface; a curved piece tilts up to
    ``curvature * radius`` more.  At most ``cap``.
    """
    psi = np.arcsin(np.sqrt(np.clip(1.0 - nz * nz, 0.0, 1.0)))
    drop = radius * np.sin(np.minimum(psi + curvature * radius, 0.5 * np.pi))
    return np.clip(np.minimum(drop, cap), 0.0, None)


@dataclass(frozen=True)
class FootTerrainClearance:
    """Per-frame minima over all foot collision points.

    A frame that could not be measured (no foot geoms, or a non-finite pose) is NaN, and so are
    the clip-wide minima then: clearance is only established if every frame is measured.
    """

    signed_distance: NDArray[np.float64]  # (F,)
    vertical_clearance: NDArray[np.float64]  # (F,)

    @property
    def min_signed_distance(self) -> float:
        d = self.signed_distance
        return float(np.min(d)) if d.size else float("nan")

    @property
    def min_vertical_clearance(self) -> float:
        d = self.vertical_clearance
        return float(np.min(d)) if d.size else float("nan")


def _arc_count(radius: float) -> int:
    """Samples around a circle so a chord sags at most ``_CURVE_TOLERANCE`` below the arc."""
    if radius <= _CURVE_TOLERANCE:
        return 8
    return max(8, math.ceil(math.pi / math.acos(1.0 - _CURVE_TOLERANCE / radius)))


def _sphere_directions(radius: float) -> NDArray[np.float64]:
    """Unit directions on latitude rings, each direction within ``_CURVE_TOLERANCE`` of a sample.

    Any direction is within an angle ``t`` of a sample, so the lowest sample of a sphere of
    ``radius`` is at most ``radius * (1 - cos t) <= _CURVE_TOLERANCE`` above its lowest point.
    """
    t = math.acos(max(1.0 - _CURVE_TOLERANCE / max(radius, _CURVE_TOLERANCE), -1.0))
    step = t * math.sqrt(2.0)
    rings = []
    for lat in np.linspace(-0.5 * np.pi, 0.5 * np.pi, max(math.ceil(np.pi / step), 2) + 1):
        n = max(math.ceil(2.0 * np.pi * math.cos(lat) / step), 1)
        lon = np.linspace(0.0, 2.0 * np.pi, n, endpoint=False)
        c = math.cos(lat)
        rings.append(np.stack([c * np.cos(lon), c * np.sin(lon), np.full(n, math.sin(lat))], 1))
    return np.concatenate(rings, axis=0)


@dataclass(frozen=True)
class GeomSamples:
    """Surface samples of one collision geom, in its own frame, with what a bound needs.

    The surface is cut into pieces (the faces of a box or of a mesh hull, one piece for a curved
    primitive) and every piece into cells, one per sample, so that every surface point is in the
    cell of some sample.  A cell is either a flat box (``cell_half`` along the geom axes, centred
    at ``points + cell_offset``; the faces of a box) or a ball of ``radius`` along the surface
    around its sample (everything else), whose surface tilts away from the sample's own tilt by
    at most ``curvature`` radians per metre of that distance.  ``normals`` are the pieces'
    outward unit normals (zero where unknown: the tilt is then taken as vertical).
    ``piece_vertices`` (m, k, 3), when given, are points whose lowest world height is the
    piece's lowest; without them (curved primitives, one piece) :func:`piece_lowest_z` uses the
    primitive's formula.
    """

    points: NDArray[np.float64]  # (n, 3)
    normals: NDArray[np.float64]  # (n, 3)
    radius: NDArray[np.float64]  # (n,) ball cells; 0 for box cells
    curvature: NDArray[np.float64]  # (n,)
    piece: NDArray[np.int64]  # (n,) index into the pieces
    piece_vertices: NDArray[np.float64] | None  # (m, k, 3)
    cell_offset: NDArray[np.float64] | None = None  # (n, 3) box cells
    cell_half: NDArray[np.float64] | None = None  # (n, 3) box cells


def _stations(half_length: float, spacing: float = _SAMPLE_SPACING) -> NDArray[np.float64]:
    n = max(math.ceil(2.0 * half_length / spacing) + 1, 2)
    return np.linspace(-half_length, half_length, n)


def _triangle_samples(
    tri: NDArray[np.float64], spacing: float = _SAMPLE_SPACING, *, return_face: bool = False
):
    """Samples on triangles (m, 3, 3): corners, points along edges and a grid inside.

    Edges are split into pieces of at most ``spacing``; triangles wide enough to hold
    a disk of that diameter also get a square grid of that spacing in their plane.  Every point
    of a triangle is within ``spacing`` of a sample of that triangle.  ``return_face`` also
    returns the triangle index of every sample.
    """
    s = spacing
    out = [tri.reshape(-1, 3)]
    face = [np.repeat(np.arange(len(tri)), 3)]
    a, b = tri, tri[:, [1, 2, 0]]
    lengths = np.linalg.norm(b - a, axis=2)  # (m, 3)
    pieces = np.ceil(lengths / s).astype(np.int64)
    for k in np.unique(pieces[pieces > 1]):
        m = pieces == k
        t = (np.arange(1, k) / k)[None, :, None]
        out.append((a[m][:, None] + t * (b[m] - a[m])[:, None]).reshape(-1, 3))
        face.append(np.repeat(np.nonzero(m)[0], k - 1))
    normal = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
    area2 = np.linalg.norm(normal, axis=1)  # twice the area
    inradius = area2 / np.maximum(lengths.sum(axis=1), 1e-12)
    for f in np.flatnonzero(inradius > 0.5 * s):
        p0, p1, p2 = tri[f]
        e1 = (p1 - p0) / np.linalg.norm(p1 - p0)
        e2 = np.cross(normal[f] / area2[f], e1)
        uv = np.array([[0.0, 0.0], [(p1 - p0) @ e1, 0.0], [(p2 - p0) @ e1, (p2 - p0) @ e2]])
        lo, hi = uv.min(axis=0), uv.max(axis=0)
        gu, gv = np.meshgrid(np.arange(lo[0], hi[0], s), np.arange(lo[1], hi[1], s))
        q = np.stack([gu.ravel(), gv.ravel()], axis=1)
        # Inside test: same side of all three edges (the uv triangle is counter-clockwise).
        e = np.roll(uv, -1, axis=0) - uv
        rel = q[:, None, :] - uv[None]
        inside = np.all(e[None, :, 0] * rel[..., 1] - e[None, :, 1] * rel[..., 0] >= 0.0, axis=1)
        q = q[inside]
        out.append(p0 + q[:, :1] * e1 + q[:, 1:] * e2)
        face.append(np.full(len(q), f))
    points = np.concatenate(out, axis=0)
    return (points, np.concatenate(face)) if return_face else points


def _mesh_hull_samples(model, mesh_id: int, spacing: float) -> GeomSamples:
    """Samples on the convex hull MuJoCo collides with: its faces, edges and vertices."""
    adr, num = int(model.mesh_vertadr[mesh_id]), int(model.mesh_vertnum[mesh_id])
    verts = np.asarray(model.mesh_vert[adr : adr + num], dtype=np.float64)
    extent = float(np.linalg.norm(verts.max(axis=0) - verts.min(axis=0))) if num else 0.0

    def unknown_faces(points) -> GeomSamples:
        # No usable faces: the samples cover nothing between them, so claim the whole extent.
        n = len(points)
        return GeomSamples(
            points, np.zeros((n, 3)), np.full(n, extent), np.zeros(n), np.zeros(n, np.int64), None
        )

    gadr = int(model.mesh_graphadr[mesh_id])
    if gadr < 0:
        return unknown_faces(verts)
    # mesh_graph: numvert, numface, vert_edgeadr[numvert], vert_globalid[numvert],
    # edge_localid[numvert + 3 * numface], face_globalid[3 * numface]
    graph = model.mesh_graph
    nv, nf = int(graph[gadr]), int(graph[gadr + 1])
    hull = np.asarray(graph[gadr + 2 + nv : gadr + 2 + 2 * nv], dtype=np.int64)
    fadr = gadr + 2 + 3 * nv + 3 * nf
    faces = np.asarray(graph[fadr : fadr + 3 * nf], dtype=np.int64).reshape(nf, 3)
    if not (hull.size and hull.min() >= 0 and hull.max() < num):
        return unknown_faces(verts)
    if nf == 0 or faces.min() < 0 or faces.max() >= num:
        return unknown_faces(verts[hull])
    tris = verts[faces]
    points, face = _triangle_samples(tris, spacing, return_face=True)
    key = np.round(np.concatenate([points, face[:, None]], axis=1), 9)
    _, first = np.unique(key, axis=0, return_index=True)
    first = np.sort(first)
    points, face = points[first], face[first]
    n = np.cross(tris[:, 1] - tris[:, 0], tris[:, 2] - tris[:, 0])
    norm = np.linalg.norm(n, axis=1, keepdims=True)
    n = np.where(norm > 1e-12, n / np.maximum(norm, 1e-12), 0.0)
    # The hull is convex: outward is away from the centroid.
    flip = np.einsum("ij,ij->i", n, tris.mean(axis=1) - verts[hull].mean(axis=0)) < 0.0
    n[flip] *= -1.0
    count = len(points)
    return GeomSamples(
        points,
        n[face],
        np.full(count, float(spacing)),
        np.zeros(count),
        face.astype(np.int64),
        tris,
    )


def _cell_bounds(stations: NDArray[np.float64], half: float):
    """Centre and half-width of each station's cell: half a step either way, within the face."""
    step = float(stations[1] - stations[0])
    lo = np.maximum(stations - 0.5 * step, -half)
    hi = np.minimum(stations + 0.5 * step, half)
    return 0.5 * (lo + hi), 0.5 * (hi - lo)


def _box_samples(size: NDArray[np.float64], spacing: float) -> GeomSamples:
    """Per-face grids of a box; each sample owns the rectangle of its grid cell."""
    pts, nrm, piece, corners, offs, halves = [], [], [], [], [], []
    for axis in range(3):
        u, v = [i for i in range(3) if i != axis]
        su, sv = _stations(float(size[u]), spacing), _stations(float(size[v]), spacing)
        cu, hu = _cell_bounds(su, float(size[u]))
        cv, hv = _cell_bounds(sv, float(size[v]))
        gu, gv = np.meshgrid(su, sv, indexing="ij")
        cgu, cgv = np.meshgrid(cu, cv, indexing="ij")
        hgu, hgv = np.meshgrid(hu, hv, indexing="ij")
        for sign in (-1.0, 1.0):
            face = np.zeros((gu.size, 3))
            face[:, axis] = sign * size[axis]
            face[:, u], face[:, v] = gu.ravel(), gv.ravel()
            off = np.zeros_like(face)
            off[:, u], off[:, v] = (cgu - gu).ravel(), (cgv - gv).ravel()
            half = np.zeros_like(face)
            half[:, u], half[:, v] = hgu.ravel(), hgv.ravel()
            normal = np.zeros(3)
            normal[axis] = sign
            pts.append(face)
            offs.append(off)
            halves.append(half)
            nrm.append(np.tile(normal, (len(face), 1)))
            piece.append(np.full(len(face), len(corners)))
            quad = np.zeros((4, 3))
            quad[:, axis] = sign * size[axis]
            quad[:, u] = [-size[u], size[u], -size[u], size[u]]
            quad[:, v] = [-size[v], -size[v], size[v], size[v]]
            corners.append(quad)
    points = np.concatenate(pts)
    return GeomSamples(
        points,
        np.concatenate(nrm),
        np.zeros(len(points)),
        np.zeros(len(points)),
        np.concatenate(piece).astype(np.int64),
        np.stack(corners),
        np.concatenate(offs),
        np.concatenate(halves),
    )


def geom_sample_cover(model, gid: int, spacing: float = _SAMPLE_SPACING) -> GeomSamples:
    """Surface samples of collision geom ``gid`` with covering radii; empty if unsupported.

    Meshes use the convex hull MuJoCo collides with (its faces, edges and vertices), boxes a
    grid per face, curved primitives rings and latitudes whose lowest sample is within
    ``_CURVE_TOLERANCE`` of the lowest surface point.  Flat parts are sampled at most
    ``spacing`` apart.  See :class:`GeomSamples` for what the radii promise.
    """
    import mujoco

    gtype = int(model.geom_type[gid])
    size = np.asarray(model.geom_size[gid], dtype=np.float64)
    empty = GeomSamples(
        np.zeros((0, 3)), np.zeros((0, 3)), np.zeros(0), np.zeros(0), np.zeros(0, np.int64), None
    )

    def one_piece(points, normals, radius, curvature) -> GeomSamples:
        n = len(points)
        return GeomSamples(
            points, normals, np.broadcast_to(radius, n).copy(),
            np.broadcast_to(curvature, n).copy(), np.zeros(n, np.int64), None,
        )

    if gtype == int(mujoco.mjtGeom.mjGEOM_MESH):
        return _mesh_hull_samples(model, int(model.geom_dataid[gid]), spacing)
    if gtype == int(mujoco.mjtGeom.mjGEOM_BOX):
        return _box_samples(size, spacing)
    if gtype == int(mujoco.mjtGeom.mjGEOM_SPHERE):
        r = float(size[0])
        dirs = _sphere_directions(r)
        t = math.acos(max(1.0 - _CURVE_TOLERANCE / max(r, _CURVE_TOLERANCE), -1.0))
        return one_piece(dirs * r, dirs, r * t * math.sqrt(2.0), 1.0 / r)
    if gtype == int(mujoco.mjtGeom.mjGEOM_ELLIPSOID):
        top = float(size[:3].max())
        dirs = _sphere_directions(top)
        t = math.acos(max(1.0 - _CURVE_TOLERANCE / max(top, _CURVE_TOLERANCE), -1.0))
        # Normals and curvature of an ellipsoid are not bounded here: vertical tilt, no
        # curvature term, and a radius that covers the whole angular cell at the longest axis.
        return one_piece(dirs * size[:3], np.zeros_like(dirs), top * t * math.sqrt(2.0), 0.0)
    if gtype in (int(mujoco.mjtGeom.mjGEOM_CAPSULE), int(mujoco.mjtGeom.mjGEOM_CYLINDER)):
        r, hl = float(size[0]), float(size[1])
        count = _arc_count(r)
        ang = np.linspace(0.0, 2.0 * np.pi, count, endpoint=False)
        ring = np.stack([np.cos(ang), np.sin(ang), np.zeros_like(ang)], axis=1)
        zs = _stations(hl, spacing)
        step_z = float(zs[1] - zs[0])
        lateral_radius = math.hypot(r * math.pi / count, 0.5 * step_z)
        pts = [r * ring + np.array([0.0, 0.0, z]) for z in zs]
        nrm = [ring] * len(zs)
        rad = [np.full(count, lateral_radius)] * len(zs)
        cur = [np.full(count, 1.0 / r)] * len(zs)
        if gtype == int(mujoco.mjtGeom.mjGEOM_CAPSULE):
            dirs = _sphere_directions(r)
            t = math.acos(max(1.0 - _CURVE_TOLERANCE / max(r, _CURVE_TOLERANCE), -1.0))
            cap_radius = max(r * t * math.sqrt(2.0), lateral_radius)
            for sign in (1.0, -1.0):
                d = dirs[dirs[:, 2] * sign >= 0.0]
                pts.append(r * d + np.array([0.0, 0.0, sign * hl]))
                nrm.append(d)
                rad.append(np.full(len(d), cap_radius))
                cur.append(np.full(len(d), 1.0 / r))
        else:
            # Flat caps: concentric rings out to the rim.
            k = max(math.ceil(r / spacing), 1)
            radii = np.linspace(0.0, r, k + 1)
            cap_radius = math.hypot(0.5 * r / k, r * math.pi / count)
            for z, sign in ((-hl, -1.0), (hl, 1.0)):
                for rr in radii:
                    pts.append(rr * ring + np.array([0.0, 0.0, z]))
                    nrm.append(np.tile([0.0, 0.0, sign], (count, 1)))
                    rad.append(np.full(count, cap_radius))
                    cur.append(np.zeros(count))
        return one_piece(
            np.concatenate(pts), np.concatenate(nrm), np.concatenate(rad), np.concatenate(cur)
        )
    return empty


def geom_sample_points(
    model, gid: int, spacing: float = _SAMPLE_SPACING
) -> NDArray[np.float64]:
    """Points (n, 3) on collision geom ``gid`` in its own frame; empty for unsupported types.

    The points of :func:`geom_sample_cover`, without duplicates.  Between samples a tilted face
    can still dip below a column edge by up to its slope times ``spacing``; the Z-snap accounts for
    that with the covering radii.
    """
    pts = geom_sample_cover(model, gid, spacing).points
    if len(pts) == 0:
        return pts
    _, first = np.unique(np.round(pts, 9), axis=0, return_index=True)
    return pts[np.sort(first)]


def piece_lowest_z(model, gid: int, samples: GeomSamples, xpos, rot) -> NDArray[np.float64]:
    """World height of the lowest point of each piece of ``samples`` (m,), for geom pose
    ``(xpos, rot)``; at most the true lowest point."""
    import mujoco

    if samples.piece_vertices is not None:
        return xpos[2] + (samples.piece_vertices @ rot[2]).min(axis=1)
    gtype = int(model.geom_type[gid])
    size = np.asarray(model.geom_size[gid], dtype=np.float64)
    az = np.abs(rot[2])  # world z components of the geom axes
    if gtype == int(mujoco.mjtGeom.mjGEOM_SPHERE):
        reach = size[0]
    elif gtype == int(mujoco.mjtGeom.mjGEOM_CAPSULE):
        reach = size[1] * az[2] + size[0]
    elif gtype == int(mujoco.mjtGeom.mjGEOM_CYLINDER):
        reach = size[1] * az[2] + size[0] * math.sqrt(max(1.0 - az[2] ** 2, 0.0))
    else:  # ellipsoid and anything else: its bounding box
        ellipsoid = gtype == int(mujoco.mjtGeom.mjGEOM_ELLIPSOID)
        reach = float(np.sum(az * size[:3])) if ellipsoid else np.inf
    return np.array([xpos[2] - reach])


def _actuated_qpos_addresses(model) -> list[int]:
    import mujoco

    kinds = (int(mujoco.mjtJoint.mjJNT_HINGE), int(mujoco.mjtJoint.mjJNT_SLIDE))
    return [int(model.jnt_qposadr[j]) for j in range(model.njnt) if int(model.jnt_type[j]) in kinds]


def foot_terrain_clearance(
    model,
    data,
    joint_q: NDArray,
    terrain: TerrainHeightfield,
    *,
    floor_z: float = 0.0,
    max_distance: float = 0.1,
    chunk_frames: int = 64,
) -> FootTerrainClearance:
    """Terrain clearance of every foot collision point in every frame of ``joint_q``.

    Foot geoms are the collidable geoms on bodies whose name contains ``foot``, ``ankle`` or
    ``toe``.  ``joint_q`` rows are ``[root xyz, root quat xyzw, actuated DOFs]`` in MuJoCo joint
    order (as ``pack_joint_q_csv`` writes them).

    ``signed_distance`` is the column metric at the sample points (:func:`column_terrain_distance`).
    ``vertical_clearance`` is a *lower bound* of how far every point of the foot surface can move
    straight down before it meets the terrain (columns, floor and, if the model has an hfield, its
    triangle surface), not only the sample points.  Each sample stands for the surface piece
    around it within the covering radius ``rho`` of :class:`GeomSamples`; the piece can be
    ``d`` lower than the sample (:func:`_tilt_drop`: its tilt, capped at the piece's lowest
    point), and the terrain under it at most :func:`terrain_height_bound` high, so
    ``z - d - height_bound`` is a lower bound for the whole piece.  A level sole over flat or
    varying terrain loses only what the terrain rises within ``rho``; a face tilted like the
    terrain loses about ``2 * rho * slope``.
    """
    import mujoco

    spacing = terrain_sample_spacing(terrain)
    triangulation = compiled_hfield_triangulation(model, data, terrain)
    geoms: list[int] = []
    cloud: list[GeomSamples] = []
    for g in range(model.ngeom):
        if int(model.geom_contype[g]) == 0 and int(model.geom_conaffinity[g]) == 0:
            continue
        body = mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_BODY, int(model.geom_bodyid[g])) or ""
        if not any(tag in body.lower() for tag in FOOT_BODY_TAGS):
            continue
        samples = geom_sample_cover(model, g, spacing)
        if len(samples.points):
            geoms.append(g)
            cloud.append(samples)
    jq = np.asarray(joint_q, dtype=np.float64)
    num_frames = int(jq.shape[0])
    signed = np.full(num_frames, np.nan)
    vertical = np.full(num_frames, np.nan)
    if not geoms or num_frames == 0:
        return FootTerrainClearance(signed, vertical)

    qadr = _actuated_qpos_addresses(model)
    counts = [len(c.points) for c in cloud]
    total = sum(counts)
    radius = np.concatenate([c.radius for c in cloud])
    curvature = np.concatenate([c.curvature for c in cloud])
    chunk_frames = max(1, min(chunk_frames, _MAX_CHUNK_POINTS // total))
    rows = min(chunk_frames, num_frames)
    world = np.empty((rows, total, 3), dtype=np.float64)  # sample points
    centre = np.empty((rows, total, 3), dtype=np.float64)  # cell centres
    half = np.empty((rows, total, 3), dtype=np.float64)  # cell half extents (x, y, z)
    normal_z = np.empty((rows, total), dtype=np.float64)
    lowest = np.empty((rows, total), dtype=np.float64)
    for start in range(0, num_frames, chunk_frames):
        stop = min(start + chunk_frames, num_frames)
        for k, f in enumerate(range(start, stop)):
            row = jq[f]
            data.qpos[:3] = row[:3]
            data.qpos[3] = row[6]
            data.qpos[4:7] = row[3:6]
            for i, adr in enumerate(qadr):
                data.qpos[adr] = row[7 + i]
            mujoco.mj_kinematics(model, data)
            off = 0
            for g, c in zip(geoms, cloud, strict=True):
                rot = data.geom_xmat[g].reshape(3, 3)
                pos = data.geom_xpos[g]
                n = len(c.points)
                world[k, off : off + n] = pos + c.points @ rot.T
                if c.cell_half is None:  # ball cells: centred on the sample, `radius` every way
                    centre[k, off : off + n] = world[k, off : off + n]
                    half[k, off : off + n, :2] = c.radius[:, None]
                    half[k, off : off + n, 2] = 0.0
                else:  # box cells: a rotated flat box
                    centre[k, off : off + n] = pos + (c.points + c.cell_offset) @ rot.T
                    half[k, off : off + n] = c.cell_half @ np.abs(rot).T
                normal_z[k, off : off + n] = c.normals @ rot[2]
                lowest[k, off : off + n] = piece_lowest_z(model, g, c, pos, rot)[c.piece]
                off += n
        n = stop - start
        sd, point_clear = column_terrain_distance(
            world[:n], terrain, floor_z=floor_z, max_distance=max_distance,
            triangulation=triangulation,
        )
        signed[start:stop] = sd.min(axis=1)
        zc = centre[:n, :, 2]
        # Lowest the cell reaches: its flat box's height extent, or the tilt of a ball cell,
        # never below the piece's lowest point.
        reach = half[:n, :, 2] + _tilt_drop(radius, curvature, normal_z[:n], np.inf)
        floor_of_cell = np.maximum(zc - reach, lowest[:n])
        cx, cy = centre[:n, :, 0], centre[:n, :, 1]
        hx, hy = half[:n, :, 0], half[:n, :, 1]
        # A sample's cell clearance is at most its point's clearance, so the frame's smallest
        # point clearance bounds the answer from above, and cells that are above that even
        # against the tallest terrain around them cannot lower it: only the rest is bounded.
        near_top = _neighbourhood_top(cx, cy, float(max(hx.max(), hy.max())), terrain, floor_z)
        cheap = floor_of_cell - near_top  # no higher a lower bound than the exact one below
        bound = np.full((n, total), np.inf)

        def tighten(fi, pi, cx=cx, cy=cy, hx=hx, hy=hy, bound=bound, base=floor_of_cell):
            ceiling = terrain_rect_bound(
                cx[fi, pi] - hx[fi, pi], cx[fi, pi] + hx[fi, pi],
                cy[fi, pi] - hy[fi, pi], cy[fi, pi] + hy[fi, pi],
                terrain, floor_z=floor_z, triangulation=triangulation,
            )
            bound[fi, pi] = base[fi, pi] - ceiling

        # Exact bounds first for the cells that look lowest, then only for the cells whose cheap
        # bound is below the smallest exact one (or below the smallest point clearance).
        first = min(32, total)
        low = np.argpartition(cheap, first - 1, axis=1)[:, :first]
        tighten(np.repeat(np.arange(n), first), low.ravel())
        limit = np.minimum(point_clear.min(axis=1), bound.min(axis=1))[:, None]
        fi, pi = np.nonzero((cheap <= limit + 1e-9) & np.isinf(bound))
        tighten(fi, pi)
        vertical[start:stop] = bound.min(axis=1)
    return FootTerrainClearance(signed, vertical)


def terrain_snap_offset(min_signed_distance: float, min_vertical_clearance: float) -> float:
    """Downward root shift (m) for the final terrain snap; never negative.

    Only a clip whose feet are clear of the terrain in every frame is lowered, by the smallest
    vertical clearance, so the lowest foot point lands on the terrain and no point goes in.
    A clip with any contact or penetration is left alone: a local penetration (a toe grazing a
    box side in one frame) must not lift every other frame off the ground.
    """
    if not (np.isfinite(min_signed_distance) and np.isfinite(min_vertical_clearance)):
        return 0.0
    if min(min_signed_distance, min_vertical_clearance) <= _SNAP_TOLERANCE:
        return 0.0
    return float(min_vertical_clearance)
