from __future__ import annotations

from pathlib import Path

import pytest

from hhtools.integrations import gvhmr


def _runtime_tree(root: Path, body_models_root: Path) -> None:
    (root / "tools" / "demo").mkdir(parents=True)
    (root / "tools" / "demo" / "demo.py").touch()
    for relative in gvhmr._PUBLIC_CHECKPOINTS.values():  # noqa: SLF001
        checkpoint = root / "inputs" / "checkpoints" / relative
        checkpoint.parent.mkdir(parents=True, exist_ok=True)
        checkpoint.touch()
    smplx = body_models_root / "smplx" / "SMPLX_NEUTRAL.npz"
    smplx.parent.mkdir(parents=True, exist_ok=True)
    smplx.touch()


def test_status_requires_licensed_smplx_model(tmp_path: Path, monkeypatch) -> None:
    root = tmp_path / "GVHMR"
    body_models = tmp_path / "body-models"
    _runtime_tree(root, body_models)
    (body_models / "smplx" / "SMPLX_NEUTRAL.npz").unlink()
    monkeypatch.setattr(gvhmr.shutil, "which", lambda _command: "docker")
    monkeypatch.setattr(gvhmr, "_run_probe", lambda *_args, **_kwargs: (True, "ok"))

    status = gvhmr.gvhmr_status(gvhmr.GvhmrConfig(root=root, body_models_root=body_models))

    assert status["ready"] is False
    assert status["checks"]["smplx_neutral"] is False
    assert any("SMPL-X" in item for item in status["missing"])
    assert status["uses_official_weights"] is True
    assert status["supports_custom_weights"] is True
    assert status["training_enabled"] is False


def test_command_uses_isolated_gpu_container_and_no_training(tmp_path: Path) -> None:
    root = tmp_path / "GVHMR"
    body_models = tmp_path / "licensed-models"
    _runtime_tree(root, body_models)
    job_root = tmp_path / "job"
    job_root.mkdir()
    video = job_root / "source clip.mp4"
    video.touch()
    config = gvhmr.GvhmrConfig(
        root=root,
        body_models_root=body_models,
        image="hhtools-gvhmr:test",
        docker="docker",
    )

    command = gvhmr.build_gvhmr_command(
        config,
        video_path=video,
        job_root=job_root,
        static_cam=True,
    )

    assert command[:3] == ["docker", "run", "--rm"]
    assert command[command.index("--gpus") + 1] == "all"
    assert command[-4:] == [
        "/work/source clip.mp4",
        "--output-root",
        "/work/output",
        "--static-cam",
    ]
    assert "hhtools-gvhmr:test" in command
    assert not any("train" in argument.lower() for argument in command)
    assert any("target=/workspace/gvhmr,readonly" in argument for argument in command)
    assert any(
        "target=/workspace/gvhmr/inputs/checkpoints/body_models,readonly" in argument
        for argument in command
    )


def test_command_rejects_video_outside_job_root(tmp_path: Path) -> None:
    root = tmp_path / "GVHMR"
    body_models = tmp_path / "body-models"
    _runtime_tree(root, body_models)
    job_root = tmp_path / "job"
    job_root.mkdir()
    video = tmp_path / "outside.mp4"
    video.touch()

    with pytest.raises(ValueError):
        gvhmr.build_gvhmr_command(
            gvhmr.GvhmrConfig(root=root, body_models_root=body_models),
            video_path=video,
            job_root=job_root,
        )


def test_command_rejects_non_video_extension(tmp_path: Path) -> None:
    root = tmp_path / "GVHMR"
    body_models = tmp_path / "body-models"
    _runtime_tree(root, body_models)
    job_root = tmp_path / "job"
    job_root.mkdir()
    source = job_root / "payload.txt"
    source.touch()

    with pytest.raises(ValueError, match="unsupported video extension"):
        gvhmr.build_gvhmr_command(
            gvhmr.GvhmrConfig(root=root, body_models_root=body_models),
            video_path=source,
            job_root=job_root,
        )


def test_command_passes_custom_checkpoint_from_isolated_job_root(
    tmp_path: Path,
) -> None:
    root = tmp_path / "GVHMR"
    body_models = tmp_path / "body-models"
    _runtime_tree(root, body_models)
    job_root = tmp_path / "job"
    checkpoint_dir = job_root / "checkpoint"
    checkpoint_dir.mkdir(parents=True)
    video = job_root / "source.mp4"
    checkpoint = checkpoint_dir / "custom.ckpt"
    video.touch()
    checkpoint.touch()

    command = gvhmr.build_gvhmr_command(
        gvhmr.GvhmrConfig(root=root, body_models_root=body_models),
        video_path=video,
        job_root=job_root,
        checkpoint_path=checkpoint,
    )

    assert command[command.index("--checkpoint") + 1] == "/work/checkpoint/custom.ckpt"


def test_command_rejects_custom_checkpoint_outside_job_root(tmp_path: Path) -> None:
    root = tmp_path / "GVHMR"
    body_models = tmp_path / "body-models"
    _runtime_tree(root, body_models)
    job_root = tmp_path / "job"
    job_root.mkdir()
    video = job_root / "source.mp4"
    checkpoint = tmp_path / "outside.ckpt"
    video.touch()
    checkpoint.touch()

    with pytest.raises(ValueError):
        gvhmr.build_gvhmr_command(
            gvhmr.GvhmrConfig(root=root, body_models_root=body_models),
            video_path=video,
            job_root=job_root,
            checkpoint_path=checkpoint,
        )
