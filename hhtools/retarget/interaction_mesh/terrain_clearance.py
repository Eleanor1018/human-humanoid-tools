# SPDX-FileCopyrightText: Copyright (c) 2026 hhtools contributors
# SPDX-License-Identifier: Apache-2.0
"""Foot-to-terrain clearance for the final Z-snap of the interaction-mesh pipeline.

The terrain is read as columns: heightfield node ``(i, j)`` is a solid column of footprint
``dx`` x ``dx`` centred on world XY ``min_point + (i, j) * dx`` that reaches from minus infinity
up to ``hf[i, j]``, and the collision scene's ground plane at ``floor_z`` is solid below
everything.  Every collision point is measured at its own XY, so a toe beside a tall box and
below its top is a few centimetres from the box side, not deep under the box top.

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
    "foot_terrain_clearance",
    "geom_sample_points",
    "terrain_snap_offset",
]

#: Body-name tags that mark a foot body.
FOOT_BODY_TAGS = ("foot", "ankle", "toe")
#: Largest spacing (m) between sample points on flat parts of a foot geom.
_SAMPLE_SPACING = 0.02
#: Largest gap (m) between a curved primitive surface and its lowest sample point.
_CURVE_TOLERANCE = 1e-3
#: Gaps at or below this (m) count as contact, so the clip is not lowered.
_SNAP_TOLERANCE = 1e-4


def column_terrain_distance(
    points: NDArray,
    terrain: TerrainHeightfield,
    *,
    floor_z: float = 0.0,
    max_distance: float = 0.1,
) -> tuple[NDArray[np.float64], NDArray[np.float64]]:
    """Signed distance and vertical clearance of world ``points`` (..., 3) to the column terrain.

    Returns ``(signed_distance, vertical_clearance)``, both shaped like ``points[..., 0]``:

    * ``signed_distance``: outside the terrain, the distance to the nearest column or the
      floor; inside, minus the shortest way out into free space, straight up or sideways past
      a lower column.  A point beside a tall column and below its top is therefore at the
      horizontal gap to the column's side.  Exact within ``max_distance`` and clipped to
      ``[-max_distance, max_distance]`` beyond it (only columns that close are searched).
    * ``vertical_clearance``: height of the point above the highest column whose footprint
      contains its XY (``floor_z`` outside the grid), i.e. how far it can move straight down
      before it meets the terrain.  Negative inside the terrain; same sign as
      ``signed_distance``.

    Cells without a finite height count as solid of unbounded height, so unknown terrain never
    reads as free space.  Points with a non-finite coordinate get NaN in both outputs.
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
        np.maximum(np.where(np.isnan(hf), np.inf, hf), floor_z), w + 1, constant_values=floor_z
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
    z = pts[:, 2]
    under = np.full(len(pts), floor_z)
    for di in (-1, 0, 1):
        for dj in (-1, 0, 1):
            lx, ly, h = gaps(pts, idx[:, 0] + di, idx[:, 1] + dj)
            under = np.maximum(under, np.where((lx == 0.0) & (ly == 0.0), h, -np.inf))
    vertical = z - under

    # Only points with some column top (or the floor) less than ``reach`` below them can be
    # closer than ``reach``; every other point is clipped to ``reach`` anyway.
    win = 2 * w + 1
    wmax = np.lib.stride_tricks.sliding_window_view(
        np.pad(heights, w, constant_values=floor_z), (win, win)
    ).max(axis=(-2, -1))
    near = finite & (z - reach < wmax[idx[:, 0], idx[:, 1]])
    signed = np.where(finite, reach, np.nan)
    flat = heights.ravel()
    for inside in (False, True):
        sel = np.flatnonzero(near & ((vertical < 0.0) == inside))
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
            signed[sel] = -np.minimum(under[sel] - zn, np.sqrt(best))
        else:  # or the floor plane
            signed[sel] = np.minimum(zn - floor_z, np.sqrt(best))
    signed = np.clip(signed, -reach, reach)
    vertical = np.where(finite, vertical, np.nan)
    return signed.reshape(batch), vertical.reshape(batch)


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


def _stations(half_length: float) -> NDArray[np.float64]:
    n = max(math.ceil(2.0 * half_length / _SAMPLE_SPACING) + 1, 2)
    return np.linspace(-half_length, half_length, n)


def _triangle_samples(tri: NDArray[np.float64]) -> NDArray[np.float64]:
    """Samples on triangles (m, 3, 3): corners, points along edges and a grid inside.

    Edges are split into pieces of at most ``_SAMPLE_SPACING``; triangles wide enough to hold
    a disk of that diameter also get a square grid of that spacing in their plane.
    """
    s = _SAMPLE_SPACING
    out = [tri.reshape(-1, 3)]
    a, b = tri, tri[:, [1, 2, 0]]
    lengths = np.linalg.norm(b - a, axis=2)  # (m, 3)
    pieces = np.ceil(lengths / s).astype(np.int64)
    for k in np.unique(pieces[pieces > 1]):
        m = pieces == k
        t = (np.arange(1, k) / k)[None, :, None]
        out.append((a[m][:, None] + t * (b[m] - a[m])[:, None]).reshape(-1, 3))
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
    return np.concatenate(out, axis=0)


def _mesh_hull_points(model, mesh_id: int) -> NDArray[np.float64]:
    """Points on the convex hull MuJoCo collides with: its vertices and samples on its faces."""
    adr, num = int(model.mesh_vertadr[mesh_id]), int(model.mesh_vertnum[mesh_id])
    verts = np.asarray(model.mesh_vert[adr : adr + num], dtype=np.float64)
    gadr = int(model.mesh_graphadr[mesh_id])
    if gadr < 0:
        return verts
    # mesh_graph: numvert, numface, vert_edgeadr[numvert], vert_globalid[numvert],
    # edge_localid[numvert + 3 * numface], face_globalid[3 * numface]
    graph = model.mesh_graph
    nv, nf = int(graph[gadr]), int(graph[gadr + 1])
    hull = np.asarray(graph[gadr + 2 + nv : gadr + 2 + 2 * nv], dtype=np.int64)
    fadr = gadr + 2 + 3 * nv + 3 * nf
    faces = np.asarray(graph[fadr : fadr + 3 * nf], dtype=np.int64).reshape(nf, 3)
    if not (hull.size and hull.min() >= 0 and hull.max() < num):
        return verts
    if nf == 0 or faces.min() < 0 or faces.max() >= num:
        return verts[hull]
    pts = np.concatenate([verts[hull], _triangle_samples(verts[faces])], axis=0)
    _, first = np.unique(np.round(pts, 9), axis=0, return_index=True)
    return pts[np.sort(first)]


def geom_sample_points(model, gid: int) -> NDArray[np.float64]:
    """Points (n, 3) on collision geom ``gid`` in its own frame; empty for unsupported types.

    Meshes use the convex hull MuJoCo collides with (its vertices, plus samples on its faces so
    a narrow column under a flat sole is not missed).  Flat parts are sampled at most
    ``_SAMPLE_SPACING`` apart, curved parts so that the lowest sample is within
    ``_CURVE_TOLERANCE`` of the lowest surface point.  Between samples a tilted face can still
    dip below a column edge by up to its slope times ``_SAMPLE_SPACING``.
    """
    import mujoco

    gtype = int(model.geom_type[gid])
    size = np.asarray(model.geom_size[gid], dtype=np.float64)
    if gtype == int(mujoco.mjtGeom.mjGEOM_MESH):
        return _mesh_hull_points(model, int(model.geom_dataid[gid]))
    if gtype == int(mujoco.mjtGeom.mjGEOM_SPHERE):
        return _sphere_directions(float(size[0])) * size[0]
    if gtype == int(mujoco.mjtGeom.mjGEOM_ELLIPSOID):
        return _sphere_directions(float(size[:3].max())) * size[:3]
    if gtype == int(mujoco.mjtGeom.mjGEOM_BOX):
        axes = [_stations(float(s)) for s in size[:3]]
        grid = np.stack(np.meshgrid(*axes, indexing="ij"), axis=-1).reshape(-1, 3)
        return grid[np.any(np.isclose(np.abs(grid), size[:3]), axis=1)]
    if gtype in (int(mujoco.mjtGeom.mjGEOM_CAPSULE), int(mujoco.mjtGeom.mjGEOM_CYLINDER)):
        r, hl = float(size[0]), float(size[1])
        ang = np.linspace(0.0, 2.0 * np.pi, _arc_count(r), endpoint=False)
        ring = np.stack([np.cos(ang), np.sin(ang), np.zeros_like(ang)], axis=1)
        pts = [r * ring + np.array([0.0, 0.0, z]) for z in _stations(hl)]
        if gtype == int(mujoco.mjtGeom.mjGEOM_CAPSULE):
            dirs = _sphere_directions(r)
            pts.append(r * dirs[dirs[:, 2] >= 0.0] + np.array([0.0, 0.0, hl]))
            pts.append(r * dirs[dirs[:, 2] <= 0.0] + np.array([0.0, 0.0, -hl]))
        else:
            # Flat caps: concentric rings down to the axis.
            for rr in np.linspace(0.0, r, max(math.ceil(r / _SAMPLE_SPACING), 1) + 1)[:-1]:
                pts += [rr * ring + np.array([0.0, 0.0, z]) for z in (-hl, hl)]
        return np.concatenate(pts, axis=0)
    return np.zeros((0, 3), dtype=np.float64)


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
    """Column-terrain clearance of every foot collision point in every frame of ``joint_q``.

    Foot geoms are the collidable geoms on bodies whose name contains ``foot``, ``ankle`` or
    ``toe``.  ``joint_q`` rows are ``[root xyz, root quat xyzw, actuated DOFs]`` in MuJoCo joint
    order (as ``pack_joint_q_csv`` writes them).  See :func:`column_terrain_distance`.
    """
    import mujoco

    geoms: list[int] = []
    local: list[NDArray[np.float64]] = []
    for g in range(model.ngeom):
        if int(model.geom_contype[g]) == 0 and int(model.geom_conaffinity[g]) == 0:
            continue
        body = mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_BODY, int(model.geom_bodyid[g])) or ""
        if not any(tag in body.lower() for tag in FOOT_BODY_TAGS):
            continue
        pts = geom_sample_points(model, g)
        if len(pts):
            geoms.append(g)
            local.append(pts)
    jq = np.asarray(joint_q, dtype=np.float64)
    num_frames = int(jq.shape[0])
    signed = np.full(num_frames, np.nan)
    vertical = np.full(num_frames, np.nan)
    if not geoms or num_frames == 0:
        return FootTerrainClearance(signed, vertical)

    qadr = _actuated_qpos_addresses(model)
    counts = [len(p) for p in local]
    world = np.empty((min(chunk_frames, num_frames), sum(counts), 3), dtype=np.float64)
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
            for g, pts in zip(geoms, local, strict=True):
                rot = data.geom_xmat[g].reshape(3, 3)
                world[k, off : off + len(pts)] = data.geom_xpos[g] + pts @ rot.T
                off += len(pts)
        n = stop - start
        sd, vc = column_terrain_distance(
            world[:n],
            terrain,
            floor_z=floor_z,
            max_distance=max_distance,
        )
        signed[start:stop] = sd.min(axis=1)
        vertical[start:stop] = vc.min(axis=1)
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
