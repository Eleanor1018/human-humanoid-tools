"""Process-level JAX configuration for the FRAX backend.

frax recommends float64, single-threaded XLA and (for batches) one CPU
device per core.  ``XLA_FLAGS``, ``JAX_PLATFORMS`` and the CPU device count
only take effect before JAX initializes, so :func:`configure_jax` applies
them on first use.  hhtools imports JAX nowhere else; if something did so
first, the settings that can no longer change are reported as not applied.
"""

from __future__ import annotations

import logging
import os
import sys
import threading
import warnings

_log = logging.getLogger(__name__)

__all__ = ["configure_jax", "import_frax"]

_XLA_FLAGS = (
    "--xla_cpu_multi_thread_eigen=false",
    "--xla_cpu_scheduler_type=CPU_SCHEDULER_TYPE_MEMORY_OPTIMIZED",
)
_LOCK = threading.Lock()
_STATE: dict[str, object] | None = None


def _requested_cpu_devices() -> int:
    raw = os.environ.get("HHTOOLS_FRAX_CPU_DEVICES", "").strip()
    if raw:
        try:
            return max(1, int(raw))
        except ValueError:
            _log.warning("ignoring invalid HHTOOLS_FRAX_CPU_DEVICES=%r", raw)
    return max(1, os.cpu_count() or 1)


def _compilation_cache_dir() -> str | None:
    """Persistent XLA cache, so a new process skips recompiling the same solver.

    ``HHTOOLS_FRAX_COMPILE_CACHE=0`` disables it; any other value is used as
    the directory.  Defaults to ``<hhtools cache>/frax-xla``.
    """
    raw = os.environ.get("HHTOOLS_FRAX_COMPILE_CACHE", "").strip()
    if raw.lower() in {"0", "false", "off", "no"}:
        return None
    if raw:
        return raw
    try:
        from hhtools.utils.paths import hhtools_cache_dir

        path = hhtools_cache_dir() / "frax-xla"
        path.mkdir(parents=True, exist_ok=True)
        return str(path)
    except OSError:
        return None


def configure_jax() -> dict[str, object]:
    """Apply the FRAX JAX settings once and return what is in effect."""
    global _STATE  # noqa: PLW0603 - process-wide, set once
    with _LOCK:
        if _STATE is not None:
            return _STATE
        preloaded = "jax" in sys.modules
        if not preloaded:
            os.environ.setdefault("JAX_PLATFORMS", os.environ.get("HHTOOLS_FRAX_PLATFORM", "cpu"))
            flags = os.environ.get("XLA_FLAGS", "")
            for flag in _XLA_FLAGS:
                if flag.split("=", 1)[0] not in flags:
                    flags = f"{flags} {flag}".strip()
            os.environ["XLA_FLAGS"] = flags

        import jax

        jax.config.update("jax_enable_x64", True)
        cache_dir = _compilation_cache_dir()
        if cache_dir is not None:
            try:
                jax.config.update("jax_compilation_cache_dir", cache_dir)
            except Exception as err:  # pragma: no cover - depends on the JAX build
                _log.debug("FRAX: persistent compilation cache unavailable (%s)", err)
                cache_dir = None
        requested = _requested_cpu_devices()
        devices_applied = False
        try:
            jax.config.update("jax_num_cpu_devices", requested)
            devices_applied = True
        except Exception as err:  # backend already initialized by someone else
            _log.warning("FRAX: could not set the JAX CPU device count (%s)", err)
        devices = jax.devices()
        _STATE = {
            "jax_version": str(jax.__version__),
            "platform": str(devices[0].platform) if devices else "unknown",
            "device": str(devices[0]) if devices else "unknown",
            "device_count": len(devices),
            "x64": bool(jax.config.read("jax_enable_x64")),
            "xla_flags_applied": not preloaded,
            "cpu_devices_requested": requested,
            "cpu_devices_applied": devices_applied,
            "compilation_cache_dir": cache_dir,
        }
        if preloaded:
            _log.warning(
                "FRAX: JAX was imported before the FRAX backend, so its recommended "
                "XLA flags were not applied; results are unaffected but may be slower."
            )
        return _STATE


def import_frax():
    """Configure JAX, then import ``frax`` and ``frax.ik``.

    frax warns at import about thread settings that only matter for its own
    benchmarks (``OPENBLAS_NUM_THREADS`` would also slow every subprocess
    hhtools starts), so that warning is silenced here.
    """
    configure_jax()
    with warnings.catch_warnings():
        warnings.filterwarnings("ignore", message=r".*\[frax\].*", category=UserWarning)
        import frax
        import frax.ik

    return frax
