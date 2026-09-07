from __future__ import annotations

import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from hhtools.contracts import (
    AssetInspectionRequest,
    AssetRegistrationRequest,
    AvailableAssetCatalogRequest,
)
from hhtools.contracts.portability import validate_portable_json
from hhtools.services import (
    AgentAssetService,
    AssetRegistry,
    AssetServiceError,
    AvailableAssetCandidate,
    AvailableAssetCatalogLimitError,
    AvailableAssetCatalogService,
    require_bounded_catalog_root,
)


def _catalog(
    tmp_path: Path,
    candidates: list[AvailableAssetCandidate],
) -> tuple[AgentAssetService, AvailableAssetCatalogService]:
    root = tmp_path / "motions"
    root.mkdir(exist_ok=True)
    registry = AssetRegistry(tmp_path / "agent-state", {"source": root})
    assets = AgentAssetService(registry)
    return assets, AvailableAssetCatalogService(
        registry,
        {"source": lambda: list(candidates)},
    )


def test_catalog_returns_portable_registration_metadata_and_exact_page(tmp_path: Path) -> None:
    root = tmp_path / "motions"
    root.mkdir()
    walk = root / "walk.bvh"
    run = root / "run.bvh"
    walk.write_text("HIERARCHY\n", encoding="utf-8")
    run.write_text("HIERARCHY\n", encoding="utf-8")
    candidates = [
        AvailableAssetCandidate(
            path=walk,
            display_name="Walk",
            kind="motion_bundle",
            category="plain_motion",
            dataset="lafan",
            reference="lafan_bvh",
        ),
        AvailableAssetCandidate(
            path=run,
            display_name="Run",
            kind="motion_bundle",
            category="plain_motion",
            dataset="lafan",
            reference="lafan_bvh",
        ),
    ]
    assets, catalog = _catalog(tmp_path, candidates)

    page = catalog.list_available(
        AvailableAssetCatalogRequest(query="lafan", limit=1, offset=1)
    )

    assert page.total == 2
    assert page.limit == 1
    assert page.offset == 1
    assert len(page.assets) == 1
    entry = page.assets[0]
    assert entry.display_name == "Walk"
    assert entry.root_id == "source"
    assert entry.relative_path == "walk.bvh"
    assert entry.kind.value == "motion_bundle"
    assert entry.category.value == "plain_motion"
    document = page.model_dump(mode="json", exclude_none=True)
    validate_portable_json(document)
    assert str(tmp_path) not in json.dumps(document)

    bundle = assets.register(
        AssetRegistrationRequest(
            root_id=entry.root_id,
            relative_path=entry.relative_path,
            display_name=entry.display_name,
            kind=entry.kind,
            category=entry.category,
            recursive=entry.recursive,
        )
    )
    inspection = assets.inspect(
        AssetInspectionRequest(
            asset_id=bundle.asset_id,
            verify_hashes=True,
            parse_content=False,
        )
    )
    assert inspection.asset_id == bundle.asset_id
    assert inspection.kind.value == "motion_bundle"


def test_catalog_rejects_unknown_root_and_contract_bounds(tmp_path: Path) -> None:
    _assets, catalog = _catalog(tmp_path, [])

    with pytest.raises(AssetServiceError) as raised:
        catalog.list_available(AvailableAssetCatalogRequest(root_id="unknown"))

    assert raised.value.api_error.code == "ASSET_OUTSIDE_ALLOWED_ROOT"
    assert raised.value.api_error.details == {"root_id": "unknown"}
    with pytest.raises(ValidationError):
        AvailableAssetCatalogRequest(limit=501)
    with pytest.raises(ValidationError):
        AvailableAssetCatalogRequest(offset=-1)
    with pytest.raises(ValidationError):
        AvailableAssetCatalogRequest(typo=True)


def test_catalog_fails_closed_for_symlink_escape_without_leaking_path(tmp_path: Path) -> None:
    root = tmp_path / "motions"
    outside = tmp_path / "private" / "secret.bvh"
    root.mkdir()
    outside.parent.mkdir()
    outside.write_text("private", encoding="utf-8")
    escaped = root / "escape.bvh"
    escaped.symlink_to(outside)
    _assets, catalog = _catalog(
        tmp_path,
        [
            AvailableAssetCandidate(
                path=escaped,
                display_name="Escaped",
                kind="motion_bundle",
                category="plain_motion",
            )
        ],
    )

    with pytest.raises(AssetServiceError) as raised:
        catalog.list_available(AvailableAssetCatalogRequest(root_id="source"))

    document = raised.value.api_error.model_dump(mode="json")
    assert raised.value.api_error.code == "ASSET_OUTSIDE_ALLOWED_ROOT"
    assert str(tmp_path) not in json.dumps(document)


def test_catalog_has_hard_tree_and_candidate_budgets(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    root = tmp_path / "motions"
    root.mkdir()
    for name in ("one", "two", "three"):
        (root / name).write_text(name, encoding="utf-8")

    with pytest.raises(AvailableAssetCatalogLimitError):
        require_bounded_catalog_root(root, max_entries=2)

    candidates = [
        AvailableAssetCandidate(
            path=root / name,
            display_name=name,
            kind="motion_bundle",
            category="plain_motion",
        )
        for name in ("one", "two", "three")
    ]
    _assets, catalog = _catalog(tmp_path, candidates)
    monkeypatch.setattr("hhtools.services.available_assets.MAX_AVAILABLE_ASSET_CANDIDATES", 2)
    with pytest.raises(AssetServiceError) as raised:
        catalog.list_available(AvailableAssetCatalogRequest())

    assert raised.value.api_error.code == "AVAILABLE_ASSET_CATALOG_LIMIT_EXCEEDED"
    assert raised.value.api_error.details["max_candidates"] == 2
