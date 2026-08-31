"""Compatibility helpers for Viser's legacy MDX markdown renderer.

Viser 1.0.x forwards HTML ``style`` attributes from markdown as string React
props.  React requires an object for ``style``, so a single inline style can
replace the whole component with ``Markdown Failed to Render``.  Keep this
workaround at the GUI boundary so both initial content and later handle updates
are treated consistently.

This module is intentionally not a general-purpose HTML sanitizer.  It only
removes the unsupported attribute from hhtools-controlled status markup.  The
original strings retain their styles so the workaround can be removed after a
released Viser version adopts the fixed markdown pipeline.
"""

from __future__ import annotations

import re
from typing import Any

_INLINE_STYLE_ATTRIBUTE = re.compile(
    r"""\s+style\s*=\s*(?:"[^"<>]*"|'[^'<>]*'|(?!\{)[^\s<>"']+)""",
    re.IGNORECASE,
)
_MARKUP_TAG = re.compile(r"<[^<>]+>")
_NON_SELF_CLOSING_BREAK = re.compile(r"<br\s*>", re.IGNORECASE)


def sanitize_markdown_for_viser(content: str) -> str:
    """Remove inline ``style`` attributes unsupported by Viser 1.0.x MDX.

    Angle brackets are excluded from every attribute-value branch so malformed
    quotes cannot consume later tags or paragraphs.  The expression also
    accepts mixed-case and unquoted string attributes for defensive
    compatibility with future hhtools-controlled markup.  Values beginning
    with ``{`` are intentionally preserved because they are MDX expressions,
    not the string prop that triggers React error #62.
    """

    without_string_styles = _MARKUP_TAG.sub(
        lambda match: _INLINE_STYLE_ATTRIBUTE.sub("", match.group(0)),
        content,
    )
    # MDX parses HTML-like tags as JSX, where void elements must be explicitly
    # self-closing.  Normalizing the legacy spelling prevents an independent
    # parse failure in status and modal copy.
    return _NON_SELF_CLOSING_BREAK.sub("<br/>", without_string_styles)


def add_safe_markdown(gui: Any, content: str, **kwargs: Any) -> Any:
    """Create a Viser markdown handle after applying the compatibility pass."""

    return gui.add_markdown(sanitize_markdown_for_viser(content), **kwargs)


def set_safe_markdown(handle: Any, content: str) -> None:
    """Update a Viser markdown handle through the same compatibility pass."""

    handle.content = sanitize_markdown_for_viser(content)
