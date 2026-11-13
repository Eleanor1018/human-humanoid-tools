"""FRAX backend options and their ``robot.yaml`` source (``retarget.frax``)."""

from __future__ import annotations

import logging
import math
from dataclasses import dataclass, fields, replace
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from hhtools.robot.base import RobotPreset

_log = logging.getLogger(__name__)

__all__ = ["FraxConfig", "frax_config_for_preset"]


@dataclass(frozen=True)
class FraxConfig:
    """Solver options for :class:`~hhtools.retarget.frax_backend.FraxPipeline`.

    Frozen and built from tuples so it can key the compiled-solver cache.

    Attributes:
        regularization: Tikhonov regularization on the joint velocity.  The
            frax default (1e-8) is too weak for hhtools' calibrated targets:
            the first-frame convergence can stall and joints chatter.
        damping: Levenberg-Marquardt damping per unit of task cost.
        joint_regularization: ``(joint, value)`` overrides of
            ``regularization`` for joints near a singular configuration.
        joint_limit_overrides: ``(joint, lower, upper)`` narrower position
            limits, e.g. to keep a shoulder off its second IK solution.
        velocity_limits: Also enforce the URDF joint velocity limits.  Off by
            default: mocap retargeting is not actuator-limited, and Newton
            does not apply them either.  The QP always bounds joint speed by
            ``PipelineConfig.max_joint_velocity`` (the cap the shared
            finalizer clips to); this adds the URDF limits on top.
        midpoint_weight: Weight of Newton's pull-to-mid-range joint filter.
            Off by default: the joint-limit constraints already keep joints
            in range, and on the built-in robots the filter raised the p95
            tracking error and slowed the first-frame convergence.  ``None``
            uses ``PipelineConfig.smooth_joint_filter_weight`` (Newton's
            value).
        floor: Keep the robot's collision spheres above ``z = 0``.
        floor_margin: Extra height kept above the floor (metres).
        self_collision: Avoid self-collision between the sphere pairs.  On the
            built-in robots it removed limb interpenetration for about 0.1 cm
            more tracking error and 10% more solve time.
        self_collision_rows: Closest self-collision pairs kept per step.
        converge_max_iters: Iterations allowed to converge on the first frame.
        solver_tol: ElastiQP tolerance.
        frame_bucket: Clips are padded to a multiple of this many frames so
            compiled solvers are reused across clip lengths.
        global_ik_init: Solve the first frame by sampled global IK before
            converging (slower start, avoids a poor local solution).
        global_ik_samples: Samples for ``global_ik_init``.
    """

    regularization: float = 0.1
    damping: float = 0.0
    joint_regularization: tuple[tuple[str, float], ...] = ()
    joint_limit_overrides: tuple[tuple[str, float, float], ...] = ()
    velocity_limits: bool = False
    midpoint_weight: float | None = 0.0
    floor: bool = True
    floor_margin: float = 0.0
    self_collision: bool = True
    self_collision_rows: int = 64
    converge_max_iters: int = 300
    solver_tol: float = 1e-5
    frame_bucket: int = 256
    global_ik_init: bool = False
    global_ik_samples: int = 32

    def with_overrides(self, **overrides: Any) -> FraxConfig:
        """Return a copy with ``overrides`` applied (unknown keys rejected)."""
        known = {f.name for f in fields(self)}
        unknown = sorted(set(overrides) - known)
        if unknown:
            raise ValueError(f"unknown FRAX option(s): {', '.join(unknown)}")
        return replace(self, **overrides)


def _positive(value: Any, name: str, *, allow_zero: bool = False) -> float:
    number = float(value)
    if not math.isfinite(number) or number < 0.0 or (number == 0.0 and not allow_zero):
        raise ValueError(f"retarget.frax.{name} must be a positive number, got {value!r}")
    return number


def frax_config_for_preset(preset: RobotPreset | None, **overrides: Any) -> FraxConfig:
    """Build a :class:`FraxConfig` from ``robot.yaml``'s ``retarget.frax`` block.

    Malformed entries raise :class:`ValueError` naming the key, so a typo is
    reported instead of silently ignored.  Keyword ``overrides`` (for example
    from a CLI flag) win over the yaml.
    """
    block: dict[str, Any] = {}
    if preset is not None:
        from hhtools.robot.retarget_profile import retarget_backend_block

        block = retarget_backend_block(preset, "frax")

    values: dict[str, Any] = {}
    scalar_floats = {
        "regularization": False,
        "damping": True,
        "floor_margin": True,
        "solver_tol": False,
    }
    for key, allow_zero in scalar_floats.items():
        if key in block:
            values[key] = _positive(block[key], key, allow_zero=allow_zero)
    if "midpoint_weight" in block:
        raw = block["midpoint_weight"]
        values["midpoint_weight"] = (
            None if raw is None else _positive(raw, "midpoint_weight", allow_zero=True)
        )
    for key in ("velocity_limits", "floor", "self_collision", "global_ik_init"):
        if key in block:
            if not isinstance(block[key], bool):
                raise ValueError(f"retarget.frax.{key} must be true or false")
            values[key] = block[key]
    for key in ("self_collision_rows", "converge_max_iters", "frame_bucket", "global_ik_samples"):
        if key in block:
            number = int(block[key])
            if number <= 0:
                raise ValueError(f"retarget.frax.{key} must be a positive integer")
            values[key] = number

    joint_reg = block.get("joint_regularization") or block.get("joint_damping") or {}
    if not isinstance(joint_reg, dict):
        raise ValueError("retarget.frax.joint_regularization must map joint names to numbers")
    values["joint_regularization"] = tuple(
        sorted(
            (str(name), _positive(v, f"joint_regularization.{name}"))
            for name, v in joint_reg.items()
        )
    )

    limits = block.get("joint_limit_overrides") or {}
    if not isinstance(limits, dict):
        raise ValueError(
            "retarget.frax.joint_limit_overrides must map joint names to [lower, upper]"
        )
    parsed_limits = []
    for name, pair in limits.items():
        if not isinstance(pair, list | tuple) or len(pair) != 2:
            raise ValueError(f"retarget.frax.joint_limit_overrides.{name} must be [lower, upper]")
        lower, upper = float(pair[0]), float(pair[1])
        if not (math.isfinite(lower) and math.isfinite(upper) and lower < upper):
            raise ValueError(
                f"retarget.frax.joint_limit_overrides.{name} must satisfy lower < upper"
            )
        parsed_limits.append((str(name), lower, upper))
    values["joint_limit_overrides"] = tuple(sorted(parsed_limits))

    unknown = sorted(
        set(block)
        - set(scalar_floats)
        - {
            "midpoint_weight",
            "velocity_limits",
            "floor",
            "self_collision",
            "global_ik_init",
            "self_collision_rows",
            "converge_max_iters",
            "frame_bucket",
            "global_ik_samples",
            "joint_regularization",
            "joint_damping",
            "joint_limit_overrides",
        }
    )
    if unknown:
        _log.warning("robot %r: ignoring unknown retarget.frax keys %s", preset.name, unknown)

    return FraxConfig(**values).with_overrides(**overrides)
