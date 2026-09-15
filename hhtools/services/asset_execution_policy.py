"""Require explicit content-scoped trust before executing uploaded serialization formats."""

from __future__ import annotations

import json
import zipfile
from pathlib import PurePosixPath

from hhtools.contracts import ApiError, ErrorStage, NextAction
from hhtools.contracts.portability import validate_portable_json

from .assets import AssetServiceError


class AssetExecutionPolicy:
    """Host roots are operator-configured; uploaded code-capable data needs admin scope."""

    def __init__(self, assets, control):
        self.assets = assets
        self.control = control
        self._safe = set()

    @staticmethod
    def _object_array(stream):
        from numpy.lib import format as npformat

        version = npformat.read_magic(stream)
        reader = {
            (1, 0): npformat.read_array_header_1_0,
            (2, 0): npformat.read_array_header_2_0,
        }.get(version)
        # Versions without a public header reader need explicit operator trust.
        if reader is None:
            return True
        _, _, dtype = reader(stream)
        return dtype.hasobject

    @staticmethod
    def _unsafe_metadata(value):
        try:
            validate_portable_json(value)
        except ValueError:
            return True
        pending = [value]
        while pending:
            item = pending.pop()
            if isinstance(item, dict):
                pending.extend(item.values())
            elif isinstance(item, list):
                pending.extend(item)
            elif isinstance(item, str) and ".." in PurePosixPath(item.replace("\\", "/")).parts:
                return True
        return False

    def require(self, asset_id: str) -> None:
        bundle = self.assets.get(asset_id)
        if bundle.source is not None and bundle.source.root_id != "runtime":
            return
        if asset_id in self._safe or self.control.asset_trusted(asset_id):
            return
        requires_trust = False
        for member in bundle.files:
            suffix = member.relative_path.rsplit(".", 1)[-1].lower()
            if suffix in {"pkl", "pickle", "pt", "pth"}:
                requires_trust = True
                break
            if suffix not in {"npy", "npz"}:
                continue
            path = self.assets._registry.resolve_file(
                asset_id, member.relative_path, verify_hash=True
            )
            try:
                if suffix == "npy":
                    with path.open("rb") as stream:
                        requires_trust = self._object_array(stream)
                else:
                    with zipfile.ZipFile(path) as archive:
                        for item in archive.infolist():
                            if item.filename.endswith(".npy"):
                                with archive.open(item) as stream:
                                    if self._object_array(stream):
                                        requires_trust = True
                                        break
                                if item.filename in {"meta_json.npy", "objects_mesh_paths.npy"}:
                                    if item.file_size > 1024**2:
                                        requires_trust = True
                                        break
                                    import numpy as np

                                    with archive.open(item) as stream:
                                        value = np.lib.format.read_array(
                                            stream, allow_pickle=False
                                        ).tolist()
                                    if item.filename == "meta_json.npy":
                                        value = json.loads(value)
                                    if self._unsafe_metadata(value):
                                        requires_trust = True
                                        break
            except (OSError, ValueError, zipfile.BadZipFile):
                requires_trust = True
            if requires_trust:
                break
        if requires_trust:
            raise AssetServiceError(
                ApiError(
                    code="INPUT_TRUST_REQUIRED",
                    message="This uploaded bundle contains code-capable serialization.",
                    stage=ErrorStage.PREFLIGHT,
                    details={"asset_id": asset_id, "required_scope": "admin"},
                    next_action=NextAction(
                        actor="agent",
                        action="authorize_asset_execution",
                        parameters={
                            "operation": "hhtools_runtime_trust_asset",
                            "asset_id": asset_id,
                        },
                    ),
                )
            )
        self._safe.add(asset_id)
