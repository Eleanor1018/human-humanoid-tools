"""Transport-neutral guard against leaking host filesystem paths in JSON."""

from __future__ import annotations

import math
import re
from pathlib import PurePosixPath, PureWindowsPath
from typing import Any
from urllib.parse import parse_qsl, urlsplit

_CONTROLLED_RESOURCE_URI_FRAGMENT = re.compile(
    r"(?:hhtools|https?)://"
    r"(?:\[[0-9A-Fa-f:.%]+\](?::[0-9]{1,5})?|[A-Za-z0-9._~-]+(?::[0-9]{1,5})?)"
    r"(?:[/?#][A-Za-z0-9._~:/?#@!$&*+,;=%-]*)?",
    re.IGNORECASE,
)
_EMBEDDED_URI_SCHEME = re.compile(r"(?<![A-Za-z0-9])([A-Za-z][A-Za-z0-9+.-]*)://")
_EMBEDDED_FILE_URI = re.compile(r"(?<![A-Za-z0-9])file:", re.IGNORECASE)
_EMBEDDED_WINDOWS_PATH = re.compile(r"(?<![A-Za-z0-9])(?:[A-Za-z]:[\\/]|\\\\)[^\s\"']*")
_EMBEDDED_POSIX_PATH = re.compile(r"(?<![A-Za-z0-9/])/(?![/\s])[^\s\"']*")
_EMBEDDED_PROTOCOL_RELATIVE = re.compile(r"(?<![A-Za-z0-9/])//[^\s\"']+")
_UI_QUERY_KEY = re.compile(r"^[a-z][a-z0-9_-]{0,63}$")


class PortableJsonError(ValueError):
    """A public JSON document contains a non-portable value."""


def _safe_same_origin_ui_url(value: str) -> bool:
    if value == "/":
        return True
    if not value.startswith("/?") or value.startswith("//"):
        return False
    parsed = urlsplit(value)
    if parsed.scheme or parsed.netloc or parsed.path != "/" or parsed.fragment:
        return False
    try:
        fields = parse_qsl(parsed.query, keep_blank_values=True, max_num_fields=16)
    except ValueError:
        return False
    return all(
        _UI_QUERY_KEY.fullmatch(key) is not None
        and len(item) <= 256
        and not looks_like_host_path(item)
        for key, item in fields
    )


def looks_like_host_path(
    value: str,
    *,
    allow_same_origin_ui_url: bool = False,
) -> bool:
    """Detect standalone or embedded POSIX, Windows, UNC, and file paths."""

    if _EMBEDDED_FILE_URI.search(value):
        return True
    for match in _EMBEDDED_URI_SCHEME.finditer(value):
        if match.group(1).casefold() not in {"hhtools", "http", "https"}:
            return True
    masked = _CONTROLLED_RESOURCE_URI_FRAGMENT.sub("", value)
    if allow_same_origin_ui_url and _safe_same_origin_ui_url(value):
        return False
    posix = PurePosixPath(masked)
    windows = PureWindowsPath(masked)
    if posix.is_absolute() or windows.is_absolute() or windows.drive or windows.root:
        return True
    return bool(
        _EMBEDDED_WINDOWS_PATH.search(masked)
        or _EMBEDDED_POSIX_PATH.search(masked)
        or _EMBEDDED_PROTOCOL_RELATIVE.search(masked)
    )


def validate_portable_json(value: Any) -> None:
    """Require finite JSON without host paths; allow a verified NextAction URL."""

    if value is None or isinstance(value, bool | int):
        return
    if isinstance(value, float):
        if not math.isfinite(value):
            raise PortableJsonError("non-finite number")
        return
    if isinstance(value, str):
        if looks_like_host_path(value):
            raise PortableJsonError("host path")
        return
    if isinstance(value, list):
        for item in value:
            validate_portable_json(item)
        return
    if isinstance(value, dict):
        next_action = value.get("actor") in {"agent", "human", "system"} and isinstance(
            value.get("action"), str
        )
        for key, item in value.items():
            if not isinstance(key, str) or looks_like_host_path(key):
                raise PortableJsonError("invalid object key")
            if (
                next_action
                and key == "url"
                and isinstance(item, str)
                and _safe_same_origin_ui_url(item)
            ):
                continue
            validate_portable_json(item)
        return
    raise PortableJsonError("non-JSON value")


__all__ = ["PortableJsonError", "looks_like_host_path", "validate_portable_json"]
