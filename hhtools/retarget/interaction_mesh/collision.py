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
import os
import tempfile
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


def _raised_hfield_distance(model, data, g1, g2, hf, lift, fromto) -> float:
    """``mj_geomDistance(distmax=0)`` with heightfield geom ``hf`` raised by ``lift``."""
    import mujoco

    saved = data.geom_xpos[hf].copy()
    try:
        data.geom_xpos[hf, 2] += lift
        fromto[:] = 0.0
        return float(mujoco.mj_geomDistance(model, data, g1, g2, 0.0, fromto))
    finally:
        data.geom_xpos[hf] = saved


#: Facets steeper than ``acos(_HFIELD_MIN_NZ)`` are treated as exactly that steep when sizing the
#: lift, which caps it at ``threshold / _HFIELD_MIN_NZ``.
_HFIELD_MIN_NZ = 0.1


def _hfield_local_min_nz(model, data, hf: int, other: int) -> float:
    """Smallest upward-normal z component of the heightfield facets near geom ``other``.

    Lifting a facet with unit normal ``n`` by ``L`` closes its normal gap by ``L * n_z``, so the
    lift that brings every facet within ``threshold`` of the geom must be ``threshold / n_z``.
    Both triangulations of every cell under the geom's bounding sphere are considered, so the
    answer does not depend on which diagonal MuJoCo splits a cell along.  Flat terrain gives 1.
    """
    hid = int(model.geom_dataid[hf])
    nrow, ncol = int(model.hfield_nrow[hid]), int(model.hfield_ncol[hid])
    radius_x, radius_y, elevation, _ = (float(v) for v in model.hfield_size[hid])
    if nrow < 2 or ncol < 2:
        return 1.0
    step_x, step_y = 2.0 * radius_x / (ncol - 1), 2.0 * radius_y / (nrow - 1)
    centre = data.geom_xpos[other] - data.geom_xpos[hf]
    reach = float(model.geom_rbound[other])
    # Cells overlapping the bounding box of the geom's footprint (the geom may be rotated, but
    # its bounding sphere is not).
    c0 = max(int(np.floor((centre[0] - reach + radius_x) / step_x)), 0)
    c1 = min(int(np.ceil((centre[0] + reach + radius_x) / step_x)), ncol - 1)
    r0 = max(int(np.floor((centre[1] - reach + radius_y) / step_y)), 0)
    r1 = min(int(np.ceil((centre[1] + reach + radius_y) / step_y)), nrow - 1)
    if c1 <= c0 or r1 <= r0:
        return 1.0
    adr = int(model.hfield_adr[hid])
    grid = model.hfield_data[adr : adr + nrow * ncol].reshape(nrow, ncol)
    h = grid[r0 : r1 + 1, c0 : c1 + 1].astype(np.float64) * elevation
    # Gradients of the planes through three corners of each cell, for both diagonals.
    dx_ = (h[:, 1:] - h[:, :-1]) / step_x  # along x, per cell row edge
    dy_ = (h[1:, :] - h[:-1, :]) / step_y
    gx = np.maximum(np.abs(dx_[:-1]), np.abs(dx_[1:]))  # (rows - 1, cols - 1), both edges
    gy = np.maximum(np.abs(dy_[:, :-1]), np.abs(dy_[:, 1:]))
    # A diagonal facet mixes one x edge and one y edge; the gradient never exceeds their sum.
    slope = float(np.hypot(gx, gy).max())
    return float(np.clip(1.0 / np.sqrt(1.0 + slope * slope), _HFIELD_MIN_NZ, 1.0))


def _hfield_pair_distance(
    model,
    data,
    g1: int,
    g2: int,
    threshold: float,
    fromto: NDArray[np.float64],
) -> float:
    """Signed distance between a geom and a heightfield geom, exact within ``threshold``.

    ``mj_geomDistance`` against an ``<hfield>`` is wrong whenever ``distmax > 0``
    (measured on MuJoCo 3.7 with spheres, boxes and the rp1 foot meshes): it
    returns about ``gap - 1.5 * distmax``, so with the 5 cm collision threshold
    a foot resting on the terrain reads 7.5 cm inside it.  With ``distmax = 0``
    it is exact for penetration up to about the geom's own thickness (deeper
    contact comes back too shallow) and reports 0 for any separation.

    So: query at ``distmax = 0``; if the geoms penetrate, that is the answer.
    Otherwise measure the gap by raising the heightfield (its world pose only)
    until the geom penetrates it shallowly.  A facet with unit upward normal ``n``
    moves ``lift * n_z`` closer along its normal, not ``lift``, so the first lift is
    ``threshold / n_z`` for the steepest facet under the geom (:func:`_hfield_local_min_nz`),
    and a penetration ``d`` of the raised surface along the witness normal ``n`` means a gap
    ``lift * n_z - d``.  While ``d`` is deeper than :data:`_HFIELD_EXACT_DEPTH` the lift
    is redone for the estimated gap plus :data:`_HFIELD_PROBE_DEPTH` along that normal.
    Gaps at or above ``threshold`` return ``threshold`` with ``fromto`` zeroed, like
    ``mj_geomDistance``.  Otherwise ``fromto`` holds ``(p1, p2)`` with the geom witness at its
    deepest point into the raised surface and the heightfield witness the foot of the
    perpendicular on the real surface, so ``p1 - p2`` gives the contact normal.
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
    nz_min = _hfield_local_min_nz(model, data, hf, other)
    probe = np.zeros(6, dtype=np.float64)
    lift = float(threshold) / nz_min
    gap = float(threshold)
    best = np.zeros(6, dtype=np.float64)
    found = False
    for _ in range(_HFIELD_MAX_LIFTS):
        depth = _raised_hfield_distance(model, data, g1, g2, hf, lift, probe)
        if depth >= 0.0:
            # Clear of the raised surface: every facet is still at least ``threshold`` away
            # (first lift), or the earlier estimate stands.
            if not found:
                gap = float(threshold)
            break
        pen = -depth
        if nz_min >= 1.0:
            # Flat terrain: the facet normal is +z and a lift closes the gap one-for-one.
            nz = 1.0
            gap = lift - pen
            best[:] = probe
            best[k + 2] -= lift
        else:
            # Contact normal, from the terrain up towards the geom.
            v = probe[kg : kg + 3] - probe[k : k + 3]
            norm = float(np.linalg.norm(v))
            up = v / norm if norm > 1e-12 else np.array([0.0, 0.0, 1.0])
            if up[2] < 0.0:
                up = -up
            # A deep penetration returns an unreliable normal; the terrain's own steepest
            # facet is the better guess then.
            nz = float(np.clip(up[2], nz_min, 1.0)) if pen <= _HFIELD_EXACT_DEPTH else nz_min
            gap = max(lift * nz - pen, 0.0)
            best[kg : kg + 3] = probe[kg : kg + 3]
            best[k : k + 3] = probe[kg : kg + 3] - gap * up
        found = True
        if pen <= _HFIELD_EXACT_DEPTH:
            break
        lift = (gap + _HFIELD_PROBE_DEPTH) / nz
    if not found or gap >= threshold:
        fromto[:] = 0.0
        return float(threshold)
    fromto[:] = best
    return float(gap)


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


def _plane_row_is_covered_by_hfield(model, data, plane: int, witness: NDArray[np.float64]) -> bool:
    """Whether the plane's contact at ``witness`` is already measured against a heightfield.

    The ground plane exists to catch feet that leave the heightfield's footprint.  Inside it, a
    plane at or below the heightfield's lowest cell is never closer than the heightfield, whose row
    has the same normal on a floor cell, so the plane's row would only double that contact's slack
    penalty.
    """
    import mujoco

    if int(model.geom_type[plane]) != int(mujoco.mjtGeom.mjGEOM_PLANE):
        return False
    for h in np.flatnonzero(np.asarray(model.geom_type) == int(mujoco.mjtGeom.mjGEOM_HFIELD)):
        centre = data.geom_xpos[h]
        radius_x, radius_y, _, _ = model.hfield_size[int(model.geom_dataid[h])]
        # The heightfield geom sits at its lowest cell; the plane must not be above that.
        if (
            data.geom_xpos[plane][2] <= centre[2] + 1e-9
            and abs(witness[0] - centre[0]) <= radius_x
            and abs(witness[1] - centre[1]) <= radius_y
        ):
            return True
    return False


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
        scene_geom, scene_pos = (g1, pos1) if _is_worldbody_geom(model, g1) else (g2, pos2)
        if _plane_row_is_covered_by_hfield(model, data, scene_geom, scene_pos):
            continue
        v = pos1 - pos2
        v_norm = float(np.linalg.norm(v))
        if v_norm > 1e-12:
            normal = (np.sign(dist) if dist != 0.0 else 1.0) * (v / v_norm)
        else:
            # Witnesses coincide (just-touching).  Use the heightfield /
            # ground geom's +Z as a sane fallback; otherwise drop the
            # row rather than fight a degenerate normal.
            n1 = geom_names[g1].lower()
            n2 = geom_names[g2].lower()
            if any(tag in n2 for tag in ("ground", "terrain", "hfield")):
                normal = np.array([0.0, 0.0, 1.0], dtype=np.float64)
            elif any(tag in n1 for tag in ("ground", "terrain", "hfield")):
                normal = np.array([0.0, 0.0, -1.0], dtype=np.float64)
            else:
                continue

        pair_records.append((g1, g2, dist, pos1, pos2))
        # ``normal`` is small / cheap to keep; recompute below from
        # the same ``pos1 - pos2`` to avoid carrying it around.

    # Per-bucket cap: collapse near-duplicate rows that the URDF's
    # multi-primitive foot meshes would otherwise produce, retaining
    # only the deepest few.  See docstring for rationale.
    if max_pairs_per_body > 0 and len(pair_records) > 0:
        from collections import defaultdict
        buckets: dict[tuple[int, int], list[tuple[int, int, float, NDArray[np.float64], NDArray[np.float64]]]] = defaultdict(list)
        for rec in pair_records:
            g1, g2, _dist, _p1, _p2 = rec
            b1 = int(model.geom_bodyid[g1])
            b2 = int(model.geom_bodyid[g2])
            # The "robot" geom is the one with non-zero body id; the
            # "scene" geom is the worldbody one (terrain, ground etc.).
            # We also key on the scene geom so a robot link straddling
            # two distinct scene geoms (terrain edge + ground plane)
            # keeps a row for each.
            if b1 != 0 and b2 == 0:
                key = (b1, g2)
            elif b2 != 0 and b1 == 0:
                key = (b2, g1)
            else:
                key = (max(b1, b2), -1)  # rare: robot-robot, keep separate
            buckets[key].append(rec)
        kept: list[tuple[int, int, float, NDArray[np.float64], NDArray[np.float64]]] = []
        for recs in buckets.values():
            recs.sort(key=lambda r: r[2])  # ascending dist == descending penetration
            kept.extend(recs[:max_pairs_per_body])
        pair_records = kept

    # Second pass: build Jacobian rows for the surviving pairs only.
    J_rows: list[NDArray[np.float64]] = []
    rhs: list[float] = []
    for g1, g2, dist, pos1, pos2 in pair_records:
        v = pos1 - pos2
        v_norm = float(np.linalg.norm(v))
        if v_norm > 1e-12:
            normal = (np.sign(dist) if dist != 0.0 else 1.0) * (v / v_norm)
        else:
            n1 = geom_names[g1].lower()
            n2 = geom_names[g2].lower()
            if any(tag in n2 for tag in ("ground", "terrain", "hfield")):
                normal = np.array([0.0, 0.0, 1.0], dtype=np.float64)
            elif any(tag in n1 for tag in ("ground", "terrain", "hfield")):
                normal = np.array([0.0, 0.0, -1.0], dtype=np.float64)
            else:
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
