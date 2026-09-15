"""Resumable upload staging and atomic registration into the shared asset registry."""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import threading
import uuid
import zipfile
from datetime import UTC, datetime
from pathlib import Path

from hhtools.contracts import AssetRegistrationRequest
from hhtools.contracts.assets import _validate_bundle_path
from hhtools.contracts.transfers import UploadCreateRequest

from .runtime_control import RuntimeServiceError, atomic_private_json


class UploadService:
    def __init__(self, data_dir: Path, assets, control):
        self.root = Path(data_dir) / "uploads"
        self.managed = Path(data_dir) / "managed"
        self.root.mkdir(parents=True, exist_ok=True)
        self.managed.mkdir(parents=True, exist_ok=True)
        self.assets = assets
        self.control = control
        self._lock = threading.RLock()
        self._cleanup_plans = {}

    def _path(self, upload_id):
        if not re.fullmatch(r"[a-f0-9]{32}", upload_id):
            raise RuntimeServiceError("UPLOAD_NOT_FOUND", "Upload session was not found.")
        return self.root / upload_id

    def _load(self, upload_id, subject, *, admin=False):
        try:
            document = json.loads((self._path(upload_id) / "session.json").read_text())
        except FileNotFoundError as error:
            raise RuntimeServiceError(
                "UPLOAD_NOT_FOUND", "Upload session was not found."
            ) from error
        if document["subject"] != subject and not admin:
            raise RuntimeServiceError("UPLOAD_FORBIDDEN", "Upload belongs to another principal.")
        return document

    def _view(self, document):
        root = self._path(document["upload_id"]) / "content"
        return {
            "upload_id": document["upload_id"],
            "state": document["state"],
            "asset_id": document.get("asset_id"),
            "files": [
                {
                    **item,
                    "offset": (root / item["relative_path"]).stat().st_size
                    if (root / item["relative_path"]).is_file()
                    else item["size_bytes"]
                    if document["state"] == "completed"
                    else 0,
                }
                for item in document["request"]["files"]
            ],
            "chunk_bytes": 8 * 1024**2,
        }

    def create(self, request: UploadCreateRequest, subject: str):
        total = sum(item.size_bytes for item in request.files)
        with self._lock:
            reserved = 0
            for path in self.root.glob("*/session.json"):
                document = json.loads(path.read_text())
                if document["state"] == "uploading":
                    reserved += sum(item["size_bytes"] for item in document["request"]["files"])
            if (
                total > self.control.budget.max_upload_bytes
                or reserved + total > self.control.budget.max_staging_bytes
            ):
                raise RuntimeServiceError(
                    "UPLOAD_BUDGET_EXCEEDED", "Upload exceeds the configured disk budget."
                )
            upload_id = uuid.uuid4().hex
            root = self._path(upload_id)
            (root / "content").mkdir(parents=True)
            document = {
                "upload_id": upload_id,
                "subject": subject,
                "state": "uploading",
                "request": request.model_dump(mode="json"),
                "created_at": datetime.now(UTC).isoformat(),
            }
            atomic_private_json(root / "session.json", document)
            return self._view(document)

    def get(self, upload_id, subject, *, admin=False):
        with self._lock:
            return self._view(self._load(upload_id, subject, admin=admin))

    def put(self, upload_id, member: str, offset: int, payload: bytes, subject: str):
        with self._lock:
            document = self._load(upload_id, subject)
            if document["state"] != "uploading":
                raise RuntimeServiceError("UPLOAD_CLOSED", "Upload is already finalized.")
            expected = next(
                (item for item in document["request"]["files"] if item["relative_path"] == member),
                None,
            )
            if expected is None:
                raise RuntimeServiceError(
                    "UPLOAD_MEMBER_NOT_FOUND", "Member is not in the upload manifest."
                )
            if (
                offset < 0
                or len(payload) > 8 * 1024**2
                or offset + len(payload) > expected["size_bytes"]
            ):
                raise RuntimeServiceError(
                    "INVALID_UPLOAD_CHUNK", "Chunk exceeds the member boundary."
                )
            path = self._path(upload_id) / "content" / member
            path.parent.mkdir(parents=True, exist_ok=True)
            current = path.stat().st_size if path.exists() else 0
            if offset < current:
                with path.open("rb") as stream:
                    stream.seek(offset)
                    if stream.read(len(payload)) == payload:
                        return {"offset": current}
            if offset != current:
                raise RuntimeServiceError(
                    "UPLOAD_OFFSET_CONFLICT", "Resume from the acknowledged offset.", offset=current
                )
            with path.open("ab") as stream:
                stream.write(payload)
                stream.flush()
                os.fsync(stream.fileno())
            return {"offset": current + len(payload)}

    def complete(self, upload_id, subject):
        with self._lock:
            document = self._load(upload_id, subject)
            if document["state"] == "completed":
                return self.assets.get(document["asset_id"])
            source = self._path(upload_id) / "content"
            target = self.managed / upload_id
            content = target if target.is_dir() else source
            for item in document["request"]["files"]:
                path = content / item["relative_path"]
                if not path.is_file() or path.stat().st_size != item["size_bytes"]:
                    raise RuntimeServiceError(
                        "UPLOAD_INCOMPLETE", "Not every member was completely uploaded."
                    )
                with path.open("rb") as stream:
                    if hashlib.file_digest(stream, "sha256").hexdigest() != item["sha256"]:
                        raise RuntimeServiceError(
                            "UPLOAD_HASH_MISMATCH", "An uploaded member failed verification."
                        )
            if content == source:
                os.replace(source, target)
            request = document["request"]
            relative = upload_id + ("/" + request["entry_point"] if request["entry_point"] else "")
            asset = self.assets.register(
                AssetRegistrationRequest(
                    root_id="runtime",
                    relative_path=relative,
                    kind=request["kind"],
                    display_name=request["display_name"],
                )
            )
            document.update(state="completed", asset_id=asset.asset_id)
            atomic_private_json(self._path(upload_id) / "session.json", document)
            return asset

    def abort(self, upload_id, subject):
        with self._lock:
            document = self._load(upload_id, subject)
            if document["state"] == "completed":
                raise RuntimeServiceError(
                    "ASSET_RETAINED", "Completed uploads are persistent assets."
                )
            shutil.rmtree(self._path(upload_id))
            # A failed registration may have moved verified bytes to managed storage.
            # Preserve that location conservatively; a concurrent registry reference may exist.
            return {"aborted": True}

    def import_artifact(self, stored, kind):
        descriptor = stored.descriptor
        key = hashlib.sha256((descriptor.artifact_id + str(kind)).encode()).hexdigest()
        directory = self.managed / key
        receipt_path = self.root / (key + ".json")
        with self._lock:
            if receipt_path.exists():
                return json.loads(receipt_path.read_text())
            if descriptor.size_bytes > self.control.budget.max_upload_bytes:
                raise RuntimeServiceError(
                    "UPLOAD_BUDGET_EXCEEDED", "Artifact exceeds the import budget."
                )
            staging = self.root / (key + ".import")
            staging.mkdir(exist_ok=True)
            if descriptor.format == "zip":
                with zipfile.ZipFile(stored.path) as archive:
                    entries = archive.infolist()
                    if (
                        len(entries) > 10000
                        or sum(item.file_size for item in entries)
                        > self.control.budget.max_upload_bytes
                    ):
                        raise RuntimeServiceError(
                            "UPLOAD_BUDGET_EXCEEDED", "Archive exceeds the import budget."
                        )
                    for item in entries:
                        if item.is_dir():
                            continue
                        name = _validate_bundle_path(item.filename)
                        if (item.external_attr >> 16) & 0o170000 == 0o120000:
                            raise RuntimeServiceError(
                                "INVALID_ASSET", "Archive links are not supported."
                            )
                        target = staging / name
                        target.parent.mkdir(parents=True, exist_ok=True)
                        with archive.open(item) as source, target.open("wb") as output:
                            shutil.copyfileobj(source, output)
                relative = key
            else:
                filename = "result." + (descriptor.format or "bin")
                shutil.copyfile(stored.path, staging / filename)
                relative = key + "/" + filename
            if directory.exists():
                shutil.rmtree(staging)
            else:
                os.replace(staging, directory)
            asset = self.assets.register(
                AssetRegistrationRequest(root_id="runtime", relative_path=relative, kind=kind)
            )
            receipt = {
                "asset": asset.model_dump(mode="json"),
                "origin": {
                    "job_id": descriptor.job_id,
                    "artifact_id": descriptor.artifact_id,
                    "sha256": descriptor.sha256,
                },
            }
            atomic_private_json(receipt_path, receipt)
            return receipt

    def cleanup_plan(self):
        with self._lock:
            candidates = []
            for path in sorted(self.root.glob("*/session.json")):
                document = json.loads(path.read_text())
                if document["state"] == "uploading":
                    view = self._view(document)
                    candidates.append(
                        {
                            "upload_id": document["upload_id"],
                            "offsets": [member["offset"] for member in view["files"]],
                        }
                    )
            encoded = json.dumps(candidates, sort_keys=True).encode()
            key = hashlib.sha256(encoded).hexdigest()
            self._cleanup_plans = {key: candidates}
            return {
                "cleanup_id": key,
                "uploads": candidates,
                "persistent_assets": "retained",
                "jobs_and_artifacts": "retained",
            }

    def cleanup(self, cleanup_id):
        with self._lock:
            candidates = self._cleanup_plans.get(cleanup_id)
            if candidates is None or self.cleanup_plan()["cleanup_id"] != cleanup_id:
                raise RuntimeServiceError(
                    "CLEANUP_PLAN_STALE", "Review a current cleanup plan before applying it."
                )
            for candidate in candidates:
                shutil.rmtree(self._path(candidate["upload_id"]))
            self._cleanup_plans.clear()
            return {"removed_uploads": len(candidates), "persistent_assets_removed": 0}
