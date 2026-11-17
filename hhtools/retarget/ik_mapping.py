# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Portions adapted from soma-retargeter (Apache-2.0).
# See https://github.com/NVIDIA/SOMA-Retargeter and the project root NOTICE.
"""Solver-independent ``robot.yaml`` ik_map resolution.

:func:`resolve_ik_map` translates ``robot.yaml``'s ``ik_map`` + ``weights``
into an :class:`IKMapping` against a list of addressable link names.  Both IK
backends share it: Newton passes its compiled body labels, FRAX passes the
URDF link names.  Kept free of Newton / Warp imports so a backend can resolve
the map without either installed.
"""

from __future__ import annotations

import logging
import os
import tempfile
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from hhtools.robot.base import RobotPreset

_log = logging.getLogger(__name__)


__all__ = [
    "IKMapping",
    "IKMappingEntry",
    "floating_base_safe_urdf",
    "resolve_ik_map",
]


@dataclass(frozen=True)
class IKMappingEntry:
    """Resolved mapping for a single canonical joint → robot link.

    Attributes:
        canonical_name: Name from ``robot.yaml:ik_map`` (canonical-human
            skeleton), e.g. ``"left_ankle"``.
        t_body_link: Name of the link used as the translation target.
        r_body_link: Name of the link used as the rotation target.  Usually
            equals ``t_body_link``; separate slot supports the (rare)
            soma-retargeter case where t and r come off different bodies.
        t_body_index: Index of ``t_body_link`` in the backend's link list
            (Newton ``body_label`` for the first environment).
        r_body_index: Same for ``r_body_link``.
        t_weight: Translation objective weight.
        r_weight: Rotation objective weight.
        t_offset: ``(x, y, z)`` offset applied to the translation target in
            the link's own frame before it reaches the IK solver.  This is
            typically ``(0, 0, 0)`` and exists to let users compensate for
            URDFs whose ankle link is at the foot sole vs ankle pivot.
    """

    canonical_name: str
    t_body_link: str
    r_body_link: str
    t_body_index: int
    r_body_index: int
    t_weight: float
    r_weight: float
    t_offset: tuple[float, float, float] = (0.0, 0.0, 0.0)


@dataclass
class IKMapping:
    """Full list of resolved IK mappings for a robot+motion pair."""

    entries: tuple[IKMappingEntry, ...]

    @property
    def canonical_names(self) -> tuple[str, ...]:
        return tuple(e.canonical_name for e in self.entries)

    @property
    def t_body_indices(self) -> tuple[int, ...]:
        return tuple(e.t_body_index for e in self.entries)

    @property
    def r_body_indices(self) -> tuple[int, ...]:
        return tuple(e.r_body_index for e in self.entries)

    @property
    def t_weights(self) -> np.ndarray:
        return np.asarray([e.t_weight for e in self.entries], dtype=np.float32)

    @property
    def r_weights(self) -> np.ndarray:
        return np.asarray([e.r_weight for e in self.entries], dtype=np.float32)

    def feet_indices(
        self, left_name: str = "left_ankle", right_name: str = "right_ankle"
    ) -> tuple[int, int] | None:
        """Return ``(idx_left, idx_right)`` in the mapping list, or None.

        The feet stabilizer uses this to pick foot effectors out of the
        mapping without caring about the absolute index layout.
        """
        names = self.canonical_names
        if left_name in names and right_name in names:
            return names.index(left_name), names.index(right_name)
        return None


def resolve_ik_map(
    preset: RobotPreset, body_labels: list[str]
) -> IKMapping:
    """Translate ``robot.yaml`` + backend link labels into an :class:`IKMapping`.

    ``robot.yaml:ik_map`` is either a flat ``{canonical: link}`` map (the
    hhtools default) or, for parity with soma-retargeter, a nested
    ``{canonical: {t_body, r_body, t_weight, r_weight, t_offset}}`` map —
    both are accepted.  Per-joint weights default to ``1.0`` and can be
    overridden via ``weights.t_weight`` / ``weights.r_weight`` in the yaml.
    """
    entries: list[IKMappingEntry] = []
    body_to_idx = {_leaf(name): i for i, name in enumerate(body_labels)}

    # Pull global weight overrides.  These are flat per-canonical-joint maps
    # in the yaml: ``weights.t_weight[hips] = 30.0``.
    t_weights_global = dict(preset.weights.get("t_weight", {}))
    r_weights_global = dict(preset.weights.get("r_weight", {}))

    for canonical, spec in preset.ik_map.items():
        if isinstance(spec, dict):
            t_body = str(spec.get("t_body") or spec.get("link") or canonical)
            r_body = str(spec.get("r_body") or t_body)
            t_weight = float(spec.get("t_weight", t_weights_global.get(canonical, 1.0)))
            r_weight = float(spec.get("r_weight", r_weights_global.get(canonical, 1.0)))
            raw_off = spec.get("t_offset", (0.0, 0.0, 0.0))
            t_offset = tuple(float(x) for x in raw_off)
        else:
            # Flat shorthand — the common case in hhtools configs.
            t_body = str(spec)
            r_body = t_body
            t_weight = float(t_weights_global.get(canonical, 1.0))
            r_weight = float(r_weights_global.get(canonical, 1.0))
            t_offset = (0.0, 0.0, 0.0)

        # Be tolerant of slots whose link isn't an addressable body in the
        # *compiled* model (e.g. a fixed-joint child the MJCF importer merged
        # into its parent).  Skipping the slot keeps the rest of the map usable
        # rather than failing the whole robot — the hhtools promise is that any
        # humanoid loads, even with an imperfect auto-map.  The Newton model is
        # built from the URDF (floating base, no fixed-joint collapse) so this
        # path is normally a no-op; it only bites on the MJCF fallback.
        missing = [b for b in (t_body, r_body) if b not in body_to_idx]
        if missing:
            _log.warning(
                "ik_map[%r] skipped: %s not in compiled bodies. Available: %s",
                canonical, missing, sorted(body_to_idx),
            )
            continue

        entries.append(
            IKMappingEntry(
                canonical_name=canonical,
                t_body_link=t_body,
                r_body_link=r_body,
                t_body_index=body_to_idx[t_body],
                r_body_index=body_to_idx[r_body],
                t_weight=t_weight,
                r_weight=r_weight,
                t_offset=t_offset,  # type: ignore[arg-type]
            )
        )
    return IKMapping(entries=tuple(entries))


def _leaf(label: str) -> str:
    """Drop any ``parent/child`` prefix so ``env0/torso_link`` → ``torso_link``."""
    return label.split("/")[-1]


def floating_base_safe_urdf(urdf_path: Path) -> Path:
    """Return a URDF path whose root is the real base (no redundant anchor).

    IK backends add their own 6-DoF free root joint.  A vendor URDF that
    *also* ships a ``world`` link + ``type="floating"`` joint to the real base
    therefore yields **two stacked floating bases**; the retargeter only
    drives one, so the robot floats.  Ingest normally strips this anchor on
    disk, but guard the solver path too (e.g. ``compile_mjcf=False`` loads or
    read-only presets that skipped the persisted fix).

    The stripped copy is written *beside* the URDF so relative mesh paths
    (``meshes/foo.STL``) keep resolving; if that directory is read-only we
    return the original path unchanged.  Callers delete a returned path that
    differs from ``urdf_path`` once they have parsed it.
    """
    import xml.etree.ElementTree as ET

    from hhtools.robot.urdf_normalize import (
        detect_redundant_floating_base_root,
        strip_redundant_floating_base_root,
    )

    try:
        if detect_redundant_floating_base_root(ET.parse(urdf_path).getroot()) is None:
            return urdf_path
    except Exception:
        return urdf_path

    urdf_dir = urdf_path.parent
    try:
        fd, tmp = tempfile.mkstemp(
            prefix=f"hhtools_fb_{urdf_path.stem}_",
            suffix=".urdf",
            dir=str(urdf_dir),
        )
        os.close(fd)
    except OSError:
        _log.warning(
            "cannot write a floating-base-safe copy of %s (read-only dir); "
            "retarget may float — re-import the robot to persist the fix",
            urdf_path.name,
        )
        return urdf_path

    tmp_path = Path(tmp)
    try:
        strip_redundant_floating_base_root(urdf_path, output_path=tmp_path)
        return tmp_path
    except Exception:
        try:
            tmp_path.unlink()
        except OSError:
            pass
        return urdf_path
