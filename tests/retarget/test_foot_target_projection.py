from __future__ import annotations

import dataclasses
from types import SimpleNamespace

import numpy as np
import pytest

from hhtools.core.scene import TerrainHeightfield
from hhtools.retarget.calibration import RobotRetargetCalibration, save_calibration
from hhtools.retarget.interaction_mesh.mujoco_scene import MujocoScene
from hhtools.retarget.interaction_mesh.pipeline import InteractionMeshPipeline
from hhtools.retarget.interaction_mesh.target_projection import (
    column_signed_distance,
    project_foot_targets,
)

DX = 0.04


def _pipeline(model, motion) -> InteractionMeshPipeline:
    path = model.preset.root_dir / "retarget_calibration_smpl.yaml"
    save_calibration(
        RobotRetargetCalibration(
            robot=model.preset.name,
            reference="smpl",
            calibrated_joint_q={name: 0.0 for name in model.dof_names()},
            notes="self-contained foot-target projection fixture",
        ),
        path,
    )
    return InteractionMeshPipeline.from_calibration(model, motion, str(path), human_height=1.7)


def _multi_frame(motion, frames: int = 3):
    motion.positions = np.repeat(motion.positions[:1], frames, axis=0)
    motion.quaternions = np.repeat(motion.quaternions[:1], frames, axis=0)
    return motion


def _terrain(hf, dx=DX, origin=(0.0, 0.0)) -> TerrainHeightfield:
    hf = np.asarray(hf, dtype=np.float32)
    return TerrainHeightfield(
        hf=hf,
        hf_maxmin=np.stack([hf, hf], axis=-1),
        min_point=np.asarray(origin, dtype=np.float32),
        dx=dx,
    )


def _reference(points, terrain, ring=3) -> np.ndarray:
    """Brute force over every column of the grid, padded with floor columns, plus the floor."""
    hf = np.asarray(terrain.hf, dtype=np.float64)
    floor = min(0.0, float(hf[np.isfinite(hf)].min()))
    h = np.where(np.isfinite(hf), np.maximum(hf, floor), floor)
    nx, ny = h.shape
    hp = np.pad(h, ring, constant_values=floor)
    half = terrain.dx / 2
    out = []
    for p in np.asarray(points, dtype=np.float64):
        best_out, best_in = p[2] - floor, np.inf
        for i in range(hp.shape[0]):
            for j in range(hp.shape[1]):
                cx = terrain.min_point[0] + (i - ring) * terrain.dx
                cy = terrain.min_point[1] + (j - ring) * terrain.dx
                rho2 = max(abs(p[0] - cx) - half, 0.0) ** 2 + max(abs(p[1] - cy) - half, 0.0) ** 2
                s = p[2] - hp[i, j]
                best_out = min(best_out, np.sqrt(rho2 + max(s, 0.0) ** 2))
                best_in = min(best_in, np.sqrt(rho2 + max(-s, 0.0) ** 2))
        fx = (p[0] - terrain.min_point[0]) / terrain.dx
        fy = (p[1] - terrain.min_point[1]) / terrain.dx
        on = -0.5 <= fx <= nx - 0.5 and -0.5 <= fy <= ny - 0.5
        i, j = int(np.clip(round(fx), 0, nx - 1)), int(np.clip(round(fy), 0, ny - 1))
        out.append(-best_in if on and p[2] < h[i, j] else best_out)
    return np.asarray(out)


def test_signed_distance_matches_bruteforce_on_stepped_grid():
    rng = np.random.default_rng(3)
    hf = np.round(rng.uniform(-0.05, 0.3, (9, 8)) / 0.05) * 0.05
    hf[4, 4] = np.nan
    terrain = _terrain(hf)
    lo = np.array([-0.05, -0.05, -0.1])
    hi = np.array([9 * DX, 8 * DX, 0.4])
    pts = rng.uniform(lo, hi, (400, 3))
    ref = _reference(pts, terrain)
    for window in (12, 5):
        got = column_signed_distance(pts, terrain, window=window)
        exact = np.abs(ref) < (window - 1) * DX
        assert exact.sum() > 100
        np.testing.assert_allclose(got[exact], ref[exact], atol=1e-6)
        # Beyond the window the value only over-estimates the distance outside / exit inside.
        assert np.all(np.sign(got) == np.sign(ref))
    assert (ref < 0).sum() > 20


def _foot_points():
    return [
        SimpleNamespace(semantic="pelvis"),
        SimpleNamespace(semantic="left_ankle"),
        SimpleNamespace(semantic="left_ankle:toe"),
        SimpleNamespace(semantic="left_ankle:heel"),
        SimpleNamespace(semantic="right_ankle"),
        SimpleNamespace(semantic="left_wrist"),
    ]


def _box_terrain(top=0.3):
    """Flat floor (0) with a box of height ``top`` filling x in [0.4, 0.8), y in [0, 0.8)."""
    hf = np.zeros((40, 40))
    hf[10:20, :20] = top
    return _terrain(hf, origin=(0.0, 0.0))  # column i covers x in [i*dx-dx/2, i*dx+dx/2)


BOX_X0 = 10 * DX - DX / 2  # x of the box's low-x face


def _group(frames, heel_x, z=0.05, y=0.3):
    """(T, 6, 3) with a left foot: ankle 5 cm, toe 5 cm and heel 15 cm behind... in +x order."""
    pos = np.zeros((frames, 6, 3))
    pos[:, 0] = (0.0, 0.0, 1.0)
    pos[:, 5] = (0.0, 0.5, 1.0)
    pos[:, 4] = (0.0, -0.3, z)
    for t in range(frames):
        pos[t, 1] = (heel_x + 0.08, y, z)  # ankle
        pos[t, 2] = (heel_x + 0.16, y, z)  # toe
        pos[t, 3] = (heel_x, y, z)  # heel
    return pos


def test_group_inside_box_side_moves_horizontally_away_and_stays_rigid():
    terrain = _box_terrain()
    # The foot points toward +x (box): the toe is 6 cm into the box face.
    pos = _group(1, heel_x=BOX_X0 - 0.16 + 0.06)
    new, info = project_foot_targets(pos, _foot_points(), terrain, surface="columns", fps=30.0)
    delta = new[0] - pos[0]
    foot = [1, 2, 3]
    assert np.allclose(delta[foot], delta[foot][0])  # rigid
    moved = delta[foot][0]
    assert moved[2] == pytest.approx(0.0, abs=1e-12)
    assert moved[0] < 0 and moved[0] == pytest.approx(-0.06 - 0.002, abs=0.0025 + 1e-9)
    assert abs(moved[1]) < 1e-9
    for i in (0, 4, 5):
        np.testing.assert_array_equal(new[0, i], pos[0, i])
    assert column_signed_distance(new[0, foot], terrain).min() >= 0.002 - 1e-9
    assert info["left"]["frames_shifted"] == 1
    assert info["left"]["frames_uncleared"] == 0
    assert "right" in info  # the right foot is outside and untouched
    assert info["right"]["frames_shifted"] == 0
    np.testing.assert_allclose(
        np.linalg.norm(new[0, foot][:, None] - new[0, foot][None], axis=-1),
        np.linalg.norm(pos[0, foot][:, None] - pos[0, foot][None], axis=-1),
        atol=1e-12,
    )


def test_group_inside_box_top_moves_up():
    terrain = _box_terrain(top=0.3)
    pos = _group(1, heel_x=0.55, z=0.28)  # all over the box, 2 cm below its top
    new, info = project_foot_targets(pos, _foot_points(), terrain, fps=30.0)
    delta = (new - pos)[0, [1, 2, 3]]
    assert np.allclose(delta[:, :2], 0.0)
    assert delta[0, 2] == pytest.approx(0.02 + 0.002, abs=0.0025 + 1e-9)
    assert info["left"]["frames_shifted"] == 1


def test_group_outside_is_unchanged_and_other_limbs_never_move():
    terrain = _box_terrain()
    pos = _group(4, heel_x=0.1)
    new, info = project_foot_targets(pos, _foot_points(), terrain, fps=30.0)
    np.testing.assert_array_equal(new, pos)
    assert info["left"]["frames_shifted"] == 0 and info["left"]["max_shift_m"] == 0.0


def test_group_that_cannot_be_cleared_is_unchanged_and_counted():
    hf = np.full((40, 40), 5.0)  # a 5 m slab: nothing clears within 0.4 m
    terrain = _terrain(hf)
    pos = _group(3, heel_x=0.6, z=1.0, y=0.8)
    new, info = project_foot_targets(pos, _foot_points(), terrain, fps=30.0)
    np.testing.assert_array_equal(new, pos)
    assert info["left"]["frames_uncleared"] == 3
    assert info["left"]["frames_shifted"] == 0


def test_ramp_softens_an_abrupt_episode_and_keeps_needed_frames_clear():
    terrain = _box_terrain()
    frames = 60
    pos = _group(frames, heel_x=0.1)
    # From frame 30 on the heel is 6 cm into the box face (toe deeper).
    pos[30:, 1:4, 0] += BOX_X0 - 0.16 + 0.06 - 0.1
    new, info = project_foot_targets(pos, _foot_points(), terrain, fps=30.0)
    raw, info_raw = project_foot_targets(pos, _foot_points(), terrain, fps=30.0, ramp_s=0.0)
    i = info["left"]
    assert i["max_jump_raw_m"] > 0.05
    assert i["max_jump_ramped_m"] < 0.7 * i["max_jump_raw_m"]
    assert info_raw["left"]["max_jump_ramped_m"] == pytest.approx(i["max_jump_raw_m"])
    foot = [1, 2, 3]
    d = column_signed_distance(new[30:, foot], terrain)
    assert d.min() >= 0.002 - 1e-9
    # Ramp-in frames before the episode move (the targets leave early) but stay outside.
    assert np.any(new[:30, 1, 0] != pos[:30, 1, 0])
    assert column_signed_distance(new[:30, foot], terrain).min() >= -0.005
    # The shift never falls below the raw one in the episode.
    assert np.all(np.abs((new - pos)[30:, 2, 0]) >= np.abs((raw - pos)[30:, 2, 0]) - 1e-12)


# -- prepare_scene_targets hook ---------------------------------------------------------


def _box_under_feet(motion):
    """Replace the flat terrain with one whose central cell is a tall box over the feet."""
    hf = np.zeros((4, 4), dtype=np.float32)
    hf[2, 2] = 10.0
    t = motion.terrain
    motion.terrain = TerrainHeightfield(
        hf=hf, hf_maxmin=np.stack([hf, hf], -1), min_point=t.min_point, dx=t.dx
    )
    return motion


def _targets(pipe, motion, flag, surface="columns"):
    pipe.cfg = dataclasses.replace(
        pipe.cfg, terrain_foot_target_projection=flag, terrain_foot_target_surface=surface
    )
    return pipe.prepare_scene_targets(motion, mj_model=MujocoScene.from_robot(pipe._model).model)


@pytest.fixture
def pipe_motion(grounding_robot_pair, synthetic_terrain_motion):
    model = grounding_robot_pair[1]
    motion = _multi_frame(synthetic_terrain_motion)
    pipe = _pipeline(model, motion)
    pipe._model = model
    return pipe, motion


def test_flat_clip_and_flag_off_are_bit_identical(pipe_motion):
    pipe, motion = pipe_motion
    off = _targets(pipe, motion, False)
    on = _targets(pipe, motion, True)
    np.testing.assert_array_equal(on.positions, off.positions)
    assert off.foot_target_projection is None
    assert on.foot_target_projection is not None
    assert all(i["frames_shifted"] == 0 for i in on.foot_target_projection.values())
    motion.terrain = None
    no_terrain = _targets(pipe, motion, True)
    np.testing.assert_array_equal(no_terrain.positions, off.positions)
    assert no_terrain.foot_target_projection is None


def test_hook_moves_foot_targets_out_of_a_box(pipe_motion):
    pipe, motion = pipe_motion
    _box_under_feet(motion)
    off = _targets(pipe, motion, False)
    on = _targets(pipe, motion, True)
    assert off.foot_target_projection is None
    info = on.foot_target_projection
    assert info and any(i["frames_shifted"] for i in info.values())
    assert np.any(on.positions != off.positions)
    terrain = pipe.scaled_terrain(motion, on.z_min, on.smpl_scale)
    foot = [
        i
        for i, p in enumerate(on.robot_points)
        if str(p.semantic).split(":")[0] in ("left_ankle", "right_ankle")
    ]
    assert column_signed_distance(off.positions[:, foot], terrain).min() < -0.005
    assert column_signed_distance(on.positions[:, foot], terrain).min() >= 0.002 - 1e-6
    other = [i for i in range(on.positions.shape[1]) if i not in foot]
    np.testing.assert_array_equal(on.positions[:, other], off.positions[:, other])


def test_hook_keeps_the_unprojected_source_targets(pipe_motion):
    pipe, motion = pipe_motion
    flat = _targets(pipe, motion, True)
    assert flat.source_positions is flat.positions  # nothing moved: the same array
    _box_under_feet(motion)
    off = _targets(pipe, motion, False)
    on = _targets(pipe, motion, True)
    np.testing.assert_array_equal(on.source_positions, off.positions)
    assert np.any(on.source_positions != on.positions)
    assert off.source_positions is off.positions


def test_interaction_mesh_run_reports_projection_and_source_alignment(pipe_motion):
    pipe, motion = pipe_motion
    _box_under_feet(motion)
    pipe.cfg = dataclasses.replace(
        pipe.cfg, terrain_foot_target_projection=True, terrain_foot_target_surface="columns"
    )
    meta = pipe.run(motion).meta
    info = meta["foot_target_projection"]
    assert info and any(i["frames_shifted"] for i in info.values())
    # The robot tracks the moved targets, so the residual against the source differs.
    assert np.isfinite(meta["alignment_source_mean_m"])
    assert meta["alignment_source_mean_m"] != pytest.approx(meta["alignment_mean_m"], abs=1e-6)


# -- ramp clearance, max_shift, non-finite cells ----------------------------------------


def _left_ankle():
    return [SimpleNamespace(semantic="left_ankle")]


def test_ramp_does_not_push_a_clear_frame_into_a_neighbouring_column():
    hf = np.zeros((30, 30))
    hf[10, 10] = 0.30  # A: x, y in [0.38, 0.42]; clears a foot inside it towards +x
    hf[15, 10] = 0.30  # B: x in [0.58, 0.62], y in [0.38, 0.42]
    terrain = _terrain(hf)
    pos = np.zeros((20, 1, 3))
    pos[:, 0] = (0.579, 0.40, 0.05)  # 1 mm outside B
    pos[10:, 0] = (0.414, 0.40, 0.05)  # 6 mm inside A: needs +x 10 mm
    new, info = project_foot_targets(pos, _left_ankle(), terrain, fps=30.0, ramp_s=0.2)
    assert info["left"]["frames_shifted"] > 0
    assert column_signed_distance(new[10:], terrain).min() >= 0.002 - 1e-9
    # The width-7 ramp would copy ~5.7 mm of +x shift into frame 7 (4.7 mm inside B).
    assert column_signed_distance(new[:10], terrain).min() >= 0.0
    assert info["left"]["frames_ramp_fallback"] > 0


def test_ramp_does_not_push_an_uncleared_frame_deeper():
    hf = np.zeros((70, 70))
    hf[0:30, :] = 5.0  # slab x in [-0.02, 1.18]: from x = 0.03 the nearest exit is 5 cm away
    hf[40, 10] = 0.30  # C: x in [1.58, 1.62], y in [0.38, 0.42]
    terrain = _terrain(hf)
    pos = np.zeros((2, 1, 3))
    pos[0, 0] = (1.614, 0.40, 0.05)  # 6 mm inside C: cleared by +x 10 mm
    pos[1, 0] = (0.03, 1.40, 1.00)  # inside the slab, 5 cm from its -x face, 4 m from the top
    new, info = project_foot_targets(
        pos, _left_ankle(), terrain, fps=30.0, ramp_s=0.2, max_shift=0.03
    )  # fmt: skip
    assert info["left"]["frames_uncleared"] == 1
    assert column_signed_distance(new[:1], terrain).min() >= 0.002 - 1e-9
    d0 = column_signed_distance(pos[1:], terrain)
    # +x is the way deeper into the slab: the neighbour's ramp must not take it there.
    assert column_signed_distance(new[1:], terrain).item() >= min(d0.item(), 0.0) - 1e-9


def test_search_never_exceeds_max_shift():
    hf = np.zeros((30, 30))
    hf[10:20, :20] = 0.30  # low-x face at x = 0.38
    terrain = _terrain(hf)
    pos = np.array([[[0.3802, 0.30, 0.05]]])  # 0.2 mm inside; a 2.5 mm step would clear it
    new, info = project_foot_targets(
        pos, _left_ankle(), terrain, fps=30.0,
        trigger=0.0001, max_shift=0.0015, step=0.0025, ramp_s=0.0,
    )  # fmt: skip
    assert info["left"]["frames_uncleared"] == 1
    np.testing.assert_array_equal(new, pos)


def test_non_finite_cell_is_floor_like():
    hf = np.zeros((8, 8))
    hf[2, 2] = np.nan
    terrain = _terrain(hf)
    pos = np.array([[[2 * DX + 0.01, 2 * DX, 0.05]]])
    d = column_signed_distance(pos, terrain)
    assert d.item() == pytest.approx(0.05)
    new, info = project_foot_targets(pos, _left_ankle(), terrain, fps=30.0)
    np.testing.assert_array_equal(new, pos)
    assert info["left"]["frames_shifted"] == 0


def test_non_finite_cell_matches_frax_terrain_grid():
    pytest.importorskip("frax")
    pytest.importorskip("elastiqp")
    from hhtools.retarget.frax_backend.terrain import build_terrain_grid

    hf = np.zeros((8, 8))
    hf[2, 2] = np.nan
    terrain = _terrain(hf)
    pos = np.array([[[2 * DX + 0.01, 2 * DX, 0.05]]])
    grid = build_terrain_grid(hf, terrain.min_point, terrain.dx, shape_bucket=1)
    d = column_signed_distance(pos, terrain)
    assert d.item() == pytest.approx(float(grid.signed_distance(pos[0]).item()), abs=1e-6)


# -- continuity, interpolated surface, bounds, run-owned targets, returned-motion alignment --


def _terrain_h(h, dx):
    h = np.asarray(h, dtype=np.float32)
    return TerrainHeightfield(
        hf=h, hf_maxmin=np.stack([h, h], -1), min_point=np.zeros(2, dtype=np.float32), dx=dx
    )


def _project_1(terrain, xyz, **kw):
    pos = np.array(xyz, dtype=float).reshape(-1, 1, 3)
    new, info = project_foot_targets(pos, _left_ankle(), terrain, fps=30.0, **kw)
    return pos[:, 0], new[:, 0], info["left"]


def _wall():
    h = np.zeros((11, 11))
    h[5, :] = 0.5  # x in [0.9, 1.1], every y; dx = 0.2
    return _terrain_h(h, 0.2)


@pytest.mark.parametrize("surface", ["columns", "both"])
def test_exit_stays_continuous_when_the_source_crosses_a_wall_centre(surface):
    terrain = _wall()
    xyz = [(0.999, 1.0, 0.05)] * 10 + [(1.001, 1.0, 0.05)] * 10
    src, new, info = _project_1(terrain, xyz, surface=surface)
    assert info["frames_uncleared"] == 0
    assert column_signed_distance(new, terrain).min() >= 0.002 - 1e-9
    # Independent of the ramp: the shortest exits on either side of the centre are opposite
    # (0.1025 m each way), a single common exit exists, and the target must not flip faces.
    assert np.linalg.norm(np.diff(new, axis=0), axis=1).max() < 0.05, info


def test_clearance_holds_against_the_interpolated_surface_on_a_step_flank():
    h = np.zeros((30, 30))
    h[10:, :] = 0.30  # samples 0 at x = 0.36 and 0.30 at x = 0.40: column face at x = 0.38
    terrain = _terrain_h(h, DX)
    xyz = [(0.386, 0.40, 0.05)]
    _, cols, _ = _project_1(terrain, xyz, surface="columns")
    # Column exit: 8 mm to the face + 2 mm clearance on the 2.5 mm step grid.
    assert cols[0, 0] == pytest.approx(0.386 - 0.010)
    surf_cols = np.interp(cols[0, 0], [0.36, 0.40], [0.0, 0.30])
    assert cols[0, 2] < surf_cols  # 7 cm under the interpolated surface (0.12 m)
    _, both, info = _project_1(terrain, xyz)  # default surface="both"
    assert info["frames_uncleared"] == 0
    surf = np.interp(both[0, 0], [0.36, 0.40], [0.0, 0.30])
    assert both[0, 2] - surf >= 0.002 - 1e-9
    assert column_signed_distance(both, terrain).min() >= 0.002 - 1e-9


def test_invalid_surface_is_rejected():
    with pytest.raises(ValueError):
        _project_1(_wall(), [(1.0, 1.0, 0.05)], surface="mesh")


def test_uncleared_frame_stays_put_next_to_a_shifted_neighbour():
    hf = np.zeros((70, 70))
    hf[0:30, :] = 5.0  # slab x in [-0.02, 1.18]
    hf[40, 10] = 0.30  # C: x in [1.58, 1.62], y in [0.38, 0.42]
    terrain = _terrain(hf)
    xyz = [(1.614, 0.40, 0.05), (0.20, 1.40, 1.00)]  # frame 1: 0.22 m from the slab face
    src, new, info = _project_1(terrain, xyz, max_shift=0.03)
    assert info["frames_uncleared"] == 1
    assert info["frames_shifted"] == 1
    assert column_signed_distance(new[:1], terrain).min() >= 0.002 - 1e-9
    np.testing.assert_array_equal(new[1], src[1])


def test_far_off_grid_dent_below_the_floor_is_not_a_collision():
    terrain = _terrain(np.zeros((8, 8)))
    p = np.array([[-4.0, 0.12, -0.001], [-4.0, 0.12, -0.1]])
    # Off the grid the floor plane is the only solid: depth is vertical.
    np.testing.assert_allclose(column_signed_distance(p, terrain), [-0.001, -0.1], atol=1e-9)
    src, new, info = _project_1(terrain, p[:1])
    np.testing.assert_array_equal(new, src)
    assert info["frames_shifted"] == 0


def test_step_grid_never_exceeds_a_sub_step_limit():
    hf = np.zeros((30, 30))
    hf[10:20, :20] = 0.30
    cap = 0.0025 * (1 - 5e-10)
    src, new, info = _project_1(
        _terrain(hf), [(0.3802, 0.30, 0.05)],
        max_shift=cap, step=0.0025, trigger=0.0001, ramp_s=0.0, surface="columns",
    )  # fmt: skip
    assert info["max_shift_m"] <= cap
    assert info["frames_uncleared"] == 1


def test_ramped_shift_obeys_the_vector_budget_across_axis_changes():
    terrain = _wall()
    # +x exits (0.100) and +z exits (0.100) in adjacent frames: the componentwise ramp
    # envelope would give (0.1, 0, 0.1), norm 0.141.
    xyz = [(1.003, 1.0, 0.399), (1.0, 1.0, 0.403)]
    src, new, info = _project_1(terrain, xyz, max_shift=0.1, surface="columns")
    assert info["frames_uncleared"] == 0
    assert column_signed_distance(new, terrain).min() >= 0.002 - 1e-9
    assert np.linalg.norm(new - src, axis=1).max() <= 0.1 + 1e-9, info


def test_fallback_keeps_the_shift_within_the_budget_after_capping():
    terrain = _wall()
    xyz = [(1.003, 1.0, 0.399)] * 3 + [(1.0, 1.0, 0.403)] * 3
    src, new, info = _project_1(terrain, xyz, max_shift=0.1, surface="columns")
    assert np.linalg.norm(new - src, axis=1).max() <= 0.1 + 1e-9
    assert info["max_shift_m"] <= 0.1 + 1e-9


def test_scene_targets_belong_to_the_run_that_reports_them(pipe_motion):
    pipe, motion = pipe_motion
    _box_under_feet(motion)
    pipe.cfg = dataclasses.replace(pipe.cfg, terrain_foot_target_surface="columns")
    baseline = pipe.run(motion).meta["foot_target_projection"]
    assert baseline and any(i["frames_shifted"] for i in baseline.values())

    other = dataclasses.replace(
        motion, positions=motion.positions[:1], quaternions=motion.quaternions[:1], terrain=None
    )
    mj = MujocoScene.from_robot(pipe._model).model
    nested = []

    def callback(stage, cur, total):
        if stage == "precompute" and not nested:
            nested.append(pipe.precompute_laplacian_targets(other, mj_model=mj))

    meta = pipe.run(motion, progress_callback=callback).meta
    assert len(nested) == 1 and len(nested[0]) == 5 and len(nested[0][0]) == 1
    assert meta["foot_target_projection"] == baseline
    assert not hasattr(pipe, "_last_scene_targets")


def _fk_points(model, joint_q, points):
    import mujoco

    data = mujoco.MjData(model)
    out = []
    for row in joint_q:
        data.qpos[:] = model.qpos0
        data.qpos[:3] = row[:3]
        data.qpos[3:7] = row[[6, 3, 4, 5]]  # xyzw -> wxyz
        data.qpos[7:] = row[7:]
        mujoco.mj_forward(model, data)
        out.append(
            [
                data.body(p.body_name).xpos
                + data.body(p.body_name).xmat.reshape(3, 3) @ np.asarray(p.local_offset)
                for p in points
            ]
        )
    return np.asarray(out)


def test_interaction_mesh_alignment_is_measured_on_the_returned_motion(pipe_motion, monkeypatch):
    from hhtools.robot import retarget_profile

    pipe, motion = pipe_motion
    _box_under_feet(motion)
    pipe.cfg = dataclasses.replace(pipe.cfg, terrain_foot_target_surface="columns")
    mj = MujocoScene.from_robot(pipe._model).model
    st = pipe.prepare_scene_targets(motion, mj_model=mj)
    plain = pipe.run(motion)

    def shift_root(q, *args, **kwargs):
        out = np.array(q, copy=True)
        out[:, 0] += 0.25
        return out

    monkeypatch.setattr(retarget_profile, "apply_upper_body_roll_narrowing_post_ik", shift_root)
    edited = pipe.run(motion)
    assert edited.joint_q.shape[1] == mj.nq  # free joint + scalar hinges only
    pts = _fk_points(mj, edited.joint_q, st.robot_points)
    for key, ref in (("alignment", st.positions), ("alignment_source", st.source_positions)):
        err = np.linalg.norm(pts - ref, axis=-1)
        assert edited.meta[f"{key}_mean_m"] == pytest.approx(err.mean(), abs=1e-5)
        assert edited.meta[f"{key}_max_m"] == pytest.approx(err.max(), abs=1e-5)
    # The forced edit is visible in the report (it is not the solver trajectory's residual).
    plain_mean = plain.meta["alignment_mean_m"]
    assert edited.meta["alignment_mean_m"] != pytest.approx(plain_mean, abs=1e-3)


def test_one_row_terrain_has_no_interpolated_surface_beyond_its_nodes() -> None:
    """A (1, 4) grid is edge-replicated for interpolation, but the replica is not terrain."""
    from hhtools.retarget.interaction_mesh.target_projection import _columns, _surface_height

    hf = np.full((1, 4), 0.3, dtype=np.float32)
    terrain = TerrainHeightfield(hf, np.stack([hf, hf], -1), np.zeros(2), 0.1)
    cols = _columns(terrain, 3)
    beyond = _surface_height(cols, np.array([[0.06, 0.15]]))
    on_nodes = _surface_height(cols, np.array([[0.0, 0.15]]))
    assert beyond[0] == pytest.approx(cols.floor_z)
    assert on_nodes[0] == pytest.approx(0.3)
