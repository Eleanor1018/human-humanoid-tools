"""Rigid-object signed distance fields and the object non-penetration constraint for FRAX.

An interaction object (a carried box, a chair) is represented by a signed distance field
(:class:`ObjectSDF`) sampled on a regular grid in the object's own scaled frame.  The grid is
built once per clip (:func:`build_object_sdf`); the solver then reads it every step together
with the object's pose of that frame (:func:`object_distance_rows`) and
:class:`ObjectConstraint` keeps the robot's collision spheres out of it, the same way
:class:`~hhtools.retarget.frax_backend.terrain.TerrainConstraint` keeps them out of the terrain.
"""

from __future__ import annotations

import logging
from collections import OrderedDict
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from numpy.typing import NDArray

from hhtools.retarget.frax_backend._jax_env import import_frax

frax = import_frax()

import jax  # noqa: E402  (configured by import_frax)
import jax.numpy as jnp  # noqa: E402
from frax.ik import DEFAULT_PENALTY  # noqa: E402
from frax.ik.constraints import _SphereConstraint  # noqa: E402
from frax.utils.spatial_utils import offset_transforms_and_jacobians  # noqa: E402

__all__ = [
    "ObjectConstraint",
    "ObjectSDF",
    "build_object_sdf",
    "object_grid_pad",
    "object_distance_rows",
]

_LOG = logging.getLogger(__name__)

#: Nodes this close (m) to the surface get the exact mesh distance instead of the voxel one.
_EXACT_BAND = 0.03
_MAX_CACHED_SDFS = 8
#: Below this squared norm a vector is treated as zero.
_TINY = 1e-12
#: Below this squared norm the trilinear gradient (1/m) is flat: the cell has no usable exit
#: direction (a medial plane of a thin object) and one-sided differences decide.
_FLAT_GRAD2 = 1e-6
#: Smallest grid padding (m) around an object's bounds.
_MIN_PAD = 0.08
#: Extra clearance (m) of the grid beyond the largest sphere reach.
_PAD_SLACK = 0.03


def object_grid_pad(max_radius: float, margin: float) -> float:
    """Grid padding (m): the trilinear field is used for every centre that can touch the object.

    A sphere of radius ``max_radius`` keeping ``margin`` from the object is in contact only
    while its centre is closer than ``max_radius + margin`` to the surface (plus the slack of the
    barrier).  With this padding such a centre is inside the grid.  Outside it the field is the
    distance to the object's bounding box, a conservative lower bound; the row it gives is
    retained (it bounds the approach velocity), it is not inactive.
    """
    return max(_MIN_PAD, float(max_radius) + float(margin) + _PAD_SLACK)


@dataclass(frozen=True)
class ObjectSDF:
    """Signed distance field of one object in its (scaled) local frame.

    ``values[i, j, k]`` is the distance (m) from ``origin + (i, j, k) * dx`` to the object's
    surface, positive outside, negative inside.  Outside the grid, :func:`object_distance_rows`
    returns the distance to the object's local bounding box ``[lo, hi]`` (a lower bound of the
    distance to the object) with that distance's unit gradient: a supporting plane of a convex
    set, so a row built from it is conservative.  The pipeline pads the grid
    (:func:`object_grid_pad`) so the accurate field covers every centre in contact.
    """

    values: NDArray[np.float32]  # (nx, ny, nz)
    origin: NDArray[np.float64]  # (3,) object-local position of node (0, 0, 0)
    dx: float
    lo: NDArray[np.float64] | None = None  # (3,) lower corner of the object's local bounding box
    hi: NDArray[np.float64] | None = None  # (3,) upper corner (both default to the grid's)

    def __post_init__(self) -> None:
        extent = self.origin + (np.asarray(self.values.shape) - 1) * self.dx
        if self.lo is None:
            object.__setattr__(self, "lo", np.asarray(self.origin, dtype=np.float64))
        if self.hi is None:
            object.__setattr__(self, "hi", np.asarray(extent, dtype=np.float64))

    def as_ref(self) -> dict[str, NDArray]:
        """The pytree handed to the solver: ``values``, ``origin``, ``dx``, ``lo``, ``hi``."""
        return {
            "values": np.asarray(self.values, dtype=np.float32),
            "origin": np.asarray(self.origin, dtype=np.float64),
            "dx": np.asarray(self.dx, dtype=np.float64),
            "lo": np.asarray(self.lo, dtype=np.float64),
            "hi": np.asarray(self.hi, dtype=np.float64),
        }

    def signed_distance(self, points: NDArray) -> NDArray[np.float64]:
        """Lookup at object-local ``points`` (..., 3): trilinear inside, box distance outside."""
        d, _ = _lookup(self.as_ref(), np.asarray(points, dtype=np.float64).reshape(-1, 3), np)
        return np.asarray(d).reshape(np.shape(points)[:-1])

    def distance_and_normal(
        self, points: NDArray
    ) -> tuple[NDArray[np.float64], NDArray[np.float64]]:
        """Lookup at object-local ``points`` (..., 3): distance and the unit outward gradient."""
        shape = np.shape(points)[:-1]
        d, n = _lookup(self.as_ref(), np.asarray(points, dtype=np.float64).reshape(-1, 3), np)
        return np.asarray(d).reshape(shape), np.asarray(n).reshape(*shape, 3)


def _box_sdf(p: NDArray, half: NDArray) -> NDArray:
    """Exact signed distance (positive outside) of points ``p`` (n, 3) to a centred box."""
    q = np.abs(p) - half
    outside = np.linalg.norm(np.maximum(q, 0.0), axis=-1)
    inside = np.minimum(q.max(axis=-1), 0.0)
    return outside + inside


def _grid_for(lo: NDArray, hi: NDArray, dx: float, pad: float):
    origin = np.floor((lo - pad) / dx) * dx
    shape = np.ceil((hi + pad - origin) / dx).astype(int) + 1
    axes = [origin[a] + dx * np.arange(shape[a]) for a in range(3)]
    return origin, shape, axes


_CACHE: OrderedDict[tuple, ObjectSDF] = OrderedDict()


def _load_mesh(path: str):
    """The raw mesh at ``path`` or ``None`` (missing, unreadable or empty)."""
    if not path:
        return None
    try:
        import trimesh

        loaded = trimesh.load(path, force="mesh", process=False)
        verts = np.asarray(getattr(loaded, "vertices", np.zeros((0, 3))), dtype=np.float64)
        faces = np.asarray(getattr(loaded, "faces", np.zeros((0, 3), dtype=np.int64)))
        if verts.size == 0 or faces.size == 0:
            return None
        return verts, faces.astype(np.int64)
    except Exception:
        _LOG.warning("object mesh %s could not be loaded; using its box extents", path)
        return None


def _file_identity(path: str) -> tuple:
    """Stat fields that change when the file at ``path`` is replaced (even keeping its mtime)."""
    if not path:
        return (0,)
    try:
        st = Path(path).stat()
    except OSError:
        return (-1,)
    return (st.st_mtime_ns, st.st_ino, st.st_size, st.st_ctime_ns)


def build_object_sdf(
    obj,
    smpl_scale: float,
    *,
    dx: float = 0.01,
    pad: float = _MIN_PAD,
    voxel: float = 0.004,
) -> ObjectSDF:
    """Signed distance field of ``obj`` in its scaled local frame.

    With a loadable mesh, vertices are ``(raw - mean of raw) * obj.scale * smpl_scale`` (the
    placement of the viewer, scaled into the solver frame) and the mesh is merged
    (``process=True``).  The magnitude at every node is the distance to the *unfilled* surface
    shell (voxel distance transform at ``voxel`` pitch), replaced within 3 cm of the surface by
    the exact triangle distance.  If the processed mesh is watertight the sign comes from
    ray-parity containment per connected component, weighted by nesting (a component inside an
    odd number of others is a cavity, -1; else a solid, +1) and summed, so cavities, nested
    cavities, overlapping closed parts (a union) and disjoint parts of any winding are right;
    otherwise (the bundled chairs and the like) from the filled voxelisation.  The grid covers
    the mesh bounds plus ``pad`` (see :func:`object_grid_pad`); outside it the lookup returns the
    distance to the bounding box (see :class:`ObjectSDF`).
    Without a mesh (empty ``mesh_path`` or a load failure) the field is the analytic box of half
    extents ``extents * smpl_scale / 2``: ``SceneObject.extents`` are metres, ``obj.scale``
    applies to raw mesh vertices only.  Results are cached in-process, keyed on the mesh file's
    identity (mtime, inode, size, ctime).
    """
    scale = float(obj.scale) * float(smpl_scale)
    path = str(obj.mesh_path or "")
    identity = _file_identity(path)
    ext = tuple(float(x) for x in np.ravel(obj.extents))
    key = (path, identity, ext, round(scale, 9), round(float(smpl_scale), 9), dx, pad, voxel)
    cached = _CACHE.get(key)
    if cached is not None:
        _CACHE.move_to_end(key)
        return cached

    mesh_data = _load_mesh(path) if identity != (-1,) else None
    if mesh_data is None:
        sdf = _build_box(np.asarray(ext) * float(smpl_scale) / 2.0, dx, pad)
    else:
        sdf = _build_mesh(mesh_data, scale, dx, pad, voxel)
    _CACHE[key] = sdf
    while len(_CACHE) > _MAX_CACHED_SDFS:
        _CACHE.popitem(last=False)
    return sdf


def _build_box(half: NDArray, dx: float, pad: float) -> ObjectSDF:
    origin, shape, axes = _grid_for(-half, half, dx, pad)
    pts = np.stack(np.meshgrid(*axes, indexing="ij"), axis=-1).reshape(-1, 3)
    values = _box_sdf(pts, half).reshape(tuple(shape)).astype(np.float32)
    return ObjectSDF(values=values, origin=origin, dx=float(dx), lo=-half, hi=half)


def _component_weights(parts) -> list[int]:
    """``+1`` for every solid component, ``-1`` for a cavity (nested in an odd number of others).

    A component is nested in another only if its bounding box and (a sample of) all of its
    vertices lie inside the other; overlapping parts are not nested in each other.
    """
    weights = []
    for i, part in enumerate(parts):
        verts = part.vertices[:: max(1, len(part.vertices) // 2000)]
        depth = 0
        for j, other in enumerate(parts):
            if j == i or not _in_bounds(part.bounds, other.bounds).all():
                continue
            depth += int(bool(other.contains(verts).all()))
        weights.append(1 if depth % 2 == 0 else -1)
    return weights


def _in_bounds(points: NDArray, bounds: NDArray) -> NDArray:
    eps = 1e-9
    return ((points >= bounds[0] - eps) & (points <= bounds[1] + eps)).all(axis=-1)


def _solid_mask(mesh, pts: NDArray, chunk: int = 20000) -> NDArray:
    """Whether each of ``pts`` is inside the solid of a watertight ``mesh``.

    Per connected component, weighted by nesting (a cavity counts -1, a solid +1), summed over
    the components that contain the point: nested cavities, overlapping closed parts (a union)
    and disjoint parts of any winding all come out right.
    """
    parts = mesh.split(only_watertight=False)
    weights = _component_weights(parts)
    total = np.zeros(len(pts), dtype=np.int64)
    for part, weight in zip(parts, weights, strict=True):
        idx = np.flatnonzero(_in_bounds(pts, part.bounds))
        for start in range(0, len(idx), chunk):
            sel = idx[start : start + chunk]
            total[sel] += weight * part.contains(pts[sel]).astype(np.int64)
    return total > 0


def _build_mesh(mesh_data, scale: float, dx: float, pad: float, voxel: float) -> ObjectSDF:
    import trimesh
    from scipy.ndimage import binary_fill_holes, distance_transform_edt, map_coordinates

    raw, faces = mesh_data
    verts = (raw - raw.mean(axis=0)) * scale
    mesh = trimesh.Trimesh(vertices=verts, faces=faces, process=True)
    lo, hi = mesh.bounds
    origin, shape, axes = _grid_for(lo, hi, dx, pad)

    # Surface voxels on the voxel grid of the voxelisation, padded by ``pad``.
    surface = mesh.voxelized(voxel)
    mat = np.asarray(surface.matrix, dtype=bool)
    margin = int(np.ceil(pad / voxel)) + 1
    shell = np.pad(mat, margin)
    vo = np.asarray(surface.translation, dtype=np.float64) - margin * voxel  # centre of voxel 0
    occ = binary_fill_holes(shell)
    filled = np.where(
        occ,
        -(distance_transform_edt(occ) * voxel - 0.5 * voxel),
        distance_transform_edt(~occ) * voxel - 0.5 * voxel,
    )
    to_surface = distance_transform_edt(~shell) * voxel

    grid = np.stack(np.meshgrid(*axes, indexing="ij"), axis=-1).reshape(-1, 3)
    coords = ((grid - vo) / voxel).T
    filled_at = map_coordinates(filled, coords, order=1, mode="nearest")
    surface_dist = map_coordinates(to_surface, coords, order=1, mode="nearest")
    # Magnitude: distance to the (unfilled) surface, so a cavity wall counts like any other.
    magnitude = surface_dist.copy()

    if mesh.is_watertight:
        inside = _solid_mask(mesh, grid)
    else:
        inside = filled_at < 0.0
    near = surface_dist < _EXACT_BAND + 2.0 * voxel
    if near.any():
        _, dist, _ = trimesh.proximity.closest_point(mesh, grid[near])
        # The voxel distance to the surface is within a voxel of the true one.
        exact = dist < _EXACT_BAND
        magnitude[near] = np.where(exact, dist, magnitude[near])
    values = np.where(inside, -magnitude, magnitude)
    return ObjectSDF(
        values=values.reshape(tuple(shape)).astype(np.float32),
        origin=origin,
        dx=float(dx),
        lo=np.asarray(lo, dtype=np.float64),
        hi=np.asarray(hi, dtype=np.float64),
    )


# ---------------------------------------------------------------------------
# Lookup (JAX, also NumPy for the host-side reference)
# ---------------------------------------------------------------------------


def _trilinear(values, fc, top, xp):
    """Trilinear value and raw (per-cell) gradient at clamped fractional indices ``fc`` (n, 3)."""
    base = xp.minimum(xp.floor(fc), top - 1.0)
    t = fc - base
    i0 = base.astype(xp.int32)

    def corner(di, dj, dk):
        return values[i0[:, 0] + di, i0[:, 1] + dj, i0[:, 2] + dk]

    c000, c001, c010, c011 = corner(0, 0, 0), corner(0, 0, 1), corner(0, 1, 0), corner(0, 1, 1)
    c100, c101, c110, c111 = corner(1, 0, 0), corner(1, 0, 1), corner(1, 1, 0), corner(1, 1, 1)
    tx, ty, tz = t[:, 0], t[:, 1], t[:, 2]
    c00 = c000 * (1 - tx) + c100 * tx
    c01 = c001 * (1 - tx) + c101 * tx
    c10 = c010 * (1 - tx) + c110 * tx
    c11 = c011 * (1 - tx) + c111 * tx
    c0 = c00 * (1 - ty) + c10 * ty
    c1 = c01 * (1 - ty) + c11 * ty
    d0 = c0 * (1 - tz) + c1 * tz
    gz = c1 - c0
    gy = (c10 * (1 - tz) + c11 * tz) - (c00 * (1 - tz) + c01 * tz)
    gx = (
        (c100 * (1 - ty) + c110 * ty) * (1 - tz)
        + (c101 * (1 - ty) + c111 * ty) * tz
        - (c000 * (1 - ty) + c010 * ty) * (1 - tz)
        - (c001 * (1 - ty) + c011 * ty) * tz
    )
    return d0, xp.stack([gx, gy, gz], axis=-1)


def _lookup(sdf: dict, local, xp):
    """Distance and local gradient direction at object-local points ``local`` (n, 3).

    Inside the grid: trilinear interpolation.  Where the trilinear gradient is (almost) flat
    (the medial plane of a thin object, which an inside sphere may sit on) the direction is the
    grid axis, ``+-x, +-y, +-z``, along which a one-cell step raises the field most; if the
    field is flat in all six, the point's own offset from the object origin, then +z.  Outside
    the grid: the distance to the object's bounding box ``[lo, hi]`` and that distance's unit
    gradient (the object lies inside the box, so this is a lower bound and a supporting plane;
    the row stays conservative however far a step goes).  Returns ``(d, n)`` with ``n`` of unit
    length.
    """
    values = xp.asarray(sdf["values"], dtype=xp.float64)
    origin = xp.asarray(sdf["origin"], dtype=xp.float64)
    dx = xp.asarray(sdf["dx"], dtype=xp.float64)
    shape = values.shape
    top = xp.asarray([s - 1 for s in shape], dtype=xp.float64)
    f = (local - origin) / dx
    fc = xp.clip(f, 0.0, top)
    outside = xp.any((f < 0.0) | (f > top), axis=-1)
    lo = xp.asarray(sdf["lo"], dtype=xp.float64)
    hi = xp.asarray(sdf["hi"], dtype=xp.float64)
    off = local - xp.clip(local, lo, hi)  # (n, 3) offset from the nearest box point
    box2 = xp.sum(off**2, axis=-1)[:, None]
    okb = box2 > _TINY
    box_n = xp.where(okb, off / xp.sqrt(xp.where(okb, box2, 1.0)), 0.0)
    box_d = xp.sqrt(box2[:, 0])
    n_pts = fc.shape[0]

    # The value at the point and at one-cell steps along +-x, +-y, +-z (clamped to the grid).
    steps = xp.concatenate([xp.zeros((1, 3)), xp.eye(3), -xp.eye(3)], axis=0).astype(
        xp.float64
    )  # (7, 3)
    probe = xp.clip(fc[None] + steps[:, None, :], 0.0, top).reshape(-1, 3)
    d_all, g_all = _trilinear(values, probe, top, xp)
    d_all = d_all.reshape(7, n_pts)
    d0 = d_all[0]
    grad = g_all.reshape(7, n_pts, 3)[0] / dx
    g2 = xp.sum(grad**2, axis=-1)[:, None]
    ok = g2 > _FLAT_GRAD2
    n = xp.where(ok, grad / xp.sqrt(xp.where(ok, g2, 1.0)), 0.0)

    rise = d_all[1:] - d0[None]  # (6, n): +x, +y, +z, -x, -y, -z
    best = xp.argmax(rise, axis=0)
    axis_dirs = xp.concatenate([xp.eye(3), -xp.eye(3)], axis=0).astype(xp.float64)  # (6, 3)
    step_dir = axis_dirs[best]
    has_rise = (xp.max(rise, axis=0) > 1e-9)[:, None]

    r2 = xp.sum(local**2, axis=-1)[:, None]
    okr = r2 > _TINY
    radial = xp.where(okr, local / xp.sqrt(xp.where(okr, r2, 1.0)), xp.asarray([0.0, 0.0, 1.0]))
    n = xp.where(ok, n, xp.where(has_rise, step_dir, radial))
    far = outside[:, None] & okb
    return xp.where(outside, box_d, d0), xp.where(far, box_n, n)


def object_distance_rows(sdf: dict, centers, pos, rot):
    """Distance ``d`` (S,) from sphere ``centers`` (S, 3) to one posed object, and the unit
    world normals ``n`` (S, 3) pointing out of it.

    ``sdf``: :meth:`ObjectSDF.as_ref`; the object's frame sits at world ``pos`` (3,) with
    rotation ``rot`` (3, 3): ``world = pos + rot @ local``.  Positive outside.
    """
    centers = jnp.asarray(centers, dtype=jnp.float64)
    pos = jnp.asarray(pos, dtype=jnp.float64)
    rot = jnp.asarray(rot, dtype=jnp.float64)
    local = (centers - pos) @ rot  # rot.T @ (c - pos), row-wise
    d, n_local = _lookup(sdf, local, jnp)
    return d, n_local @ rot.T  # rot @ n, row-wise


@jax.tree_util.register_static
class ObjectConstraint(_SphereConstraint):
    """Keep collision spheres and surface points out of one moving rigid object.

    Each sphere contributes one barrier row ``h = d - r - margin`` with ``d`` from
    :func:`object_distance_rows`: ``-(n . J_sphere) v <= gain * h``.  Optional *points* (frames
    rigidly attached to joint frames, e.g. samples of a hand's collision mesh) contribute one
    row each, ``h = d - point_margin``, with the Jacobian of the point.  The ``max_rows``
    lowest-barrier rows over spheres and points together are kept.  A sphere or point already
    inside is pushed out along the field's gradient.  The SDF is read every step from
    ``ref[f"object_sdf_{index}"]`` and the pose from ``ref["object_pos"][index]`` (3,) and
    ``ref["object_rot"][index]`` (3, 3), so one compiled solver serves any pose track and any
    field of the same grid shape.  The row is a half-space through the closest surface point:
    exact for a convex object under translation, a local approximation for concave ones and
    for rotating limbs.  Object motion between frames is not predicted: a sphere may be reached
    by an object moving towards it faster than the gain pushes it away, so keep ``margin``
    above the per-frame object travel for fast props.

    Args:
        robot: frax robot with collision data
        index: object index ``k``
        sphere_idxs: robot collision spheres to check (default all)
        max_rows: keep only this many lowest-barrier rows per step
        gain: CBF gain (1/s)
        penalty: relaxation penalty
        margin: clearance kept from the object
        sphere_margins: per-sphere clearance (one per checked sphere), instead of ``margin``
        point_joints: frax joint index of every point (default none)
        point_offsets: ``(n, 4, 4)`` frame of every point in its joint's frame
        point_margin: clearance kept between a point and the object
    """

    def __init__(
        self,
        robot,
        index: int = 0,
        sphere_idxs=None,
        max_rows: int | None = None,
        gain: float = 10.0,
        penalty: float = DEFAULT_PENALTY,
        margin: float = 0.0,
        sphere_margins=None,
        point_joints=None,
        point_offsets=None,
        point_margin: float = 0.0,
    ):
        assert robot.has_collision_data
        super().__init__(robot, gain, penalty)
        self.index = int(index)
        self.margin = margin
        self.sphere_idxs = (
            np.arange(len(self.radii)) if sphere_idxs is None else np.asarray(sphere_idxs)
        )
        n_s = len(self.sphere_idxs)
        self.sphere_margins = (
            None
            if sphere_margins is None
            else np.broadcast_to(np.asarray(sphere_margins, dtype=float), (n_s,)).copy()
        )
        self.point_joints = np.asarray([] if point_joints is None else point_joints, dtype=int)
        n_p = len(self.point_joints)
        self.point_offsets = (
            np.zeros((0, 4, 4))
            if n_p == 0
            else np.broadcast_to(np.asarray(point_offsets, dtype=float), (n_p, 4, 4)).copy()
        )
        self.point_margin = float(point_margin)
        self._set_num_rows(n_s + n_p, max_rows)

    def rows(self, q, ref):
        robot = self.robot
        joint_tfs = robot.joint_to_world_transforms(q)
        pos = robot._link_collision_positions(joint_tfs)[self.sphere_idxs]
        radii = self.radii[self.sphere_idxs]
        k = self.index
        n_s, n_p = len(self.sphere_idxs), len(self.point_joints)
        sphere_margin = self.margin if self.sphere_margins is None else self.sphere_margins
        if n_p == 0:
            d, normals = object_distance_rows(
                ref[f"object_sdf_{k}"], pos, ref["object_pos"][k], ref["object_rot"][k]
            )
            h = d - radii - sphere_margin
            keep = jnp.arange(n_s) if self.max_rows is None else self._keep(h)
            spheres = jnp.asarray(self.sphere_idxs)[keep]
            Jv, Jw = robot._joint_jacobians(joint_tfs)
            J = robot._link_collision_jacobians(joint_tfs, Jv, Jw, spheres)  # (k, 3, nv)
            dh = jnp.einsum("ki,kij->kj", normals[keep], J)
            return -dh, self.gain * h[keep]

        Jv, Jw = robot._joint_jacobians(joint_tfs)
        pj = self.point_joints
        tfs_p, Jv_p, _ = offset_transforms_and_jacobians(
            joint_tfs[pj], Jv[pj], Jw[pj], self.point_offsets
        )  # (n_p, 4, 4), (n_p, 3, nv)
        centres = jnp.concatenate([pos, tfs_p[:, :3, 3]], axis=0)
        d, normals = object_distance_rows(
            ref[f"object_sdf_{k}"], centres, ref["object_pos"][k], ref["object_rot"][k]
        )
        h = jnp.concatenate([d[:n_s] - radii - sphere_margin, d[n_s:] - self.point_margin])
        keep = jnp.arange(n_s + n_p) if self.max_rows is None else self._keep(h)
        is_sphere = keep < n_s
        spheres = jnp.asarray(self.sphere_idxs)[jnp.minimum(keep, n_s - 1)]
        J_s = robot._link_collision_jacobians(joint_tfs, Jv, Jw, spheres)  # (k, 3, nv)
        J_p = Jv_p[jnp.clip(keep - n_s, 0, n_p - 1)]  # (k, 3, nv)
        J = jnp.where(is_sphere[:, None, None], J_s, J_p)
        dh = jnp.einsum("ki,kij->kj", normals[keep], J)
        return -dh, self.gain * h[keep]
