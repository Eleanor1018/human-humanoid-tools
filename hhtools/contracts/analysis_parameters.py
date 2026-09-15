"""Partial metric overrides accepted by the public analysis workflow."""

from typing import Annotated, Literal

from pydantic import ConfigDict, Field
from typing_extensions import TypedDict

Nonnegative = Annotated[float, Field(ge=0, allow_inf_nan=False)]
Ratio = Annotated[float, Field(ge=0, le=1, allow_inf_nan=False)]


class Overrides(TypedDict, total=False):
    __pydantic_config__ = ConfigDict(extra="forbid")


class Complexity(Overrides, total=False):
    lambda_accel: Nonnegative


class Thresholds(Overrides, total=False):
    floating_height_m: Nonnegative
    contact_height_m: Nonnegative
    foot_slide_speed_mps: Nonnegative
    static_root_speed_mps: Nonnegative
    inverted_angle_deg: Nonnegative
    jump_airborne_ratio: Ratio
    leg_static_quantile: Ratio
    dynamics_quantiles: Annotated[list[Ratio], Field(min_length=3, max_length=3)]


class Weights(Overrides, total=False):
    floating: Nonnegative
    penetration: Nonnegative
    vel_violation: Nonnegative
    foot_slide: Nonnegative
    self_collision: Nonnegative
    jerk: Nonnegative


class Quality(Overrides, total=False):
    weights: Weights
    limmt_raw_weights: Weights
    warn_below: Nonnegative
    bad_below: Nonnegative


class Pae(Overrides, total=False):
    window_s: Annotated[float, Field(gt=0, allow_inf_nan=False)]
    k: Annotated[int, Field(ge=1, strict=True)]


class Embedding(Overrides, total=False):
    backend: Literal["handcrafted", "pae"]
    pae: Pae


class Subset(Overrides, total=False):
    alpha: Ratio
    default_ratio: Ratio


class Parallel(Overrides, total=False):
    workers: Annotated[int, Field(ge=0, strict=True)]
    max_workers: Annotated[int, Field(ge=1, strict=True)]


class AnalysisMetricConfig(Overrides, total=False):
    complexity: Complexity
    thresholds: Thresholds
    quality: Quality
    embedding: Embedding
    subset: Subset
    parallel: Parallel
