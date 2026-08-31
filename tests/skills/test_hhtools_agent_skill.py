"""Repository-level contract tests for the HHTools Agent Codex skill."""

from __future__ import annotations

import re
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import cast

import pytest
import yaml
from mcp import Client

from hhtools.mcp.runtime import AgentRuntime
from hhtools.mcp.server import create_mcp_server

REPO_ROOT = Path(__file__).resolve().parents[2]
SKILL_ROOT = REPO_ROOT / ".agents" / "skills" / "hhtools-agent"
SKILL_FILE = SKILL_ROOT / "SKILL.md"
CONTRACTS_FILE = SKILL_ROOT / "references" / "contracts.md"
STOPS_FILE = SKILL_ROOT / "references" / "errors-and-stops.md"
OPENAI_FILE = SKILL_ROOT / "agents" / "openai.yaml"


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


def _frontmatter(document: str) -> dict[str, object]:
    match = re.match(r"^---\n(?P<yaml>.*?)\n---\n", document, flags=re.DOTALL)
    assert match is not None, "SKILL.md must begin with YAML frontmatter"
    loaded = yaml.safe_load(match.group("yaml"))
    assert isinstance(loaded, dict)
    return loaded


def _markdown_links(document: str) -> list[str]:
    return re.findall(r"\[[^\]]+\]\(([^)]+)\)", document)


def _markdown_table(document: str, heading: str) -> dict[str, list[str]]:
    marker = f"## {heading}\n"
    assert marker in document
    section = document.split(marker, 1)[1].split("\n## ", 1)[0]
    rows: dict[str, list[str]] = {}
    for line in section.splitlines():
        if not line.startswith("|"):
            continue
        cells = [cell.strip() for cell in line.strip("|").split("|")]
        if (
            not cells
            or cells[0] in {"ID", "Signal", "MCP operation"}
            or set(cells[0]) <= {"-", ":"}
        ):
            continue
        key = cells[0].replace("`", "")
        rows[key] = cells[1:]
    return rows


def test_skill_has_minimal_repo_scoped_structure_and_trigger_metadata() -> None:
    files = {
        path.relative_to(SKILL_ROOT).as_posix()
        for path in SKILL_ROOT.rglob("*")
        if path.is_file()
    }
    assert files == {
        "SKILL.md",
        "agents/openai.yaml",
        "references/contracts.md",
        "references/errors-and-stops.md",
    }
    assert not (SKILL_ROOT / "scripts").exists()

    metadata = _frontmatter(SKILL_FILE.read_text(encoding="utf-8"))
    assert metadata["name"] == SKILL_ROOT.name == "hhtools-agent"
    description = str(metadata["description"]).casefold()
    for included_scope in ("h2r", "status", "cancellation", "retry", "result"):
        assert included_scope in description
    for excluded_scope in (
        "solver-code edits",
        "r2r",
        "batch",
        "interaction-mesh",
        "remote service setup",
        "real-robot deployment",
    ):
        assert excluded_scope in description

    openai = yaml.safe_load(OPENAI_FILE.read_text(encoding="utf-8"))
    assert set(openai) == {"interface"}
    assert "dependencies" not in openai
    assert "$hhtools-agent" in openai["interface"]["default_prompt"]
    assert "smoke" in openai["interface"]["default_prompt"].casefold()


def test_all_skill_references_resolve_and_contract_map_covers_public_schemas() -> None:
    documents = (SKILL_FILE, CONTRACTS_FILE, STOPS_FILE)
    linked_schema_names: set[str] = set()

    for document_path in documents:
        for target in _markdown_links(document_path.read_text(encoding="utf-8")):
            assert "://" not in target, "Skill documentation should use repository references"
            resolved = (document_path.parent / target).resolve(strict=True)
            assert resolved.is_relative_to(REPO_ROOT.resolve())
            if resolved.parent == (REPO_ROOT / "docs" / "schemas" / "agent" / "v1").resolve():
                linked_schema_names.add(resolved.name)

    public_schema_names = {
        path.name for path in (REPO_ROOT / "docs" / "schemas" / "agent" / "v1").glob("*.json")
    }
    assert linked_schema_names == public_schema_names


@pytest.mark.anyio
async def test_contract_map_names_exactly_the_tools_discovered_from_mcp() -> None:
    @asynccontextmanager
    async def runtime_factory() -> AsyncIterator[AgentRuntime]:
        yield cast(AgentRuntime, object())

    documented_rows = _markdown_table(
        CONTRACTS_FILE.read_text(encoding="utf-8"),
        "Tool and schema routing",
    )
    documented_tools = {
        operation
        for group in documented_rows
        for operation in (item.strip() for item in group.split(" / "))
    }

    async with Client(create_mcp_server(runtime_factory=runtime_factory)) as client:
        discovered_tools = {tool.name for tool in (await client.list_tools()).tools}

    assert documented_tools == discovered_tools


def test_workflow_invariants_preserve_transport_and_execution_boundaries() -> None:
    rules = _markdown_table(SKILL_FILE.read_text(encoding="utf-8"), "Non-negotiable invariants")
    assert set(rules) == {
        "MCP_ONLY",
        "ALLOWLISTED_ASSETS",
        "PREFLIGHT_OWNS_MODE",
        "IDEMPOTENT_START",
        "NEW_FULL_PLAN",
        "JOB_SCOPED_ARTIFACTS",
        "NO_BINARY_CONTEXT",
        "HUMAN_GATES",
        "COOPERATIVE_CANCEL",
        "HONEST_PROVENANCE",
        "SINGLE_RUNTIME_OWNER",
        "LOCAL_BOUNDARY",
    }
    normalized = {key: " ".join(value).casefold() for key, value in rules.items()}
    assert all(term in normalized["MCP_ONLY"] for term in ("mcp", "shell", "rest"))
    assert all(
        term in normalized["ALLOWLISTED_ASSETS"]
        for term in ("root_id", "relative_path", "absolute path")
    )
    assert all(
        term in normalized["PREFLIGHT_OWNS_MODE"]
        for term in ("run_mode", "preflight", "plan_id", "idempotency_key")
    )
    assert "same plan and idempotency key" in normalized["IDEMPOTENT_START"]
    assert all(
        term in normalized["NEW_FULL_PLAN"]
        for term in ("explicit approval", "new full preflight", "new plan", "new idempotency key")
    )
    assert all(
        term in normalized["JOB_SCOPED_ARTIFACTS"] for term in ("job_id", "artifact_id")
    )
    assert all(term in normalized["NO_BINARY_CONTEXT"] for term in ("binary", "base64"))
    assert all(
        term in normalized["SINGLE_RUNTIME_OWNER"]
        for term in (
            "one local runtime",
            "save_dir",
            "disconnect stdio mcp",
            "close webui",
            "reconnecting mcp",
            "preflight again",
        )
    )
    assert all(
        term in normalized["LOCAL_BOUNDARY"]
        for term in ("local stdio", "no remote auth", "multi-user", "worker resume")
    )


def test_stop_matrix_blocks_unsafe_continuation_and_duplicate_work() -> None:
    rows = _markdown_table(STOPS_FILE.read_text(encoding="utf-8"), "Stop and recovery matrix")

    human_required = " ".join(rows["human_action_required"]).casefold()
    assert all(
        term in human_required
        for term in (
            "pause",
            "required_actions",
            "disconnect the stdio mcp",
            "same `save_dir`",
            "close webui",
            "reconnect mcp",
            "new preflight",
        )
    )
    assert "do not call `start_retarget`" in human_required
    assert "run mcp and web against the same directory" in human_required
    assert "request a webui session token" in human_required

    rejected = " ".join(rows["rejected"]).casefold()
    assert "stop" in rejected and "do not start a job" in rejected

    stale = " ".join(rows["PLAN_STALE"]).casefold()
    assert all(term in stale for term in ("new preflight", "new plan", "new start key"))
    assert "do not reuse the old plan" in stale

    ambiguous = " ".join(rows["transport ambiguity"]).casefold()
    assert all(term in ambiguous for term in ("same `plan_id`", "idempotency key"))
    assert all(term in ambiguous for term in ("do not call `retry_job`", "new key"))

    interrupted = " ".join(rows["JOB_INTERRUPTED"]).casefold()
    assert all(
        term in interrupted
        for term in ("explicit user approval", "`retry_job`", "whole-plan child attempt")
    )
    assert "retry automatically" in interrupted

    mismatch = " ".join(rows["ARTIFACT_HASH_MISMATCH"]).casefold()
    assert "stop artifact delivery" in mismatch
    assert "do not present the artifact as valid" in mismatch

    review = " ".join(rows["review_required"]).casefold()
    assert all(term in review for term in ("evaluation", "manifest", "explicit quality approval"))
    assert "do not preflight or start a full run" in review

    unavailable = " ".join(rows["MCP unavailable"]).casefold()
    assert "stop" in unavailable
    assert all(term in unavailable for term in ("shell", "json cli", "rest"))
