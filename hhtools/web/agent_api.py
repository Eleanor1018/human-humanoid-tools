"""Versioned REST adapter for HHTools' transport-neutral agent services.

This module intentionally contains no capability probing or solver logic.  It
only retrieves the service instance assembled by :func:`hhtools.web.server.create_app`
and serializes its contracts through FastAPI.
"""

from __future__ import annotations

import json
import logging
import math
import re
from collections.abc import Awaitable, Callable
from pathlib import PurePosixPath, PureWindowsPath
from typing import Annotated, Any, Protocol, cast
from urllib.parse import parse_qsl, urlsplit

from fastapi import APIRouter, Body, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response
from fastapi.routing import APIRoute

from hhtools.contracts import (
    AgentJobView,
    ApiError,
    ArtifactDescriptor,
    ArtifactId,
    ArtifactListResponse,
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
    JobRetryRequest,
    JobStartRequest,
    LegacyJobUpgradeRequest,
    LegacyJobUpgradeResponse,
    PreflightResponse,
    RetargetPreflightRequest,
)
from hhtools.services.artifacts import StoredArtifact
from hhtools.services.assets import AssetServiceError
from hhtools.services.jobs import JobManagerError
from hhtools.services.legacy_job_upgrade import LegacyJobUpgradeError
from hhtools.web.agent_artifact_response import verified_artifact_response

_log = logging.getLogger(__name__)

_ERROR_STATUS_BY_CODE = {
    "ALLOWED_ROOT_UNAVAILABLE": 503,
    "AMBIGUOUS_ALLOWED_ROOT": 409,
    "ARTIFACT_HASH_MISMATCH": 409,
    "ARTIFACT_NOT_FOUND": 404,
    "ASSET_CHANGED_DURING_UPGRADE": 409,
    "ASSET_HASH_MISMATCH": 409,
    "ASSET_NOT_FOUND": 404,
    "ASSET_OUTSIDE_ALLOWED_ROOT": 403,
    "ASSET_REGISTRATION_MISMATCH": 409,
    "BACKEND_UNAVAILABLE": 503,
    "BUNDLE_AMBIGUOUS": 409,
    "INTERNAL_ERROR": 500,
    "INVALID_JOB_TRANSITION": 409,
    "INVALID_JOB_SPEC": 400,
    "INVALID_JSON": 400,
    "INVALID_PARAMETER": 400,
    "JOB_CANCEL_UNSUPPORTED": 409,
    "JOB_CONFLICT": 409,
    "JOB_NOT_FOUND": 404,
    "LEGACY_METADATA_MISMATCH": 409,
    "PLAN_CONFLICT": 409,
    "PLAN_NOT_FOUND": 404,
    "PLAN_STALE": 409,
    "QUEUE_FULL": 429,
    "ROBOT_AMBIGUOUS": 409,
    "ROBOT_NOT_FOUND": 404,
    "ROBOT_REGISTRY_UNAVAILABLE": 503,
    "RANGE_NOT_SUPPORTED": 416,
    "REFERENCE_MISMATCH": 409,
    "SCHEDULER_UNAVAILABLE": 503,
}

_CONTROLLED_RESOURCE_URI_FRAGMENT = re.compile(
    r"(?:hhtools|https?)://"
    r"(?:\[[0-9A-Fa-f:.%]+\](?::[0-9]{1,5})?|[A-Za-z0-9._~-]+(?::[0-9]{1,5})?)"
    r"(?:[/?#][A-Za-z0-9._~:/?#@!$&*+,;=%-]*)?",
    re.IGNORECASE,
)
_EMBEDDED_URI_SCHEME = re.compile(
    r"(?<![A-Za-z0-9])([A-Za-z][A-Za-z0-9+.-]*)://"
)
_EMBEDDED_FILE_URI = re.compile(r"(?<![A-Za-z0-9])file:", re.IGNORECASE)
_EMBEDDED_WINDOWS_PATH = re.compile(
    r"(?<![A-Za-z0-9])(?:[A-Za-z]:[\\/]|\\\\)[^\s\"']*"
)
_EMBEDDED_POSIX_PATH = re.compile(r"(?<![A-Za-z0-9/])/(?![/\s])[^\s\"']*")
_EMBEDDED_PROTOCOL_RELATIVE = re.compile(r"(?<![A-Za-z0-9/])//[^\s\"']+")
_UI_QUERY_KEY = re.compile(r"^[a-z][a-z0-9_-]{0,63}$")


class _InvalidAgentJsonError(ValueError):
    """The JSON representation is ambiguous or unsafe for the public wire."""


def _safe_same_origin_ui_url(value: str) -> bool:
    if value == "/":
        return True
    if not value.startswith("/?") or value.startswith("//"):
        return False
    parsed = urlsplit(value)
    if parsed.scheme or parsed.netloc or parsed.path != "/" or parsed.fragment:
        return False
    try:
        fields = parse_qsl(
            parsed.query,
            keep_blank_values=True,
            max_num_fields=16,
        )
    except ValueError:
        return False
    return all(
        _UI_QUERY_KEY.fullmatch(key) is not None
        and len(item) <= 256
        and not _looks_like_host_path(item)
        for key, item in fields
    )


def _strict_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise _InvalidAgentJsonError("duplicate object key")
        result[key] = value
    return result


def _reject_nonfinite_constant(_value: str) -> None:
    raise _InvalidAgentJsonError("non-finite number")


def _strict_json_int(value: str) -> int:
    if len(value) > 128:
        raise _InvalidAgentJsonError("integer token is too long")
    return int(value)


def _strict_json_float(value: str) -> float:
    if len(value) > 128:
        raise _InvalidAgentJsonError("float token is too long")
    result = float(value)
    if not math.isfinite(result):
        raise _InvalidAgentJsonError("non-finite number")
    return result


def _strict_json_loads(payload: bytes) -> Any:
    try:
        return json.loads(
            payload.decode("utf-8"),
            object_pairs_hook=_strict_object,
            parse_float=_strict_json_float,
            parse_int=_strict_json_int,
            parse_constant=_reject_nonfinite_constant,
        )
    except (
        UnicodeDecodeError,
        json.JSONDecodeError,
        _InvalidAgentJsonError,
        RecursionError,
    ) as exc:
        raise _InvalidAgentJsonError("invalid strict JSON") from exc


def _looks_like_host_path(
    value: str,
    *,
    allow_same_origin_ui_url: bool = False,
) -> bool:
    if _EMBEDDED_FILE_URI.search(value):
        return True
    for match in _EMBEDDED_URI_SCHEME.finditer(value):
        if match.group(1).casefold() not in {"hhtools", "http", "https"}:
            # Free-form metadata/details must not smuggle an adapter-specific
            # URI scheme past the ResourceUri allowlist.
            return True
    # Remove explicitly portable resource URI fragments before looking for
    # filesystem syntax.  The remaining scans use a generic non-alphanumeric
    # boundary, so punctuation such as ``:``, ``[``, ``{`` and ``|`` cannot
    # create one-off path-leak bypasses while ``https://`` is not mistaken for
    # an absolute POSIX path.
    masked = _CONTROLLED_RESOURCE_URI_FRAGMENT.sub("", value)
    # The current Web recovery action opens the root UI with a query string.
    # Permit only that explicit shape inside a verified NextAction object;
    # arbitrary nested fields named ``url`` and protocol-relative ``//`` URLs
    # must not turn into path-leak escape hatches.
    if allow_same_origin_ui_url and _safe_same_origin_ui_url(value):
        return False
    posix = PurePosixPath(masked)
    windows = PureWindowsPath(masked)
    if (
        posix.is_absolute()
        or windows.is_absolute()
        or bool(windows.drive)
        or bool(windows.root)
    ):
        return True
    return bool(
        _EMBEDDED_WINDOWS_PATH.search(masked)
        or _EMBEDDED_POSIX_PATH.search(masked)
        or _EMBEDDED_PROTOCOL_RELATIVE.search(masked)
    )


def _validate_portable_json(
    value: Any,
    *,
    allow_same_origin_ui_url: bool = False,
) -> None:
    if value is None or isinstance(value, bool | int):
        return
    if isinstance(value, float):
        if not math.isfinite(value):
            raise _InvalidAgentJsonError("non-finite number")
        return
    if isinstance(value, str):
        if _looks_like_host_path(
            value,
            allow_same_origin_ui_url=allow_same_origin_ui_url,
        ):
            raise _InvalidAgentJsonError("host path")
        return
    if isinstance(value, list):
        for item in value:
            _validate_portable_json(item)
        return
    if isinstance(value, dict):
        next_action_shape = (
            value.get("actor") in {"agent", "human", "system"}
            and isinstance(value.get("action"), str)
        )
        for key, item in value.items():
            if not isinstance(key, str) or _looks_like_host_path(key):
                raise _InvalidAgentJsonError("invalid object key")
            _validate_portable_json(
                item,
                allow_same_origin_ui_url=next_action_shape and key == "url",
            )
        return
    raise _InvalidAgentJsonError("non-JSON value")


def _error_status(error: ApiError) -> int:
    status = _ERROR_STATUS_BY_CODE.get(error.code)
    if status is not None:
        return status
    return 500 if error.stage is ErrorStage.INTERNAL else 422


def _error_response(error: ApiError, *, status_code: int | None = None) -> JSONResponse:
    headers = {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
    }
    if error.code == "QUEUE_FULL" and error.next_action is not None:
        raw_poll_ms = error.next_action.parameters.get("poll_after_ms")
        if (
            isinstance(raw_poll_ms, int | float)
            and not isinstance(raw_poll_ms, bool)
            and math.isfinite(raw_poll_ms)
            and 0 <= raw_poll_ms <= 300_000
        ):
            headers["Retry-After"] = str(max(1, math.ceil(raw_poll_ms / 1000)))
    return JSONResponse(
        status_code=status_code or _error_status(error),
        content=error.model_dump(mode="json", exclude_none=True),
        headers=headers,
    )


def _portable_response(response: Response) -> Response:
    content_type = response.headers.get("content-type", "").partition(";")[0].strip()
    if content_type != "application/json" and not content_type.endswith("+json"):
        return response
    body = getattr(response, "body", None)
    if not isinstance(body, bytes | bytearray | memoryview):
        raise _InvalidAgentJsonError("JSON response is not buffered")
    value = _strict_json_loads(bytes(body))
    _validate_portable_json(value)
    response.headers["Cache-Control"] = "no-store"
    response.headers["X-Content-Type-Options"] = "nosniff"
    return response


def _portable_or_internal_error(response: Response) -> Response:
    try:
        return _portable_response(response)
    except _InvalidAgentJsonError:
        _log.error("blocked a non-portable Agent JSON response")
        return _error_response(
            ApiError(
                code="INTERNAL_ERROR",
                message="The Agent service produced an unsafe response.",
                retryable=False,
                stage=ErrorStage.INTERNAL,
            )
        )


class _AgentRoute(APIRoute):
    """Keep expected Agent failures on the same versioned error contract."""

    def get_route_handler(self) -> Callable[[Request], Awaitable[Response]]:
        route_handler = super().get_route_handler()

        async def agent_route_handler(request: Request) -> Response:
            try:
                body = await request.body()
                if body:
                    try:
                        _strict_json_loads(body)
                    except _InvalidAgentJsonError:
                        return _portable_or_internal_error(
                            _error_response(
                                ApiError(
                                    code="INVALID_JSON",
                                    message=(
                                        "The Agent request body must be strict UTF-8 JSON "
                                        "without duplicate keys or non-finite numbers."
                                    ),
                                    stage=ErrorStage.REQUEST,
                                ),
                                status_code=400,
                            )
                        )
                response = await route_handler(request)
            except RequestValidationError as exc:
                issues = [
                    {
                        "location": ".".join(str(part) for part in issue.get("loc", ())),
                        "type": str(issue.get("type", "validation_error")),
                    }
                    for issue in exc.errors()
                ]
                response = _error_response(
                    ApiError(
                        code="INVALID_PARAMETER",
                        message="The Agent request does not match the versioned contract.",
                        stage=ErrorStage.REQUEST,
                        details={"issues": issues},
                    ),
                    status_code=422,
                )
            except AssetServiceError as exc:
                response = _error_response(exc.api_error)
            except (JobManagerError, LegacyJobUpgradeError) as exc:
                response = _error_response(exc.api_error)
            except Exception:  # noqa: BLE001 - REST must not expose internals
                _log.exception("unexpected Agent REST failure")
                response = _error_response(
                    ApiError(
                        code="INTERNAL_ERROR",
                        message="The Agent service could not complete the request.",
                        retryable=True,
                        stage=ErrorStage.INTERNAL,
                    )
                )
            return _portable_or_internal_error(response)

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


class _PreflightProvider(Protocol):
    def preflight_retarget(
        self,
        request: RetargetPreflightRequest,
    ) -> PreflightResponse: ...


class _JobProvider(Protocol):
    def start_retarget(
        self,
        plan_id: str,
        *,
        idempotency_key: str,
        parent_job_id: str | None = None,
    ) -> AgentJobView: ...

    def get_job(
        self,
        job_id: str,
        *,
        after_revision: int | None = None,
    ) -> AgentJobView: ...

    def cancel_job(self, job_id: str) -> AgentJobView: ...

    def retry_job(self, job_id: str, *, idempotency_key: str) -> AgentJobView: ...

    def list_artifacts(
        self,
        job_id: str,
        *,
        offset: int = 0,
        limit: int = 100,
    ) -> list[ArtifactDescriptor]: ...

    def get_artifact(
        self,
        job_id: str,
        artifact_id: str,
        *,
        verify: bool = False,
    ) -> StoredArtifact: ...


class _LegacyUpgradeProvider(Protocol):
    def upgrade(self, payload: Any) -> LegacyJobUpgradeResponse: ...


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


def _preflight_service(request: Request) -> _PreflightProvider:
    service = getattr(request.app.state, "agent_preflight_service", None)
    if service is None or not callable(getattr(service, "preflight_retarget", None)):
        raise RuntimeError("agent preflight service is not configured")
    return cast("_PreflightProvider", service)


def _job_manager(request: Request) -> _JobProvider:
    service = getattr(request.app.state, "agent_job_manager", None)
    required = (
        "start_retarget",
        "get_job",
        "cancel_job",
        "retry_job",
        "list_artifacts",
        "get_artifact",
    )
    if service is None or any(not callable(getattr(service, name, None)) for name in required):
        raise RuntimeError("agent job manager is not configured")
    return cast("_JobProvider", service)


def _legacy_upgrade_service(request: Request) -> _LegacyUpgradeProvider:
    service = getattr(request.app.state, "agent_legacy_job_upgrade_service", None)
    if service is None or not callable(getattr(service, "upgrade", None)):
        raise RuntimeError("agent legacy job upgrade service is not configured")
    return cast("_LegacyUpgradeProvider", service)


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


@router.post(
    "/preflight/retarget",
    response_model=PreflightResponse,
    response_model_exclude_none=True,
)
def preflight_retarget(
    request: Request,
    preflight: RetargetPreflightRequest,
) -> PreflightResponse:
    """Resolve retarget intent without loading a solver or reserving a job."""

    return _preflight_service(request).preflight_retarget(preflight)


@router.post(
    "/jobs",
    response_model=AgentJobView,
    response_model_exclude_none=True,
    status_code=202,
)
def start_retarget_job(
    request: Request,
    submission: Annotated[
        JobStartRequest,
        Body(
            openapi_examples={
                "smoke": {
                    "summary": "Submit a preflighted smoke plan",
                    "value": {
                        "schema_version": "1.0",
                        "plan_id": f"plan:sha256:{'1' * 64}",
                        "idempotency_key": "agent-smoke-001",
                    },
                }
            }
        ),
    ],
) -> AgentJobView:
    """Submit one immutable preflight plan with caller-owned idempotency."""

    return _job_manager(request).start_retarget(
        submission.plan_id,
        idempotency_key=submission.idempotency_key,
    )


@router.get(
    "/jobs/{job_id}",
    response_model=AgentJobView,
    response_model_exclude_none=True,
)
def get_retarget_job(
    request: Request,
    job_id: str,
    after_revision: int | None = Query(default=None, ge=0),
) -> AgentJobView:
    """Return a compact job snapshot suitable for revision-aware polling."""

    return _job_manager(request).get_job(
        job_id,
        after_revision=after_revision,
    )


@router.post(
    "/jobs/{job_id}/cancel",
    response_model=AgentJobView,
    response_model_exclude_none=True,
)
def cancel_retarget_job(request: Request, job_id: str) -> AgentJobView:
    """Persist a queued or cooperative-running cancellation request."""

    return _job_manager(request).cancel_job(job_id)


@router.post(
    "/jobs/{job_id}/retry",
    response_model=AgentJobView,
    response_model_exclude_none=True,
    status_code=202,
)
def retry_retarget_job(
    request: Request,
    job_id: str,
    retry: Annotated[
        JobRetryRequest,
        Body(
            openapi_examples={
                "retry": {
                    "summary": "Create one child attempt",
                    "value": {
                        "schema_version": "1.0",
                        "idempotency_key": "agent-retry-001",
                    },
                }
            }
        ),
    ],
) -> AgentJobView:
    """Create an idempotent child attempt for one terminal parent job."""

    return _job_manager(request).retry_job(
        job_id,
        idempotency_key=retry.idempotency_key,
    )


@router.get(
    "/jobs/{job_id}/artifacts",
    response_model=ArtifactListResponse,
    response_model_exclude_none=True,
)
def list_job_artifacts(
    request: Request,
    job_id: str,
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
) -> ArtifactListResponse:
    """List a bounded page of canonical artifacts attached to one job."""

    manager = _job_manager(request)
    # List first, then read the compact view.  Canonical membership only grows,
    # so a concurrently completed job cannot make ``total`` smaller than this
    # returned page.
    artifacts = manager.list_artifacts(job_id, offset=offset, limit=limit)
    view = manager.get_job(job_id)
    if view.artifact_count is None:
        raise JobManagerError(
            ApiError(
                code="INTERNAL_ERROR",
                message="The canonical artifact count is unavailable.",
                retryable=True,
                stage=ErrorStage.INTERNAL,
            )
        )
    return ArtifactListResponse(
        job_id=job_id,
        artifacts=artifacts,
        total=view.artifact_count,
        limit=limit,
        offset=offset,
    )


@router.get(
    "/jobs/{job_id}/artifacts/{artifact_id}",
    response_model=ArtifactDescriptor,
    response_model_exclude_none=True,
)
def get_job_artifact_descriptor(
    request: Request,
    job_id: str,
    artifact_id: ArtifactId,
    verify: bool = False,
) -> ArtifactDescriptor:
    """Return metadata only after canonical job-membership authorization."""

    return _job_manager(request).get_artifact(
        job_id,
        artifact_id,
        verify=verify,
    ).descriptor


@router.get(
    "/jobs/{job_id}/artifacts/{artifact_id}/content",
    response_class=Response,
)
def download_job_artifact(
    request: Request,
    job_id: str,
    artifact_id: ArtifactId,
) -> Response:
    """Download managed bytes for a canonically attached artifact."""

    stored = _job_manager(request).get_artifact(
        job_id,
        artifact_id,
        verify=False,
    )
    if request.headers.get("range") is not None:
        raise JobManagerError(
            ApiError(
                code="RANGE_NOT_SUPPORTED",
                message="Range requests are not supported for Agent artifacts.",
                retryable=False,
                stage=ErrorStage.ARTIFACT,
            )
        )
    return verified_artifact_response(stored)


@router.post(
    "/legacy/jobspec-v1/upgrade",
    response_model=LegacyJobUpgradeResponse,
    response_model_exclude_none=True,
)
def upgrade_legacy_jobspec(
    request: Request,
    upgrade: Annotated[
        LegacyJobUpgradeRequest,
        Body(
            openapi_examples={
                "single_h2r": {
                    "summary": "Upgrade one allowlisted H2R JobSpec v1",
                    "value": {
                        "schema_version": "1.0",
                        "payload": {
                            "schema_version": 1,
                            "kind": "retarget",
                            "request": {
                                "source_path": "/srv/hhtools/motions/walk.bvh",
                                "robot": "g1_29dof",
                            },
                        },
                    },
                }
            }
        ),
    ],
) -> LegacyJobUpgradeResponse:
    """Safely re-register and preflight one legacy path-based JobSpec v1."""

    return _legacy_upgrade_service(request).upgrade(upgrade.payload)


__all__ = ["router"]
