"""FastAPI backend for the hhtools web UI.

Single-user, localhost-first.  All heavy lifting (motion IO, URDF loading,
calibration, retargeting) re-uses the existing ``hhtools`` pipeline; the
browser only renders and drives interaction.

Run via ``hhtools web`` (see :mod:`hhtools.cli.web`) or::

    uv run hhtools web
"""

from __future__ import annotations

import atexit
import hashlib
import hmac
import ipaddress
import json
import logging
import math
import os
import shlex
import shutil
import tempfile
import threading
import time
import uuid
from collections.abc import Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath, PureWindowsPath
from typing import Any

from hhtools.services.runtime_lease import AgentRuntimeLease
from hhtools.web.dependencies import require_web_runtime_dependencies
from hhtools.web.job_scheduler import (
    JobQueueFullError,
    JobReservation,
    JobScheduler,
    JobSchedulerClosedError,
)
from hhtools.web.job_settings import (
    JobAdmissionSettings,
    JobAdmissionSettingsStore,
    updated_job_admission_settings,
    validate_job_admission_settings,
)
from hhtools.web.job_specs import (
    JobSpecError,
    build_job_spec,
    normalize_job_spec,
    replay_capability,
)

# These names are referenced in route annotations (e.g. ``list[UploadFile]``).
# Because this module uses ``from __future__ import annotations`` *and* imports
# FastAPI lazily inside ``create_app``, FastAPI would resolve those string
# annotations against the *module* globals — where the lazily-imported names are
# absent — and fail.  Importing them here (guarded, so the module still loads
# without the optional ``web`` extra) makes the forward refs resolvable.
try:  # pragma: no cover - depends on optional extra being installed
    from fastapi import Request, UploadFile
except ImportError:  # fastapi not installed; routes are never defined either
    Request = Any  # type: ignore[assignment,misc]
    UploadFile = Any  # type: ignore[assignment,misc]

_log = logging.getLogger(__name__)

# Bump when static/ front-end behaviour changes.  Injected into ``index.html``
# at serve time so collaborators only need to pull + restart (no triple-sync).
UI_BUILD_ID = "20260902-react-workbench"

_UPLOAD_CHUNK_BYTES = 1024 * 1024
# These are application-level resource controls, not transport tuning knobs.
# Upload/retention bounds are active by default; job admission is deliberately
# unlimited unless an expert deployment opts into a concurrency cap and queue.
_DEFAULT_MAX_UPLOAD_FILES = 4096
_DEFAULT_MAX_UPLOAD_FILE_BYTES = 2 * 1024**3
_DEFAULT_MAX_UPLOAD_REQUEST_BYTES = 8 * 1024**3
_DEFAULT_MAX_RUNNING_JOBS = 0
_DEFAULT_MAX_QUEUED_JOBS = 0
_DEFAULT_MAX_RETAINED_JOBS = 64
_DEFAULT_JOB_TTL_SECONDS = 60 * 60.0

_ACTIVE_JOB_STATUSES = frozenset({"pending", "running"})

# Product-curated models remain read-only even when a distribution provisions
# them below the same per-user root as uploaded models. Keep this list aligned
# with the front-end Robot Library catalog.
_BUILTIN_ROBOT_PRESET_NAMES = frozenset(
    {
        "g1_29dof",
        "roboto_origin",
        "agibot_x2_ultra",
        "asimov_1",
        "fourier_gr2",
        "berkeley_humanoid_lite",
    }
)


def _is_builtin_robot_preset(name: str) -> bool:
    return str(name).strip().lower() in _BUILTIN_ROBOT_PRESET_NAMES

_UPLOAD_ENDPOINTS = frozenset(
    {
        "/api/dataset/upload",
        "/api/basket/upload",
        "/api/motion/upload",
        "/api/video-to-motion/upload",
        "/api/robot/upload",
        "/api/r2r/source/upload",
        "/api/r2r/basket/upload",
    }
)
# Datasets whose adapters accept ``with_mesh=True`` (SMPL forward → baked vertices).
# The web UI always requests mesh so AMASS / Motion-X etc. show a real body surface,
# not just a stick skeleton (matches Viser's "Skinned mesh" path).
_SMPL_MESH_DATASETS: frozenset[str] = frozenset(
    {"amass", "motion_x", "phuma", "gvhmr", "kungfu_athlete"}
)

# Map a motion's provenance to the calibration reference pose it needs.  This
# drives the "this format isn't calibrated yet — calibrate first" prompt.
_FORMAT_TO_REFERENCE: dict[str, str] = {
    "smpl": "smpl",
    "smplh": "smpl",
    "smplx": "smplx",
    "bvh": "lafan_bvh",
    "glb": "glb",
    "gltf": "glb",
    "npz": "smpl",
    "csv": "smpl",
    "unknown": "smpl",
}

# Dataset adapter name → reference (more specific than source_format).
_DATASET_TO_REFERENCE: dict[str, str] = {
    "amass": "smpl",
    "motion_x": "smplx",
    "phuma": "smpl",
    "lafan": "lafan_bvh",
    "mocap": "mocap_bvh",
    "soma": "soma_bvh",
    "xsens_mocap": "xsens_mocap",
    "gvhmr": "gvhmr",
    "omomo": "smplx",
    "omnicontact": "lafan_bvh",
    "meshmimic_holosoma": "smplx",
    "glb": "glb",
    "unified_npz": "smpl",
    "parc_ms": "smpl",
}


def _tmpdir(tag: str) -> Path:
    return Path(tempfile.mkdtemp(prefix=f"hhtools_web_{tag}_"))


def _safe_upload_relative_path(
    filename: str | None,
    *,
    default: str = "upload.bin",
) -> Path:
    """Return a normalized browser upload path that cannot escape its drop root."""

    raw = str(filename or default).strip()
    if not raw or "\x00" in raw:
        raise ValueError("invalid upload filename")

    normalized = raw.replace("\\", "/")
    posix_path = PurePosixPath(normalized)
    windows_path = PureWindowsPath(normalized)
    if posix_path.is_absolute() or windows_path.is_absolute() or windows_path.drive:
        raise ValueError("upload filename must be relative")
    if not posix_path.parts or any(part == ".." for part in posix_path.parts):
        raise ValueError("upload filename contains a parent-directory segment")

    relative = Path(*posix_path.parts)
    if relative.name in ("", ".", ".."):
        raise ValueError("invalid upload filename")
    return relative


def _ensure_path_within(root: Path, candidate: Path) -> Path:
    """Resolve ``candidate`` and require it to remain below ``root``."""

    resolved_root = Path(root).resolve()
    resolved_candidate = Path(candidate).resolve(strict=False)
    try:
        resolved_candidate.relative_to(resolved_root)
    except ValueError as err:
        raise ValueError("upload path escapes its destination") from err
    return resolved_candidate


def _safe_upload_destination(root: Path, relative: Path) -> Path:
    return _ensure_path_within(root, Path(root).resolve() / relative)


def _safe_upload_directory_name(name: str | None, *, default: str) -> str:
    relative = _safe_upload_relative_path(name, default=default)
    if len(relative.parts) != 1:
        raise ValueError("upload directory name must contain one path segment")
    return relative.name


def _adopt_motion_library_root(
    target: Path,
    *,
    current_root: Path | None = None,
    trusted_roots: tuple[Path, ...] = (),
) -> Path:
    """Create or explicitly adopt one dedicated, managed library container.

    Library publication can replace a same-named child directory, so silently
    treating an arbitrary populated dataset directory as its managed root would
    make later unlink/import actions destructive. New selections must therefore
    be empty (or already carry our marker). The current historical root may be
    marked in place because hhtools already owns its child namespace.
    """

    from hhtools.web.motion_library_settings import (
        motion_library_marker_path,
        motion_library_marker_payload,
        validate_motion_library_marker,
    )

    root = Path(target).expanduser().resolve(strict=False)
    if root.parent == root or root == Path.home().resolve(strict=False):
        raise ValueError("请选择专用的资源库目录，不能使用文件系统根目录或用户主目录")
    if root.exists() and not root.is_dir():
        raise ValueError("资源库路径必须是目录")

    marker = motion_library_marker_path(root)
    known_roots = trusted_roots + (
        (current_root,) if current_root is not None else ()
    )
    already_owned = any(
        root == Path(candidate).expanduser().resolve(strict=False)
        for candidate in known_roots
    )
    marker_is_valid = validate_motion_library_marker(root)
    if root.is_dir() and not marker_is_valid and not already_owned:
        try:
            has_existing_content = next(root.iterdir(), None) is not None
        except OSError as err:
            raise ValueError(f"无法读取资源库目录：{err}") from err
        if has_existing_content:
            raise ValueError(
                "所选目录不是空目录。请选择一个空的专用目录；"
                "已有数据集请使用“链接目录”接入。"
            )

    try:
        root.mkdir(parents=True, exist_ok=True)
        temporary = marker.with_name(f".{marker.name}.{time.time_ns()}.tmp")
        try:
            temporary.write_text(
                json.dumps(
                    motion_library_marker_payload(),
                    ensure_ascii=False,
                    indent=2,
                    sort_keys=True,
                ) + "\n",
                encoding="utf-8",
            )
            temporary.replace(marker)
        finally:
            temporary.unlink(missing_ok=True)
    except OSError as err:
        raise ValueError(f"无法写入资源库目录：{err}") from err
    return root


def _is_loopback_address(value: str | None, *, allow_localhost: bool = False) -> bool:
    """Recognize loopback literals without trusting arbitrary DNS resolution."""

    if value is None:
        return False
    if allow_localhost and value.lower() == "localhost":
        return True
    try:
        address = ipaddress.ip_address(value)
    except ValueError:
        return False
    if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped is not None:
        return address.ipv4_mapped.is_loopback
    return address.is_loopback


def _robot_library_root() -> Path:
    """Persistent per-user robot library (survives ``hhtools web`` restarts)."""
    from hhtools.utils.paths import user_robot_dir

    return user_robot_dir()


def _start_robot_prewarm(state: SessionState, model: Any, name: str) -> None:
    """Background-compile Warp IK kernels after a robot loads (Viser parity)."""

    def _run() -> None:
        try:
            _require_newton_package()
            from hhtools.retarget.newton_basic._warp_config import configure as configure_warp_cache
            from hhtools.retarget.newton_basic.pipeline import NewtonBasicPipeline

            configure_warp_cache()
            NewtonBasicPipeline.prewarm_for_robot(model)
        except Exception:  # noqa: BLE001 — optional GPU / missing newton
            _log.debug("background IK prewarm failed for %r", name, exc_info=True)

    prev = state.robot_prewarm_threads.get(name)
    if isinstance(prev, threading.Thread) and prev.is_alive():
        return
    thread = threading.Thread(
        target=_run, name=f"hhtools-web-prewarm-{name}", daemon=True,
    )
    state.robot_prewarm_threads[name] = thread
    thread.start()


def _join_robot_prewarm(state: SessionState, robot_name: str, job: Job | None) -> None:
    """Wait for background prewarm before the first retarget solve."""
    thread = state.robot_prewarm_threads.get(robot_name)
    if not isinstance(thread, threading.Thread) or not thread.is_alive():
        return
    if job is not None:
        job.progress = max(job.progress, 0.03)
        job.message = "正在预热 IK 内核（新机器人首次 retarget 较慢，请稍候）…"
    thread.join(timeout=180.0)


def _require_newton_package() -> None:
    """Raise a clear error when the optional NVIDIA ``newton`` wheel is missing."""
    try:
        import newton  # noqa: F401
    except ModuleNotFoundError as err:
        raise ValueError(
            "未安装 newton（Newton IK 依赖）。请先安装 retarget 额外依赖：\n"
            "  uv sync --extra web --extra retarget\n"
            "并按 NVIDIA / SOMA-Retargeter 文档安装 newton 包；"
            "仅预览 AMASS/parc_ms 动作不需要 newton，但 Retarget 与部分缩放预览需要。"
        ) from err


@dataclass
class SessionState:
    """In-memory state for the single active browser session."""

    source_root: Path
    save_dir: Path
    cache: Any = None  # EphemeralCache
    job_history: Any = None  # JobHistoryStore
    motions: dict[str, Any] = field(default_factory=dict)  # token -> (Motion, meta)
    robots: dict[str, Any] = field(default_factory=dict)  # name -> URDFRobotModel
    jobs: dict[str, Job] = field(default_factory=dict)
    # robot-to-robot source trajectories: token -> {source_robot, motion, ...}
    r2r_sources: dict[str, Any] = field(default_factory=dict)
    # dataset viz robot preview: token -> {clip_dir, source_path}
    dataset_previews: dict[str, Any] = field(default_factory=dict)
    basket: list[dict] = field(default_factory=list)  # library entries queued for batch
    upload_root: Path = field(default_factory=lambda: _tmpdir("up"))
    robot_root: Path = field(default_factory=lambda: _robot_library_root())
    export_root: Path = field(default_factory=lambda: _tmpdir("out"))
    robot_prewarm_threads: dict[str, threading.Thread] = field(default_factory=dict)
    job_lock: threading.Lock = field(default_factory=threading.Lock)


@dataclass
class Job:
    id: str
    kind: str
    request: dict[str, Any] = field(default_factory=dict)
    status: str = "running"  # pending | running | done | error
    progress: float = 0.0  # overall job progress (batch: all clips)
    clip_progress: float = 0.0  # batch only: current clip / GPU-chunk progress
    message: str = ""
    result: dict | None = None
    error: str | None = None
    parent_job_id: str | None = None
    created_at: float = field(default_factory=time.monotonic)
    created_wall_time: float = field(default_factory=time.time)
    finished_wall_time: float | None = None
    terminal_since: float | None = None
    last_accessed_at: float = field(default_factory=time.monotonic)
    on_terminal: Callable[[Job], None] | None = field(
        default=None, repr=False, compare=False,
    )

    def mark_running(self) -> None:
        """Publish the transition from the FIFO queue into an execution slot."""

        self.status = "running"

    def mark_terminal(self, status: str) -> None:
        """Publish terminal status only after the worker has populated its result."""
        self.terminal_since = time.monotonic()
        self.finished_wall_time = time.time()
        self.status = status
        if self.on_terminal is not None:
            try:
                self.on_terminal(self)
            except Exception:  # noqa: BLE001 - history must not fail the actual job
                _log.exception("failed to persist terminal Web job %s", self.id)


def _snapshot_job_request(value: Any) -> Any:
    """Copy JSON-like request data so later UI mutations cannot alter job history."""
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, dict):
        return {str(key): _snapshot_job_request(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_snapshot_job_request(item) for item in value]
    return str(value)


def _cleanup_session_state(state: SessionState) -> None:
    """Release resources owned by one FastAPI process without touching user data."""
    try:
        if state.cache is not None:
            state.cache.cleanup()
    except Exception:  # noqa: BLE001 - shutdown cleanup must remain best-effort
        _log.warning("failed to clean the web motion cache", exc_info=True)

    # Robot presets and save_dir are persistent user data. Only roots minted by
    # SessionState are safe to remove when this server instance shuts down.
    for root in (state.upload_root, state.export_root):
        shutil.rmtree(root, ignore_errors=True)

    with state.job_lock:
        state.jobs.clear()
    state.motions.clear()
    state.r2r_sources.clear()
    state.dataset_previews.clear()
    state.basket.clear()
    state.robot_prewarm_threads.clear()


def _create_app_owned(
    *,
    source_root: Path,
    save_dir: Path,
    cache_dir: Path | None = None,
    desktop_session_secret: str | None = None,
    desktop_allowed_host: str | None = None,
    desktop_allowed_origin: str | None = None,
    max_upload_files: int = _DEFAULT_MAX_UPLOAD_FILES,
    max_upload_file_bytes: int = _DEFAULT_MAX_UPLOAD_FILE_BYTES,
    max_upload_request_bytes: int = _DEFAULT_MAX_UPLOAD_REQUEST_BYTES,
    max_running_jobs: int = _DEFAULT_MAX_RUNNING_JOBS,
    max_queued_jobs: int = _DEFAULT_MAX_QUEUED_JOBS,
    max_retained_jobs: int = _DEFAULT_MAX_RETAINED_JOBS,
    job_ttl_seconds: float = _DEFAULT_JOB_TTL_SECONDS,
    job_history_dir: Path | None = None,
    job_settings_path: Path | None = None,
    agent_mcp_available: bool = False,
    agent_rest_available: bool = True,
    agent_json_cli_available: bool = True,
    agent_runtime_lease: AgentRuntimeLease,
):
    """Build the FastAPI application while ``agent_runtime_lease`` is held."""
    from fastapi import FastAPI, File, HTTPException
    from fastapi.exception_handlers import http_exception_handler
    from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, Response
    from fastapi.staticfiles import StaticFiles
    from starlette.exceptions import HTTPException as StarletteHTTPException
    from starlette.routing import Match

    from hhtools.utils.paths import user_job_history_dir
    from hhtools.viewer.cache import EphemeralCache
    from hhtools.agent.boundary import (
        AgentBoundaryMiddleware,
        agent_error_response,
        is_agent_path,
    )
    from hhtools.web.job_history import JobHistoryStore

    static_dir = Path(__file__).parent / "static"

    positive_limits = {
        "max_upload_files": max_upload_files,
        "max_upload_file_bytes": max_upload_file_bytes,
        "max_upload_request_bytes": max_upload_request_bytes,
        "max_retained_jobs": max_retained_jobs,
    }
    invalid_limits = [
        name for name, value in positive_limits.items() if int(value) <= 0
    ]
    if float(job_ttl_seconds) <= 0:
        invalid_limits.append("job_ttl_seconds")
    if invalid_limits:
        names = ", ".join(invalid_limits)
        raise ValueError(f"resource limits must be positive: {names}")
    non_negative_limits = {
        "max_running_jobs": max_running_jobs,
        "max_queued_jobs": max_queued_jobs,
    }
    invalid_limits = [
        name for name, value in non_negative_limits.items() if int(value) < 0
    ]
    if invalid_limits:
        names = ", ".join(invalid_limits)
        raise ValueError(f"job scheduler limits must be non-negative: {names}")

    state = SessionState(source_root=Path(source_root), save_dir=Path(save_dir))
    try:
        state.cache = EphemeralCache.create(cache_dir=cache_dir, save_dir=save_dir)
        history_root = (
            Path(job_history_dir)
            if job_history_dir is not None
            else user_job_history_dir()
        )
        state.job_history = JobHistoryStore(history_root, max_records=max_retained_jobs)
        scheduler = JobScheduler(
            max_running_jobs=max_running_jobs,
            max_queued_jobs=max_queued_jobs,
        )
        job_settings_store = (
            JobAdmissionSettingsStore(job_settings_path)
            if job_settings_path is not None
            else None
        )
    except Exception:
        _cleanup_session_state(state)
        raise
    # Motion uploads load from immutable per-request drops.  Publication into
    # the shared label namespace is short and serialized so same-label imports
    # cannot interleave delete/copy operations.
    motion_library_publish_lock = threading.Lock()
    job_settings_update_lock = threading.Lock()
    cleanup_lock = threading.Lock()
    cleanup_complete = False

    def _cleanup_session_once() -> None:
        """Release session-owned roots once, including at interpreter exit."""

        nonlocal cleanup_complete
        with cleanup_lock:
            if cleanup_complete:
                return
            cleanup_complete = True
        _cleanup_session_state(state)
        atexit.unregister(_cleanup_session_once)

    # If uvicorn exits after the graceful timeout, its daemon cleanup thread
    # cannot keep the process alive.  The interpreter callback still removes
    # this process's temporary roots; persistent user data is never included.
    atexit.register(_cleanup_session_once)

    def _deferred_session_cleanup() -> None:
        """Clean temporary roots once jobs that outlive graceful shutdown finish."""

        # Keep this call outside the release ``finally``.  If shutdown itself
        # fails, worker liveness is unknown, so retaining the lease until the
        # process exits is the safe fail-closed outcome.
        scheduler.shutdown(wait=True)
        try:
            _cleanup_session_once()
        finally:
            agent_runtime_lease.release()

    @asynccontextmanager
    async def _lifespan(_app):  # type: ignore[no-untyped-def]
        try:
            yield
        finally:
            # Do not close admission between a settings file write and its live
            # reconfiguration; one lock makes Save and graceful shutdown linear.
            # A shutdown exception deliberately leaves the OS lease held: a
            # competing runtime must not recover jobs while worker state is
            # unknown.  Normal process exit releases the descriptor.
            with job_settings_update_lock:
                drained = scheduler.shutdown(wait=True, timeout=5.0)
            if drained:
                try:
                    _cleanup_session_once()
                finally:
                    agent_runtime_lease.release()
            else:
                # A Python thread cannot be force-cancelled safely.  Preserve
                # its temporary inputs instead of deleting files beneath it,
                # then reclaim them if the host process remains alive long
                # enough for the worker to finish.
                _log.warning(
                    "Web shutdown timed out with active jobs; deferring session cleanup"
                )
                threading.Thread(
                    target=_deferred_session_cleanup,
                    name="hhtools-web-deferred-cleanup",
                    daemon=True,
                ).start()

    app = FastAPI(title="hhtools web", version="0.1", lifespan=_lifespan)
    # Exposed for diagnostics and lifecycle regression tests, not as an HTTP API.
    app.state.session_state = state
    app.state.job_scheduler = scheduler
    app.state.job_settings_store = job_settings_store
    app.state.agent_runtime_lease = agent_runtime_lease

    @app.exception_handler(StarletteHTTPException)
    async def _agent_http_exception_handler(request, exc):  # type: ignore[no-untyped-def]
        """Keep router-level Agent 404/405 responses on the ApiError wire.

        Service-level 404s are already serialized by ``_AgentRoute``.  Every
        other route and HTTPException retains FastAPI's normal behavior.
        """

        if is_agent_path(request.url.path) and exc.status_code in {404, 405}:
            if exc.status_code == 404:
                return agent_error_response(
                    status_code=404,
                    code="ENDPOINT_NOT_FOUND",
                    message="The requested Agent endpoint does not exist.",
                )
            method_headers = dict(exc.headers or {})
            if not any(name.casefold() == "allow" for name in method_headers):
                allowed_methods: set[str] = set()
                for route in request.app.routes:
                    match, _child_scope = route.matches(request.scope)
                    if match is Match.PARTIAL:
                        allowed_methods.update(getattr(route, "methods", set()) or set())
                if allowed_methods:
                    method_headers["Allow"] = ", ".join(sorted(allowed_methods))
            return agent_error_response(
                status_code=405,
                code="METHOD_NOT_ALLOWED",
                message="The HTTP method is not supported by this Agent endpoint.",
                headers=method_headers,
            )
        return await http_exception_handler(request, exc)

    def _validated_uploads(
        files: list[UploadFile],
        *,
        default: str = "upload.bin",
    ) -> list[tuple[UploadFile, Path]]:
        if len(files) > max_upload_files:
            raise HTTPException(
                status_code=413,
                detail=f"too many upload files (limit: {max_upload_files})",
            )
        validated: list[tuple[UploadFile, Path]] = []
        try:
            for upload in files:
                validated.append(
                    (
                        upload,
                        _safe_upload_relative_path(upload.filename, default=default),
                    )
                )
        except ValueError as err:
            raise HTTPException(status_code=400, detail=str(err)) from err
        return validated

    def _request_upload_destination(root: Path, relative: Path) -> Path:
        try:
            return _safe_upload_destination(root, relative)
        except ValueError as err:
            raise HTTPException(status_code=400, detail=str(err)) from err

    async def _store_uploads(
        files: list[UploadFile],
        root: Path,
        *,
        default: str = "upload.bin",
        destination_for: Callable[[Path], Path] | None = None,
    ) -> list[tuple[Path, Path]]:
        """Stage a multipart upload, then publish each complete file atomically.

        The size checks finish before publication starts.  Each ``replace`` is
        atomic, but the group is not a filesystem transaction: an I/O failure
        between replacements can still leave a published subset.
        """
        validated = _validated_uploads(files, default=default)
        staged: list[tuple[Path, Path, Path]] = []
        total_bytes = 0
        try:
            for upload, relative in validated:
                candidate = destination_for(relative) if destination_for else relative
                destination = _request_upload_destination(root, candidate)
                destination.parent.mkdir(parents=True, exist_ok=True)
                part = destination.with_name(f".{destination.name}.{uuid.uuid4().hex}.upload")
                file_bytes = 0
                try:
                    with part.open("wb") as fp:
                        while chunk := await upload.read(_UPLOAD_CHUNK_BYTES):
                            file_bytes += len(chunk)
                            total_bytes += len(chunk)
                            if file_bytes > max_upload_file_bytes:
                                raise HTTPException(
                                    status_code=413,
                                    detail=(
                                        f"upload file exceeds {max_upload_file_bytes} bytes: "
                                        f"{relative.as_posix()}"
                                    ),
                                )
                            if total_bytes > max_upload_request_bytes:
                                raise HTTPException(
                                    status_code=413,
                                    detail=(
                                        "upload request exceeds "
                                        f"{max_upload_request_bytes} bytes"
                                    ),
                                )
                            fp.write(chunk)
                except Exception:
                    part.unlink(missing_ok=True)
                    raise
                staged.append((relative, part, destination))

            # Files become visible only after every item passes the size limits,
            # avoiding a partial folder on a normal 413 rejection.  Publication
            # is per-file; an unexpected filesystem failure can still interrupt
            # this loop after an earlier destination has been replaced.
            stored: list[tuple[Path, Path]] = []
            for relative, part, destination in staged:
                part.replace(destination)
                stored.append((relative, destination))
            return stored
        finally:
            for _relative, part, _destination in staged:
                part.unlink(missing_ok=True)
            for upload, _relative in validated:
                await upload.close()

    def _remove_job_artifact(job: Job) -> None:
        """Delete only generated artifacts that belong to this server instance."""
        artifact = (job.result or {}).get("artifact_path")
        if not artifact:
            return
        try:
            path = Path(artifact).resolve()
            export_root = state.export_root.resolve()
            path.relative_to(export_root)
        except (OSError, ValueError, TypeError):
            # A job result may point at user-owned data. Never remove a path
            # unless it is provably contained by the ephemeral export root.
            return
        try:
            if path.is_dir():
                shutil.rmtree(path, ignore_errors=True)
            else:
                path.unlink(missing_ok=True)
        except OSError:
            _log.warning("failed to remove expired job artifact %s", path, exc_info=True)

    def _prune_jobs_locked(now: float) -> None:
        terminal: list[Job] = []
        for job in state.jobs.values():
            if job.status in _ACTIVE_JOB_STATUSES:
                continue
            if job.terminal_since is None:
                job.terminal_since = now
            terminal.append(job)

        expired = {
            job.id
            for job in terminal
            if now - max(job.terminal_since or now, job.last_accessed_at)
            >= job_ttl_seconds
        }
        for job_id in expired:
            removed = state.jobs.pop(job_id, None)
            if removed is not None:
                _remove_job_artifact(removed)

        retained = sorted(
            (job for job in terminal if job.id not in expired),
            key=lambda job: job.terminal_since or job.created_at,
        )
        overflow = max(0, len(retained) - max_retained_jobs)
        for job in retained[:overflow]:
            removed = state.jobs.pop(job.id, None)
            if removed is not None:
                _remove_job_artifact(removed)

    def _job_cli_reproduction(  # noqa: PLR0911 - each unsupported case needs its reason
        kind: str,
        request: dict[str, Any],
    ) -> dict[str, Any]:
        """Build an exact CLI equivalent when the public CLI covers this Web job."""
        if kind not in {"retarget", "batch"}:
            return {
                "available": False,
                "command": None,
                "reason": "该任务类型暂时没有等价的 hhtools CLI 命令。",
            }

        if request.get("retarget_fps") is not None:
            return {
                "available": False,
                "command": None,
                "reason": "当前 CLI 尚未提供 Retarget FPS 重采样参数。",
            }
        if request.get("export_fps") is not None or request.get("fps") is not None:
            return {
                "available": False,
                "command": None,
                "reason": "当前 CLI 尚未提供 Web 导出 FPS 参数。",
            }
        if request.get("t_start") is not None or request.get("t_end") is not None:
            return {
                "available": False,
                "command": None,
                "reason": "当前 CLI 尚未提供 Web 时间区间导出参数。",
            }
        if bool(request.get("foot_clamp_anti_penetration")):
            return {
                "available": False,
                "command": None,
                "reason": "当前 CLI 尚未提供同等的脚部防穿透参数。",
            }
        if str(request.get("format") or "csv").lower() != "csv":
            return {
                "available": False,
                "command": None,
                "reason": "当前 hhtools retarget CLI 仅能复现 CSV 导出。",
            }

        entries = request.get("entries")
        if kind == "batch" and isinstance(entries, list):
            source_paths = [
                str(entry.get("source_path"))
                for entry in entries
                if isinstance(entry, dict) and entry.get("source_path")
            ]
        else:
            source = request.get("source_path")
            source_paths = [str(source)] if source else []
        if not source_paths:
            return {
                "available": False,
                "command": None,
                "reason": "任务只保留了会话 token，没有可供 CLI 重开的源文件路径。",
            }
        if any(not Path(path).is_file() for path in source_paths):
            return {
                "available": False,
                "command": None,
                "reason": "一个或多个源文件已不存在，无法生成可执行的 CLI 命令。",
            }
        try:
            ephemeral_root = state.upload_root.resolve()
            if any(
                Path(path).resolve().is_relative_to(ephemeral_root)
                for path in source_paths
            ):
                return {
                    "available": False,
                    "command": None,
                    "reason": "源文件来自临时上传目录，请先保存到 Motion Library。",
                }
        except OSError:
            return {
                "available": False,
                "command": None,
                "reason": "无法确认源文件是否可供 CLI 访问。",
            }

        robot = str(request.get("robot") or "").strip()
        if not robot:
            return {
                "available": False,
                "command": None,
                "reason": "任务记录缺少目标机器人名称。",
            }

        backend = str(request.get("backend") or "newton").strip().lower()
        if backend == "newton" and any(
            Path(path).suffix.lower() != ".npz" for path in source_paths
        ):
            return {
                "available": False,
                "command": None,
                "reason": "Newton CLI 当前只直接接受 NPZ 输入。",
            }
        if kind == "batch" and isinstance(entries, list):
            references = {
                str(entry.get("reference") or request.get("reference") or "smpl")
                for entry in entries
                if isinstance(entry, dict)
            }
            if len(references) > 1:
                return {
                    "available": False,
                    "command": None,
                    "reason": "该批次包含多个校准参考，当前 CLI 需要按参考分别运行。",
                }
        if request.get("csv_header") is False:
            return {
                "available": False,
                "command": None,
                "reason": "当前 CLI 尚未提供无表头 CSV 导出参数。",
            }
        output = str(
            request.get("out_dir")
            or ("batch_export" if kind == "batch" else "retarget_output.csv")
        )
        reference = str(request.get("reference") or "smpl")
        human_height = float(request.get("human_height") or 1.7)
        ik_iterations = int(request.get("ik_iterations") or 24)

        if backend == "interaction_mesh":
            args = ["hhtools", "retarget", "interaction-mesh", "run", *source_paths]
            args.extend(
                [
                    "--robot",
                    robot,
                    "--output",
                    output,
                    "--human-height",
                    f"{human_height:g}",
                    "--calibration-reference",
                    reference,
                ]
            )
            if request.get("limit_frames") is not None:
                args.extend(["--limit-frames", str(int(request["limit_frames"]))])
        elif backend == "newton":
            args = ["hhtools", "retarget", "run", *source_paths]
            args.extend(
                [
                    "--robot",
                    robot,
                    "--output",
                    output,
                    "--ik-iterations",
                    str(ik_iterations),
                    "--human-height",
                    f"{human_height:g}",
                    "--calibration-reference",
                    reference,
                ]
            )
            if request.get("limit_frames") is not None:
                args.extend(["--limit-frames", str(int(request["limit_frames"]))])
        else:
            return {
                "available": False,
                "command": None,
                "reason": f"未知求解器 {backend!r} 无法映射到 CLI。",
            }
        return {"available": True, "command": shlex.join(args), "reason": None}

    def _reserve_job_slot() -> JobReservation:
        """Reserve scheduler admission before a route performs durable writes."""

        try:
            return scheduler.reserve()
        except JobQueueFullError as err:
            raise HTTPException(status_code=429, detail=str(err)) from err
        except JobSchedulerClosedError as err:
            raise HTTPException(status_code=503, detail=str(err)) from err

    def _scheduler_payload(*, editable: bool | None = None) -> dict[str, int | bool | str]:
        snapshot = scheduler.snapshot()
        payload: dict[str, int | bool | str] = {
            "mode": "unlimited" if snapshot.max_running_jobs == 0 else "queued",
            "max_running_jobs": snapshot.max_running_jobs,
            "max_queued_jobs": snapshot.max_queued_jobs,
            "running_jobs": snapshot.running_jobs,
            "queued_jobs": snapshot.queued_jobs,
            "reserved_jobs": snapshot.reserved_jobs,
            "cancelling_jobs": snapshot.cancelling_jobs,
            "closed": snapshot.closed,
        }
        if editable is not None:
            payload["editable"] = editable
        return payload

    def _job_settings_editable(request: Request) -> bool:
        """Expose the same local-admin boundary enforced by the PATCH route."""

        client_host = request.client.host if request.client is not None else None
        return _is_loopback_address(client_host) and _is_loopback_address(
            request.url.hostname,
            allow_localhost=True,
        )

    def _schedule_job(
        kind: str,
        request: dict[str, Any] | None = None,
        target: Callable[..., None] | None = None,
        *,
        args: tuple[Any, ...] = (),
        kwargs: dict[str, Any] | None = None,
        parent_job_id: str | None = None,
        reservation: JobReservation | None = None,
    ) -> Job:
        """Create, persist, and submit one background Job through the scheduler."""

        if target is None:
            raise TypeError("scheduled job target is required")
        admission = reservation or _reserve_job_slot()
        submitted = False
        try:
            now = time.monotonic()
            job = Job(
                id=uuid.uuid4().hex[:12],
                kind=kind,
                request=_snapshot_job_request(request or {}),
                status="pending",
                message="等待可用的任务执行槽位…",
                parent_job_id=parent_job_id,
                on_terminal=_persist_terminal_job,
            )

            def run() -> None:
                try:
                    job.mark_running()
                    if job.message == "等待可用的任务执行槽位…":
                        job.message = "任务已开始…"
                    _persist_job(job)
                    target(job, *args, **(kwargs or {}))
                except Exception as err:  # noqa: BLE001 - expose worker failure
                    _log.exception("unhandled %s job failure", kind)
                    if job.status in _ACTIVE_JOB_STATUSES:
                        job.error = str(err)
                        job.mark_terminal("error")
                finally:
                    if job.status in _ACTIVE_JOB_STATUSES:
                        job.error = "后台任务提前结束，未发布完成状态。"
                        job.mark_terminal("error")

            def cancel(reason: str) -> None:
                if job.status not in _ACTIVE_JOB_STATUSES:
                    return
                job.message = "任务未开始"
                job.error = reason
                job.mark_terminal("error")

            try:
                with state.job_lock:
                    _prune_jobs_locked(now)
                    state.jobs[job.id] = job
                    _persist_job(job)
            except Exception:
                with state.job_lock:
                    state.jobs.pop(job.id, None)
                raise
            try:
                admission.submit(run, on_cancel=cancel)
            except JobSchedulerClosedError as err:
                cancel(str(err))
                raise HTTPException(status_code=503, detail=str(err)) from err
            except Exception:
                cancel("无法启动后台任务。")
                raise
            submitted = True
            return job
        finally:
            if not submitted:
                admission.cancel()

    def _get_job(job_id: str) -> Job | None:
        now = time.monotonic()
        with state.job_lock:
            _prune_jobs_locked(now)
            job = state.jobs.get(job_id)
            if job is not None:
                job.last_accessed_at = now
            return job

    def _job_parameter_summary(job: Job) -> dict[str, str | int | float | bool]:
        """Return compact, stable parameters suitable for the always-on job drawer."""
        request = job.request
        summary: dict[str, str | int | float | bool] = {}
        keys = (
            "robot",
            "target",
            "target_robot",
            "source_robot",
            "source",
            "profile",
            "reference",
            "backend",
            "embedding",
            "format",
            "retarget_fps",
            "export_fps",
            "source_fps",
            "batch_size",
            "out_dir",
            "folder_label",
            "library_folder_label",
        )
        for key in keys:
            value = request.get(key)
            if isinstance(value, (str, int, float, bool)) and value != "":
                summary[key] = value

        entries = request.get("entries")
        files = request.get("files")
        if isinstance(entries, list):
            summary["entry_count"] = len(entries)
        if isinstance(files, list):
            summary["file_count"] = len(files)
        elif isinstance(request.get("file_count"), int):
            summary["file_count"] = request["file_count"]
        return summary

    def _job_result_summary(job: Job) -> dict[str, str | int | float | bool]:
        result = job.result or {}
        summary: dict[str, str | int | float | bool] = {}
        for key in ("download_name", "num_frames", "clip_count", "solver_mode", "format"):
            value = result.get(key)
            if isinstance(value, (str, int, float, bool)) and value != "":
                summary[key] = value
        written = result.get("written")
        failures = result.get("failures")
        errors = result.get("errors")
        if isinstance(written, list):
            summary["success_count"] = len(written)
        if isinstance(failures, list):
            summary["failure_count"] = len(failures)
        elif isinstance(errors, list):
            summary["failure_count"] = len(errors)
        return summary

    def _job_can_download(job: Job) -> bool:
        artifact = (job.result or {}).get("artifact_path")
        if job.status != "done" or not isinstance(artifact, str):
            return False
        try:
            return Path(artifact).is_file()
        except OSError:
            return False

    def _job_record(job: Job) -> dict[str, Any]:
        finished = job.finished_wall_time
        duration_end = finished if finished is not None else time.time()
        cli = _job_cli_reproduction(job.kind, job.request)
        spec = build_job_spec(job.kind, job.request)
        replay = replay_capability(spec, ephemeral_root=state.upload_root)
        failures = (job.result or {}).get("failures")
        failed_item_count = len(failures) if isinstance(failures, list) else 0
        return {
            "id": job.id,
            "kind": job.kind,
            "status": job.status,
            "progress": job.progress,
            "clip_progress": job.clip_progress,
            "message": job.message,
            "error": job.error,
            "created_at": job.created_wall_time,
            "finished_at": finished,
            "duration_seconds": max(0.0, duration_end - job.created_wall_time),
            "parameters": _job_parameter_summary(job),
            "result_summary": _job_result_summary(job),
            "can_download": _job_can_download(job),
            "can_copy_cli": bool(cli["available"]),
            "can_retry": (
                bool(replay["available"])
                and job.status not in _ACTIVE_JOB_STATUSES
            ),
            "retry_reason": (
                "任务仍在排队或运行中。"
                if job.status in _ACTIVE_JOB_STATUSES
                else replay["reason"]
            ),
            "can_retry_failed": (
                job.kind == "batch"
                and job.status not in _ACTIVE_JOB_STATUSES
                and failed_item_count > 0
                and bool(replay["available"])
            ),
            "failed_item_count": failed_item_count,
            "parent_job_id": job.parent_job_id,
            "scope": "current_session",
        }

    def _persistent_job_record(job: Job) -> dict[str, Any]:
        record = {
            **_job_record(job),
            "schema_version": 1,
            "scope": "persistent",
            "request": _snapshot_job_request(job.request),
            "cli": _job_cli_reproduction(job.kind, job.request),
            "parent_job_id": job.parent_job_id,
        }
        failures = (job.result or {}).get("failures")
        if isinstance(failures, list):
            record["failures"] = _snapshot_job_request(failures)
        artifact = (job.result or {}).get("artifact_path")
        if isinstance(artifact, str):
            record["artifact_path"] = artifact
        download_name = (job.result or {}).get("download_name")
        if isinstance(download_name, str):
            record["download_name"] = download_name
        return record

    def _persist_job(job: Job) -> None:
        state.job_history.put(_persistent_job_record(job))

    def _persist_terminal_job(job: Job) -> None:
        """Persist terminal metadata and move generated ZIPs out of the temp root."""
        artifact = (job.result or {}).get("artifact_path")
        if isinstance(artifact, str):
            try:
                artifact_path = Path(artifact).resolve()
                artifact_path.relative_to(state.export_root.resolve())
                adopted = state.job_history.adopt_artifact(
                    job.id,
                    artifact_path,
                    download_name=(job.result or {}).get("download_name"),
                )
                if job.result is not None:
                    job.result["artifact_path"] = str(adopted)
            except (OSError, ValueError):
                _log.warning(
                    "could not retain generated artifact for job %s", job.id, exc_info=True,
                )
        _persist_job(job)

    def _stored_job_record(record: dict[str, Any]) -> dict[str, Any]:
        artifact = state.job_history.artifact_path(record)
        cli = _job_cli_reproduction(
            str(record.get("kind") or ""), record.get("request") or {},
        )
        spec = build_job_spec(
            str(record.get("kind") or ""), record.get("request") or {},
        )
        replay = replay_capability(spec, ephemeral_root=state.upload_root)
        failures = record.get("failures")
        failed_item_count = len(failures) if isinstance(failures, list) else 0
        return {
            key: value
            for key, value in {
                **record,
                "can_download": artifact is not None,
                "can_copy_cli": bool(cli["available"]),
                "can_retry": bool(replay["available"]),
                "retry_reason": replay["reason"],
                "can_retry_failed": (
                    record.get("kind") == "batch"
                    and failed_item_count > 0
                    and bool(replay["available"])
                ),
                "failed_item_count": failed_item_count,
                "scope": "persistent",
            }.items()
            if key not in {
                "request",
                "cli",
                "artifact_path",
                "download_name",
                "schema_version",
                "failures",
            }
        }

    def _job_config_payload(job: Job | None, stored: dict[str, Any] | None) -> dict[str, Any]:
        if job is not None:
            spec = build_job_spec(job.kind, job.request)
            return {
                "schema_version": 1,
                "job_id": job.id,
                "kind": job.kind,
                "status": job.status,
                "created_at": job.created_wall_time,
                "finished_at": job.finished_wall_time,
                "scope": "current_session",
                "request": job.request,
                "cli": _job_cli_reproduction(job.kind, job.request),
                "spec": spec,
                "replay": replay_capability(spec, ephemeral_root=state.upload_root),
                "parent_job_id": job.parent_job_id,
            }
        if stored is None:
            raise HTTPException(status_code=404, detail="unknown job")
        spec = build_job_spec(
            str(stored.get("kind") or ""), stored.get("request") or {},
        )
        return {
            "schema_version": int(stored.get("schema_version") or 1),
            "job_id": stored["id"],
            "kind": stored["kind"],
            "status": stored["status"],
            "created_at": stored["created_at"],
            "finished_at": stored.get("finished_at"),
            "scope": "persistent",
            "request": stored.get("request") or {},
            "cli": _job_cli_reproduction(
                str(stored.get("kind") or ""), stored.get("request") or {},
            ),
            "spec": spec,
            "replay": replay_capability(spec, ephemeral_root=state.upload_root),
            "parent_job_id": stored.get("parent_job_id"),
        }

    from hhtools.utils.paths import (
        HHTOOLS_MOTION_LIBRARY_ROOT_ENV,
        user_motion_library_root,
        user_motion_library_settings_path,
    )
    from hhtools.web.motion_library_links import ensure_motions_library, motions_library_root
    from hhtools.web.motion_library_settings import (
        MotionLibrarySettingsStore,
        effective_motion_library_root,
        updated_motion_library_settings,
    )

    motion_library_settings_store = MotionLibrarySettingsStore(
        user_motion_library_settings_path(),
    )
    app.state.motion_library_settings_store = motion_library_settings_store
    ensure_motions_library()

    # Agent-facing REST is a thin, versioned adapter over transport-neutral
    # services.  Capability discovery receives only the scheduler's read-only
    # snapshot function: it cannot reserve a queue slot or touch solver state.
    from hhtools.contracts import (
        ApiError,
        AssetFileRole,
        AssetInspectionRequest,
        ErrorStage,
        InspectionStatus,
        JobSpecV2,
        NextAction,
    )
    from hhtools.services import (
        AgentAssetService,
        ArtifactExportService,
        ArtifactStore,
        AssetRegistry,
        AssetServiceError,
        CapabilitiesService,
        DynamicRootLocator,
        JobManager,
        JobStore,
        LegacyJobUpgradeService,
        PlanStore,
        PreflightService,
        RetargetService,
        RetargetServiceError,
    )
    from hhtools.agent.api import router as agent_router
    from hhtools.agent.h2r_job_executor import (
        H2RExecutorBindings,
        H2RJobExecutor,
        H2RPreview,
        ResolvedMotion,
    )

    agent_motion_roots: dict[str, Path | Callable[[], Path]] = {
        "motion-library": motions_library_root,
        "source": state.source_root,
    }
    agent_robot_roots: dict[str, Path | Callable[[], Path]] = {
        "robot-library": state.robot_root,
    }
    workspace_robot_root = Path(__file__).resolve().parents[2] / "configs" / "robots"
    if workspace_robot_root.is_dir() and any(
        child.is_dir() and not child.name.startswith("_")
        for child in workspace_robot_root.iterdir()
    ):
        agent_robot_roots["workspace-robots"] = workspace_robot_root
    app.state.agent_legacy_root_locator = DynamicRootLocator(
        motion_roots=agent_motion_roots,
        robot_roots=agent_robot_roots,
    )
    agent_data_dir = state.save_dir / ".hhtools-agent"
    app.state.agent_asset_service = AgentAssetService(
        AssetRegistry(
            agent_data_dir,
            app.state.agent_legacy_root_locator.registry_root_providers(),
        )
    )
    app.state.agent_plan_store = PlanStore(agent_data_dir)
    app.state.agent_retarget_service = RetargetService(
        app.state.agent_plan_store,
        app.state.agent_asset_service,
    )
    app.state.agent_artifact_store = ArtifactStore(agent_data_dir)
    app.state.agent_job_store = JobStore(agent_data_dir)

    # The production Agent executor is intentionally a set of thin bindings to
    # the existing H2R Web path.  These closures perform no IK/calibration math;
    # they keep the old loader, solver, preview, diagnostics, and exporter as
    # the single implementation while JobManager owns lifecycle semantics.
    agent_robot_load_lock = threading.Lock()
    agent_preview_max_frames = 600

    def _agent_validate_spec(spec: JobSpecV2) -> None:
        current = app.state.agent_retarget_service.get_job_spec(spec.plan_id)
        if current.model_dump(mode="json") == spec.model_dump(mode="json"):
            return
        raise RetargetServiceError(
            ApiError(
                code="PLAN_STALE",
                message="The persisted JobSpec no longer matches the immutable plan.",
                stage=ErrorStage.PREFLIGHT,
                details={"plan_id": spec.plan_id},
                next_action=NextAction(
                    actor="agent",
                    action="run_preflight",
                    message="Run retarget preflight again before retrying the job.",
                    parameters={"plan_id": spec.plan_id},
                ),
            )
        )

    def _agent_resolve_motion(asset_id: str) -> ResolvedMotion:
        bundle = app.state.agent_asset_service.get(asset_id)
        dataset = bundle.detected.dataset if bundle.detected is not None else None
        if not isinstance(dataset, str) or not dataset:
            raise ValueError("the verified motion bundle has no dataset routing identity")
        return ResolvedMotion(
            asset_id=bundle.asset_id,
            category=bundle.category,
            dataset=dataset,
            source_path=app.state.agent_asset_service.resolve_primary(asset_id),
            stem=Path(bundle.primary_file).stem,
        )

    def _agent_load_motion(resolved: ResolvedMotion) -> Any:
        from hhtools.web.upload_resolve import (
            _load_intermimic,
            _load_meshmimic,
            _load_via_dataset_adapter,
        )

        path = resolved.source_path
        dataset = resolved.dataset
        suffix = path.suffix.casefold()
        if dataset in {"omomo", "omnicontact"}:
            motion, loaded_dataset = _load_intermimic(path)
        elif dataset == "parc_ms":
            motion, loaded_dataset = _load_meshmimic(
                "npz" if suffix == ".npz" else "pkl",
                path,
            )
        elif dataset in {
            "amass",
            "gvhmr",
            "kungfu_athlete",
            "meshmimic_holosoma",
            "motion_x",
            "phuma",
            "unified_npz",
        } and suffix not in {".bvh", ".csv", ".glb", ".gltf"}:
            motion, loaded_dataset = _load_via_dataset_adapter(path, dataset)
        elif dataset in {
            "amass",
            "glb",
            "lafan",
            "mocap",
            "soma",
            "xsens_mocap",
        }:
            motion = _load_motion_file(path)
            loaded_dataset = dataset
        else:
            raise ValueError("the verified motion dataset has no production loader")
        if loaded_dataset != dataset:
            raise ValueError("the motion loader returned a different dataset identity")
        return motion

    def _agent_get_robot_model(spec: JobSpecV2) -> Any:
        bundle = app.state.agent_asset_service.get(spec.robot.asset_id)
        inspection = app.state.agent_asset_service.inspect(
            AssetInspectionRequest(
                asset_id=bundle.asset_id,
                verify_hashes=True,
                parse_content=True,
            )
        )
        if inspection.status is InspectionStatus.INVALID:
            if inspection.errors:
                raise AssetServiceError(inspection.errors[0])
            raise AssetServiceError(
                ApiError(
                    code="ASSET_INSPECTION_FAILED",
                    message="The robot bundle is not safe to materialize.",
                    stage=ErrorStage.ASSET_INSPECTION,
                    details={"asset_id": bundle.asset_id},
                )
            )
        yaml_files = [
            item
            for item in bundle.files
            if item.role is AssetFileRole.METADATA
            and (
                Path(item.relative_path).name == "robot.yaml"
                or (
                    Path(item.relative_path).name.startswith("robot.")
                    and Path(item.relative_path).suffix.casefold() == ".yaml"
                )
            )
        ]
        from hhtools.robot.loader import load_robot
        from hhtools.robot.registry import preset_from_yaml

        # Legacy robot loading intentionally repairs URDF/MuJoCo compatibility
        # files in place.  Agent assets are content-addressed, so materialize
        # the exact manifest into a per-job writable workspace and confine all
        # loader plus Interaction-Mesh fallback writes to that snapshot.
        workspace_parent = agent_data_dir / "temporary" / "robots"
        workspace_parent.mkdir(parents=True, exist_ok=True)
        workspace = tempfile.TemporaryDirectory(
            prefix="agent-robot-",
            dir=workspace_parent,
        )
        workspace_root = Path(workspace.name).resolve(strict=True)
        try:
            bundle_root = (workspace_root / spec.robot.robot_id).resolve()
            bundle_root.relative_to(workspace_root)
            bundle_root.mkdir(parents=True, exist_ok=False)
            for item in bundle.files:
                source = app.state.agent_asset_service.resolve_file(
                    bundle.asset_id,
                    item.relative_path,
                )
                target = bundle_root.joinpath(
                    *PurePosixPath(item.relative_path).parts
                ).resolve()
                target.relative_to(bundle_root)
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(source, target)
                with target.open("rb") as stream:
                    copied_sha256 = hashlib.file_digest(stream, "sha256").hexdigest()
                if (
                    copied_sha256 != item.sha256
                    or target.stat().st_size != item.size_bytes
                ):
                    raise ValueError(
                        "the robot workspace copy does not match its asset manifest"
                    )

            matching = []
            for item in yaml_files:
                yaml_path = bundle_root.joinpath(
                    *PurePosixPath(item.relative_path).parts
                ).resolve()
                yaml_path.relative_to(bundle_root)
                preset = preset_from_yaml(yaml_path)
                if preset.name == spec.robot.robot_id:
                    if preset.urdf_path is None:
                        raise ValueError("the robot snapshot has no declared URDF")
                    resolved_urdf = preset.urdf_path.resolve(strict=True)
                    resolved_urdf.relative_to(bundle_root)
                    if not resolved_urdf.is_file():
                        raise ValueError("the robot snapshot URDF is not a file")
                    for search_path in preset.mesh_search_paths:
                        resolved_search = search_path.resolve(strict=True)
                        resolved_search.relative_to(bundle_root)
                        if not resolved_search.is_dir():
                            raise ValueError(
                                "a robot mesh search path is not a snapshot directory"
                            )
                    metadata_yaml = Path(preset.meta["yaml_path"]).resolve(strict=True)
                    metadata_yaml.relative_to(bundle_root)
                    matching.append(preset)
            if len(matching) != 1:
                raise ValueError(
                    "the robot bundle does not contain one exact matching preset"
                )

            # This content identity is consumed only by internal
            # geometry/scaler caches.  It is never serialized and leaves
            # legacy Web presets intact.
            matching[0].meta["_agent_asset_id"] = spec.robot.asset_id
            with agent_robot_load_lock:
                model = load_robot(matching[0], compile_mjcf=True)
            setattr(model, "_agent_asset_workspace", workspace)
            return model
        except Exception:
            try:
                workspace.cleanup()
            except OSError:
                _log.warning("failed to clean Agent robot workspace", exc_info=True)
            raise

    def _agent_release_robot_model(model: Any) -> None:
        workspace = getattr(model, "_agent_asset_workspace", None)
        setattr(model, "_agent_asset_workspace", None)
        if workspace is not None:
            workspace.cleanup()

    def _agent_run_retarget(
        model: Any,
        robot_id: str,
        motion: Any,
        reference: str,
        backend: str,
        ik_iterations: int,
        human_height: float,
        limit_frames: int | None,
        progress_job: Any,
        *,
        foot_clamp_anti_penetration: bool,
    ) -> Any:
        return _retarget_single(
            model,
            robot_id,
            motion,
            reference,
            backend,
            ik_iterations,
            human_height,
            limit_frames,
            progress_job,
            state=None,
            foot_clamp_anti_penetration=foot_clamp_anti_penetration,
            preset=model.preset,
        )

    def _agent_build_preview(
        model: Any,
        robot_id: str,
        motion: Any,
        reference: str,
        human_height: float,
        retargeted: Any,
    ) -> H2RPreview:
        from hhtools.web.result_diagnostics import build_result_diagnostics
        from hhtools.web.serialize import (
            _scaled_overlay_foot_z,
            serialize_robot_trajectory,
        )

        scaled = _compute_scaled_preview(
            model,
            robot_id,
            motion,
            reference,
            human_height,
            max_frames=agent_preview_max_frames,
        )
        trajectory = serialize_robot_trajectory(
            model,
            retargeted,
            scaled_preview=scaled,
            max_frames=agent_preview_max_frames,
        )
        scaled = _align_scaled_preview_to_robot_playback(
            model,
            retargeted,
            scaled,
            trajectory,
        )
        diagnostics = build_result_diagnostics(
            trajectory,
            scaled,
            ik_map=model.preset.ik_map,
            feet=model.preset.feet,
        )
        scaled_scene = _compute_scaled_scene(
            model,
            robot_id,
            motion,
            reference,
            human_height,
            max_frames=agent_preview_max_frames,
        )
        return H2RPreview(
            document={
                "trajectory": trajectory,
                "scaled_preview": scaled,
                "scaled_scene": scaled_scene,
                "diagnostics": diagnostics,
            },
            diagnostics=diagnostics,
            yellow_foot_z=_scaled_overlay_foot_z(scaled, 0),
        )

    def _agent_write_export(
        retargeted: Any,
        model: Any,
        source_motion: Any,
        output_root: Path,
        *,
        stem: str,
        output_format: str,
        backend: str,
        source_path: Path,
        yellow_foot_z: float | None,
    ) -> Path:
        return Path(
            _write_export(
                retargeted,
                model,
                source_motion,
                output_root,
                stem=stem,
                fps=None,
                fmt=output_format,
                backend=backend,
                csv_header=True,
                source_path=source_path,
                yellow_foot_z=yellow_foot_z,
            )
        )

    agent_executor = H2RJobExecutor(
        H2RExecutorBindings(
            validate_spec=_agent_validate_spec,
            resolve_motion=_agent_resolve_motion,
            load_motion=_agent_load_motion,
            ground_motion=_ground_motion_for_web,
            prepare_motion=_motion_for_retarget,
            get_robot_model=_agent_get_robot_model,
            run_retarget=_agent_run_retarget,
            build_preview=_agent_build_preview,
            write_export=_agent_write_export,
            release_robot_model=_agent_release_robot_model,
        ),
        temporary_root=agent_data_dir / "temporary",
    )
    app.state.agent_job_manager = JobManager(
        app.state.agent_job_store,
        app.state.agent_artifact_store,
        app.state.agent_retarget_service,
        scheduler,
        executor=agent_executor,
    )
    app.state.agent_artifact_export_service = ArtifactExportService(
        app.state.agent_job_manager,
        state.save_dir / "agent-exports",
    )
    app.state.agent_capabilities_service = CapabilitiesService(
        scheduler_snapshot=scheduler.snapshot,
        asset_root_provider=lambda: app.state.agent_asset_service.allowed_root_ids,
        preflight_available=True,
        artifact_store_available=True,
        job_manager_available=True,
        job_execution_available=app.state.agent_job_manager.execution_available,
        mcp_available=agent_mcp_available,
        agent_rest_available=agent_rest_available,
        json_cli_available=agent_json_cli_available,
    )
    app.state.agent_preflight_service = PreflightService(
        app.state.agent_asset_service,
        app.state.agent_plan_store,
        capabilities_provider=app.state.agent_capabilities_service.get_capabilities,
    )
    # Phase 4's REST/JSON-CLI adapters call this exact transport-neutral
    # service instance; they do not reimplement path migration or construct
    # JobSpec v2 directly.
    app.state.agent_legacy_job_upgrade_service = LegacyJobUpgradeService(
        app.state.agent_asset_service,
        app.state.agent_preflight_service,
        app.state.agent_retarget_service,
        app.state.agent_legacy_root_locator,
    )
    app.include_router(agent_router)

    def _render_index_html() -> str:
        raw = (static_dir / "index.html").read_text(encoding="utf-8")
        return raw.replace("{{UI_BUILD}}", UI_BUILD_ID)

    @app.get("/")
    @app.get("/index.html")
    def serve_index():
        return HTMLResponse(
            _render_index_html(),
            headers={"Cache-Control": "no-store, must-revalidate", "Pragma": "no-cache"},
        )

    @app.middleware("http")
    async def _reject_oversized_upload_requests(request, call_next):  # type: ignore[no-untyped-def]
        """Reject normal browser multipart requests before Starlette parses their files."""
        if request.method == "POST" and request.url.path in _UPLOAD_ENDPOINTS:
            content_length = request.headers.get("content-length")
            if content_length is not None:
                try:
                    request_bytes = int(content_length)
                except ValueError:
                    return JSONResponse({"detail": "Invalid Content-Length"}, status_code=400)
                if request_bytes > max_upload_request_bytes:
                    return JSONResponse(
                        {
                            "detail": (
                                "upload request exceeds "
                                f"{max_upload_request_bytes} bytes"
                            )
                        },
                        status_code=413,
                    )
        return await call_next(request)

    def _desktop_guard_failure(
        request: Request,
        *,
        status_code: int,
        code: str,
        message: str,
        legacy_detail: str,
    ) -> JSONResponse:
        if is_agent_path(request.url.path):
            return agent_error_response(
                status_code=status_code,
                code=code,
                message=message,
            )
        return JSONResponse({"detail": legacy_detail}, status_code=status_code)

    @app.middleware("http")
    async def _desktop_request_guard(request, call_next):  # type: ignore[no-untyped-def]
        """Protect the localhost API when it is hosted inside Electron.

        Browser mode leaves ``desktop_session_secret`` unset and keeps its original behavior.
        Desktop mode requires the per-launch secret on every request; exact Host and Origin checks
        add defense against DNS rebinding and requests from unrelated local pages.
        """
        if desktop_session_secret is not None:
            host = request.headers.get("host", "")
            if desktop_allowed_host is not None and host.lower() != desktop_allowed_host.lower():
                return _desktop_guard_failure(
                    request,
                    status_code=400,
                    code="INVALID_DESKTOP_HOST",
                    message="The desktop Agent request used an unexpected Host.",
                    legacy_detail="Invalid desktop host",
                )

            supplied_secret = request.headers.get("x-hhtools-session", "")
            if not hmac.compare_digest(supplied_secret, desktop_session_secret):
                return _desktop_guard_failure(
                    request,
                    status_code=401,
                    code="INVALID_DESKTOP_SESSION",
                    message="The desktop Agent session is invalid.",
                    legacy_detail="Invalid desktop session",
                )

            origin = request.headers.get("origin")
            if (
                origin is not None
                and desktop_allowed_origin is not None
                and origin != desktop_allowed_origin
            ):
                return _desktop_guard_failure(
                    request,
                    status_code=403,
                    code="INVALID_DESKTOP_ORIGIN",
                    message="The desktop Agent origin is invalid.",
                    legacy_detail="Invalid desktop origin",
                )

        response = await call_next(request)
        if desktop_session_secret is not None:
            response.headers["Content-Security-Policy"] = (
                "default-src 'self'; "
                "script-src 'self' 'unsafe-inline'; "
                "style-src 'self' 'unsafe-inline'; "
                "img-src 'self' blob: data:; "
                "media-src 'self' blob: data:; "
                "connect-src 'self'; "
                "worker-src 'self' blob:; "
                "object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
            )
            response.headers["X-Content-Type-Options"] = "nosniff"
            response.headers["X-Frame-Options"] = "DENY"
            response.headers["Referrer-Policy"] = "no-referrer"
        return response

    @app.middleware("http")
    async def _no_cache_ui_assets(request, call_next):  # type: ignore[no-untyped-def]
        response = await call_next(request)
        path = request.url.path
        if path == "/" or path.endswith((".html", ".js", ".css")):
            response.headers["Cache-Control"] = "no-store, must-revalidate"
            response.headers["Pragma"] = "no-cache"
        return response

    # ----------------------------------------------------------------- meta

    @app.get("/api/health")
    def health() -> dict:
        index = static_dir / "index.html"
        index_snip = index.read_text(encoding="utf-8")[:8000] if index.is_file() else ""
        vue_renderer = 'id="app-root"' in index_snip
        return {
            "ok": True,
            "ui_build": UI_BUILD_ID,
            "static_dir": str(static_dir.resolve()),
            "ui_features": {
                "merged_robot_panel": vue_renderer or "data-panel=\"retarget\"" not in index_snip,
                "view_hud": vue_renderer or "view-hud" in index_snip,
                "scaled_skeleton_toggle": vue_renderer or "tg-scaled" in index_snip,
                "recalib_button": vue_renderer or "recalib-btn" in index_snip,
            },
            "source_root": str(state.source_root),
            "save_dir": str(state.save_dir),
            "motions_library_root": str(motions_library_root()),
            "job_scheduler": _scheduler_payload(),
        }

    @app.get("/api/settings/job-admission")
    def get_job_admission_settings(request: Request) -> dict[str, int | bool | str]:
        """Return live scheduler settings, counters, and edit capability."""

        return _scheduler_payload(editable=_job_settings_editable(request))

    @app.patch("/api/settings/job-admission")
    def patch_job_admission_settings(
        payload: dict[str, Any],
        request: Request,
    ) -> dict[str, int | bool | str]:
        """Persist and hot-apply job limits without stopping active work."""

        if not _job_settings_editable(request):
            # Browser mode has no administrator authentication yet.  Keep this
            # persistent, resource-affecting mutation local; SSH loopback tunnels
            # and the authenticated Electron sidecar still satisfy this boundary.
            # Requiring a literal loopback Host also blocks DNS-rebinding pages.
            raise HTTPException(
                status_code=403,
                detail="job admission settings can only be changed from a loopback client",
            )

        # Serialize the complete read/validate/write/apply transaction so two
        # settings tabs cannot leave the JSON file and live scheduler disagreeing.
        with job_settings_update_lock:
            snapshot = scheduler.snapshot()
            current = JobAdmissionSettings(
                max_running_jobs=snapshot.max_running_jobs,
                max_queued_jobs=snapshot.max_queued_jobs,
            )
            try:
                updated = updated_job_admission_settings(current, payload)
            except ValueError as err:
                raise HTTPException(status_code=422, detail=str(err)) from err

            # Persist first: if the filesystem rejects the write, the live runtime
            # remains unchanged and the UI can truthfully report that Save failed.
            if job_settings_store is not None:
                try:
                    job_settings_store.save(updated)
                except OSError as err:
                    _log.exception("failed to persist Web job admission settings")
                    raise HTTPException(
                        status_code=500,
                        detail="failed to persist job admission settings",
                    ) from err
            try:
                scheduler.reconfigure(
                    max_running_jobs=updated.max_running_jobs,
                    max_queued_jobs=updated.max_queued_jobs,
                )
            except JobSchedulerClosedError as err:
                raise HTTPException(status_code=503, detail=str(err)) from err
            return _scheduler_payload(editable=True)

    def _motion_library_settings_payload(
        request: Request,
    ) -> dict[str, str | bool | None]:
        settings = motion_library_settings_store.load()
        environment_override = bool(os.environ.get(HHTOOLS_MOTION_LIBRARY_ROOT_ENV))
        local_request = _job_settings_editable(request)
        editable = local_request and not environment_override
        readonly_reason: str | None = None
        if not editable:
            readonly_reason = "environment_override" if environment_override else "remote"
        return {
            "root": str(effective_motion_library_root(settings)),
            "default_root": str(user_motion_library_root().expanduser().resolve(strict=False)),
            # An environment override is an administrator-owned launch setting;
            # writing a lower-priority JSON value would misleadingly appear to
            # succeed while leaving the effective root unchanged.
            "editable": editable,
            "readonly_reason": readonly_reason,
        }

    @app.get("/api/settings/motion-library")
    def get_motion_library_settings(request: Request) -> dict[str, str | bool | None]:
        """Return the effective server-side Motion Library root."""

        return _motion_library_settings_payload(request)

    @app.patch("/api/settings/motion-library")
    def patch_motion_library_settings(
        payload: dict[str, Any],
        request: Request,
    ) -> dict[str, str | bool | None]:
        """Persist and hot-apply a dedicated managed library directory."""

        if not _job_settings_editable(request):
            raise HTTPException(
                status_code=403,
                detail="motion library settings can only be changed from a loopback client",
            )
        if os.environ.get(HHTOOLS_MOTION_LIBRARY_ROOT_ENV):
            raise HTTPException(
                status_code=409,
                detail=(
                    "HHTOOLS_MOTION_LIBRARY_ROOT overrides the saved directory; "
                    "change or remove that environment setting first"
                ),
            )

        # Switching the resolver while another thread publishes or scans a
        # library would split one operation across two roots. The same lock used
        # for materialization makes validation, persistence, and the next scan
        # observe one complete root selection.
        with motion_library_publish_lock:
            current = motion_library_settings_store.load()
            try:
                updated = updated_motion_library_settings(current, payload)
                selected_root = effective_motion_library_root(updated)
                current_root = motions_library_root()
                default_root = user_motion_library_root().expanduser().resolve(strict=False)
                if selected_root != current_root:
                    # Mark the root we are leaving before changing the resolver.
                    # This preserves a safe return path even if platform-default
                    # discovery changes while the custom root is active.
                    _adopt_motion_library_root(
                        current_root,
                        current_root=current_root,
                    )
                _adopt_motion_library_root(
                    selected_root,
                    current_root=current_root,
                    # The default/legacy location is owned by hhtools even when
                    # it predates ownership markers. Trust it once so a populated
                    # library can safely round-trip default -> custom -> default;
                    # adoption writes the canonical marker before saving.
                    trusted_roots=(default_root,),
                )
                motion_library_settings_store.save(updated)
            except ValueError as err:
                raise HTTPException(status_code=422, detail=str(err)) from err
            except OSError as err:
                _log.exception("failed to persist Motion Library settings")
                raise HTTPException(
                    status_code=500,
                    detail="failed to persist Motion Library settings",
                ) from err
        return _motion_library_settings_payload(request)

    @app.get("/api/formats")
    def formats() -> dict:
        from hhtools.io.base import registered_loader_extensions

        exts = registered_loader_extensions()
        # Datasets that require sidecar geometry.
        return {
            "file_formats": [
                {"ext": ".bvh", "label": "BVH mocap", "needs": None},
                {"ext": ".glb", "label": "glTF / GLB (skinned)", "needs": None},
                {"ext": ".gltf", "label": "glTF", "needs": None},
                {"ext": ".npz", "label": "hhtools unified NPZ", "needs": None},
            ],
            "dataset_formats": [
                {"ext": ".npz", "label": "AMASS / SMPL-H,X poses", "needs": "smpl-weights"},
                {"ext": ".npy", "label": "Motion-X / holosoma", "needs": "smpl / terrain.obj"},
                {"ext": ".pkl", "label": "OMOMO (interaction)", "needs": "object .obj sidecar"},
                {"ext": ".bvh", "label": "OmniContact (HOI mocap)", "needs": "object CSV + optional assets/"},
                {"ext": ".pt", "label": "GVHMR", "needs": "smpl-weights"},
            ],
            "registered_loaders": exts,
        }

    # ----------------------------------------------------------------- library

    @app.get("/api/library")
    def library(source: str | None = None) -> dict:
        from hhtools.viewer.library import scan_library
        from hhtools.web.motion_library_links import scan_motions_library

        root = Path(source) if source else state.source_root
        merged: list[dict] = []
        seen: set[str] = set()
        for e in scan_library(root):
            row = _enrich_basket_entry({
                "dataset": e.dataset,
                "folder_label": e.folder_label,
                "sequence_id": e.sequence_id,
                "stem": e.stem,
                "source_path": str(e.source_path),
                "label": e.display_label,
                "origin": "assets",
            })
            seen.add(row["source_path"])
            merged.append(row)
        # Avoid observing a half-copied same-process publish.  The filesystem
        # namespace is still only process-local; multi-worker deployments need
        # a cross-process file lock before they can offer this guarantee.
        with motion_library_publish_lock:
            lib_root = motions_library_root()
            motion_entries = scan_motions_library(lib_root)
        for raw in motion_entries:
            sp = str(raw.get("source_path") or "")
            if not sp or sp in seen:
                continue
            seen.add(sp)
            merged.append(_enrich_basket_entry(raw))
        merged.sort(
            key=lambda row: (
                str(row.get("folder_label") or "").lower(),
                str(row.get("stem") or "").lower(),
            ),
        )
        folders: list[str] = []
        for row in merged:
            label = str(row.get("folder_label") or "")
            if label and label not in folders:
                folders.append(label)
        return {
            "source_root": str(root),
            "motions_library_root": str(lib_root),
            "folders": folders,
            "entries": merged,
        }

    @app.post("/api/library/link")
    def library_link(body: dict) -> dict:
        from hhtools.web.motion_library_links import link_to_library, scan_motions_library

        path = str(body.get("path") or "").strip()
        folder_label = str(body.get("folder_label") or "").strip() or None
        if not path:
            raise HTTPException(status_code=400, detail="需要 path")
        with motion_library_publish_lock:
            lib_root = motions_library_root()
            dest = link_to_library(
                path,
                folder_label=folder_label,
                library_root=lib_root,
            )
            entries = [
                entry
                for entry in scan_motions_library(lib_root)
                if entry.get("folder_label") == dest.name
            ]
        return {
            "folder_label": dest.name,
            "kind": "directory",
            "clip_count": len(entries),
            "path": str(dest),
            "motions_library_root": str(lib_root),
        }

    @app.delete("/api/library/link/{folder_label}")
    def library_unlink(folder_label: str) -> dict:
        from hhtools.web.motion_library_links import remove_library_folder

        with motion_library_publish_lock:
            removed = remove_library_folder(folder_label)
        if not removed:
            raise HTTPException(status_code=404, detail="link not found")
        return {"removed": folder_label}

    # --------------------------------------------------- dataset analysis (viz)

    def _run_dataset_analyze_job(job: Job, body: dict) -> None:
        try:
            from hhtools.web import dataset_analysis as _da

            root = Path(body.get("source") or state.source_root)
            embedding = str(body.get("embedding") or "handcrafted")
            force = bool(body.get("force", False))

            def cb(frac: float, msg: str) -> None:
                job.progress = float(max(0.0, min(1.0, frac)))
                job.message = msg

            job.message = "扫描数据集…"
            payload = _da.run_analysis(
                root,
                state.save_dir,
                embedding=embedding,
                force=force,
                progress=cb,
            )
            job.result = payload
            job.progress = 1.0
            job.mark_terminal("done")
        except Exception as err:  # noqa: BLE001
            _log.exception("dataset analyze job failed")
            job.error = str(err)
            job.mark_terminal("error")

    @app.post("/api/dataset/analyze")
    async def dataset_analyze(body: dict) -> dict:
        job = _schedule_job(
            "dataset_analyze", body, _run_dataset_analyze_job, args=(body,),
        )
        return {"job_id": job.id}

    @app.get("/api/dataset/result")
    def dataset_result(source: str | None = None, embedding: str = "handcrafted") -> dict:
        from hhtools.web import dataset_analysis as _da

        root = Path(source) if source else state.source_root
        entries = _da.build_entries(root)
        cached = _da.load_cached(root, state.save_dir, embedding, entries)
        if cached is None:
            return {"available": False, "source_root": str(root)}
        return {"available": True, **cached}

    @app.post("/api/dataset/subset")
    def dataset_subset(body: dict) -> dict:
        from hhtools.web import dataset_analysis as _da

        clips = body.get("clips") or []
        k = int(body.get("k", 0))
        alpha = float(body.get("alpha", 0.99))
        selected = _da.compute_subset(clips, k, alpha)
        return {"selected": selected, "count": len(selected)}

    @app.get("/api/dataset/catalog")
    def dataset_catalog() -> dict:
        from hhtools.analysis.catalog import load_catalog

        return load_catalog()

    @app.post("/api/dataset/upload")
    async def dataset_upload(
        files: list[UploadFile] = File(...),
        append_to: str | None = None,
        user_source_root: str | None = None,
    ) -> dict:
        """Accept a folder drop for batch analysis (preserves relative paths).

        Pass ``append_to`` (a prior ``source`` path from this endpoint) to merge
        multiple drag-and-drop batches into one analysis basket.
        """
        from hhtools.web import dataset_analysis as _da

        dataset_root = (state.upload_root / "dataset").resolve()
        dataset_root.mkdir(parents=True, exist_ok=True)
        if append_to:
            drop = Path(append_to).resolve()
            try:
                drop.relative_to(dataset_root)
            except ValueError as err:
                raise HTTPException(status_code=400, detail="invalid append_to") from err
            if not drop.is_dir():
                raise HTTPException(status_code=400, detail="append target missing")
        else:
            drop = dataset_root / uuid.uuid4().hex[:8]
            drop.mkdir(parents=True, exist_ok=True)
        stored = await _store_uploads(files, drop)
        if not stored:
            raise HTTPException(status_code=400, detail="empty upload")
        hint_root = str(user_source_root or "").strip()
        if hint_root:
            _da.save_upload_source_hint(drop, hint_root)
        summary = _da.scan_upload_summary(drop)
        return summary

    @app.post("/api/dataset/scan")
    def dataset_scan(body: dict) -> dict:
        """Scan a server-local directory without copying files into /tmp."""
        from hhtools.web import dataset_analysis as _da

        raw = str(body.get("source") or "").strip()
        if not raw:
            raise HTTPException(status_code=400, detail="请填写本机目录路径")
        root = Path(raw).expanduser()
        if not root.is_dir():
            raise HTTPException(status_code=400, detail=f"目录不存在：{root}")
        return _da.scan_upload_summary(root.resolve())

    @app.post("/api/dataset/upload/remove")
    async def dataset_upload_remove(body: dict) -> dict:
        from hhtools.web import dataset_analysis as _da

        source = str(body.get("source") or "").strip()
        folder_label = str(body.get("folder_label") or "").strip()
        if not source:
            raise HTTPException(status_code=400, detail="missing source")
        if not folder_label:
            raise HTTPException(status_code=400, detail="missing folder_label")
        drop = Path(source).resolve()
        dataset_root = (state.upload_root / "dataset").resolve()
        try:
            drop.relative_to(dataset_root)
        except ValueError as err:
            raise HTTPException(status_code=400, detail="invalid source") from err
        try:
            return _da.remove_upload_folder(drop, folder_label)
        except FileNotFoundError as err:
            raise HTTPException(status_code=404, detail=str(err)) from err
        except ValueError as err:
            raise HTTPException(status_code=400, detail=str(err)) from err

    @app.post("/api/dataset/export_manifest")
    def dataset_export_manifest(body: dict):
        from fastapi.responses import Response

        from hhtools.web import dataset_analysis as _da

        clips = body.get("clips") or []
        ids = body.get("ids") or []
        fmt = str(body.get("format") or "json").lower()
        analyze_source = str(body.get("analyze_source") or "").strip() or None
        user_source_root = str(body.get("user_source_root") or "").strip() or None
        if not user_source_root and analyze_source:
            user_source_root = _da.read_upload_source_hint(analyze_source)
        if fmt == "csv":
            text = _da.export_manifest_csv(
                clips,
                ids,
                analyze_source=analyze_source,
                user_source_root=user_source_root,
            )
            return Response(
                content=text,
                media_type="text/csv; charset=utf-8",
                headers={
                    "Content-Disposition": "attachment; filename=dataset_manifest.csv"
                },
            )
        text = _da.export_manifest(
            clips,
            ids,
            analyze_source=analyze_source,
            user_source_root=user_source_root,
        )
        return Response(
            content=text,
            media_type="application/json",
            headers={
                "Content-Disposition": "attachment; filename=dataset_manifest.json"
            },
        )

    @app.post("/api/dataset/export_robot_zip")
    def dataset_export_robot_zip(body: dict):
        """ZIP selected robot clip folders (trajectory CSV + terrain/object sidecars)."""
        from fastapi.responses import FileResponse

        from hhtools.web import dataset_analysis as _da

        clips = body.get("clips") or []
        ids = body.get("ids") or []
        if not ids:
            raise HTTPException(status_code=400, detail="ids required")
        id_set = set(ids)
        allowed = [
            state.source_root,
            state.upload_root,
            state.upload_root / "dataset",
        ]
        for c in clips:
            if c.get("clip_id") not in id_set:
                continue
            sp = c.get("source_path")
            if sp:
                allowed.append(Path(sp).resolve().parent)
        drop = state.save_dir / "dataset_exports"
        drop.mkdir(parents=True, exist_ok=True)
        try:
            zip_path, stats = _da.export_robot_clips_zip(
                clips,
                ids,
                drop,
                zip_stem="robot_subset_export",
                allowed_roots=allowed,
            )
        except FileNotFoundError as err:
            raise HTTPException(status_code=404, detail=str(err)) from err
        except PermissionError as err:
            raise HTTPException(status_code=403, detail=str(err)) from err
        except ValueError as err:
            raise HTTPException(status_code=400, detail=str(err)) from err
        return FileResponse(
            zip_path,
            filename=stats["zip_name"],
            media_type="application/zip",
        )

    @app.post("/api/dataset/preview_robot")
    async def dataset_preview_robot(body: dict) -> dict:
        """Load a robot export CSV for mesh playback (dataset viz scatter preview)."""
        if not body.get("source_path"):
            raise HTTPException(status_code=400, detail="source_path required")
        job = _schedule_job(
            "dataset_robot_preview",
            body,
            _run_dataset_robot_preview_job,
            args=(body, state),
        )
        return {"job_id": job.id}

    @app.get("/api/dataset/scene_glb")
    def dataset_scene_glb(token: str, mesh: str) -> Response:
        """Serve object mesh from a dataset robot-preview clip folder."""
        from types import SimpleNamespace

        from hhtools.web.serialize import object_mesh_glb

        rec = state.dataset_previews.get(token)
        if rec is None:
            raise HTTPException(status_code=404, detail="preview token not found")
        clip_dir = Path(rec.get("clip_dir") or Path(rec["source_path"]).parent)
        safe = Path(mesh).name
        path = (clip_dir / safe).resolve()
        if not path.is_file() or clip_dir.resolve() not in path.parents:
            raise HTTPException(status_code=404, detail="mesh not found")
        glb = object_mesh_glb(SimpleNamespace(mesh_path=str(path), scale=1.0))
        if glb is None:
            raise HTTPException(status_code=404, detail="mesh export failed")
        return Response(content=glb, media_type="model/gltf-binary")

    # ----------------------------------------------------------------- motion

    def _suggest_reference(
        motion,
        dataset: str | None,
        *,
        source_path: Path | None = None,
    ) -> str:
        if source_path is not None:
            from hhtools.io.mimic_detect import infer_mimic_dataset

            bone_names = (
                motion.hierarchy.bone_names
                if str(motion.source_format) == "bvh"
                else None
            )
            dataset = infer_mimic_dataset(source_path, bone_names=bone_names)
            if dataset == "omnicontact":
                from hhtools.io.bvh_detect import infer_bvh_dataset_from_joints

                detected = infer_bvh_dataset_from_joints(motion.hierarchy.bone_names)
                if detected and detected in _DATASET_TO_REFERENCE:
                    return _DATASET_TO_REFERENCE[detected]
        elif str(motion.source_format) == "bvh":
            from hhtools.io.bvh_detect import infer_bvh_dataset_from_joints

            detected = infer_bvh_dataset_from_joints(motion.hierarchy.bone_names)
            if detected:
                dataset = detected
        if dataset and dataset in _DATASET_TO_REFERENCE:
            return _DATASET_TO_REFERENCE[dataset]
        return _FORMAT_TO_REFERENCE.get(str(motion.source_format), "smpl")

    def _register_motion(
        motion,
        dataset: str | None,
        origin: str,
        *,
        library_entry: dict | None = None,
        job: Job | None = None,
        extra: dict | None = None,
    ) -> dict:
        from hhtools.web.serialize import serialize_motion

        ground_cb = None
        if job is not None:
            from hhtools.web.motion_progress import MotionLoadProgress

            ground_cb = MotionLoadProgress(job, base=0.42, span=0.13).as_callback()
            ground_cb(0.0, "对齐地面与坐标…")

        # Ground + centre the clip ONCE so the visualization, retarget input
        # and any export all share the same source frame (the user wants
        # "保存时以可视化看到的为来源").  Mirrors the Viser viewer defaults.
        motion = _ground_motion_for_web(motion)
        if ground_cb is not None:
            ground_cb(1.0, "地面对齐完成")

        token = uuid.uuid4().hex[:12]
        src_path: Path | None = None
        if library_entry is not None and library_entry.get("source_path"):
            src_path = Path(library_entry["source_path"])
        elif extra:
            picked = extra.get("picked") or (extra.get("upload_info") or {}).get("picked")
            if picked:
                src_path = Path(picked)
        ref = _suggest_reference(motion, dataset, source_path=src_path)
        motion_rec: dict = {"motion": motion, "reference": ref, "origin": origin}
        if library_entry is not None and library_entry.get("source_path"):
            motion_rec["source_path"] = library_entry["source_path"]
            motion_rec["library_entry"] = _snapshot_job_request(library_entry)
        state.motions[token] = motion_rec

        ser_cb = None
        if job is not None:
            from hhtools.web.motion_progress import MotionLoadProgress

            ser_cb = MotionLoadProgress(job, base=0.55, span=0.17).as_callback()

        payload = serialize_motion(motion, progress_callback=ser_cb)
        payload["token"] = token
        payload["suggested_reference"] = ref
        payload["dataset"] = dataset
        payload["origin"] = origin
        if library_entry is not None:
            payload["library_entry"] = library_entry
        if extra:
            payload.update(extra)
        # Hint the front-end which retarget backend fits this clip: anything
        # with terrain / interaction objects defaults to interaction-mesh.
        has_scene = bool(motion.terrain is not None or motion.objects)
        payload["suggested_backend"] = "interaction_mesh" if has_scene else "newton"

        if job is not None:
            job.message = "完成"
            job.progress = 1.0
        return payload

    def _run_motion_library_job(job: Job, body: dict) -> None:
        from hhtools.web.motion_progress import MotionLoadProgress
        from hhtools.web.r2r_upload_resolve import _is_robot_export_trajectory

        try:
            from hhtools.web.motion_library_links import library_entry_for_load

            entry = library_entry_for_load(
                dataset=body["dataset"],
                folder_label=body["folder_label"],
                sequence_id=body["sequence_id"],
                source_path=body["source_path"],
            )
            load_prog = MotionLoadProgress(job, base=0.08, span=0.34)
            source_path = entry.source_path
            if body.get("dataset") == "robot" or _is_robot_export_trajectory(source_path):
                motion = _load_robot_export_for_web(
                    source_path, state, progress=load_prog,
                )
                dataset_label = "robot"
            else:
                motion = _load_motion_for_web(
                    entry, state.cache, progress=load_prog,
                )
                dataset_label = entry.dataset
            payload = _register_motion(
                motion,
                dataset_label,
                "library",
                library_entry=_enrich_basket_entry({
                    "dataset": dataset_label,
                    "folder_label": entry.folder_label,
                    "sequence_id": entry.sequence_id,
                    "source_path": str(entry.source_path),
                    "stem": entry.stem,
                }),
                job=job,
            )
            job.result = payload
            job.mark_terminal("done")
        except Exception as err:  # noqa: BLE001
            _log.exception("motion library job failed")
            job.error = str(err)
            job.mark_terminal("error")

    def _run_basket_upload_job(job: Job, drop: Path, profile: str) -> None:
        from hhtools.web.upload_resolve import (
            enumerate_upload_clips,
            upload_validation_error,
        )

        try:
            clips = enumerate_upload_clips(drop, profile)
            if not clips:
                raise ValueError(upload_validation_error(profile))
            entries = []
            for i, ref in enumerate(clips):
                job.progress = i / max(1, len(clips))
                job.message = f"解析 {i + 1}/{len(clips)}: {ref.path.name}"
                entry = _library_entry_from_upload(
                    drop,
                    ref.path,
                    ref.dataset,
                    ref.profile,
                    upload_profile=ref.profile,
                    clip_kind=ref.clip_kind,
                )
                entries.append(entry)
            job.result = {
                "entries": entries,
                "clip_count": len(entries),
                "upload_root": str(drop),
            }
            job.progress = 1.0
            job.message = f"已加入 {len(entries)} 个 clip"
            job.mark_terminal("done")
        except Exception as err:  # noqa: BLE001
            _log.exception("basket upload job failed")
            job.error = str(err)
            job.mark_terminal("error")

    def _run_motion_library_dir_job(
        job: Job,
        drop: Path,
        relative_paths: list[str],
        folder_label_hint: str | None,
        profile: str,
        prefer_paths: list[str] | None = None,
    ) -> None:
        from hhtools.web.motion_library_links import materialize_drop
        from hhtools.web.motion_progress import MotionLoadProgress
        from hhtools.web.upload_resolve import resolve_upload_drop

        try:
            load_prog = MotionLoadProgress(job, base=0.08, span=0.34)
            motion, dataset, info = resolve_upload_drop(
                # Never parse through the mutable library label.  A later
                # same-label upload may replace it while this job is pending.
                drop,
                profile,
                load_motion_file=_load_motion_file,
                load_via_adapter=_load_via_adapter,
                progress=load_prog,
                prefer_paths=prefer_paths,
            )
            snapshot_picked = Path(info.get("picked", drop))
            with motion_library_publish_lock:
                lib_dir, folder_label, materialize_mode = materialize_drop(
                    relative_paths,
                    folder_label=folder_label_hint,
                    upload_drop=drop,
                )
                library_picked = _matching_materialized_clip(
                    lib_dir,
                    snapshot_root=drop,
                    snapshot_picked=snapshot_picked,
                    profile=profile,
                )
                library_entry = _library_entry_from_link(
                    folder_label, lib_dir, library_picked, dataset,
                )
                # The request is persisted as soon as it is admitted, when a
                # single-file upload may not yet have an inferred label and no
                # materialisation mode exists.  Replace the snapshot after the
                # atomic publish step so history/restart diagnostics retain the
                # actual library destination instead of the original hint.
                job.request = {
                    **job.request,
                    "folder_label": folder_label,
                    "materialize_mode": materialize_mode,
                }
            # Persist the publication metadata before the potentially long
            # grounding/serialization phase.  A process interruption after
            # library publication must not leave history pointing only at the
            # original label hint.
            _persist_job(job)
            payload = _register_motion(
                motion,
                dataset,
                "link",
                library_entry=library_entry,
                job=job,
                extra={
                    "upload_info": info,
                    "linked_folder": folder_label,
                    "materialize_mode": materialize_mode,
                },
            )
            job.result = payload
            job.mark_terminal("done")
        except Exception as err:  # noqa: BLE001
            _log.exception("motion library dir job failed")
            job.error = str(err)
            job.mark_terminal("error")

    def _run_gvhmr_video_job(
        job: Job,
        drop: Path,
        video_path: Path,
        checkpoint_path: Path | None,
        static_cam: bool,
        f_mm: int | None,
    ) -> None:
        """Convert one uploaded video with the isolated official GVHMR runtime."""

        from hhtools.integrations.gvhmr import GvhmrConfig, run_gvhmr
        from hhtools.web.motion_library_links import materialize_drop
        from hhtools.web.motion_progress import MotionLoadProgress
        from hhtools.web.upload_resolve import load_clip_at_path

        try:
            config = GvhmrConfig.from_environment()
            # GVHMR and hhtools can use the same licensed SMPL-X directory. An
            # explicit hhtools override always wins; this only supplies the
            # integration default for the generated .pt adapter.
            os.environ.setdefault(
                "HHTOOLS_BODY_MODELS", str(config.body_models_root),
            )

            def inference_progress(fraction: float, message: str) -> None:
                job.progress = 0.03 + 0.67 * max(0.0, min(1.0, fraction))
                job.message = message
                _persist_job(job)

            result_path = run_gvhmr(
                video_path,
                drop,
                checkpoint_path=checkpoint_path,
                static_cam=static_cam,
                f_mm=f_mm,
                config=config,
                progress=inference_progress,
            )

            job.progress = 0.72
            job.message = "正在转换 GVHMR 参数为 hhtools Motion…"
            load_progress = MotionLoadProgress(job, base=0.72, span=0.13)
            motion, dataset = load_clip_at_path(
                result_path,
                "mimic",
                load_motion_file=_load_motion_file,
                load_via_adapter=_load_via_adapter,
                progress=load_progress,
            )

            relative_result = result_path.resolve().relative_to(drop.resolve())
            folder_label_hint = _safe_upload_directory_name(
                f"gvhmr-{video_path.stem}",
                default=f"gvhmr-{job.id}",
            )
            job.progress = 0.87
            job.message = "正在发布到 Motion Library…"
            with motion_library_publish_lock:
                lib_dir, folder_label, materialize_mode = materialize_drop(
                    [relative_result.as_posix()],
                    folder_label=folder_label_hint,
                    upload_drop=drop,
                )
                library_picked = _matching_materialized_clip(
                    lib_dir,
                    snapshot_root=drop,
                    snapshot_picked=result_path,
                    profile="mimic",
                )
                library_entry = _library_entry_from_link(
                    folder_label,
                    lib_dir,
                    library_picked,
                    dataset or "gvhmr",
                )

            job.progress = 0.93
            job.message = "正在构建动作预览…"
            payload = _register_motion(
                motion,
                dataset or "gvhmr",
                "gvhmr",
                library_entry=library_entry,
                extra={
                    "video_name": video_path.name,
                    "gvhmr_checkpoint": (
                        checkpoint_path.name if checkpoint_path else "official"
                    ),
                    "gvhmr_static_cam": static_cam,
                    "materialize_mode": materialize_mode,
                    "linked_folder": folder_label,
                },
            )
            job.result = payload
            job.progress = 1.0
            job.message = "视频动作生成完成"
            job.mark_terminal("done")
        except Exception as err:  # noqa: BLE001
            _log.exception("GVHMR video-to-motion job failed")
            job.error = str(err)
            job.mark_terminal("error")

    @app.get("/api/video-to-motion/status")
    def video_to_motion_status() -> dict:
        """Report whether the isolated official GVHMR runtime is ready."""

        from hhtools.integrations.gvhmr import gvhmr_status

        return gvhmr_status()

    @app.post("/api/video-to-motion/upload")
    async def upload_video_to_motion(
        files: list[UploadFile] = File(...),
        checkpoint: UploadFile | None = File(None),
        static_cam: bool = True,
        f_mm: int | None = None,
    ) -> dict:
        """Upload one video and schedule official GVHMR inference."""

        from hhtools.integrations.gvhmr import gvhmr_status

        if len(files) != 1:
            raise HTTPException(status_code=400, detail="请选择一个视频文件")
        if f_mm is not None and f_mm <= 0:
            raise HTTPException(status_code=400, detail="f_mm 必须为正整数")
        runtime = gvhmr_status()
        if not runtime["ready"]:
            missing = "; ".join(runtime["missing"])
            raise HTTPException(status_code=503, detail=f"GVHMR 尚未就绪：{missing}")

        admission = _reserve_job_slot()
        drop = state.upload_root / f"gvhmr_{uuid.uuid4().hex[:8]}"
        scheduled = False
        try:
            drop.mkdir(parents=True, exist_ok=True)
            stored = await _store_uploads(files, drop)
            if len(stored) != 1:
                raise HTTPException(status_code=400, detail="视频上传为空")
            relative, video_path = stored[0]
            if video_path.suffix.lower() not in {
                ".mp4", ".mov", ".mkv", ".avi", ".webm", ".m4v",
            }:
                raise HTTPException(
                    status_code=400,
                    detail="支持 MP4、MOV、MKV、AVI、WebM 和 M4V 视频",
                )
            checkpoint_path: Path | None = None
            if checkpoint is not None:
                stored_checkpoint = await _store_uploads(
                    [checkpoint],
                    drop / "checkpoint",
                    default="custom.ckpt",
                )
                if len(stored_checkpoint) != 1:
                    raise HTTPException(status_code=400, detail="自定义权重上传为空")
                _checkpoint_relative, checkpoint_path = stored_checkpoint[0]
            job = _schedule_job(
                "video_to_motion",
                {
                    "file": relative.as_posix(),
                    "static_cam": static_cam,
                    "f_mm": f_mm,
                    "engine": "official_gvhmr",
                    "weights": "custom" if checkpoint_path else "official",
                    "checkpoint_name": checkpoint_path.name if checkpoint_path else None,
                    "training": False,
                },
                _run_gvhmr_video_job,
                args=(drop, video_path, checkpoint_path, static_cam, f_mm),
                reservation=admission,
            )
            scheduled = True
            return {"job_id": job.id}
        finally:
            if not scheduled:
                admission.cancel()
                shutil.rmtree(drop, ignore_errors=True)

    @app.post("/api/motion/load_library")
    async def load_library(body: dict) -> dict:
        if body.get("usage") == "human_to_robot":
            from hhtools.web.motion_library_links import library_entry_for_load
            from hhtools.web.r2r_upload_resolve import _is_robot_export_trajectory

            try:
                entry = library_entry_for_load(
                    dataset=str(body.get("dataset") or "unknown"),
                    folder_label=str(body.get("folder_label") or ""),
                    sequence_id=str(body.get("sequence_id") or ""),
                    source_path=str(body.get("source_path") or ""),
                )
            except (FileNotFoundError, ValueError) as err:
                raise HTTPException(status_code=422, detail=str(err)) from err
            if (
                str(body.get("dataset") or "").casefold() in {"robot", "r2r"}
                or _is_robot_export_trajectory(entry.source_path)
            ):
                raise HTTPException(
                    status_code=422,
                    detail=(
                        "人体到机器人工作流只接受人体动作；机器人关节轨迹请使用"
                        "机器人到机器人工作流。"
                    ),
                )
        job = _schedule_job(
            "motion_load", body, _run_motion_library_job, args=(body,),
        )
        return {"job_id": job.id}

    @app.post("/api/basket/upload")
    async def basket_upload(
        files: list[UploadFile] = File(...),
        profile: str = "auto",
    ) -> dict:
        """Upload external clips into the session cache for batch retarget."""
        admission = _reserve_job_slot()
        drop = state.upload_root / uuid.uuid4().hex[:8]
        scheduled = False
        try:
            drop.mkdir(parents=True, exist_ok=True)
            stored = await _store_uploads(files, drop)
            if not stored:
                raise HTTPException(status_code=400, detail="empty upload")
            job = _schedule_job(
                "basket_upload",
                {
                    "profile": profile,
                    "file_count": len(stored),
                    "files": [relative.as_posix() for relative, _path in stored],
                },
                _run_basket_upload_job,
                args=(drop, profile),
                reservation=admission,
            )
            scheduled = True
            return {"job_id": job.id}
        finally:
            if not scheduled:
                admission.cancel()
                shutil.rmtree(drop, ignore_errors=True)

    @app.post("/api/basket/scan")
    def basket_scan(body: dict) -> dict:
        """Enumerate Human2Robot clips on a server-local path (no copy)."""
        from hhtools.web.upload_resolve import enumerate_upload_clips

        raw = str(body.get("source") or "").strip()
        profile = str(body.get("profile") or "auto").strip() or "auto"
        if not raw:
            raise HTTPException(status_code=400, detail="请填写本机目录路径")
        root = Path(raw).expanduser()
        if not root.is_dir():
            raise HTTPException(status_code=400, detail=f"目录不存在：{root}")
        root = root.resolve()
        clips = enumerate_upload_clips(root, profile)
        if not clips:
            raise HTTPException(
                status_code=400,
                detail="未找到可识别的动作 clip（OmniContact 需要 motion_actor.bvh）",
            )
        entries = [
            _library_entry_from_upload(
                root,
                ref.path,
                ref.dataset,
                ref.profile,
                upload_profile=ref.profile,
                clip_kind=ref.clip_kind,
            )
            for ref in clips
        ]
        return {
            "entries": entries,
            "clip_count": len(entries),
            "source": str(root),
            "profile": profile,
        }

    @app.post("/api/motion/upload")
    async def upload_motion(
        files: list[UploadFile] = File(...),
        profile: str = "mimic",
        library_folder_label: str | None = None,
    ) -> dict:
        """Upload motion clips; auto-link or copy them into the managed library."""

        from hhtools.web.motion_library_links import motions_library_root

        if not files:
            raise HTTPException(status_code=400, detail="empty upload")

        from hhtools.web.upload_resolve import (
            enumerate_upload_clips,
            upload_validation_error,
        )

        folder_label = str(library_folder_label or "").strip() or None

        # Reserve admission before touching either the upload tree or the user's
        # persistent Motion Library.  A bounded queue therefore rejects cleanly.
        admission = _reserve_job_slot()
        drop = state.upload_root / uuid.uuid4().hex[:8]
        scheduled = False
        try:
            drop.mkdir(parents=True, exist_ok=True)
            # Always buffer browser bytes first so a bad on-disk symlink guess
            # cannot discard the only copy of the clip (see link_to_library).
            stored = await _store_uploads(files, drop)
            rel_paths = [relative.as_posix() for relative, _destination in stored]

            # Validate the isolated drop before materialisation.  Previously an
            # unsupported upload could replace a same-named library folder and
            # only then return HTTP 400.
            if not enumerate_upload_clips(drop, profile):
                raise HTTPException(
                    status_code=400,
                    detail=upload_validation_error(profile),
                )

            job = _schedule_job(
                "motion_link",
                {
                    "profile": profile,
                    "folder_label": folder_label,
                    "file_count": len(rel_paths),
                    "files": rel_paths,
                },
                _run_motion_library_dir_job,
                args=(drop, rel_paths, folder_label, profile),
                kwargs={"prefer_paths": rel_paths},
                reservation=admission,
            )
            scheduled = True
            return {
                "job_id": job.id,
                "linked": False,
                "materialize_mode": "pending",
                "motions_library_root": str(motions_library_root()),
            }
        finally:
            if not scheduled:
                admission.cancel()
                shutil.rmtree(drop, ignore_errors=True)

    @app.get("/api/object_glb")
    def object_glb(token: str, index: int, scale: float | None = None) -> Response:
        rec = state.motions.get(token)
        if not rec:
            raise HTTPException(status_code=404, detail="unknown motion token")
        from hhtools.web.serialize import object_mesh_glb

        objs = rec["motion"].objects
        if index < 0 or index >= len(objs):
            raise HTTPException(status_code=404, detail="object index out of range")
        scale_override = _parse_optional_fps(scale)
        glb = object_mesh_glb(objs[index], scale=scale_override)
        if glb is None:
            raise HTTPException(status_code=404, detail="no mesh for object")
        return Response(content=glb, media_type="model/gltf-binary")

    # ----------------------------------------------------------------- robots

    @app.get("/api/robots")
    def robots() -> dict:
        from hhtools.robot.registry import is_user_installed, list_presets, refresh

        refresh()
        out = []
        for p in list_presets():
            builtin = _is_builtin_robot_preset(p.name)
            out.append(
                {
                    "name": p.name,
                    "display_name": p.display_name,
                    "has_urdf": p.has_urdf,
                    "num_dof": len(p.dof_order),
                    "builtin": builtin,
                    "deletable": is_user_installed(p, state.robot_root) and not builtin,
                }
            )
        return {
            "robots": out,
            "library_dir": str(state.robot_root.resolve()),
        }

    def _serialize_and_store_robot(name: str) -> dict:
        from hhtools.robot.loader import load_robot
        from hhtools.robot.registry import get as get_preset
        from hhtools.web.serialize import serialize_robot

        preset = get_preset(name)
        model = load_robot(preset, compile_mjcf=True)
        if model.mujoco_model is None:
            raise RuntimeError(
                f"URDF for {name!r} did not compile to a MuJoCo model after mesh "
                f"path repair — upload the full robot folder (URDF + meshes/, and "
                f"any mesh/, convex/, or assets/ sidecars). Collada (.dae) meshes "
                f"are auto-converted to STL at ingest."
            )
        state.robots[name] = model
        _start_robot_prewarm(state, model, name)
        payload = serialize_robot(model, name=name)
        try:
            from hhtools.retarget.newton_basic.pipeline import is_newton_ik_prewarmed

            payload["ik_prewarmed"] = is_newton_ik_prewarmed(name)
        except Exception:  # noqa: BLE001
            payload["ik_prewarmed"] = False
        return payload

    @app.post("/api/robot/select")
    async def robot_select(body: dict) -> dict:
        name = body.get("name", "")
        try:
            return _serialize_and_store_robot(name)
        except Exception as err:  # noqa: BLE001
            raise HTTPException(status_code=400, detail=f"load robot failed: {err}") from err

    @app.post("/api/robot/upload")
    async def robot_upload(
        files: list[UploadFile] = File(...), name: str | None = None
    ) -> dict:
        """Accept a URDF + mesh files; scaffold + auto-repair, load, serialize."""
        from hhtools.robot.kinematics import prepare_ik_map
        from hhtools.robot.registry import preset_from_dir, refresh
        from hhtools.robot.scaffold import scaffold_yaml_file
        from hhtools.robot.urdf_normalize import (
            ensure_urdf_meshes_resolvable,
            robot_upload_destination,
        )
        from hhtools.robot.yaml_io import update_robot_yaml_ik_map

        urdf_path: Path | None = None
        saved: list[Path] = []
        try:
            drop_name = _safe_upload_directory_name(name, default="uploaded_robot")
        except ValueError as err:
            raise HTTPException(status_code=400, detail=str(err)) from err
        if _is_builtin_robot_preset(drop_name):
            raise HTTPException(
                status_code=403,
                detail=(
                    f"robot {drop_name!r} is a built-in preset and cannot be "
                    "overwritten via upload"
                ),
            )
        drop = state.robot_root / drop_name
        # Re-uploading an existing robot rebuilds geometry but must NOT wipe the
        # user's tuned retarget config: keep bundled scalers, calibrations, and
        # the robot.yaml ``retarget.references`` mapping across the rebuild.
        preserved_files: dict[str, bytes] = {}
        preserved_references: dict | None = None
        if drop.exists():
            for pat in ("retarget_calibration_*.yaml", "*scaler_config*.yaml"):
                for f in drop.glob(pat):
                    try:
                        preserved_files[f.name] = f.read_bytes()
                    except OSError:
                        pass
            preserved_references = _read_yaml_retarget_references(drop)
            shutil.rmtree(drop, ignore_errors=True)

        def _robot_upload_path(relative: Path) -> Path:
            rel = relative.as_posix()
            return robot_upload_destination(
                drop,
                rel,
                is_urdf=rel.lower().endswith(".urdf"),
            )

        stored = await _store_uploads(
            files,
            drop,
            default="f",
            destination_for=_robot_upload_path,
        )
        for rel_path, dst in stored:
            is_urdf = rel_path.suffix.lower() == ".urdf"
            saved.append(dst)
            if is_urdf:
                urdf_path = dst
        if urdf_path is None:
            raise HTTPException(status_code=400, detail="no .urdf file in upload")

        try:
            ensure_urdf_meshes_resolvable(
                urdf_path,
                search_dirs=[drop / "meshes", drop],
                output_path=urdf_path,
            )
            # Restore calibration / bundled scalers before scaffold so
            # retarget_calibration_*.yaml survives the URDF replace.
            for fname, data in preserved_files.items():
                try:
                    (drop / fname).write_bytes(data)
                except OSError:
                    pass
            scaffold_yaml_file(urdf_path, overwrite=True, root_dir=drop)
            try:
                preset = preset_from_dir(drop)
            except FileNotFoundError as err:
                raise HTTPException(
                    status_code=400,
                    detail=f"robot ingest failed: {err}",
                ) from err
            refresh()
            repaired, _changes = prepare_ik_map(urdf_path, dict(preset.ik_map))
            yaml_path = preset.meta.get("yaml_path")
            if yaml_path and repaired != dict(preset.ik_map):
                update_robot_yaml_ik_map(yaml_path, repaired)
                refresh()
            if preserved_references:
                _merge_retarget_references(yaml_path, preserved_references)
            if preserved_references:
                refresh()
            return _serialize_and_store_robot(preset.name)
        except HTTPException:
            raise
        except Exception as err:  # noqa: BLE001
            raise HTTPException(status_code=400, detail=f"robot ingest failed: {err}") from err

    @app.delete("/api/robot/{name}")
    def robot_delete(name: str) -> dict:
        """Remove a user-installed robot from the persistent library."""
        from hhtools.robot.registry import get as get_preset
        from hhtools.robot.registry import is_user_installed, refresh

        try:
            preset = get_preset(name)
        except KeyError as err:
            raise HTTPException(status_code=404, detail=f"unknown robot: {name}") from err
        if _is_builtin_robot_preset(preset.name):
            raise HTTPException(
                status_code=403,
                detail=f"robot {name!r} is a built-in preset and cannot be deleted",
            )
        if not is_user_installed(preset, state.robot_root):
            raise HTTPException(
                status_code=403,
                detail=(
                    f"robot {name!r} is a built-in preset and cannot be deleted from the UI; "
                    "only robots registered via the web UI (under your user library) are removable"
                ),
            )
        target = preset.root_dir.resolve()
        library = state.robot_root.resolve()
        try:
            if not target.is_relative_to(library):
                raise HTTPException(status_code=403, detail="robot is outside the user library")
        except ValueError as err:
            raise HTTPException(status_code=403, detail="robot is outside the user library") from err
        shutil.rmtree(target, ignore_errors=False)
        state.robots.pop(name, None)
        refresh()
        return {"ok": True, "deleted": name}

    # ----------------------------------------------------------------- calibration

    @app.get("/api/calibration/references")
    def calibration_references() -> dict:
        from hhtools.retarget.calibration import list_reference_names

        return {"references": list(list_reference_names())}

    @app.get("/api/calibration/status")
    def calibration_status(robot: str, reference: str) -> dict:
        from hhtools.retarget.calibration import resolve_preset_calibration_file
        from hhtools.robot.registry import get as get_preset
        from hhtools.robot.retarget_profile import bundled_scaler_path

        try:
            preset = get_preset(robot)
        except Exception as err:  # noqa: BLE001
            raise HTTPException(status_code=404, detail=str(err)) from err
        if preset.urdf_path is None:
            return {"calibrated": False, "path": None}
        path = resolve_preset_calibration_file(preset, reference)
        bundled = bundled_scaler_path(preset, reference)
        joint_q: dict[str, float] | None = None
        if path is not None:
            from hhtools.retarget.calibration import load_calibration

            cal = load_calibration(path)
            joint_q = {str(k): float(v) for k, v in cal.calibrated_joint_q.items()}
        # Optional per-robot bundled scaler (``robot.yaml`` → ``scaler_config``)
        # also counts as ready; otherwise calibration is required.
        return {
            "calibrated": path is not None or bundled is not None,
            "bundled": bundled is not None,
            "path": str(path) if path else None,
            "joint_q": joint_q,
        }

    @app.post("/api/robot/fk_preview")
    async def robot_fk_preview(body: dict) -> dict:
        """Apply a calibration joint_q on the server and return link transforms."""
        import numpy as np

        from hhtools.web.calibration_session import joint_world_payload

        robot = body.get("robot")
        model = state.robots.get(robot)
        if model is None:
            raise HTTPException(status_code=404, detail="robot not loaded")
        joint_q = {str(k): float(v) for k, v in (body.get("joint_q") or {}).items()}
        try:
            model.apply_configuration(joint_q)
        except Exception as err:  # noqa: BLE001
            raise HTTPException(status_code=400, detail=str(err)) from err
        from hhtools.web.calibration_session import _robot_ground_offset_z

        ground_z = _robot_ground_offset_z(model)
        links = [link.name for link in model.links]
        link_T: dict[str, list[float]] = {}
        for link in links:
            try:
                T = model.urdf.get_transform(link)
                link_T[link] = np.asarray(T, dtype=np.float32).flatten().tolist()
            except Exception:
                link_T[link] = np.eye(4, dtype=np.float32).flatten().tolist()
        return {
            "links": links,
            "link_transforms": link_T,
            "joint_world": joint_world_payload(model),
            "ground_offset_z": round(ground_z, 5),
        }

    @app.post("/api/calibration/save")
    async def calibration_save(body: dict) -> dict:
        from hhtools.retarget.calibration import (
            RobotRetargetCalibration,
            derive_calibration_params,
            save_calibration_for_preset,
        )
        from hhtools.robot.registry import get as get_preset

        robot = body["robot"]
        reference = body["reference"]
        joint_q = {str(k): float(v) for k, v in body.get("joint_q", {}).items()}
        token = body.get("motion_token")
        model = state.robots.get(robot)
        motion = None
        if token:
            rec = state.motions.get(token)
            if rec is not None:
                motion = rec["motion"]
        try:
            preset = get_preset(robot)
            if model is None:
                from hhtools.robot.loader import load_robot

                model = load_robot(preset, compile_mjcf=False)
                state.robots[robot] = model
            cal = RobotRetargetCalibration(
                robot=robot, reference=reference, calibrated_joint_q=joint_q,
                notes="saved from web UI",
            )
            derived = derive_calibration_params(
                cal, model, reference_motion=motion,
            )
            path = save_calibration_for_preset(cal, preset, derived=derived)
            # Do not sync derived.scales into robot.yaml joint_scale_multipliers:
            # that global table is shared across references and would pollute
            # the next dataset's retarget (see active_joint_scale_overrides).
        except Exception as err:  # noqa: BLE001
            raise HTTPException(status_code=400, detail=f"calibration save failed: {err}") from err
        return {"ok": True, "path": str(path)}

    @app.post("/api/calibration/session")
    async def calibration_session(body: dict) -> dict:
        """Enter calibration mode: reference T-pose, joint limits, saved joint_q."""
        from hhtools.web.calibration_session import build_calibration_session

        robot = body.get("robot")
        reference = body.get("reference")
        token = body.get("motion_token")
        model = state.robots.get(robot)
        if model is None:
            raise HTTPException(status_code=404, detail="robot not loaded")
        motion = None
        if token:
            rec = state.motions.get(token)
            if rec is not None:
                motion = rec["motion"]
        try:
            return build_calibration_session(
                model, reference=str(reference), motion=motion,
            )
        except ValueError as err:
            raise HTTPException(status_code=400, detail=str(err)) from err
        except Exception as err:  # noqa: BLE001
            _log.exception("calibration session failed")
            raise HTTPException(status_code=500, detail=str(err)) from err

    # ----------------------------------------------------------------- retarget

    def _run_retarget_job(job: Job, body: dict) -> None:
        try:
            job.progress = 0.01
            job.message = "正在准备 retarget…"
            robot = body["robot"]
            token = body["motion_token"]
            reference = body.get("reference", "smpl")
            backend = body.get("backend", "newton")
            ik_iters = int(body.get("ik_iterations", 24))
            foot_clamp_anti_penetration = bool(
                body.get("foot_clamp_anti_penetration", False)
            )
            from hhtools.robot.registry import get as _get_preset

            human_height = _request_human_height(body, _get_preset(robot), reference)
            limit_frames = body.get("limit_frames")
            retarget_fps = _parse_optional_fps(body.get("retarget_fps"))

            rec = state.motions.get(token)
            if rec is None:
                raise ValueError("motion token expired; reload the clip")
            source_entry = rec.get("library_entry")
            job.request = _snapshot_job_request(
                {
                    **job.request,
                    "source_path": rec.get("source_path"),
                    "source_entry": source_entry,
                    "robot": robot,
                    "reference": reference,
                    "backend": backend,
                    "ik_iterations": ik_iters,
                    "human_height": human_height,
                    "limit_frames": limit_frames,
                    "retarget_fps": retarget_fps,
                }
            )
            motion_src = rec["motion"]
            motion_source_fps = float(motion_src.framerate)
            motion, motion_retarget_fps = _motion_for_retarget(motion_src, retarget_fps)
            model = state.robots[robot]
            ret = _retarget_single(
                model, robot, motion, reference, backend,
                ik_iters, human_height, limit_frames, job,
                state=state,
                foot_clamp_anti_penetration=foot_clamp_anti_penetration,
            )
            from hhtools.web.serialize import serialize_robot_trajectory

            scaled = _compute_scaled_preview(
                model, robot, motion, reference, human_height,
            )
            traj = serialize_robot_trajectory(
                model, ret, scaled_preview=scaled,
            )
            scaled = _align_scaled_preview_to_robot_playback(
                model, ret, scaled, traj,
            )
            from hhtools.web.result_diagnostics import build_result_diagnostics

            diagnostics = build_result_diagnostics(
                traj,
                scaled,
                ik_map=model.preset.ik_map,
                feet=model.preset.feet,
            )
            scaled_scene = _compute_scaled_scene(
                model, robot, motion, reference, human_height,
            )
            from hhtools.web.serialize import _scaled_overlay_foot_z

            # Keep the retarget result + source motion in memory so the export
            # endpoint can render CSV or PKL at any target fps on demand.
            export_token = uuid.uuid4().hex[:10]
            state.motions[f"export::{export_token}"] = {
                "retargeted": ret,
                "robot": robot,
                "source_motion": motion,
                "backend": backend,
                "stem": motion.name or token,
                "has_scene": bool(motion.terrain is not None or motion.objects),
                "source_path": rec.get("source_path"),
                # Same yellow-foot Z the viewer used so CSV/PKL bake matches playback.
                "yellow_foot_z": _scaled_overlay_foot_z(scaled, 0),
            }
            job.result = {
                "trajectory": traj,
                "scaled_preview": scaled,
                "scaled_scene": scaled_scene,
                "diagnostics": diagnostics,
                "export_token": export_token,
                "stem": motion.name or token,
                "motion_source_fps": motion_source_fps,
                "retarget_fps": float(motion_retarget_fps),
                "source_fps": float(ret.sample_rate),
                "has_scene": bool(motion.terrain is not None or motion.objects),
                "num_frames": ret.num_frames,
            }
            job.progress = 1.0
            job.message = "done"
            job.mark_terminal("done")
        except Exception as err:  # noqa: BLE001
            _log.exception("retarget job failed")
            job.error = str(err)
            job.mark_terminal("error")

    @app.post("/api/retarget")
    async def retarget(body: dict) -> dict:
        job = _schedule_job("retarget", body, _run_retarget_job, args=(body,))
        return {"job_id": job.id}

    @app.post("/api/scaled_preview")
    async def scaled_preview(body: dict) -> dict:
        """Scaled effector skeleton (robot calibration applied, before IK)."""
        robot = body.get("robot")
        token = body.get("motion_token")
        reference = body.get("reference", "smpl")
        rec = state.motions.get(token)
        if rec is None:
            raise HTTPException(status_code=404, detail="motion token expired; reload the clip")
        model = state.robots.get(robot)
        if model is None:
            raise HTTPException(status_code=404, detail="robot not loaded")
        human_height = _request_human_height(body, model.preset, reference)
        try:
            motion = rec["motion"]
            preview = _compute_scaled_preview(
                model, robot, motion, reference, human_height,
            )
            scaled_scene = _compute_scaled_scene(
                model, robot, motion, reference, human_height,
            )
            return {"preview": preview, "scaled_scene": scaled_scene}
        except ValueError as err:
            raise HTTPException(status_code=400, detail=str(err)) from err
        except Exception as err:  # noqa: BLE001
            _log.exception("scaled preview failed")
            raise HTTPException(status_code=500, detail=str(err)) from err

    def _job_source_for_replay(job_id: str) -> tuple[dict[str, Any], str, list[dict]]:
        """Return ``(spec, status, failures)`` without exposing stored internals."""
        job = _get_job(job_id)
        if job is not None:
            failures = (job.result or {}).get("failures")
            return (
                build_job_spec(job.kind, job.request),
                job.status,
                failures if isinstance(failures, list) else [],
            )
        stored = state.job_history.get(job_id)
        if stored is None:
            raise HTTPException(status_code=404, detail="unknown job")
        failures = stored.get("failures")
        return (
            build_job_spec(
                str(stored.get("kind") or ""), stored.get("request") or {},
            ),
            str(stored.get("status") or ""),
            failures if isinstance(failures, list) else [],
        )

    def _ensure_replay_robot(job: Job, robot: str) -> None:
        if robot in state.robots:
            return
        job.progress = max(job.progress, 0.01)
        job.message = f"正在重新加载机器人 {robot}…"
        _serialize_and_store_robot(robot)

    def _load_replay_motion(job: Job, request: dict[str, Any]) -> str:
        """Rebuild a motion token from the source path captured by JobSpec."""
        from hhtools.web.r2r_upload_resolve import _is_robot_export_trajectory

        source_path = Path(str(request["source_path"])).expanduser().resolve()
        job.progress = max(job.progress, 0.02)
        job.message = f"正在重新加载 {source_path.name}…"
        source_entry = request.get("source_entry")
        motion = None
        dataset: str | None = None
        library_entry: dict[str, Any] | None = None

        if isinstance(source_entry, dict):
            candidate = dict(source_entry)
            candidate["source_path"] = str(source_path)
            try:
                from hhtools.web.motion_library_links import library_entry_for_load

                entry = library_entry_for_load(
                    dataset=str(candidate.get("dataset") or "unknown"),
                    folder_label=str(candidate.get("folder_label") or source_path.parent.name),
                    sequence_id=str(candidate.get("sequence_id") or source_path.name),
                    source_path=source_path,
                    upload_drop=candidate.get("upload_drop"),
                )
                if candidate.get("dataset") == "robot" or _is_robot_export_trajectory(
                    source_path
                ):
                    motion = _load_robot_export_for_web(source_path, state)
                    dataset = "robot"
                else:
                    motion = _load_motion_for_web(entry, state.cache)
                    dataset = str(candidate.get("dataset") or "unknown")
                library_entry = candidate
            except Exception as err:  # noqa: BLE001 - direct file load is the fallback
                _log.info("library replay load fell back to direct IO: %s", err)

        if motion is None:
            if _is_robot_export_trajectory(source_path):
                motion = _load_robot_export_for_web(source_path, state)
                dataset = "robot"
            else:
                try:
                    motion = _load_motion_file(source_path)
                except Exception as direct_error:  # noqa: BLE001 - adapter fallback
                    motion, dataset = _load_via_adapter(source_path)
                    if motion is None:
                        raise ValueError(
                            f"无法重新加载源动作 {source_path}: {direct_error}"
                        ) from direct_error
            library_entry = {
                "dataset": dataset or "unknown",
                "folder_label": source_path.parent.name or "replay",
                "sequence_id": source_path.name,
                "source_path": str(source_path),
                "stem": source_path.stem,
                "origin": "replay",
            }

        payload = _register_motion(
            motion,
            dataset,
            "replay",
            library_entry=library_entry,
        )
        return str(payload["token"])

    def _normalise_replay_batch_entries(request: dict[str, Any]) -> dict[str, Any]:
        """Fill the library-shaped fields required by the existing batch worker."""
        replay_request = dict(request)
        normalized: list[dict[str, Any]] = []
        for raw_entry in replay_request.get("entries") or []:
            entry = dict(raw_entry)
            source = Path(str(entry["source_path"])).expanduser().resolve()
            entry["source_path"] = str(source)
            entry.setdefault("dataset", "unknown")
            entry.setdefault("folder_label", source.parent.name or "replay")
            entry.setdefault("sequence_id", source.name)
            entry.setdefault("stem", source.stem)
            if entry.get("dataset") == "unknown" and not entry.get("origin"):
                # The upload resolver is also the generic single-file loader. It
                # avoids requiring a dataset adapter for an imported NPZ/BVH/GLB.
                entry["origin"] = "upload"
                entry["upload_profile"] = "auto"
            normalized.append(entry)
        replay_request["entries"] = normalized
        return replay_request

    def _run_replayed_retarget_job(job: Job, request: dict[str, Any]) -> None:
        try:
            robot = str(request["robot"])
            _ensure_replay_robot(job, robot)
            motion_token = _load_replay_motion(job, request)
            _run_retarget_job(job, {**request, "motion_token": motion_token})
        except Exception as err:  # noqa: BLE001 - worker errors belong on the job
            _log.exception("replayed retarget job failed")
            job.error = str(err)
            job.mark_terminal("error")

    def _run_replayed_batch_job(job: Job, request: dict[str, Any]) -> None:
        try:
            _ensure_replay_robot(job, str(request["robot"]))
            _run_batch_job(job, _normalise_replay_batch_entries(request))
        except Exception as err:  # noqa: BLE001 - worker errors belong on the job
            _log.exception("replayed batch job failed")
            job.error = str(err)
            job.mark_terminal("error")

    def _failed_only_spec(
        spec: dict[str, Any], failures: list[dict],
    ) -> dict[str, Any]:
        if spec["kind"] != "batch":
            raise HTTPException(
                status_code=400,
                detail={"code": "not_batch", "msg": "只有批处理任务支持仅重试失败项。"},
            )
        failed_paths = {
            str(Path(str(item["source_path"])).expanduser().resolve())
            for item in failures
            if isinstance(item, dict) and item.get("source_path")
        }
        request = dict(spec["request"])
        entries = [
            entry
            for entry in request.get("entries") or []
            if isinstance(entry, dict)
            and entry.get("source_path")
            and str(Path(str(entry["source_path"])).expanduser().resolve()) in failed_paths
        ]
        if not entries:
            raise HTTPException(
                status_code=400,
                detail={
                    "code": "no_failed_entries",
                    "msg": "该记录没有可定位到源文件的失败条目。",
                },
            )
        request["entries"] = entries
        out_name = str(request.get("out_dir") or "batch_export")
        request["out_dir"] = f"{out_name}_failed_retry"
        return build_job_spec("batch", request)

    def _start_replayed_job(
        spec: dict[str, Any], *, parent_job_id: str | None,
    ) -> Job:
        capability = replay_capability(spec, ephemeral_root=state.upload_root)
        if not capability["available"]:
            raise HTTPException(
                status_code=400,
                detail={"code": "job_not_replayable", "msg": capability["reason"]},
            )
        request = _snapshot_job_request(spec["request"])
        target = (
            _run_replayed_retarget_job
            if spec["kind"] == "retarget"
            else _run_replayed_batch_job
        )
        return _schedule_job(
            str(spec["kind"]),
            request,
            target,
            args=(request,),
            parent_job_id=parent_job_id,
        )

    @app.post("/api/jobs/spec/validate")
    async def validate_job_spec(body: dict) -> dict:
        """Normalize imported JSON and report whether it can be run locally."""
        try:
            spec = normalize_job_spec(body)
        except JobSpecError as err:
            raise HTTPException(
                status_code=400,
                detail={"code": "invalid_job_spec", "msg": str(err)},
            ) from err
        return {
            "spec": spec,
            "replay": replay_capability(spec, ephemeral_root=state.upload_root),
        }

    @app.post("/api/jobs/replay")
    async def replay_job(body: dict) -> dict:
        """Start a new job from history or from an edited/imported JobSpec."""
        source_job_id = body.get("job_id")
        failed_only = bool(body.get("failed_only", False))
        failures: list[dict] = []
        if isinstance(source_job_id, str) and source_job_id:
            spec, source_status, failures = _job_source_for_replay(source_job_id)
            if source_status in _ACTIVE_JOB_STATUSES:
                raise HTTPException(
                    status_code=409,
                    detail={
                        # Keep the established machine-readable code for API
                        # compatibility; its message now also covers pending.
                        "code": "job_running",
                        "msg": "原任务仍在排队或运行中。",
                    },
                )
        else:
            try:
                spec = normalize_job_spec(body)
            except JobSpecError as err:
                raise HTTPException(
                    status_code=400,
                    detail={"code": "invalid_job_spec", "msg": str(err)},
                ) from err
            source_job_id = None
        if failed_only:
            spec = _failed_only_spec(spec, failures)
        job = _start_replayed_job(spec, parent_job_id=source_job_id)
        return {
            "job_id": job.id,
            "parent_job_id": source_job_id,
            "spec": build_job_spec(job.kind, job.request),
        }

    @app.get("/api/jobs")
    def job_list(limit: int = 50) -> dict:
        """List compact live and disk-backed records, newest first."""
        bounded_limit = max(1, min(100, limit))
        now = time.monotonic()
        persisted = {
            record["id"]: _stored_job_record(record)
            for record in state.job_history.list_records(limit=100)
        }
        with state.job_lock:
            _prune_jobs_locked(now)
            # Listing must not refresh last_accessed_at: otherwise the drawer's
            # periodic polling would prevent terminal jobs from expiring.
            live = {job.id: _job_record(job) for job in state.jobs.values()}
        records = sorted(
            {**persisted, **live}.values(),
            key=lambda record: float(record.get("created_at") or 0.0),
            reverse=True,
        )[:bounded_limit]
        return {
            "jobs": records,
            "session_only": False,
            "persistence": "disk",
            "scheduler": _scheduler_payload(),
        }

    @app.get("/api/job/{job_id}/config")
    def job_config(job_id: str) -> dict:
        """Return the exact effective request captured when this job was started."""
        job = _get_job(job_id)
        stored = None if job is not None else state.job_history.get(job_id)
        return _job_config_payload(job, stored)

    @app.get("/api/job/{job_id}/config/download")
    def job_config_download(job_id: str) -> Response:
        """Download the effective request as a UTF-8 JSON reproduction record."""
        job = _get_job(job_id)
        stored = None if job is not None else state.job_history.get(job_id)
        payload = _job_config_payload(job, stored)
        return Response(
            content=json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
            media_type="application/json; charset=utf-8",
            headers={
                "Content-Disposition": f'attachment; filename="hhtools-job-{job_id}.json"'
            },
        )

    @app.get("/api/job/{job_id}/cli")
    def job_cli(job_id: str) -> dict:
        """Return the exact public CLI equivalent, or why none exists yet."""
        job = _get_job(job_id)
        if job is not None:
            return _job_cli_reproduction(job.kind, job.request)
        stored = state.job_history.get(job_id)
        if stored is None:
            raise HTTPException(status_code=404, detail="unknown job")
        return _job_cli_reproduction(
            str(stored.get("kind") or ""), stored.get("request") or {},
        )

    @app.get("/api/job/{job_id}")
    def job_status(job_id: str) -> dict:
        job = _get_job(job_id)
        if job is not None:
            return {**_job_record(job), "result": job.result}
        stored = state.job_history.get(job_id)
        if stored is None:
            raise HTTPException(status_code=404, detail="unknown job")
        result = {
            "artifact_path": stored.get("artifact_path"),
            "download_name": stored.get("download_name"),
        }
        return {**_stored_job_record(stored), "result": result}

    @app.get("/api/job/{job_id}/download")
    def job_download(job_id: str):
        job = _get_job(job_id)
        if job is not None:
            if job.status != "done":
                raise HTTPException(status_code=404, detail="job not ready")
            artifact = (job.result or {}).get("artifact_path")
            path = Path(artifact) if artifact else None
            name = (job.result or {}).get("download_name") or (path.name if path else None)
        else:
            stored = state.job_history.get(job_id)
            if stored is None or stored.get("status") != "done":
                raise HTTPException(status_code=404, detail="job not ready")
            path = state.job_history.artifact_path(stored)
            name = stored.get("download_name") or (path.name if path else None)
        if path is None:
            raise HTTPException(status_code=404, detail="no download artifact")
        if not path.is_file():
            raise HTTPException(status_code=404, detail="artifact missing")
        return FileResponse(
            path,
            filename=name or path.name,
            media_type="application/zip",
        )

    # ----------------------------------------------------------------- batch

    @app.get("/api/basket")
    def basket_get() -> dict:
        return {"basket": state.basket}

    @app.post("/api/basket/add")
    async def basket_add(body: dict) -> dict:
        fallback = (body.get("reference") or "smpl").strip()
        for e in body.get("entries", []):
            enriched = _enrich_basket_entry(e, fallback)
            if not any(
                x.get("source_path") == enriched.get("source_path")
                for x in state.basket
            ):
                state.basket.append(enriched)
        return {"basket": state.basket}

    @app.post("/api/basket/clear")
    async def basket_clear() -> dict:
        state.basket.clear()
        return {"basket": state.basket}

    def _run_batch_job(job: Job, body: dict) -> None:
        try:
            robot = body["robot"]
            default_reference = body.get("reference", "smpl")
            backend = body.get("backend", "newton")
            ik_iters = int(body.get("ik_iterations", 24))
            from hhtools.robot.registry import get as _get_preset

            human_height = _request_human_height(
                body, _get_preset(robot), default_reference
            )
            out_name = body.get("out_dir") or "batch_export"
            fmt = (body.get("format") or "csv").lower()
            csv_header = _parse_csv_header(body.get("csv_header", True))
            export_fps = _parse_optional_fps(body.get("export_fps", body.get("fps")))
            retarget_fps = _parse_optional_fps(body.get("retarget_fps"))
            export_t_start = _parse_optional_time(body.get("t_start"), name="t_start")
            export_t_end = _parse_optional_time(body.get("t_end"), name="t_end")
            limit_frames = body.get("limit_frames")
            foot_clamp_anti_penetration = bool(
                body.get("foot_clamp_anti_penetration", False)
            )
            requested_batch = max(1, min(256, int(body.get("batch_size", 16))))
            batch_size = requested_batch
            entries = [
                _enrich_basket_entry(e, default_reference)
                for e in (body.get("entries") or state.basket)
            ]
            model = state.robots[robot]
            if backend != "interaction_mesh":
                from hhtools.retarget.newton_basic.batch_limits import clamp_gpu_batch_size

                batch_size = clamp_gpu_batch_size(model, requested_batch)
                if batch_size < requested_batch:
                    _log.info(
                        "GPU batch_size clamped %d → %d for robot %r",
                        requested_batch,
                        batch_size,
                        robot,
                    )

            job.request = _snapshot_job_request(
                {
                    **job.request,
                    "entries": entries,
                    "robot": robot,
                    "reference": default_reference,
                    "backend": backend,
                    "ik_iterations": ik_iters,
                    "human_height": human_height,
                    "limit_frames": limit_frames,
                    "batch_size": batch_size,
                    "retarget_fps": retarget_fps,
                    "export_fps": export_fps,
                    "format": fmt,
                    "csv_header": csv_header,
                    "out_dir": out_name,
                }
            )
            out_dir = state.export_root / job.id
            if out_dir.exists():
                shutil.rmtree(out_dir, ignore_errors=True)
            out_dir.mkdir(parents=True, exist_ok=True)

            total = len(entries)
            written: list[str] = []
            errors: list[str] = []
            failures: list[dict] = []
            failure_log = None
            done_clips = 0
            batch_t0 = time.monotonic()
            clamp_note = ""
            if backend != "interaction_mesh" and batch_size < requested_batch:
                clamp_note = f"（GPU 上限，批量 {requested_batch}→{batch_size}）"
            _set_batch_job_progress(
                job, f"批量开始 · 0/{total}{clamp_note}", 0.0, batch_t0,
                clip_progress=0.0,
            )

            if backend == "interaction_mesh":
                failure_log = _run_batch_entries_sequential(
                    entries, model, robot, default_reference, backend,
                    ik_iters, human_height, limit_frames, retarget_fps,
                    export_fps, fmt, csv_header, out_dir, state,
                    job=job, job_id=job.id, out_name=out_name,
                    written=written, errors=errors, failures=failures,
                    failure_log=failure_log, batch_t0=batch_t0,
                    foot_clamp_anti_penetration=foot_clamp_anti_penetration,
                    t_start=export_t_start,
                    t_end=export_t_end,
                )
            else:
                from collections import defaultdict

                by_ref: dict[str, list[dict]] = defaultdict(list)
                for e in entries:
                    by_ref[_entry_reference(e, default_reference)].append(e)

                ref_groups = list(by_ref.items())
                for reference, ref_entries in ref_groups:
                    for chunk_start in range(0, len(ref_entries), batch_size):
                        chunk = ref_entries[chunk_start : chunk_start + batch_size]
                        loaded_chunk: list[tuple[dict, object, object]] = []
                        for e in chunk:
                            # ``done_clips`` only advances on export/failure, so
                            # add the count already loaded in this chunk
                            # (``len(loaded_chunk)``) to keep the counter moving
                            # while a large chunk loads clip-by-clip.
                            loading_pos = done_clips + len(loaded_chunk) + 1
                            _set_batch_job_progress(
                                job,
                                f"加载 {e.get('stem', '?')} · {loading_pos}/{total}",
                                (done_clips + len(loaded_chunk)) / max(1, total),
                                batch_t0,
                                clip_progress=0.0,
                            )
                            try:
                                from hhtools.web.motion_library_links import (
                                    library_entry_for_load,
                                )

                                entry = library_entry_for_load(
                                    dataset=e["dataset"],
                                    folder_label=e["folder_label"],
                                    sequence_id=e["sequence_id"],
                                    source_path=e["source_path"],
                                    upload_drop=e.get("upload_drop"),
                                )
                                motion = _load_batch_motion(
                                    e, entry, state.cache,
                                    retarget_fps=retarget_fps,
                                    limit_frames=limit_frames,
                                )
                                loaded_chunk.append((e, motion, entry))
                            except Exception as err:  # noqa: BLE001
                                failure_log = _record_batch_failure(
                                    failure_log, state, job.id, out_name,
                                    e, stage="load", reason=str(err),
                                    reference=reference,
                                    errors=errors, failures=failures,
                                )
                                done_clips += 1
                                _set_batch_job_progress(
                                    job,
                                    f"加载失败 {e.get('stem', '?')} · {done_clips}/{total}",
                                    done_clips / max(1, total),
                                    batch_t0,
                                    clip_progress=1.0,
                                )
                        if not loaded_chunk:
                            continue

                        chunk_label = (
                            f"GPU×{len(loaded_chunk)}"
                            if len(loaded_chunk) > 1
                            else "逐条"
                        )
                        _set_batch_job_progress(
                            job,
                            (
                                f"参考 {reference} · {chunk_label} · "
                                f"clip {done_clips + 1}–"
                                f"{min(done_clips + len(loaded_chunk), total)}/{total}"
                            ),
                            done_clips / max(1, total),
                            batch_t0,
                            clip_progress=0.0,
                        )
                        base_prog = done_clips / max(1, total)
                        span_prog = len(loaded_chunk) / max(1, total)
                        try:
                            exports, failure_log = _retarget_newton_batch_chunk(
                                loaded_chunk,
                                model=model,
                                robot_name=robot,
                                reference=reference,
                                ik_iters=ik_iters,
                                human_height=human_height,
                                state=state,
                                job=job,
                                job_id=job.id,
                                out_name=out_name,
                                failure_log=failure_log,
                                failures=failures,
                                errors=errors,
                                progress_base=base_prog,
                                progress_span=span_prog,
                                batch_t0=batch_t0,
                                chunk_label=chunk_label,
                                foot_clamp_anti_penetration=(
                                    foot_clamp_anti_penetration
                                ),
                            )
                            done_clips, failure_log = _batch_export_retargeted_chunk(
                                exports,
                                model=model,
                                motion_out_dir=out_dir,
                                export_fps=export_fps,
                                fmt=fmt,
                                backend=backend,
                                csv_header=csv_header,
                                base_prog=base_prog,
                                span_prog=span_prog,
                                job=job,
                                batch_t0=batch_t0,
                                done_clips=done_clips,
                                total=total,
                                written=written,
                                failure_log=failure_log,
                                state=state,
                                job_id=job.id,
                                out_name=out_name,
                                reference=reference,
                                errors=errors,
                                failures=failures,
                                t_start=export_t_start,
                                t_end=export_t_end,
                            )
                        except Exception as err:  # noqa: BLE001
                            for e, _, _ in loaded_chunk:
                                failure_log = _record_batch_failure(
                                    failure_log, state, job.id, out_name,
                                    e, stage="retarget", reason=str(err),
                                    reference=reference,
                                    errors=errors, failures=failures,
                                )
                                done_clips += 1
                            _set_batch_job_progress(
                                job,
                                f"批量失败 · {done_clips}/{total}",
                                done_clips / max(1, total),
                                batch_t0,
                                clip_progress=1.0,
                            )

            if failure_log is not None:
                failure_log.finalize(job_id=job.id, out_name=out_name)

            _set_batch_job_progress(
                job, "正在打包 ZIP…", _BATCH_ZIP_PROGRESS, batch_t0,
                clip_progress=1.0,
            )
            from hhtools.web.export_bundle import zip_directory

            zip_path = zip_directory(out_dir, out_name, compress=False)
            gpu_note = (
                "GPU-parallel Newton"
                if backend != "interaction_mesh" and batch_size > 1
                else "per-clip"
            )
            job.result = {
                "written": written,
                "errors": errors,
                "failures": failures,
                "failure_log": str(failure_log.root) if failure_log else None,
                "format": fmt,
                "download_name": f"{out_name}.zip",
                "artifact_path": str(zip_path),
                "clip_count": len(written),
                "batch_size": batch_size,
                "requested_batch_size": requested_batch,
                "solver_mode": gpu_note,
            }
            job.progress = 1.0
            job.clip_progress = 1.0
            fail_note = f"，{len(failures)} 失败" if failures else ""
            job.message = (
                f"{len(written)} 成功{fail_note}"
                + (f" · {gpu_note}" if backend != "interaction_mesh" else "")
            )
            job.mark_terminal("done")
        except Exception as err:  # noqa: BLE001
            _log.exception("batch job failed")
            job.error = str(err)
            job.mark_terminal("error")

    @app.post("/api/batch/retarget")
    async def batch_retarget(body: dict) -> dict:
        job = _schedule_job("batch", body, _run_batch_job, args=(body,))
        return {"job_id": job.id}

    # ----------------------------------------------------------------- export

    @app.get("/api/export/{export_token}")
    def export(
        export_token: str,
        fps: float | None = None,
        fmt: str = "csv",
        csv_header: bool = True,
        t_start: float | None = None,
        t_end: float | None = None,
    ):
        rec = state.motions.get(f"export::{export_token}")
        if rec is None:
            raise HTTPException(status_code=404, detail="unknown export token")
        if "path" in rec:
            path = Path(rec["path"])
            media = "application/zip" if path.suffix == ".zip" else "text/csv"
            return FileResponse(path, filename=path.name, media_type=media)

        ret = rec["retargeted"]
        stem = rec["stem"]
        fmt = (fmt or "csv").lower()
        try:
            t0 = _parse_optional_time(t_start, name="t_start")
            t1 = _parse_optional_time(t_end, name="t_end")
            # The robot may have been unloaded/swapped since this clip was
            # retargeted (``/api/robot`` unload pops ``state.robots``).  A bare
            # ``state.robots[name]`` here used to raise KeyError *outside* this
            # try block → unhandled 500.  Reload the preset on demand; pkl
            # export does not need the model at all, so tolerate its absence.
            model = state.robots.get(rec["robot"])
            if model is None:
                try:
                    from hhtools.robot.loader import load_robot
                    from hhtools.robot.registry import get as _get_preset

                    model = load_robot(_get_preset(rec["robot"]), compile_mjcf=False)
                    state.robots[rec["robot"]] = model
                except Exception as load_err:  # noqa: BLE001
                    if fmt != "pkl":
                        raise RuntimeError(
                            f"robot '{rec['robot']}' is no longer loaded and "
                            f"could not be reloaded for CSV export: {load_err}"
                        ) from load_err
                    model = None  # pkl branch never dereferences the model
            if rec.get("r2r"):
                src_name = rec.get("source_robot")
                src_model = state.robots.get(src_name) if src_name else None
                if src_model is None and src_name:
                    from hhtools.robot.loader import load_robot
                    from hhtools.robot.registry import get as _get_preset

                    src_model = load_robot(_get_preset(src_name), compile_mjcf=False)
                    state.robots[src_name] = src_model
                calib = None
                if src_name and model is not None:
                    from hhtools.retarget import robot_to_robot as r2r

                    calib = r2r.load_r2r_calibration(
                        model.preset.urdf_path.parent,
                        src_name,
                        target_robot=model.preset.name,
                    )
                if src_model is None or not calib:
                    raise RuntimeError(
                        "R2R export needs source robot loaded and calibration saved"
                    )
                path = _write_r2r_export(
                    ret, model, rec["source_motion"], state.export_root,
                    source_model=src_model,
                    calibrated_joint_q=calib,
                    entry=rec.get("r2r_entry") or {
                        "source_path": rec.get("source_path"),
                        "stem": stem,
                        "has_scene": rec.get("has_scene"),
                    },
                    stem=stem, fps=fps, fmt=fmt,
                    csv_header=_parse_csv_header(csv_header),
                    yellow_foot_z=rec.get("yellow_foot_z"),
                    t_start=t0,
                    t_end=t1,
                )
            else:
                path = _write_export(
                    ret, model, rec["source_motion"], state.export_root,
                    stem=stem, fps=fps, fmt=fmt, backend=rec["backend"],
                    csv_header=_parse_csv_header(csv_header),
                    source_path=rec.get("source_path"),
                    yellow_foot_z=rec.get("yellow_foot_z"),
                    t_start=t0,
                    t_end=t1,
                )
        except Exception as err:  # noqa: BLE001
            raise HTTPException(status_code=400, detail=f"export failed: {err}") from err
        if path.suffix == ".zip":
            return FileResponse(
                path,
                filename=f"{stem}_export.zip",
                media_type="application/zip",
            )
        return FileResponse(path, filename=path.name, media_type="text/csv")

    # --------------------------------------------------- robot-to-robot (R2R)

    def _r2r_get_model(name: str, *, compile_mjcf: bool = True):
        model = state.robots.get(name)
        if model is None:
            from hhtools.robot.loader import load_robot
            from hhtools.robot.registry import get as _get_preset

            model = load_robot(_get_preset(name), compile_mjcf=compile_mjcf)
            state.robots[name] = model
        return model

    @app.post("/api/r2r/source/upload")
    async def r2r_source_upload(
        files: list[UploadFile] = File(...),
        source_robot: str = "",
        profile: str = "auto",
        source_fps: float | None = None,
    ) -> dict:
        """Upload robot trajectory clip(s); FK runs in a background job with progress."""
        if not files:
            raise HTTPException(status_code=400, detail="no trajectory file uploaded")
        if not source_robot:
            raise HTTPException(status_code=400, detail="source_robot is required")
        src_fps = _parse_optional_fps(source_fps)
        admission = _reserve_job_slot()
        drop = state.upload_root / f"r2r_{uuid.uuid4().hex[:8]}"
        scheduled = False
        try:
            drop.mkdir(parents=True, exist_ok=True)
            stored = await _store_uploads(files, drop)
            if not stored:
                raise HTTPException(status_code=400, detail="empty upload")
            job = _schedule_job(
                "r2r_source_upload",
                {
                    "source_robot": source_robot,
                    "profile": profile,
                    "source_fps": src_fps,
                    "file_count": len(stored),
                    "files": [relative.as_posix() for relative, _path in stored],
                },
                _run_r2r_source_upload_job,
                args=(drop, source_robot, profile, state, src_fps),
                reservation=admission,
            )
            scheduled = True
            return {"job_id": job.id}
        finally:
            if not scheduled:
                admission.cancel()
                shutil.rmtree(drop, ignore_errors=True)

    @app.post("/api/r2r/source/library")
    async def r2r_source_library(body: dict) -> dict:
        """Load one existing robot trajectory without crossing into H2R data."""
        from hhtools.web.motion_library_links import library_entry_for_load
        from hhtools.web.r2r_upload_resolve import r2r_clip_ref_for_path

        source_robot = str(body.get("source_robot") or "").strip()
        if not source_robot:
            raise HTTPException(status_code=400, detail="source_robot is required")
        try:
            entry = library_entry_for_load(
                dataset=str(body.get("dataset") or "unknown"),
                folder_label=str(body.get("folder_label") or ""),
                sequence_id=str(body.get("sequence_id") or ""),
                source_path=str(body.get("source_path") or ""),
            )
            profile = str(body.get("upload_profile") or body.get("profile") or "auto")
            clip_ref = r2r_clip_ref_for_path(entry.source_path, profile)
            source_fps = _parse_optional_fps(body.get("source_fps"))
        except (FileNotFoundError, TypeError, ValueError) as err:
            raise HTTPException(status_code=422, detail=str(err)) from err

        job = _schedule_job(
            "r2r_source_library",
            {
                "source_robot": source_robot,
                "profile": clip_ref.profile,
                "source_fps": source_fps,
                "source_path": str(clip_ref.path),
            },
            _run_r2r_source_upload_job,
            args=(
                clip_ref.path.parent,
                source_robot,
                clip_ref.profile,
                state,
                source_fps,
                clip_ref.path,
            ),
        )
        return {"job_id": job.id}

    @app.get("/api/r2r/scene_glb")
    def r2r_scene_glb(token: str, mesh: str, scale: float | None = None) -> Response:
        """Serve an interaction-object mesh from an uploaded R2R clip folder."""
        from types import SimpleNamespace

        from hhtools.web.serialize import object_mesh_glb

        rec = state.r2r_sources.get(token)
        if rec is None:
            raise HTTPException(status_code=404, detail="r2r source token not found")
        clip_dir = Path(rec.get("clip_dir") or Path(rec["source_path"]).parent)
        safe = Path(mesh).name
        path = (clip_dir / safe).resolve()
        if not path.is_file() or clip_dir.resolve() not in path.parents:
            raise HTTPException(status_code=404, detail="mesh not found")
        scale_override = float(scale) if scale is not None and scale > 0 else None
        glb = object_mesh_glb(
            SimpleNamespace(mesh_path=str(path), scale=scale_override or 1.0),
            scale=scale_override,
        )
        if glb is None:
            raise HTTPException(status_code=404, detail="mesh export failed")
        return Response(content=glb, media_type="model/gltf-binary")

    @app.post("/api/r2r/calibration/session")
    async def r2r_calibration_session(body: dict) -> dict:
        target = body.get("target")
        source = body.get("source")
        if not target or not source:
            raise HTTPException(status_code=400, detail="target and source required")
        try:
            tgt = _r2r_get_model(target)
            src = _r2r_get_model(source, compile_mjcf=False)
            return _build_r2r_calibration_session(tgt, src)
        except ValueError as err:
            raise HTTPException(status_code=400, detail=str(err)) from err
        except Exception as err:  # noqa: BLE001
            _log.exception("r2r calibration session failed")
            raise HTTPException(status_code=500, detail=str(err)) from err

    @app.post("/api/r2r/calibration/save")
    async def r2r_calibration_save(body: dict) -> dict:
        from hhtools.retarget import robot_to_robot as r2r

        target = body.get("target")
        source = body.get("source")
        joint_q = {str(k): float(v) for k, v in body.get("joint_q", {}).items()}
        if not target or not source:
            raise HTTPException(status_code=400, detail="target and source required")
        try:
            tgt = _r2r_get_model(target, compile_mjcf=False)
            path = r2r.save_r2r_calibration(
                tgt.preset.urdf_path.parent,
                target_robot=tgt.preset.name,
                source_robot=source,
                calibrated_joint_q=joint_q,
            )
        except Exception as err:  # noqa: BLE001
            raise HTTPException(
                status_code=400, detail=f"calibration save failed: {err}",
            ) from err
        return {"ok": True, "path": str(path)}

    @app.get("/api/r2r/calibration/status")
    def r2r_calibration_status(target: str, source: str) -> dict:
        from hhtools.retarget import robot_to_robot as r2r
        from hhtools.robot.registry import get as _get_preset

        try:
            preset = _get_preset(target)
            saved = r2r.load_r2r_calibration(
                preset.urdf_path.parent,
                source,
                target_robot=preset.name,
            )
        except Exception:  # noqa: BLE001
            saved = None
        return {"calibrated": bool(saved)}

    def _run_r2r_retarget_job(job: Job, body: dict) -> None:
        try:
            job.progress = 0.01
            job.message = "正在准备 robot-to-robot retarget…"
            target = body["target"]
            source = body["source"]
            token = body["source_token"]
            ik_iters = int(body.get("ik_iterations", 24))
            retarget_fps = _parse_optional_fps(body.get("retarget_fps"))
            backend = (body.get("backend") or "newton").strip().lower()

            rec = state.r2r_sources.get(token)
            if rec is None:
                raise ValueError("source trajectory expired; re-upload the clip")
            job.request = _snapshot_job_request(
                {
                    **job.request,
                    "target": target,
                    "source": source,
                    "source_path": rec.get("source_path"),
                    "backend": backend,
                    "ik_iterations": ik_iters,
                    "retarget_fps": retarget_fps,
                }
            )

            from hhtools.retarget import robot_to_robot as r2r

            tgt = _r2r_get_model(target)
            src = _r2r_get_model(source, compile_mjcf=False)
            calib = r2r.load_r2r_calibration(
                tgt.preset.urdf_path.parent,
                source,
                target_robot=tgt.preset.name,
            )
            if not calib:
                raise ValueError(
                    "target robot is not calibrated against this source robot; "
                    "run the calibration step first"
                )

            if backend != "interaction_mesh":
                _require_newton_package()
                _join_robot_prewarm(state, target, job)

            motion_src = rec["motion"]
            motion, _eff_fps = _motion_for_retarget(motion_src, retarget_fps)
            motion = _r2r_prepare_retarget_motion(
                motion,
                backend=backend,
                clip_dir=rec.get("clip_dir"),
                robot_path=rec.get("source_path"),
                profile=str(rec.get("upload_profile") or "mimic"),
                has_scene=bool(rec.get("has_scene")),
            )

            def _cb(done: int, total: int) -> None:
                _r2r_retarget_progress_cb(job, backend, done=done, total=total)

            ret = r2r.retarget_robot_to_robot(
                src, tgt,
                calibrated_joint_q=calib,
                source_motion=motion,
                backend=backend,
                ik_iterations=ik_iters,
                progress_callback=_cb,
            )
            from hhtools.web.serialize import serialize_robot_trajectory

            scaled = _compute_r2r_scaled_preview(src, tgt, motion, calib)
            traj = serialize_robot_trajectory(
                tgt,
                ret,
                scaled_preview=scaled,
                ground_follow=False,
                yellow_align="ankle",
            )
            from hhtools.web.result_diagnostics import build_result_diagnostics

            diagnostics = build_result_diagnostics(
                traj,
                scaled,
                ik_map=tgt.preset.ik_map,
                feet=tgt.preset.feet,
            )
            from hhtools.web.r2r_export_bundle import clip_has_export_scene
            from hhtools.web.r2r_scene import compute_r2r_target_scaled_scene
            from hhtools.web.serialize import _scaled_overlay_foot_z

            stem = rec.get("stem") or "r2r"
            clip_dir_path = Path(rec.get("clip_dir") or Path(rec["source_path"]).parent)
            scene_prof = str(rec.get("upload_profile") or "mimic")
            src_has_scene = bool(rec.get("has_scene")) or clip_has_export_scene(
                clip_dir_path, stem=stem, profile=scene_prof,
            )
            tgt_scene = None
            if src_has_scene and rec.get("clip_dir") and rec.get("source_path"):
                tgt_scene = compute_r2r_target_scaled_scene(
                    src,
                    tgt,
                    motion,
                    calib,
                    clip_dir=Path(rec["clip_dir"]),
                    profile=scene_prof,
                    robot_path=Path(rec["source_path"]),
                    num_frames=int(ret.num_frames),
                    framerate=float(ret.sample_rate),
                )
            export_token = uuid.uuid4().hex[:10]
            has_scene = src_has_scene
            state.motions[f"export::{export_token}"] = {
                "retargeted": ret,
                "robot": target,
                "source_motion": motion,
                "backend": backend,
                "stem": stem,
                "has_scene": has_scene,
                "source_path": rec.get("source_path"),
                "r2r": True,
                "source_robot": source,
                "yellow_foot_z": _scaled_overlay_foot_z(scaled, 0),
                "r2r_entry": {
                    "source_path": rec.get("source_path"),
                    "clip_dir": rec.get("clip_dir"),
                    "stem": stem,
                    "has_scene": has_scene,
                    "upload_profile": scene_prof,
                },
            }
            job.result = {
                "trajectory": traj,
                "export_token": export_token,
                "stem": rec.get("stem") or "r2r",
                "num_frames": ret.num_frames,
                "source_fps": float(ret.sample_rate),
                "scaled_preview": scaled,
                "scaled_scene": tgt_scene,
                "diagnostics": diagnostics,
                "has_scene": has_scene,
            }
            job.progress = 1.0
            job.message = "done"
            job.mark_terminal("done")
        except Exception as err:  # noqa: BLE001
            _log.exception("r2r retarget job failed")
            job.error = str(err)
            job.mark_terminal("error")

    @app.post("/api/r2r/retarget")
    async def r2r_retarget(body: dict) -> dict:
        job = _schedule_job(
            "r2r_retarget", body, _run_r2r_retarget_job, args=(body,),
        )
        return {"job_id": job.id}

    @app.post("/api/r2r/basket/upload")
    async def r2r_basket_upload(
        files: list[UploadFile] = File(...),
        profile: str = "auto",
    ) -> dict:
        admission = _reserve_job_slot()
        drop = state.upload_root / uuid.uuid4().hex[:8]
        scheduled = False
        try:
            drop.mkdir(parents=True, exist_ok=True)
            stored = await _store_uploads(files, drop)
            if not stored:
                raise HTTPException(status_code=400, detail="empty upload")
            job = _schedule_job(
                "r2r_basket_upload",
                {
                    "profile": profile,
                    "file_count": len(stored),
                    "files": [relative.as_posix() for relative, _path in stored],
                },
                _run_r2r_basket_upload_job,
                args=(drop, profile),
                reservation=admission,
            )
            scheduled = True
            return {"job_id": job.id}
        finally:
            if not scheduled:
                admission.cancel()
                shutil.rmtree(drop, ignore_errors=True)

    @app.post("/api/r2r/basket/scan")
    def r2r_basket_scan(body: dict) -> dict:
        """Enumerate R2R clips on a server-local path (no copy)."""
        from hhtools.web.r2r_upload_resolve import enumerate_r2r_clips, validate_r2r_upload

        raw = str(body.get("source") or "").strip()
        profile = str(body.get("profile") or "auto").strip() or "auto"
        if not raw:
            raise HTTPException(status_code=400, detail="请填写本机目录路径")
        root = Path(raw).expanduser()
        if not root.is_dir():
            raise HTTPException(status_code=400, detail=f"目录不存在：{root}")
        root = root.resolve()
        try:
            validate_r2r_upload(root, profile)
        except ValueError as err:
            raise HTTPException(status_code=400, detail=str(err)) from err
        clips = enumerate_r2r_clips(root, profile)
        if not clips:
            raise HTTPException(status_code=400, detail="未找到可识别的机器人轨迹 clip")
        entries = [_r2r_entry_from_upload(root, ref) for ref in clips]
        return {
            "entries": entries,
            "clip_count": len(entries),
            "source": str(root),
            "profile": profile,
        }

    @app.post("/api/r2r/batch/retarget")
    async def r2r_batch_retarget(body: dict) -> dict:
        job = _schedule_job(
            "r2r_batch", body, _run_r2r_batch_job, args=(body, state),
        )
        return {"job_id": job.id}

    # ----------------------------------------------------------------- static

    if static_dir.is_dir():
        app.mount("/", StaticFiles(directory=str(static_dir), html=True), name="static")

    # Added last so it is the outermost user middleware in Starlette's stack:
    # malformed or oversized Agent requests are rejected before desktop/UI
    # middleware, routing, JSON parsing, or any service is reached.
    app.add_middleware(AgentBoundaryMiddleware)

    return app


def create_app(
    *,
    source_root: Path,
    save_dir: Path,
    cache_dir: Path | None = None,
    desktop_session_secret: str | None = None,
    desktop_allowed_host: str | None = None,
    desktop_allowed_origin: str | None = None,
    max_upload_files: int = _DEFAULT_MAX_UPLOAD_FILES,
    max_upload_file_bytes: int = _DEFAULT_MAX_UPLOAD_FILE_BYTES,
    max_upload_request_bytes: int = _DEFAULT_MAX_UPLOAD_REQUEST_BYTES,
    max_running_jobs: int = _DEFAULT_MAX_RUNNING_JOBS,
    max_queued_jobs: int = _DEFAULT_MAX_QUEUED_JOBS,
    max_retained_jobs: int = _DEFAULT_MAX_RETAINED_JOBS,
    job_ttl_seconds: float = _DEFAULT_JOB_TTL_SECONDS,
    job_history_dir: Path | None = None,
    job_settings_path: Path | None = None,
    agent_mcp_available: bool = False,
    agent_rest_available: bool = True,
    agent_json_cli_available: bool = True,
):
    """Build one local runtime with exclusive ownership of its Agent jobs.

    Job recovery and GPU scheduling are process-local.  The operating-system
    lease is therefore acquired before any Agent store or ``JobManager`` is
    constructed, and is transferred to the application lifespan on success.
    """

    runtime_lease = AgentRuntimeLease.acquire(Path(save_dir) / ".hhtools-agent")
    try:
        return _create_app_owned(
            source_root=source_root,
            save_dir=save_dir,
            cache_dir=cache_dir,
            desktop_session_secret=desktop_session_secret,
            desktop_allowed_host=desktop_allowed_host,
            desktop_allowed_origin=desktop_allowed_origin,
            max_upload_files=max_upload_files,
            max_upload_file_bytes=max_upload_file_bytes,
            max_upload_request_bytes=max_upload_request_bytes,
            max_running_jobs=max_running_jobs,
            max_queued_jobs=max_queued_jobs,
            max_retained_jobs=max_retained_jobs,
            job_ttl_seconds=job_ttl_seconds,
            job_history_dir=job_history_dir,
            job_settings_path=job_settings_path,
            agent_mcp_available=agent_mcp_available,
            agent_rest_available=agent_rest_available,
            agent_json_cli_available=agent_json_cli_available,
            agent_runtime_lease=runtime_lease,
        )
    except BaseException:
        runtime_lease.release()
        raise


def _enrich_basket_entry(entry: dict, fallback: str = "smpl") -> dict:
    """Attach stable calibration and Motion Library UX metadata."""
    from hhtools.web.motion_library_categories import infer_motion_category

    out = dict(entry)
    if not (out.get("reference") or "").strip():
        out["reference"] = _entry_reference(out, fallback)
    # Keep category semantics on the API boundary. The renderer must not infer
    # object/terrain workflows from volatile adapter or folder display names.
    out["motion_category"] = infer_motion_category(out)
    explicit_kind = str(out.get("asset_kind") or "").strip().casefold()
    if explicit_kind in {"human_motion", "robot_trajectory"}:
        out["asset_kind"] = explicit_kind
    else:
        dataset = str(out.get("dataset") or "").strip().casefold()
        out["asset_kind"] = (
            "robot_trajectory" if dataset in {"robot", "r2r"} else "human_motion"
        )
    return out


def _matching_materialized_clip(
    library_root: Path,
    *,
    snapshot_root: Path,
    snapshot_picked: Path,
    profile: str,
) -> Path:
    """Match a loaded snapshot clip to its newly materialized library path."""

    from hhtools.web.upload_resolve import enumerate_upload_clips

    library_root = Path(library_root).resolve()
    snapshot_root = Path(snapshot_root).resolve()
    snapshot_picked = Path(snapshot_picked).resolve()
    candidates = enumerate_upload_clips(library_root, profile)
    if not candidates:
        raise ValueError("动作已解析，但发布后的 Motion Library 中没有可识别文件。")
    try:
        snapshot_parts = snapshot_picked.relative_to(snapshot_root).parts
    except ValueError:
        snapshot_parts = (snapshot_picked.name,)

    def score(candidate: Any) -> tuple[int, bool]:
        # Keep the candidate lexical while deriving its library-relative
        # suffix.  ``resolve()`` here would follow file/directory symlinks out
        # of the library and collapse distinct paths such as ``a/clip.bvh``
        # and ``b/clip.bvh`` to their external targets.
        candidate_path = Path(candidate.path)
        try:
            candidate_parts = candidate_path.relative_to(library_root).parts
        except ValueError:
            try:
                candidate_parts = candidate_path.absolute().relative_to(
                    library_root
                ).parts
            except ValueError:
                candidate_parts = (candidate_path.name,)
        matching_suffix = 0
        for left, right in zip(
            reversed(snapshot_parts), reversed(candidate_parts), strict=False,
        ):
            if left != right:
                break
            matching_suffix += 1
        return matching_suffix, candidate_path.name == snapshot_picked.name

    return Path(max(candidates, key=score).path).resolve()


def _library_entry_from_link(
    folder_label: str,
    lib_dir: Path,
    picked: Path,
    dataset: str | None,
) -> dict:
    """Build a library-shaped entry for a clip under the managed library root."""
    from hhtools.web.motion_library_links import scan_motions_library

    picked = Path(picked).resolve()
    sp = str(picked)
    for raw in scan_motions_library():
        if raw.get("source_path") == sp:
            return _enrich_basket_entry(raw)

    lib_dir = Path(lib_dir).resolve()
    stem = picked.stem
    sequence_id = picked.name
    try:
        rel = picked.relative_to(lib_dir)
        stem = rel.with_suffix("").as_posix() if rel.parts else picked.stem
    except ValueError:
        pass
    return _enrich_basket_entry({
        "dataset": dataset or "unknown",
        "folder_label": folder_label,
        "sequence_id": sequence_id,
        "source_path": sp,
        "stem": stem,
        "label": f"{folder_label} · {stem}",
        "origin": "link",
    })


def _library_entry_from_upload(
    drop_dir: Path,
    picked: Path,
    dataset: str | None,
    profile: str,
    *,
    upload_profile: str | None = None,
    clip_kind: str = "",
) -> dict:
    """Build a batch-basket / library-shaped entry for an uploaded clip."""
    from hhtools.web.upload_resolve import export_subdir_for_clip

    picked = Path(picked).resolve()
    drop_dir = Path(drop_dir).resolve()
    prof = (upload_profile or profile or "mimic").strip().lower()
    folder_by_profile = {
        "intermimic": "intermimic",
        "meshmimic": "meshmimic",
        "mimic": "mimic",
        "auto": "uploads",
    }
    folder_label = folder_by_profile.get(prof, "uploads")
    try:
        rel = picked.relative_to(drop_dir)
        sequence_id = rel.as_posix()
        stem = picked.parent.name if picked.parent.name == picked.stem else picked.stem
        if picked.stem.lower() == "motion_actor":
            stem = picked.parent.name or stem
    except ValueError:
        sequence_id = picked.name
        stem = picked.parent.name if picked.stem.lower() == "motion_actor" else picked.stem
    return _enrich_basket_entry({
        "dataset": dataset or "unknown",
        "folder_label": folder_label,
        "sequence_id": sequence_id,
        "source_path": str(picked),
        "stem": stem,
        "origin": "upload",
        "export_subdir": export_subdir_for_clip(drop_dir, picked),
        "upload_profile": prof,
        "clip_kind": clip_kind,
        "upload_drop": str(drop_dir),
    })


def _load_clip_for_batch(entry_dict: dict, entry, cache):
    """Load a basket clip — uploaded paths bypass adapter-only cache conversion."""
    from hhtools.viewer.cache import _attach_library_folder_label
    from hhtools.web.motion_library_links import resolve_clip_on_disk
    from hhtools.web.upload_resolve import load_clip_at_path

    if entry_dict.get("origin") != "upload":
        entry_dict = dict(entry_dict)
        entry_dict["source_path"] = str(entry.source_path)
        return cache.load_motion(entry)

    resolved = resolve_clip_on_disk(
        entry.source_path,
        extra_names=[entry_dict.get("sequence_id") or ""],
        folder_label=entry_dict.get("folder_label"),
        sequence_id=entry_dict.get("sequence_id"),
        upload_drop=entry_dict.get("upload_drop"),
    )
    entry_dict = dict(entry_dict)
    entry_dict["source_path"] = str(resolved)

    motion, dataset = load_clip_at_path(
        resolved,
        entry_dict.get("upload_profile") or "mimic",
        clip_kind=entry_dict.get("clip_kind") or "",
        load_motion_file=_load_motion_file,
        load_via_adapter=_load_via_adapter,
    )
    if dataset and entry_dict.get("dataset") in (None, "", "unknown"):
        entry_dict["dataset"] = dataset
    _attach_library_folder_label(motion, entry)
    return motion


def _format_duration(seconds: float) -> str:
    """Human-readable duration for batch ETA."""
    if not math.isfinite(seconds) or seconds < 0:
        return "估算中…"
    sec = int(seconds + 0.5)
    if sec < 60:
        return f"{sec} 秒"
    minutes, sec = divmod(sec, 60)
    if minutes < 60:
        return f"{minutes} 分 {sec} 秒"
    hours, minutes = divmod(minutes, 60)
    return f"{hours} 时 {minutes} 分"


# GPU batch: IK frame progress uses only part of each chunk's budget; export + zip
# follow.  Previously IK reached 100% of the chunk span before CSV/ZIP I/O, so
# ETA showed "1 s left" while dozens of large exports still ran.
_BATCH_CHUNK_IK_FRAC = 0.82
_BATCH_CHUNK_EXPORT_FRAC = 0.18
_BATCH_ZIP_PROGRESS = 0.985
_BATCH_EXPORT_WORKERS = 8


def _batch_chunk_ik_progress(
    progress_base: float, progress_span: float, frame_frac: float,
) -> tuple[float, float]:
    ik_clip = 0.05 + 0.95 * min(1.0, max(0.0, frame_frac))
    total = progress_base + progress_span * ik_clip * _BATCH_CHUNK_IK_FRAC
    return total, ik_clip * _BATCH_CHUNK_IK_FRAC


def _batch_chunk_export_progress(
    progress_base: float, progress_span: float, export_frac: float,
) -> tuple[float, float]:
    export_frac = min(1.0, max(0.0, export_frac))
    total = progress_base + progress_span * (
        _BATCH_CHUNK_IK_FRAC + _BATCH_CHUNK_EXPORT_FRAC * export_frac
    )
    clip_p = _BATCH_CHUNK_IK_FRAC + _BATCH_CHUNK_EXPORT_FRAC * export_frac
    return total, clip_p


def _batch_export_retargeted_chunk(
    exports: list[tuple[dict, object, object, object]],
    *,
    model,
    motion_out_dir,
    export_fps,
    fmt: str,
    backend: str,
    csv_header: bool,
    base_prog: float,
    span_prog: float,
    job,
    batch_t0: float,
    done_clips: int,
    total: int,
    written: list[str],
    failure_log,
    state,
    job_id: str,
    out_name: str,
    reference: str,
    errors: list[str],
    failures: list[dict],
    t_start: float | None = None,
    t_end: float | None = None,
):
    """Write retarget results for one GPU chunk (parallel CSV/PKL when >1 clip)."""
    from concurrent.futures import ThreadPoolExecutor, as_completed

    n_export = len(exports)
    if n_export == 0:
        return done_clips, failure_log

    workers = 1 if n_export <= 1 else min(_BATCH_EXPORT_WORKERS, n_export)
    prog_lock = threading.Lock()
    export_done = 0

    def _write_one(
        export_i: int,
        e: dict,
        motion: object,
        entry: object,
        ret: object,
    ) -> tuple[int, dict, str | None, str | None]:
        try:
            subdir = _batch_export_subdir(e)
            out_path = _write_export(
                ret, model, motion, motion_out_dir,
                stem=(motion.name or entry.stem),
                fps=export_fps, fmt=fmt, backend=backend,
                subdir=subdir, csv_header=csv_header,
                source_path=e.get("source_path"),
                t_start=t_start,
                t_end=t_end,
            )
            return export_i, e, str(out_path.relative_to(motion_out_dir)), None
        except Exception as err:  # noqa: BLE001
            return export_i, e, None, str(err)

    def _record_success(rel_path: str) -> None:
        nonlocal export_done, done_clips
        with prog_lock:
            written.append(rel_path)
            export_done += 1
            done_clips += 1
            export_frac = export_done / n_export
            prog, clip_p = _batch_chunk_export_progress(
                base_prog, span_prog, export_frac,
            )
            _set_batch_job_progress(
                job,
                f"导出 · {done_clips}/{total}",
                prog,
                batch_t0,
                clip_progress=clip_p,
            )

    def _record_failure(e: dict, reason: str) -> None:
        nonlocal export_done, done_clips, failure_log
        with prog_lock:
            failure_log = _record_batch_failure(
                failure_log, state, job_id, out_name,
                e, stage="export", reason=reason,
                reference=reference,
                errors=errors, failures=failures,
            )
            export_done += 1
            done_clips += 1
            export_frac = export_done / n_export
            prog, clip_p = _batch_chunk_export_progress(
                base_prog, span_prog, export_frac,
            )
            _set_batch_job_progress(
                job,
                f"导出失败 {e.get('stem', '?')} · {done_clips}/{total}",
                prog,
                batch_t0,
                clip_progress=clip_p,
            )

    if workers == 1:
        for export_i, (e, motion, entry, ret) in enumerate(exports):
            _, _, rel, err = _write_one(export_i, e, motion, entry, ret)
            if err is not None:
                _record_failure(e, err)
            else:
                _record_success(rel)
        return done_clips, failure_log

    with ThreadPoolExecutor(max_workers=workers) as pool:
        futs = [
            pool.submit(_write_one, i, e, motion, entry, ret)
            for i, (e, motion, entry, ret) in enumerate(exports)
        ]
        for fut in as_completed(futs):
            _, e, rel, err = fut.result()
            if err is not None:
                _record_failure(e, err)
            else:
                _record_success(rel)
    return done_clips, failure_log


def _batch_eta_suffix(progress: float, t0: float) -> str:
    """Linear ETA from elapsed time and fractional progress."""
    if progress <= 0.02 or progress >= 0.88:
        return ""
    elapsed = time.monotonic() - t0
    if elapsed <= 0:
        return ""
    remaining = elapsed * (1.0 - progress) / progress
    return f" · 预计剩余 {_format_duration(remaining)}"


def _set_batch_job_progress(
    job: Job | None,
    message: str,
    progress: float,
    t0: float,
    *,
    clip_progress: float | None = None,
) -> None:
    if job is None:
        return
    job.progress = min(0.99, max(0.0, float(progress)))
    if clip_progress is not None:
        job.clip_progress = min(1.0, max(0.0, float(clip_progress)))
    job.message = message + _batch_eta_suffix(job.progress, t0)


def _job_is_batch(job: Job | None) -> bool:
    return job is not None and job.kind in ("batch", "r2r_batch")


def _build_r2r_calibration_session(target_model, source_model) -> dict:
    """Calibration payload for aligning ``target_model`` to a source robot.

    The source robot's forward-kinematics rest pose (canonical joint names) acts
    as the reference skeleton — the robot-to-robot analogue of a human T-pose.
    """
    from hhtools.retarget import robot_to_robot as r2r
    from hhtools.web.calibration_session import (
        _joint_limits_payload,
        _reference_heading_rad,
        _robot_ground_offset_z,
        serialize_reference_skeleton,
    )

    joint_order = [
        j.name for j in target_model.actuated_joints if j.joint_type != "fixed"
    ]
    if not joint_order:
        raise ValueError("target robot has no actuated joints; check URDF / upload")
    joint_q = {n: 0.0 for n in joint_order}

    saved: dict[str, float] | None = None
    urdf_path = getattr(target_model.preset, "urdf_path", None)
    if urdf_path is not None:
        saved = r2r.load_r2r_calibration(
            urdf_path.parent,
            source_model.preset.name,
            target_robot=target_model.preset.name,
        )
        if saved:
            for name, value in saved.items():
                if name in joint_q:
                    joint_q[name] = float(value)

    ref = r2r.build_source_reference_pose(source_model)
    target_model.apply_configuration(joint_q)
    ground_z = _robot_ground_offset_z(target_model, joint_q)
    try:
        heading = _reference_heading_rad(
            target_model, ref, None, ref.name, current_q=joint_q,
        )
    except Exception:  # noqa: BLE001
        heading = 0.0
    ref_payload = serialize_reference_skeleton(ref, heading_rad=heading)
    return {
        "joint_q": joint_q,
        "joint_limits": _joint_limits_payload(target_model),
        "reference": ref_payload,
        "reference_name": ref.name,
        "ground_offset_z": ground_z,
        "has_saved_calibration": bool(saved),
    }


def _compute_r2r_scaled_preview(source_model, target_model, motion, calibrated_joint_q) -> dict:
    """Yellow scaled skeleton for R2R — uniform source→target scale, world Z kept."""
    from hhtools.retarget import robot_to_robot as r2r
    from hhtools.retarget.calibration.calibration import uniform_overlay_scale_for_motion
    from hhtools.retarget.newton_basic.scaler import HumanToRobotScaler
    from hhtools.web.scaled_preview import (
        _uniform_scaled_preview_fallback,
        resolve_scaled_overlay_z_correction,
    )

    cfg, ref = r2r._build_scaler_config(source_model, target_model, calibrated_joint_q)
    human_height = float(ref.height_m)
    ik_canons = (
        frozenset(target_model.preset.ik_map.keys())
        if target_model.preset.ik_map
        else frozenset()
    )
    scaler = HumanToRobotScaler(motion.hierarchy, cfg, human_height=human_height)
    ratio = float(
        uniform_overlay_scale_for_motion(
            cfg, human_height, motion, ik_map_keys=ik_canons,
        )
    )
    z_correction = resolve_scaled_overlay_z_correction(motion, scaler, ratio)
    # Do **not** snap yellow ankles to z=0.  R2R source motions declare the
    # mesh-sole plane (``source_floor_z_world``); after that subtract, ankles
    # sit one sole-thickness above the ground.  Snapping them to z=0 then
    # planting the target mesh on the same plane floats the robot above the
    # overlay by that thickness.
    return _uniform_scaled_preview_fallback(
        motion,
        cfg,
        human_height,
        ik_canons,
        z_correction=z_correction,
    )


def _align_scaled_preview_to_robot_playback(
    target_model,
    retargeted,
    scaled_preview: dict,
    trajectory: dict,
) -> dict:
    """Shift yellow overlay Z to the grounded robot sole (browser playback frame)."""
    import numpy as np

    from hhtools.robot.foot_geometry import (
        quat_xyzw_to_rotmat,
        scene_min_mesh_z,
    )
    from hhtools.web.serialize import _scaled_overlay_foot_z

    yellow_z = _scaled_overlay_foot_z(scaled_preview, 0)
    if yellow_z is None:
        return _ground_skeleton_preview(scaled_preview)

    frames = trajectory.get("frames") or []
    if not frames:
        return _ground_skeleton_preview(scaled_preview)

    idx = trajectory.get("frame_indices") or [0]
    f0 = int(idx[0]) if idx else 0
    root = np.asarray(retargeted.root_trajectory[f0], dtype=np.float64)
    mesh_lift = float(frames[0].get("mesh_z_lift") or 0.0)
    ret_dof_names = list(retargeted.dof_names)
    dof0 = np.asarray(retargeted.dof_trajectory[f0], dtype=np.float64)
    cfg0 = {ret_dof_names[i]: float(dof0[i]) for i in range(len(ret_dof_names))}
    target_model.apply_configuration(cfg0)
    root_rot = quat_xyzw_to_rotmat(root[3:7])
    # Browser playback: group.z = root.z + mesh_z_lift; sole is the mesh AABB
    # bottom (not the ankle link).  Aligning to ankle re-floats the yellow
    # skeleton by ~sole thickness and fights foot-floor snap.
    min_mesh_z = scene_min_mesh_z(target_model.trimesh_scene(), root_rot)
    robot_ref_z = (
        float(root[2] + mesh_lift + min_mesh_z) if min_mesh_z is not None else 0.0
    )

    dz = robot_ref_z - float(yellow_z)
    if abs(dz) < 1e-5:
        return scaled_preview

    positions = np.asarray(scaled_preview["positions"], dtype=np.float32).copy()
    positions[:, :, 2] += np.float32(dz)
    out = dict(scaled_preview)
    out["positions"] = np.round(positions, 4).tolist()
    return out


def _run_r2r_source_upload_job(
    job: Job,
    drop: Path,
    source_robot: str,
    profile: str,
    state: SessionState,
    source_fps: float | None = None,
    selected_path: Path | None = None,
) -> None:
    from hhtools.retarget import robot_to_robot as r2r
    from hhtools.web.r2r_export_bundle import clip_has_export_scene
    from hhtools.web.r2r_upload_resolve import (
        detect_r2r_profile,
        enumerate_r2r_clips,
        r2r_clip_ref_for_path,
        validate_r2r_upload,
    )
    from hhtools.web.serialize import (
        serialize_motion_skeleton_preview,
        serialize_robot_trajectory,
    )

    try:
        job.progress = 0.02
        job.message = "正在识别轨迹格式…"
        if selected_path is not None:
            clip_ref = r2r_clip_ref_for_path(selected_path, profile)
            prof = clip_ref.profile
        else:
            validate_r2r_upload(drop, profile)
            prof = (profile or "auto").strip().lower()
            if prof == "auto":
                prof = detect_r2r_profile(drop)
            clips = enumerate_r2r_clips(drop, prof)
            if not clips:
                raise ValueError("no robot trajectory clip found under upload")
            clip_ref = clips[0]
        picked = clip_ref.path
        stem = picked.stem
        clip_dir = picked.parent
        scene_prof = clip_ref.profile or prof

        job.progress = 0.08
        job.message = "正在读取轨迹文件…"
        src_model = state.robots.get(source_robot)
        if src_model is None:
            from hhtools.robot.loader import load_robot
            from hhtools.robot.registry import get as _get_preset

            src_model = load_robot(_get_preset(source_robot), compile_mjcf=False)
            state.robots[source_robot] = src_model
        traj = r2r.load_source_trajectory(
            picked, source_model=src_model, source_fps=source_fps,
        )

        def _fk_cb(done: int, total: int) -> None:
            job.progress = 0.1 + 0.55 * (done / max(1, total))
            job.message = f"正运动学还原关键点 {done}/{total}"

        job.message = "正运动学还原关键点…"
        motion = r2r.source_trajectory_to_motion(
            src_model,
            traj.joint_q,
            traj.dof_names,
            framerate=traj.framerate,
            name=stem,
            progress_callback=_fk_cb,
        )

        job.progress = 0.72
        job.message = "正在生成机器人播放轨迹…"
        scaled_scene = None
        src_has_scene = clip_ref.has_scene or clip_has_export_scene(
            clip_dir, stem=stem, profile=scene_prof,
        )
        if src_has_scene:
            job.progress = 0.88
            job.message = "正在加载地形/物体…"
            from hhtools.web.r2r_scene import load_r2r_clip_scene

            scaled_scene = load_r2r_clip_scene(
                clip_dir,
                profile=scene_prof,
                robot_path=picked,
                num_frames=int(traj.joint_q.shape[0]),
                framerate=float(traj.framerate),
            )

        job.progress = 0.9
        job.message = "正在生成机器人播放轨迹…"
        ret_play = r2r.trajectory_to_retargeted_motion(src_model, traj, name=stem)
        playback = serialize_robot_trajectory(
            src_model,
            ret_play,
            preserve_absolute_z=bool(scaled_scene and scaled_scene.get("terrain")),
        )

        job.progress = 0.95
        job.message = "正在生成骨架预览…"
        skel = _ground_skeleton_preview(serialize_motion_skeleton_preview(motion))

        token = uuid.uuid4().hex[:10]
        state.r2r_sources[token] = {
            "source_robot": source_robot,
            "motion": motion,
            "framerate": float(traj.framerate),
            "num_frames": int(traj.joint_q.shape[0]),
            "stem": stem,
            "source_path": str(picked),
            "clip_dir": str(clip_dir),
            "has_scene": bool(src_has_scene),
            "upload_profile": scene_prof,
            "scaled_scene": scaled_scene,
        }
        job.result = {
            "token": token,
            "source_robot": source_robot,
            "num_frames": int(traj.joint_q.shape[0]),
            "framerate": float(traj.framerate),
            "dof_names": list(traj.dof_names),
            "trajectory": playback,
            "skeleton_preview": skel,
            "scaled_scene": scaled_scene,
            "has_scene": bool(src_has_scene),
            "upload_profile": scene_prof,
            "name": stem,
            "suggested_backend": r2r.suggested_r2r_backend(
                scene_prof, has_scene=bool(src_has_scene),
            ),
        }
        job.progress = 1.0
        job.message = "done"
        job.mark_terminal("done")
    except Exception as err:  # noqa: BLE001
        _log.exception("r2r source upload job failed")
        job.error = str(err)
        job.mark_terminal("error")


def _ground_skeleton_preview(payload: dict) -> dict:
    """Shift skeleton positions so the clip-wide lowest joint rests on z=0."""
    import numpy as np

    from hhtools.core.grounding import clip_floor_z_in_positions

    positions = np.asarray(payload.get("positions") or [], dtype=np.float32)
    if positions.size == 0:
        return payload
    z_ref = float(clip_floor_z_in_positions(positions))
    positions = positions.copy()
    positions[:, :, 2] -= np.float32(z_ref)
    out = dict(payload)
    out["positions"] = np.round(positions, 4).tolist()
    return out


def _r2r_entry_from_upload(drop_dir: Path, ref) -> dict:
    from hhtools.web.r2r_upload_resolve import export_subdir_for_r2r_clip

    picked = Path(ref.path).resolve()
    drop_dir = Path(drop_dir).resolve()
    prof = (ref.profile or "mimic").strip().lower()
    folder_by_profile = {
        "intermimic": "intermimic",
        "meshmimic": "meshmimic",
        "mimic": "mimic",
    }
    try:
        rel = picked.relative_to(drop_dir)
        sequence_id = rel.as_posix()
        stem = picked.parent.name if picked.parent.name == picked.stem else picked.stem
    except ValueError:
        sequence_id = picked.name
        stem = picked.stem
    from hhtools.retarget import robot_to_robot as r2r

    return {
        "dataset": "r2r",
        "asset_kind": "robot_trajectory",
        "folder_label": folder_by_profile.get(prof, "r2r"),
        "sequence_id": sequence_id,
        "source_path": str(picked),
        "clip_dir": str(picked.parent),
        "stem": stem,
        "origin": "upload",
        "export_subdir": export_subdir_for_r2r_clip(drop_dir, picked),
        "upload_profile": prof,
        "clip_kind": ref.clip_kind or "",
        "has_scene": bool(ref.has_scene),
        "upload_drop": str(drop_dir),
        "suggested_backend": r2r.suggested_r2r_backend(
            prof, has_scene=bool(ref.has_scene),
        ),
    }


def _run_r2r_basket_upload_job(job: Job, drop: Path, profile: str) -> None:
    from hhtools.web.r2r_upload_resolve import enumerate_r2r_clips, validate_r2r_upload

    try:
        validate_r2r_upload(drop, profile)
        clips = enumerate_r2r_clips(drop, profile)
        entries = [_r2r_entry_from_upload(drop, ref) for ref in clips]
        job.result = {
            "entries": entries,
            "clip_count": len(entries),
            "upload_root": str(drop),
            "profile": profile,
        }
        job.progress = 1.0
        job.message = f"已识别 {len(entries)} 个机器人轨迹 clip"
        job.mark_terminal("done")
    except Exception as err:  # noqa: BLE001
        _log.exception("r2r basket upload failed")
        job.error = str(err)
        job.mark_terminal("error")


def _r2r_prepare_retarget_motion(
    motion,
    *,
    backend: str,
    clip_dir: Path | str | None,
    robot_path: Path | str | None,
    profile: str,
    has_scene: bool,
):
    """Attach terrain/objects when the Interaction-Mesh backend is selected."""
    if (backend or "newton").strip().lower() != "interaction_mesh":
        return motion
    if not has_scene or clip_dir is None or robot_path is None:
        return motion
    from hhtools.web.r2r_scene import attach_r2r_clip_scene_to_motion

    return attach_r2r_clip_scene_to_motion(
        motion,
        Path(clip_dir),
        profile=profile,
        robot_path=Path(robot_path),
    )


def _r2r_retarget_progress_cb(
    job: Job | None,
    backend: str,
    *,
    done: int,
    total: int,
) -> None:
    if job is None:
        return
    backend = (backend or "newton").strip().lower()
    if backend == "interaction_mesh":
        if done <= 0:
            _set_retarget_job_clip_progress(
                job, 0.08, "正在构建 Interaction-Mesh 场景…",
            )
        else:
            _set_retarget_job_clip_progress(
                job,
                min(0.98, 0.1 + 0.88 * (done / max(1, total))),
                f"MPC 求解 {done}/{total}",
            )
        return
    if done <= 0:
        _set_retarget_job_clip_progress(job, 0.08, "正在准备逐帧 IK…")
    else:
        _set_retarget_job_clip_progress(
            job,
            min(0.98, 0.1 + 0.88 * (done / max(1, total))),
            f"IK 求解 {done}/{total}",
        )


def _r2r_retarget_from_path(
    source_model,
    target_model,
    traj_path: Path,
    *,
    calibrated_joint_q: dict[str, float],
    retarget_fps: float | None,
    ik_iters: int,
    backend: str = "newton",
    profile: str = "mimic",
    has_scene: bool = False,
    source_fps: float | None = None,
    job: Job | None = None,
):
    from hhtools.retarget import robot_to_robot as r2r

    traj = r2r.load_source_trajectory(
        traj_path, source_model=source_model, source_fps=source_fps,
    )
    motion_src = r2r.source_trajectory_to_motion(
        source_model,
        traj.joint_q,
        traj.dof_names,
        framerate=traj.framerate,
        name=traj_path.stem,
    )
    motion, _eff_fps = _motion_for_retarget(motion_src, retarget_fps)
    motion = _r2r_prepare_retarget_motion(
        motion,
        backend=backend,
        clip_dir=traj_path.parent,
        robot_path=traj_path,
        profile=profile,
        has_scene=has_scene,
    )

    def _cb(done: int, total: int) -> None:
        _r2r_retarget_progress_cb(job, backend, done=done, total=total)

    ret = r2r.retarget_robot_to_robot(
        source_model,
        target_model,
        calibrated_joint_q=calibrated_joint_q,
        source_motion=motion,
        backend=backend,
        ik_iterations=ik_iters,
        progress_callback=_cb if job is not None else None,
    )
    return ret, motion


def _run_r2r_batch_job(job: Job, body: dict, state: SessionState) -> None:
    try:
        target = body["target"]
        source = body["source"]
        entries = body.get("entries") or []
        if not entries:
            raise ValueError("batch entries list is empty")
        ik_iters = int(body.get("ik_iterations", 24))
        retarget_fps = _parse_optional_fps(body.get("retarget_fps"))
        source_fps = _parse_optional_fps(body.get("source_fps"))
        export_fps = _parse_optional_fps(body.get("export_fps", body.get("fps")))
        export_t_start = _parse_optional_time(body.get("t_start"), name="t_start")
        export_t_end = _parse_optional_time(body.get("t_end"), name="t_end")
        fmt = (body.get("format") or "csv").lower()
        csv_header = _parse_csv_header(body.get("csv_header", True))
        out_name = body.get("out_dir") or "r2r_batch_export"
        backend = (body.get("backend") or "newton").strip().lower()

        job.request = _snapshot_job_request(
            {
                **job.request,
                "target": target,
                "source": source,
                "entries": entries,
                "backend": backend,
                "ik_iterations": ik_iters,
                "retarget_fps": retarget_fps,
                "source_fps": source_fps,
                "export_fps": export_fps,
                "format": fmt,
                "csv_header": csv_header,
                "out_dir": out_name,
            }
        )

        from hhtools.retarget import robot_to_robot as r2r

        tgt = state.robots.get(target)
        if tgt is None:
            from hhtools.robot.loader import load_robot
            from hhtools.robot.registry import get as _get_preset

            tgt = load_robot(_get_preset(target), compile_mjcf=True)
            state.robots[target] = tgt
        src = state.robots.get(source)
        if src is None:
            from hhtools.robot.loader import load_robot
            from hhtools.robot.registry import get as _get_preset

            src = load_robot(_get_preset(source), compile_mjcf=False)
            state.robots[source] = src
        calib = r2r.load_r2r_calibration(
            tgt.preset.urdf_path.parent,
            source,
            target_robot=tgt.preset.name,
        )
        if not calib:
            raise ValueError(
                f"target {target!r} is not calibrated against source {source!r}"
            )

        if backend != "interaction_mesh":
            _require_newton_package()
            _join_robot_prewarm(state, target, job)

        out_dir = state.export_root / f"r2r_batch_{job.id}"
        out_dir.mkdir(parents=True, exist_ok=True)
        written: list[str] = []
        errors: list[str] = []
        failures: list[dict] = []
        total = len(entries)
        batch_t0 = time.monotonic()
        _set_batch_job_progress(job, f"R2R 批量开始 · 0/{total}", 0.0, batch_t0)

        for i, e in enumerate(entries):
            stem = e.get("stem") or Path(e.get("source_path", "clip")).stem
            _set_batch_job_progress(
                job, f"{i + 1}/{total}: {stem}", i / max(1, total), batch_t0,
                clip_progress=0.0,
            )
            traj_path = Path(e["source_path"])
            try:
                ret, motion = _r2r_retarget_from_path(
                    src, tgt, traj_path,
                    calibrated_joint_q=calib,
                    retarget_fps=retarget_fps,
                    ik_iters=ik_iters,
                    backend=backend,
                    profile=str(e.get("upload_profile") or "mimic"),
                    has_scene=bool(e.get("has_scene")),
                    source_fps=source_fps,
                    job=job,
                )
            except Exception as err:  # noqa: BLE001
                errors.append(f"{stem}: {err}")
                failures.append({"stem": stem, "stage": "retarget", "reason": str(err)})
                _set_batch_job_progress(
                    job, f"失败 {stem} · {i + 1}/{total}",
                    (i + 1) / max(1, total), batch_t0, clip_progress=1.0,
                )
                continue
            try:
                _set_batch_job_progress(
                    job,
                    f"导出 {stem} · {i + 1}/{total}",
                    i / max(1, total),
                    batch_t0,
                    clip_progress=0.99,
                )
                subdir = _batch_export_subdir(e)
                out_path = _write_r2r_export(
                    ret, tgt, motion, out_dir,
                    source_model=src,
                    calibrated_joint_q=calib,
                    entry=e,
                    stem=stem, fps=export_fps, fmt=fmt,
                    subdir=subdir, csv_header=csv_header,
                    t_start=export_t_start,
                    t_end=export_t_end,
                )
                written.append(str(out_path.relative_to(out_dir)))
            except Exception as err:  # noqa: BLE001
                errors.append(f"{stem} export: {err}")
                failures.append({"stem": stem, "stage": "export", "reason": str(err)})
            _set_batch_job_progress(
                job, f"完成 {stem} · {i + 1}/{total}",
                (i + 1) / max(1, total), batch_t0, clip_progress=1.0,
            )

        zip_path = shutil.make_archive(str(out_dir.parent / out_name), "zip", root_dir=str(out_dir))
        shutil.rmtree(out_dir, ignore_errors=True)
        job.result = {
            "written": written,
            "errors": errors,
            "failures": failures,
            "download_name": f"{out_name}.zip",
            "artifact_path": str(zip_path),
            "format": fmt,
        }
        job.progress = 1.0
        job.message = f"完成 {len(written)}/{total}"
        job.mark_terminal("done")
    except Exception as err:  # noqa: BLE001
        _log.exception("r2r batch job failed")
        job.error = str(err)
        job.mark_terminal("error")


def _set_retarget_job_clip_progress(job: Job | None, value: float, message: str) -> None:
    """Update per-clip progress during batch retarget; otherwise ``job.progress``."""
    if job is None:
        return
    v = min(0.99, max(0.0, float(value)))
    if _job_is_batch(job):
        job.clip_progress = v
    else:
        job.progress = v
    job.message = message


def _batch_export_subdir(entry: dict) -> str | None:
    """Export folder: preserve drag-in tree for uploads, else per-dataset."""
    if entry.get("origin") == "upload":
        sub = (entry.get("export_subdir") or "").strip().replace("\\", "/")
        return sub or None
    return _dataset_subdir(entry)


def _entry_reference(entry: dict, fallback: str) -> str:
    """Map a basket row to the calibration reference it needs."""
    explicit = (entry.get("reference") or "").strip()
    if explicit:
        return explicit
    dataset = (entry.get("dataset") or "").strip()
    if dataset in _DATASET_TO_REFERENCE:
        return _DATASET_TO_REFERENCE[dataset]
    return fallback


def _apply_limit_frames(motion, limit_frames):
    if not limit_frames:
        return motion
    lf = int(limit_frames)
    if motion.num_frames <= lf:
        return motion
    motion.positions = motion.positions[:lf]
    motion.quaternions = motion.quaternions[:lf]
    for o in motion.objects:
        o.positions = o.positions[:lf]
        o.quaternions = o.quaternions[:lf]
    return motion


def _load_batch_motion(entry_dict: dict, entry, cache, *, retarget_fps, limit_frames):
    from hhtools.viewer.library import LibraryEntry

    motion = _load_clip_for_batch(entry_dict, entry, cache)
    motion = _ground_motion_for_web(motion)
    motion, _ = _motion_for_retarget(motion, retarget_fps)
    return _apply_limit_frames(motion, limit_frames)


def _record_batch_failure(
    failure_log,
    state,
    job_id: str,
    out_name: str,
    entry: dict,
    *,
    stage: str,
    reason: str,
    reference: str | None,
    errors: list[str],
    failures: list[dict],
):
    from hhtools.web.batch_failure_log import BatchFailureLog, open_batch_failure_log

    if failure_log is None:
        failure_log = open_batch_failure_log(state.save_dir, job_id, out_name)
    item = failure_log.record(
        entry, stage=stage, reason=reason, reference=reference,
    )
    failures.append(item)
    errors.append(f"{item['stem']} [{stage}]: {reason}")
    return failure_log


def _run_batch_entries_sequential(
    entries,
    model,
    robot_name,
    reference,
    backend,
    ik_iters,
    human_height,
    limit_frames,
    retarget_fps,
    export_fps,
    fmt,
    csv_header,
    out_dir,
    state,
    *,
    job,
    job_id,
    out_name,
    written,
    errors,
    failures,
    failure_log,
    batch_t0: float,
    foot_clamp_anti_penetration: bool = False,
    t_start: float | None = None,
    t_end: float | None = None,
) -> BatchFailureLog | None:
    from hhtools.web.motion_library_links import library_entry_for_load

    total = len(entries)
    for i, e in enumerate(entries):
        _set_batch_job_progress(
            job,
            f"{i + 1}/{total}: {e.get('stem', '?')}",
            i / max(1, total),
            batch_t0,
            clip_progress=0.0,
        )
        ref = _entry_reference(e, reference)
        entry = library_entry_for_load(
            dataset=e["dataset"],
            folder_label=e["folder_label"],
            sequence_id=e["sequence_id"],
            source_path=e["source_path"],
            upload_drop=e.get("upload_drop"),
        )
        try:
            motion = _load_batch_motion(
                e, entry, state.cache,
                retarget_fps=retarget_fps, limit_frames=limit_frames,
            )
        except Exception as err:  # noqa: BLE001
            failure_log = _record_batch_failure(
                failure_log, state, job_id, out_name,
                e, stage="load", reason=str(err), reference=ref,
                errors=errors, failures=failures,
            )
            _set_batch_job_progress(
                job,
                f"加载失败 {e.get('stem', '?')} · {i + 1}/{total}",
                (i + 1) / max(1, total),
                batch_t0,
                clip_progress=1.0,
            )
            continue
        try:
            ret = _retarget_single(
                model, robot_name, motion, ref, backend,
                ik_iters, human_height, limit_frames, job,
                state=state,
                foot_clamp_anti_penetration=foot_clamp_anti_penetration,
            )
        except Exception as err:  # noqa: BLE001
            failure_log = _record_batch_failure(
                failure_log, state, job_id, out_name,
                e, stage="retarget", reason=str(err), reference=ref,
                errors=errors, failures=failures,
            )
            _set_batch_job_progress(
                job,
                f"重定向失败 {e.get('stem', '?')} · {i + 1}/{total}",
                (i + 1) / max(1, total),
                batch_t0,
                clip_progress=1.0,
            )
            continue
        try:
            subdir = _batch_export_subdir(e)
            out_path = _write_export(
                ret, model, motion, out_dir,
                stem=(motion.name or entry.stem), fps=export_fps,
                fmt=fmt, backend=backend, subdir=subdir,
                csv_header=csv_header,
                source_path=e.get("source_path"),
                t_start=t_start,
                t_end=t_end,
            )
            written.append(str(out_path.relative_to(out_dir)))
            _set_batch_job_progress(
                job,
                f"完成 {e.get('stem', '?')} · {i + 1}/{total}",
                (i + 1) / max(1, total),
                batch_t0,
                clip_progress=1.0,
            )
        except Exception as err:  # noqa: BLE001
            failure_log = _record_batch_failure(
                failure_log, state, job_id, out_name,
                e, stage="export", reason=str(err), reference=ref,
                errors=errors, failures=failures,
            )
            _set_batch_job_progress(
                job,
                f"失败 {e.get('stem', '?')} · {i + 1}/{total}",
                (i + 1) / max(1, total),
                batch_t0,
                clip_progress=1.0,
            )
    _set_batch_job_progress(
        job, f"批量完成 · {total}/{total}", 1.0, batch_t0, clip_progress=1.0,
    )
    return failure_log


def _retarget_newton_batch_chunk(
    loaded: list[tuple[dict, object, object]],
    *,
    model,
    robot_name: str,
    reference: str,
    ik_iters: int,
    human_height: float,
    state,
    job,
    job_id: str,
    out_name: str,
    failure_log,
    failures: list[dict],
    errors: list[str],
    progress_base: float,
    progress_span: float,
    batch_t0: float,
    chunk_label: str,
    foot_clamp_anti_penetration: bool = False,
) -> tuple[list[tuple[dict, object, object, object]], object]:
    """Retarget pre-loaded clips; multi-env GPU when ``len(loaded) > 1``."""
    from hhtools.retarget.calibration import (
        load_calibration,
        resolve_preset_calibration_file,
    )
    from hhtools.retarget.newton_basic import NewtonBasicPipeline
    from hhtools.retarget.newton_basic._warp_config import configure as configure_warp_cache
    from hhtools.robot.registry import get as get_preset

    if not loaded:
        return [], failure_log

    if len(loaded) == 1:
        e, motion, entry = loaded[0]
        ret = _retarget_single(
            model, robot_name, motion, reference, "newton",
            ik_iters, human_height, None, job,
            state=state,
            foot_clamp_anti_penetration=foot_clamp_anti_penetration,
        )
        return [(e, motion, entry, ret)], failure_log

    # Clips that share a calibration ``reference`` can still carry *different
    # source skeletons* — e.g. OMOMO (SMPL-H 24-joint) and holosoma (53-joint)
    # both map to ``smplx``.  A single GPU batch builds **one** ScalerConfig
    # keyed by the first clip's bone names; ``adapt_scaler_config_for_hierarchy``
    # then raises "no joint_scales entries resolvable" on the mismatched clips.
    # Sub-group by skeleton signature so each GPU batch shares one hierarchy.
    # Single-skeleton chunks (the common case) fall through unchanged.
    from collections import defaultdict as _defaultdict

    by_skeleton: dict[tuple, list] = _defaultdict(list)
    for item in loaded:
        sig = tuple(item[1].hierarchy.bone_names)
        by_skeleton[sig].append(item)
    if len(by_skeleton) > 1:
        merged: list[tuple[dict, object, object, object]] = []
        for group in by_skeleton.values():
            sub, failure_log = _retarget_newton_batch_chunk(
                group,
                model=model,
                robot_name=robot_name,
                reference=reference,
                ik_iters=ik_iters,
                human_height=human_height,
                state=state,
                job=job,
                job_id=job_id,
                out_name=out_name,
                failure_log=failure_log,
                failures=failures,
                errors=errors,
                progress_base=progress_base,
                progress_span=progress_span,
                batch_t0=batch_t0,
                chunk_label=chunk_label,
                foot_clamp_anti_penetration=foot_clamp_anti_penetration,
            )
            merged.extend(sub)
        return merged, failure_log

    from hhtools.robot.retarget_profile import (
        build_feet_stabilizer_config,
        build_pipeline_config_for_preset,
        bundled_scaler_path,
        resolve_retarget_scaler_config,
    )

    preset = get_preset(robot_name)
    cal_path = resolve_preset_calibration_file(preset, reference)
    if cal_path is None and bundled_scaler_path(preset, reference) is None:
        raise ValueError(
            f"robot {robot_name!r} not calibrated for reference {reference!r}; calibrate first"
        )

    _join_robot_prewarm(state, robot_name, job)
    configure_warp_cache()
    calibration = load_calibration(cal_path) if cal_path is not None else None
    scaler_cfg = resolve_retarget_scaler_config(
        preset,
        reference,
        calibration=calibration,
        model=model,
        motion=loaded[0][1],
        human_height=human_height,
    )
    feet_cfg = build_feet_stabilizer_config(preset, reference, model=model)
    _set_batch_job_progress(
        job,
        f"并行 IK {chunk_label} · 参考 {reference} · 编译内核…",
        progress_base + 0.02 * progress_span,
        batch_t0,
        clip_progress=0.02,
    )

    pipeline = NewtonBasicPipeline(
        model,
        scaler_config=scaler_cfg,
        pipeline_config=build_pipeline_config_for_preset(
            preset, reference, ik_iterations=ik_iters,
            foot_clamp_anti_penetration=foot_clamp_anti_penetration,
        ),
        feet_stabilizer_config=feet_cfg,
        human_height=human_height,
        configure_warp=False,
    )

    motions = [m for _, m, _ in loaded]
    _ik_total = {"n": 0}

    def _frame_cb(done: int, total: int) -> None:
        if job is None:
            return
        # ``run_batch`` reports IK as ``done/max_frames``, then post-IK as
        # ``max_frames + clip_i / max_frames + n_clips`` (total grows).
        if _ik_total["n"] == 0:
            _ik_total["n"] = max(1, int(total))
        if int(total) > _ik_total["n"]:
            post_done = max(0, int(done) - _ik_total["n"])
            post_tot = max(1, int(total) - _ik_total["n"])
            total_p, clip_p = _batch_chunk_ik_progress(
                progress_base, progress_span, 1.0,
            )
            post_frac = post_done / post_tot
            total_p = progress_base + progress_span * (
                _BATCH_CHUNK_IK_FRAC + 0.5 * _BATCH_CHUNK_EXPORT_FRAC * post_frac
            )
            _set_batch_job_progress(
                job,
                (
                    f"并行 IK {chunk_label} · 参考 {reference} · "
                    f"后处理 {post_done}/{post_tot}"
                ),
                total_p,
                batch_t0,
                clip_progress=clip_p,
            )
            return
        _ik_total["n"] = max(_ik_total["n"], int(total))
        ik_total = _ik_total["n"]
        frac = min(1.0, float(done) / max(1, ik_total))
        total_p, clip_p = _batch_chunk_ik_progress(
            progress_base, progress_span, frac,
        )
        _set_batch_job_progress(
            job,
            (
                f"并行 IK {chunk_label} · 参考 {reference} · "
                f"帧 {min(int(done), ik_total)}/{ik_total}（本批最长 clip）"
            ),
            total_p,
            batch_t0,
            clip_progress=clip_p,
        )

    try:
        results = pipeline.run_batch(motions, progress_callback=_frame_cb)
    except Exception as err:
        from hhtools.retarget.newton_basic.batch_limits import (
            is_ik_shared_memory_error,
            shared_memory_error_hint,
        )

        if not is_ik_shared_memory_error(err):
            raise
        _log.warning(
            "GPU batch IK failed (shared memory), falling back to sequential: %s",
            err,
        )
        hint = shared_memory_error_hint(getattr(pipeline.ctx, "joint_dof_count", None))
        if job is not None:
            _set_batch_job_progress(
                job,
                f"内核共享内存不足，改逐条 IK ×{len(loaded)}（参考 {reference}）…",
                progress_base + 0.05 * progress_span,
                batch_t0,
                clip_progress=0.0,
            )
        out: list[tuple[dict, object, object, object]] = []
        for i, (e, motion, entry) in enumerate(loaded):
            if job is not None:
                _set_batch_job_progress(
                    job,
                    f"逐条 IK {i + 1}/{len(loaded)} · {e.get('stem', '?')}（{hint}）",
                    progress_base + progress_span * (i / max(1, len(loaded))),
                    batch_t0,
                    clip_progress=0.0,
                )
            try:
                ret = _retarget_single(
                    model, robot_name, motion, reference, "newton",
                    ik_iters, human_height, None, job,
                    state=state,
                    foot_clamp_anti_penetration=foot_clamp_anti_penetration,
                )
                out.append((e, motion, entry, ret))
            except Exception as single_err:  # noqa: BLE001
                failure_log = _record_batch_failure(
                    failure_log, state, job_id, out_name,
                    e, stage="retarget", reason=str(single_err),
                    reference=reference,
                    errors=errors, failures=failures,
                )
        if not out:
            raise RuntimeError(
                f"GPU batch IK failed and all {len(loaded)} sequential retries failed "
                f"(first error: {failures[-1]['reason'] if failures else err})"
            ) from err
        return out, failure_log

    if len(results) != len(loaded):
        raise RuntimeError(
            f"run_batch returned {len(results)} results for {len(loaded)} motions"
        )
    return [
        (loaded[i][0], loaded[i][1], loaded[i][2], results[i])
        for i in range(len(loaded))
    ], failure_log


def _ground_motion_for_web(motion):
    """Centre the root at the origin (XY) and snap the lowest point to z=0.

    Matches the Viser viewer's default ``center_motion_root_xy`` +
    ``snap_motion_to_ground`` so terrain, objects and the human all sit on the
    same ground plane the browser draws its grid on.  ``margin=0`` puts the
    lowest foot/terrain point exactly on z=0 (the user's "最低点在水平面上").
    """
    try:
        from hhtools.core.coord import to_up_axis
        from hhtools.retarget.newton_basic.rest_pose import normalize_mocap_bvh_clip
        from hhtools.viewer.anatomy import center_motion_root_xy, snap_motion_to_ground

        motion = normalize_mocap_bvh_clip(motion)
        if motion.up_axis != "Z":
            motion = to_up_axis(motion, "Z")
        motion = center_motion_root_xy(motion)
        motion = snap_motion_to_ground(motion, margin=0.0)
    except Exception:  # noqa: BLE001 — never block loading on grounding
        _log.warning("grounding failed; using raw motion", exc_info=True)
    return motion


def _run_dataset_robot_preview_job(job: Job, body: dict, state: SessionState) -> None:
    from hhtools.web.motion_progress import MotionLoadProgress

    try:
        source_path = Path(str(body["source_path"]))
        robot_name = body.get("robot") or None
        load_prog = MotionLoadProgress(job, base=0.05, span=0.9)
        job.message = "读取机器人轨迹…"
        result = _build_robot_export_playback(
            source_path,
            state,
            robot_name=str(robot_name) if robot_name else None,
            progress=load_prog,
        )
        job.result = result
        job.progress = 1.0
        job.message = "完成"
        job.mark_terminal("done")
    except Exception as err:  # noqa: BLE001
        _log.exception("dataset robot preview failed")
        job.error = str(err)
        job.mark_terminal("error")


def _ensure_robot_model(state: SessionState, robot_name: str | None):
    """Load a robot preset for FK preview (from CSV meta or G1 default)."""
    from hhtools.robot.loader import load_robot
    from hhtools.robot.registry import get as get_preset
    from hhtools.robot.registry import refresh

    refresh()
    candidates = [robot_name, "unitree_g1__g1_29dof", "unitree_g1"]
    for name in candidates:
        if not name:
            continue
        cached = state.robots.get(name)
        if cached is not None:
            return cached
        try:
            preset = get_preset(name)
            model = load_robot(preset, compile_mjcf=False)
            state.robots[preset.name] = model
            return model
        except Exception as err:  # noqa: BLE001
            _log.debug("robot preset %r unavailable: %s", name, err)
    raise ValueError(
        "无法加载机器人模型以预览轨迹；请先在「机器人」面板加载对应机器人"
    )


def _build_robot_export_playback(
    source_path: Path,
    state: SessionState,
    *,
    robot_name: str | None = None,
    progress=None,
) -> dict[str, Any]:
    """Parse a robot export CSV and build mesh playback + optional scene payload."""
    from hhtools.retarget import robot_to_robot as r2r
    from hhtools.web.r2r_scene import _parse_comment_meta, load_r2r_clip_scene
    from hhtools.web.r2r_upload_resolve import detect_r2r_profile
    from hhtools.web.serialize import serialize_robot_trajectory

    path = Path(source_path).resolve()
    clip_dir = path.parent
    inferred = str(_parse_comment_meta(path).get("robot") or "").strip()
    pick = (robot_name or inferred or None)
    model = _ensure_robot_model(state, pick)
    actual = model.preset.name

    cb = progress.as_callback() if progress is not None else None
    if cb is not None:
        cb(0.12, f"读取 {path.name}…")

    traj = r2r.load_source_trajectory(path, source_model=model)
    if cb is not None:
        cb(0.45, "生成机器人播放轨迹…")
    num_frames = int(traj.joint_q.shape[0])
    framerate = float(traj.framerate)
    prof = detect_r2r_profile(clip_dir)
    scaled_scene = load_r2r_clip_scene(
        clip_dir,
        profile=prof,
        robot_path=path,
        num_frames=num_frames,
        framerate=framerate,
    )
    ret_play = r2r.trajectory_to_retargeted_motion(model, traj, name=path.stem)
    playback = serialize_robot_trajectory(
        model,
        ret_play,
        preserve_absolute_z=bool(scaled_scene and scaled_scene.get("terrain")),
    )

    preview_token = uuid.uuid4().hex[:10]
    state.dataset_previews[preview_token] = {
        "clip_dir": str(clip_dir),
        "source_path": str(path),
    }

    if cb is not None:
        cb(1.0, "就绪")

    return {
        "preview_token": preview_token,
        "trajectory": playback,
        "robot": actual,
        "inferred_robot": inferred or actual,
        "num_frames": num_frames,
        "framerate": framerate,
        "has_scene": bool(scaled_scene),
        "scaled_scene": scaled_scene,
        "name": path.stem,
    }


def _load_robot_export_for_web(
    source_path: Path,
    state: SessionState,
    *,
    progress=None,
):
    """FK a retarget robot CSV export into a :class:`Motion` for 3D preview."""
    from hhtools.retarget import robot_to_robot as r2r
    from hhtools.web.r2r_scene import (
        _parse_comment_meta,
        attach_r2r_clip_scene_to_motion,
    )
    from hhtools.web.r2r_upload_resolve import detect_r2r_profile

    path = Path(source_path).resolve()
    clip_dir = path.parent
    cb = progress.as_callback() if progress is not None else None
    if cb is not None:
        cb(0.05, f"读取机器人轨迹 {path.name}…")

    robot_name = str(_parse_comment_meta(path).get("robot") or "").strip()
    model = _ensure_robot_model(state, robot_name or None)
    traj = r2r.load_source_trajectory(path, source_model=model)

    def _fk_progress(done: int, total: int) -> None:
        if cb is not None:
            cb(0.15 + 0.55 * (done / max(1, total)), f"正运动学 {done}/{total}")

    motion = r2r.source_trajectory_to_motion(
        model,
        traj.joint_q,
        traj.dof_names,
        framerate=traj.framerate,
        name=path.stem,
        progress_callback=_fk_progress if cb is not None else None,
    )

    prof = detect_r2r_profile(clip_dir)
    try:
        motion = attach_r2r_clip_scene_to_motion(
            motion,
            clip_dir,
            profile=prof,
            robot_path=path,
        )
    except Exception as err:  # noqa: BLE001 — scene is optional for preview
        _log.warning("robot export scene attach skipped for %s: %s", path, err)

    if cb is not None:
        cb(1.0, "机器人轨迹就绪")
    return motion


def _load_motion_for_web(entry, cache, *, progress=None):
    """Load a library clip with SMPL mesh baking when the dataset supports it."""
    from hhtools.io.datasets import registered_datasets
    from hhtools.viewer.cache import _attach_library_folder_label

    cb = progress.as_callback() if progress is not None else None
    if entry.dataset in _SMPL_MESH_DATASETS:
        adapter_cls = registered_datasets().get(entry.dataset)
        if adapter_cls is not None:
            adapter = adapter_cls(entry.source_path.parent)
            try:
                if cb is not None:
                    cb(0.0, f"读取 {entry.stem}…")
                motion = adapter.load_motion(
                    entry.adapter_sequence_id,
                    with_mesh=True,
                    progress_callback=cb,
                )
                _attach_library_folder_label(motion, entry)
                return motion
            except Exception as err:
                _log.warning(
                    "with_mesh load failed for %s (%s); falling back to cache: %s",
                    entry.stem,
                    entry.dataset,
                    err,
                )
    return cache.load_motion(entry, progress_callback=cb)


def _load_motion_file(path: Path, *, progress=None):
    """Load a motion file with mesh enabled for GLB when possible."""
    cb = progress.as_callback() if progress is not None else None
    suf = path.suffix.lower()
    if suf in (".glb", ".gltf"):
        from hhtools.io.glb import load_glb

        if cb is not None:
            cb(0.1, f"解析 GLB {path.name}…")
        motion = load_glb(path, with_mesh=True)
        if cb is not None:
            cb(1.0, "GLB 解析完成")
        return motion
    if cb is not None:
        cb(0.1, f"读取 {path.name}…")
    from hhtools.io.base import load_motion

    motion = load_motion(path)
    if cb is not None:
        cb(1.0, f"已读取 {path.name}")
    return motion


def _load_via_adapter(path: Path):
    """Best-effort dataset-adapter load for non-io.base extensions."""
    suf = path.suffix.lower()
    try:
        if suf == ".bvh":
            from hhtools.io.mimic_detect import is_omnicontact_capture

            if is_omnicontact_capture(path):
                from hhtools.io.datasets.omnicontact import OmniContactAdapter

                return (
                    OmniContactAdapter(root=path.parent).load_motion(path.name),
                    "omnicontact",
                )
        if suf == ".pkl":
            from hhtools.io.datasets.omomo import OmomoAdapter
            from hhtools.io.datasets.parc_ms import ParcMsAdapter

            parent = path.parent
            try:
                if parent.name == path.stem:
                    return (
                        OmomoAdapter(root=parent.parent).load_motion(
                            f"{parent.name}/{path.name}"
                        ),
                        "omomo",
                    )
                return OmomoAdapter(root=parent).load_motion(path.name), "omomo"
            except Exception:
                pass
            try:
                if parent.name == path.stem:
                    return (
                        ParcMsAdapter(root=parent.parent).load_motion(
                            f"{parent.name}/{path.name}"
                        ),
                        "parc_ms",
                    )
                return ParcMsAdapter(root=parent).load_motion(path.name), "parc_ms"
            except Exception:
                return None, None
        if suf == ".npy":
            from hhtools.io.datasets.meshmimic_holosoma import MeshmimicHolosomaAdapter

            parent = path.parent
            if parent.name == path.stem:
                seq = f"{parent.name}/{path.name}"
                m = MeshmimicHolosomaAdapter(root=parent.parent).load_motion(seq)
                return m, "meshmimic_holosoma"
        if suf == ".npz":
            from hhtools.io.datasets.amass import AmassAdapter

            return (
                AmassAdapter(root=path.parent).load_motion(path.name, with_mesh=True),
                "amass",
            )
    except Exception:
        return None, None
    return None, None


def _dataset_subdir(entry: dict) -> str:
    """Per-dataset export subfolder (e.g. ``AMASS``, ``PHUMA``).

    Prefers the dataset adapter name, falling back to the library folder label.
    """
    import re

    raw = entry.get("dataset") or entry.get("folder_label") or "misc"
    name = str(raw).strip().replace(" ", "_")
    name = re.sub(r"[^A-Za-z0-9_.-]", "_", name) or "misc"
    return name.upper() if name.islower() and len(name) <= 12 else name


def _parse_csv_header(value) -> bool:
    """Truthy unless the client explicitly disables comments + column headers."""
    if value is None:
        return True
    if isinstance(value, bool):
        return value
    s = str(value).strip().lower()
    if s in ("0", "false", "no", "off", "none", "raw", "numeric"):
        return False
    return True


def _parse_optional_fps(value) -> float | None:
    """Positive target fps from API/JSON, or ``None`` to keep the source rate."""
    if value is None or value == "":
        return None
    try:
        fps = float(value)
    except (TypeError, ValueError):
        return None
    return fps if fps > 0 else None


def _parse_optional_time(value, *, name: str = "t") -> float | None:
    """Non-negative seconds for export window bounds, or ``None`` if omitted."""
    if value is None or value == "":
        return None
    try:
        t = float(value)
    except (TypeError, ValueError) as err:
        raise ValueError(f"{name} must be a number of seconds") from err
    if not math.isfinite(t) or t < 0.0:
        raise ValueError(f"{name} must be a non-negative finite number of seconds")
    return t


def _motion_for_retarget(motion, retarget_fps: float | None):
    """Optionally down/up-sample the clip before IK/MPC (fewer frames ⇒ faster).

    Returns ``(motion_for_solver, effective_fps)``.  When the rate is unchanged
    the same ``Motion`` instance is returned (read-only use during retarget).
    """
    from hhtools.core.resample import resample_motion_with_objects

    src = float(motion.framerate)
    target = _parse_optional_fps(retarget_fps)
    if target is None or abs(target - src) < 1e-6:
        return motion, src
    return resample_motion_with_objects(motion, target), float(target)


def _resample_retargeted(retargeted, fps: float | None):
    """Return a (joint_q, sample_rate) pair, optionally resampled to ``fps``."""
    import numpy as np

    from hhtools.web.serialize import resample_joint_q

    src = float(getattr(retargeted, "sample_rate", 30.0))
    if fps is None or fps <= 0 or abs(fps - src) < 1e-6:
        return np.asarray(retargeted.joint_q, dtype=np.float32), src
    rc = int(getattr(retargeted, "root_coord_count", 7))
    jq = resample_joint_q(retargeted.joint_q, src, float(fps), root_coord_count=rc)
    return jq, float(fps)


def _write_r2r_export(
    retargeted,
    target_model,
    source_motion,
    out_root,
    *,
    source_model,
    calibrated_joint_q: dict[str, float],
    entry: dict,
    stem: str,
    fps: float | None,
    fmt: str,
    subdir: str | None = None,
    csv_header: bool = True,
    yellow_foot_z: float | None = None,
    t_start: float | None = None,
    t_end: float | None = None,
):
    """R2R clip bundle: target robot traj + rescaled terrain/object sidecars."""
    from hhtools.web.export_bundle import resolve_clip_export_dir
    from hhtools.web.r2r_export_bundle import (
        clip_has_export_scene,
        write_r2r_export_bundle,
    )

    out_dir = Path(out_root)
    if subdir:
        out_dir = out_dir / subdir
    out_dir.mkdir(parents=True, exist_ok=True)

    path = write_r2r_export_bundle(
        retargeted,
        target_model,
        source_motion,
        source_model=source_model,
        calibrated_joint_q=calibrated_joint_q,
        entry=entry,
        out_root=out_dir,
        stem=stem,
        fps=fps,
        fmt=fmt,
        resample_fn=_resample_retargeted,
        csv_header=csv_header,
        yellow_foot_z=yellow_foot_z,
        t_start=t_start,
        t_end=t_end,
    )
    if subdir is not None and path.suffix == ".zip":
        import shutil

        from hhtools.web.r2r_export_bundle import (
            clip_has_export_scene,
            resolve_r2r_source_clip_dir,
        )

        source_clip_dir = resolve_r2r_source_clip_dir(entry)
        profile = str(entry.get("upload_profile") or "")
        has_scene = bool(entry.get("has_scene")) or (
            clip_has_export_scene(
                source_clip_dir, stem=stem, profile=profile,
            )
            if source_clip_dir is not None
            else False
        )
        clip_dir = resolve_clip_export_dir(
            out_dir, stem, entry.get("source_path"), has_scene=has_scene,
        )
        clip_dir.mkdir(parents=True, exist_ok=True)
        shutil.unpack_archive(str(path), str(clip_dir))
        path.unlink(missing_ok=True)
        return clip_dir
    return path


def _write_export(
    retargeted,
    model,
    source_motion,
    out_root,
    *,
    stem: str,
    fps: float | None,
    fmt: str,
    backend: str,
    subdir: str | None = None,
    csv_header: bool = True,
    source_path: str | Path | None = None,
    yellow_foot_z: float | None = None,
    t_start: float | None = None,
    t_end: float | None = None,
):
    """Write a browser-downloadable CSV/PKL bundle (zip when scene props exist)."""
    from hhtools.web.export_bundle import (
        motion_has_scene,
        resolve_clip_export_dir,
        write_retarget_export_bundle,
    )

    out_dir = Path(out_root)
    if subdir:
        out_dir = out_dir / subdir
    out_dir.mkdir(parents=True, exist_ok=True)

    path = write_retarget_export_bundle(
        retargeted,
        model,
        source_motion,
        out_dir,
        stem=stem,
        fps=fps,
        fmt=fmt,
        backend=backend,
        resample_fn=_resample_retargeted,
        csv_header=csv_header,
        source_path=source_path,
        yellow_foot_z=yellow_foot_z,
        t_start=t_start,
        t_end=t_end,
    )
    # Batch jobs unpack per-clip zips into the job tree (final zip later).
    if subdir is not None and path.suffix == ".zip":
        import shutil

        clip_dir = resolve_clip_export_dir(
            out_dir,
            stem,
            source_path,
            has_scene=motion_has_scene(source_motion),
        )
        clip_dir.mkdir(parents=True, exist_ok=True)
        shutil.unpack_archive(str(path), str(clip_dir))
        path.unlink(missing_ok=True)
        return clip_dir
    return path


def _read_yaml_retarget_references(drop: Path) -> dict | None:
    """Extract ``retarget.references`` from a robot dir's yaml (pre-rebuild)."""
    import yaml

    for yp in sorted(drop.glob("*.yaml")):
        if yp.name.startswith("retarget_calibration_"):
            continue
        try:
            data = yaml.safe_load(yp.read_text(encoding="utf-8")) or {}
        except Exception:  # noqa: BLE001
            continue
        refs = (data.get("retarget") or {}).get("references")
        if isinstance(refs, dict) and refs:
            return refs
    return None


def _merge_retarget_references(yaml_path: str | Path | None, refs: dict) -> None:
    """Re-attach preserved ``retarget.references`` onto a freshly scaffolded yaml."""
    import yaml

    if not yaml_path or not refs:
        return
    p = Path(yaml_path)
    if not p.is_file():
        return
    data = yaml.safe_load(p.read_text(encoding="utf-8")) or {}
    rt = data.get("retarget")
    if not isinstance(rt, dict):
        rt = {}
        data["retarget"] = rt
    existing = rt.get("references")
    if not isinstance(existing, dict):
        existing = {}
    existing.update(refs)
    rt["references"] = existing
    p.write_text(
        yaml.safe_dump(data, sort_keys=False, allow_unicode=True),
        encoding="utf-8",
    )


def _request_human_height(body: dict, preset, reference: str) -> float:
    """Resolve source-human height from the request, with a scaler-aware default.

    Falls back to a reference-family canonical height (1.65 m for SMPL / SOMA /
    LAFAN / GLB) when the UI does not send an explicit height.
    """
    from hhtools.robot.retarget_profile import default_human_height

    raw = body.get("human_height")
    if raw is not None:
        try:
            val = float(raw)
        except (TypeError, ValueError):
            val = 0.0
        if val > 0.1:
            return val
    return default_human_height(preset, reference)


def _compute_scaled_scene(
    model,
    robot_name: str,
    motion,
    reference: str,
    human_height: float,
    *,
    max_frames: int | None = None,
) -> dict | None:
    """Scaled terrain + objects in the robot retarget frame (no Viser 5 m offset).

    Mirrors :func:`hhtools.viewer.app._publish_robot_objects` but keeps everything
    co-located with the robot preview in the web UI.
    """
    import numpy as np

    if motion.terrain is None and not motion.objects:
        return None
    from hhtools.core.grounding import (
        human_source_floor_z_world,
        terrain_heightfield_z_offset_world,
    )
    from hhtools.core.scene import SceneObject
    from hhtools.retarget.calibration.calibration import uniform_overlay_scale_for_motion
    from hhtools.retarget.newton_basic.scaler import HumanToRobotScaler
    from hhtools.web.scaled_preview import (
        resolve_scaled_overlay_z_correction,
        resolve_web_scaler_config,
    )
    from hhtools.web.serialize import (
        _MAX_PLAYBACK_FRAMES,
        _downsample_indices,
        _serialize_object_meta,
        _serialize_terrain,
    )

    try:
        scaler_cfg = resolve_web_scaler_config(
            model, motion, reference, float(human_height),
        )
    except ValueError:
        return None
    scaler = HumanToRobotScaler(
        motion.hierarchy, scaler_cfg, human_height=float(human_height),
    )
    from hhtools.robot.ik_map_policy import ik_map_canonicals_for_motion

    ik_canons = ik_map_canonicals_for_motion(
        model.preset.name, model.preset.ik_map, motion,
    )
    ratio = float(
        uniform_overlay_scale_for_motion(
            scaler_cfg, float(human_height), motion, ik_map_keys=ik_canons,
        )
    )

    z_min = float(human_source_floor_z_world(motion))
    z_terrain = float(terrain_heightfield_z_offset_world(motion, z_min))
    z_correction = float(resolve_scaled_overlay_z_correction(motion, scaler, ratio))
    idx = _downsample_indices(
        motion.num_frames,
        _MAX_PLAYBACK_FRAMES if max_frames is None else max_frames,
        motion=motion,
    )

    payload: dict = {"scale_ratio": round(ratio, 5), "objects": [], "terrain": None}
    for i, ob in enumerate(motion.objects):
        op = ob.positions.astype(np.float32, copy=True)
        op[:, 2] -= z_min
        op *= ratio
        if abs(z_correction) > 1e-6:
            op[:, 2] += np.float32(z_correction)
        scaled_ob = SceneObject(
            name=f"scaled_{ob.name}",
            positions=op,
            quaternions=ob.quaternions.copy(),
            extents=ob.extents * ratio,
            mesh_path=ob.mesh_path,
            scale=ob.scale * ratio,
            opacity=ob.opacity,
            color=ob.color,
        )
        meta = _serialize_object_meta(scaled_ob, idx)
        meta["source_index"] = i
        meta["source_scale"] = float(ob.scale)
        payload["objects"].append(meta)

    if motion.terrain is not None:
        hf_robot = motion.terrain.scaled(ratio, z_offset=z_terrain)
        if abs(z_correction) > 1e-6:
            hf_robot = hf_robot.shifted(dz=z_correction)
        # PARC's ``*_foot`` joints are ankles sitting a fixed offset above the
        # sole contact surface, so ``terrain_data`` (authored to the sole) ends
        # up that much below the foot joints / robot mesh sole the viewer snaps
        # to them.  Lift parc_ms terrain by the scaled offset so the surface,
        # the yellow skeleton foot, and the robot sole coincide.
        if isinstance(motion.meta, dict) and motion.meta.get("dataset") == "parc_ms":
            from hhtools.io.parc_ms_skeleton import PARC_MS_FOOT_CONTACT_OFFSET_M

            hf_robot = hf_robot.shifted(
                dz=float(PARC_MS_FOOT_CONTACT_OFFSET_M) * ratio,
            )
        payload["terrain"] = _serialize_terrain(hf_robot)
    return payload


def _compute_scaled_preview(
    model,
    robot_name: str,
    motion,
    reference: str,
    human_height: float,
    *,
    max_frames: int = 0,
) -> dict:
    """Dense uniform scaled skeleton (Viser ``_compute_scaled_preview`` parity)."""
    from hhtools.web.scaled_preview import compute_web_scaled_preview

    return compute_web_scaled_preview(
        model,
        motion,
        reference,
        human_height,
        max_frames=max_frames,
    )


def _retarget_single(
    model,
    robot_name,
    motion,
    reference,
    backend,
    ik_iters,
    human_height,
    limit_frames,
    job,
    *,
    state: SessionState | None = None,
    foot_clamp_anti_penetration: bool | None = None,
    preset=None,
):
    """Run one clip through the requested backend, returning RetargetedMotion."""
    from hhtools.retarget.calibration import resolve_preset_calibration_file
    from hhtools.robot.retarget_profile import bundled_scaler_path

    if preset is None:
        from hhtools.robot.registry import get as get_preset

        preset = get_preset(robot_name)
    elif preset.name != robot_name:
        raise ValueError("the injected robot preset does not match the requested robot")
    cal_path = resolve_preset_calibration_file(preset, reference)
    if cal_path is None and bundled_scaler_path(preset, reference) is None:
        raise ValueError(
            f"robot {robot_name!r} not calibrated for reference {reference!r}; calibrate first"
        )

    if limit_frames:
        lf = int(limit_frames)
        if motion.num_frames > lf:
            motion.positions = motion.positions[:lf]
            motion.quaternions = motion.quaternions[:lf]
            for o in motion.objects:
                o.positions = o.positions[:lf]
                o.quaternions = o.quaternions[:lf]

    if backend == "interaction_mesh":
        from hhtools.retarget.interaction_mesh.config import (
            InteractionMeshPipelineConfig,
        )
        from hhtools.retarget.interaction_mesh.pipeline import InteractionMeshPipeline

        if job is not None:
            _set_retarget_job_clip_progress(
                job, 0.04, "正在构建 Interaction-Mesh 场景（新机器人首次较慢）…",
            )
        im_cfg = InteractionMeshPipelineConfig()
        # Same UI gate as Newton: unchecked 「脚穿地修正」→ skip mesh foot clamps.
        if foot_clamp_anti_penetration is not None:
            im_cfg.post_mpc_foot_clamps = bool(foot_clamp_anti_penetration)
            if not im_cfg.post_mpc_foot_clamps:
                im_cfg.min_foot_clearance_m = 0.0
        pipe = InteractionMeshPipeline.from_calibration(
            model, motion, str(cal_path), human_height=human_height, cfg=im_cfg,
        )

        def _im_cb(stage: str, cur: int, tot: int) -> None:
            if job is None:
                return
            # precompute is the first ~30%, MPC the remaining ~70%.
            if stage == "precompute":
                frac = 0.3 * (cur / max(1, tot))
                _set_retarget_job_clip_progress(job, frac, f"预处理 {cur}/{tot}")
            else:
                frac = 0.3 + 0.68 * (cur / max(1, tot))
                _set_retarget_job_clip_progress(job, frac, f"MPC 求解 {cur}/{tot}")

        try:
            try:
                return pipe.run(motion, progress_callback=_im_cb)
            except TypeError:
                return pipe.run(motion)
        except ModuleNotFoundError as err:
            if "osqp" in str(err).lower():
                raise ValueError(
                    "interaction-mesh retarget on terrain needs the OSQP solver. "
                    "Install it with `uv pip install osqp` (or re-run "
                    "`uv sync --extra web`)."
                ) from err
            raise

    if backend != "interaction_mesh":
        _require_newton_package()

    # newton
    from hhtools.retarget.calibration import load_calibration
    from hhtools.retarget.newton_basic import NewtonBasicPipeline
    from hhtools.retarget.newton_basic._warp_config import configure as configure_warp_cache
    from hhtools.robot.retarget_profile import (
        build_feet_stabilizer_config,
        build_pipeline_config_for_preset,
        resolve_retarget_scaler_config,
    )

    if job is not None:
        _set_retarget_job_clip_progress(job, 0.03, "正在加载标定与缩放参数…")
    if state is not None:
        _join_robot_prewarm(state, robot_name, job)

    configure_warp_cache()
    calibration = load_calibration(cal_path) if cal_path is not None else None
    scaler_cfg = resolve_retarget_scaler_config(
        preset,
        reference,
        calibration=calibration,
        model=model,
        motion=motion,
        human_height=human_height,
    )
    feet_cfg = build_feet_stabilizer_config(preset, reference, model=model)
    if job is not None:
        # Only advertise kernel compilation when this robot has NOT been
        # prewarmed yet — once Warp's cache is populated (and writable) the
        # init is fast and the old unconditional "compiling kernels" notice was
        # misleading users into thinking every run recompiled.
        try:
            from hhtools.retarget.newton_basic.pipeline import is_newton_ik_prewarmed

            _prewarmed = is_newton_ik_prewarmed(robot_name)
        except Exception:
            _prewarmed = False
        _set_retarget_job_clip_progress(
            job,
            0.06,
            (
                "正在初始化 Newton IK…"
                if _prewarmed
                else "正在初始化 Newton IK（首次会编译 GPU 内核，之后会复用缓存）…"
            ),
        )
    pipeline = NewtonBasicPipeline(
        model,
        scaler_config=scaler_cfg,
        pipeline_config=build_pipeline_config_for_preset(
            preset, reference, ik_iterations=ik_iters,
            foot_clamp_anti_penetration=foot_clamp_anti_penetration,
        ),
        feet_stabilizer_config=feet_cfg,
        human_height=human_height,
        configure_warp=False,
    )

    def _cb(done: int, total: int) -> None:
        if job is None:
            return
        if done <= 0:
            _set_retarget_job_clip_progress(
                job, 0.08, "正在捕获 CUDA 图 / 准备逐帧 IK（首次较慢，请耐心等待）…",
            )
        else:
            _set_retarget_job_clip_progress(
                job,
                min(0.98, 0.1 + 0.88 * (done / max(1, total))),
                f"IK 求解 {done}/{total}",
            )

    try:
        return pipeline.run(motion, progress_callback=_cb)
    except TypeError:
        return pipeline.run(motion)


def effective_job_admission_settings(
    *,
    max_running_jobs: int | None,
    max_queued_jobs: int | None,
    job_settings_path: Path | None,
) -> tuple[JobAdmissionSettings, Path]:
    """Merge persistent settings with explicit CLI/environment overrides."""

    from hhtools.utils.paths import user_web_settings_path

    path = Path(job_settings_path or user_web_settings_path())
    persisted = JobAdmissionSettingsStore(path).load()
    settings = validate_job_admission_settings(
        persisted.max_running_jobs if max_running_jobs is None else max_running_jobs,
        persisted.max_queued_jobs if max_queued_jobs is None else max_queued_jobs,
    )
    return settings, path


# Preserve the private name used by existing callers and regression tests;
# Phase 5 exposes the public alias to the local MCP composition bridge.
_effective_job_admission_settings = effective_job_admission_settings


def run_web(
    *,
    source_root: Path,
    save_dir: Path,
    cache_dir: Path | None = None,
    host: str = "127.0.0.1",
    port: int = 8009,
    max_running_jobs: int | None = None,
    max_queued_jobs: int | None = None,
    job_settings_path: Path | None = None,
) -> None:
    """Launch the uvicorn server (blocking)."""
    require_web_runtime_dependencies()
    import uvicorn

    job_settings, resolved_settings_path = effective_job_admission_settings(
        max_running_jobs=max_running_jobs,
        max_queued_jobs=max_queued_jobs,
        job_settings_path=job_settings_path,
    )
    app = create_app(
        source_root=source_root,
        save_dir=save_dir,
        cache_dir=cache_dir,
        max_running_jobs=job_settings.max_running_jobs,
        max_queued_jobs=job_settings.max_queued_jobs,
        job_settings_path=resolved_settings_path,
    )
    url = f"http://{host}:{port}"
    static_dir = Path(__file__).parent / "static"
    print(f"\n  hhtools web  →  {url}")
    print(f"  UI build     →  {UI_BUILD_ID}")
    print(f"  static dir   →  {static_dir.resolve()}")
    print(
        "  jobs         →  "
        + (
            "unlimited concurrency"
            if job_settings.max_running_jobs == 0
            else f"{job_settings.max_running_jobs} running, "
            + (
                "unlimited waiting"
                if job_settings.max_queued_jobs == 0
                else f"{job_settings.max_queued_jobs} waiting"
            )
        )
    )
    print(
        "  侧栏应为 3 项（含「机器人 · Retarget」）；舞台左上角有「骨架|身体|机器人」。"
        "\n  git pull 后请在本仓库执行 uv sync 并用 uv run hhtools web 重启（勿用全局旧包）。"
        "\n  若界面异常：确认终端 UI build 与浏览器地址栏端口一致，再 Ctrl+Shift+R。"
        "\n  Retarget 需：uv sync --extra web --extra retarget + NVIDIA newton 包。\n"
    )
    try:
        import webbrowser

        threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    except Exception:
        pass
    uvicorn.run(app, host=host, port=port, log_level="info")


def run_desktop_sidecar(
    *,
    source_root: Path,
    save_dir: Path,
    cache_dir: Path | None,
    host: str,
    port: int,
    session_secret: str,
    max_running_jobs: int | None = None,
    max_queued_jobs: int | None = None,
    job_settings_path: Path | None = None,
) -> None:
    """Run the secured localhost server without opening a browser."""
    # The sidecar is a private desktop implementation detail and must never listen on the LAN.
    if host != "127.0.0.1":
        raise ValueError("The desktop sidecar must bind to 127.0.0.1")
    if not session_secret:
        raise ValueError("The desktop sidecar requires a session secret")

    require_web_runtime_dependencies()
    import uvicorn

    job_settings, resolved_settings_path = effective_job_admission_settings(
        max_running_jobs=max_running_jobs,
        max_queued_jobs=max_queued_jobs,
        job_settings_path=job_settings_path,
    )
    allowed_host = f"{host}:{port}"
    origin = f"http://{allowed_host}"
    app = create_app(
        source_root=source_root,
        save_dir=save_dir,
        cache_dir=cache_dir,
        desktop_session_secret=session_secret,
        desktop_allowed_host=allowed_host,
        desktop_allowed_origin=origin,
        max_running_jobs=job_settings.max_running_jobs,
        max_queued_jobs=job_settings.max_queued_jobs,
        job_settings_path=resolved_settings_path,
    )
    _log.info("Starting hhtools desktop sidecar on %s", origin)
    uvicorn.run(app, host=host, port=port, log_level="info", access_log=False)


__all__ = [
    "create_app",
    "effective_job_admission_settings",
    "run_desktop_sidecar",
    "run_web",
]
