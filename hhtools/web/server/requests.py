"""Validated execution inputs for browser adapters."""

from __future__ import annotations

from typing import Literal

from hhtools.contracts.execution import (
    ExecutionIdentifier,
    HumanRetargetExecutionOptions,
    SolverExecutionOptions,
)

#: ``None`` lets the server pick the default IK backend for this install
#: (FRAX when installed, otherwise Newton); see
#: :func:`hhtools.services.routing.default_ik_backend`.
BrowserBackend = Literal["newton", "interaction_mesh", "frax"] | None


class HumanRetargetRequest(HumanRetargetExecutionOptions):
    backend: BrowserBackend = None  # type: ignore[assignment]
    robot: ExecutionIdentifier
    motion_token: ExecutionIdentifier


class RobotRetargetRequest(SolverExecutionOptions):
    backend: BrowserBackend = None  # type: ignore[assignment]
    target: ExecutionIdentifier
    source: ExecutionIdentifier
    source_token: ExecutionIdentifier
