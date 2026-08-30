"""Application service for registering and inspecting Agent motion assets.

``AssetRegistry`` owns filesystem authorization, immutable manifests, and
persistence. ``MotionAssetInspector`` owns format discovery and read-only
content checks. This module composes those two boundaries so transport adapters
do not need to exchange host paths or reimplement bundle assembly.
"""

from __future__ import annotations

from pathlib import PurePosixPath, PureWindowsPath

from hhtools.contracts import (
    ApiError,
    AssetBundle,
    AssetCategory,
    AssetDetected,
    AssetFileRole,
    AssetInspection,
    AssetInspectionRequest,
    AssetKind,
    AssetRegistrationRequest,
    AssetSearchResponse,
    ErrorStage,
)

from .asset_inspection import (
    MotionAssetDiscoveryError,
    MotionAssetInspector,
    discover_primary,
)
from .assets import (
    AssetRegistry,
    AssetServiceError,
    DiscoveredAsset,
    DiscoveredAssetFile,
)


def _safe_discovery_candidates(values: tuple[str, ...]) -> list[str]:
    """Keep only normalized relative candidate names in public error details."""

    safe: list[str] = []
    for value in values:
        if not value or "\\" in value:
            continue
        posix = PurePosixPath(value)
        windows = PureWindowsPath(value)
        if (
            posix.is_absolute()
            or windows.is_absolute()
            or bool(windows.drive)
            or any(part in {"", ".", ".."} for part in posix.parts)
        ):
            continue
        safe.append(posix.as_posix())
    return safe


def _discovery_error(error: MotionAssetDiscoveryError) -> AssetServiceError:
    """Translate an inspector discovery failure to the shared service error."""

    details: dict[str, object] = {}
    candidates = _safe_discovery_candidates(error.candidates)
    if candidates:
        details["candidates"] = candidates
    return AssetServiceError(
        ApiError(
            code=error.code,
            message=str(error),
            retryable=False,
            stage=ErrorStage.ASSET_REGISTRATION,
            details=details,
        )
    )


class AgentAssetService:
    """Transport-neutral facade for the Agent asset lifecycle."""

    def __init__(
        self,
        registry: AssetRegistry,
        inspector: MotionAssetInspector | None = None,
    ) -> None:
        self._registry = registry
        self._inspector = inspector or MotionAssetInspector()

    @property
    def allowed_root_ids(self) -> tuple[str, ...]:
        """Return configured root identifiers without revealing their paths."""

        return self._registry.allowed_root_ids

    def register(self, request: AssetRegistrationRequest) -> AssetBundle:
        """Discover and persist one motion bundle below an allowlisted root."""

        candidate = self._registry.resolve_registration_path(request)
        try:
            discovered = discover_primary(candidate)
        except MotionAssetDiscoveryError as error:
            raise _discovery_error(error) from error

        files = [
            DiscoveredAssetFile(
                path=discovered.primary_path,
                role=AssetFileRole.MOTION,
                required=True,
            )
        ]
        for role, paths in sorted(
            discovered.sidecars.items(),
            key=lambda item: item[0].value,
        ):
            files.extend(
                DiscoveredAssetFile(path=path, role=role, required=True)
                for path in paths
                if path != discovered.primary_path
            )

        discovery = DiscoveredAsset(
            primary_file=discovered.primary_path,
            files=tuple(files),
            kind=AssetKind.MOTION_BUNDLE,
            category=discovered.category,
            detected=AssetDetected(
                dataset=discovered.dataset,
                reference=discovered.reference,
                recommended_backend=discovered.recommended_backend,
            ),
        )
        return self._registry.register(request, discovery=discovery)

    def get(self, asset_id: str) -> AssetBundle:
        """Return one registered, portable asset manifest."""

        return self._registry.get(asset_id)

    def search(
        self,
        *,
        query: str | None = None,
        kind: AssetKind | str | None = None,
        category: AssetCategory | str | None = None,
        dataset: str | None = None,
        reference: str | None = None,
        limit: int = 100,
        offset: int = 0,
    ) -> AssetSearchResponse:
        """Search registered manifests using the registry's bounded filters."""

        return self._registry.search(
            query=query,
            kind=kind,
            category=category,
            dataset=dataset,
            reference=reference,
            limit=limit,
            offset=offset,
        )

    def inspect(self, request: AssetInspectionRequest) -> AssetInspection:
        """Inspect a registered bundle after re-resolving its trusted base path."""

        bundle = self._registry.get(request.asset_id)
        primary = self._registry.resolve_file(
            bundle.asset_id,
            bundle.primary_file,
            verify_hash=False,
        )

        # The registry returns the resolved primary file, while the inspector
        # consumes the bundle base. Walk one parent per portable manifest path
        # component so nested primaries remain relative to the registered root.
        bundle_root = primary
        for _ in PurePosixPath(bundle.primary_file).parts:
            bundle_root = bundle_root.parent

        return self._inspector.inspect(
            bundle,
            bundle_root,
            verify_hashes=request.verify_hashes,
            parse_content=request.parse_content,
        )


__all__ = ["AgentAssetService"]
