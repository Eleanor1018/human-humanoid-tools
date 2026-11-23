"""Foot-sticking contact flags read the source vertex of the foot point the QP pins."""

from __future__ import annotations

import numpy as np

from hhtools.retarget.interaction_mesh.mpc_loop import (
    FrameLaplacianTarget,
    RobotMpcPoint,
    extract_foot_sticking_sequences,
    resolve_foot_mpc_points,
)

_TOE = np.array([0.12, 0.0, -0.04])
_HEEL = np.array([-0.05, 0.0, -0.04])


def _point(body: str, semantic: str, offset=(0.0, 0.0, 0.0)) -> RobotMpcPoint:
    return RobotMpcPoint(
        body_name=body,
        local_offset=np.asarray(offset, dtype=np.float64),
        semantic=semantic,
    )


def _ankle_named_points() -> list[RobotMpcPoint]:
    """Point layout of an ankle-mapped robot such as rp1 (no ``*_foot`` point)."""
    pts = [_point("pelvis", "pelvis")]
    for side in ("left", "right"):
        body = f"{side}_ankle_roll_link"
        pts += [
            _point(body, f"{side}_ankle"),
            _point(body, f"{side}_ankle:toe", _TOE),
            _point(body, f"{side}_ankle:heel", _HEEL),
        ]
    return pts


def _targets(tracks: dict[int, np.ndarray], n_vertices: int, nh: int) -> list[FrameLaplacianTarget]:
    """Frames whose source vertex ``i`` follows ``tracks[i]`` (F, 3); other vertices stay put."""
    n_frames = len(next(iter(tracks.values())))
    out = []
    for f in range(n_frames):
        verts = np.zeros((n_vertices, 3), dtype=np.float32)
        for i, track in tracks.items():
            verts[i] = track[f]
        out.append(
            FrameLaplacianTarget(
                adj_list=[[] for _ in range(n_vertices)],
                target_laplacian=np.zeros((n_vertices, 3), dtype=np.float32),
                source_vertices=verts,
                n_human_vertices=nh,
            )
        )
    return out


def _walk(start, step, n_frames: int = 5) -> np.ndarray:
    """``n_frames`` positions moving ``step`` (metres per frame) in XY."""
    t = np.arange(n_frames, dtype=np.float64)[:, None]
    return np.asarray(start, dtype=np.float64) + t * np.asarray(step, dtype=np.float64)


def test_ankle_named_feet_get_contact_flags_from_the_pinned_point():
    pts = _ankle_named_points()
    nh = len(pts)
    left_pt, right_pt = resolve_foot_mpc_points(pts, nh)
    assert (left_pt.semantic, right_pt.semantic) == ("left_ankle:toe", "right_ankle:toe")

    # Left heel rises about a planted toe: the ankle vertex moves 2 cm/frame
    # but the toe vertex (the point the sticking rows pin) stays put.
    # Right foot swings 5 cm/frame.
    targets = _targets(
        {
            1: _walk([0.0, 0.1, 0.1], [0.02, 0.0, 0.0]),
            2: _walk([0.15, 0.1, 0.0], [0.0, 0.0, 0.0]),
            4: _walk([0.0, -0.1, 0.1], [0.05, 0.0, 0.0]),
            5: _walk([0.15, -0.1, 0.0], [0.05, 0.0, 0.0]),
        },
        n_vertices=nh + 3,  # + terrain / object samples after the human rows
        nh=nh,
    )

    seq = extract_foot_sticking_sequences(targets, pts, velocity_threshold=0.01)

    assert [row["L_Foot"] for row in seq] == [False, True, True, True, True]
    assert not any(row["R_Foot"] for row in seq)


def test_foot_named_points_keep_using_the_foot_vertex():
    pts = []
    for side in ("left", "right"):
        pts += [
            _point(f"{side}_ankle_link", f"{side}_ankle"),
            _point(f"{side}_ankle_link", f"{side}_ankle:toe", _TOE),
            _point(f"{side}_toe_link", f"{side}_foot"),
        ]
    nh = len(pts)
    # resolve_foot_mpc_points prefers ``*_ankle:toe``, but the flags keep
    # reading the ``*_foot`` vertex as before: only the foot vertex is planted.
    assert resolve_foot_mpc_points(pts, nh)[0].semantic == "left_ankle:toe"
    targets = _targets(
        {
            1: _walk([0.1, 0.1, 0.0], [0.05, 0.0, 0.0]),
            2: _walk([0.2, 0.1, 0.0], [0.0, 0.0, 0.0]),
            4: _walk([0.1, -0.1, 0.0], [0.0, 0.0, 0.0]),
            5: _walk([0.2, -0.1, 0.0], [0.05, 0.0, 0.0]),
        },
        n_vertices=nh,
        nh=nh,
    )

    seq = extract_foot_sticking_sequences(targets, pts, velocity_threshold=0.01)

    assert [row["L_Foot"] for row in seq] == [False, True, True, True, True]
    assert not any(row["R_Foot"] for row in seq)
