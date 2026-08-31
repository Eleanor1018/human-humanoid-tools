"""Read-only discovery and inspection for robot URDF bundles.

This module intentionally stops at the asset boundary.  It parses XML with the
standard library, validates referenced files, and reports compact structural
facts.  It never constructs a robot model, invokes a solver, or imports MuJoCo,
Newton, Warp, or ``yourdfpy``.

Public contracts contain only bundle-relative paths.  Absolute paths returned
by discovery are an internal hand-off to :class:`AssetRegistry`; expected
errors never include those host paths.
"""

from __future__ import annotations

import hashlib
import math
import os
from collections import Counter, defaultdict
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from pathlib import Path, PurePosixPath, PureWindowsPath
from typing import Any
from urllib.parse import unquote, urlsplit
from urllib.request import url2pathname
from xml.etree import ElementTree

from hhtools.contracts import (
    ApiError,
    AssetBundle,
    AssetCategory,
    AssetFileRole,
    AssetInspection,
    AssetKind,
    ErrorStage,
    InspectionStatus,
)

_MAX_URDF_BYTES = 16 * 1024 * 1024
_SUPPORTED_JOINT_TYPES = frozenset(
    {"fixed", "revolute", "continuous", "prismatic", "floating", "planar"}
)
_BOUNDED_JOINT_TYPES = frozenset({"revolute", "prismatic"})
_ACTUATED_JOINT_TYPES = frozenset({"revolute", "continuous", "prismatic"})
_MESH_ROLES = frozenset({AssetFileRole.VISUAL_MESH, AssetFileRole.COLLISION_MESH})


@dataclass(frozen=True, slots=True)
class RobotAssetFile:
    """One file discovered as part of a logical robot bundle."""

    path: Path
    role: AssetFileRole
    required: bool = True


@dataclass(frozen=True, slots=True)
class RobotAssetDiscovery:
    """Internal paths and portable metadata for one unambiguous URDF bundle."""

    primary_urdf: Path
    files: tuple[RobotAssetFile, ...]
    metadata: Mapping[str, Any]

    @property
    def primary_file(self) -> Path:
        """Compatibility spelling used by registry discovery adapters."""

        return self.primary_urdf


class RobotAssetDiscoveryError(ValueError):
    """Expected discovery failure carrying an Agent-safe structured error."""

    def __init__(self, error: ApiError, *, candidates: tuple[str, ...] = ()) -> None:
        self.api_error = error
        self.candidates = candidates
        super().__init__(f"{error.code}: {error.message}")

    @property
    def code(self) -> str:
        """Stable machine code for protocol adapters and focused tests."""

        return self.api_error.code


@dataclass(frozen=True, slots=True)
class _MeshDeclaration:
    role: AssetFileRole
    reference: str
    index: int


@dataclass(slots=True)
class _UrdfFacts:
    robot_name: str | None
    link_count: int
    urdf_joint_count: int
    joint_count: int
    fixed_joint_count: int
    joint_type_counts: dict[str, int]
    visual_mesh_declaration_count: int
    collision_mesh_declaration_count: int
    mesh_declarations: tuple[_MeshDeclaration, ...]
    errors: list[ApiError]
    warnings: list[str]


def _api_error(
    code: str,
    message: str,
    *,
    details: Mapping[str, Any] | None = None,
) -> ApiError:
    return ApiError(
        code=code,
        message=message,
        retryable=False,
        stage=ErrorStage.ASSET_INSPECTION,
        details=dict(details or {}),
    )


def _raise_discovery(
    code: str,
    message: str,
    *,
    details: Mapping[str, Any] | None = None,
    candidates: tuple[str, ...] = (),
) -> None:
    raise RobotAssetDiscoveryError(
        _api_error(code, message, details=details),
        candidates=candidates,
    )


def _local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _safe_relative(path: Path, root: Path) -> str:
    """Return a portable path after containment was already established."""

    return path.relative_to(root).as_posix()


def _contains(root: Path, path: Path, *, strict: bool) -> Path:
    try:
        resolved = path.resolve(strict=strict)
        resolved.relative_to(root)
    except (OSError, RuntimeError, ValueError) as exc:
        raise RobotAssetDiscoveryError(
            _api_error(
                "ASSET_OUTSIDE_ALLOWED_ROOT",
                "A robot bundle reference resolves outside the registered bundle.",
            )
        ) from exc
    return resolved


def _read_urdf(path: Path) -> ElementTree.Element:
    """Parse a bounded XML document without resolving external resources."""

    try:
        size = path.stat().st_size
        if size > _MAX_URDF_BYTES:
            _raise_discovery(
                "ROBOT_URDF_PARSE_FAILED",
                "The robot description exceeds the supported inspection size.",
                details={"max_bytes": _MAX_URDF_BYTES},
            )
        payload = path.read_bytes()
    except RobotAssetDiscoveryError:
        raise
    except OSError as exc:
        raise RobotAssetDiscoveryError(
            _api_error("ASSET_NOT_FOUND", "The robot description is unavailable.")
        ) from exc

    upper_payload = payload.upper()
    if b"<!DOCTYPE" in upper_payload or b"<!ENTITY" in upper_payload:
        _raise_discovery(
            "ROBOT_URDF_PARSE_FAILED",
            "DTD and entity declarations are not allowed in robot descriptions.",
        )
    try:
        return ElementTree.fromstring(payload)
    except (ElementTree.ParseError, UnicodeError, ValueError) as exc:
        raise RobotAssetDiscoveryError(
            _api_error(
                "ROBOT_URDF_PARSE_FAILED",
                "The robot description contains malformed XML.",
                details={"exception_type": type(exc).__name__},
            )
        ) from exc


def _children(element: ElementTree.Element, name: str) -> list[ElementTree.Element]:
    return [child for child in element if _local_name(child.tag) == name]


def _descendants(element: ElementTree.Element, name: str) -> Iterable[ElementTree.Element]:
    return (child for child in element.iter() if _local_name(child.tag) == name)


def _mesh_declarations(root: ElementTree.Element) -> tuple[_MeshDeclaration, ...]:
    declarations: list[_MeshDeclaration] = []
    index = 0
    for link in _children(root, "link"):
        for container_name, role in (
            ("visual", AssetFileRole.VISUAL_MESH),
            ("collision", AssetFileRole.COLLISION_MESH),
        ):
            for container in _children(link, container_name):
                for mesh in _descendants(container, "mesh"):
                    declarations.append(
                        _MeshDeclaration(
                            role=role,
                            reference=(mesh.get("filename") or "").strip(),
                            index=index,
                        )
                    )
                    index += 1
    return tuple(declarations)


def _float_attribute(
    element: ElementTree.Element,
    name: str,
    *,
    joint_name: str,
    required: bool,
    errors: list[ApiError],
) -> float | None:
    raw = element.get(name)
    if raw is None:
        if required:
            errors.append(
                _api_error(
                    "ROBOT_URDF_INVALID",
                    "A bounded joint is missing a required numeric limit.",
                    details={"joint": joint_name, "attribute": name},
                )
            )
        return None
    try:
        value = float(raw)
    except ValueError:
        value = math.nan
    if not math.isfinite(value):
        errors.append(
            _api_error(
                "ROBOT_URDF_INVALID",
                "A joint limit is not a finite number.",
                details={"joint": joint_name, "attribute": name},
            )
        )
        return None
    return value


def _duplicates(values: Iterable[str]) -> list[str]:
    counts = Counter(values)
    return sorted(name for name, count in counts.items() if name and count > 1)[:20]


def _validate_topology(
    links: set[str],
    edges: list[tuple[str, str]],
    *,
    errors: list[ApiError],
) -> None:
    valid_edges = [(parent, child) for parent, child in edges if parent in links and child in links]
    children = [child for _, child in valid_edges]
    duplicate_children = _duplicates(children)
    if duplicate_children:
        errors.append(
            _api_error(
                "ROBOT_URDF_INVALID",
                "A robot link has more than one parent joint.",
                details={"links": duplicate_children},
            )
        )

    roots = sorted(links - set(children))
    if links and len(roots) != 1:
        errors.append(
            _api_error(
                "ROBOT_URDF_INVALID",
                "A robot description must define exactly one root link.",
                details={"root_count": len(roots)},
            )
        )

    adjacency: dict[str, list[str]] = defaultdict(list)
    indegree = {name: 0 for name in links}
    for parent, child in valid_edges:
        adjacency[parent].append(child)
        indegree[child] += 1
    queue = [name for name, degree in indegree.items() if degree == 0]
    visited = 0
    while queue:
        current = queue.pop()
        visited += 1
        for child in adjacency[current]:
            indegree[child] -= 1
            if indegree[child] == 0:
                queue.append(child)
    if links and visited != len(links):
        errors.append(
            _api_error(
                "ROBOT_URDF_INVALID",
                "The robot link graph contains a cycle.",
            )
        )


def _analyse_urdf(root: ElementTree.Element) -> _UrdfFacts:
    errors: list[ApiError] = []
    warnings: list[str] = []
    if _local_name(root.tag) != "robot":
        errors.append(
            _api_error(
                "ROBOT_URDF_INVALID",
                "The XML root element must be robot.",
            )
        )

    robot_name = (root.get("name") or "").strip() or None
    if robot_name is None:
        warnings.append("The robot description does not declare a robot name.")

    link_elements = _children(root, "link")
    link_names = [(element.get("name") or "").strip() for element in link_elements]
    missing_link_names = sum(not name for name in link_names)
    duplicate_links = _duplicates(link_names)
    if not link_elements:
        errors.append(_api_error("ROBOT_URDF_INVALID", "The robot defines no links."))
    if missing_link_names:
        errors.append(
            _api_error(
                "ROBOT_URDF_INVALID",
                "Every robot link must have a name.",
                details={"missing_name_count": missing_link_names},
            )
        )
    if duplicate_links:
        errors.append(
            _api_error(
                "ROBOT_URDF_INVALID",
                "Robot link names must be unique.",
                details={"duplicate_names": duplicate_links},
            )
        )
    links = {name for name in link_names if name}

    joint_elements = _children(root, "joint")
    joint_names = [(element.get("name") or "").strip() for element in joint_elements]
    missing_joint_names = sum(not name for name in joint_names)
    duplicate_joints = _duplicates(joint_names)
    if missing_joint_names:
        errors.append(
            _api_error(
                "ROBOT_URDF_INVALID",
                "Every robot joint must have a name.",
                details={"missing_name_count": missing_joint_names},
            )
        )
    if duplicate_joints:
        errors.append(
            _api_error(
                "ROBOT_URDF_INVALID",
                "Robot joint names must be unique.",
                details={"duplicate_names": duplicate_joints},
            )
        )

    joint_types: Counter[str] = Counter()
    edges: list[tuple[str, str]] = []
    effort_velocity_missing = 0
    for index, joint in enumerate(joint_elements):
        name = (joint.get("name") or "").strip() or f"joint_{index}"
        joint_type = (joint.get("type") or "").strip().lower()
        joint_types[joint_type or "(missing)"] += 1
        if joint_type not in _SUPPORTED_JOINT_TYPES:
            errors.append(
                _api_error(
                    "ROBOT_URDF_INVALID",
                    "A robot joint has an unsupported or missing type.",
                    details={"joint": name, "joint_type": joint_type or None},
                )
            )

        parent_elements = _children(joint, "parent")
        child_elements = _children(joint, "child")
        parent = (
            (parent_elements[0].get("link") or "").strip()
            if len(parent_elements) == 1
            else ""
        )
        child = (
            (child_elements[0].get("link") or "").strip()
            if len(child_elements) == 1
            else ""
        )
        if not parent or not child:
            errors.append(
                _api_error(
                    "ROBOT_URDF_INVALID",
                    "Every joint must declare exactly one parent and one child link.",
                    details={"joint": name},
                )
            )
        else:
            edges.append((parent, child))
            missing_references = sorted({value for value in (parent, child) if value not in links})
            if missing_references:
                errors.append(
                    _api_error(
                        "ROBOT_URDF_INVALID",
                        "A joint refers to a link that is not declared.",
                        details={"joint": name, "links": missing_references},
                    )
                )
            if parent == child:
                errors.append(
                    _api_error(
                        "ROBOT_URDF_INVALID",
                        "A joint cannot connect a link to itself.",
                        details={"joint": name},
                    )
                )

        limit_elements = _children(joint, "limit")
        if joint_type in _BOUNDED_JOINT_TYPES:
            if len(limit_elements) != 1:
                errors.append(
                    _api_error(
                        "ROBOT_URDF_INVALID",
                        "A bounded joint must declare exactly one limit element.",
                        details={"joint": name},
                    )
                )
            else:
                limit = limit_elements[0]
                lower = _float_attribute(
                    limit,
                    "lower",
                    joint_name=name,
                    required=True,
                    errors=errors,
                )
                upper = _float_attribute(
                    limit,
                    "upper",
                    joint_name=name,
                    required=True,
                    errors=errors,
                )
                if lower is not None and upper is not None and lower > upper:
                    errors.append(
                        _api_error(
                            "ROBOT_URDF_INVALID",
                            "A joint lower limit exceeds its upper limit.",
                            details={"joint": name},
                        )
                    )
                if limit.get("effort") is None or limit.get("velocity") is None:
                    effort_velocity_missing += 1
        elif joint_type == "continuous" and (
            not limit_elements
            or any(
                limit.get("effort") is None or limit.get("velocity") is None
                for limit in limit_elements
            )
        ):
            effort_velocity_missing += 1

    if effort_velocity_missing:
        warnings.append(
            f"{effort_velocity_missing} actuated joint(s) omit effort or velocity limits."
        )
    _validate_topology(links, edges, errors=errors)

    declarations = _mesh_declarations(root)
    empty_mesh_references = sum(not declaration.reference for declaration in declarations)
    if empty_mesh_references:
        errors.append(
            _api_error(
                "ROBOT_URDF_INVALID",
                "Every mesh declaration must include a filename.",
                details={"missing_filename_count": empty_mesh_references},
            )
        )
    return _UrdfFacts(
        robot_name=robot_name,
        link_count=len(link_elements),
        urdf_joint_count=len(joint_elements),
        joint_count=sum(
            joint_type in _ACTUATED_JOINT_TYPES for joint_type in joint_types.elements()
        ),
        fixed_joint_count=joint_types.get("fixed", 0),
        joint_type_counts=dict(sorted(joint_types.items())),
        visual_mesh_declaration_count=sum(
            declaration.role is AssetFileRole.VISUAL_MESH for declaration in declarations
        ),
        collision_mesh_declaration_count=sum(
            declaration.role is AssetFileRole.COLLISION_MESH for declaration in declarations
        ),
        mesh_declarations=declarations,
        errors=errors,
        warnings=warnings,
    )


def _reference_candidate(reference: str, *, urdf_path: Path, bundle_root: Path) -> Path:
    """Convert a URDF mesh reference to an internal candidate path."""

    raw = reference.strip()
    if not raw or "\x00" in raw:
        _raise_discovery(
            "BUNDLE_INCOMPLETE",
            "A robot mesh reference is empty or invalid.",
        )

    parsed = urlsplit(raw)
    scheme = parsed.scheme.casefold()
    if scheme == "package":
        if parsed.query or parsed.fragment or not parsed.netloc:
            _raise_discovery(
                "BUNDLE_INCOMPLETE",
                "A package mesh reference is malformed.",
            )
        package = unquote(parsed.netloc)
        package_path = unquote(parsed.path).replace("\\", "/").lstrip("/")
        parts = PurePosixPath(package_path).parts
        if package in {".", ".."} or "/" in package or not parts:
            _raise_discovery(
                "BUNDLE_INCOMPLETE",
                "A package mesh reference is malformed.",
            )
        return bundle_root.joinpath(*parts)

    if scheme == "file":
        if parsed.query or parsed.fragment or parsed.netloc not in {"", "localhost"}:
            _raise_discovery(
                "ASSET_OUTSIDE_ALLOWED_ROOT",
                "A file URI is outside the registered robot bundle.",
            )
        return Path(url2pathname(unquote(parsed.path)))

    # A Windows drive such as C:\\robot\\mesh.stl is parsed as a one-letter
    # URI scheme.  Treat it as a filesystem path, not an unknown URI.
    windows_path = PureWindowsPath(raw)
    if scheme and not windows_path.drive:
        _raise_discovery(
            "BUNDLE_INCOMPLETE",
            "The robot description uses an unsupported mesh URI scheme.",
        )
    if windows_path.is_absolute() or windows_path.drive:
        return Path(raw)
    if PurePosixPath(raw).is_absolute():
        return Path(raw)
    normalized = unquote(raw).replace("\\", "/")
    return urdf_path.parent.joinpath(*PurePosixPath(normalized).parts)


def _resolve_mesh(
    declaration: _MeshDeclaration,
    *,
    urdf_path: Path,
    bundle_root: Path,
) -> Path:
    candidate = _reference_candidate(
        declaration.reference,
        urdf_path=urdf_path,
        bundle_root=bundle_root,
    )
    try:
        resolved = candidate.resolve(strict=False)
        resolved.relative_to(bundle_root)
    except (OSError, RuntimeError, ValueError) as exc:
        raise RobotAssetDiscoveryError(
            _api_error(
                "ASSET_OUTSIDE_ALLOWED_ROOT",
                "A robot mesh reference resolves outside the registered bundle.",
                details={"role": declaration.role.value, "declaration_index": declaration.index},
            )
        ) from exc
    if not resolved.is_file():
        relative = _safe_relative(resolved, bundle_root)
        raise RobotAssetDiscoveryError(
            _api_error(
                "BUNDLE_INCOMPLETE",
                "A referenced robot mesh is missing or is not a regular file.",
                details={"relative_path": relative, "role": declaration.role.value},
            )
        )
    try:
        strict_resolved = candidate.resolve(strict=True)
        strict_resolved.relative_to(bundle_root)
    except (OSError, RuntimeError, ValueError) as exc:
        raise RobotAssetDiscoveryError(
            _api_error(
                "ASSET_OUTSIDE_ALLOWED_ROOT",
                "A robot mesh reference resolves outside the registered bundle.",
                details={"role": declaration.role.value, "declaration_index": declaration.index},
            )
        ) from exc
    return strict_resolved


def _candidate_urdfs(candidate: Path, bundle_root: Path) -> list[Path]:
    candidates: list[Path] = []
    try:
        for current, directory_names, file_names in os.walk(
            bundle_root,
            topdown=True,
            followlinks=False,
        ):
            directory_names.sort(key=str.casefold)
            file_names.sort(key=str.casefold)
            directory = Path(current)
            for name in file_names:
                if Path(name).suffix.casefold() != ".urdf":
                    continue
                path = directory / name
                resolved = _contains(bundle_root, path, strict=True)
                if not resolved.is_file():
                    continue
                candidates.append(resolved)
    except RobotAssetDiscoveryError:
        raise
    except OSError as exc:
        raise RobotAssetDiscoveryError(
            _api_error("ASSET_NOT_FOUND", "The robot bundle cannot be read.")
        ) from exc
    return sorted(set(candidates), key=lambda path: _safe_relative(path, bundle_root).casefold())


def _bundle_context(candidate: str | Path) -> tuple[Path, Path]:
    path = Path(candidate)
    try:
        if path.is_dir():
            bundle_root = path.resolve(strict=True)
            candidates = _candidate_urdfs(path, bundle_root)
            if not candidates:
                _raise_discovery(
                    "BUNDLE_INCOMPLETE",
                    "The robot bundle contains no URDF description.",
                )
            if len(candidates) > 1:
                relative = tuple(_safe_relative(item, bundle_root) for item in candidates)
                _raise_discovery(
                    "BUNDLE_AMBIGUOUS",
                    "The directory contains multiple robot descriptions; register one bundle.",
                    details={"candidates": list(relative)},
                    candidates=relative,
                )
            return bundle_root, candidates[0]
        if path.is_file() or path.is_symlink():
            if path.suffix.casefold() != ".urdf":
                _raise_discovery(
                    "UNSUPPORTED_FORMAT",
                    "Robot bundle discovery requires a URDF file or directory.",
                )
            bundle_root = path.parent.resolve(strict=True)
            primary = _contains(bundle_root, path, strict=True)
            if not primary.is_file():
                _raise_discovery(
                    "ASSET_NOT_FOUND",
                    "The robot description is not a regular file.",
                )
            return bundle_root, primary
    except RobotAssetDiscoveryError:
        raise
    except OSError as exc:
        raise RobotAssetDiscoveryError(
            _api_error("ASSET_NOT_FOUND", "The robot bundle is unavailable.")
        ) from exc
    _raise_discovery("ASSET_NOT_FOUND", "The robot bundle is unavailable.")


def _metadata(facts: _UrdfFacts, *, unique_meshes: int, shared_meshes: int) -> dict[str, Any]:
    return {
        "source_format": "urdf",
        "robot_name": facts.robot_name,
        "link_count": facts.link_count,
        "urdf_joint_count": facts.urdf_joint_count,
        "joint_count": facts.joint_count,
        "fixed_joint_count": facts.fixed_joint_count,
        "joint_type_counts": facts.joint_type_counts,
        "visual_mesh_declaration_count": facts.visual_mesh_declaration_count,
        "collision_mesh_declaration_count": facts.collision_mesh_declaration_count,
        "unique_mesh_count": unique_meshes,
        "shared_visual_collision_mesh_count": shared_meshes,
    }


def discover_robot_bundle(candidate: str | Path) -> RobotAssetDiscovery:
    """Discover one URDF plus every in-bundle file required by that URDF."""

    bundle_root, primary = _bundle_context(candidate)
    xml_root = _read_urdf(primary)
    facts = _analyse_urdf(xml_root)
    if facts.errors:
        first = facts.errors[0]
        raise RobotAssetDiscoveryError(first)

    mesh_roles: dict[Path, set[AssetFileRole]] = defaultdict(set)
    for declaration in facts.mesh_declarations:
        if not declaration.reference:
            continue
        resolved = _resolve_mesh(
            declaration,
            urdf_path=primary,
            bundle_root=bundle_root,
        )
        mesh_roles[resolved].add(declaration.role)

    files: list[RobotAssetFile] = [
        RobotAssetFile(primary, AssetFileRole.ROBOT_DESCRIPTION)
    ]
    metadata_candidates = {bundle_root / "robot.yaml", primary.parent / "robot.yaml"}
    for path in sorted(metadata_candidates, key=lambda item: item.as_posix().casefold()):
        if not path.exists() and not path.is_symlink():
            continue
        resolved = _contains(bundle_root, path, strict=True)
        if not resolved.is_file():
            _raise_discovery(
                "BUNDLE_INCOMPLETE",
                "Robot metadata exists but is not a regular file.",
            )
        files.append(RobotAssetFile(resolved, AssetFileRole.METADATA))

    shared_meshes = 0
    for path, roles in sorted(
        mesh_roles.items(),
        key=lambda item: _safe_relative(item[0], bundle_root).casefold(),
    ):
        if len(roles) > 1:
            shared_meshes += 1
        # AssetFile has one semantic role.  A shared collision/visual mesh is
        # classified as collision because that is the stricter operational use;
        # metadata retains the fact that the file is shared.
        role = (
            AssetFileRole.COLLISION_MESH
            if AssetFileRole.COLLISION_MESH in roles
            else AssetFileRole.VISUAL_MESH
        )
        files.append(RobotAssetFile(path, role))

    deduplicated: dict[Path, RobotAssetFile] = {}
    for item in files:
        previous = deduplicated.get(item.path)
        if previous is None:
            deduplicated[item.path] = item
        elif previous.role is not item.role:
            precedence = {
                AssetFileRole.ROBOT_DESCRIPTION: 4,
                AssetFileRole.METADATA: 3,
                AssetFileRole.COLLISION_MESH: 2,
                AssetFileRole.VISUAL_MESH: 1,
            }
            if precedence.get(item.role, 0) > precedence.get(previous.role, 0):
                deduplicated[item.path] = item
    ordered = tuple(
        sorted(
            deduplicated.values(),
            key=lambda item: (
                0 if item.path == primary else 1,
                _safe_relative(item.path, bundle_root).casefold(),
            ),
        )
    )
    return RobotAssetDiscovery(
        primary_urdf=primary,
        files=ordered,
        metadata=_metadata(
            facts,
            unique_meshes=len(mesh_roles),
            shared_meshes=shared_meshes,
        ),
    )


def _sha256(path: Path) -> tuple[str, int, bool]:
    before = path.stat()
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
            size += len(chunk)
    after = path.stat()
    before_snapshot = (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns)
    after_snapshot = (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns)
    stable = before_snapshot == after_snapshot and size == after.st_size
    return digest.hexdigest(), size, stable


def _inspection_path(
    bundle_root: Path,
    relative_path: str,
) -> tuple[Path | None, ApiError | None]:
    candidate = bundle_root.joinpath(*relative_path.split("/"))
    try:
        resolved = candidate.resolve(strict=False)
        resolved.relative_to(bundle_root)
    except (OSError, RuntimeError, ValueError):
        return None, _api_error(
            "ASSET_OUTSIDE_ALLOWED_ROOT",
            "A robot bundle file resolves outside its registered root.",
            details={"relative_path": relative_path},
        )
    if not resolved.is_file():
        return None, _api_error(
            "BUNDLE_INCOMPLETE",
            "A required robot bundle file is missing.",
            details={"relative_path": relative_path},
        )
    try:
        strict_resolved = candidate.resolve(strict=True)
        strict_resolved.relative_to(bundle_root)
    except (OSError, RuntimeError, ValueError):
        return None, _api_error(
            "ASSET_OUTSIDE_ALLOWED_ROOT",
            "A robot bundle file resolves outside its registered root.",
            details={"relative_path": relative_path},
        )
    return strict_resolved, None


class RobotAssetInspector:
    """Validate one registered robot bundle without loading a robot runtime."""

    def inspect(
        self,
        bundle: AssetBundle,
        bundle_root: str | Path,
        *,
        verify_hashes: bool = True,
        parse_content: bool = True,
    ) -> AssetInspection:
        """Return compact URDF facts and structured, Agent-safe failures."""

        errors: list[ApiError] = []
        warnings: list[str] = []
        root_path = Path(bundle_root)
        try:
            root = root_path.resolve(strict=True)
            if not root.is_dir():
                raise OSError
        except (OSError, RuntimeError):
            root = root_path.resolve(strict=False)
            errors.append(
                _api_error(
                    "ASSET_NOT_FOUND",
                    "The registered robot bundle root is unavailable.",
                )
            )

        if bundle.kind is not AssetKind.ROBOT_BUNDLE:
            errors.append(
                _api_error(
                    "UNSUPPORTED_ASSET_KIND",
                    "Robot inspection requires a robot_bundle asset.",
                    details={"kind": bundle.kind.value},
                )
            )
        if bundle.category is not AssetCategory.ROBOT_MODEL:
            errors.append(
                _api_error(
                    "BUNDLE_METADATA_MISMATCH",
                    "A robot bundle must use the robot_model category.",
                    details={"category": bundle.category.value},
                )
            )

        resolved_files: dict[str, Path] = {}
        manifest_by_path = {item.relative_path: item for item in bundle.files}
        if root.is_dir():
            for item in bundle.files:
                path, path_error = _inspection_path(root, item.relative_path)
                if path_error is not None:
                    if not item.required and path_error.code == "BUNDLE_INCOMPLETE":
                        warnings.append(
                            f"Optional robot bundle file is missing: {item.relative_path}."
                        )
                    else:
                        errors.append(path_error)
                    continue
                assert path is not None
                resolved_files[item.relative_path] = path
                if verify_hashes:
                    try:
                        digest, size, stable = _sha256(path)
                    except OSError:
                        errors.append(
                            _api_error(
                                "ASSET_NOT_FOUND",
                                "A robot bundle file cannot be read.",
                                details={"relative_path": item.relative_path},
                            )
                        )
                        continue
                    if not stable or digest != item.sha256 or size != item.size_bytes:
                        errors.append(
                            _api_error(
                                "ASSET_HASH_MISMATCH",
                                "A robot bundle file no longer matches its manifest.",
                                details={
                                    "relative_path": item.relative_path,
                                    "expected_sha256": item.sha256,
                                    "actual_sha256": digest,
                                },
                            )
                        )

        primary_manifest = manifest_by_path.get(bundle.primary_file)
        if Path(bundle.primary_file).suffix.casefold() != ".urdf":
            errors.append(
                _api_error(
                    "UNSUPPORTED_FORMAT",
                    "Robot inspection requires a URDF primary file.",
                )
            )
        if primary_manifest is None:
            errors.append(
                _api_error(
                    "BUNDLE_INCOMPLETE",
                    "The primary robot description is absent from the manifest.",
                )
            )
        elif primary_manifest.role is not AssetFileRole.ROBOT_DESCRIPTION:
            errors.append(
                _api_error(
                    "BUNDLE_METADATA_MISMATCH",
                    "The primary URDF must have the robot_description role.",
                    details={"relative_path": bundle.primary_file},
                )
            )

        primary_path = resolved_files.get(bundle.primary_file)
        primary_integrity_failed = any(
            error.code in {"ASSET_HASH_MISMATCH", "ASSET_NOT_FOUND", "BUNDLE_INCOMPLETE"}
            and error.details.get("relative_path") == bundle.primary_file
            for error in errors
        )
        facts: _UrdfFacts | None = None
        unique_meshes: set[str] = set()
        shared_meshes: set[str] = set()
        content_parsed = False
        if parse_content and primary_path is not None and not primary_integrity_failed:
            try:
                xml_root = _read_urdf(primary_path)
                facts = _analyse_urdf(xml_root)
                errors.extend(facts.errors)
                warnings.extend(facts.warnings)
                content_parsed = True

                roles_by_path: dict[str, set[AssetFileRole]] = defaultdict(set)
                for declaration in facts.mesh_declarations:
                    if not declaration.reference:
                        continue
                    try:
                        mesh_path = _resolve_mesh(
                            declaration,
                            urdf_path=primary_path,
                            bundle_root=root,
                        )
                    except RobotAssetDiscoveryError as exc:
                        errors.append(exc.api_error)
                        continue
                    relative = _safe_relative(mesh_path, root)
                    unique_meshes.add(relative)
                    roles_by_path[relative].add(declaration.role)
                    manifest_file = manifest_by_path.get(relative)
                    if manifest_file is None:
                        errors.append(
                            _api_error(
                                "BUNDLE_INCOMPLETE",
                                "A referenced robot mesh is not declared in the manifest.",
                                details={
                                    "relative_path": relative,
                                    "role": declaration.role.value,
                                },
                            )
                        )
                    elif manifest_file.role not in _MESH_ROLES:
                        errors.append(
                            _api_error(
                                "BUNDLE_METADATA_MISMATCH",
                                "A referenced robot mesh has a non-mesh manifest role.",
                                details={
                                    "relative_path": relative,
                                    "role": manifest_file.role.value,
                                },
                            )
                        )
                shared_meshes = {
                    relative for relative, roles in roles_by_path.items() if len(roles) > 1
                }
                for relative, roles in roles_by_path.items():
                    manifest_file = manifest_by_path.get(relative)
                    if manifest_file is None or manifest_file.role not in _MESH_ROLES:
                        continue
                    expected_role = (
                        AssetFileRole.COLLISION_MESH
                        if AssetFileRole.COLLISION_MESH in roles
                        else AssetFileRole.VISUAL_MESH
                    )
                    if manifest_file.role is not expected_role:
                        errors.append(
                            _api_error(
                                "BUNDLE_METADATA_MISMATCH",
                                "A robot mesh manifest role does not match its URDF use.",
                                details={
                                    "relative_path": relative,
                                    "declared_role": manifest_file.role.value,
                                    "expected_role": expected_role.value,
                                },
                            )
                        )

                declared_meshes = {
                    relative
                    for relative, item in manifest_by_path.items()
                    if item.role in _MESH_ROLES
                }
                unused = sorted(declared_meshes - unique_meshes)
                if unused:
                    warnings.append(
                        f"{len(unused)} declared mesh file(s) are not referenced by the URDF."
                    )
            except RobotAssetDiscoveryError as exc:
                errors.append(exc.api_error)

        metadata: dict[str, Any] = {
            "content_parsed": content_parsed,
            "manifest_file_count": len(bundle.files),
            "mesh_manifest_count": sum(item.role in _MESH_ROLES for item in bundle.files),
        }
        joint_count = None
        if facts is not None:
            metadata.update(
                _metadata(
                    facts,
                    unique_meshes=len(unique_meshes),
                    shared_meshes=len(shared_meshes),
                )
            )
            joint_count = facts.joint_count

        if errors:
            status = InspectionStatus.INVALID
        elif warnings:
            status = InspectionStatus.VALID_WITH_WARNINGS
        else:
            status = InspectionStatus.VALID
        return AssetInspection(
            asset_id=bundle.asset_id,
            status=status,
            kind=bundle.kind,
            category=AssetCategory.ROBOT_MODEL,
            source_format="urdf",
            joint_count=joint_count,
            warnings=warnings,
            errors=errors,
            metadata=metadata,
        )


__all__ = [
    "RobotAssetDiscovery",
    "RobotAssetDiscoveryError",
    "RobotAssetFile",
    "RobotAssetInspector",
    "discover_robot_bundle",
]
