"""Transport-only contracts for the single, server-rendered HHTools application."""

from typing import Annotated, Literal

from pydantic import ConfigDict, Field, field_validator

from .assets import _validate_bundle_path
from .common import ContractModel


class GuiSessionRequest(ContractModel):
    mode: Literal["webrtc"] = "webrtc"
    width: Annotated[int, Field(ge=320, le=1920)] = 1440
    height: Annotated[int, Field(ge=320, le=1080)] = 900
    fps: Annotated[int, Field(ge=5, le=30)] = 24
    ttl_seconds: Annotated[int, Field(ge=30, le=600)] = 300


class GuiInput(ContractModel):
    model_config = ConfigDict(str_strip_whitespace=False)
    action: Literal[
        "move", "down", "up", "wheel", "key_down", "key_up", "text", "release", "resize"
    ]
    x: Annotated[float, Field(ge=0, le=1920, allow_inf_nan=False)] = 0
    y: Annotated[float, Field(ge=0, le=1080, allow_inf_nan=False)] = 0
    button: Literal["left", "middle", "right"] = "left"
    delta_x: Annotated[float, Field(ge=-5000, le=5000, allow_inf_nan=False)] = 0
    delta_y: Annotated[float, Field(ge=-5000, le=5000, allow_inf_nan=False)] = 0
    key: Annotated[str, Field(max_length=64)] = ""
    text: Annotated[str, Field(max_length=16000)] = ""
    width: Annotated[int, Field(ge=320, le=1920)] = 1440
    height: Annotated[int, Field(ge=320, le=1080)] = 900


class GuiUploadFile(ContractModel):
    relative_path: str
    size_bytes: Annotated[int, Field(ge=0, le=4 * 1024**3)]

    @field_validator("relative_path")
    @classmethod
    def valid_path(cls, value):
        return _validate_bundle_path(value)


class GuiUploadRequest(ContractModel):
    chooser_id: Annotated[str, Field(min_length=1, max_length=64)]
    files: Annotated[list[GuiUploadFile], Field(min_length=1, max_length=4096)]
    x: Annotated[float, Field(ge=0, le=1920, allow_inf_nan=False)] = 0
    y: Annotated[float, Field(ge=0, le=1080, allow_inf_nan=False)] = 0
