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
#: Largest spacing (m) between the sample points placed along a primitive geom.
_SAMPLE_SPACING = 0.02
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
    * ``vertical_clearance``: height of the point above the top of the column under its own XY
      (``floor_z`` outside the grid), i.e. how far it can move straight down before it meets
      the terrain.  Negative inside the terrain; same sign as ``signed_distance``.
    """
    pts = np.asarray(points, dtype=np.float64)
    batch = pts.shape[:-1]
    pts = pts.reshape(-1, 3)
    floor_z = float(floor_z)
    dx = float(terrain.dx)
    reach = max(float(max_distance), 0.0)
    w = max(int(math.ceil(reach / dx)), 1)
    # Floor columns around the grid so the search never leaves the array and points near the
    # border can step out sideways onto the floor.
    hf = np.asarray(terrain.hf, dtype=np.float64)
    heights = np.pad(
        np.maximum(np.where(np.isfinite(hf), hf, floor_z), floor_z), w + 1, constant_values=floor_z
    )
    origin = np.asarray(terrain.min_point, dtype=np.float64).reshape(2) - (w + 1) * dx
    shape = np.asarray(heights.shape)

    f = (pts[:, :2] - origin) / dx
    on_grid = np.all((f >= -0.5) & (f <= shape - 0.5), axis=1)
    idx = np.clip(np.round(f), 0, shape - 1).astype(np.int64)
    top = np.where(on_grid, heights[idx[:, 0], idx[:, 1]], floor_z)
    z = pts[:, 2]
    vertical = z - top

    half = 0.5 * dx
    d_out = z - floor_z  # outside: distance to the nearest column, or to the floor plane
    d_in = -vertical  # inside: shortest way out, straight up or over the top of a nearby column
    for di in range(-w, w + 1):
        ii = np.clip(idx[:, 0] + di, 0, shape[0] - 1)
        lx = np.maximum(np.abs(pts[:, 0] - (origin[0] + ii * dx)) - half, 0.0)
        for dj in range(-w, w + 1):
            jj = np.clip(idx[:, 1] + dj, 0, shape[1] - 1)
            ly = np.maximum(np.abs(pts[:, 1] - (origin[1] + jj * dx)) - half, 0.0)
            rho = np.hypot(lx, ly)  # horizontal gap to this column's footprint
            s = z - heights[ii, jj]  # height above this column's top
            # Distance to the column's solid, and to the free space above its top.
            d_out = np.minimum(d_out, np.hypot(rho, np.maximum(s, 0.0)))
            d_in = np.minimum(d_in, np.hypot(rho, np.maximum(-s, 0.0)))
    signed = np.where(vertical < 0.0, -d_in, d_out)
    signed = np.clip(signed, -reach, reach)
    return signed.reshape(batch), vertical.reshape(batch)


@dataclass(frozen=True)
class FootTerrainClearance:
    """Per-frame minima over all foot collision points (NaN where a frame has none)."""

    signed_distance: NDArray[np.float64]  # (F,)
    vertical_clearance: NDArray[np.float64]  # (F,)

    @property
    def min_signed_distance(self) -> float:
        d = self.signed_distance[np.isfinite(self.signed_distance)]
        return float(d.min()) if d.size else float("nan")

    @property
    def min_vertical_clearance(self) -> float:
        d = self.vertical_clearance[np.isfinite(self.vertical_clearance)]
        return float(d.min()) if d.size else float("nan")


def _unit_directions() -> NDArray[np.float64]:
    """The 26 directions to the faces, edges and corners of a cube, normalised."""
    g = np.array(
        [
            (a, b, c)
            for a in (-1, 0, 1)
            for b in (-1, 0, 1)
            for c in (-1, 0, 1)
            if (a, b, c) != (0, 0, 0)
        ],
        dtype=np.float64,
    )
    return g / np.linalg.norm(g, axis=1, keepdims=True)


def _stations(half_length: float) -> NDArray[np.float64]:
    n = max(int(math.ceil(2.0 * half_length / _SAMPLE_SPACING)) + 1, 2)
    return np.linspace(-half_length, half_length, n)


def geom_sample_points(model, gid: int) -> NDArray[np.float64]:
    """Points (n, 3) on collision geom ``gid`` in its own frame; empty for unsupported types.

    Meshes use the vertices of the convex hull MuJoCo collides with.  Primitives are sampled
    on their surface with at most ``_SAMPLE_SPACING`` between points along an edge or axis.
    """
    import mujoco

    gtype = int(model.geom_type[gid])
    size = np.asarray(model.geom_size[gid], dtype=np.float64)
    if gtype == int(mujoco.mjtGeom.mjGEOM_MESH):
        mid = int(model.geom_dataid[gid])
        adr, num = int(model.mesh_vertadr[mid]), int(model.mesh_vertnum[mid])
        verts = np.asarray(model.mesh_vert[adr : adr + num], dtype=np.float64)
        gadr = int(model.mesh_graphadr[mid])
        if gadr >= 0:
            # mesh_graph: numvert, numface, vert_edgeadr[numvert], vert_globalid[numvert], ...
            nv = int(model.mesh_graph[gadr])
            hull = np.asarray(model.mesh_graph[gadr + 2 + nv : gadr + 2 + 2 * nv], dtype=np.int64)
            if hull.size and hull.min() >= 0 and hull.max() < num:
                verts = verts[hull]
        return verts
    dirs = _unit_directions()
    if gtype == int(mujoco.mjtGeom.mjGEOM_SPHERE):
        return dirs * size[0]
    if gtype == int(mujoco.mjtGeom.mjGEOM_ELLIPSOID):
        return dirs * size[:3]
    if gtype == int(mujoco.mjtGeom.mjGEOM_BOX):
        axes = [_stations(float(s)) for s in size[:3]]
        grid = np.stack(np.meshgrid(*axes, indexing="ij"), axis=-1).reshape(-1, 3)
        on_surface = np.any(np.isclose(np.abs(grid), size[:3]), axis=1)
        return grid[on_surface]
    if gtype in (int(mujoco.mjtGeom.mjGEOM_CAPSULE), int(mujoco.mjtGeom.mjGEOM_CYLINDER)):
        r, hl = float(size[0]), float(size[1])
        ang = np.linspace(0.0, 2.0 * np.pi, 8, endpoint=False)
        ring = np.stack([r * np.cos(ang), r * np.sin(ang), np.zeros_like(ang)], axis=1)
        pts = [ring + np.array([0.0, 0.0, z]) for z in _stations(hl)]
        if gtype == int(mujoco.mjtGeom.mjGEOM_CAPSULE):
            pts += [dirs * r + np.array([0.0, 0.0, z]) for z in (-hl, hl)]
        else:
            pts.append(np.array([[0.0, 0.0, -hl], [0.0, 0.0, hl]]))
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
    if min_signed_distance <= _SNAP_TOLERANCE:
        return 0.0
    return float(min_vertical_clearance)
