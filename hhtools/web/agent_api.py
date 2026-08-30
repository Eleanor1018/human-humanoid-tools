"""Versioned REST adapter for HHTools' transport-neutral agent services.

This module intentionally contains no capability probing or solver logic.  It
only retrieves the service instance assembled by :func:`hhtools.web.server.create_app`
and serializes its contracts through FastAPI.
"""

from __future__ import annotations

from typing import Protocol, cast

from fastapi import APIRouter, Request

from hhtools.contracts import CapabilityResponse

router = APIRouter(prefix="/api/agent/v1", tags=["agent"])


class _CapabilityProvider(Protocol):
    def get_capabilities(self) -> CapabilityResponse: ...


def _capabilities_service(request: Request) -> _CapabilityProvider:
    service = getattr(request.app.state, "agent_capabilities_service", None)
    if service is None or not callable(getattr(service, "get_capabilities", None)):
        raise RuntimeError("agent capabilities service is not configured")
    return cast("_CapabilityProvider", service)


@router.get(
    "/capabilities",
    response_model=CapabilityResponse,
    response_model_exclude_none=True,
)
def get_capabilities(request: Request) -> CapabilityResponse:
    """Describe backends, devices, robots, formats, and live admission state."""

    return _capabilities_service(request).get_capabilities()


__all__ = ["router"]
