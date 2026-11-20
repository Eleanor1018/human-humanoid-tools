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

__all__ = [
    "ObjectConstraint",
    "ObjectSDF",
    "build_object_sdf",
    "object_distance_rows",
]

_LOG = logging.getLogger(__name__)

#: Nodes this close (m) to the surface get the exact mesh distance instead of the voxel one.
_EXACT_BAND = 0.03
_MAX_CACHED_SDFS = 8
#: Below this squared norm a gradient is treated as zero.
_TINY = 1e-12
#: Within this many voxels of the surface the sign comes from the mesh, not the voxels.
_SIGN_BAND = 3.0


@dataclass(frozen=True)
class ObjectSDF:
    """Signed distance field of one object in its (scaled) local frame.

    ``values[i, j, k]`` is the distance (m) from ``origin + (i, j, k) * dx`` to the object's
    surface, positive outside, negative inside.  Outside the grid, :func:`object_distance_rows`
    extends it by the distance to the grid.
    """

    values: NDArray[np.float32]  # (nx, ny, nz)
    origin: NDArray[np.float64]  # (3,) object-local position of node (0, 0, 0)
    dx: float

    def as_ref(self) -> dict[str, NDArray]:
        """The pytree handed to the solver: ``values``, ``origin``, ``dx``."""
        return {
            "values": np.asarray(self.values, dtype=np.float32),
            "origin": np.asarray(self.origin, dtype=np.float64),
            "dx": np.asarray(self.dx, dtype=np.float64),
        }

    def signed_distance(self, points: NDArray) -> NDArray[np.float64]:
        """Trilinear lookup at object-local ``points`` (..., 3), grid-extended outside (NumPy)."""
        d, _ = _lookup(self.as_ref(), np.asarray(points, dtype=np.float64).reshape(-1, 3), np)
        return np.asarray(d).reshape(np.shape(points)[:-1])


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


def build_object_sdf(
    obj,
    smpl_scale: float,
    *,
    dx: float = 0.01,
    pad: float = 0.08,
    voxel: float = 0.004,
) -> ObjectSDF:
    """Signed distance field of ``obj`` in its scaled local frame.

    With a loadable mesh, vertices are ``(raw - mean of raw) * obj.scale * smpl_scale`` (the
    placement of the viewer, scaled into the solver frame) and the mesh is merged
    (``process=True``).  The inside is the filled voxelisation at ``voxel`` pitch (the bundled
    meshes are not watertight); the magnitude is the Euclidean distance transform of that
    occupancy on every node, replaced by the exact distance to the mesh within 3 cm of the
    surface (there, the sign comes from the face normals when the mesh is a closed, consistently
    wound surface, else from the voxels).  The grid covers the mesh bounds plus ``pad``.  Without
    a mesh (empty ``mesh_path`` or a load failure) the field is the analytic box of half extents
    ``extents * scale * smpl_scale / 2``.  Results are cached in-process.
    """
    scale = float(obj.scale) * float(smpl_scale)
    path = str(obj.mesh_path or "")
    try:
        mtime = Path(path).stat().st_mtime_ns if path else 0
    except OSError:
        mtime = -1
    ext = tuple(float(x) for x in np.ravel(obj.extents))
    key = (path, mtime, ext, round(scale, 9), dx, pad, voxel)
    cached = _CACHE.get(key)
    if cached is not None:
        _CACHE.move_to_end(key)
        return cached

    mesh_data = _load_mesh(path) if mtime >= 0 else None
    if mesh_data is None:
        sdf = _build_box(np.asarray(ext) * scale / 2.0, dx, pad)
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
    return ObjectSDF(values=values, origin=origin, dx=float(dx))


def _build_mesh(mesh_data, scale: float, dx: float, pad: float, voxel: float) -> ObjectSDF:
    import trimesh
    from scipy.ndimage import binary_fill_holes, distance_transform_edt, map_coordinates

    raw, faces = mesh_data
    verts = (raw - raw.mean(axis=0)) * scale
    mesh = trimesh.Trimesh(vertices=verts, faces=faces, process=True)
    lo, hi = mesh.bounds
    origin, shape, axes = _grid_for(lo, hi, dx, pad)

    # Filled occupancy on the voxel grid of the voxelisation, padded by ``pad``.
    surface = mesh.voxelized(voxel)
    mat = np.asarray(surface.matrix, dtype=bool)
    margin = int(np.ceil(pad / voxel)) + 1
    occ = np.pad(mat, margin)
    vo = np.asarray(surface.translation, dtype=np.float64) - margin * voxel  # centre of voxel 0
    occ = binary_fill_holes(occ)
    outside = distance_transform_edt(~occ) * voxel - 0.5 * voxel
    inside = -(distance_transform_edt(occ) * voxel - 0.5 * voxel)
    field = np.where(occ, inside, outside)

    grid = np.stack(np.meshgrid(*axes, indexing="ij"), axis=-1).reshape(-1, 3)
    coords = ((grid - vo) / voxel).T
    approx = map_coordinates(field, coords, order=1, mode="nearest")
    values = approx.copy()

    near = np.abs(approx) < _EXACT_BAND + voxel
    if near.any():
        pts = grid[near]
        closest, dist, tri = trimesh.proximity.closest_point(mesh, pts)
        sign = np.where(approx[near] < 0.0, -1.0, 1.0)
        if mesh.is_watertight and mesh.is_winding_consistent:
            # The voxel sign is only reliable away from the surface; close to it, use the sign
            # of the angle-weighted pseudo-normal of the closest feature.
            close = np.abs(approx[near]) < _SIGN_BAND * voxel
            outward = 1.0 if mesh.volume >= 0.0 else -1.0
            side = _pseudo_normal_side(mesh, pts[close], closest[close], tri[close])
            sign[close] = np.where(side * outward < 0.0, -1.0, 1.0)
        exact = sign * dist
        values[near] = np.where(np.abs(approx[near]) < _EXACT_BAND, exact, approx[near])
    return ObjectSDF(
        values=values.reshape(tuple(shape)).astype(np.float32), origin=origin, dx=float(dx)
    )


def _pseudo_normal_side(mesh, points: NDArray, closest: NDArray, tri: NDArray) -> NDArray:
    """``(p - c) . n`` with ``n`` the pseudo-normal of the mesh feature holding closest point ``c``.

    The face normal inside a face, the sum of the two face normals on an edge and the
    angle-weighted vertex normal at a vertex (the normals under which the sign is exact for a
    closed, consistently wound surface).  ``tri`` is the closest face of each point.
    """
    import trimesh

    corners = mesh.triangles[tri]
    bary = trimesh.triangles.points_to_barycentric(corners, closest)
    edge_faces: dict[tuple[int, int], list[int]] = {}
    for faces, edge in zip(mesh.face_adjacency, mesh.face_adjacency_edges, strict=True):
        edge_faces[(int(min(edge)), int(max(edge)))] = [int(faces[0]), int(faces[1])]
    vertex_normals = mesh.vertex_normals
    eps = 1e-6
    out = np.empty(len(points))
    for i in range(len(points)):
        on = np.flatnonzero(bary[i] > eps)
        ids = mesh.faces[tri[i]]
        if len(on) == 1:
            n = vertex_normals[ids[on[0]]]
        elif len(on) == 2:
            key = (int(min(ids[on])), int(max(ids[on])))
            n = mesh.face_normals[edge_faces.get(key, [int(tri[i])])].sum(axis=0)
        else:
            n = mesh.face_normals[tri[i]]
        out[i] = float(np.dot(points[i] - closest[i], n))
    return out


# ---------------------------------------------------------------------------
# Lookup (JAX, also NumPy for the host-side reference)
# ---------------------------------------------------------------------------


def _lookup(sdf: dict, local, xp):
    """Distance and local gradient direction at object-local points ``local`` (n, 3).

    Trilinear interpolation inside the grid.  Outside, the point is clamped to the grid, the
    value there plus the distance from the clamped point is returned (so far points read far)
    and the direction is the clamped gradient.  A direction of (almost) zero length falls back
    to the point's own offset from the object origin, then +z.  Returns ``(d, n)`` with ``n``
    of unit length.
    """
    values = xp.asarray(sdf["values"], dtype=xp.float64)
    origin = xp.asarray(sdf["origin"], dtype=xp.float64)
    dx = xp.asarray(sdf["dx"], dtype=xp.float64)
    shape = values.shape
    top = xp.asarray([s - 1 for s in shape], dtype=xp.float64)
    f = (local - origin) / dx
    fc = xp.clip(f, 0.0, top)
    excess = (f - fc) * dx  # (n, 3) local offset from the clamped point
    e2 = xp.sum(excess**2, axis=-1)
    e = xp.sqrt(e2)
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
    grad = xp.stack([gx, gy, gz], axis=-1) / dx
    g2 = xp.sum(grad**2, axis=-1)[:, None]
    ok = g2 > _TINY
    n = xp.where(ok, grad / xp.sqrt(xp.where(ok, g2, 1.0)), 0.0)
    r2 = xp.sum(local**2, axis=-1)[:, None]
    okr = r2 > _TINY
    radial = xp.where(okr, local / xp.sqrt(xp.where(okr, r2, 1.0)), xp.asarray([0.0, 0.0, 1.0]))
    n = xp.where(ok, n, radial)
    return d0 + e, n


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
    """Keep collision spheres out of one moving rigid object.

    Each sphere contributes one barrier row ``h = d - r - margin`` with ``d`` from
    :func:`object_distance_rows`: ``-(n . J_sphere) v <= gain * h``, and the ``max_rows``
    lowest-barrier rows are kept.  A sphere already inside is pushed out along the field's
    gradient.  The SDF is read every step from ``ref[f"object_sdf_{index}"]`` and the pose from
    ``ref["object_pos"][index]`` (3,) and ``ref["object_rot"][index]`` (3, 3), so one compiled
    solver serves any pose track and any field of the same grid shape.  The row is a half-space
    through the closest surface point: exact for a convex object under translation, a local
    approximation for concave ones and for rotating limbs.  Object motion between frames is
    not predicted: a sphere may be reached by an object moving towards it faster than the gain
    pushes it away, so keep ``margin`` above the per-frame object travel for fast props.

    Args:
        robot: frax robot with collision data
        index: object index ``k``
        sphere_idxs: robot collision spheres to check (default all)
        max_rows: keep only this many lowest-barrier rows per step
        gain: CBF gain (1/s)
        penalty: relaxation penalty
        margin: clearance kept from the object
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
    ):
        assert robot.has_collision_data
        super().__init__(robot, gain, penalty)
        self.index = int(index)
        self.margin = margin
        self.sphere_idxs = (
            np.arange(len(self.radii)) if sphere_idxs is None else np.asarray(sphere_idxs)
        )
        self._set_num_rows(len(self.sphere_idxs), max_rows)

    def rows(self, q, ref):
        robot = self.robot
        joint_tfs = robot.joint_to_world_transforms(q)
        pos = robot._link_collision_positions(joint_tfs)[self.sphere_idxs]
        radii = self.radii[self.sphere_idxs]
        k = self.index
        d, normals = object_distance_rows(
            ref[f"object_sdf_{k}"], pos, ref["object_pos"][k], ref["object_rot"][k]
        )
        h = d - radii - self.margin
        n_rows = len(self.sphere_idxs)
        keep = jnp.arange(n_rows) if self.max_rows is None else self._keep(h)
        spheres = jnp.asarray(self.sphere_idxs)[keep]
        Jv, Jw = robot._joint_jacobians(joint_tfs)
        J = robot._link_collision_jacobians(joint_tfs, Jv, Jw, spheres)  # (k, 3, nv)
        dh = jnp.einsum("ki,kij->kj", normals[keep], J)
        return -dh, self.gain * h[keep]
