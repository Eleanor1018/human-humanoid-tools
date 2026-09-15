"""Manifest-verified, resumable upload sessions for portable asset bundles."""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import Field, field_validator, model_validator

from .assets import AssetFile, AssetKind, _validate_bundle_path
from .common import ArtifactId, AssetId, ContractModel


class UploadCreateRequest(ContractModel):
    kind: AssetKind
    files: Annotated[list[AssetFile], Field(min_length=1, max_length=10000)]
    entry_point: str | None = None
    display_name: Annotated[str | None, Field(default=None, max_length=256)]

    @field_validator("entry_point")
    @classmethod
    def validate_entry_point(cls, value):
        return _validate_bundle_path(value) if value is not None else None

    @model_validator(mode="after")
    def validate_members(self):
        names = {item.relative_path for item in self.files}
        if len(names) != len(self.files):
            raise ValueError("Duplicate bundle members")
        for name in names:
            parts = name.split("/")
            if any("/".join(parts[:index]) in names for index in range(1, len(parts))):
                raise ValueError("Bundle members conflict with directories")
        if self.entry_point is not None and self.entry_point not in names:
            raise ValueError("Entry point must be a bundle member")
        return self


class UploadedMember(AssetFile):
    offset: Annotated[int, Field(ge=0)]


class UploadSession(ContractModel):
    upload_id: str
    state: Literal["uploading", "completed"]
    asset_id: AssetId | None = None
    files: list[UploadedMember]
    chunk_bytes: int


class ArtifactImportRequest(ContractModel):
    job_id: str
    artifact_id: ArtifactId
    kind: AssetKind = AssetKind.MOTION_BUNDLE


class AssetMemberImportRequest(ContractModel):
    asset_id: AssetId
    member: str
    kind: AssetKind = AssetKind.MOTION_BUNDLE

    @field_validator("member")
    @classmethod
    def validate_member(cls, value):
        return _validate_bundle_path(value)
