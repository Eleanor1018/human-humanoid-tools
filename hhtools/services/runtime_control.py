"""Persistent workspace identity, scoped credentials, and Runtime configuration."""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import secrets
import sqlite3
import tempfile
import threading
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from hhtools._version import __version__
from hhtools.contracts import ApiError, ErrorStage
from hhtools.contracts.runtime import (
    RuntimeBudget,
    RuntimeIdentity,
    RuntimeTokenReceipt,
    RuntimeTokenRequest,
)


class RuntimeServiceError(RuntimeError):
    """An expected Runtime failure safe to serialize at every adapter."""

    def __init__(self, code: str, message: str, *, retryable: bool = False, **details):
        self.api_error = ApiError(
            code=code,
            message=message,
            stage=ErrorStage.REQUEST,
            retryable=retryable,
            details=details,
        )
        super().__init__(f"{code}: {message}")


def atomic_private_json(path: Path, document: Any) -> None:
    """Publish complete JSON with owner-only permissions, including on replacement."""
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary = Path(name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            json.dump(document, stream, allow_nan=False, sort_keys=True, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


class RuntimeControl:
    """Construct only after acquiring the workspace's exclusive Runtime lease."""

    def __init__(self, data_dir: Path, *, remote: bool = False):
        self.data_dir = Path(data_dir)
        self._lock = threading.RLock()
        self._session_tokens = {}
        self._token_revocation_listeners = set()
        self._path = self.data_dir / "runtime-control.json"
        if self._path.exists():
            self._document = json.loads(self._path.read_text(encoding="utf-8"))
        else:
            backup = self.data_dir / "before-runtime-v1"
            backup.mkdir(parents=True, exist_ok=True)
            for database in self.data_dir.glob("*.sqlite3"):
                destination = backup / database.name
                if not destination.exists():
                    with (
                        sqlite3.connect(database) as source,
                        sqlite3.connect(destination) as target,
                    ):
                        source.backup(target)
            self._document = {
                "runtime_id": f"runtime:{uuid.uuid4().hex}",
                "workspace_id": f"workspace:{uuid.uuid4().hex}",
                "budget": RuntimeBudget().model_dump(),
                "tokens": [],
            }
            atomic_private_json(self._path, self._document)
        self.budget = RuntimeBudget.model_validate(self._document["budget"])
        self._apply_backend_configuration()
        self.identity = RuntimeIdentity(
            runtime_id=self._document["runtime_id"],
            workspace_id=self._document["workspace_id"],
            generation=uuid.uuid4().hex,
            version=__version__,
            started_at=datetime.now(UTC),
            mode="remote" if remote else "local",
        )

    def authenticate(self, token: str) -> dict[str, Any] | None:
        digest = hashlib.sha256(token.encode()).hexdigest()
        with self._lock:
            for record in getattr(self, "_session_tokens", {}).values():
                if hmac.compare_digest(record["sha256"], digest):
                    return {
                        "subject": record["subject"],
                        "scopes": ["admin"],
                        "token_id": record["token_id"],
                    }
            for record in self._document["tokens"]:
                if hmac.compare_digest(record["sha256"], digest):
                    return {
                        "subject": record["subject"],
                        "scopes": list(record["scopes"]),
                        "token_id": record["token_id"],
                    }
        return None

    def issue_session_token(self, session_id: str, *, token_id: str | None = None):
        token = secrets.token_urlsafe(48)
        with self._lock:
            if token_id is not None and not any(
                record["token_id"] == token_id for record in self._document["tokens"]
            ):
                raise RuntimeServiceError("UNAUTHORIZED", "The operator credential was revoked.")
            self._session_tokens[session_id] = {
                "sha256": hashlib.sha256(token.encode()).hexdigest(),
                "subject": "gui-session:" + session_id,
                "token_id": token_id,
            }
        return token

    def authenticate_session_token(self, token: str):
        digest = hashlib.sha256(token.encode()).hexdigest()
        with self._lock:
            for record in getattr(self, "_session_tokens", {}).values():
                if hmac.compare_digest(record["sha256"], digest):
                    return {
                        "subject": record["subject"],
                        "scopes": ["admin"],
                        "token_id": record["token_id"],
                    }
        return None

    def revoke_session_token(self, session_id: str):
        with self._lock:
            getattr(self, "_session_tokens", {}).pop(session_id, None)

    def issue_token(self, request: RuntimeTokenRequest) -> RuntimeTokenReceipt:
        token = secrets.token_urlsafe(48)
        receipt = RuntimeTokenReceipt(
            token_id=uuid.uuid4().hex,
            subject=request.subject,
            scopes=sorted(set(request.scopes)),
            token=token,
        )
        record = receipt.model_dump(exclude={"token"})
        record["sha256"] = hashlib.sha256(token.encode()).hexdigest()
        with self._lock:
            self._document["tokens"].append(record)
            atomic_private_json(self._path, self._document)
        return receipt

    def revoke_token(self, token_id: str) -> dict[str, bool]:
        with self._lock:
            self._document["tokens"] = [
                item for item in self._document["tokens"] if item["token_id"] != token_id
            ]
            atomic_private_json(self._path, self._document)
            self._session_tokens = {
                key: record
                for key, record in self._session_tokens.items()
                if record["token_id"] != token_id
            }
            listeners = tuple(self._token_revocation_listeners)
        # Closing workers can wait on GUI requests that also authenticate here.
        for listener in listeners:
            listener(token_id)
        return {"revoked": True}

    def add_token_revocation_listener(self, listener):
        with self._lock:
            self._token_revocation_listeners.add(listener)

    def remove_token_revocation_listener(self, listener):
        with self._lock:
            self._token_revocation_listeners.discard(listener)

    def list_tokens(self) -> list[dict[str, Any]]:
        with self._lock:
            return [
                {key: value for key, value in item.items() if key != "sha256"}
                for item in self._document["tokens"]
            ]

    def save_budget(self, budget: RuntimeBudget) -> RuntimeBudget:
        with self._lock:
            self._document["budget"] = budget.model_dump()
            atomic_private_json(self._path, self._document)
            self.budget = budget.model_copy(deep=True)
            return self.budget.model_copy(deep=True)

    def scoped_key(self, subject: str, operation: str, key: str) -> str:
        payload = [self.identity.workspace_id, subject, operation, key]
        return "runtime:" + hashlib.sha256(json.dumps(payload).encode()).hexdigest()

    def asset_trusted(self, asset_id: str) -> bool:
        with self._lock:
            return asset_id in self._document.get("trusted_assets", [])

    def trust_asset(self, asset_id: str) -> dict:
        with self._lock:
            trusted = self._document.setdefault("trusted_assets", [])
            if asset_id not in trusted:
                trusted.append(asset_id)
                atomic_private_json(self._path, self._document)
        return {"asset_id": asset_id, "execution_authorized": True}

    def _apply_backend_configuration(self) -> None:
        for key, variable in {
            "gvhmr_root": "HHTOOLS_GVHMR_ROOT",
            "gvhmr_python": "HHTOOLS_GVHMR_PYTHON",
            "body_models_root": "HHTOOLS_GVHMR_BODY_MODELS",
        }.items():
            value = self._document.get("backend_configuration", {}).get(key)
            if value:
                os.environ[variable] = value
                if key == "body_models_root":
                    os.environ["HHTOOLS_BODY_MODELS"] = value

    def configure_backends(self, request) -> dict[str, bool]:
        document = request.model_dump(exclude_none=True)
        for value in document.values():
            if not Path(value).is_absolute() or not Path(value).exists():
                raise RuntimeServiceError(
                    "BACKEND_PATH_UNAVAILABLE",
                    "Configured backend paths must exist on the Runtime host.",
                )
        with self._lock:
            self._document.setdefault("backend_configuration", {}).update(document)
            atomic_private_json(self._path, self._document)
            self._apply_backend_configuration()
        return {key: True for key in document}
