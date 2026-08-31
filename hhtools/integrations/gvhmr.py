"""Isolated GVHMR video-to-motion runtime.

GVHMR has a large, Linux/CUDA-specific dependency graph that should not be
imported into the hhtools web process. This module validates the local official
checkout and invokes a pinned Docker image with argument lists (never a shell).
"""

from __future__ import annotations

import json
import os
import queue
import re
import shutil
import subprocess
import threading
import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

GVHMR_ROOT_ENV = "HHTOOLS_GVHMR_ROOT"
GVHMR_IMAGE_ENV = "HHTOOLS_GVHMR_IMAGE"
GVHMR_BODY_MODELS_ENV = "HHTOOLS_GVHMR_BODY_MODELS"
GVHMR_TIMEOUT_ENV = "HHTOOLS_GVHMR_TIMEOUT_SECONDS"

DEFAULT_IMAGE = "hhtools-gvhmr:cu128"
DEFAULT_TIMEOUT_SECONDS = 2 * 60 * 60

_PUBLIC_CHECKPOINTS = {
    "GVHMR": Path("gvhmr/gvhmr_siga24_release.ckpt"),
    "HMR2": Path("hmr2/epoch=10-step=25000.ckpt"),
    "ViTPose": Path("vitpose/vitpose-h-multi-coco.pth"),
    "YOLOv8": Path("yolo/yolov8x.pt"),
}
_VIDEO_SUFFIXES = frozenset({".mp4", ".mov", ".mkv", ".avi", ".webm", ".m4v"})
_CHECKPOINT_SUFFIXES = frozenset({".ckpt", ".pt", ".pth"})
_PROGRESS_RE = re.compile(r"^HHTOOLS_PROGRESS\s+([0-9.]+)\s+(.*)$")
_RESULT_PREFIX = "HHTOOLS_RESULT "


@dataclass(frozen=True)
class GvhmrConfig:
    root: Path
    body_models_root: Path
    image: str = DEFAULT_IMAGE
    docker: str = "docker"
    timeout_seconds: int = DEFAULT_TIMEOUT_SECONDS

    @classmethod
    def from_environment(cls) -> GvhmrConfig:
        root = _default_root()
        body_models = Path(
            os.environ.get(
                GVHMR_BODY_MODELS_ENV,
                root / "inputs" / "checkpoints" / "body_models",
            )
        ).expanduser()
        raw_timeout = os.environ.get(GVHMR_TIMEOUT_ENV, str(DEFAULT_TIMEOUT_SECONDS))
        try:
            timeout = max(60, int(raw_timeout))
        except ValueError:
            timeout = DEFAULT_TIMEOUT_SECONDS
        return cls(
            root=root,
            body_models_root=body_models,
            image=os.environ.get(GVHMR_IMAGE_ENV, DEFAULT_IMAGE),
            docker=shutil.which("docker") or "docker",
            timeout_seconds=timeout,
        )


def _default_root() -> Path:
    override = os.environ.get(GVHMR_ROOT_ENV)
    if override:
        return Path(override).expanduser()
    windows_default = Path("C:/GVHMR")
    if windows_default.is_dir():
        return windows_default
    return Path.home() / "GVHMR"


def _run_probe(args: list[str], *, timeout: float = 10.0) -> tuple[bool, str]:
    try:
        completed = subprocess.run(
            args,
            capture_output=True,
            check=False,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
        )
    except (OSError, subprocess.TimeoutExpired) as err:
        return False, str(err)
    output = (completed.stdout or completed.stderr or "").strip()
    return completed.returncode == 0, output


def gvhmr_status(config: GvhmrConfig | None = None) -> dict[str, Any]:
    """Return actionable readiness checks without importing GVHMR or CUDA."""

    cfg = config or GvhmrConfig.from_environment()
    checkpoint_root = cfg.root / "inputs" / "checkpoints"
    checks: dict[str, bool] = {
        "official_repo": (cfg.root / "tools" / "demo" / "demo.py").is_file(),
        "docker_cli": shutil.which(cfg.docker) is not None or Path(cfg.docker).is_file(),
    }
    missing: list[str] = []
    if not checks["official_repo"]:
        missing.append(f"GVHMR official checkout: {cfg.root}")

    for label, relative in _PUBLIC_CHECKPOINTS.items():
        available = (checkpoint_root / relative).is_file()
        checks[f"checkpoint_{label.lower()}"] = available
        if not available:
            missing.append(f"{label} checkpoint: {checkpoint_root / relative}")

    smplx = cfg.body_models_root / "smplx" / "SMPLX_NEUTRAL.npz"
    checks["smplx_neutral"] = smplx.is_file()
    if not checks["smplx_neutral"]:
        missing.append(
            "licensed SMPL-X neutral model: "
            f"{smplx} (download after accepting the official SMPL-X license)"
        )

    docker_ready = False
    image_ready = False
    if checks["docker_cli"]:
        docker_ready, _ = _run_probe(
            [cfg.docker, "version", "--format", "{{.Server.Version}}"],
        )
        if docker_ready:
            image_ready, _ = _run_probe(
                [cfg.docker, "image", "inspect", cfg.image, "--format", "{{.Id}}"],
            )
    checks["docker_engine"] = docker_ready
    checks["runtime_image"] = image_ready
    if not docker_ready:
        missing.append("running Docker Desktop Linux engine")
    elif not image_ready:
        missing.append(f"GVHMR runtime image: {cfg.image}")

    return {
        "ready": all(checks.values()),
        "checks": checks,
        "missing": missing,
        "root": str(cfg.root),
        "body_models_root": str(cfg.body_models_root),
        "image": cfg.image,
        "uses_official_weights": True,
        "supports_custom_weights": True,
        "training_enabled": False,
    }


def ensure_gvhmr_ready(config: GvhmrConfig | None = None) -> GvhmrConfig:
    cfg = config or GvhmrConfig.from_environment()
    status = gvhmr_status(cfg)
    if not status["ready"]:
        details = "\n- ".join(status["missing"])
        raise RuntimeError(f"GVHMR is not ready:\n- {details}")
    return cfg


def _container_path(host_path: Path, mount_root: Path, container_root: str) -> str:
    relative = host_path.resolve().relative_to(mount_root.resolve())
    suffix = "/".join(relative.parts)
    return f"{container_root}/{suffix}" if suffix else container_root


def build_gvhmr_command(
    config: GvhmrConfig,
    *,
    video_path: Path,
    job_root: Path,
    checkpoint_path: Path | None = None,
    static_cam: bool = True,
    f_mm: int | None = None,
) -> list[str]:
    """Build the Docker argv for one isolated inference job."""

    root = config.root.resolve()
    body_models = config.body_models_root.resolve()
    video = video_path.resolve()
    work = job_root.resolve()
    video.relative_to(work)
    if video.suffix.lower() not in _VIDEO_SUFFIXES:
        raise ValueError(f"unsupported video extension: {video.suffix or '<none>'}")
    checkpoint: Path | None = None
    if checkpoint_path is not None:
        checkpoint = checkpoint_path.resolve()
        checkpoint.relative_to(work)
        if not checkpoint.is_file():
            raise FileNotFoundError(f"custom checkpoint does not exist: {checkpoint}")
        if checkpoint.suffix.lower() not in _CHECKPOINT_SUFFIXES:
            raise ValueError(
                f"unsupported checkpoint extension: {checkpoint.suffix or '<none>'}"
            )

    output = work / "output"
    output.mkdir(parents=True, exist_ok=True)
    command = [
        config.docker,
        "run",
        "--rm",
        "--gpus",
        "all",
        "--name",
        f"hhtools-gvhmr-{uuid.uuid4().hex[:10]}",
        "--mount",
        f"type=bind,source={root},target=/workspace/gvhmr,readonly",
        "--mount",
        f"type=bind,source={work},target=/work",
    ]
    default_body_models = (root / "inputs" / "checkpoints" / "body_models").resolve()
    if body_models != default_body_models:
        command.extend(
            [
                "--mount",
                (
                    "type=bind,"
                    f"source={body_models},"
                    "target=/workspace/gvhmr/inputs/checkpoints/body_models,readonly"
                ),
            ]
        )
    command.extend(
        [
            config.image,
            "--video",
            _container_path(video, work, "/work"),
            "--output-root",
            "/work/output",
        ]
    )
    if checkpoint is not None:
        command.extend(
            ["--checkpoint", _container_path(checkpoint, work, "/work")]
        )
    if static_cam:
        command.append("--static-cam")
    if f_mm is not None:
        if f_mm <= 0:
            raise ValueError("f_mm must be positive")
        command.extend(["--f-mm", str(f_mm)])
    return command


def run_gvhmr(
    video_path: Path,
    job_root: Path,
    *,
    checkpoint_path: Path | None = None,
    static_cam: bool = True,
    f_mm: int | None = None,
    config: GvhmrConfig | None = None,
    progress: Callable[[float, str], None] | None = None,
) -> Path:
    """Run GVHMR and return the generated ``hmr4d_results.pt`` path."""

    cfg = ensure_gvhmr_ready(config)
    command = build_gvhmr_command(
        cfg,
        video_path=video_path,
        job_root=job_root,
        checkpoint_path=checkpoint_path,
        static_cam=static_cam,
        f_mm=f_mm,
    )
    process = subprocess.Popen(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    result_container_path: str | None = None
    recent: list[str] = []
    output_lines: queue.Queue[str | None] = queue.Queue()

    def read_output() -> None:
        assert process.stdout is not None
        try:
            for raw_line in process.stdout:
                output_lines.put(raw_line)
        finally:
            output_lines.put(None)

    reader = threading.Thread(target=read_output, name="gvhmr-output", daemon=True)
    reader.start()
    deadline = time.monotonic() + cfg.timeout_seconds
    timed_out = False
    try:
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                timed_out = True
                break
            try:
                raw = output_lines.get(timeout=min(0.5, remaining))
            except queue.Empty:
                if process.poll() is not None and not reader.is_alive():
                    break
                continue
            if raw is None:
                break
            line = raw.strip()
            if line:
                recent.append(line)
                recent = recent[-30:]
            match = _PROGRESS_RE.match(line)
            if match and progress is not None:
                progress(float(match.group(1)), match.group(2))
            elif line.startswith(_RESULT_PREFIX):
                payload = json.loads(line[len(_RESULT_PREFIX) :])
                result_container_path = str(payload["result_path"])
        if timed_out:
            raise TimeoutError(
                f"GVHMR exceeded the {cfg.timeout_seconds}-second inference timeout"
            )
        return_code = process.wait(timeout=max(1.0, deadline - time.monotonic()))
    except Exception:
        process.kill()
        process.wait(timeout=30)
        try:
            container_name = command[command.index("--name") + 1]
            _run_probe([cfg.docker, "rm", "--force", container_name], timeout=30)
        except (ValueError, IndexError):
            pass
        raise
    if return_code != 0:
        diagnostic = "\n".join(recent[-12:])
        raise RuntimeError(
            f"GVHMR container exited with code {return_code}.\n{diagnostic}"
        )
    if not result_container_path or not result_container_path.startswith("/work/"):
        raise RuntimeError("GVHMR completed without publishing a result path")
    result = job_root.resolve() / Path(result_container_path).relative_to("/work")
    if not result.is_file():
        raise RuntimeError(f"GVHMR result was not found on the host: {result}")
    if progress is not None:
        progress(1.0, "GVHMR motion ready")
    return result


__all__ = [
    "DEFAULT_IMAGE",
    "GVHMR_BODY_MODELS_ENV",
    "GVHMR_IMAGE_ENV",
    "GVHMR_ROOT_ENV",
    "GvhmrConfig",
    "build_gvhmr_command",
    "ensure_gvhmr_ready",
    "gvhmr_status",
    "run_gvhmr",
]
