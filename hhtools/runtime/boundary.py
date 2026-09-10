"""Runtime-wide authentication, scope checks, and bounded request bodies."""

from __future__ import annotations

from urllib.parse import urlsplit

from starlette.types import ASGIApp, Receive, Scope, Send

from hhtools.agent.boundary import (
    _bounded_body,
    _content_length,
    _identity_content_encoding,
    _is_loopback_literal,
    _loopback_host,
    _loopback_origin,
    agent_error_response,
)

PREFIX = "/api/runtime/v1"


def required_scope(method: str, path: str) -> str:
    if path.startswith(PREFIX + "/admin/"):
        return "admin"
    if path.endswith("/calibrations/save") or path.endswith("/calibrations/r2r/save"):
        return "calibrate"
    if method in {"GET", "HEAD"}:
        return "read"
    if path.endswith(
        (
            "/status",
            "/validate",
            "/preview",
            "/lookup",
            "/preview-document",
            "/analysis/select",
            "/analysis/compare",
        )
    ):
        return "read"
    return "write"


class RuntimeBoundary:
    def __init__(self, app: ASGIApp, *, control, allowed_origins: tuple[str, ...] = ()):
        self.app = app
        self.control = control
        self.allowed_origins = allowed_origins

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:  # noqa: PLR0911
        if scope["type"] != "http" or not scope.get("path", "").startswith("/api/"):
            await self.app(scope, receive, send)
            return
        path = scope["path"]
        headers = list(scope.get("headers", []))
        header_map = {k.decode("latin1").lower(): v.decode("latin1") for k, v in headers}

        async def reject(code: str, message: str, status: int = 403, **details):
            await agent_error_response(
                status_code=status, code=code, message=message, details=details
            )(scope, receive, send)

        local = (
            _is_loopback_literal((scope.get("client") or (None,))[0])
            and _loopback_host(headers)
            and _loopback_origin(headers)
        )
        if self.control.identity.mode == "remote" and scope.get("scheme") != "https":
            await reject("TLS_REQUIRED", "Remote Runtime requests require TLS.")
            return
        authorization = header_map.get("authorization", "")
        if sum(k.lower() == b"authorization" for k, _ in headers) > 1:
            await reject("UNAUTHORIZED", "Exactly one credential is required.", 401)
            return
        principal = None
        if authorization.startswith("Bearer "):
            principal = self.control.authenticate(authorization[7:])
        elif not authorization and local and self.control.identity.mode == "local":
            principal = {"subject": "local", "scopes": ["read", "write", "calibrate", "admin"]}
        if principal is None:
            await reject("UNAUTHORIZED", "A valid Runtime credential is required.", 401)
            return
        origin = header_map.get("origin")
        same_origin = origin == scope.get("scheme", "http") + "://" + header_map.get("host", "")
        if origin and not (local or same_origin or origin in self.allowed_origins):
            await reject("ORIGIN_FORBIDDEN", "Browser origin is not authorized.")
            return
        if origin:
            parsed = urlsplit(origin)
            if parsed.path or parsed.query or parsed.fragment or parsed.username:
                await reject("ORIGIN_FORBIDDEN", "Invalid browser origin.")
                return
        for header, expected in (
            ("x-hhtools-runtime", self.control.identity.runtime_id),
            ("x-hhtools-workspace", self.control.identity.workspace_id),
        ):
            if header in header_map and header_map[header] != expected:
                await reject("RUNTIME_MISMATCH", "The endpoint serves another workspace.", 409)
                return
        machine_path = path.startswith((PREFIX + "/", "/api/agent/v1/"))
        if not machine_path and (not local or "admin" not in principal["scopes"]):
            await reject(
                "LEGACY_LOCAL_ONLY", "This legacy operation requires local administration."
            )
            return
        required = required_scope(scope["method"], path)
        if required not in principal["scopes"] and "admin" not in principal["scopes"]:
            await reject("SCOPE_REQUIRED", "This operation requires another scope.", scope=required)
            return
        scope.setdefault("state", {})["runtime_principal"] = principal
        # This in-process marker is set only after authentication and policy checks.
        scope["state"]["runtime_authorized"] = True
        maximum = 8 * 1024**2 if "/uploads/" in path and path.endswith("/content") else 1024**2
        if machine_path:
            declared, valid = _content_length(headers)
            if not valid or not _identity_content_encoding(headers):
                await reject("INVALID_REQUEST_BODY", "Invalid body length or encoding.", 400)
                return
            if declared is not None and declared > maximum:
                await reject("REQUEST_TOO_LARGE", "Request body exceeds the route limit.", 413)
                return
            body, disconnected = await _bounded_body(receive, maximum=maximum)
            if body is None:
                await reject("REQUEST_TOO_LARGE", "Request body exceeds the route limit.", 413)
                return
            if disconnected or (declared is not None and declared != len(body)):
                await reject("INCOMPLETE_REQUEST_BODY", "Request body is incomplete.", 400)
                return
            if body and "application/json" in header_map.get("content-type", ""):
                from hhtools.agent.api import _strict_json_loads

                try:
                    _strict_json_loads(body)
                except ValueError:
                    await reject("INVALID_JSON", "Request must contain strict JSON.", 400)
                    return
            replayed = False

            async def replay():
                nonlocal replayed
                if not replayed:
                    replayed = True
                    return {"type": "http.request", "body": body, "more_body": False}
                return await receive()

            await self.app(scope, replay, send)
        else:
            await self.app(scope, receive, send)
