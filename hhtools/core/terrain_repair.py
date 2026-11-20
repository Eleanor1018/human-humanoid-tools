"""Imputation of non-finite terrain heights, shared by the solver and the exporters."""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

import numpy as np
from numpy.typing import NDArray

if TYPE_CHECKING:
    from hhtools.core.scene import TerrainHeightfield

_log = logging.getLogger(__name__)


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
