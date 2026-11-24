"""FRAX differential-IK retarget backend.

Solves the same IK targets as the Newton backend (see
:mod:`hhtools.retarget.ik_pipeline`) with `frax.ik
<https://github.com/StanfordASL/frax>`_: one ElastiQP quadratic program per
frame, scanned over the clip with JAX on the CPU.

``frax`` is an optional dependency (``retarget-frax`` extra).  This package
can be imported without it; :func:`frax_available` reports whether the
backend can run, and the pipeline imports frax / JAX only when constructed.
"""

from __future__ import annotations

import importlib
import importlib.util

from hhtools.retarget.frax_backend.config import FraxConfig, frax_config_for_preset

__all__ = [
    "FRAX_DEPENDENCIES",
    "FraxConfig",
    "FraxPipeline",
    "FraxSceneConfig",
    "FraxScenePipeline",
    "default_backend_for_motion",
    "default_ik_backend",
    "default_scene_backend",
    "frax_available",
    "frax_config_for_preset",
    "missing_frax_dependencies",
    "motion_has_scene",
]

#: Import names the backend needs at run time.
FRAX_DEPENDENCIES: tuple[str, ...] = ("frax", "jax", "elastiqp", "yourdfpy", "mujoco")


def missing_frax_dependencies() -> list[str]:
    """Return the FRAX backend dependencies that are not importable."""
    return [name for name in FRAX_DEPENDENCIES if importlib.util.find_spec(name) is None]


def frax_available() -> bool:
    """True when every FRAX backend dependency is installed."""
    return not missing_frax_dependencies()


def default_ik_backend() -> str:
    """The plain-motion IK backend to use when the caller names none.

    FRAX when its optional dependencies are installed (the ``retarget-frax``
    extra, part of ``all``), otherwise Newton.
    """
    return "frax" if frax_available() else "newton"


def default_scene_backend() -> str:
    """The backend for terrain / object clips when the caller names none.

    The FRAX scene solver when FRAX is installed, otherwise ``interaction_mesh``.
    """
    return "frax" if frax_available() else "interaction_mesh"


def motion_has_scene(motion) -> bool:
    """True when ``motion`` carries terrain or interaction objects."""
    return bool(
        getattr(motion, "terrain", None) is not None or getattr(motion, "objects", None)
    )


def default_backend_for_motion(has_scene: bool) -> str:
    """Default backend for a clip: the scene default when it has terrain / objects."""
    return default_scene_backend() if has_scene else default_ik_backend()


def __getattr__(name: str):
    if name == "FraxPipeline":
        return importlib.import_module("hhtools.retarget.frax_backend.pipeline").FraxPipeline
    if name in ("FraxSceneConfig", "FraxScenePipeline"):
        module = importlib.import_module("hhtools.retarget.frax_backend.scene_pipeline")
        return getattr(module, name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
