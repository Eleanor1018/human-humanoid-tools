"""Resource-bound preview sessions and low-latency viewport inputs."""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import AwareDatetime, ConfigDict, Field, field_validator, model_validator

from .assets import _validate_bundle_path
from .common import ArtifactId, AssetId, ContractModel, Sha256Hex


class PreviewSource(ContractModel):
    asset_id: AssetId | None = None
    robot_asset_id: AssetId | None = None
    job_id: str | None = None
    artifact_id: ArtifactId | None = None
    member: str | None = None

    @field_validator("member")
    @classmethod
    def validate_member(cls, value):
        return _validate_bundle_path(value) if value is not None else None

    @model_validator(mode="after")
    def validate_source(self):
        if (self.asset_id is None) == (self.job_id is None):
            raise ValueError("Choose exactly one asset or job source")
        if self.artifact_id and not self.job_id:
            raise ValueError("An artifact requires its owning job")
        if self.member and not self.asset_id:
            raise ValueError("A bundle member requires an asset")
        return self


class PreviewCreateRequest(ContractModel):
    source: PreviewSource
    mode: Literal["data", "webrtc"] = "data"
    width: Annotated[int, Field(ge=160, le=1280)] = 960
    height: Annotated[int, Field(ge=120, le=720)] = 540
    fps: Annotated[int, Field(ge=1, le=30)] = 24
    ttl_seconds: Annotated[int, Field(ge=15, le=600)] = 120


class PreviewOffer(ContractModel):
    model_config = ConfigDict(str_strip_whitespace=False)
    type: Literal["offer"] = "offer"
    sdp: Annotated[str, Field(min_length=1, max_length=256000)]


class PreviewSession(ContractModel):
    session_id: str
    request: PreviewCreateRequest
    state: Literal["ready", "closed", "expired"]
    reason: str | None = None
    frame_count: int
    duration_seconds: float
    expires_at: AwareDatetime


class PreviewAnswer(ContractModel):
    model_config = ConfigDict(str_strip_whitespace=False)
    type: Literal["answer"] = "answer"
    sdp: str


class PreviewInput(ContractModel):
    action: Literal["orbit", "zoom", "seek", "play", "pause"]
    sequence: Annotated[int, Field(ge=0)] = 0
    x: Annotated[float, Field(ge=-360, le=360, allow_inf_nan=False)] = 0
    y: Annotated[float, Field(ge=-90, le=90, allow_inf_nan=False)] = 0
    value: Annotated[float, Field(ge=0, le=1000000, allow_inf_nan=False)] = 0


class PreviewRenderParameters(ContractModel):
    source: PreviewSource
    artifact_sha256: Sha256Hex | None = None
    format: Literal["png", "mp4"] = "png"
    width: Annotated[int, Field(ge=160, le=1280)] = 960
    height: Annotated[int, Field(ge=120, le=720)] = 540
    start_frame: Annotated[int, Field(ge=0)] = 0
    frames: Annotated[int, Field(ge=1, le=180)] = 60
    fps: Annotated[int, Field(ge=1, le=30)] = 24

    @model_validator(mode="after")
    def validate_video_dimensions(self):
        if self.format == "mp4" and (self.width % 2 or self.height % 2):
            raise ValueError("MP4 dimensions must be even")
        return self
