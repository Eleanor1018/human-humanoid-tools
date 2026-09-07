"""Read-only discovery of registerable assets below configured roots."""

from __future__ import annotations

import os
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from hhtools.contracts import (
    ApiError,
    AssetCategory,
    AssetKind,
    AssetRegistrationRequest,
    AvailableAssetCatalogEntry,
    AvailableAssetCatalogRequest,
    AvailableAssetCatalogResponse,
    ErrorStage,
)

from .assets import AssetServiceError


class _RegistrationHints(Protocol):
    @property
    def allowed_root_ids(self) -> tuple[str, ...]: ...

    def registration_hint(
        self,
        trusted_path: Path,
        *,
        kind: AssetKind | None = None,
        category: AssetCategory | None = None,
        recursive: bool = True,
    ) -> AssetRegistrationRequest: ...


@dataclass(frozen=True, slots=True)
class AvailableAssetCandidate:
    """Trusted in-process candidate; its path never crosses a transport boundary."""

    path: Path
    display_name: str
    kind: AssetKind
    category: AssetCategory
    recursive: bool = True
    dataset: str | None = None
    reference: str | None = None


AvailableAssetProvider = Callable[[], Iterable[AvailableAssetCandidate]]
MAX_AVAILABLE_ASSET_SCAN_ENTRIES = 20_000
MAX_AVAILABLE_ASSET_CANDIDATES = 10_000


class AvailableAssetCatalogLimitError(RuntimeError):
    """A trusted catalog provider exceeded its fixed discovery budget."""


def require_bounded_catalog_root(
    root: Path,
    *,
    max_entries: int = MAX_AVAILABLE_ASSET_SCAN_ENTRIES,
) -> None:
    """Reject a tree before existing discovery helpers can scan it without bounds."""

    visited = 0
    pending = [Path(root)]
    while pending:
        directory = pending.pop()
        try:
            with os.scandir(directory) as children:
                for child in children:
                    if child.name.startswith(".") or child.name == "__pycache__":
                        continue
                    visited += 1
                    if visited > max_entries:
                        raise AvailableAssetCatalogLimitError
                    if child.is_dir(follow_symlinks=False):
                        pending.append(Path(child.path))
        except AvailableAssetCatalogLimitError:
            raise
        except OSError:
            raise


def _catalog_error(
    code: str,
    message: str,
    *,
    retryable: bool = False,
    details: dict[str, object] | None = None,
) -> AssetServiceError:
    return AssetServiceError(
        ApiError(
            code=code,
            message=message,
            retryable=retryable,
            stage=ErrorStage.ASSET_REGISTRATION,
            details=details or {},
        )
    )


class AvailableAssetCatalogService:
    """List trusted candidates only after proving a portable registration identity."""

    def __init__(
        self,
        registration_hints: _RegistrationHints,
        providers: Mapping[str, AvailableAssetProvider],
    ) -> None:
        self._registration_hints = registration_hints
        self._providers = dict(providers)

    def list_available(
        self,
        request: AvailableAssetCatalogRequest,
    ) -> AvailableAssetCatalogResponse:
        """Return a deterministic page without hashing, parsing, or registering assets."""

        allowed = set(self._registration_hints.allowed_root_ids)
        if request.root_id is not None and request.root_id not in allowed:
            raise _catalog_error(
                "ASSET_OUTSIDE_ALLOWED_ROOT",
                "The requested asset root is not allowed.",
                details={"root_id": request.root_id},
            )

        root_ids = [request.root_id] if request.root_id is not None else sorted(allowed)
        entries: dict[tuple[str, str, str], AvailableAssetCatalogEntry] = {}
        for root_id in root_ids:
            provider = self._providers.get(root_id)
            if provider is None:
                raise _catalog_error(
                    "AVAILABLE_ASSET_CATALOG_UNAVAILABLE",
                    "The allowed asset root has no catalog provider.",
                    retryable=True,
                    details={"root_id": root_id},
                )
            try:
                for candidate_index, candidate in enumerate(provider(), start=1):
                    if candidate_index > MAX_AVAILABLE_ASSET_CANDIDATES:
                        raise AvailableAssetCatalogLimitError
                    if request.kind is not None and candidate.kind is not request.kind:
                        continue
                    hint = self._registration_hints.registration_hint(
                        candidate.path,
                        kind=candidate.kind,
                        category=candidate.category,
                        recursive=candidate.recursive,
                    )
                    # Overlapping configured roots use the registry's most-specific
                    # identity. Do not advertise the same path under a broader root.
                    if hint.root_id != root_id:
                        continue
                    entry = AvailableAssetCatalogEntry(
                        root_id=hint.root_id,
                        relative_path=hint.relative_path,
                        display_name=candidate.display_name,
                        kind=candidate.kind,
                        category=candidate.category,
                        recursive=candidate.recursive,
                        dataset=candidate.dataset,
                        reference=candidate.reference,
                    )
                    key = (entry.root_id, entry.relative_path, entry.kind.value)
                    entries[key] = entry
            except AssetServiceError:
                raise
            except AvailableAssetCatalogLimitError as error:
                raise _catalog_error(
                    "AVAILABLE_ASSET_CATALOG_LIMIT_EXCEEDED",
                    "The allowed asset root exceeds the catalog discovery limit.",
                    details={
                        "root_id": root_id,
                        "max_scan_entries": MAX_AVAILABLE_ASSET_SCAN_ENTRIES,
                        "max_candidates": MAX_AVAILABLE_ASSET_CANDIDATES,
                    },
                ) from error
            except (OSError, RuntimeError, TypeError, ValueError) as error:
                raise _catalog_error(
                    "AVAILABLE_ASSET_CATALOG_UNAVAILABLE",
                    "The available asset catalog could not scan an allowed root.",
                    retryable=True,
                    details={"root_id": root_id},
                ) from error

        ordered = sorted(
            entries.values(),
            key=lambda item: (
                item.root_id.casefold(),
                item.display_name.casefold(),
                item.relative_path.casefold(),
                item.kind.value,
            ),
        )
        if request.query is not None:
            terms = request.query.casefold().split()
            ordered = [
                item
                for item in ordered
                if all(
                    term
                    in " ".join(
                        value
                        for value in (
                            item.display_name,
                            item.relative_path,
                            item.kind.value,
                            item.category.value,
                            item.dataset or "",
                            item.reference or "",
                        )
                    ).casefold()
                    for term in terms
                )
            ]
        total = len(ordered)
        return AvailableAssetCatalogResponse(
            assets=ordered[request.offset : request.offset + request.limit],
            total=total,
            limit=request.limit,
            offset=request.offset,
        )


__all__ = [
    "AvailableAssetCandidate",
    "AvailableAssetCatalogLimitError",
    "AvailableAssetCatalogService",
    "AvailableAssetProvider",
    "MAX_AVAILABLE_ASSET_CANDIDATES",
    "MAX_AVAILABLE_ASSET_SCAN_ENTRIES",
    "require_bounded_catalog_root",
]
