from __future__ import annotations

import importlib.util
from pathlib import Path
from types import ModuleType

import pytest


def _load_worker() -> ModuleType:
    worker_path = Path(__file__).parents[1] / "hhtools" / "integrations" / "gvhmr_worker.py"
    spec = importlib.util.spec_from_file_location("hhtools_gvhmr_worker", worker_path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_hydra_alias_handles_common_non_override_safe_video_names(tmp_path: Path) -> None:
    worker = _load_worker()
    video = tmp_path / "视频 (take=1),#final.mp4"
    video.write_bytes(b"video")
    output_root = tmp_path / "output"
    output_root.mkdir()

    try:
        alias = worker._hydra_safe_video_alias(video, output_root)  # noqa: SLF001
    except OSError:
        pytest.skip("file symlinks are not available on this host")

    assert alias.parent == tmp_path / ".hhtools-gvhmr-input"
    assert alias.name.startswith("source_")
    assert alias.suffix == ".mp4"
    assert alias.read_bytes() == b"video"
    assert all(character.isascii() for character in alias.name)
