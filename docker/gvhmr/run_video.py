"""Run the official GVHMR predictor without the optional mesh render pass.

The official demo renders two videos after writing ``hmr4d_results.pt``. The
hhtools workflow consumes that result file directly, so rendering would only
increase latency and GPU memory use. Model construction, preprocessing, and
prediction remain the official GVHMR implementation and released weights.
"""

from __future__ import annotations

import argparse
import json
import sys
import types
from collections import namedtuple
from pathlib import Path


def _progress(value: float, message: str) -> None:
    print(f"HHTOOLS_PROGRESS {value:.3f} {message}", flush=True)


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--video", required=True)
    parser.add_argument("--output-root", required=True)
    parser.add_argument(
        "--checkpoint",
        default=None,
        help="Optional trusted GVHMR checkpoint. Defaults to the official release weights.",
    )
    parser.add_argument("--static-cam", action="store_true")
    parser.add_argument("--f-mm", type=int, default=None)
    return parser.parse_args()


def _install_inference_only_pytorch3d_stubs(torch: object) -> None:
    """Keep GVHMR's predictor independent from PyTorch3D render extensions.

    The released model uses the pure-PyTorch rotation transforms.  The demo
    module also imports mesh rendering helpers and one optional KNN helper at
    module import time, even though hhtools neither renders meshes nor invokes
    that helper during prediction.  A small torch.cdist fallback preserves the
    KNN contract if a future preprocessing path does call it.
    """

    # GVHMR's BodyModel module contains an unused ``from turtle import
    # forward`` statement.  Importing turtle would pull Tk into this headless
    # worker even though BodyModel defines its own forward method immediately.
    turtle_module = types.ModuleType("turtle")
    turtle_module.forward = lambda *_args, **_kwargs: None
    sys.modules.setdefault("turtle", turtle_module)

    import pytorch3d

    knn_result = namedtuple("KNN", ("dists", "idx", "knn"))
    knn_module = types.ModuleType("pytorch3d.ops.knn")

    def knn_points(
        p1: object,
        p2: object,
        lengths1: object | None = None,
        lengths2: object | None = None,
        norm: int = 2,
        K: int = 1,  # noqa: N803 - mirror PyTorch3D's public argument
        version: int = -1,
        return_nn: bool = False,
        return_sorted: bool = True,
    ) -> object:
        del lengths1, lengths2, norm, version
        distances = torch.cdist(p1, p2).square()
        distances, indices = torch.topk(
            distances,
            k=K,
            dim=-1,
            largest=False,
            sorted=return_sorted,
        )
        neighbors = None
        if return_nn:
            expanded = p2[:, None, :, :].expand(
                -1, p1.shape[1], -1, -1
            )
            neighbors = torch.gather(
                expanded,
                2,
                indices[..., None].expand(-1, -1, -1, p2.shape[-1]),
            )
        return knn_result(distances, indices, neighbors)

    knn_module.knn_points = knn_points
    ops_module = types.ModuleType("pytorch3d.ops")
    ops_module.__path__ = []
    ops_module.knn = knn_module
    pytorch3d.ops = ops_module
    sys.modules["pytorch3d.ops"] = ops_module
    sys.modules["pytorch3d.ops.knn"] = knn_module

    renderer_module = types.ModuleType("hmr4d.utils.vis.renderer")

    def rendering_disabled(*_args: object, **_kwargs: object) -> None:
        raise RuntimeError("mesh rendering is disabled in the hhtools worker")

    renderer_module.Renderer = rendering_disabled
    renderer_module.get_global_cameras_static = rendering_disabled
    renderer_module.get_ground_params_from_points = rendering_disabled
    sys.modules["hmr4d.utils.vis.renderer"] = renderer_module


def main() -> int:
    args = _parse_args()
    video = Path(args.video)
    checkpoint = Path(args.checkpoint) if args.checkpoint else None
    output_root = Path(args.output_root)
    if not video.is_file():
        raise FileNotFoundError(f"input video does not exist: {video}")
    if checkpoint is not None:
        if not checkpoint.is_file():
            raise FileNotFoundError(f"custom checkpoint does not exist: {checkpoint}")
        if checkpoint.suffix.lower() not in {".ckpt", ".pt", ".pth"}:
            raise ValueError(
                f"unsupported checkpoint extension: {checkpoint.suffix or '<none>'}"
            )
    output_root.mkdir(parents=True, exist_ok=True)

    # Executing this worker by absolute path makes Python use the worker's
    # directory as sys.path[0]. Register the mounted official checkout
    # explicitly so GVHMR's top-level ``hmr4d`` and ``tools`` packages resolve.
    gvhmr_root = Path.cwd()
    if not (gvhmr_root / "hmr4d").is_dir():
        raise FileNotFoundError(
            f"GVHMR checkout is not mounted at the working directory: {gvhmr_root}"
        )
    sys.path.insert(0, str(gvhmr_root))

    # The official helper parses its own argv and creates the Hydra config.
    official_argv = [
        "tools/demo/demo.py",
        "--video",
        str(video),
        "--output_root",
        str(output_root),
    ]
    if args.static_cam:
        official_argv.append("--static_cam")
    if args.f_mm is not None:
        official_argv.extend(["--f_mm", str(args.f_mm)])

    _progress(0.01, "initializing GVHMR")
    sys.argv = official_argv

    import hydra
    import torch

    _install_inference_only_pytorch3d_stubs(torch)

    from hmr4d.utils.net_utils import detach_to_cpu
    from hmr4d.utils.pylogger import Log
    from tools.demo.demo import load_data_dict, parse_args_to_cfg, run_preprocess

    cfg = parse_args_to_cfg()
    if checkpoint is not None:
        # ``ckpt_path`` is part of the official demo config. Replacing only
        # this value preserves the official architecture and preprocessing
        # stack while allowing a compatible user-trained GVHMR state dict.
        cfg.ckpt_path = str(checkpoint)
    paths = cfg.paths
    _progress(0.08, "preprocessing video")
    run_preprocess(cfg)
    _progress(0.66, "loading preprocessed features")
    data = load_data_dict(cfg)

    result_path = Path(paths.hmr4d_results)
    if not result_path.exists():
        checkpoint_label = "custom" if checkpoint is not None else "official"
        _progress(0.72, f"running {checkpoint_label} GVHMR checkpoint")
        model = hydra.utils.instantiate(cfg.model, _recursive_=False)
        model.load_pretrained_model(cfg.ckpt_path)
        model = model.eval().cuda()
        tic = Log.sync_time()
        with torch.no_grad():
            pred = model.predict(data, static_cam=cfg.static_cam)
        pred = detach_to_cpu(pred)
        Log.info(
            f"[HHTOOLS] GVHMR prediction elapsed: "
            f"{Log.sync_time() - tic:.2f}s"
        )
        torch.save(pred, result_path)

    if not result_path.is_file():
        raise RuntimeError(f"GVHMR did not create {result_path}")
    _progress(1.0, "GVHMR motion ready")
    print(
        "HHTOOLS_RESULT "
        + json.dumps({"result_path": str(result_path)}, ensure_ascii=False),
        flush=True,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
