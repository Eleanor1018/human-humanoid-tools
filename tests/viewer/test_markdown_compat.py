from __future__ import annotations

import ast
from pathlib import Path

import pytest

from hhtools.viewer.markdown_compat import (
    add_safe_markdown,
    sanitize_markdown_for_viser,
    set_safe_markdown,
)


@pytest.mark.parametrize(
    ("source", "expected"),
    [
        ("<span style='color:red'>x</span>", "<span>x</span>"),
        ('<div STYLE = "opacity:0.7" id="row">x</div>', '<div id="row">x</div>'),
        ("<b style=color:red>x</b>", "<b>x</b>"),
        (
            "<div style='padding:1px'><span style=opacity:.5>x</span></div>",
            "<div><span>x</span></div>",
        ),
    ],
)
def test_sanitize_markdown_removes_string_style_attributes(source: str, expected: str) -> None:
    assert sanitize_markdown_for_viser(source) == expected


@pytest.mark.parametrize(
    "source",
    [
        "Plain markdown without HTML.",
        "Explain style='compact' as ordinary text.",
        "<span data-style='compact' aria-label='status'>ok</span>",
        "<span style={{color: 'red'}}>valid MDX expression</span>",
        "<span style={styleObject}>valid MDX expression</span>",
        "<span style='unterminated><b>later tag survives</b>",
    ],
)
def test_sanitize_markdown_preserves_non_target_content(source: str) -> None:
    assert sanitize_markdown_for_viser(source) == source


def test_sanitize_markdown_is_idempotent() -> None:
    source = "<div style='color:red'><span STYLE=opacity:.5>status</span></div>"
    once = sanitize_markdown_for_viser(source)
    assert sanitize_markdown_for_viser(once) == once


def test_sanitize_markdown_normalizes_legacy_break_tags_for_mdx() -> None:
    source = "saved calibration.<br>Open editor?<BR >Done.<br/>"
    assert sanitize_markdown_for_viser(source) == (
        "saved calibration.<br/>Open editor?<br/>Done.<br/>"
    )


def test_add_safe_markdown_sanitizes_and_preserves_handle_and_kwargs() -> None:
    sentinel = object()

    class FakeGui:
        call: tuple[str, dict[str, object]] | None = None

        def add_markdown(self, content: str, **kwargs: object) -> object:
            self.call = (content, kwargs)
            return sentinel

    gui = FakeGui()
    handle = add_safe_markdown(
        gui,
        "<span style='color:red'>ready</span>",
        visible=False,
        order=3,
        image_root="assets",
    )

    assert handle is sentinel
    assert gui.call == (
        "<span>ready</span>",
        {"visible": False, "order": 3, "image_root": "assets"},
    )


def test_set_safe_markdown_sanitizes_every_dynamic_update() -> None:
    class FakeHandle:
        content = ""

    handle = FakeHandle()
    set_safe_markdown(handle, "<span style='opacity:.5'>loading</span>")
    assert handle.content == "<span>loading</span>"

    set_safe_markdown(handle, '<b STYLE="color:green">done</b>')
    assert handle.content == "<b>done</b>"


def test_viewer_modules_cannot_bypass_markdown_compatibility_boundary() -> None:
    repo_root = Path(__file__).parents[2]
    viewer_dir = repo_root / "hhtools" / "viewer"
    violations: list[str] = []

    for source_path in viewer_dir.rglob("*.py"):
        if source_path.name == "markdown_compat.py":
            continue
        location = source_path.relative_to(repo_root)
        tree = ast.parse(source_path.read_text(encoding="utf-8"), filename=str(source_path))

        for node in ast.walk(tree):
            if isinstance(node, ast.Call):
                if isinstance(node.func, ast.Attribute) and node.func.attr == "add_markdown":
                    violations.append(f"direct add_markdown call at {location}:{node.lineno}")
                if (
                    isinstance(node.func, ast.Name)
                    and node.func.id == "setattr"
                    and len(node.args) >= 2
                    and isinstance(node.args[1], ast.Constant)
                    and node.args[1].value == "content"
                ):
                    violations.append(f"indirect content assignment at {location}:{node.lineno}")

            targets: list[ast.expr] = []
            if isinstance(node, ast.Assign):
                targets.extend(node.targets)
            elif isinstance(node, (ast.AnnAssign, ast.AugAssign, ast.NamedExpr)):
                targets.append(node.target)
            for target in targets:
                if isinstance(target, ast.Attribute) and target.attr == "content":
                    violations.append(f"direct content assignment at {location}:{target.lineno}")

    assert violations == []
