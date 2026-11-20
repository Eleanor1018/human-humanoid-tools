# SPDX-FileCopyrightText: Copyright (c) 2026 hhtools contributors
# SPDX-License-Identifier: Apache-2.0
"""Robot-agnostic non-penetration constraints via MuJoCo signed distance.

Produces linearised constraints::

    J_i · δq  ≥  −φ_i − tolerance

for every active robot ↔ scene geom pair.  Jacobians are obtained by
central finite differences of ``mj_geomDistance`` — identical to
holosoma's MPC path, no analytic Jacobian needed.

Design
------
* **Completely robot-agnostic** — operates on an arbitrary
  ``mujoco.MjModel`` that contains both robot and scene geoms.
* Collision geometry = convex hull of each link's mesh, computed
  automatically by MuJoCo at compile time.
* Scene geoms (ground plane, terrain, objects) live in worldbody
  (``body_id == 0``) and are identified by that criterion alone.
"""

from __future__ import annotations

import logging
import math
import os
import tempfile
import weakref
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import TYPE_CHECKING

import numpy as np
from numpy.typing import NDArray

if TYPE_CHECKING:
    from hhtools.core.scene import TerrainHeightfield

_log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Model enhancement — inject collision geometry into MJCF
# ---------------------------------------------------------------------------

def _enable_collision_in_xml(root: ET.Element) -> int:
    """Set ``contype=1 conaffinity=1`` on every mesh-backed ``<geom>``
    that currently has collision disabled.  Returns the number of geoms
    changed.
    """
    changed = 0
    for geom in root.iter("geom"):
        mesh_attr = geom.get("mesh")
        if not mesh_attr:
            continue
        ct = int(geom.get("contype", "0"))
        ca = int(geom.get("conaffinity", "0"))
        if ct == 0 and ca == 0:
            geom.set("contype", "1")
            geom.set("conaffinity", "1")
            changed += 1
    return changed


def _add_ground_plane(wb: ET.Element, z: float = 0.0) -> None:
    """Append a thin ground-plane geom to ``<worldbody>``."""
    ET.SubElement(
        wb, "geom",
        name="hhtools_ground",
        type="plane",
        size="10 10 0.01",
        pos=f"0 0 {z:.6f}",
        contype="1",
        conaffinity="1",
        rgba="0.85 0.85 0.85 0",
    )


def collision_ground_z(terrain: TerrainHeightfield | None, default: float = 0.0) -> float:
    """Height of the collision scene's ground plane for ``terrain``.

    The plane is solid below its height everywhere, including inside the
    heightfield's footprint, so it must never sit above the terrain surface.
    Grounding puts ``z = 0`` at the source's lowest joint, which on parc_ms is
    an ankle about 4 cm above the floor (``hf`` floor at -0.038 m); a plane
    at ``z = 0`` there fills every floor cell and pit up to ``z = 0``.  With a
    heightfield the plane goes to ``min(default, hf.min())`` and only catches
    feet that leave the heightfield's footprint.
    """
    if terrain is None:
        return float(default)
    hf = np.asarray(terrain.hf, dtype=np.float64)
    finite = hf[np.isfinite(hf)]
    if finite.size == 0:
        return float(default)
    return min(float(default), float(finite.min()))


def sanitize_hfield(hf: NDArray[np.floating]) -> NDArray[np.float64]:
    """Heightfield with every non-finite cell (NaN, +/-inf) set to the tallest finite height.

    Cells without a height are unknown terrain, which the foot clearance treats as solid, so
    the uploaded surface must not be lower there.  A grid with no finite cell becomes flat 0.
    """
    arr = np.array(hf, dtype=np.float64)
    bad = ~np.isfinite(arr)
    if bad.any():
        good = arr[~bad]
        _log.warning(
            "Heightfield has %d non-finite cells; raised to the finite maximum", int(bad.sum())
        )
        arr[bad] = float(good.max()) if good.size else 0.0
    return arr


def sanitize_terrain(terrain: TerrainHeightfield) -> TerrainHeightfield:
    """``terrain`` with every non-finite height (NaN, +/-inf) imputed, or ``terrain`` itself.

    The one place the interaction-mesh pipeline decides what an unknown cell is: solid, as tall as
    the tallest finite cell (:func:`sanitize_hfield`), so the grounding offset, the Laplacian
    anchors, the collision scene and the Z-snap all see the same finite surface and unknown ground
    never reads as free space.  ``hf_maxmin`` bounds of those cells follow.  Raises ``ValueError``
    when no cell has a finite height: there is no terrain to impute from.
    """
    from hhtools.core.scene import TerrainHeightfield as _Terrain

    hf = np.asarray(terrain.hf, dtype=np.float64)
    bad = ~np.isfinite(hf)
    if not bad.any():
        return terrain
    if bad.all():
        raise ValueError(
            f"terrain heightfield {hf.shape} has no finite cell (all NaN/inf); "
            "cannot impute a surface"
        )
    fixed = sanitize_hfield(hf)
    maxmin = np.array(terrain.hf_maxmin, dtype=np.float64)
    maxmin[bad] = fixed[bad][:, None]
    maxmin = np.where(np.isfinite(maxmin), maxmin, fixed[..., None])
    return _Terrain(
        hf=fixed.astype(np.float32),
        hf_maxmin=maxmin.astype(np.float32),
        min_point=terrain.min_point,
        dx=terrain.dx,
    )


def _dump_hfield_to_bin(hf: NDArray[np.floating], path: str | Path) -> None:
    """Write a heightfield to MuJoCo's custom hfield binary format.

    Layout (matches the MuJoCo XML reference for ``<asset><hfield file=…>``)::

        int32   nrow
        int32   ncol
        float32 data[nrow * ncol]   # row-major, normalised to [0, 1]

    MuJoCo internally re-normalises the data, but doing it here too gives
    deterministic round-tripping and lets us use the same byte payload as
    a fallback PNG.

    MuJoCo reads ``data[r * ncol + c]`` as the elevation at column ``c``
    along X and row ``r`` along Y.  ``hf`` is indexed ``hf[ix, iy]``
    (PARC's convention, X first), so it is written transposed:
    ``nrow = ny``, ``ncol = nx``, ``data[iy * nx + ix] = hf[ix, iy]``.
    """
    import struct

    arr = np.asarray(hf, dtype=np.float64)
    if arr.ndim != 2:
        raise ValueError(f"hfield must be 2-D; got shape {arr.shape}")
    arr = sanitize_hfield(arr).T  # rows along Y, columns along X
    nrow, ncol = arr.shape
    z_min = float(arr.min())
    z_max = float(arr.max())
    span = z_max - z_min
    norm = (arr - z_min) / max(span, 1e-9)
    payload = np.ascontiguousarray(norm, dtype=np.float32)

    with open(path, "wb") as fp:
        fp.write(struct.pack("<i", int(nrow)))
        fp.write(struct.pack("<i", int(ncol)))
        fp.write(payload.tobytes(order="C"))


def _add_hfield_geom(
    root: ET.Element,
    wb: ET.Element,
    *,
    hf_name: str,
    hf_geom_name: str,
    hf_file: Path,
    nx: int,
    ny: int,
    dx: float,
    z_min: float,
    z_max: float,
    x_center: float,
    y_center: float,
    base_thickness: float = 0.5,
) -> None:
    """Inject ``<asset><hfield/>`` and a worldbody ``<geom type="hfield"/>``.

    Layout requirements (see MuJoCo XML reference, asset/hfield):

    * ``size = (radius_x, radius_y, elevation_z, base_z)`` — half-extents
      of the rectangle plus the **range** of the elevation data and the
      thickness of the box hung below the minimum-elevation plane.
    * The geom's local Z=0 sits at the minimum elevation point; max
      elevation is at Z=elevation_z (data normalised to [0, 1] internally).
      So we set ``geom.pos.z = z_min``.
    * X-extent is ``(nx-1) * dx`` and Y-extent is ``(ny-1) * dx``; the
      geom is centred on its XY bbox so we pass ``pos.xy = (x_center,
      y_center)``.
    * ``contype/conaffinity = 1`` activates the heightfield for every
      collision pair (robot links inherit ``contype=1`` from the URDF).

    A ``base_thickness`` of 0.5 m is generous but harmless: the box
    underneath the hfield exists only to give cells where the
    normalised elevation is 0 a non-zero thickness so collision
    detection has a closed volume to work with.
    """
    asset = root.find("asset")
    if asset is None:
        asset = ET.SubElement(root, "asset")
        # Move the new <asset> ahead of <worldbody> for readability — not
        # strictly required, but makes the dumped XML easier to inspect.
        root.remove(asset)
        root.insert(0, asset)

    radius_x = max(((nx - 1) * dx) / 2.0, 1e-3)
    radius_y = max(((ny - 1) * dx) / 2.0, 1e-3)
    elevation_z = max(z_max - z_min, 1e-4)
    base_z = max(base_thickness, 1e-3)

    ET.SubElement(
        asset, "hfield",
        name=hf_name,
        file=str(hf_file),
        size=f"{radius_x:.6f} {radius_y:.6f} {elevation_z:.6f} {base_z:.6f}",
    )

    ET.SubElement(
        wb, "geom",
        name=hf_geom_name,
        type="hfield",
        hfield=hf_name,
        pos=f"{x_center:.6f} {y_center:.6f} {z_min:.6f}",
        contype="1",
        conaffinity="1",
        rgba="0.55 0.50 0.45 1",
    )


def build_collision_model_with_hfield(
    base_model,
    urdf_dir: str | Path,
    terrain: "TerrainHeightfield | None",
    *,
    base_xml: str = "",
    add_ground: bool = True,
    ground_z: float = 0.0,
    base_thickness: float = 0.5,
):
    """Build a MuJoCo collision model from a robot URDF + a heightfield.

    Replaces the previous OBJ + VHACD pipeline with MuJoCo's native
    ``<hfield>`` asset.  Steps:

    1. Parse *base_xml* (the freejoint-augmented MJCF snapshotted by
       :func:`_ensure_freejoint`) so we can inject new ``<asset>`` /
       ``<worldbody>`` entries.
    2. Enable ``contype=1 conaffinity=1`` on every mesh-backed geom in
       the URDF (MuJoCo will auto-build convex-hull collision shapes).
    3. Optionally drop a flat ground plane at ``ground_z`` so robots
       don't fall through cells outside the heightfield's footprint.
    4. If ``terrain`` is non-None, write its data to a temporary
       MuJoCo-format ``.bin`` file and inject ``<asset><hfield/>``
       referencing it, plus a worldbody ``<geom type="hfield"/>`` whose
       pose places the data exactly where the source heightfield says.
    5. Recompile the modified MJCF and return the new ``mujoco.MjModel``.

    Parameters
    ----------
    base_model
        Compiled ``mujoco.MjModel`` for the robot only (no terrain).
        Used for shape-comparison logging only — the new model is
        compiled from *base_xml*.
    urdf_dir
        URDF parent directory; used as the working directory for temp
        files so that any ``<mesh file="meshes/foo.STL">`` references
        in the URDF still resolve after we re-write the XML.
    terrain
        Optional :class:`hhtools.core.scene.TerrainHeightfield` already
        in the **robot frame** (caller is responsible for invoking
        :meth:`TerrainHeightfield.scaled` first).  ``None`` → only a
        ground plane is added (or nothing if ``add_ground=False``).
    base_xml
        Freejoint-augmented MJCF string to start from.  This **must** be
        provided (we used to call ``mj_saveLastXML`` here, but that API
        snapshots whichever model was last compiled in the process and
        was the cause of cross-clip XML contamination — e.g. an OMOMO
        retarget after a holosoma retarget would inherit the latter's
        ``<hfield file=…/hhtools_terrain_hfield_*.bin>`` reference, then
        crash recompilation because the .bin had been deleted).
    add_ground
        Add an infinite-plane geom at ``ground_z``.
    ground_z
        Z position of the optional ground plane.
    base_thickness
        Thickness of the closed box hung underneath the hfield to give
        every cell a non-zero collision volume.  See MuJoCo's hfield
        docs (``size[3]``).

    Returns
    -------
    new_model : mujoco.MjModel
        Same ``nq``/``nv`` as *base_model*, with extra worldbody geoms.
    tmp_files : list[Path]
        Temporary files produced (currently the hfield .bin if any);
        callers should pass these to :func:`cleanup_terrain_files` once
        the retarget run finishes.
    """
    import mujoco

    urdf_dir = Path(urdf_dir)

    if not base_xml:
        raise ValueError(
            "build_collision_model_with_hfield requires base_xml. "
            "Pass MujocoScene.mjcf_xml — never use mj_saveLastXML, which "
            "leaks stale references across retarget runs."
        )

    tree = ET.ElementTree(ET.fromstring(base_xml))
    root = tree.getroot()
    wb = root.find("worldbody")
    if wb is None:
        raise RuntimeError("no <worldbody> in MJCF")

    compiler = root.find("compiler")
    if compiler is not None:
        saved_meshdir = compiler.get("meshdir", "")
        if saved_meshdir and saved_meshdir != ".":
            resolved = (
                Path(saved_meshdir)
                if Path(saved_meshdir).is_absolute()
                else urdf_dir / saved_meshdir
            )
            if not resolved.is_dir():
                compiler.set("meshdir", str(urdf_dir))

    n_enabled = _enable_collision_in_xml(root)
    _log.info("Enabled collision on %d mesh geoms", n_enabled)

    if add_ground:
        _add_ground_plane(wb, z=ground_z)

    tmp_files: list[Path] = []
    if terrain is not None:
        nx, ny = int(terrain.shape[0]), int(terrain.shape[1])
        dx_m = float(terrain.dx)
        x_min = float(terrain.min_point[0])
        y_min = float(terrain.min_point[1])
        x_max = x_min + (nx - 1) * dx_m
        y_max = y_min + (ny - 1) * dx_m
        clean_hf = sanitize_hfield(terrain.hf)
        z_min_g = float(clean_hf.min())
        z_max_g = float(clean_hf.max())

        fd_bin, tmp_bin = tempfile.mkstemp(
            suffix=".bin", prefix="hhtools_terrain_hfield_", dir=urdf_dir,
        )
        os.close(fd_bin)
        _dump_hfield_to_bin(clean_hf, tmp_bin)
        tmp_files.append(Path(tmp_bin))

        _add_hfield_geom(
            root, wb,
            hf_name="hhtools_terrain_hf",
            hf_geom_name="hhtools_terrain_hf_geom",
            hf_file=Path(tmp_bin),
            nx=nx,
            ny=ny,
            dx=dx_m,
            z_min=z_min_g,
            z_max=z_max_g,
            x_center=0.5 * (x_min + x_max),
            y_center=0.5 * (y_min + y_max),
            base_thickness=base_thickness,
        )

    fd2, tmp_out = tempfile.mkstemp(
        suffix=".xml", prefix="hhtools_collision_scene_", dir=urdf_dir,
    )
    os.close(fd2)
    try:
        tree.write(tmp_out, encoding="utf-8", xml_declaration=True)
        new_model = mujoco.MjModel.from_xml_path(tmp_out)
    except Exception as exc:
        _log.error("Collision scene compilation failed: %s", exc)
        raise
    finally:
        _safe_unlink(tmp_out)

    _log.info(
        "Collision scene: nq=%d nv=%d ngeom=%d (base ngeom=%d, hfield=%s)",
        new_model.nq, new_model.nv, new_model.ngeom, base_model.ngeom,
        "yes" if terrain is not None else "no",
    )
    return new_model, tmp_files


# ---------------------------------------------------------------------------
# Constraint computation (robot-agnostic)
# ---------------------------------------------------------------------------

#: Penetrations up to this depth (m) are measured exactly by the ``distmax = 0``
#: heightfield query; deeper ones can come back too shallow.
_HFIELD_EXACT_DEPTH = 0.01
#: Penetration (m) aimed for when re-raising the heightfield to refine a gap.
_HFIELD_PROBE_DEPTH = 0.003
#: Raised-heightfield queries per pair, at most.
_HFIELD_MAX_LIFTS = 3


def _shifted_hfield_distance(model, data, g1, g2, hf, shift, fromto) -> float:
    """``mj_geomDistance(distmax=0)`` with heightfield geom ``hf`` displaced by ``shift`` (3,)."""
    import mujoco

    saved = data.geom_xpos[hf].copy()
    try:
        data.geom_xpos[hf] = saved + shift
        fromto[:] = 0.0
        return float(mujoco.mj_geomDistance(model, data, g1, g2, 0.0, fromto))
    finally:
        data.geom_xpos[hf] = saved


#: Facet normals closer than this (rad) to one another are probed once.
_HFIELD_NORMAL_MERGE = 2e-3
#: A probe's own contact normal is probed again when it differs from the probed one by more.
_HFIELD_REFINE_ANGLE = np.radians(1.5)
#: Refinements of the contact normal per pair, at most.
_HFIELD_MAX_REFINES = 2


def _closest_points_on_triangles(p, a, b, c) -> NDArray[np.float64]:
    """Closest point to ``p`` on triangle ``(a, b, c)``; the arguments broadcast (``(..., 3)``)."""
    ab, ac, ap = b - a, c - a, p - a
    d1, d2 = (ab * ap).sum(-1), (ac * ap).sum(-1)
    bp = p - b
    d3, d4 = (ab * bp).sum(-1), (ac * bp).sum(-1)
    cp = p - c
    d5, d6 = (ab * cp).sum(-1), (ac * cp).sum(-1)
    vc, vb, va = d1 * d4 - d3 * d2, d5 * d2 - d1 * d6, d3 * d6 - d5 * d4

    def frac(num, den):
        return (num / np.where(den == 0.0, 1.0, den))[..., None]

    out = a + ab * frac(vb, va + vb + vc) + ac * frac(vc, va + vb + vc)  # inside
    edge_bc = ((va <= 0) & (d4 - d3 >= 0) & (d5 - d6 >= 0))[..., None]
    out = np.where(edge_bc, b + (c - b) * frac(d4 - d3, (d4 - d3) + (d5 - d6)), out)
    edge_ac = ((vb <= 0) & (d2 >= 0) & (d6 <= 0))[..., None]
    out = np.where(edge_ac, a + ac * frac(d2, d2 - d6), out)
    out = np.where(((d6 >= 0) & (d5 <= d6))[..., None], c, out)
    edge_ab = ((vc <= 0) & (d1 >= 0) & (d3 <= 0))[..., None]
    out = np.where(edge_ab, a + ab * frac(d1, d1 - d3), out)
    out = np.where(((d3 >= 0) & (d4 <= d3))[..., None], b, out)
    return np.where(((d1 <= 0) & (d2 <= 0))[..., None], a, out)


def _hfield_facets_near(
    model, data, hf: int, other: int, reach: float
) -> tuple[NDArray[np.float64], NDArray[np.float64], NDArray[np.float64]]:
    """Facets near geom ``other``: ``(triangles, normals, lower bounds)``, in the hfield frame.

    The triangles (m, 3, 3) are the two of every cell whose square comes within ``reach`` (m) of
    the geom's bounding sphere in XY, split along the diagonal joining nodes ``(i, j)`` and
    ``(i + 1, j + 1)`` (the one MuJoCo collides with;
    ``tests/retarget/test_interaction_mesh_terrain_collision_limits.py`` pins it).  ``normals``
    (m, 3) are their unit upward normals.  ``lower bounds`` (m,) are, per triangle, the distance
    from the geom's centre to its bounding box minus the bounding radius: no point of the geom is
    closer to that facet than this.  Flat terrain gives one normal for every triangle.  A geom
    outside the grid gets no triangles.
    """
    none = (np.zeros((0, 3, 3)), np.zeros((0, 3)), np.zeros(0))
    grid = _hfield_triangles(model, hf)
    if grid is None:
        return none
    tris_all, normals_all, lo_all, hi_all, (step_x, step_y, radius_x, radius_y) = grid
    nrow, ncol = tris_all.shape[0] + 1, tris_all.shape[1] + 1
    centre = data.geom_xpos[other] - data.geom_xpos[hf]
    bound = float(model.geom_rbound[other])
    span = bound + reach
    c0 = max(int(np.floor((centre[0] - span + radius_x) / step_x)), 0)
    c1 = min(int(np.ceil((centre[0] + span + radius_x) / step_x)), ncol - 1)
    r0 = max(int(np.floor((centre[1] - span + radius_y) / step_y)), 0)
    r1 = min(int(np.ceil((centre[1] + span + radius_y) / step_y)), nrow - 1)
    if c1 <= c0 or r1 <= r0:
        return none
    window = (slice(r0, r1), slice(c0, c1))
    tris = tris_all[window].reshape(-1, 3, 3)
    normals = normals_all[window].reshape(-1, 3)
    lo, hi = lo_all[window].reshape(-1, 3), hi_all[window].reshape(-1, 3)
    box = np.maximum(np.maximum(lo - centre, centre - hi), 0.0)
    return tris, normals, np.maximum(np.linalg.norm(box, axis=1) - bound, 0.0)


_TRIANGLE_CACHE: weakref.WeakKeyDictionary = weakref.WeakKeyDictionary()


def _hfield_triangles(model, hf: int):
    """Every triangle of heightfield geom ``hf`` in its own frame, cached per model.

    Returns ``(triangles, normals, lower corners, upper corners, (step_x, step_y, radius_x,
    radius_y))`` with the first four shaped ``(nrow - 1, ncol - 1, 2, ...)``, or ``None`` for a
    degenerate field.
    """
    cache = _TRIANGLE_CACHE.setdefault(model, {})
    if hf in cache:
        return cache[hf]
    hid = int(model.geom_dataid[hf])
    nrow, ncol = int(model.hfield_nrow[hid]), int(model.hfield_ncol[hid])
    radius_x, radius_y, elevation, _ = (float(v) for v in model.hfield_size[hid])
    if nrow < 2 or ncol < 2:
        cache[hf] = None
        return None
    step_x, step_y = 2.0 * radius_x / (ncol - 1), 2.0 * radius_y / (nrow - 1)
    adr = int(model.hfield_adr[hid])
    h = model.hfield_data[adr : adr + nrow * ncol].reshape(nrow, ncol).astype(np.float64)
    h = h * elevation
    gx, gy = np.meshgrid(-radius_x + step_x * np.arange(ncol), -radius_y + step_y * np.arange(nrow))
    corner = np.stack([gx, gy, h], axis=-1)  # (rows, cols, 3)
    p00, p10 = corner[:-1, :-1], corner[:-1, 1:]  # (row, col) and (row, col + 1)
    p01, p11 = corner[1:, :-1], corner[1:, 1:]
    tris = np.stack(
        [
            np.stack([p00, p10, p11], axis=-2),  # below the diagonal: x offset >= y offset
            np.stack([p00, p11, p01], axis=-2),  # above it
        ],
        axis=2,
    )  # (rows - 1, cols - 1, 2, 3, 3)
    normals = np.cross(tris[..., 1, :] - tris[..., 0, :], tris[..., 2, :] - tris[..., 0, :])
    normals /= np.linalg.norm(normals, axis=-1, keepdims=True)
    normals = np.where(normals[..., 2:3] < 0.0, -normals, normals)
    spacing = (step_x, step_y, radius_x, radius_y)
    entry = (tris, normals, tris.min(axis=-2), tris.max(axis=-2), spacing)
    cache[hf] = entry
    return entry


#: Spacing (m) of the surface samples that bound the gap to a non-flat window (a foot mesh has
#: thousands at 1 cm and the query runs thousands of times per clip).
_HFIELD_SAMPLE_SPACING = 0.02
_SAMPLE_CACHE: weakref.WeakKeyDictionary = weakref.WeakKeyDictionary()


def _geom_surface_samples(model, geom: int) -> NDArray[np.float64]:
    """Points (n, 3) on geom ``geom``'s collision surface in its own frame, cached per model.

    The same samples the Z-snap uses (:func:`~.terrain_clearance.geom_sample_points`): corners,
    edges and faces of boxes and mesh hulls, curved surfaces to within 1 mm.
    """
    cache = _SAMPLE_CACHE.setdefault(model, {})
    if geom not in cache:
        from hhtools.retarget.interaction_mesh.terrain_clearance import geom_sample_points

        cache[geom] = geom_sample_points(model, geom, _HFIELD_SAMPLE_SPACING)
    return cache[geom]


def _sampled_gap(
    model, data, hf: int, other: int, tris: NDArray[np.float64], limit: float
) -> tuple[float, NDArray[np.float64], NDArray[np.float64]] | None:
    """Smallest distance from samples of geom ``other`` to the triangles, or ``None``.

    Returns ``(gap, point on the geom, point on the terrain)`` in world coordinates.  The samples
    are points of the geom, so the gap is an upper bound of the true one; it is exact when the
    closest point of the geom is a sample, i.e. for a sphere (its centre, minus the radius), and
    for the corner or an edge or face parallel to the terrain of a polyhedron or mesh hull.
    ``None`` when nothing is closer than ``limit`` or the geom has no samples.
    """
    import mujoco

    origin = data.geom_xpos[hf]
    if int(model.geom_type[other]) == int(mujoco.mjtGeom.mjGEOM_SPHERE):
        radius = float(model.geom_size[other][0])
        centre = (data.geom_xpos[other] - origin)[None, :]
        pts, shift = centre, radius
    else:
        local = _geom_surface_samples(model, other)
        if not len(local):
            return None
        rot = data.geom_xmat[other].reshape(3, 3)
        pts, shift = data.geom_xpos[other] - origin + local @ rot.T, 0.0
    if not len(tris):
        return None
    reach = limit + shift
    lo, hi = tris.min(axis=1), tris.max(axis=1)
    # Only point-triangle pairs that can be closer than ``reach``: a cheap box distance first.
    near = np.all((pts > lo.min(axis=0) - reach) & (pts < hi.max(axis=0) + reach), axis=1)
    pts = pts[near]
    if not len(pts):
        return None
    box = np.maximum(np.maximum(lo[None] - pts[:, None], pts[:, None] - hi[None]), 0.0)
    lower = np.sqrt(np.einsum("ptk,ptk->pt", box, box))  # no closer than the triangle's box
    # ... nor than its plane, the tighter bound above a sloped facet.
    normal = np.cross(tris[:, 1] - tris[:, 0], tris[:, 2] - tris[:, 0])
    normal /= np.linalg.norm(normal, axis=1, keepdims=True)
    plane = np.abs(pts @ normal.T - np.einsum("tk,tk->t", normal, tris[:, 0]))
    lower = np.fmax(lower, plane)
    pi, ti = np.nonzero(lower < reach)
    if not len(pi):
        return None
    order = np.argsort(lower[pi, ti])
    pi, ti = pi[order], ti[order]

    def measure(sel):
        t = tris[ti[sel]]
        q = _closest_points_on_triangles(pts[pi[sel]], t[:, 0], t[:, 1], t[:, 2])
        return q, np.linalg.norm(pts[pi[sel]] - q, axis=1)

    # The 64 pairs with the closest boxes give an upper bound; only pairs whose box is closer
    # than that can beat it.
    first = slice(0, 64)
    q, dist = measure(first)
    best = float(dist.min())
    rest = np.arange(64, len(pi))
    rest = rest[lower[pi[rest], ti[rest]] < best]
    if len(rest):
        q2, d2 = measure(rest)
        q, dist = np.concatenate([q, q2]), np.concatenate([dist, d2])
        pi = np.concatenate([pi[first], pi[rest]])
    else:
        pi = pi[first]
    i = int(np.argmin(dist))
    gap = float(dist[i]) - shift
    if gap >= limit or gap < 0.0:
        return None
    on_terrain, point = q[i], pts[pi[i]]
    if shift:  # sphere: its witness is the surface point towards the terrain
        point = point + shift * (on_terrain - point) / max(float(dist[i]), 1e-12)
    return gap, point + origin, on_terrain + origin


def _distinct_normals(
    normals: NDArray[np.float64], bound_gap: NDArray[np.float64]
) -> list[tuple[float, NDArray[np.float64]]]:
    """``(lower bound, normal)`` per distinct normal, nearest first."""
    cells = np.round(normals / _HFIELD_NORMAL_MERGE).astype(np.int64)
    base = int(2 * math.ceil(1.0 / _HFIELD_NORMAL_MERGE) + 1)
    key = ((cells[:, 0] + base) * (2 * base) + cells[:, 1] + base) * (2 * base) + cells[:, 2] + base
    _, first, inverse = np.unique(key, return_index=True, return_inverse=True)
    inverse = np.asarray(inverse).reshape(-1)
    best = np.full(len(first), np.inf)
    np.minimum.at(best, inverse, bound_gap)
    order = np.argsort(best)
    return [(float(best[i]), normals[first[i]]) for i in order]


def _probe_hfield_along(
    model, data, g1, g2, hf, normal, start, k, kg, probe
) -> tuple[float, NDArray[np.float64], float] | None:
    """Gap along ``normal`` by displacing the heightfield towards the geom, or ``None``.

    Displacing the surface by ``L * normal`` and finding the geom ``p`` deep inside it
    (the exact ``distmax = 0`` penetration depth) proves a gap of at most ``L - p`` to the
    original surface, whatever the normal; it is the gap itself when the closest surface point
    lies on a planar facet with this normal.  ``None`` when the displaced surface (``L = start``)
    does not touch the geom, i.e. the gap along this normal is at least ``start``.  Otherwise
    ``(gap, witnesses of the last probe, its L)``.  While ``p`` exceeds :data:`_HFIELD_EXACT_DEPTH`
    (the depth the query is trusted to), it is redone for the estimated gap plus
    :data:`_HFIELD_PROBE_DEPTH`.
    """
    shift_len = float(start)
    result = None
    for _ in range(_HFIELD_MAX_LIFTS):
        depth = _shifted_hfield_distance(model, data, g1, g2, hf, shift_len * normal, probe)
        if depth >= 0.0:
            break  # first query: clear; later: the earlier (upper) estimate stands
        pen = -depth
        gap = max(shift_len - pen, 0.0)
        result = (gap, probe.copy(), shift_len)
        if pen <= _HFIELD_EXACT_DEPTH:
            break
        shift_len = gap + _HFIELD_PROBE_DEPTH
    return result


def _hfield_pair_distance(
    model,
    data,
    g1: int,
    g2: int,
    threshold: float,
    fromto: NDArray[np.float64],
) -> float:
    """Signed distance between a geom and a heightfield geom within ``threshold``.

    ``mj_geomDistance`` against an ``<hfield>`` is wrong whenever ``distmax > 0``
    (measured on MuJoCo 3.7 with spheres, boxes and the rp1 foot meshes): it
    returns about ``gap - 1.5 * distmax``, so with the 5 cm collision threshold
    a foot resting on the terrain reads 7.5 cm inside it.  With ``distmax = 0``
    it is exact for penetration up to about the geom's own thickness (deeper
    contact comes back too shallow) and reports 0 for any separation.

    So: query at ``distmax = 0``; if the geoms penetrate, that is the answer (the deepest
    penetration MuJoCo reports; trusted up to :data:`_HFIELD_EXACT_DEPTH`).  Otherwise the gap is
    an upper bound built from two kinds of evidence, the smaller one wins:

    * Displacement probes (:func:`_probe_hfield_along`): the heightfield's world pose is moved
      towards the geom along a direction ``n`` by ``L`` until the geom penetrates it by ``p``,
      which proves gap <= ``L - p``, with equality when the closest terrain point lies in the
      interior of a planar facet whose upward normal is ``n``.  The directions are the distinct
      normals of the terrain triangles within ``threshold`` of the geom's bounding sphere,
      tilted in any direction in XY (:func:`_hfield_facets_near`), each probed only while its
      facet could still be closer than the best gap found, then the contact normal of the best
      probe.  A flat window has one direction, the vertical: the plain vertical lift.
    * Samples of the geom (:func:`_sampled_gap`), used in non-flat windows: the exact distance
      from sample points of the geom's surface (its centre for a sphere) to the triangles.

    Guarantees, against the compiled (triangulated) surface, with the penetration query exact
    (``p`` can come back too small for a deep contact, which only raises the gap):

    * The gap is never below the true one, except by the error of the brute-force reference (below a
      millimetre).
    * It equals the true gap, to about a millimetre, when the closest terrain point is in a
      facet interior (any geom, including a facet outside the geom's XY footprint), and for a
      sphere anywhere, including on a ridge or vertex.
    * For a box or mesh hull whose closest feature touches a ridge or vertex it is exact when
      that feature is a corner or an edge or face parallel to the terrain (a sample hits it),
      and otherwise within the 2 cm sample grid's reach.  Measured against a brute-force
      surface distance on random terrains (rough and stepped): 194 sphere poses on 12 terrains
      agreed to the last digit, 133 randomly oriented box poses on 20 terrains to within 3.6 mm
      (95th percentile 2.2 mm); the previous vertical probe read up to 49 mm low.  Curved primitives other than spheres (capsules, cylinders,
      ellipsoids) are covered by the facet probes and 1 mm curvature samples, with no separate
      measurement.
    * Near a heightfield edge the displaced pose also moves its footprint, which is not
      corrected for.

    Gaps at or above ``threshold`` return ``threshold`` with ``fromto`` zeroed, like
    ``mj_geomDistance``.  Otherwise ``fromto`` holds ``(p1, p2)``: the geom witness at its
    deepest point into the displaced surface, and the heightfield witness on the real surface
    (the displaced surface's witness moved back), so ``p1 - p2`` gives the contact normal.
    """
    import mujoco

    fromto[:] = 0.0
    dist = float(mujoco.mj_geomDistance(model, data, g1, g2, 0.0, fromto))
    if dist < 0.0 or threshold <= 0.0:
        return dist
    hf = g1 if int(model.geom_type[g1]) == int(mujoco.mjtGeom.mjGEOM_HFIELD) else g2
    other = g2 if hf == g1 else g1
    k = 0 if hf == g1 else 3  # offset of the heightfield witness in ``fromto``
    kg = 3 - k  # offset of the other geom's witness
    tris, normals, bound_gap = _hfield_facets_near(model, data, hf, other, float(threshold))
    if not len(tris):
        normals, bound_gap = np.array([[0.0, 0.0, 1.0]]), np.zeros(1)
    if bound_gap.min() >= threshold:  # even the geom's bounding sphere is out of reach
        fromto[:] = 0.0
        return float(threshold)
    candidates = _distinct_normals(normals, bound_gap)
    probe = np.zeros(6, dtype=np.float64)

    best_gap = float(threshold)
    best: NDArray[np.float64] | None = None  # witnesses in ``fromto`` layout
    tried: list[NDArray[np.float64]] = []

    last: tuple[NDArray[np.float64], NDArray[np.float64]] | None = None  # (witnesses, normal)

    def run(normal: NDArray[np.float64]) -> None:
        nonlocal best_gap, best, last
        tried.append(normal)
        hit = _probe_hfield_along(model, data, g1, g2, hf, normal, best_gap, k, kg, probe)
        if hit is None or hit[0] >= best_gap:
            return
        gap, witnesses, shift_len = hit
        best_gap = gap
        best = witnesses.copy()
        best[k : k + 3] -= shift_len * normal  # the real surface, not the displaced one
        last = (witnesses, normal)

    def contact_normal() -> NDArray[np.float64] | None:
        """Terrain-to-geom direction at the last probe's witnesses, pointing up."""
        v = last[0][kg : kg + 3] - last[0][k : k + 3]
        norm = float(np.linalg.norm(v))
        return v / norm if norm > 1e-9 and v[2] > 0.0 else None

    def angle(a, b) -> float:
        return float(np.arccos(np.clip(a @ b, -1.0, 1.0)))

    for lower, normal in candidates:
        if lower >= best_gap:
            break
        run(normal)
    # The probe is exact when its contact normal is the probed one: the closest point is in the
    # interior of that facet.  Otherwise (a ridge or vertex has none of the facet normals) probe
    # along the contact normal itself.
    exact = False
    for _ in range(_HFIELD_MAX_REFINES + 1):
        v = contact_normal() if last is not None else None
        if v is None:
            break
        if angle(v, last[1]) <= _HFIELD_REFINE_ANGLE:
            exact = True
            break
        if any(angle(v, t) <= _HFIELD_REFINE_ANGLE for t in tried):
            break
        run(v)
    if len(candidates) > 1 and not exact:
        # A non-flat window and no probe that landed on a facet: the closest point may be on a
        # ridge or vertex, where the samples of the geom bound the gap from above.
        sampled = _sampled_gap(model, data, hf, other, tris[bound_gap < best_gap], best_gap)
        if sampled is not None:
            best_gap = sampled[0]
            best = np.zeros(6, dtype=np.float64)
            best[k : k + 3], best[kg : kg + 3] = sampled[2], sampled[1]
    if best is None or best_gap >= threshold:
        fromto[:] = 0.0
        return float(threshold)
    fromto[:] = best
    return float(best_gap)


def _geom_pair_distance(
    model,
    data,
    g1: int,
    g2: int,
    threshold: float,
    fromto: NDArray[np.float64],
) -> float:
    """``mj_geomDistance``, with heightfield pairs measured by :func:`_hfield_pair_distance`."""
    import mujoco

    hfield = int(mujoco.mjtGeom.mjGEOM_HFIELD)
    if int(model.geom_type[g1]) == hfield or int(model.geom_type[g2]) == hfield:
        return _hfield_pair_distance(model, data, g1, g2, threshold, fromto)
    fromto[:] = 0.0
    return float(mujoco.mj_geomDistance(model, data, g1, g2, threshold, fromto))


#: A ground-plane row duplicates a heightfield row when their normals are within this angle...
_PLANE_DUPLICATE_ANGLE = np.radians(3.0)
#: ... and their gaps within this distance (m).
_PLANE_DUPLICATE_GAP = 3e-3


def _plane_rows_duplicated_by_hfield(model, records, normals) -> set[int]:
    """Indices into ``records`` of ground-plane rows that a heightfield row already expresses.

    The plane catches feet that leave the heightfield's footprint.  Inside it, on a floor cell, the
    heightfield row of the same robot geom has the plane's normal and gap, and keeping both would
    only double that contact's slack penalty.  A plane row is dropped only when such a row exists:
    same robot geom, normals within :data:`_PLANE_DUPLICATE_ANGLE`, gaps within
    :data:`_PLANE_DUPLICATE_GAP`.  Where the heightfield is elsewhere (its footprint does not
    cover the contact, or its surface or base is far above or below the plane) the plane row is the
    only floor and stays.

    ``records`` are ``(g1, g2, dist, pos1, pos2)``; ``normals[i]`` is record ``i``'s unit normal or
    ``None``.
    """
    import mujoco

    gtype = np.asarray(model.geom_type)
    plane_t, hf_t = int(mujoco.mjtGeom.mjGEOM_PLANE), int(mujoco.mjtGeom.mjGEOM_HFIELD)
    cos_tol = float(np.cos(_PLANE_DUPLICATE_ANGLE))
    hf_rows: dict[int, list[tuple[float, NDArray[np.float64]]]] = {}
    planes: list[tuple[int, int, float, NDArray[np.float64]]] = []
    for i, (g1, g2, dist, _p1, _p2) in enumerate(records):
        if normals[i] is None:
            continue
        scene_first = _is_worldbody_geom(model, g1)
        scene, robot = (g1, g2) if scene_first else (g2, g1)
        normal = normals[i] if scene_first else -normals[i]  # same side whatever the pair order
        if int(gtype[scene]) == hf_t:
            hf_rows.setdefault(robot, []).append((dist, normal))
        elif int(gtype[scene]) == plane_t:
            planes.append((i, robot, dist, normal))
    covered: set[int] = set()
    for i, robot, dist, normal in planes:
        for h_dist, h_normal in hf_rows.get(robot, ()):
            if abs(h_dist - dist) <= _PLANE_DUPLICATE_GAP and float(normal @ h_normal) >= cos_tol:
                covered.add(i)
                break
    return covered


def _is_worldbody_geom(model, geom_id: int) -> bool:
    return int(model.geom_bodyid[geom_id]) == 0


def _has_collision(model, geom_id: int) -> bool:
    return int(model.geom_contype[geom_id]) != 0 or int(model.geom_conaffinity[geom_id]) != 0


def detect_collision_candidates(
    model, data, threshold: float,
) -> list[tuple[int, int]]:
    """Broadphase: inflate margins, run ``mj_collision``, return unique pairs
    where one geom is a robot link and the other is a scene (worldbody) geom.
    """
    import mujoco

    saved = model.geom_margin.copy()
    model.geom_margin[:] = threshold
    try:
        mujoco.mj_collision(model, data)
    finally:
        model.geom_margin[:] = saved

    pairs: set[tuple[int, int]] = set()
    for k in range(data.ncon):
        c = data.contact[k]
        g1, g2 = int(c.geom1), int(c.geom2)
        if g1 < 0 or g2 < 0:
            continue
        is_scene1 = _is_worldbody_geom(model, g1)
        is_scene2 = _is_worldbody_geom(model, g2)
        if is_scene1 == is_scene2:
            continue
        if not (_has_collision(model, g1) and _has_collision(model, g2)):
            continue
        pairs.add((min(g1, g2), max(g1, g2)))
    return sorted(pairs)


def _contact_normal(g1, g2, dist, pos1, pos2, geom_names) -> NDArray[np.float64] | None:
    """Unit normal of the pair's constraint row from its witnesses, or ``None`` if degenerate."""
    v = pos1 - pos2
    v_norm = float(np.linalg.norm(v))
    if v_norm > 1e-12:
        return (np.sign(dist) if dist != 0.0 else 1.0) * (v / v_norm)
    # Witnesses coincide (just-touching).  Use the heightfield / ground geom's +Z as a sane
    # fallback; otherwise there is no usable normal.
    n1 = geom_names[g1].lower()
    n2 = geom_names[g2].lower()
    if any(tag in n2 for tag in ("ground", "terrain", "hfield")):
        return np.array([0.0, 0.0, 1.0], dtype=np.float64)
    if any(tag in n1 for tag in ("ground", "terrain", "hfield")):
        return np.array([0.0, 0.0, -1.0], dtype=np.float64)
    return None


def compute_nonpenetration_constraints(
    model,
    data,
    qpos: NDArray[np.float64],
    *,
    threshold: float = 0.05,
    tolerance: float = 0.002,
    fd_epsilon: float = 1e-5,  # kept for API compatibility (unused)
    max_pairs_per_body: int = 0,
) -> tuple[list[NDArray[np.float64]], list[float]]:
    """Non-penetration constraint rows via **analytic** signed-distance Jacobians.

    For every robot↔scene geom pair with signed distance ≤ *threshold*,
    computes the linearised constraint::

        (∂dist/∂q) · δq  ≥  −dist − tolerance

    The Jacobian is built directly from the contact normal and MuJoCo's
    body-attached point Jacobian (``mj_jac``), mirroring the analytic
    formula used by the holosoma retargeter
    (``holosoma/.../interaction_mesh_retargeter.py:_compute_jacobian_for_contact_relative``).
    Specifically, ``mj_geomDistance`` returns the witness points
    ``(p1, p2)`` on each geom's surface and the signed distance
    ``φ = sign(d) · ‖p1 − p2‖``; differentiating with respect to ``q``
    while holding the witness points fixed at first order gives::

        ∂φ/∂q = n̂ᵀ · (J_p1 − J_p2),     n̂ = sign(d) · (p1 − p2) / ‖p1 − p2‖

    where ``J_pᵢ = ∂p_i^world/∂q`` is the translational Jacobian of
    a point rigidly attached to ``body(geom_i)``.  For ``worldbody``
    geoms (heightfield, ground plane) the body Jacobian is identically
    zero, so terrain contributes only via the corresponding closest
    point's normal.

    Compared to the previous central-difference implementation this
    eliminates the inner ``2 · nq`` ``mj_forward`` sweep and the
    ``2 · nq · |pairs|`` extra ``mj_geomDistance`` evaluations per SQP
    inner iteration — an O(nq) speedup that dominates on heightfield
    clips where ``mj_geomDistance`` is itself expensive.

    **Per-body row deduplication.** For URDF feet that compile to many
    sub-meshes (the rp1 right_ankle_roll_link, for example, exposes
    24+ collision primitives) every primitive can independently be
    "close to" the heightfield and produce its own row.  At a typical
    parkour frame this gave 53 rows per SQP step where ~6 were
    genuinely informative; the rest were near-duplicates whose witness
    points and normals oscillated frame-to-frame as the foot crossed
    cell boundaries on the heightfield surface.  OSQP fed these
    chattery rows produced multi-degree per-frame ``|Δq|`` jitter on
    the foot DOFs (the user-reported "since switching to heightmap
    the robot trembles like crazy" failure mode).  We now keep at
    most :param max_pairs_per_body: rows per (robot body, scene geom)
    bucket — the deepest signed distances within that bucket.  This
    preserves the meaningful constraints (the actually-penetrating
    contact at the deepest point of each foot) while suppressing the
    noisy near-duplicates that produced the chatter.  Empirical
    holosoma parkour_1 sweep: dropping from 53 → ~12 rows/frame cut
    per-frame ``|Δq|`` jerk by ≈8× without changing the converged
    posture.

    Parameters
    ----------
    model, data
        MuJoCo model/data — must include scene geoms (ground, terrain).
    qpos
        Current generalised coordinates ``(nq,)``.
    threshold
        Activation distance: pairs farther than this are ignored.
    tolerance
        Small positive slack (metres) to avoid chatter at the boundary.
    fd_epsilon
        Unused.  Retained so existing callers and tests don't break.
    max_pairs_per_body
        Maximum number of inequality rows kept per
        ``(robot_body, scene_geom)`` bucket — see jitter discussion
        above.  ``0`` disables the cap (every active pair contributes
        a row, original behaviour).

    Returns
    -------
    J_rows : list[ndarray]
        Each entry is ``(nq,)`` — the signed-distance Jacobian for one pair.
    rhs : list[float]
        Matching lower bounds: ``J_rows[i] @ dq >= rhs[i]``.
    """
    import mujoco

    from hhtools.retarget.interaction_mesh.mujoco_jacobians import (
        build_T_qdot_to_qpos,
    )

    nq = model.nq
    nv = model.nv
    fromto = np.zeros(6, dtype=np.float64)

    data.qpos[:] = qpos
    mujoco.mj_forward(model, data)

    candidates = detect_collision_candidates(model, data, threshold)
    if not candidates:
        return [], []

    # Build T(q) once.  Only the FREE-joint quaternion block depends on
    # qpos and that block is constant across all pairs at this snapshot.
    T = build_T_qdot_to_qpos(model, data)

    Jp = np.zeros((3, nv), dtype=np.float64, order="C")
    Jr = np.zeros((3, nv), dtype=np.float64, order="C")

    geom_names = [
        mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_GEOM, g) or "" for g in range(model.ngeom)
    ]

    # First pass: collect every active pair's geometry without yet
    # building the (potentially expensive) Jacobian rows.  We bucket
    # by ``(robot_body, scene_geom)`` so the dedup-by-depth step is
    # local to each foot ↔ each scene part.
    pair_records: list[tuple[int, int, float, NDArray[np.float64], NDArray[np.float64]]] = []
    for g1, g2 in candidates:
        dist = _geom_pair_distance(model, data, g1, g2, threshold, fromto)
        if dist >= threshold:
            continue
        pos1 = fromto[:3].copy()
        pos2 = fromto[3:].copy()
        if _contact_normal(g1, g2, dist, pos1, pos2, geom_names) is None:
            continue  # degenerate: drop the row rather than fight a degenerate normal
        pair_records.append((g1, g2, dist, pos1, pos2))

    def capped(records):
        """Per-bucket cap: collapse near-duplicate rows that the URDF's multi-primitive foot
        meshes would otherwise produce, retaining only the deepest few (see docstring)."""
        if max_pairs_per_body <= 0 or not records:
            return records
        from collections import defaultdict

        buckets: dict[tuple[int, int], list] = defaultdict(list)
        for rec in records:
            g1, g2 = rec[0], rec[1]
            b1 = int(model.geom_bodyid[g1])
            b2 = int(model.geom_bodyid[g2])
            # The "robot" geom is the one with non-zero body id; the "scene" geom is the
            # worldbody one (terrain, ground etc.).  We also key on the scene geom so a robot
            # link straddling two distinct scene geoms (terrain edge + ground plane) keeps a
            # row for each.
            if b1 != 0 and b2 == 0:
                key = (b1, g2)
            elif b2 != 0 and b1 == 0:
                key = (b2, g1)
            else:
                key = (max(b1, b2), -1)  # rare: robot-robot, keep separate
            buckets[key].append(rec)
        kept = []
        for recs in buckets.values():
            recs.sort(key=lambda r: r[2])  # ascending dist == descending penetration
            kept.extend(recs[:max_pairs_per_body])
        return kept

    # The ground plane exists for feet outside the heightfield; where an equivalent heightfield
    # row of the same robot geom survives its cap, the plane row only doubles that contact.
    plane_type = int(mujoco.mjtGeom.mjGEOM_PLANE)

    def is_plane_row(rec) -> bool:
        scene = rec[0] if _is_worldbody_geom(model, rec[0]) else rec[1]
        return int(model.geom_type[scene]) == plane_type

    others = capped([r for r in pair_records if not is_plane_row(r)])
    plane_rows = [r for r in pair_records if is_plane_row(r)]
    if plane_rows and others:
        probe = others + plane_rows
        probe_normals = [_contact_normal(r[0], r[1], r[2], r[3], r[4], geom_names) for r in probe]
        dup = _plane_rows_duplicated_by_hfield(model, probe, probe_normals)
        plane_rows = [r for i, r in enumerate(plane_rows) if len(others) + i not in dup]
    pair_records = others + capped(plane_rows)

    # Second pass: build Jacobian rows for the surviving pairs only.
    J_rows: list[NDArray[np.float64]] = []
    rhs: list[float] = []
    for g1, g2, dist, pos1, pos2 in pair_records:
        normal = _contact_normal(g1, g2, dist, pos1, pos2, geom_names)
        if normal is None:
            continue

        b1 = int(model.geom_bodyid[g1])
        b2 = int(model.geom_bodyid[g2])

        row_v = np.zeros(nv, dtype=np.float64)
        if b1 != 0:
            Jp.fill(0.0)
            Jr.fill(0.0)
            mujoco.mj_jac(model, data, Jp, Jr, pos1, b1)
            row_v += normal @ Jp
        if b2 != 0:
            Jp.fill(0.0)
            Jr.fill(0.0)
            mujoco.mj_jac(model, data, Jp, Jr, pos2, b2)
            row_v -= normal @ Jp

        # row_v is in qvel space (length nv); convert to qpos space via T.
        # ``v = T q̇`` ⇒ ``∂φ/∂q = (∂φ/∂v) · T``.
        row = row_v @ T
        J_rows.append(row.astype(np.float64, copy=False))
        rhs.append(-dist - tolerance)

    return J_rows, rhs


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _safe_unlink(path) -> None:
    try:
        os.unlink(path)
    except OSError:
        pass


def cleanup_terrain_files(paths: list[Path]) -> None:
    """Remove temporary terrain OBJ files created during scene build."""
    for p in paths:
        _safe_unlink(p)


__all__ = [
    "build_collision_model_with_hfield",
    "cleanup_terrain_files",
    "collision_ground_z",
    "compute_nonpenetration_constraints",
    "detect_collision_candidates",
]
