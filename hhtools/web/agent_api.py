"""Versioned REST adapter for HHTools' transport-neutral agent services.

This module intentionally contains no capability probing or solver logic.  It
only retrieves the service instance assembled by :func:`hhtools.web.server.create_app`
and serializes its contracts through FastAPI.
"""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable
from typing import Any, Protocol, cast

from fastapi import APIRouter, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response
from fastapi.routing import APIRoute

from hhtools.contracts import (
    ApiError,
    AssetBundle,
    AssetCategory,
    AssetId,
    AssetInspection,
    AssetInspectionRequest,
    AssetKind,
    AssetRegistrationRequest,
    AssetSearchResponse,
    CapabilityResponse,
    ErrorStage,
)
from hhtools.services.assets import AssetServiceError

_log = logging.getLogger(__name__)


def _error_status(error: ApiError) -> int:
    if error.code == "ASSET_OUTSIDE_ALLOWED_ROOT":
        return 403
    if error.code == "ASSET_NOT_FOUND":
        return 404
    if error.code in {"ASSET_HASH_MISMATCH", "BUNDLE_AMBIGUOUS"}:
        return 409
    if error.code == "INVALID_PARAMETER":
        return 400
    if error.code == "INTERNAL_ERROR":
        return 500
    return 422


def _error_response(error: ApiError, *, status_code: int | None = None) -> JSONResponse:
    return JSONResponse(
        status_code=status_code or _error_status(error),
        content=error.model_dump(mode="json", exclude_none=True),
    )


class _AgentRoute(APIRoute):
    """Keep expected Agent failures on the same versioned error contract."""

    def get_route_handler(self) -> Callable[[Request], Awaitable[Response]]:
        route_handler = super().get_route_handler()

        async def agent_route_handler(request: Request) -> Response:
            try:
                return await route_handler(request)
            except RequestValidationError as exc:
                issues = [
                    {
                        "location": ".".join(str(part) for part in issue.get("loc", ())),
                        "type": str(issue.get("type", "validation_error")),
                    }
                    for issue in exc.errors()
                ]
                return _error_response(
                    ApiError(
                        code="INVALID_PARAMETER",
                        message="The Agent request does not match the versioned contract.",
                        stage=ErrorStage.REQUEST,
                        details={"issues": issues},
                    ),
                    status_code=422,
                )
            except AssetServiceError as exc:
                return _error_response(exc.api_error)
            except Exception:  # noqa: BLE001 - REST must not expose internals
                _log.exception("unexpected Agent REST failure")
                return _error_response(
                    ApiError(
                        code="INTERNAL_ERROR",
                        message="The Agent service could not complete the request.",
                        retryable=True,
                        stage=ErrorStage.INTERNAL,
                    )
                )

        return agent_route_handler


router = APIRouter(
    prefix="/api/agent/v1",
    tags=["agent"],
    route_class=_AgentRoute,
)


class _CapabilityProvider(Protocol):
    def get_capabilities(self) -> CapabilityResponse: ...


class _AssetProvider(Protocol):
    @property
    def allowed_root_ids(self) -> tuple[str, ...]: ...

    def register(self, request: AssetRegistrationRequest) -> AssetBundle: ...

    def get(self, asset_id: str) -> AssetBundle: ...

    def search(self, **filters: Any) -> AssetSearchResponse: ...

    def inspect(self, request: AssetInspectionRequest) -> AssetInspection: ...


def _capabilities_service(request: Request) -> _CapabilityProvider:
    service = getattr(request.app.state, "agent_capabilities_service", None)
    if service is None or not callable(getattr(service, "get_capabilities", None)):
        raise RuntimeError("agent capabilities service is not configured")
    return cast("_CapabilityProvider", service)


def _asset_service(request: Request) -> _AssetProvider:
    service = getattr(request.app.state, "agent_asset_service", None)
    required = ("register", "get", "search", "inspect")
    if service is None or any(not callable(getattr(service, name, None)) for name in required):
        raise RuntimeError("agent asset service is not configured")
    return cast("_AssetProvider", service)


@router.get(
    "/capabilities",
    response_model=CapabilityResponse,
    response_model_exclude_none=True,
)
def get_capabilities(request: Request) -> CapabilityResponse:
    """Describe backends, devices, robots, formats, and live admission state."""

    return _capabilities_service(request).get_capabilities()


@router.post(
    "/assets",
    response_model=AssetBundle,
    response_model_exclude_none=True,
    status_code=201,
)
def register_asset(
    request: Request,
    registration: AssetRegistrationRequest,
) -> AssetBundle:
    """Register one content-addressed bundle below a configured server root."""

    return _asset_service(request).register(registration)


@router.get(
    "/assets",
    response_model=AssetSearchResponse,
    response_model_exclude_none=True,
)
def search_assets(
    request: Request,
    query: str | None = Query(default=None, max_length=256),
    kind: AssetKind | None = None,
    category: AssetCategory | None = None,
    dataset: str | None = Query(default=None, max_length=128),
    reference: str | None = Query(default=None, max_length=128),
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
) -> AssetSearchResponse:
    """Search immutable asset manifests using compact, bounded filters."""

    return _asset_service(request).search(
        query=query,
        kind=kind,
        category=category,
        dataset=dataset,
        reference=reference,
        limit=limit,
        offset=offset,
    )


@router.get(
    "/assets/{asset_id}",
    response_model=AssetBundle,
    response_model_exclude_none=True,
)
def get_asset(request: Request, asset_id: AssetId) -> AssetBundle:
    """Return one portable content manifest without exposing a host path."""

    return _asset_service(request).get(asset_id)


@router.get(
    "/assets/{asset_id}/inspect",
    response_model=AssetInspection,
    response_model_exclude_none=True,
)
def inspect_asset(
    request: Request,
    asset_id: AssetId,
    verify_hashes: bool = True,
    parse_content: bool = True,
) -> AssetInspection:
    """Validate bundle integrity and content without starting a solver job."""

    return _asset_service(request).inspect(
        AssetInspectionRequest(
            asset_id=asset_id,
            verify_hashes=verify_hashes,
            parse_content=parse_content,
        )
    )


__all__ = ["router"]
