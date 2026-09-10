"""Dependency-light Runtime SDK with identity binding and verified file transfers."""

from __future__ import annotations

import hashlib
import ipaddress
import json
import os
import ssl
from collections.abc import Mapping
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, HTTPSHandler, Request, build_opener

from hhtools.contracts import ApiError, ErrorStage

PREFIX = "/api/runtime/v1"


class RuntimeClientError(RuntimeError):
    def __init__(self, error: ApiError):
        self.api_error = error
        super().__init__(f"{error.code}: {error.message}")


def client_error(code: str, message: str, *, retryable: bool = False) -> RuntimeClientError:
    return RuntimeClientError(
        ApiError(
            code=code,
            message=message,
            stage=ErrorStage.REQUEST,
            retryable=retryable,
        )
    )


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class RuntimeClient:
    """A connection never owns or stops the Runtime it accesses.

    Credentials are sent only to the configured origin. Once connected, every
    request carries the expected persistent Runtime and workspace identities.
    """

    def __init__(
        self,
        endpoint: str,
        *,
        token: str | None = None,
        runtime_id: str | None = None,
        workspace_id: str | None = None,
        timeout: float = 35.0,
        ca_file: Path | None = None,
    ):
        parsed = urlsplit(endpoint)
        if (
            parsed.scheme not in {"http", "https"}
            or not parsed.hostname
            or parsed.username
            or parsed.password
            or parsed.query
            or parsed.fragment
            or parsed.path not in {"", "/"}
        ):
            raise client_error("INVALID_ENDPOINT", "Use an HTTP(S) origin without credentials.")
        try:
            local = ipaddress.ip_address(parsed.hostname).is_loopback
        except ValueError:
            local = parsed.hostname == "localhost"
        if parsed.scheme != "https" and not local:
            raise client_error("TLS_REQUIRED", "Remote Runtime connections require HTTPS.")
        if not 0 < timeout <= 3600:
            raise client_error("INVALID_PARAMETER", "Timeout must be between 0 and 3600 seconds.")
        self.endpoint = endpoint.rstrip("/")
        self.token = token
        self.runtime_id = runtime_id
        self.workspace_id = workspace_id
        self.timeout = timeout
        authority_file = ca_file or os.environ.get("HHTOOLS_RUNTIME_CA")
        self._opener = build_opener(
            _NoRedirect(), HTTPSHandler(context=ssl.create_default_context(cafile=authority_file))
        )
        self._operations: dict[str, dict[str, Any]] | None = None

    def _open(self, method: str, path: str, *, query=None, payload=None, headers=None):
        if not path.startswith("/api/") or "//" in path or "?" in path or "#" in path:
            raise client_error("INVALID_ENDPOINT", "Invalid Runtime resource path.")
        request_headers = {"Accept": "application/json", **(headers or {})}
        if self.token:
            request_headers["Authorization"] = f"Bearer {self.token}"
        if self.runtime_id:
            request_headers["X-HHTools-Runtime"] = self.runtime_id
        if self.workspace_id:
            request_headers["X-HHTools-Workspace"] = self.workspace_id
        values = {
            k: str(v).lower() if isinstance(v, bool) else v
            for k, v in (query or {}).items()
            if v is not None
        }
        suffix = "?" + urlencode(values) if values else ""
        request = Request(
            self.endpoint + path + suffix, data=payload, headers=request_headers, method=method
        )
        try:
            return self._opener.open(request, timeout=self.timeout)
        except HTTPError as error:
            try:
                body = error.read(1024 * 1024)
                failure = ApiError.model_validate_json(body)
            except (ValueError, OSError):
                failure = ApiError(
                    code="HTTP_ERROR",
                    message="Runtime request failed.",
                    stage=ErrorStage.REQUEST,
                    retryable=error.code >= 500,
                    details={"status": error.code},
                )
            raise RuntimeClientError(failure) from None
        except (OSError, URLError) as error:
            raise client_error(
                "RUNTIME_UNAVAILABLE", "Runtime connection failed.", retryable=True
            ) from error

    def request(self, method: str, path: str, *, document=None, query=None) -> Any:
        payload = json.dumps(document, allow_nan=False).encode() if document is not None else None
        with self._open(
            method, path, query=query, payload=payload, headers={"Content-Type": "application/json"}
        ) as response:
            body = response.read(16 * 1024**2 + 1)
        if len(body) > 16 * 1024**2:
            raise client_error("RESPONSE_TOO_LARGE", "Fetch large results through artifacts.")
        try:
            return json.loads(body)
        except ValueError as error:
            raise client_error("INVALID_RESPONSE", "Runtime returned invalid JSON.") from error

    def connect(self) -> dict[str, Any]:
        identity = self.request("GET", PREFIX + "/identity")
        if (self.runtime_id and identity["runtime_id"] != self.runtime_id) or (
            self.workspace_id and identity["workspace_id"] != self.workspace_id
        ):
            raise client_error("RUNTIME_MISMATCH", "The endpoint serves another workspace.")
        self.runtime_id = identity["runtime_id"]
        self.workspace_id = identity["workspace_id"]
        return identity

    def operations(self, *, refresh: bool = False) -> list[dict[str, Any]]:
        if self._operations is None or refresh:
            if not self.runtime_id:
                self.connect()
            catalog = self.request("GET", PREFIX + "/operations")
            self._operations = {item["name"]: item for item in catalog["operations"]}
        return list(self._operations.values())

    def call(self, operation: str, arguments: Mapping[str, Any] | None = None) -> Any:
        """Call a discoverable operation using its published input schema."""
        self.operations()
        descriptor = (self._operations or {}).get(operation)
        if descriptor is None:
            raise client_error("OPERATION_NOT_FOUND", "Unknown Runtime operation.")
        values = dict(arguments or {})
        path = descriptor["path"]
        for name in descriptor["path_parameters"]:
            if name not in values:
                raise client_error("INVALID_PARAMETER", f"Missing parameter: {name}.")
            path = path.replace("{" + name + "}", quote(str(values.pop(name)), safe=""))
        query = {
            name: values.pop(name) for name in descriptor["query_parameters"] if name in values
        }
        body_name = descriptor.get("body_parameter")
        document = values.pop(body_name, None) if body_name else None
        if values:
            raise client_error("INVALID_PARAMETER", "Unknown operation parameters.")
        return self.request(descriptor["method"], path, document=document, query=query)

    def download(self, job_id: str, artifact_id: str, destination: Path) -> dict[str, Any]:
        """Resume into a partial file; publish only after size and SHA-256 verification."""
        if not self.runtime_id:
            self.connect()
        path = PREFIX + f"/jobs/{quote(job_id, safe='')}/artifacts/{quote(artifact_id, safe='')}"
        descriptor = self.request("GET", path)
        destination = Path(destination)
        destination.parent.mkdir(parents=True, exist_ok=True)
        partial = destination.with_name(destination.name + ".hhtools-part")
        partial.touch(exist_ok=True)
        offset = partial.stat().st_size if partial.exists() else 0
        headers = {"Accept": "application/octet-stream"}
        if offset and offset < descriptor["size_bytes"]:
            headers["Range"] = f"bytes={offset}-"
            headers["If-Range"] = '"' + descriptor["sha256"] + '"'
        elif offset != descriptor["size_bytes"]:
            offset = 0
        if offset != descriptor["size_bytes"]:
            with self._open("GET", path + "/content", headers=headers) as response:
                if response.status != 206:
                    offset = 0
                with partial.open("ab" if offset else "wb") as stream:
                    while chunk := response.read(1024**2):
                        stream.write(chunk)
                        if stream.tell() > descriptor["size_bytes"]:
                            raise client_error(
                                "ARTIFACT_HASH_MISMATCH", "Artifact exceeds its declared size."
                            )
                    stream.flush()
                    os.fsync(stream.fileno())
        with partial.open("rb") as stream:
            digest = hashlib.file_digest(stream, "sha256").hexdigest()
        if partial.stat().st_size != descriptor["size_bytes"] or digest != descriptor["sha256"]:
            partial.unlink(missing_ok=True)
            raise client_error("ARTIFACT_HASH_MISMATCH", "Downloaded artifact failed verification.")
        os.replace(partial, destination)
        return descriptor

    def upload(
        self, source: Path, *, kind: str, upload_id: str | None = None, on_session=None
    ) -> dict:
        """Upload a file or bundle. Persist on_session's ID to resume after disconnect."""
        if not self.runtime_id:
            self.connect()
        source = Path(source)
        if source.is_symlink():
            raise client_error("INVALID_ASSET", "Uploads must not contain symbolic links.")
        paths = sorted(source.rglob("*")) if source.is_dir() else [source]
        if any(path.is_symlink() for path in paths):
            raise client_error("INVALID_ASSET", "Uploads must not contain symbolic links.")
        files = []
        local = {}
        for path in paths:
            if not path.is_file():
                continue
            name = path.relative_to(source).as_posix() if source.is_dir() else path.name
            with path.open("rb") as stream:
                digest = hashlib.file_digest(stream, "sha256").hexdigest()
            files.append(
                {
                    "relative_path": name,
                    "sha256": digest,
                    "size_bytes": path.stat().st_size,
                    "role": "other",
                }
            )
            local[name] = path
        if upload_id is None:
            session = self.request(
                "POST",
                PREFIX + "/uploads",
                document={
                    "kind": kind,
                    "files": files,
                    "entry_point": None if source.is_dir() else source.name,
                    "display_name": source.name,
                },
            )
        else:
            session = self.request("GET", PREFIX + "/uploads/" + quote(upload_id, safe=""))

            def identity(items):
                return {
                    (item["relative_path"], item["sha256"], item["size_bytes"]) for item in items
                }

            if identity(files) != identity(session["files"]):
                raise client_error(
                    "UPLOAD_SOURCE_CHANGED", "Local files no longer match the upload manifest."
                )
        upload_id = session["upload_id"]
        if on_session:
            on_session(upload_id)
        try:
            for member in session["files"]:
                with local[member["relative_path"]].open("rb") as stream:
                    offset = member["offset"]
                    stream.seek(offset)
                    while payload := stream.read(session["chunk_bytes"]):
                        with self._open(
                            "PUT",
                            PREFIX + f"/uploads/{upload_id}/content",
                            query={"member": member["relative_path"], "offset": offset},
                            payload=payload,
                            headers={"Content-Type": "application/octet-stream"},
                        ) as response:
                            offset = json.loads(response.read(4096))["offset"]
                    if member["size_bytes"] == 0 and session["state"] != "completed":
                        with self._open(
                            "PUT",
                            PREFIX + f"/uploads/{upload_id}/content",
                            query={"member": member["relative_path"], "offset": 0},
                            payload=b"",
                        ):
                            pass
            return self.request("POST", PREFIX + f"/uploads/{upload_id}/complete")
        except RuntimeClientError as error:
            error.api_error.details["upload_id"] = upload_id
            raise
