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
    "frax_available",
    "frax_config_for_preset",
    "missing_frax_dependencies",
]

#: Import names the backend needs at run time.
FRAX_DEPENDENCIES: tuple[str, ...] = ("frax", "jax", "elastiqp", "yourdfpy", "mujoco")


def missing_frax_dependencies() -> list[str]:
    """Return the FRAX backend dependencies that are not importable."""
    return [name for name in FRAX_DEPENDENCIES if importlib.util.find_spec(name) is None]


def frax_available() -> bool:
    """True when every FRAX backend dependency is installed."""
    return not missing_frax_dependencies()


def __getattr__(name: str):
    if name == "FraxPipeline":
        return importlib.import_module("hhtools.retarget.frax_backend.pipeline").FraxPipeline
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
