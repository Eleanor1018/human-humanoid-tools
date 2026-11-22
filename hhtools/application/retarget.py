"""Human-to-robot retarget runtime helpers."""

from __future__ import annotations

from typing import TYPE_CHECKING

from hhtools.application.progress import _set_retarget_job_clip_progress
from hhtools.application.robots import (
    _join_robot_prewarm,
    _require_frax_package,
    _require_newton_package,
)

if TYPE_CHECKING:
    from hhtools.application.state import SessionState


def _request_human_height(body: dict, preset, reference: str) -> float:
    """Resolve source-human height from the request, with a scaler-aware default."""
    from hhtools.robot.retarget_profile import default_human_height

    raw = body.get("human_height")
    if raw is not None:
        try:
            val = float(raw)
        except (TypeError, ValueError):
            val = 0.0
        if val > 0.1:
            return val
    return default_human_height(preset, reference)


def _scene_pipeline_scaler(preset, reference, model, motion, human_height, cal_path):
    """Human-to-robot scaler for a scene solver, from a calibration or a bundled scaler."""
    from hhtools.retarget.calibration import load_calibration
    from hhtools.retarget.newton_basic.scaler import HumanToRobotScaler
    from hhtools.robot.retarget_profile import resolve_retarget_scaler_config

    calibration = load_calibration(cal_path) if cal_path is not None else None
    scaler_cfg = resolve_retarget_scaler_config(
        preset,
        reference,
        calibration=calibration,
        model=model,
        motion=motion,
        human_height=human_height,
    )
    return HumanToRobotScaler(motion.hierarchy, scaler_cfg, human_height=human_height)


def _scene_progress(job, *, compiled: bool):
    """Map ``(stage, done, total)`` scene-solver progress onto the job's clip progress."""

    floor = [0.04]  # the setup step already reported this

    def _set(job_, value: float, message: str) -> None:
        # Progress never moves backwards (the setup step already reported 4%).
        floor[0] = max(floor[0], value)
        _set_retarget_job_clip_progress(job_, floor[0], message)

    def _cb(stage: str, cur: int, tot: int) -> None:
        if job is None:
            return
        frac_in = cur / max(1, tot)
        if stage == "precompute":
            _set(job, 0.3 * frac_in, f"预处理 {cur}/{tot}")
        elif stage == "build":
            _set(job, 0.3 + 0.1 * frac_in, "正在构建场景与求解器…")
        elif stage == "post":
            _set(job, 0.95, "求解完成，正在后处理…")
        elif compiled and stage == "mpc":
            # The FRAX scene solve is one compiled scan: only its ends are reported.
            if cur <= 0:
                _set(job, 0.4, f"FRAX 场景整段求解 {tot} 帧（首次需编译，请稍候）…")
            else:
                _set(job, 0.92, "FRAX 场景求解完成…")
        else:
            _set(job, 0.3 + 0.68 * frac_in, f"MPC 求解 {cur}/{tot}")

    return _cb


def _retarget_scene_clip(
    model,
    motion,
    reference,
    backend,
    human_height,
    job,
    *,
    preset,
    cal_path,
    foot_clamp_anti_penetration,
):
    """Run a terrain / object clip on the FRAX scene solver or interaction-mesh."""
    from hhtools.retarget.interaction_mesh.config import InteractionMeshPipelineConfig

    im_cfg = InteractionMeshPipelineConfig()
    if foot_clamp_anti_penetration is not None:
        im_cfg.post_mpc_foot_clamps = bool(foot_clamp_anti_penetration)
        if not im_cfg.post_mpc_foot_clamps:
            im_cfg.min_foot_clearance_m = 0.0

    if backend == "frax":
        _require_frax_package()
        if job is not None:
            _set_retarget_job_clip_progress(
                job,
                0.04,
                "正在初始化 FRAX 场景求解器（首次会编译求解器，之后会复用缓存）…",
            )
        from hhtools.retarget.frax_backend import FraxScenePipeline

        if cal_path is not None:
            pipe = FraxScenePipeline.from_calibration(
                model,
                motion,
                str(cal_path),
                human_height=human_height,
                front_config=im_cfg,
            )
        else:
            scaler = _scene_pipeline_scaler(
                preset, reference, model, motion, human_height, cal_path
            )
            pipe = FraxScenePipeline(model, scaler, front_config=im_cfg)
        return pipe.run(motion, progress_callback=_scene_progress(job, compiled=True))

    from hhtools.retarget.interaction_mesh.pipeline import InteractionMeshPipeline

    if job is not None:
        _set_retarget_job_clip_progress(
            job,
            0.04,
            "正在构建 Interaction-Mesh 场景（新机器人首次较慢）…",
        )
    if cal_path is not None:
        pipe = InteractionMeshPipeline.from_calibration(
            model,
            motion,
            str(cal_path),
            human_height=human_height,
            cfg=im_cfg,
        )
    else:
        scaler = _scene_pipeline_scaler(preset, reference, model, motion, human_height, cal_path)
        pipe = InteractionMeshPipeline(robot=model, scaler=scaler, cfg=im_cfg)
    cb = _scene_progress(job, compiled=False)
    try:
        try:
            return pipe.run(motion, progress_callback=cb)
        except TypeError:
            return pipe.run(motion)
    except ModuleNotFoundError as err:
        if "osqp" in str(err).lower():
            raise ValueError(
                "interaction-mesh retarget on terrain needs the OSQP solver. "
                "Install it with `uv pip install osqp` (or re-run "
                "`uv sync --extra web`)."
            ) from err
        raise


def _retarget_single(
    model,
    robot_name,
    motion,
    reference,
    backend,
    ik_iters,
    human_height,
    limit_frames,
    job,
    *,
    state: SessionState | None = None,
    foot_clamp_anti_penetration: bool | None = None,
    preset=None,
):
    """Run one clip through the requested backend, returning RetargetedMotion."""
    from hhtools.retarget.calibration import resolve_preset_calibration_file
    from hhtools.robot.retarget_profile import bundled_scaler_path

    if preset is None:
        from hhtools.robot.registry import get as get_preset

        preset = get_preset(robot_name)
    elif preset.name != robot_name:
        raise ValueError("the injected robot preset does not match the requested robot")
    cal_path = resolve_preset_calibration_file(preset, reference)
    if cal_path is None and bundled_scaler_path(preset, reference) is None:
        raise ValueError(
            f"robot {robot_name!r} not calibrated for reference {reference!r}; calibrate first"
        )

    if limit_frames:
        lf = int(limit_frames)
        if motion.num_frames > lf:
            motion.positions = motion.positions[:lf]
            motion.quaternions = motion.quaternions[:lf]
            for obj in motion.objects:
                obj.positions = obj.positions[:lf]
                obj.quaternions = obj.quaternions[:lf]

    has_scene = getattr(motion, "terrain", None) is not None or bool(
        getattr(motion, "objects", None)
    )

    if backend == "interaction_mesh" or (backend == "frax" and has_scene):
        return _retarget_scene_clip(
            model,
            motion,
            reference,
            backend,
            human_height,
            job,
            preset=preset,
            cal_path=cal_path,
            foot_clamp_anti_penetration=foot_clamp_anti_penetration,
        )

    use_frax = backend == "frax"
    if use_frax:
        _require_frax_package()
    else:
        _require_newton_package()

    from hhtools.retarget.calibration import load_calibration
    from hhtools.robot.retarget_profile import (
        build_feet_stabilizer_config,
        build_pipeline_config_for_preset,
        resolve_retarget_scaler_config,
    )

    if job is not None:
        _set_retarget_job_clip_progress(job, 0.03, "正在加载标定与缩放参数…")
    if state is not None and not use_frax:
        _join_robot_prewarm(state, robot_name, job)

    if not use_frax:
        from hhtools.retarget.newton_basic._warp_config import configure as configure_warp_cache

        configure_warp_cache()
    calibration = load_calibration(cal_path) if cal_path is not None else None
    scaler_cfg = resolve_retarget_scaler_config(
        preset,
        reference,
        calibration=calibration,
        model=model,
        motion=motion,
        human_height=human_height,
    )
    feet_cfg = build_feet_stabilizer_config(preset, reference, model=model)
    pipeline_cfg = build_pipeline_config_for_preset(
        preset,
        reference,
        ik_iterations=ik_iters,
        foot_clamp_anti_penetration=foot_clamp_anti_penetration,
    )
    if use_frax:
        if job is not None:
            _set_retarget_job_clip_progress(
                job, 0.06, "正在初始化 FRAX（首次会编译求解器，之后会复用缓存）…"
            )
        from hhtools.retarget.frax_backend import FraxPipeline

        frax_pipeline = FraxPipeline(
            model,
            scaler_config=scaler_cfg,
            pipeline_config=pipeline_cfg,
            feet_stabilizer_config=feet_cfg,
            human_height=human_height,
        )

        def _frax_cb(done: int, total: int) -> None:
            if job is None:
                return
            if done <= 0:
                _set_retarget_job_clip_progress(
                    job, 0.1, f"FRAX 整段求解 {total} 帧（首次需编译，请稍候）…"
                )
            else:
                _set_retarget_job_clip_progress(job, 0.95, "FRAX 求解完成，正在后处理…")

        return frax_pipeline.run(motion, progress_callback=_frax_cb)

    from hhtools.retarget.newton_basic import NewtonBasicPipeline

    if job is not None:
        try:
            from hhtools.retarget.newton_basic.pipeline import is_newton_ik_prewarmed

            prewarmed = is_newton_ik_prewarmed(robot_name)
        except Exception:
            prewarmed = False
        _set_retarget_job_clip_progress(
            job,
            0.06,
            (
                "正在初始化 Newton IK…"
                if prewarmed
                else "正在初始化 Newton IK（首次会编译 GPU 内核，之后会复用缓存）…"
            ),
        )
    pipeline = NewtonBasicPipeline(
        model,
        scaler_config=scaler_cfg,
        pipeline_config=pipeline_cfg,
        feet_stabilizer_config=feet_cfg,
        human_height=human_height,
        configure_warp=False,
    )

    def _cb(done: int, total: int) -> None:
        if job is None:
            return
        if done <= 0:
            _set_retarget_job_clip_progress(
                job,
                0.08,
                "正在捕获 CUDA 图 / 准备逐帧 IK（首次较慢，请耐心等待）…",
            )
        else:
            _set_retarget_job_clip_progress(
                job,
                min(0.98, 0.1 + 0.88 * (done / max(1, total))),
                f"IK 求解 {done}/{total}",
            )

    try:
        return pipeline.run(motion, progress_callback=_cb)
    except TypeError:
        return pipeline.run(motion)


__all__ = ["_request_human_height", "_retarget_single"]
