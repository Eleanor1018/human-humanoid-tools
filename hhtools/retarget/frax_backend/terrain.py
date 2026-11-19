"""Column terrain and foot-sticking constraints for the FRAX solver.

Provides a padded, shape-bucketed heightfield container (:class:`TerrainGrid`) read as square
columns, a jit-friendly local signed distance to it (:func:`column_distance_rows`), the
:class:`TerrainConstraint` built on that distance (collision spheres stay out of the terrain,
generalizing frax's ``FloorConstraint``) and :class:`FootStickConstraint` (planted points may
not slide horizontally).
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from numpy.typing import NDArray

from hhtools.retarget.frax_backend._jax_env import import_frax

frax = import_frax()

import jax  # noqa: E402  (configured by import_frax)
import jax.numpy as jnp  # noqa: E402
from frax.ik import DEFAULT_PENALTY, InequalityConstraint  # noqa: E402
from frax.ik.constraints import _SphereConstraint  # noqa: E402
from frax.utils.spatial_utils import offset_transforms_and_jacobians  # noqa: E402
from jax import Array  # noqa: E402

__all__ = [
    "FootStickConstraint",
    "TerrainConstraint",
    "TerrainGrid",
    "build_terrain_grid",
    "column_distance_rows",
]

#: Distance reported by an inactive (wall) row; large enough to never be among the kept rows.
_INACTIVE = 1e3
#: Stand-in for "no candidate" inside ``min``/``argmin`` (finite, so nothing turns into NaN).
_FAR = 1e30
#: Below this distance a direction is undefined and the plane normal is used.
_EPS = 1e-9


@dataclass(frozen=True)
class TerrainGrid:
    """A heightfield laid out for the FRAX solver.

    Node ``(i, j)`` is a solid column of footprint ``dx`` x ``dx`` centred on world XY
    ``origin + (i, j) * dx``, reaching from minus infinity up to ``heights[i, j]``; an infinite
    floor plane at ``floor_z`` lies under everything (``heights >= floor_z``).
    """

    heights: NDArray[np.float64]  # (nx, ny)
    origin: NDArray[np.float64]  # (2,) world XY of node (0, 0)
    dx: float  # cell size, metres
    floor_z: float

    def as_ref(self) -> dict[str, NDArray]:
        """The pytree handed to the solver: ``heights``, ``origin``, ``inv_dx``, ``floor_z``."""
        return {
            "heights": np.asarray(self.heights, dtype=np.float64),
            "origin": np.asarray(self.origin, dtype=np.float64),
            "inv_dx": np.asarray(1.0 / self.dx, dtype=np.float64),
            "floor_z": np.asarray(self.floor_z, dtype=np.float64),
        }

    def _nodes(self, xy: NDArray) -> tuple[NDArray, NDArray, NDArray]:
        """Nearest node indices (clipped into the grid) and whether ``xy`` lies on a column."""
        f = (np.asarray(xy, dtype=np.float64) - self.origin) / self.dx
        shape = np.asarray(self.heights.shape)
        on_grid = np.all((f >= -0.5) & (f <= shape - 0.5), axis=-1)
        idx = np.clip(np.round(f), 0, shape - 1).astype(np.int64)
        return idx[..., 0], idx[..., 1], on_grid

    def column_height_at(self, xy: NDArray) -> NDArray:
        """Top of the column containing each world point ``xy`` (..., 2); ``floor_z`` off-grid."""
        i, j, on_grid = self._nodes(xy)
        return np.where(on_grid, self.heights[i, j], self.floor_z)

    def signed_distance(self, points: NDArray) -> NDArray:
        """Brute-force signed distance from world ``points`` (..., 3) to the column terrain.

        Outside: the smallest distance to any column or the floor plane.  Inside a column: minus
        the shorter way out, upwards or sideways to the nearest column not higher than the
        point.  Reference for :func:`column_distance_rows`; cost is points x columns.
        """
        pts = np.asarray(points, dtype=np.float64)
        batch = pts.shape[:-1]
        pts = pts.reshape(-1, 3)
        nx, ny = self.heights.shape
        half = 0.5 * self.dx
        xk = self.origin[0] + self.dx * np.arange(nx)
        yk = self.origin[1] + self.dx * np.arange(ny)
        lx = np.maximum(np.abs(pts[:, 0, None] - xk) - half, 0.0)  # (m, nx)
        ly = np.maximum(np.abs(pts[:, 1, None] - yk) - half, 0.0)  # (m, ny)
        rho2 = lx[:, :, None] ** 2 + ly[:, None, :] ** 2
        rho = np.sqrt(rho2)
        s = pts[:, 2, None, None] - self.heights
        outside = np.where(s >= 0.0, np.sqrt(rho2 + s**2), np.where(rho > 0.0, rho, np.inf))
        d_out = np.minimum(outside.reshape(len(pts), -1).min(axis=1), pts[:, 2] - self.floor_z)
        i, j, on_grid = self._nodes(pts[:, :2])
        top = self.heights[i, j]
        inside = on_grid & (pts[:, 2] < top)
        free = (s >= 0.0) & (rho > 0.0)
        side = np.where(free, rho, np.inf).reshape(len(pts), -1).min(axis=1)
        d_in = -np.minimum(top - pts[:, 2], side)
        return np.where(inside, d_in, d_out).reshape(batch)


def build_terrain_grid(
    hf,
    min_point,
    dx: float,
    *,
    floor_z: float | None = None,
    pad_cells: int = 2,
    shape_bucket: int = 64,
) -> TerrainGrid:
    """Heightfield ``hf[ix, iy]`` (z at world XY ``min_point + (ix, iy) * dx``) as a solver grid.

    An infinite floor plane at ``floor_z`` lies under the terrain: cells below it are raised to
    it and non-finite cells become it.  ``None`` puts it at ``min(0, lowest cell)``, so it never
    cuts into the terrain; in a retarget scene ``z = 0`` is the source's lowest joint, usually an
    ankle a few centimetres above the floor it stands on.  ``pad_cells`` floor columns surround
    the terrain (points beyond them see only the floor plane), and both dimensions are then
    padded at the high-index end to multiples of ``shape_bucket`` so compiled solvers are reused
    across terrains of similar size (``shape_bucket <= 1`` disables this).
    """
    hf = np.asarray(hf, dtype=np.float64)
    if hf.ndim != 2:
        raise ValueError(f"heightfield must be 2-D, got shape {hf.shape}")
    if min(hf.shape) < 1:
        raise ValueError(f"heightfield must be non-empty, got shape {hf.shape}")
    if not dx > 0.0 or not np.isfinite(dx):
        raise ValueError(f"cell size dx must be positive and finite, got {dx}")
    min_point = np.asarray(min_point, dtype=np.float64).reshape(-1)
    if min_point.shape != (2,) or not np.all(np.isfinite(min_point)):
        raise ValueError(f"min_point must be two finite values, got {min_point}")
    if pad_cells < 0:
        raise ValueError(f"pad_cells must be >= 0, got {pad_cells}")
    if floor_z is None:
        finite = hf[np.isfinite(hf)]
        floor_z = min(0.0, float(finite.min())) if finite.size else 0.0
    floor_z = float(floor_z)
    heights = np.maximum(np.where(np.isfinite(hf), hf, floor_z), floor_z)
    heights = np.pad(heights, pad_cells, constant_values=floor_z)
    if shape_bucket > 1:
        extra = [-n % shape_bucket for n in heights.shape]
        heights = np.pad(heights, [(0, e) for e in extra], constant_values=floor_z)
    # The bilinear formula needs two samples per axis.
    heights = np.pad(heights, [(0, max(0, 2 - n)) for n in heights.shape], constant_values=floor_z)
    return TerrainGrid(
        heights=np.ascontiguousarray(heights),
        origin=min_point - pad_cells * float(dx),
        dx=float(dx),
        floor_z=floor_z,
    )


def _safe_norm(sq: Array) -> Array:
    """``sqrt(sq)`` with a finite derivative at 0 (``sq >= 0``)."""
    pos = sq > 0.0
    return jnp.where(pos, jnp.sqrt(jnp.where(pos, sq, 1.0)), 0.0)


def column_distance_rows(
    terrain: dict, centers: Array, window: int
) -> tuple[Array, Array, Array, Array]:
    """Local signed distance from sphere centres to the column terrain, as two rows each.

    ``centers``: (n, 3).  Columns are searched in a ``(2 * window + 1)^2`` block around the
    nearest node (indices clamped into the grid).  Returns ``(d_support, n_support, d_wall,
    n_wall)``, shapes (n,), (n, 3), (n,), (n, 3); directions are unit vectors along which the
    distance grows.  The support row is the nearest feature below or diagonally beside the
    centre (or the floor plane); when the centre is inside a column it is minus the shorter way
    out (up, or sideways to a free column).  The wall row is the horizontal gap to the nearest
    column that is higher than the centre; it is inactive (``d = 1e3``, zero direction) when
    there is none or the centre is inside a column.  :meth:`TerrainGrid.signed_distance` is the
    brute-force reference.
    """
    heights = jnp.asarray(terrain["heights"], dtype=jnp.float64)
    origin = jnp.asarray(terrain["origin"], dtype=jnp.float64)
    inv_dx = jnp.asarray(terrain["inv_dx"], dtype=jnp.float64)
    floor_z = jnp.asarray(terrain["floor_z"], dtype=jnp.float64)
    centers = jnp.asarray(centers, dtype=jnp.float64)
    shape = heights.shape
    half = 0.5 / inv_dx
    dx = 1.0 / inv_dx
    offs = jnp.arange(-window, window + 1)
    up = jnp.array([0.0, 0.0, 1.0])

    def one(c):
        f = (c[:2] - origin) * inv_dx
        on_grid = jnp.all((f >= -0.5) & (f <= jnp.asarray(shape) - 0.5))
        n0 = jnp.clip(jnp.round(f), 0, jnp.asarray(shape) - 1).astype(jnp.int32)
        ii = jnp.clip(n0[0] + offs, 0, shape[0] - 1)
        jj = jnp.clip(n0[1] + offs, 0, shape[1] - 1)
        dxs = c[0] - (origin[0] + dx * ii)  # (m,)
        dys = c[1] - (origin[1] + dx * jj)
        lx = jnp.maximum(jnp.abs(dxs) - half, 0.0)
        ly = jnp.maximum(jnp.abs(dys) - half, 0.0)
        hx = jnp.sign(dxs)[:, None] * lx[:, None] * jnp.ones_like(ly)[None]  # (m, m) x offsets
        hy = jnp.sign(dys)[None] * ly[None] * jnp.ones_like(lx)[:, None]
        rho2 = hx**2 + hy**2
        rho = _safe_norm(rho2)
        s = c[2] - heights[ii[:, None], jj[None, :]]
        top0 = heights[n0[0], n0[1]]
        inside = on_grid & (c[2] < top0)

        def direction(k, vertical):
            """Unit direction away from the nearest point of column ``k`` (flattened index)."""
            v = jnp.stack([hx.ravel()[k], hy.ravel()[k], vertical])
            n = _safe_norm(jnp.sum(v**2))
            return v / jnp.where(n > _EPS, n, 1.0), n

        below = s >= 0.0
        d_below = jnp.where(below, _safe_norm(rho2 + s**2), _FAR).ravel()
        kb = jnp.argmin(d_below)
        n_below, dist_b = direction(kb, s.ravel()[kb])
        n_below = jnp.where(dist_b > _EPS, n_below, up)
        use_plane = c[2] - floor_z <= d_below[kb]
        d_out = jnp.where(use_plane, c[2] - floor_z, d_below[kb])
        n_out = jnp.where(use_plane, up, n_below)

        free = (below & (rho > 0.0)).ravel()
        e_all = jnp.where(free, rho.ravel(), _FAR)
        ke = jnp.argmin(e_all)
        n_side, _ = direction(ke, 0.0)
        depth_up = top0 - c[2]
        go_up = depth_up <= e_all[ke]
        d_in = -jnp.minimum(depth_up, e_all[ke])
        n_in = jnp.where(go_up, up, -n_side)

        beside = (~below & (rho > 0.0)).ravel()
        r_all = jnp.where(beside, rho.ravel(), _FAR)
        kw = jnp.argmin(r_all)
        n_w, _ = direction(kw, 0.0)
        active = jnp.any(beside) & ~inside
        d_wall = jnp.where(active, r_all[kw], _INACTIVE)
        n_wall = jnp.where(active, n_w, 0.0)
        return (
            jnp.where(inside, d_in, d_out),
            jnp.where(inside, n_in, n_out),
            d_wall,
            n_wall,
        )

    return jax.vmap(one)(centers)


@jax.tree_util.register_static
class TerrainConstraint(_SphereConstraint):
    """Keep collision spheres out of a column terrain (:class:`TerrainGrid`).

    Each sphere contributes two barrier rows ``h = d - r - margin`` from
    :func:`column_distance_rows`; rows are ``-(n . J_sphere) v <= gain * h`` and the ``max_rows``
    lowest-barrier rows are kept.  The *support* row is the signed distance to the nearest
    feature below or beside-and-below the sphere (floor, column top or edge); the *wall* row is
    the horizontal gap to the nearest higher column.  A sphere standing on the floor beside a
    wall has two different nearest features, and one row would guard only one of them.  The
    wall distance shrinks continuously as the sphere approaches, so the barrier lets it close
    the gap within a step but not cross it: no tunnelling, provided the wall is inside the
    search window (``window`` columns each side, i.e. a sphere must not travel farther than
    ``window * dx`` horizontally in one solver step).  A sphere already inside a column leaves
    by the shorter way, up or sideways.  The terrain is read from ``ref[terrain_key]`` every
    step (:meth:`TerrainGrid.as_ref`), so one compiled solver serves any terrain of the same
    grid shape.

    Args:
        robot: frax robot with collision data
        sphere_idxs: robot collision spheres to check (default all)
        max_rows: keep only this many lowest-barrier rows per step (of ``2 * spheres``)
        gain: CBF gain (1/s)
        penalty: relaxation penalty
        margin: clearance kept from the terrain
        terrain_key: key of the terrain pytree in ``ref``
        window: columns searched on each side of the nearest node
    """

    def __init__(
        self,
        robot,
        sphere_idxs=None,
        max_rows: int | None = None,
        gain: float = 10.0,
        penalty: float = DEFAULT_PENALTY,
        margin: float = 0.0,
        terrain_key: str = "terrain",
        window: int = 4,
    ):
        assert robot.has_collision_data
        super().__init__(robot, gain, penalty)
        self.margin = margin
        self.terrain_key = terrain_key
        self.window = int(window)
        assert self.window >= 1
        self.sphere_idxs = (
            np.arange(len(self.radii)) if sphere_idxs is None else np.asarray(sphere_idxs)
        )
        self._set_num_rows(2 * len(self.sphere_idxs), max_rows)

    def rows(self, q, ref):
        robot = self.robot
        joint_tfs = robot.joint_to_world_transforms(q)
        pos = robot._link_collision_positions(joint_tfs)[self.sphere_idxs]
        radii = self.radii[self.sphere_idxs]
        d_s, n_s, d_w, n_w = column_distance_rows(ref[self.terrain_key], pos, self.window)
        h = jnp.concatenate([d_s, d_w]) - jnp.tile(radii, 2) - self.margin
        normals = jnp.concatenate([n_s, n_w])  # (2n, 3)
        n_sph = len(self.sphere_idxs)
        keep = jnp.arange(2 * n_sph) if self.max_rows is None else self._keep(h)
        spheres = jnp.asarray(self.sphere_idxs)[keep % n_sph]
        Jv, Jw = robot._joint_jacobians(joint_tfs)
        J = robot._link_collision_jacobians(joint_tfs, Jv, Jw, spheres)  # (k, 3, nv)
        dh = jnp.einsum("ki,kij->kj", normals[keep], J)
        return -dh, self.gain * h[keep]


@jax.tree_util.register_static
class FootStickConstraint(InequalityConstraint):
    """Cap the horizontal speed of tracked points.

    For each tracked point ``p_k`` (a frame rigidly attached to a joint frame) and each of x, y:
    ``|d/dt p_k,xy| <= ref[stick_key][k]``, a per-point speed cap in m/s (shape ``(n,)``,
    non-negative) read every step.  A tiny cap pins a planted foot; a large one leaves it free.

    Rows are grouped per point in the order ``+Jx, +Jy, -Jx, -Jy`` (``num_rows = 4 * n``).
    """

    def __init__(
        self,
        robot,
        joints,
        offsets,
        gain: float,
        penalty: float = DEFAULT_PENALTY,
        stick_key: str = "foot_speed_cap",
    ):
        self.robot = robot
        self.joints = np.asarray(joints)
        n = len(self.joints)
        self.offsets = np.broadcast_to(np.asarray(offsets, dtype=float), (n, 4, 4)).copy()
        self.stick_key = stick_key
        self.num_rows = 4 * n
        assert self.num_rows > 0
        self.penalty = penalty
        # Not used by ``rows``: frax reads every term's gain to size the first-frame
        # convergence step.
        self.gain = float(gain)

    def rows(self, q, ref):
        robot = self.robot
        tfs = robot.joint_to_world_transforms(q)
        Jv, Jw = robot._joint_jacobians(tfs)
        tfs, Jv, Jw = tfs[self.joints], Jv[self.joints], Jw[self.joints]
        _, Jv, _ = offset_transforms_and_jacobians(tfs, Jv, Jw, self.offsets)
        Jxy = Jv[:, :2]  # (n, 2, nv)
        G = jnp.concatenate([Jxy, -Jxy], axis=1)  # (n, 4, nv): +Jx, +Jy, -Jx, -Jy
        cap = jnp.asarray(ref[self.stick_key])
        h = jnp.broadcast_to(cap[:, None], (cap.shape[0], 4))
        return G.reshape(self.num_rows, -1), h.reshape(self.num_rows)
